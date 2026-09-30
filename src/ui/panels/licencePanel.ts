/** The circuit licence estimate and the facilities, as Analyse panel sections. */
import type { LicenceCheck } from '../../core/licence.ts';
import { segmented } from '../controls.ts';
import { h } from '../dom.ts';
import * as fmt from '../format.ts';
import type { Store } from '../store.ts';

const ICON: Record<string, string> = { pass: '✓', required: '✗', recommended: '!', info: 'i' };

export function licenceSection(store: Store, onLocate: (station: number) => void): HTMLElement | null {
  const lic = store.licence;
  const pending = store.performancePending;
  if (!lic) {
    return h('section', { class: 'panel-section' }, h('h3', null, 'Circuit licence'),
      h('p', { class: 'muted small' }, pending ? 'Calculating…' : 'Appears once lap times are ready.'));
  }
  const badge = (body: string, grade: string | null) =>
    h('div', { class: `grade-badge${grade ? '' : ' none'}` },
      h('span', { class: 'grade-body' }, body),
      h('span', { class: 'grade-value' }, grade ? `Grade ${grade}` : 'Not licensable'));

  const classes = h('div', { class: 'class-chips' }, ...lic.classes.map((c) => {
    const v = store.vehicles.find((x) => x.id === c.id)!;
    return h('span', { class: `class-chip${c.allowed ? '' : ' blocked'}`, title: `${v.name} needs ${c.needs}` },
      h('span', { class: 'dot', style: `background:${v.color}` }), v.name);
  }));

  const runoffPicker = segmented(
    [{ value: 'off', label: 'Off' }, ...['1', '2', '3', '4'].map((g) => ({ value: g, label: g, title: `FIA grade ${g}` })), ...['A', 'B'].map((g) => ({ value: g, label: g, title: `FIM grade ${g}` }))],
    () => store.view.runoffGrade ?? 'off',
    (v) => store.setView({ runoffGrade: v === 'off' ? null : v }),
  );

  const list = (body: 'FIA' | 'FIM') => h('ul', { class: 'checks' }, ...lic.checks.filter((c) => c.body === body).map((c) => checkRow(c, onLocate)));
  const results = (body: 'FIA' | 'FIM') => {
    const r = body === 'FIA' ? lic.fia.results : lic.fim.results;
    return h('div', { class: 'grade-ladder' }, ...r.map((g) =>
      h('span', { class: `grade-step${g.passes ? ' ok' : ''}`, title: g.passes ? 'All required checks pass' : g.failures.map((f) => f.label).join('\n') },
        `${g.grade} ${g.passes ? '✓' : `✗ ${g.failures.length}`}`)));
  };

  return h('section', { class: 'panel-section' },
    h('h3', null, 'Circuit licence', pending ? h('span', { class: 'badge' }, 'updating') : null),
    h('div', { class: 'grade-badges' }, badge('FIA', lic.fia.grade), badge('FIM', lic.fim.grade)),
    h('p', { class: 'hint' }, 'An estimate from the layout alone: a real licence also depends on barriers, buildings, medical facilities and an FIA or FIM inspection.'),
    classes,
    h('div', { class: 'field' }, h('span', null, 'Show run-off escape paths for grade'), runoffPicker.el),
    h('details', { class: 'check-group', open: true }, h('summary', null, 'FIA (cars) ', results('FIA')), list('FIA')),
    h('details', { class: 'check-group' }, h('summary', null, 'FIM (bikes) ', results('FIM')), list('FIM')),
    h('details', { class: 'check-group' },
      h('summary', null, 'Largest permitted grid'),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Cars'), h('th', { class: 'num' }, '1 h'), h('th', { class: 'num' }, '6 h'))),
        h('tbody', null, ...lic.maxStarters.map((m) => h('tr', null, h('td', null, m.label), h('td', { class: 'num' }, String(m.sprint)), h('td', { class: 'num' }, String(m.sixHours)))))),
      h('p', { class: 'hint' }, 'FIA Appendix O supplement 2, from the circuit length and narrowest width.')),
  );
}

function checkRow(c: LicenceCheck, onLocate: (station: number) => void): HTMLElement {
  const state = c.pass ? 'pass' : c.level;
  const grades = c.grades.length ? h('span', { class: 'check-grades' }, c.grades.join(' ')) : null;
  return h('li', {
    class: `check ${state}${c.focus !== undefined ? ' link' : ''}`,
    title: c.source,
    onclick: c.focus !== undefined ? () => onLocate(c.focus!) : undefined,
  },
  h('span', { class: 'check-icon' }, ICON[state]),
  h('span', { class: 'check-text' }, c.label, h('span', { class: 'check-detail' }, c.detail)),
  grades);
}

