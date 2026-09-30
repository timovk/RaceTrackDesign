/** Analyse mode: lap times, headline metrics, corners, straights and warnings. */
import { CORNER_LABELS } from '../../core/analysis.ts';
import { section } from '../controls.ts';
import { h, setChildren } from '../dom.ts';
import * as fmt from '../format.ts';
import type { Store, Topic } from '../store.ts';
import { issueList } from './issueList.ts';
import { lapTimesSection } from './lapTimes.ts';
import { facilitiesSection, licenceSection } from './licencePanel.ts';

export class AnalysePanel {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly onLocate: (station: number) => void;
  private readonly lapsEl: HTMLElement;
  private readonly circuitEl: HTMLElement;
  private readonly geometryEl: HTMLElement;

  constructor(store: Store, onLocate: (station: number) => void) {
    this.store = store;
    this.onLocate = onLocate;
    this.lapsEl = h('div');
    this.circuitEl = h('div');
    this.geometryEl = h('div');
    this.el = h('div', { class: 'panel' }, this.lapsEl, this.circuitEl, this.geometryEl);
    store.subscribe((topics) => this.update(topics));
    this.update(new Set<Topic>(['track', 'performance']));
  }

  private locate(start: number, end: number, centre: number): void {
    this.store.setFocus({ start, end, centre });
    this.onLocate(centre);
  }

  private update(topics: Set<Topic>): void {
    if (topics.has('performance') || topics.has('vehicle') || topics.has('track')) {
      setChildren(this.lapsEl, this.store.track ? lapTimesSection(this.store) : null);
    }
    if (topics.has('performance') || topics.has('track') || topics.has('view') || topics.has('project')) {
      const s = this.store;
      setChildren(this.circuitEl, s.track ? licenceSection(s, this.onLocate) : null, s.track ? facilitiesSection(s, this.onLocate) : null);
    }
    if (topics.has('track') || topics.has('focus')) this.updateGeometry();
  }

  private updateGeometry(): void {
    const s = this.store;
    const t = s.track;
    const m = s.metrics;
    if (!t || !m) {
      setChildren(this.geometryEl, h('p', { class: 'muted' }, 'Draw a closed track in Design to see its analysis.'));
      return;
    }

    const row = (label: string, value: string, station?: number) =>
      [h('dt', null, label), h('dd', station === undefined ? null : {
        class: 'link', title: 'Show on the map',
        onclick: () => this.locate(station, station, station),
      }, value)];

    const overview = h('dl', { class: 'stats' },
      ...row('Length', fmt.km(m.length, 3)),
      ...row('Direction', m.direction),
      ...row('Height difference', fmt.elevation(m.elevationRange)),
      ...row('Highest / lowest', `${fmt.elevation(m.maxZ)} / ${fmt.elevation(m.minZ)}`),
      ...row('Climb per lap', fmt.elevation(m.totalClimb)),
      ...row('Steepest uphill', fmt.gradient(m.maxUphill), m.maxUphillAt),
      ...row('Steepest downhill', fmt.gradient(m.maxDownhill), m.maxDownhillAt),
      ...row('Longest straight', m.longestStraight ? fmt.distance(m.longestStraight.length) : '—', m.longestStraight?.start),
      ...row('Corners', `${m.corners.length} (${m.rightTurns} right, ${m.leftTurns} left)`),
      ...row('Tightest corner', fmt.radius(m.minRadius), m.minRadiusAt),
      ...row('Sharpest crest / dip', `${fmt.radius(m.crestRadius)} / ${fmt.radius(m.dipRadius)}`),
      ...row('Width', m.minWidth === m.maxWidth ? fmt.metres(m.minWidth, 1) : `${fmt.metres(m.minWidth, 1)} – ${fmt.metres(m.maxWidth, 1)}`),
      ...row('Max cut / fill', `${fmt.metres(m.maxCut, 1)} / ${fmt.metres(m.maxFill, 1)}`),
      ...row('Earthworks', `${fmt.volume(m.cutVolume)} cut, ${fmt.volume(m.fillVolume)} fill`),
    );

    const corners = m.corners.length
      ? h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Turn'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Radius'), h('th', { class: 'num' }, 'Angle'), h('th', { class: 'num' }, 'At'))),
          h('tbody', null, ...m.corners.map((c) =>
            h('tr', {
              class: s.focus?.centre === c.apex ? 'focused' : '',
              onclick: () => this.locate(c.start, c.end, c.apex),
              onmouseenter: () => s.setHover(c.apex),
              onmouseleave: () => s.setHover(null),
            },
            h('td', null, h('span', { class: `dir ${c.direction}` }, c.direction === 'right' ? '↱' : '↰'), ` T${c.number}`),
            h('td', null, CORNER_LABELS[c.type]),
            h('td', { class: 'num' }, fmt.radius(c.minRadius)),
            h('td', { class: 'num' }, fmt.degrees(c.angle)),
            h('td', { class: 'num' }, fmt.km(t.s[c.apex]))))))
      : h('p', { class: 'muted small' }, 'No corners: the loop is one long curve or nearly straight.');

    const straights = m.straights.length
      ? h('ul', { class: 'plain-list' }, ...[...m.straights].sort((a, b) => b.length - a.length).map((st) =>
          h('li', { class: 'link', onclick: () => this.locate(st.start, st.end, st.start) },
            h('span', null, fmt.distance(st.length)), h('span', { class: 'muted' }, `from ${fmt.km(t.s[st.start])}`))))
      : h('p', { class: 'muted small' }, 'No straights of 100 m or more.');

    setChildren(this.geometryEl,
      section('Overview', overview),
      section(`Corners (${m.corners.length})`, corners,
        h('p', { class: 'hint' }, 'Numbered from the start/finish line. Click a row to show it on the map.')),
      section('Straights', straights),
      section(`Checks (${s.issues.length})`, issueList(s, this.onLocate)),
      h('button', { class: 'btn primary block', onclick: () => s.setMode('race') }, 'Next: race on it'),
    );
  }
}
