/**
 * The map: terrain, track and editing on one canvas, with HTML overlays for
 * the stats, the toolbar, the legend and the cursor readout.
 *
 * World coordinates are metres (x east, y south); the camera maps them to
 * CSS pixels. Drawing happens on demand, at most once per animation frame.
 */
import { CORNER_LABELS } from '../core/analysis.ts';
import { dist, simplifyPolyline, type Vec2 } from '../core/geometry.ts';
import { sampleHeight } from '../core/heightmap.ts';
import type { ControlPoint } from '../core/track.ts';
import { formatLapTime } from '../core/calibration.ts';
import { type Handle, drawFacilities, drawHandles, handleStations } from './facilityLayer.ts';
import { ASPHALT, COLOR_BY_LABELS, type ColorBy, buckets, stationBuckets } from './colors.ts';
import { h, isTyping, setChildren, setText } from './dom.ts';
import { download } from './download.ts';
import * as fmt from './format.ts';
import type { RaceController } from './raceController.ts';
import type { Store, Topic } from './store.ts';
import type { View3D } from './view3d.ts';

interface Camera {
  x: number;
  y: number;
  /** CSS pixels per metre. */
  scale: number;
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number; button: number; moved: boolean }
  | { kind: 'point'; index: number; dx: number; dy: number; moved: boolean }
  | { kind: 'freehand'; points: Vec2[] }
  | { kind: 'handle'; handle: Handle; station: number; moved: boolean };

const SEVERITY_COLORS = { error: 'rgba(255, 77, 79, 0.75)', warning: 'rgba(245, 177, 76, 0.7)', info: 'rgba(111, 179, 255, 0.55)' };
const ACCENT = '#ff5a36';
const HOVER = '#3fb6ff';
const SECTOR = '#ffd60a';
const POINT_HIT_PX = 10;
const TRACK_HIT_PX = 12;
const MAX_SCALE = 10;
/** Minimum on-screen track width, so a 12 m track stays visible on a zoomed-out 8 km map. */
const MIN_TRACK_PX = 3.5;

export class MapView {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly race: RaceController | null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cam: Camera = { x: 4096, y: 4096, scale: 0.1 };
  private width = 1;
  private height = 1;
  private frameRequested = false;
  private fittedExtent = 0;
  private drag: Drag | null = null;
  private spaceDown = false;
  private pointerInside = false;
  private cursor: Vec2 | null = null;
  private bucketCache: { track: unknown; colorBy: ColorBy; lap: unknown; buckets: Int8Array } | null = null;
  private raceShown: unknown = null;

  private readonly hud: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly colorSelect: HTMLSelectElement;
  private readonly contourToggle: HTMLButtonElement;
  private readonly labelToggle: HTMLButtonElement;
  private readonly lineToggle: HTMLButtonElement;
  private readonly facilityToggle: HTMLButtonElement;
  private readonly dimensionButtons: HTMLButtonElement[];
  private readonly reliefSelect: HTMLSelectElement;
  private readonly viewBar: HTMLElement;
  /** The 3D view, loaded (with three.js) the first time it is shown. */
  private view3d: View3D | null = null;
  private view3dLoading = false;

