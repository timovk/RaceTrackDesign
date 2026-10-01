/** Design mode: drawing tools, the selected point, track width and grading, and the circuit's layouts. */
import { formatLapTime } from '../../core/calibration.ts';
import { sampleHeight } from '../../core/heightmap.ts';
import { type Control, section, segmented, slider } from '../controls.ts';
import { h, setChildren } from '../dom.ts';
import * as fmt from '../format.ts';
import type { Store, Tool, Topic } from '../store.ts';
import { issueList } from './issueList.ts';

const HELP: Record<Tool, string[]> = {
  points: [
    'Click empty ground to add a point after the selected one.',
    'Click the track to insert a point there.',
    'Drag points to move them. Right-click or Delete removes one.',
    'Pan with right-drag or Space + drag; scroll to zoom.',
  ],
  freehand: [
    'Drag to sketch a loop; it closes by itself.',
    'The sketch replaces the current track and turns into editable points.',
  ],
  link: [
    'Click the track where the link leaves it.',
    'Click the ground to lead it across.',
    'Click the track again where it joins: the layout runs round the circuit to the link, along it, and on from where it joins.',
    'Esc or right-click stops drawing.',
  ],
};

export class DesignPanel {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly onLocate: (station: number) => void;
  private readonly controls: Control[] = [];
  private readonly help: HTMLElement;
  private readonly pointCard: HTMLElement;
  private readonly pointTitle: HTMLElement;
  private readonly pointInfo: HTMLElement;
  private readonly pointWidth: Control;
  private readonly checks: HTMLElement;
  private readonly layouts: HTMLElement;
  private readonly linkStatus: HTMLElement;