export function facilitiesSection(store: Store, onLocate: (station: number) => void): HTMLElement | null {
  const f = store.facilities;
  const t = store.track;
  const sf = store.startFinish;
  if (!t || !sf) return null;
  const row = (label: string, value: string | Node, station?: number) =>
    [h('dt', null, label), h('dd', station === undefined ? null : { class: 'link', onclick: () => onLocate(station) }, value)];
  const reset = (key: 'startFinish' | 'pitLane' | 'speedTrap') =>
    store.project.overrides[key] ? h('button', { class: 'btn small subtle', onclick: () => store.setOverride(key, null) }, 'Automatic') : null;

  const startRows = h('dl', { class: 'stats' },
    ...row('To the first corner', fmt.metres(sf.firstCornerDistance), 0),
    ...row('Grid gradient', fmt.gradient(sf.gridMaxGradient)),
    ...row('Grid width', `${sf.gridMinWidth.toFixed(1)} m`),
  );

  const parts: (HTMLElement | null)[] = [
    h('div', { class: 'facility-head' }, h('strong', null, 'Start/finish'), h('span', { class: 'muted small' }, sf.overridden ? 'moved by hand' : 'placed automatically'), reset('startFinish')),
    startRows,
  ];

  if (f && store.performanceCurrent) {
    const pit = f.pitLane;
    parts.push(h('div', { class: 'facility-head' }, h('strong', null, 'Pit lane'),
      h('span', { class: 'muted small' }, pit ? (pit.overridden ? 'moved by hand' : 'placed automatically') : 'no place found'),
      pit ? h('button', { class: 'btn small subtle', title: 'Put the pit lane on the other side of the track', onclick: () => store.setOverride('pitLane', {
        entry: { x: t.x[pit.entry], y: t.y[pit.entry] }, exit: { x: t.x[pit.exit], y: t.y[pit.exit] }, side: pit.side === 1 ? -1 : 1,
      }) }, 'Other side') : null,
      reset('pitLane')));
    if (pit) {
      parts.push(h('dl', { class: 'stats' },
        ...row('Position', `${pit.kind === 'chord' ? 'across the infield' : 'beside the track'}, ${pit.side === 1 ? 'left' : 'right'}`),
        ...row('Entry / exit', `${fmt.km(t.s[pit.entry])} / ${fmt.km(t.s[pit.exit])}`, pit.entry),
        ...row('Length', `${fmt.metres(pit.length)} (boxes ${fmt.metres(pit.boxLength)})`),
        ...row('Width', `${pit.width} m`),
        ...row('Beside the start', pit.adjacentToStart ? 'yes' : 'no'),
      ));
      if (pit.problems.length) parts.push(h('ul', { class: 'issues' }, ...pit.problems.map((p) => h('li', { class: 'issue error' }, h('span', { class: 'issue-icon' }, '●'), h('span', { class: 'issue-text' }, p)))));
      const losses = [...f.pitLoss].sort((a, b) => a.loss - b.loss);
      parts.push(h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Drive-through loss'), h('th', { class: 'num' }, 'Limit'), h('th', { class: 'num' }, 'Loss'))),
        h('tbody', null, ...losses.map((l) => {
          const v = store.vehicles.find((x) => x.id === l.vehicleId)!;
          return h('tr', null, h('td', null, h('span', { class: 'dot', style: `background:${v.color}` }), v.name),
            h('td', { class: 'num muted' }, `${Math.round(v.pitSpeed * 3.6)}`), h('td', { class: 'num' }, `${l.loss.toFixed(1)} s`));
        }))));
    }
    const fastest = store.performance?.laps.reduce((a, b) => (b.time < a.time ? b : a));
    parts.push(
      h('div', { class: 'facility-head' }, h('strong', null, 'Timing and racing'), reset('speedTrap')),
      h('dl', { class: 'stats' },
        ...row('Speed trap', `${fmt.km(t.s[f.speedTrap.station])}${fastest ? `, ${fmt.speed(fastest.v[f.speedTrap.station])}` : ''}`, f.speedTrap.station),
        ...row('DRS zones', f.drsZones.length ? f.drsZones.map((z) => fmt.metres(z.length)).join(', ') : 'none (no straight of 400 m)', f.drsZones[0]?.start),
        ...row('Overtaking spots', f.overtaking.length ? f.overtaking.map((o) => `${fmt.km(t.s[o.station])} (−${Math.round(o.speedDrop * 3.6)} km/h)`).join(', ') : 'none', f.overtaking[0]?.station),
        ...row('Marshal posts', `${f.marshals.posts.length}, largest gap ${fmt.metres(f.marshals.maxGap)}${f.marshals.unobserved ? `, ${fmt.metres(f.marshals.unobserved)} unseen` : ''}`),
      ),
    );
  }
  parts.push(h('p', { class: 'hint' }, 'Drag Start, Pit in, Pit out and Speed on the map to move them; Automatic puts them back.'));
  return h('section', { class: 'panel-section' }, h('h3', null, 'Facilities'), ...parts);
}