  constructor(store: Store, race: RaceController | null = null) {
    this.store = store;
    this.race = race;
    this.canvas = h('canvas', { class: 'map-canvas' });
    this.ctx = this.canvas.getContext('2d')!;

    this.colorSelect = h('select', {
      title: 'Colour the track by',
      onchange: () => {
        store.setView({ colorBy: this.colorSelect.value as ColorBy });
        this.colorSelect.blur();
      },
    }, ...(Object.keys(COLOR_BY_LABELS) as ColorBy[]).map((k) => h('option', { value: k }, COLOR_BY_LABELS[k])));
    this.contourToggle = h('button', { class: 'chip', title: 'Show contour lines', onclick: () => store.setView({ contours: !store.view.contours }) }, 'Contours');
    this.labelToggle = h('button', { class: 'chip', title: 'Show corner numbers', onclick: () => store.setView({ labels: !store.view.labels }) }, 'Labels');
    this.lineToggle = h('button', { class: 'chip', title: 'Show the racing line', onclick: () => store.setView({ line: !store.view.line }) }, 'Line');
    this.facilityToggle = h('button', { class: 'chip only-2d', title: 'Show pit lane, grid, DRS zones, marshal posts and run-off', onclick: () => store.setView({ facilities: !store.view.facilities }) }, 'Facilities');
    this.dimensionButtons = (['2d', '3d'] as const).map((d) =>
      h('button', { class: 'segment', title: d === '3d' ? 'The terrain and track in 3D (V)' : 'The flat map, for drawing and editing (V)', onclick: () => store.setView({ dimension: d }) }, d.toUpperCase()));
    this.reliefSelect = h('select', {
      title: 'Exaggerate heights in 3D',
      onchange: () => {
        store.setView({ relief: Number(this.reliefSelect.value) });
        this.reliefSelect.blur();
      },
    }, ...[1, 1.5, 2, 3].map((r) => h('option', { value: String(r) }, `×${r}`)));
    const viewBar = h('div', { class: 'map-toolbar map-viewbar' },
      h('label', { class: 'map-toolbar-label map-relief' }, 'Height', this.reliefSelect),
      h('div', { class: 'segmented map-dimension' }, ...this.dimensionButtons));
    this.viewBar = viewBar;
    const toolbar = h('div', { class: 'map-toolbar' },
      h('label', { class: 'map-toolbar-label' }, 'Colour', this.colorSelect),
      this.contourToggle,
      this.labelToggle,
      this.lineToggle,
      this.facilityToggle,
      h('button', { class: 'chip', title: 'Fit the map to the window (F)', onclick: () => this.fit() }, 'Fit'),
    );

    this.hud = h('div', { class: 'map-hud' });
    this.legend = h('div', { class: 'map-legend' });
    this.readout = h('div', { class: 'map-readout' });
    this.tooltip = h('div', { class: 'map-tooltip', hidden: true });
    this.progressBar = h('div', { class: 'progress-fill' });
    this.progressLabel = h('div', { class: 'progress-label' }, 'Generating terrain');
    this.progress = h('div', { class: 'map-progress', hidden: true }, this.progressLabel, h('div', { class: 'progress-track' }, this.progressBar));

    this.el = h('div', { class: 'map' }, this.canvas, this.hud, h('div', { class: 'map-right' }, toolbar, viewBar, this.legend), this.readout, this.tooltip, this.progress);

    new ResizeObserver(() => this.resize()).observe(this.el);
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', () => this.cancelDrag());
    this.canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.cursor = null;
      if (!this.drag) this.store.setHover(null);
      this.updateReadout();
    });
    this.canvas.addEventListener('pointerenter', () => { this.pointerInside = true; });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        this.spaceDown = true;
        this.updateCursor();
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });

    store.subscribe((topics) => this.onChange(topics));
    race?.onTick(() => this.onRaceTick());
    this.onChange(new Set<Topic>(['project', 'terrain', 'generating', 'track', 'view', 'mode']));
  }

  // ---- camera ----------------------------------------------------------------

  private get extent(): number {
    return this.store.terrain?.heightmap.extent ?? this.store.project.terrain.mapSize;
  }

  private fitScale(): number {
    return (Math.min(this.width, this.height) / this.extent) * 0.94;
  }

  fit(): void {
    if (this.is3d) {
      this.view3d?.fit(this.raceActive ? this.freeArea().x0 : 0);
      return;
    }
    if (this.raceActive) {
      this.fitTrackBesideTower();
      return;
    }
    this.cam = { x: this.extent / 2, y: this.extent / 2, scale: this.fitScale() };
    this.invalidate();
  }

  private get is3d(): boolean {
    return this.store.view.dimension === '3d';
  }

  /** Shows the flat map or the 3D view, loading the 3D view the first time. */
  private applyDimension(): void {
    const on = this.is3d;
    this.dimensionButtons.forEach((b, i) => b.classList.toggle('on', (i === 1) === on));
    this.el.classList.toggle('is-3d', on);
    this.canvas.hidden = on;
    this.tooltip.hidden = true;
    if (!on) {
      this.view3d?.setVisible(false);
      setText(this.readout, '');
      this.invalidate();
      return;
    }
    if (this.view3d) {
      this.view3d.setVisible(true);
      return;
    }
    if (this.view3dLoading) return;
    this.view3dLoading = true;
    import('./view3d.ts')
      .then(({ View3D }) => {
        this.view3d = new View3D(this.store, this.readout);
        this.canvas.after(this.view3d.el);
        this.viewBar.prepend(this.view3d.toolbar);
        this.view3d.setVisible(this.is3d);
      })
      .catch((err: unknown) => {
        console.error('3D view failed:', err);
        alert('The 3D view needs WebGL, which is not available here.');
        this.store.setView({ dimension: '2d' });
      })
      .finally(() => {
        this.view3dLoading = false;
      });
  }

  /** Saves the map as it is on screen (terrain, track, facilities and cars, or the 3D view) as a PNG. */
  exportImage(filename: string): void {
    if (this.is3d && this.view3d) {
      this.view3d.saveImage('screen', filename);
      return;
    }
    this.draw();
    this.canvas.toBlob((blob) => {
      if (blob) download(filename, blob);
    }, 'image/png');
  }

  /** Centres the view on a station, zooming in if the map is zoomed far out. */
  centreOn(station: number): void {
    const t = this.store.track;
    if (!t) return;
    this.cam.x = t.x[station];
    this.cam.y = t.y[station];
    this.cam.scale = Math.max(this.cam.scale, Math.min(MAX_SCALE, this.fitScale() * 3));
    this.invalidate();
  }

  private sx(x: number): number {
    return (x - this.cam.x) * this.cam.scale + this.width / 2;
  }

  private sy(y: number): number {
    return (y - this.cam.y) * this.cam.scale + this.height / 2;
  }

  private toWorld(px: number, py: number): Vec2 {
    return { x: (px - this.width / 2) / this.cam.scale + this.cam.x, y: (py - this.height / 2) / this.cam.scale + this.cam.y };
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const before = this.toWorld(px, py);
    const scale = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.5, this.cam.scale * factor));
    this.cam.scale = scale;
    const after = this.toWorld(px, py);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.invalidate();
  }

  private resize(): void {
    const rect = this.el.getBoundingClientRect();
    const firstSize = this.width <= 1;
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    if (firstSize) this.fit();
    this.invalidate();
  }

  // ---- state changes -----------------------------------------------------------

  private onChange(topics: Set<Topic>): void {
    const s = this.store;
    if (topics.has('terrain') && s.terrain && s.terrain.heightmap.extent !== this.fittedExtent) {
      this.fittedExtent = s.terrain.heightmap.extent;
      this.fit();
    }
    if (topics.has('generating') || topics.has('terrain')) {
      this.progress.hidden = !s.generating && !s.terrainError;
      this.progress.classList.toggle('error', !!s.terrainError);
      setText(this.progressLabel, s.terrainError ? `Terrain failed: ${s.terrainError}` : `Generating terrain  ${Math.round(s.progress * 100)}%`);
      this.progressBar.style.width = `${Math.round(s.progress * 100)}%`;
    }
    if (topics.has('view')) {
      this.colorSelect.value = s.view.colorBy;
      this.reliefSelect.value = String(s.view.relief);
      this.dimensionButtons.forEach((b, i) => b.classList.toggle('on', (i === 1) === this.is3d));
      this.contourToggle.classList.toggle('on', s.view.contours);
      this.labelToggle.classList.toggle('on', s.view.labels);
      this.lineToggle.classList.toggle('on', s.view.line);
      this.facilityToggle.classList.toggle('on', s.view.facilities);
      if (this.is3d !== this.el.classList.contains('is-3d') || (this.is3d && !this.view3d)) this.applyDimension();
    }
    const lapChanged = topics.has('performance') || topics.has('vehicle');
    if (topics.has('view') || topics.has('track') || lapChanged) this.updateLegend();
    if (topics.has('track') || topics.has('mode') || topics.has('project') || lapChanged) this.updateHud();
    if (topics.has('hover') || topics.has('track') || lapChanged) this.updateTooltip();
    if (topics.has('mode')) this.updateCursor();
    if (topics.has('race') && this.race && this.race.sim !== this.raceShown) {
      this.raceShown = this.race.sim;
      // A new race: once the timing tower and the dock are laid out (and the map resized to fit), show the whole track.
      if (this.race.sim) requestAnimationFrame(() => requestAnimationFrame(() => (this.is3d ? this.fit() : this.fitTrackBesideTower())));
    }
    this.invalidate();
  }

  private updateHud(): void {
    const s = this.store;
    const m = s.metrics;
    if (!m) {
      const n = s.design.points.length;
      const hint =
        s.mode === 'terrain' ? 'Pick a seed and a landscape, then open Design to draw a track.'
        : s.mode === 'design' ? (s.tool === 'freehand' ? 'Drag to sketch a closed loop.' : `Click to place points: ${n} of at least 3.`)
        : 'Draw a track in Design to analyse it.';
      setChildren(this.hud, h('div', { class: 'hud-hint' }, hint));
      return;
    }
    const errors = s.issues.filter((i) => i.severity === 'error').length;
    const warnings = s.issues.filter((i) => i.severity === 'warning').length;
    const stat = (label: string, value: string) => h('div', { class: 'hud-stat' }, h('span', { class: 'hud-value' }, value), h('span', { class: 'hud-label' }, label));
    const lap = s.lap;
    const lapStat = h('button', {
      class: `hud-stat hud-lap${s.performancePending ? ' pending' : ''}`,
      title: 'Lap times for every class in Analyse',
      onclick: () => s.setMode('analyse'),
    },
    h('span', { class: 'hud-value' }, lap ? formatLapTime(lap.time) : '—'),
    h('span', { class: 'hud-label' }, h('span', { class: 'dot', style: `background:${s.vehicle.color}` }), `${s.vehicle.name} lap`));
    const lic = s.licence;
    const gradeText = lic ? `FIA ${lic.fia.grade ?? '–'} · FIM ${lic.fim.grade ?? '–'}` : '…';
    const licenceStat = h('button', {
      class: `hud-stat hud-lap${s.performancePending ? ' pending' : ''}`,
      title: 'Estimated circuit licence; details in Analyse',
      onclick: () => s.setMode('analyse'),
    }, h('span', { class: 'hud-value' }, gradeText), h('span', { class: 'hud-label' }, 'licence estimate'));
    setChildren(this.hud,
      lapStat,
      licenceStat,
      stat('length', fmt.km(m.length)),
      stat('height difference', fmt.elevation(m.elevationRange)),
      stat('corners', String(m.corners.length)),
      h('button', {
        class: `hud-issues ${errors ? 'has-errors' : warnings ? 'has-warnings' : 'clean'}`,
        title: 'Show all warnings in Analyse',
        onclick: () => s.setMode('analyse'),
      }, errors || warnings ? `${plural(errors, 'error')} · ${plural(warnings, 'warning')}` : 'No problems'),
    );
  }

  private updateLegend(): void {
    const s = this.store;
    const list = buckets(s.view.colorBy, s.track, s.lap, s.vehicle.gears);
    this.legend.hidden = list.length === 0;
    setChildren(this.legend, ...list.map((b) => h('div', { class: 'legend-row' }, h('span', { class: 'swatch', style: `background:${b.color}` }), b.label)));
  }

  private updateReadout(): void {
    const hm = this.store.terrain?.heightmap;
    if (!this.cursor || !hm) {
      setText(this.readout, '');
      return;
    }
    const { x, y } = this.cursor;
    const inside = x >= 0 && y >= 0 && x <= hm.extent && y <= hm.extent;
    if (!inside) {
      setText(this.readout, 'off the map');
      return;
    }
    const z = sampleHeight(hm, x, y);
    const water = z < hm.waterLevel ? ' · water' : '';
    setText(this.readout, `${(x / 1000).toFixed(2)} km E  ${(y / 1000).toFixed(2)} km S  ·  ${fmt.elevation(z)}${water}`);
  }

  private updateTooltip(): void {
    const s = this.store;
    const t = s.track;
    const k = s.hover;
    if (!t || k === null || !this.pointerInside || !this.cursor || this.drag) {
      this.tooltip.hidden = true;
      return;
    }
    const corner = s.metrics?.corners.find((c) => inRange(k, c.start, c.end));
    const r = 1 / Math.max(1e-9, Math.abs(t.curvature[k]));
    const lap = s.lap;
    const i = s.lapIndex(k);
    setChildren(this.tooltip,
      h('div', { class: 'tt-main' }, `${fmt.km(t.s[k])}  ·  ${fmt.elevation(t.z[k])}  ·  ${fmt.gradient(t.gradient[k])}`),
      h('div', { class: 'tt-sub' }, corner ? `T${corner.number} ${CORNER_LABELS[corner.type].toLowerCase()} · radius ${fmt.radius(r)}` : r > 1000 ? 'straight' : `radius ${fmt.radius(r)}`),
      lap ? h('div', { class: 'tt-sub' }, `${s.vehicle.name}: ${fmt.speed(lap.v[i])} · gear ${lap.gear[i]} · ${pedalText(lap.throttle[i], lap.brake[i])}`) : null,
    );
    this.tooltip.hidden = false;
    this.tooltip.style.transform = `translate(${this.sx(this.cursor.x) + 16}px, ${this.sy(this.cursor.y) + 16}px)`;
  }

  private updateCursor(): void {
    const s = this.store;
    let cursor = 'grab';
    if (this.drag?.kind === 'pan') cursor = 'grabbing';
    else if (this.spaceDown) cursor = 'grab';
    else if (s.mode === 'design') cursor = 'crosshair';
    this.canvas.style.cursor = cursor;
  }

  // ---- input -------------------------------------------------------------------

  private local(e: PointerEvent | WheelEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    this.zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
  }

  private onPointerDown(e: PointerEvent): void {
    const s = this.store;
    const p = this.local(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (tests, automation) have no capturable pointer; dragging still works without it.
    }
    if (e.button === 0 && !this.spaceDown && s.mode === 'analyse' && s.view.facilities) {
      const hit = this.handleAt(p.x, p.y);
      if (hit) {
        this.drag = { kind: 'handle', handle: hit.handle, station: hit.station, moved: false };
        return;
      }
    }
    const panButton = e.button === 1 || e.button === 2 || (e.button === 0 && (this.spaceDown || s.mode !== 'design'));
    if (panButton) {
      this.drag = { kind: 'pan', startX: p.x, startY: p.y, camX: this.cam.x, camY: this.cam.y, button: e.button, moved: false };
      this.updateCursor();
      return;
    }
    if (e.button !== 0 || !s.terrain) return;

    const w = this.toWorld(p.x, p.y);
    if (s.tool === 'freehand') {
      this.drag = { kind: 'freehand', points: [w] };
      return;
    }

    const hitPoint = this.pointAt(p.x, p.y);
    if (hitPoint !== null) {
      const pt = s.design.points[hitPoint];
      s.select(hitPoint);
      s.beginEdit();
      this.drag = { kind: 'point', index: hitPoint, dx: pt.x - w.x, dy: pt.y - w.y, moved: false };
      return;
    }

    const clamped = this.clampToMap(w);
    const hitStation = s.design.points.length >= 3 ? this.stationAt(p.x, p.y, TRACK_HIT_PX) : null;
    s.beginEdit();
    let index: number;
    if (hitStation !== null && s.track) {
      // Clicking the track inserts a point into the segment under the cursor.
      index = s.track.seg[hitStation] + 1;
      const pos = { x: s.track.x[hitStation], y: s.track.y[hitStation] };
      s.updateDesign((d) => d.points.splice(index, 0, { ...pos, width: s.track!.width[hitStation] }));
    } else {
      // Empty ground adds a point after the selected one, or at the end of the loop.
      index = s.selected !== null ? s.selected + 1 : s.design.points.length;
      s.updateDesign((d) => d.points.splice(index, 0, { ...clamped, width: d.defaultWidth }));
    }
    s.select(index);
    this.drag = { kind: 'point', index, dx: 0, dy: 0, moved: true };
  }

  private onPointerMove(e: PointerEvent): void {
    const s = this.store;
    const p = this.local(e);
    this.cursor = this.toWorld(p.x, p.y);
    this.pointerInside = true;
    const drag = this.drag;
    if (drag?.kind === 'pan') {
      if (Math.abs(p.x - drag.startX) + Math.abs(p.y - drag.startY) > 3) drag.moved = true;
      this.cam.x = drag.camX - (p.x - drag.startX) / this.cam.scale;
      this.cam.y = drag.camY - (p.y - drag.startY) / this.cam.scale;
      this.cursor = this.toWorld(p.x, p.y);
      this.invalidate();
    } else if (drag?.kind === 'point') {
      const target = this.clampToMap({ x: this.cursor.x + drag.dx, y: this.cursor.y + drag.dy });
      drag.moved = true;
      s.updateDesign((d) => {
        const pt = d.points[drag.index];
        if (pt) {
          pt.x = target.x;
          pt.y = target.y;
        }
      });
    } else if (drag?.kind === 'freehand') {
      const last = drag.points[drag.points.length - 1];
      if (dist(this.sx(last.x), this.sy(last.y), p.x, p.y) > 3) drag.points.push(this.clampToMap(this.cursor));
      this.invalidate();
    } else if (drag?.kind === 'handle') {
      // Handles slide along the track: snap to the nearest station.
      const k = this.stationAt(p.x, p.y, 80);
      if (k !== null && k !== drag.station) {
        drag.station = k;
        drag.moved = true;
        this.invalidate();
      }
    } else {
      s.setHover(this.stationAt(p.x, p.y, TRACK_HIT_PX));
      this.updateTooltip();
    }
    this.updateReadout();
  }

  private onPointerUp(e: PointerEvent): void {
    const s = this.store;
    const drag = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (drag?.kind === 'pan') {
      const p = this.local(e);
      if (!drag.moved && drag.button === 2 && s.mode === 'design') {
        // Right click without dragging deletes a point.
        const hit = this.pointAt(p.x, p.y);
        if (hit !== null) s.deletePoint(hit);
      } else if (!drag.moved && drag.button === 0 && s.mode === 'analyse') {
        this.focusCornerAt(p.x, p.y);
      } else if (!drag.moved && drag.button === 0 && s.mode === 'race') {
        this.pickCar(p.x, p.y);
      }
    } else if (drag?.kind === 'point') {
      s.commitEdit();
    } else if (drag?.kind === 'freehand') {
      this.finishFreehand(drag.points);
    } else if (drag?.kind === 'handle' && drag.moved) {
      this.dropHandle(drag.handle, drag.station);
    }
    this.updateCursor();
    this.invalidate();
  }

  /** Stores a dragged facility as a hand placement (a world position, so it survives edits to the track). */
  private dropHandle(handle: Handle, station: number): void {
    const s = this.store;
    const t = s.track;
    if (!t) return;
    const at = { x: t.x[station], y: t.y[station] };
    if (handle === 'start') s.setOverride('startFinish', at);
    else if (handle === 'speedTrap') s.setOverride('speedTrap', at);
    else {
      const pit = s.facilities?.pitLane;
      if (!pit) return;
      const entry = handle === 'pitEntry' ? at : { x: t.x[pit.entry], y: t.y[pit.entry] };
      const exit = handle === 'pitExit' ? at : { x: t.x[pit.exit], y: t.y[pit.exit] };
      s.setOverride('pitLane', { entry, exit, side: pit.side });
    }
  }

  private handleAt(px: number, py: number): { handle: Handle; station: number } | null {
    const t = this.store.track;
    if (!t) return null;
    for (const h of handleStations(this.store)) {
      if (dist(this.sx(t.x[h.station]), this.sy(t.y[h.station]), px, py) < 12) return h;
    }
    return null;
  }

  private cancelDrag(): void {
    if (this.drag?.kind === 'point') this.store.commitEdit();
    this.drag = null;
    this.updateCursor();
    this.invalidate();
  }

  private focusCornerAt(px: number, py: number): void {
    const s = this.store;
    const k = this.stationAt(px, py, TRACK_HIT_PX);
    const corner = k === null ? undefined : s.metrics?.corners.find((c) => inRange(k, c.start, c.end));
    s.setFocus(corner ? { start: corner.start, end: corner.end, centre: corner.apex } : null);
  }

  /** Turns a sketched stroke into control points and replaces the track with it. */
  private finishFreehand(stroke: Vec2[]): void {
    const s = this.store;
    let length = 0;
    for (let i = 1; i < stroke.length; i++) length += dist(stroke[i - 1].x, stroke[i - 1].y, stroke[i].x, stroke[i].y);
    if (stroke.length < 8 || length < 300) return;
    const tolerance = Math.max(4, 2.5 / this.cam.scale);
    let pts = simplifyPolyline(stroke, tolerance);
    // Drop the end if it came back to the start; the loop closes itself.
    const closeEnough = Math.max(40, 30 / this.cam.scale);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (pts.length > 3 && dist(first.x, first.y, last.x, last.y) < closeEnough) pts = pts.slice(0, -1);
    // Merge points closer than 15 m, which would only add wiggles.
    const merged: Vec2[] = [];
    for (const p of pts) {
      const prev = merged[merged.length - 1];
      if (!prev || dist(prev.x, prev.y, p.x, p.y) >= 15) merged.push(p);
    }
    if (merged.length < 3) return;
    const width = s.design.defaultWidth;
    s.edit((d) => { d.points = merged.map((p): ControlPoint => ({ x: p.x, y: p.y, width })); });
    s.select(null);
    s.setTool('points');
  }

  private clampToMap(p: Vec2): Vec2 {
    const e = this.extent;
    return { x: Math.min(e, Math.max(0, p.x)), y: Math.min(e, Math.max(0, p.y)) };
  }

  private pointAt(px: number, py: number): number | null {
    const pts = this.store.design.points;
    let best: number | null = null;
    let bestD = POINT_HIT_PX;
    for (let i = pts.length - 1; i >= 0; i--) {
      const d = dist(this.sx(pts[i].x), this.sy(pts[i].y), px, py);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Nearest station within `tolerance` pixels of the track surface. */
  private stationAt(px: number, py: number, tolerance: number): number | null {
    const t = this.store.track;
    if (!t) return null;
    const w = this.toWorld(px, py);
    let best: number | null = null;
    let bestD = Infinity;
    for (let k = 0; k < t.n; k++) {
      const dx = t.x[k] - w.x;
      const dy = t.y[k] - w.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best === null) return null;
    const reach = Math.max(tolerance / this.cam.scale, t.width[best] / 2);
    return Math.sqrt(bestD) <= reach ? best : null;
  }

  // ---- drawing -------------------------------------------------------------------

  invalidate(): void {
    if (this.frameRequested || this.is3d) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / this.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0c0f13';
    ctx.fillRect(0, 0, this.width, this.height);

    const terrain = this.store.terrain;
    if (terrain) {
      const e = terrain.heightmap.extent;
      const x0 = this.sx(0);
      const y0 = this.sy(0);
      const size = e * this.cam.scale;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(terrain.base, x0, y0, size, size);
      if (this.store.view.contours) ctx.drawImage(terrain.contours, x0, y0, size, size);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 - 0.5, y0 - 0.5, size + 1, size + 1);
    }

    this.drawTrack();
    if (this.store.mode === 'race') {
      this.drawRaceTrack();
      this.drawCars();
      this.drawRain();
    }
    this.drawPoints();
    if (this.drag?.kind === 'freehand') this.drawStroke(this.drag.points);
    this.drawScaleBar();
  }

  private trackPx(width: number): number {
    return Math.max(MIN_TRACK_PX, width * this.cam.scale);
  }

  /** Adds stations `start`..`end` (wrapping) plus one more to the current path. */
  private pathRange(start: number, end: number): void {
    const t = this.store.track!;
    const ctx = this.ctx;
    const len = (end >= start ? end - start : t.n - start + end) + 2;
    for (let i = 0; i < len && i <= t.n; i++) {
      const k = (start + i) % t.n;
      if (i === 0) ctx.moveTo(this.sx(t.x[k]), this.sy(t.y[k]));
      else ctx.lineTo(this.sx(t.x[k]), this.sy(t.y[k]));
    }
  }

  private strokeRange(start: number, end: number, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    this.pathRange(start, end);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private drawTrack(): void {
    const s = this.store;
    const t = s.track;
    if (!t) return;
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let avgWidth = 0;
    for (let k = 0; k < t.n; k++) avgWidth += t.width[k];
    avgWidth /= t.n;
    const basePx = this.trackPx(avgWidth);

    // Warnings glow underneath the track, most severe drawn last.
    for (const issue of [...s.issues].reverse()) {
      if (issue.code === 'short') continue;
      this.strokeRange(issue.start, issue.end, SEVERITY_COLORS[issue.severity], basePx + 12);
    }
    if (s.focus) this.strokeRange(s.focus.start, s.focus.end, 'rgba(255,255,255,0.95)', basePx + 9);

    // Dark edge, then the surface in runs of equal colour.
    ctx.beginPath();
    this.pathRange(0, t.n - 1);
    ctx.closePath();
    ctx.strokeStyle = '#121418';
    ctx.lineWidth = basePx + 2.5;
    ctx.stroke();

    const colors = buckets(s.view.colorBy, t, s.lap, s.vehicle.gears);
    const idx = this.stationBuckets();
    let start = 0;
    while (start < t.n) {
      const b = idx[start];
      let end = start;
      let widthSum = t.width[start];
      while (end + 1 < t.n && idx[end + 1] === b && end - start < 24) {
        end++;
        widthSum += t.width[end];
      }
      this.strokeRange(start, end, b < 0 ? ASPHALT : colors[b].color, this.trackPx(widthSum / (end - start + 1)));
      start = end + 1;
    }

    // White edge lines once the real width is visible.
    if (avgWidth * this.cam.scale > 10) {
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      for (const [xs, ys] of [[t.leftX, t.leftY], [t.rightX, t.rightY]] as const) {
        ctx.beginPath();
        for (let k = 0; k <= t.n; k++) {
          const i = k % t.n;
          if (k === 0) ctx.moveTo(this.sx(xs[i]), this.sy(ys[i]));
          else ctx.lineTo(this.sx(xs[i]), this.sy(ys[i]));
        }
        ctx.stroke();
      }
    }

    if (s.view.line) this.drawRacingLine();
    this.drawStartLine(basePx);
    this.drawSectorLines(basePx);
    this.drawChevrons(basePx);
    const layer = { ctx, store: s, scale: this.cam.scale, sx: (x: number) => this.sx(x), sy: (y: number) => this.sy(y) };
    if (s.view.facilities) drawFacilities(layer);
    if (s.view.labels) this.drawCornerLabels();
    if (s.view.facilities && s.mode === 'analyse') drawHandles(layer, this.drag?.kind === 'handle' ? this.drag : null);

    if (s.hover !== null && s.hover < t.n) {
      const k = s.hover;
      ctx.beginPath();
      ctx.arc(this.sx(t.x[k]), this.sy(t.y[k]), Math.max(6, this.trackPx(t.width[k]) / 2 + 3), 0, Math.PI * 2);
      ctx.strokeStyle = HOVER;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  private stationBuckets(): Int8Array {
    const s = this.store;
    const c = this.bucketCache;
    const lap = s.lap;
    if (c && c.track === s.track && c.colorBy === s.view.colorBy && c.lap === lap) return c.buckets;
    const b = stationBuckets(s.track!, s.view.colorBy, { lap, index: (k) => s.lapIndex(k) });
    this.bucketCache = { track: s.track, colorBy: s.view.colorBy, lap, buckets: b };
    return b;
  }

  /** The racing line as a thin bright line, hidden while it is being recalculated. */
  private drawRacingLine(): void {
    const s = this.store;
    const perf = s.performance;
    if (!perf || !s.performanceCurrent) return;
    const line = perf.line;
    const ctx = this.ctx;
    ctx.beginPath();
    for (let k = 0; k <= line.n; k++) {
      const i = k % line.n;
      if (k === 0) ctx.moveTo(this.sx(line.x[i]), this.sy(line.y[i]));
      else ctx.lineTo(this.sx(line.x[i]), this.sy(line.y[i]));
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = '#7df9ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Yellow bars across the track where sectors 2 and 3 begin. */
  private drawSectorLines(trackPx: number): void {
    const s = this.store;
    const t = s.track!;
    const perf = s.performance;
    if (!perf || !s.performanceCurrent) return;
    const ctx = this.ctx;
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    perf.sectors.forEach((k, i) => {
      const half = Math.max(trackPx / 2, (t.width[k] / 2) * this.cam.scale) + 3;
      const nx = Math.sin(t.heading[k]);
      const ny = -Math.cos(t.heading[k]);
      const cx = this.sx(t.x[k]);
      const cy = this.sy(t.y[k]);
      ctx.beginPath();
      ctx.moveTo(cx - nx * half, cy - ny * half);
      ctx.lineTo(cx + nx * half, cy + ny * half);
      ctx.strokeStyle = SECTOR;
      ctx.lineWidth = 3;
      ctx.stroke();
      const lx = cx + nx * (half + 12);
      const ly = cy + ny * (half + 12);
      ctx.fillStyle = SECTOR;
      roundRect(ctx, lx - 11, ly - 7, 22, 14, 3);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillText(`S${i + 2}`, lx, ly + 0.5);
    });
  }

  /** A chequered bar across the track at station 0, the provisional start. */
  private drawStartLine(trackPx: number): void {
    const t = this.store.track!;
    const ctx = this.ctx;
    const half = Math.max(trackPx / 2, (t.width[0] / 2) * this.cam.scale) + 1;
    const nx = Math.sin(t.heading[0]);
    const ny = -Math.cos(t.heading[0]);
    const cx = this.sx(t.x[0]);
    const cy = this.sy(t.y[0]);
    const squares = 6;
    const thick = Math.max(3, Math.min(8, half / 2));
    const fx = Math.cos(t.heading[0]) * thick;
    const fy = Math.sin(t.heading[0]) * thick;
    for (let i = 0; i < squares; i++) {
      for (let row = 0; row < 2; row++) {
        const a = -half + (2 * half * i) / squares;
        const b = -half + (2 * half * (i + 1)) / squares;
        const ox = row * fx - fx;
        const oy = row * fy - fy;
        ctx.beginPath();
        ctx.moveTo(cx + nx * a + ox, cy + ny * a + oy);
        ctx.lineTo(cx + nx * b + ox, cy + ny * b + oy);
        ctx.lineTo(cx + nx * b + ox + fx, cy + ny * b + oy + fy);
        ctx.lineTo(cx + nx * a + ox + fx, cy + ny * a + oy + fy);
        ctx.closePath();
        ctx.fillStyle = (i + row) % 2 ? '#111' : '#f4f4f4';
        ctx.fill();
      }
    }
  }

  /** Small arrows along the centreline showing the direction of travel. */
  private drawChevrons(trackPx: number): void {
    const t = this.store.track!;
    const ctx = this.ctx;
    const size = Math.max(2.5, Math.min(7, trackPx * 0.3));
    const spacing = 150;
    let acc = spacing / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 1; k < t.n; k++) {
      acc += t.ds * this.cam.scale;
      if (acc < spacing) continue;
      acc = 0;
      const x = this.sx(t.x[k]);
      const y = this.sy(t.y[k]);
      if (x < -20 || y < -20 || x > this.width + 20 || y > this.height + 20) continue;
      const c = Math.cos(t.heading[k]);
      const sn = Math.sin(t.heading[k]);
      ctx.moveTo(x - c * size - sn * size, y - sn * size + c * size);
      ctx.lineTo(x, y);
      ctx.lineTo(x - c * size + sn * size, y - sn * size - c * size);
    }
    ctx.stroke();
  }

  private drawCornerLabels(): void {
    const s = this.store;
    const t = s.track!;
    const m = s.metrics;
    if (!m) return;
    const ctx = this.ctx;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of m.corners) {
      const k = c.apex;
      // Label on the outside of the corner.
      const side = c.direction === 'right' ? 1 : -1;
      const nx = Math.sin(t.heading[k]) * side;
      const ny = -Math.cos(t.heading[k]) * side;
      const off = this.trackPx(t.width[k]) / 2 + 13;
      const x = this.sx(t.x[k]) + nx * off;
      const y = this.sy(t.y[k]) + ny * off;
      const label = `T${c.number}`;
      const w = ctx.measureText(label).width + 8;
      const focused = s.focus?.centre === c.apex;
      ctx.fillStyle = focused ? '#ffffff' : 'rgba(18,20,24,0.85)';
      roundRect(ctx, x - w / 2, y - 8, w, 16, 4);
      ctx.fill();
      ctx.fillStyle = focused ? '#111' : '#f1f3f5';
      ctx.fillText(label, x, y + 0.5);
    }
  }

  private drawPoints(): void {
    const s = this.store;
    if (s.mode !== 'design') return;
    const pts = s.design.points;
    const ctx = this.ctx;
    if (pts.length > 0 && pts.length < 3) {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(this.sx(p.x), this.sy(p.y)) : ctx.lineTo(this.sx(p.x), this.sy(p.y))));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pts.forEach((p, i) => {
      const selected = i === s.selected;
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), selected ? 6.5 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeStyle = selected ? ACCENT : '#111';
      ctx.stroke();
    });
  }

  private drawStroke(points: Vec2[]): void {
    const ctx = this.ctx;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(this.sx(p.x), this.sy(p.y)) : ctx.lineTo(this.sx(p.x), this.sy(p.y))));
    ctx.stroke();
  }

  // ---- race ------------------------------------------------------------------------

  private get raceActive(): boolean {
    return !!this.race?.sim && this.store.mode === 'race';
  }

  private onRaceTick(): void {
    if (!this.raceActive) return;
    const r = this.race!;
    if (r.follow && r.selected !== null) {
      const pose = r.sim!.pose(r.sim!.cars[r.selected], r.alpha);
      if (pose && this.drag?.kind !== 'pan') {
        this.cam.scale = Math.max(this.cam.scale, Math.min(MAX_SCALE, this.fitScale() * 4));
        const free = this.freeArea();
        this.cam.x = pose.x - ((free.x0 + free.x1) / 2 - this.width / 2) / this.cam.scale;
        this.cam.y = pose.y - ((free.y0 + free.y1) / 2 - this.height / 2) / this.cam.scale;
      }
    }
    this.invalidate();
  }

  /** The part of the map not covered by the timing tower, in CSS pixels. */
  private freeArea(): { x0: number; y0: number; x1: number; y1: number } {
    const tower = this.el.querySelector<HTMLElement>('.tower');
    const x0 = tower && !tower.hidden ? tower.offsetLeft + tower.offsetWidth + 8 : 0;
    return { x0: Math.min(x0, this.width * 0.6), y0: 0, x1: this.width, y1: this.height };
  }

  /** Fits the track into the part of the map beside the timing tower. */
  fitTrackBesideTower(): void {
    const t = this.store.track;
    if (!t) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < t.n; k++) {
      minX = Math.min(minX, t.x[k]);
      maxX = Math.max(maxX, t.x[k]);
      minY = Math.min(minY, t.y[k]);
      maxY = Math.max(maxY, t.y[k]);
    }
    const free = this.freeArea();
    const pad = 40;
    const w = Math.max(50, free.x1 - free.x0 - 2 * pad);
    const hgt = Math.max(50, free.y1 - free.y0 - 2 * pad - 40);
    this.cam.scale = Math.min(MAX_SCALE, w / Math.max(1, maxX - minX), hgt / Math.max(1, maxY - minY));
    this.cam.x = (minX + maxX) / 2 - ((free.x0 + free.x1) / 2 - this.width / 2) / this.cam.scale;
    this.cam.y = (minY + maxY) / 2 - ((free.y0 + free.y1) / 2 + 20 - this.height / 2) / this.cam.scale;
    this.invalidate();
  }

  private pickCar(px: number, py: number): void {
    const r = this.race;
    const sim = r?.sim;
    if (!r || !sim) return;
    let best: number | null = null;
    let bestD = 14;
    for (const car of sim.cars) {
      const pose = sim.pose(car, r.alpha);
      if (!pose || car.status === 'retired') continue;
      const d = dist(this.sx(pose.x), this.sy(pose.y), px, py);
      if (d < bestD) {
        bestD = d;
        best = car.id;
      }
    }
    if (best !== null) r.select(best, true);
    else if (r.selected !== null && !r.follow) r.select(null);
  }

  /** A wet sheen on the track as it gets wet, and yellow flag zones along it. */
  private drawRaceTrack(): void {
    const sim = this.race?.sim;
    const t = this.store.track;
    if (!sim || !t || t.n !== sim.model.n) return;
    const ctx = this.ctx;
    let avgWidth = 0;
    for (let k = 0; k < t.n; k++) avgWidth += t.width[k];
    const basePx = this.trackPx(avgWidth / t.n);
    if (sim.wetness > 0.02) {
      ctx.beginPath();
      this.pathRange(0, t.n - 1);
      ctx.closePath();
      ctx.strokeStyle = `rgba(70,140,220,${(0.12 + 0.4 * sim.wetness).toFixed(3)})`;
      ctx.lineWidth = basePx;
      ctx.stroke();
    }
    for (const z of sim.yellows) {
      ctx.setLineDash(z.double ? [] : [6, 4]);
      this.strokeRange(z.from, z.to, z.double ? 'rgba(255,214,10,0.95)' : 'rgba(255,214,10,0.7)', Math.max(4, basePx * 0.55));
    }
    ctx.setLineDash([]);
    // A virtual safety car or full course yellow covers the whole lap.
    if (sim.phase === 'vsc' || sim.phase === 'fcy') {
      ctx.beginPath();
      this.pathRange(0, t.n - 1);
      ctx.closePath();
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = 'rgba(255,214,10,0.55)';
      ctx.lineWidth = Math.max(2, basePx * 0.3);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Rain over the map: a tint and falling streaks, stronger in heavier rain. */
  private drawRain(): void {
    const sim = this.race?.sim;
    if (!sim || sim.rain < 0.05) return;
    const ctx = this.ctx;
    const a = Math.min(1, sim.rain);
    ctx.fillStyle = `rgba(40,70,110,${(0.1 + 0.15 * a).toFixed(3)})`;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.strokeStyle = `rgba(190,215,240,${(0.1 + 0.2 * a).toFixed(3)})`;
    ctx.lineWidth = 1;
    const spacing = 38 - 16 * a;
    const shift = (sim.t * 240) % spacing;
    ctx.beginPath();
    for (let x = -this.height; x < this.width; x += spacing) {
      for (let y = -spacing + shift; y < this.height; y += spacing * 1.7) {
        const jitter = ((x * 7 + Math.floor(y) * 13) % 11) - 5;
        ctx.moveTo(x + y * 0.25 + jitter, y);
        ctx.lineTo(x + y * 0.25 + jitter + 3, y + 10);
      }
    }
    ctx.stroke();
  }

  /**
   * Cars as dots in their team colours, the leader drawn on top, ringed in
   * their class colour in a multi-class race; retired cars as grey crosses
   * where they stopped; the safety car as a marked box.
   */
  private drawCars(): void {
    const r = this.race;
    const sim = r?.sim;
    if (!r || !sim) return;
    const ctx = this.ctx;
    const radius = Math.max(3.5, Math.min(9, 2.4 * this.cam.scale));
    const labels = this.cam.scale > 0.9;
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = sim.order.length - 1; i >= 0; i--) {
      const car = sim.order[i];
      const pose = sim.pose(car, r.alpha);
      if (!pose) continue;
      const x = this.sx(pose.x);
      const y = this.sy(pose.y);
      if (x < -20 || y < -20 || x > this.width + 20 || y > this.height + 20) continue;
      if (car.status === 'retired') {
        ctx.strokeStyle = 'rgba(160,168,178,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 3.5, y - 3.5);
        ctx.lineTo(x + 3.5, y + 3.5);
        ctx.moveTo(x + 3.5, y - 3.5);
        ctx.lineTo(x - 3.5, y + 3.5);
        ctx.stroke();
        continue;
      }
      const selected = r.selected === car.id;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = car.entrant.color;
      ctx.globalAlpha = car.status === 'pit' ? 0.75 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = sim.multiClass ? 2.5 : 1.5;
      ctx.strokeStyle = sim.multiClass ? car.cls.color : '#0b0d10';
      ctx.stroke();
      if (car.position === 1) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (selected) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (labels || selected) {
        const pos = sim.multiClass ? `${car.cls.label} P${car.classPosition}` : `P${car.position}`;
        const text = selected ? `${pos} ${car.entrant.code}` : car.entrant.code;
        const w = ctx.measureText(text).width + 8;
        const lx = x + radius + 5;
        ctx.fillStyle = selected ? '#ffffff' : 'rgba(12,15,19,0.8)';
        roundRect(ctx, lx, y - 7, w, 14, 3);
        ctx.fill();
        ctx.fillStyle = selected ? '#111' : '#f1f3f5';
        ctx.textAlign = 'left';
        ctx.fillText(text, lx + 4, y + 0.5);
      }
    }
    // The safety car on top, so the queue behind it does not hide it.
    const sc = sim.safetyCarPose(r.alpha);
    if (sc) {
      const x = this.sx(sc.x);
      const y = this.sy(sc.y);
      const s = Math.max(8, radius + 3);
      ctx.fillStyle = '#ffb020';
      roundRect(ctx, x - s, y - s * 0.75, 2 * s, 1.5 * s, 3);
      ctx.fill();
      ctx.strokeStyle = '#0b0d10';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#0b0d10';
      ctx.font = `800 ${Math.round(s * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('SC', x, y + 0.5);
    }
  }

  private drawScaleBar(): void {
    const ctx = this.ctx;
    const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let len = steps[steps.length - 1];
    for (const st of steps) {
      if (st * this.cam.scale >= 70) {
        len = st;
        break;
      }
    }
    const px = len * this.cam.scale;
    const x = 16;
    const y = this.height - 22;
    ctx.fillStyle = 'rgba(12,15,19,0.7)';
    roundRect(ctx, x - 8, y - 18, px + 16, 30, 6);
    ctx.fill();
    ctx.strokeStyle = '#f1f3f5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = '#f1f3f5';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, x, y - 7);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function pedalText(throttle: number, brake: number): string {
  if (brake > 0) return `braking ${Math.round(brake * 100)}%`;
  if (throttle >= 0.98) return 'full throttle';
  if (throttle > 0.05) return `throttle ${Math.round(throttle * 100)}%`;
  return 'coasting';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Whether station k lies in the wrapped range start..end. */
export function inRange(k: number, start: number, end: number): boolean {
  return end >= start ? k >= start && k <= end : k >= start || k <= end;
}
