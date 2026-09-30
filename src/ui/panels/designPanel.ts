/** Design mode: drawing tools, the selected point, track width and grading. */
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

    this.el = h('div', { class: 'panel' },
      section('Tool', tools.el, this.help),
      this.pointCard,
      section('Track', width.el,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => store.edit((x) => x.points.forEach((p) => { p.width = x.defaultWidth; })) }, 'Apply width to all'),
          h('button', { class: 'btn', title: 'Drive the other way round', onclick: () => this.reverse() }, 'Reverse direction'))),
      section('Grading', smoothing.el, cutFill.el,
        h('p', { class: 'hint' }, 'The track follows the ground, evened out over the smoothing length, but is never dug in or raised more than the limit.')),
      section('Checks', this.checks),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger subtle', onclick: () => { store.edit((x) => { x.points = []; }); store.select(null); } }, 'Clear track'),
        h('button', { class: 'btn primary grow', onclick: () => store.setMode('analyse') }, 'Next: analyse')),
    );

    store.subscribe((topics) => this.update(topics));
    this.update(new Set<Topic>(['project', 'selection', 'mode', 'track']));
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
