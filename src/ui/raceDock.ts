/**
 * The race analysis dock under the map in Race mode:
 * - Telemetry: speed, throttle and brake, gear and g-forces over a lap for
 *   one car, optionally overlaid with another lap or car and the time delta;
 * - Positions (lap chart), Gaps to the leader and Lap times per lap;
 * - Stints: tyre sets per car;
 * - Statistics: fastest laps, speed trap, overtakes and pit stops.
 * Hovering the telemetry marks the spot on the map; clicking a line in a
 * chart selects that car. The dock's height can be dragged.
 */
import { formatLapTime } from '../core/calibration.ts';
import type { RaceCar, RaceSim } from '../core/race/sim.ts';
import { fastestLaps, gapsByLap, overtakeCounts, pitStops, positionsByLap, speedTraps, stints } from '../core/race/stats.ts';
import type { LapChoice, Telemetry } from '../core/race/telemetry.ts';
import { AXIS_TEXT, FONT, GRID, type Plot, TEXT, lapAxis, niceStep, polyline, sizeCanvas, tag, yAxis } from './charts.ts';
import { h, setChildren, setText } from './dom.ts';
import type { RaceController } from './raceController.ts';
import type { Store, Topic } from './store.ts';

type DockTab = 'telemetry' | 'positions' | 'gaps' | 'laps' | 'stints' | 'stats';

const TABS: { tab: DockTab; label: string }[] = [
  { tab: 'telemetry', label: 'Telemetry' },
  { tab: 'positions', label: 'Positions' },
  { tab: 'gaps', label: 'Gaps' },
  { tab: 'laps', label: 'Lap times' },
  { tab: 'stints', label: 'Stints' },
  { tab: 'stats', label: 'Statistics' },
];
const HEIGHT_KEY = 'racetrackdesign.dock';
const DEFAULT_HEIGHT = 380;
const REFRESH_MS = 250;
const COMPARE_COLOR = '#e8ecf1';
const THROTTLE = '#4ade80';
const BRAKE = '#ff5a5f';

interface Hit {
  car: number;
  x: number;
  y: number;
  text: string;
}

export class RaceDock {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly race: RaceController;
  private readonly canvas: HTMLCanvasElement;
  private readonly body: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly controlsEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly tabButtons: HTMLButtonElement[];
  private tab: DockTab = 'telemetry';
  private width = 1;
  private height = 1;
  private frameRequested = false;
  private dataVersion = '';
  private controlsKey = '';
  private lastCheck = 0;
  private hits: Hit[] = [];
  private hover: Hit | null = null;
  private plot: Plot = { x0: 0, y0: 0, w: 1, h: 1 };