  constructor(store: Store, onLocate: (station: number) => void) {
    this.store = store;
    this.onLocate = onLocate;
    const d = () => store.design;

    const tools = segmented<Tool>(
      [{ value: 'points', label: 'Points' }, { value: 'freehand', label: 'Freehand' }],
      () => store.tool,
      (tool) => store.setTool(tool),
    );
    this.help = h('ul', { class: 'help' });

    this.pointTitle = h('h3');
    this.pointInfo = h('p', { class: 'muted small' });
    this.pointWidth = slider({
      label: 'Width here', min: 6, max: 30, step: 0.5, format: (v) => `${v} m`,
      get: () => (store.selected !== null ? d().points[store.selected]?.width ?? d().defaultWidth : d().defaultWidth),
      onStart: () => store.beginEdit(),
      onInput: (v) => store.updateDesign((x) => { if (store.selected !== null && x.points[store.selected]) x.points[store.selected].width = v; }),
      onCommit: () => store.commitEdit(),
    });
    this.pointCard = h('section', { class: 'panel-section card' },
      this.pointTitle, this.pointInfo, this.pointWidth.el,
      h('div', { class: 'row' },
        h('button', { class: 'btn', title: 'Put the start/finish line at this point (Analyse can move it back to automatic)', onclick: () => this.startHere() }, 'Start/finish here'),
        h('button', { class: 'btn danger', onclick: () => store.selected !== null && store.deletePoint(store.selected) }, 'Delete')),
    );

    const width = slider({
      label: 'Width for new points', min: 6, max: 30, step: 0.5, format: (v) => `${v} m`,
      get: () => d().defaultWidth,
      onStart: () => store.beginEdit(),
      onInput: (v) => store.updateDesign((x) => { x.defaultWidth = v; }),
      onCommit: () => store.commitEdit(),
    });
    const smoothing = slider({
      label: 'Smoothing', min: 0, max: 300, step: 5, format: (v) => (v ? `${v} m` : 'off'),
      title: 'Length over which the ground profile is evened out, as real circuits are graded',
      get: () => d().grading.smoothing,
      onStart: () => store.beginEdit(),
      onInput: (v) => store.updateDesign((x) => { x.grading.smoothing = v; }),
      onCommit: () => store.commitEdit(),
    });
    const cutFill = slider({
      label: 'Max cut or fill', min: 0, max: 40, step: 1, format: (v) => `${v} m`,
      title: 'Largest height the track may be dug into or raised above the ground',
      get: () => d().grading.maxCutFill,
      onStart: () => store.beginEdit(),
      onInput: (v) => store.updateDesign((x) => { x.grading.maxCutFill = v; }),
      onCommit: () => store.commitEdit(),
    });
    this.controls.push(tools, width, smoothing, cutFill, this.pointWidth);

    this.checks = h('div');
    this.layouts = h('div', { class: 'layout-list' });
    this.linkStatus = h('p', { class: 'link-status', hidden: true });

    this.el = h('div', { class: 'panel' },
      section('Tool', tools.el, this.help),
      this.pointCard,
      section('Track', width.el,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => store.edit((x) => x.points.forEach((p) => { p.width = x.defaultWidth; })) }, 'Apply width to all'),
          h('button', { class: 'btn', title: 'Drive the other way round', onclick: () => this.reverse() }, 'Reverse direction'))),
      section('Grading', smoothing.el, cutFill.el,
        h('p', { class: 'hint' }, 'The track follows the ground, evened out over the smoothing length, but is never dug in or raised more than the limit.')),
      section('Layouts', this.layouts, this.linkStatus,
        h('div', { class: 'row' },
          h('button', { class: 'btn', title: 'Draw a link from the track to another part of it: a new layout takes it', onclick: () => store.beginLink(null) }, 'Add layout')),
        h('p', { class: 'hint' }, 'A layout is the full circuit with a shortcut or an extra loop: draw a link from the track to another part of it, and the layout skips the stretch in between. Every layout keeps the start/finish line and shares the pit lane. Analyse and Race show the layout picked here or above the map.')),
      section('Checks', this.checks),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger subtle', onclick: () => { store.edit((x) => { x.points = []; }); store.select(null); } }, 'Clear track'),
        h('button', { class: 'btn primary grow', onclick: () => store.setMode('analyse') }, 'Next: analyse')),
    );

    store.subscribe((topics) => this.update(topics));
    this.update(new Set<Topic>(['project', 'selection', 'mode', 'track']));
  }

  /** The full circuit and each layout: its length and lap time for the class picked, or why it cannot be built. */
  private updateLayouts(): void {
    const s = this.store;
    const row = (i: number) => {
      const state = i === 0 ? null : s.layoutStates[i - 1];
      const t = i === 0 ? s.fullTrack : state?.built?.track ?? null;
      const lap = s.analysisOf(i)?.performance.laps.find((l) => l.vehicleId === s.vehicleId);
      const error = t ? null : state?.build.errors[0] ?? 'Draw a closed track first.';
      const status = t ? `${fmt.km(t.length)}${lap ? ` · ${s.vehicle.name} ${formatLapTime(lap.time)}` : ''}` : error ?? '';
      const name = i === 0
        ? h('span', { class: 'layout-name' }, 'Full circuit')
        : h('input', {
          type: 'text', class: 'layout-name', value: s.layoutName(i), title: 'Rename the layout',
          onclick: (e: Event) => e.stopPropagation(),
          onchange: (e: Event) => s.renameLayout(i, (e.target as HTMLInputElement).value),
        });
      return h('div', {
        class: `layout-row${s.layout === i ? ' on' : ''}${error && i > 0 ? ' error' : ''}`,
        title: i === 0 ? 'The whole circuit' : 'Show this layout in Analyse and Race',
        onclick: () => s.selectLayout(i),
      },
      h('div', { class: 'layout-main' }, name, h('span', { class: 'layout-status' }, status)),
      i > 0 ? h('button', { class: 'btn small', title: 'Draw another link for this layout', onclick: (e: Event) => { e.stopPropagation(); s.beginLink(i); } }, 'Add link') : null,
      i > 0 ? h('button', { class: 'icon-btn', title: 'Delete this layout', onclick: (e: Event) => { e.stopPropagation(); s.deleteLayout(i); } }, '\u00d7') : null);
    };
    setChildren(this.layouts, ...[0, ...s.project.layouts.map((_, j) => j + 1)].map(row));
    const drawing = s.tool === 'link';
    this.linkStatus.hidden = !drawing;
    if (drawing) {
      const d = s.linkDraft;
      const target = s.linkTarget !== null ? ` for ${s.layoutName(s.linkTarget)}` : '';
      this.linkStatus.textContent = d
        ? `Drawing a link${target}: ${d.points.length} point${d.points.length === 1 ? '' : 's'}. Click the track where it joins; Esc stops.`
        : `Drawing a link${target}: click the track where it leaves.`;
    }
  }

  private startHere(): void {
    const s = this.store;
    const pt = s.selected !== null ? s.design.points[s.selected] : undefined;
    if (pt) s.setOverride('startFinish', { x: pt.x, y: pt.y });
  }

  private reverse(): void {
    this.store.edit((d) => {
      if (d.points.length < 2) return;
      d.points = [d.points[0], ...d.points.slice(1).reverse()];
    });
    this.store.select(null);
  }

  private update(topics: Set<Topic>): void {
    const s = this.store;
    if (topics.has('mode')) setChildren(this.help, ...HELP[s.tool].map((line) => h('li', null, line)));
    if (['project', 'layout', 'track', 'performance', 'vehicle', 'mode'].some((t) => topics.has(t as Topic))) this.updateLayouts();
    if (topics.has('project') || topics.has('selection') || topics.has('mode')) for (const c of this.controls) c.update();
    if (topics.has('project') || topics.has('selection') || topics.has('track')) {
      const i = s.selected;
      const pts = s.design.points;
      const pt = i !== null ? pts[i] : undefined;
      this.pointCard.hidden = !pt;
      if (pt && i !== null) {
        this.pointTitle.textContent = `Point ${i + 1} of ${pts.length}`;
        const hm = s.terrain?.heightmap;
        const k = s.track?.pointStations[i];
        const ground = hm ? fmt.elevation(sampleHeight(hm, pt.x, pt.y)) : '—';
        const track = s.track && k !== undefined ? ` · track ${fmt.elevation(s.track.z[k])} at ${fmt.km(s.track.s[k])}` : '';
        this.pointInfo.textContent = `Ground ${ground}${track}`;
      }
    }
    if (topics.has('track')) {
      if (!s.track) setChildren(this.checks, h('p', { class: 'muted small' }, 'Checks appear once the track is a closed loop of three or more points.'));
      else setChildren(this.checks, issueList(s, this.onLocate, 6));
    }
  }
}