  constructor(store: Store, race: RaceController) {
    this.store = store;
    this.race = race;
    this.canvas = h('canvas', { class: 'dock-canvas' });
    this.statsEl = h('div', { class: 'dock-stats', hidden: true });
    this.body = h('div', { class: 'dock-body' }, this.canvas, this.statsEl);
    this.controlsEl = h('div', { class: 'dock-controls' });
    this.summaryEl = h('div', { class: 'dock-summary' });
    this.tabButtons = TABS.map(({ tab, label }) => h('button', { class: 'profile-tab', onclick: () => this.setTab(tab) }, label));
    const handle = h('div', { class: 'dock-resize', title: 'Drag to resize' });
    this.el = h('section', { class: 'dock', hidden: true },
      handle,
      h('header', { class: 'dock-header' }, h('div', { class: 'profile-tabs' }, ...this.tabButtons), this.controlsEl, this.summaryEl),
      this.body);
    let height = DEFAULT_HEIGHT;
    try {
      height = Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_HEIGHT;
    } catch {
      // Keep the default height.
    }
    this.el.style.height = `${height}px`;
    this.setupResize(handle);

    new ResizeObserver(() => this.resize()).observe(this.body);
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (this.tab === 'telemetry') store.setHover(null);
      this.hover = null;
      this.invalidate();
    });
    this.canvas.addEventListener('click', () => {
      if (this.hover) race.select(this.hover.car);
    });
    store.subscribe((topics) => this.onStore(topics));
    race.onTick(() => this.onTick());
    this.updateTabs();
  }

  private setupResize(handle: HTMLElement): void {
    let startY = 0;
    let startH = 0;
    handle.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startH = this.el.getBoundingClientRect().height;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events cannot be captured; resizing still works while the pointer stays on the handle.
      }
      const move = (ev: PointerEvent) => {
        const max = (this.el.parentElement?.getBoundingClientRect().height ?? 800) * 0.75;
        const next = Math.max(160, Math.min(max, startH + startY - ev.clientY));
        this.el.style.height = `${Math.round(next)}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(this.el.getBoundingClientRect().height)));
        } catch {
          // Remembering the height is only a convenience.
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private setTab(tab: DockTab): void {
    this.tab = tab;
    this.hover = null;
    this.controlsKey = '';
    this.updateTabs();
  }

  private updateTabs(): void {
    this.tabButtons.forEach((b, i) => b.classList.toggle('on', TABS[i].tab === this.tab));
    const stats = this.tab === 'stats';
    this.canvas.hidden = stats;
    this.statsEl.hidden = !stats;
    this.updateControls(true);
    this.dataVersion = '';
    this.refresh();
  }

  private onStore(topics: Set<Topic>): void {
    if (topics.has('mode') || topics.has('race')) {
      this.el.hidden = !(this.store.mode === 'race' && this.race.sim);
      if (topics.has('race') && this.race.wantsTelemetry) {
        this.race.wantsTelemetry = false;
        if (this.tab !== 'telemetry') this.setTab('telemetry');
      }
      this.updateControls(topics.has('race'));
      this.dataVersion = '';
      this.refresh();
    }
    if (topics.has('hover') && this.tab === 'telemetry') this.invalidate();
  }

  private onTick(): void {
    const now = performance.now();
    if (now - this.lastCheck < REFRESH_MS) return;
    this.lastCheck = now;
    this.updateControls(false);
    this.refresh();
  }

  /** Redraws when the recorded data has moved on since the last drawing. */
  private refresh(): void {
    const sim = this.race.sim;
    if (!sim || this.el.hidden) return;
    let laps = 0;
    for (const c of sim.cars) laps += c.history.length;
    const live = this.tab === 'telemetry' && this.race.telemetry.lap === 'current' ? Math.floor(sim.t) : 0;
    const version = `${laps}:${sim.stops.length}:${sim.finished}:${this.race.selected}:${live}`;
    if (version === this.dataVersion) return;
    this.dataVersion = version;
    if (this.tab === 'stats') this.renderStats(sim);
    else this.invalidate();
  }

  private resize(): void {
    const rect = this.body.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.invalidate();
  }

  private invalidate(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  // ---- controls ------------------------------------------------------------------

  /** Selectors for the telemetry tab, rebuilt only when their options change and nobody is using them. */
  private updateControls(force: boolean): void {
    const sim = this.race.sim;
    if (!sim || this.tab !== 'telemetry') {
      if (force || this.controlsKey !== '') setChildren(this.controlsEl);
      this.controlsKey = '';
      this.updateSummary();
      return;
    }
    const sel = this.race.telemetry;
    const pair = this.race.telemetryPair();
    const carA = pair?.carA ?? sim.order[0];
    const carB = sel.compare === 'car' && sel.compareCar !== null ? sim.cars[sel.compareCar] : null;
    const key = `${sim.cars.length}:${carA.id}:${carA.lapsDone}:${carB?.id ?? '-'}:${carB?.lapsDone ?? '-'}:${sel.lap}:${sel.compare}:${sel.compareLap}:${sim.order.map((c) => c.id).join('.')}`;
    const busy = this.controlsEl.contains(document.activeElement);
    if (!force && (key === this.controlsKey || busy)) {
      this.updateSummary();
      return;
    }
    this.controlsKey = key;
    const carSelect = h('select', { 'aria-label': 'Car', onchange: () => this.race.setTelemetry({ car: Number(carSelect.value) }) },
      ...sim.order.map((c) => h('option', { value: String(c.id) }, `${c.status === 'retired' ? 'DNF' : `P${c.position}`} ${c.entrant.code}`)));
    carSelect.value = String(carA.id);
    const lapSelect = lapPicker(carA, sel.lap, (lap) => this.race.setTelemetry({ lap }));
    const compareSelect = h('select', {
      'aria-label': 'Compare with',
      onchange: () => {
        const v = compareSelect.value;
        if (v === 'none' || v === 'fastest') this.race.setTelemetry({ compare: v });
        else this.race.setTelemetry({ compare: 'car', compareCar: Number(v) });
      },
    },
    h('option', { value: 'none' }, 'No comparison'),
    h('option', { value: 'fastest' }, 'Fastest lap of the race'),
    ...sim.order.map((c) => h('option', { value: String(c.id) }, `vs ${c.entrant.code}`)));
    compareSelect.value = sel.compare === 'car' && sel.compareCar !== null ? String(sel.compareCar) : sel.compare;
    const parts: Node[] = [carSelect, lapSelect, compareSelect];
    if (carB) parts.push(lapPicker(carB, sel.compareLap, (lap) => this.race.setTelemetry({ compareLap: lap })));
    setChildren(this.controlsEl, ...parts);
    this.updateSummary();
  }

  private updateSummary(): void {
    const sim = this.race.sim;
    if (!sim) {
      setText(this.summaryEl, '');
      return;
    }
    if (this.tab !== 'telemetry') {
      const hints: Record<DockTab, string> = {
        telemetry: '',
        positions: 'Position at the end of each lap. Click a line to pick a car.',
        gaps: 'Seconds behind the leader at the end of each lap.',
        laps: 'Lap times; open dots are laps with a pit stop.',
        stints: 'Tyre sets per car; gaps are pit stops.',
        stats: '',
      };
      setText(this.summaryEl, hints[this.tab]);
      return;
    }
    const pair = this.race.telemetryPair();
    if (!pair?.a) {
      setText(this.summaryEl, 'No completed lap yet for this car.');
      return;
    }
    const lapText = (t: Telemetry) => (t.time !== null ? formatLapTime(t.time) : 'in progress');
    let text = `${pair.labelA} ${lapText(pair.a)}`;
    if (pair.b && pair.carB) {
      text += `  ·  ${pair.labelB} ${lapText(pair.b)}`;
      if (pair.a.time !== null && pair.b.time !== null) {
        const d = pair.b.time - pair.a.time;
        text += ` (${d >= 0 ? '+' : ''}${d.toFixed(3)})`;
      }
    }
    setText(this.summaryEl, text);
  }

  // ---- drawing -------------------------------------------------------------------

  private draw(): void {
    const sim = this.race.sim;
    const ctx = sizeCanvas(this.canvas, this.width, this.height);
    this.hits = [];
    if (!sim || this.tab === 'stats') return;
    if (this.tab === 'telemetry') this.drawTelemetry(ctx, sim);
    else if (this.tab === 'stints') this.drawStints(ctx, sim);
    else this.drawLapChart(ctx, sim);
  }

  private onMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (this.tab === 'telemetry') {
      const t = this.store.track;
      const p = this.plot;
      if (!t || x < p.x0 || x > p.x0 + p.w) {
        this.store.setHover(null);
        return;
      }
      const d = ((x - p.x0) / p.w) * t.length;
      this.store.setHover(Math.min(t.n - 1, Math.max(0, Math.round(d / t.ds))));
      return;
    }
    let best: Hit | null = null;
    let bestD = 14;
    for (const hit of this.hits) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d < bestD) {
        bestD = d;
        best = hit;
      }
    }
    if (best?.car !== this.hover?.car || best?.x !== this.hover?.x) {
      this.hover = best;
      this.canvas.style.cursor = best ? 'pointer' : 'default';
      this.invalidate();
    }
  }

  private drawTelemetry(ctx: CanvasRenderingContext2D, sim: RaceSim): void {
    const pair = this.race.telemetryPair();
    const track = sim.model.track;
    const a = pair?.a ?? null;
    const b = pair?.b ?? null;
    const W = this.width;
    const H = this.height;
    const x0 = 46;
    const plotW = Math.max(10, W - x0 - 12);
    this.plot = { x0, y0: 16, w: plotW, h: H - 34 };
    if (!pair || !a) {
      ctx.fillStyle = AXIS_TEXT;
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.fillText('Telemetry appears once the car has completed a lap.', W / 2, H / 2);
      return;
    }
    const colorA = pair.carA.entrant.color;
    const px = (d: number) => x0 + (d / track.length) * plotW;
    const panels: { key: string; weight: number }[] = [
      { key: 'speed', weight: 3 },
      { key: 'pedals', weight: 1.5 },
      { key: 'gear', weight: 1.2 },
      { key: 'g', weight: 1.8 },
    ];
    if (b && pair.delta) panels.push({ key: 'delta', weight: 1.4 });
    const total = panels.reduce((s, p) => s + p.weight, 0);
    const gap = 8;
    const top = 16;
    const bottom = H - 18;
    const avail = bottom - top - gap * (panels.length - 1);
    let y = top;

    // Corners along the top and sector lines through every panel.
    const m = this.store.metrics;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c9d1d9';
    if (m) for (const c of m.corners) ctx.fillText(`T${c.number}`, px(track.s[c.apex]), 7);

    const hoverK = this.store.hover;
    const hoverI = hoverK !== null ? Math.round(hoverK / sim.model.teleEvery) : null;
    const readout: string[] = [];

    for (const panel of panels) {
      const ph = (panel.weight / total) * avail;
      const plot: Plot = { x0, y0: y, w: plotW, h: ph };
      ctx.save();
      const series = (t: Telemetry, values: ArrayLike<number>, color: string, width: number, dash: number[] = [], scale = 1) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        polyline(ctx, t.count, (i) => px(t.x[i]), (i) => yv(values[i] * scale));
        ctx.setLineDash([]);
      };
      let yv: (v: number) => number = () => 0;
      if (panel.key === 'speed') {
        let hi = 0;
        for (const t of [a, b]) if (t) for (let i = 0; i < t.count; i++) if (Number.isFinite(t.v[i])) hi = Math.max(hi, t.v[i] * 3.6);
        hi = Math.ceil((hi * 1.05) / 50) * 50 || 100;
        yv = yAxis(ctx, plot, 0, hi, niceStep(hi, Math.max(2, ph / 28)), (v) => `${v}`);
        if (b) series(b, b.v, COMPARE_COLOR, 1.25, [], 3.6);
        series(a, a.v, colorA, 1.75, [], 3.6);
        if (hoverI !== null) readout.push(`${Math.round(a.v[hoverI] * 3.6)} km/h${b ? ` / ${Math.round(b.v[hoverI] * 3.6)}` : ''}`);
      } else if (panel.key === 'pedals') {
        yv = yAxis(ctx, plot, 0, 100, 50, (v) => `${v}%`);
        if (b) {
          series(b, b.throttle, 'rgba(74,222,128,0.55)', 1, [3, 3], 100);
          series(b, b.brake, 'rgba(255,90,95,0.55)', 1, [3, 3], 100);
        }
        series(a, a.throttle, THROTTLE, 1.5, [], 100);
        series(a, a.brake, BRAKE, 1.5, [], 100);
        if (hoverI !== null) readout.push(`throttle ${Math.round(a.throttle[hoverI] * 100)}% brake ${Math.round(a.brake[hoverI] * 100)}%`);
      } else if (panel.key === 'gear') {
        const gears = sim.model.vehicle.gears;
        yv = yAxis(ctx, plot, 0.5, gears + 0.5, gears > 6 ? 2 : 1, (v) => `${Math.round(v)}`);
        if (b) series(b, b.gear, COMPARE_COLOR, 1, [3, 3]);
        series(a, a.gear, colorA, 1.5);
        if (hoverI !== null) readout.push(`gear ${a.gear[hoverI]}${b ? ` / ${b.gear[hoverI]}` : ''}`);
      } else if (panel.key === 'g') {
        let hi = 1;
        for (const t of [a, b]) if (t) for (let i = 0; i < t.count; i++) {
          if (Number.isFinite(t.latG[i])) hi = Math.max(hi, Math.abs(t.latG[i]));
          if (Number.isFinite(t.lonG[i])) hi = Math.max(hi, Math.abs(t.lonG[i]));
        }
        hi = Math.ceil(hi);
        yv = yAxis(ctx, plot, -hi, hi, niceStep(2 * hi, Math.max(2, ph / 24)), (v) => `${v}`);
        if (b) {
          series(b, b.latG, COMPARE_COLOR, 1);
          series(b, b.lonG, COMPARE_COLOR, 1, [3, 3]);
        }
        series(a, a.latG, colorA, 1.5);
        series(a, a.lonG, '#ffb020', 1.5);
        if (hoverI !== null) readout.push(`lateral ${a.latG[hoverI].toFixed(1)} g, longitudinal ${a.lonG[hoverI].toFixed(1)} g`);
      } else if (panel.key === 'delta' && b && pair.delta) {
        const delta = pair.delta;
        let hi = 0.1;
        for (let i = 0; i < delta.length; i++) if (Number.isFinite(delta[i])) hi = Math.max(hi, Math.abs(delta[i]));
        hi = niceStep(hi, 1) * Math.ceil(hi / niceStep(hi, 1));
        yv = yAxis(ctx, plot, -hi, hi, hi, (v) => `${v > 0 ? '+' : ''}${v.toFixed(hi < 1 ? 1 : 0)}`);
        // Shade where the comparison is behind (red) or ahead (green).
        const zero = yv(0);
        for (let i = 1; i < a.x.length; i++) {
          if (!Number.isFinite(delta[i]) || !Number.isFinite(delta[i - 1])) continue;
          ctx.fillStyle = delta[i] > 0 ? 'rgba(255,90,95,0.25)' : 'rgba(74,222,128,0.25)';
          const xa = px(a.x[i - 1]);
          const xb = px(a.x[i]);
          const yd = yv(delta[i]);
          ctx.fillRect(xa, Math.min(zero, yd), Math.max(0.5, xb - xa), Math.abs(yd - zero));
        }
        ctx.strokeStyle = TEXT;
        ctx.lineWidth = 1.25;
        polyline(ctx, a.x.length, (i) => px(a.x[i]), (i) => yv(delta[i]));
        if (hoverI !== null && Number.isFinite(delta[hoverI])) readout.push(`delta ${delta[hoverI] >= 0 ? '+' : ''}${delta[hoverI].toFixed(3)} s`);
      }
      // Panel name in the corner.
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillStyle = AXIS_TEXT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const names: Record<string, string> = { speed: 'Speed km/h', pedals: 'Throttle / brake', gear: 'Gear', g: 'Lateral / longitudinal g', delta: `Delta ${pair.labelB} vs ${pair.labelA}` };
      ctx.fillText(names[panel.key], x0 + 4, y + 2);
      ctx.restore();
      y += ph + gap;
    }

    // Sector lines and the distance axis.
    ctx.strokeStyle = 'rgba(255,214,10,0.5)';
    ctx.setLineDash([4, 3]);
    for (const k of sim.model.sectors) {
      const x = Math.round(px(track.s[k])) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const step = niceStep(track.length, Math.max(2, plotW / 90));
    ctx.font = FONT;
    ctx.fillStyle = AXIS_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 0; d <= track.length; d += step) ctx.fillText(`${(d / 1000).toFixed(step < 1000 ? 1 : 0)} km`, px(d), bottom + 3);

    // Hover line and readout.
    if (hoverK !== null && hoverK < track.n) {
      const x = Math.round(px(track.s[hoverK])) + 0.5;
      ctx.strokeStyle = '#3fb6ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      const text = `${(track.s[hoverK] / 1000).toFixed(2)} km · ${readout.filter((r) => !r.includes('NaN')).join(' · ')}`;
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 12;
      const left = x + w + 8 > W ? x - w - 8 : x + 8;
      tag(ctx, left, top + 10, text, 'rgba(12,15,19,0.92)', TEXT);
    }
  }

  private drawLapChart(ctx: CanvasRenderingContext2D, sim: RaceSim): void {
    const W = this.width;
    const H = this.height;
    const maxLap = Math.max(1, ...sim.cars.map((c) => c.lapsDone));
    const plot: Plot = { x0: 52, y0: 12, w: Math.max(10, W - 52 - 64), h: Math.max(10, H - 12 - 24) };
    const selected = this.race.selected;
    const hoverCar = this.hover?.car ?? null;
    let series: { car: RaceCar; points: number[]; first: number }[];
    let y: (v: number) => number;
    let valueText: (v: number) => string;
    let x: (lap: number) => number;

    if (this.tab === 'positions') {
      const pos = positionsByLap(sim);
      series = sim.cars.map((car) => ({ car, points: pos.get(car.id)!, first: 0 }));
      x = lapAxis(ctx, plot, 0, maxLap);
      const n = sim.cars.length;
      y = yAxis(ctx, plot, 1, n, n > 20 ? 5 : n > 10 ? 2 : 1, (v) => `P${v}`, true);
      valueText = (v) => `P${v}`;
    } else if (this.tab === 'gaps') {
      const gaps = gapsByLap(sim);
      series = sim.cars.map((car) => ({ car, points: gaps.get(car.id)!, first: 1 }));
      let hi = 1;
      for (const s of series) for (const g of s.points) if (Number.isFinite(g)) hi = Math.max(hi, g);
      const step = niceStep(hi, Math.max(2, plot.h / 30));
      hi = Math.ceil(hi / step) * step;
      x = lapAxis(ctx, plot, 1, maxLap);
      y = yAxis(ctx, plot, 0, hi, step, (v) => (v === 0 ? '0' : `+${v}`), true);
      valueText = (v) => `+${v.toFixed(3)} s`;
    } else {
      series = sim.cars.map((car) => ({ car, points: car.history.map((hh) => hh.time), first: 1 }));
      const clean: number[] = [];
      for (const c of sim.cars) for (const hh of c.history) if (hh.lap > 1 && !hh.pit) clean.push(hh.time);
      clean.sort((p, q) => p - q);
      const lo = clean.length ? clean[0] : sim.model.lapTime;
      const med = clean.length ? clean[Math.floor(clean.length / 2)] : sim.model.lapTime;
      const top = Math.max(lo + 1, med + (med - lo) * 1.5 + 0.5);
      const step = niceStep(top - lo, Math.max(2, plot.h / 28));
      const yLo = Math.floor((lo - 0.2) / step) * step;
      x = lapAxis(ctx, plot, 1, maxLap);
      const inner = yAxis(ctx, plot, yLo, top, step, (v) => formatLapTime(v).replace(/\.\d+$/, (s) => s.slice(0, 2)));
      // Slow laps (the start, stops, incidents) sit on the top edge.
      y = (v) => inner(Math.min(v, top));
      valueText = (v) => formatLapTime(v);
    }

    const perTeam = Math.max(1, sim.model.rules.field.perTeam);
    const focus = hoverCar ?? selected;
    // Other cars first, then the focused one on top.
    const ordered = [...series].sort((p, q) => Number(p.car.id === focus) - Number(q.car.id === focus));
    for (const s of ordered) {
      const e = s.car.entrant;
      const on = focus === null || s.car.id === focus;
      ctx.globalAlpha = on ? 1 : 0.28;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = s.car.id === focus ? 2.5 : 1.5;
      ctx.setLineDash(e.index % perTeam === 1 ? [5, 3] : []);
      polyline(ctx, s.points.length, (i) => x(i + s.first), (i) => y(s.points[i]));
      ctx.setLineDash([]);
      for (let i = 0; i < s.points.length; i++) {
        const v = s.points[i];
        if (!Number.isFinite(v)) continue;
        const px = x(i + s.first);
        const py = y(v);
        this.hits.push({ car: s.car.id, x: px, y: py, text: `${e.code} · ${i + s.first === 0 ? 'grid' : `lap ${i + s.first}`} · ${valueText(v)}` });
        const pit = this.tab === 'laps' && s.car.history[i]?.pit;
        if (pit && on) {
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      // End label: the car's code, and a cross where a retired car stopped.
      const last = s.points.length - 1;
      if (last >= 0 && (this.tab === 'positions' || s.car.id === focus)) {
        const lx = x(last + s.first);
        const ly = y(s.points[last]);
        if (Number.isFinite(ly)) {
          ctx.font = '600 10px system-ui, sans-serif';
          ctx.fillStyle = e.color;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${s.car.status === 'retired' ? '✕ ' : ''}${e.code}`, lx + 5, ly);
        }
      }
    }
    ctx.globalAlpha = 1;
    if (this.hover) tag(ctx, Math.min(this.hover.x + 10, W - 180), Math.max(12, this.hover.y - 14), this.hover.text, 'rgba(12,15,19,0.92)', TEXT);
  }

  private drawStints(ctx: CanvasRenderingContext2D, sim: RaceSim): void {
    const W = this.width;
    const H = this.height;
    const maxLap = Math.max(1, ...sim.cars.map((c) => c.lapsDone));
    const cars = sim.order;
    const plot: Plot = { x0: 64, y0: 6, w: Math.max(10, W - 64 - 16), h: Math.max(10, H - 6 - 24) };
    const rowH = Math.min(22, plot.h / Math.max(1, cars.length));
    const x = lapAxis(ctx, { ...plot, h: rowH * cars.length }, 0, maxLap);
    const compounds = sim.model.rules.tyres.compounds;
    const all = stints(sim);
    cars.forEach((car, row) => {
      const y0 = plot.y0 + row * rowH;
      const selected = this.race.selected === car.id;
      if (selected) {
        ctx.fillStyle = 'rgba(63,182,255,0.14)';
        ctx.fillRect(0, y0, W, rowH);
      }
      ctx.font = `${selected ? 700 : 600} 11px system-ui, sans-serif`;
      ctx.fillStyle = car.status === 'retired' ? AXIS_TEXT : TEXT;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${car.status === 'retired' ? '' : `P${car.position} `}${car.entrant.code}`, plot.x0 - 8, y0 + rowH / 2);
      ctx.fillStyle = car.entrant.color;
      ctx.fillRect(plot.x0 - 5, y0 + 3, 3, rowH - 6);
      for (const s of all.get(car.id) ?? []) {
        const c = compounds[s.compound];
        const xa = x(s.from - 1) + 1;
        const xb = x(s.to) - 1;
        const bh = Math.max(4, rowH - 6);
        ctx.fillStyle = c.color;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.roundRect(xa, y0 + (rowH - bh) / 2, Math.max(1, xb - xa), bh, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (xb - xa > 34 && rowH >= 12) {
          ctx.fillStyle = '#0b0d10';
          ctx.font = '700 10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${c.code} ${s.to - s.from + 1}`, (xa + xb) / 2, y0 + rowH / 2 + 0.5);
        }
        this.hits.push({ car: car.id, x: (xa + xb) / 2, y: y0 + rowH / 2, text: `${car.entrant.code} · ${c.name}, laps ${s.from}–${s.to}` });
      }
      if (car.status === 'retired' && car.retired) {
        ctx.fillStyle = AXIS_TEXT;
        ctx.font = FONT;
        ctx.textAlign = 'left';
        ctx.fillText(`✕ ${car.retired.reason}`, x(car.lapsDone) + 6, y0 + rowH / 2);
      }
    });
    ctx.strokeStyle = GRID;
    if (this.hover) tag(ctx, Math.min(this.hover.x + 10, W - 200), this.hover.y - 14, this.hover.text, 'rgba(12,15,19,0.92)', TEXT);
  }

  // ---- statistics ----------------------------------------------------------------

  private renderStats(sim: RaceSim): void {
    const code = (id: number) => {
      const e = sim.cars[id].entrant;
      return h('span', null, h('span', { class: 'dot', style: `background:${e.color}` }), e.code);
    };
    const compounds = sim.model.rules.tyres.compounds;
    const table = (title: string, head: string[], rows: (string | Node)[][], note?: string) =>
      h('div', { class: 'stat-block' },
        h('h3', null, title),
        rows.length
          ? h('table', { class: 'table' },
              h('thead', null, h('tr', null, ...head.map((c, i) => h('th', { class: i === 1 ? '' : 'num' }, c)))),
              h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c, i) => h('td', { class: i === 1 ? '' : 'num' }, c))))))
          : h('p', { class: 'muted small' }, 'Nothing yet.'),
        note ? h('p', { class: 'hint' }, note) : null);

    const fl = fastestLaps(sim);
    const traps = speedTraps(sim);
    const overtakes = overtakeCounts(sim).filter((o) => o.made || o.lost);
    const stops = pitStops(sim);
    const totalOvertakes = sim.events.filter((e) => e.kind === 'overtake').length;
    setChildren(this.statsEl,
      table('Fastest laps', ['#', 'Driver', 'Time', 'Gap', 'Lap', 'Tyre'],
        fl.map((f, i) => [String(i + 1), code(f.car), formatLapTime(f.time), i === 0 ? '' : `+${f.gap.toFixed(3)}`, String(f.lap), compounds[f.compound].code])),
      table('Speed trap', ['#', 'Driver', 'km/h', 'Lap'],
        traps.map((t, i) => [String(i + 1), code(t.car), (t.speed * 3.6).toFixed(1), String(t.lap)]),
        'Best speed through the trap on laps without a stop.'),
      table(`Overtakes (${totalOvertakes})`, ['#', 'Driver', 'Made', 'Lost', 'Net'],
        overtakes.map((o, i) => [String(i + 1), code(o.car), String(o.made), String(o.lost), `${o.made - o.lost > 0 ? '+' : ''}${o.made - o.lost}`]),
        'Passes for position; lapping backmarkers is not counted.'),
      table(`Pit stops (${stops.length})`, ['#', 'Driver', 'Stationary', 'Pit lane', 'Lap', 'Tyres'],
        stops.slice(0, 40).map((s, i) => [String(i + 1), code(s.car), `${s.stationary.toFixed(1)} s`, Number.isFinite(s.exit) ? `${(s.exit - s.entry).toFixed(1)} s` : '—', String(s.lap),
          s.to === null ? 'no change' : `${compounds[s.from].code} → ${compounds[s.to].code}`]),
        'Shortest time in the box first; the pit lane time runs from entry to exit.'),
    );
  }
}

/** A lap selector: last, best, current, or any completed lap with its time. */
function lapPicker(car: RaceCar, value: LapChoice, onChange: (lap: LapChoice) => void): HTMLSelectElement {
  const sel = h('select', {
    'aria-label': `${car.entrant.code} lap`,
    onchange: () => {
      const v = sel.value;
      onChange(v === 'last' || v === 'best' || v === 'current' ? v : Number(v));
    },
  },
  h('option', { value: 'last' }, 'Last lap'),
  h('option', { value: 'best' }, 'Best lap'),
  h('option', { value: 'current' }, 'Current lap'),
  ...[...car.history].reverse().map((hh) => h('option', { value: String(hh.lap) }, `Lap ${hh.lap} · ${formatLapTime(hh.time)}${hh.pit ? ' (pit)' : ''}`)));
  sel.value = String(value);
  return sel;
}
