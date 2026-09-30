/**
 * The timing tower over the map in Race mode: position, driver, gap to the
 * leader or interval to the car ahead, last and best lap, the latest sector
 * times coloured purple (best of anyone), green (personal best) or yellow,
 * tyres and stops. Rows are reused and refreshed a few times a second.
 */
import { formatLapTime } from '../core/calibration.ts';
import type { RaceCar, RaceSim, SectorMark } from '../core/race/sim.ts';
import { h, setChildren, setText } from './dom.ts';
import { gapText } from './panels/racePanel.ts';
import type { RaceController } from './raceController.ts';
import type { Store, Topic } from './store.ts';

const REFRESH_MS = 160;
const PREFS_KEY = 'racetrackdesign.tower';

interface Row {
  el: HTMLElement;
  pos: HTMLElement;
  moved: HTMLElement;
  code: HTMLElement;
  gap: HTMLElement;
  last: HTMLElement;
  best: HTMLElement;
  sectors: HTMLElement[];
  tyre: HTMLElement;
  pit: HTMLElement;
}

export class TimingTower {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly race: RaceController;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly gapHead: HTMLButtonElement;
  private readonly sizeButton: HTMLButtonElement;
  private rows = new Map<number, Row>();
  private sim: RaceSim | null = null;
  private interval = false;
  private compact = false;
  /** Whether the viewer has picked the tower size; until then it follows the map width. */
  private sizeChosen = false;
  private last = 0;

  constructor(store: Store, race: RaceController) {
    this.store = store;
    this.race = race;
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { interval?: boolean; compact?: boolean };
      this.interval = !!prefs.interval;
      this.compact = !!prefs.compact;
      this.sizeChosen = prefs.compact !== undefined;
    } catch {
      // No stored preferences; use the defaults.
    }
    this.title = h('span', { class: 'tower-title' });
    this.gapHead = h('button', { class: 'tower-toggle', title: 'Switch between gap to the leader and interval to the car ahead', onclick: () => this.setPrefs({ interval: !this.interval }) });
    this.sizeButton = h('button', { class: 'tower-toggle', title: 'Show or hide lap and sector times', onclick: () => this.setPrefs({ compact: !this.compact }) });
    this.body = h('div', { class: 'tower-body' });
    this.el = h('div', { class: 'tower', hidden: true },
      h('div', { class: 'tower-head' }, this.title, this.sizeButton),
      h('div', { class: 'tower-row tower-labels' },
        h('span', { class: 'tw-pos' }, ''), h('span', { class: 'tw-moved' }, ''), h('span', { class: 'tw-code' }, 'Driver'),
        h('span', { class: 'tw-gap' }, this.gapHead),
        h('span', { class: 'tw-time wide' }, 'Last'), h('span', { class: 'tw-time wide' }, 'Best'),
        h('span', { class: 'tw-sector wide' }, 'S1'), h('span', { class: 'tw-sector wide' }, 'S2'), h('span', { class: 'tw-sector wide' }, 'S3'),
        h('span', { class: 'tw-tyre' }, 'Tyre'), h('span', { class: 'tw-pit' }, 'Pit')),
      this.body);
    store.subscribe((topics) => this.onStore(topics));
    race.onTick(() => this.refresh(false));
    this.applyPrefs();
  }

  private setPrefs(p: { interval?: boolean; compact?: boolean }): void {
    if (p.interval !== undefined) this.interval = p.interval;
    if (p.compact !== undefined) {
      this.compact = p.compact;
      this.sizeChosen = true;
    }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ interval: this.interval, compact: this.sizeChosen ? this.compact : undefined }));
    } catch {
      // Storage unavailable; the choice lasts for this session.
    }
    this.applyPrefs();
    this.refresh(true);
  }

  private applyPrefs(): void {
    this.el.classList.toggle('compact', this.compact);
    setText(this.gapHead, this.interval ? 'Interval' : 'Gap');
    setText(this.sizeButton, this.compact ? 'Times' : 'Less');
  }

  private onStore(topics: Set<Topic>): void {
    if (topics.has('race') || topics.has('mode')) this.refresh(true);
  }

  private refresh(force: boolean): void {
    const sim = this.race.sim;
    const show = !!sim && this.store.mode === 'race';
    this.el.hidden = !show;
    if (!sim || !show) return;
    const now = performance.now();
    if (!force && now - this.last < REFRESH_MS) return;
    this.last = now;
    if (sim !== this.sim) {
      this.sim = sim;
      this.rows.clear();
      setChildren(this.body);
      if (!this.sizeChosen) {
        // Lap and sector times only when the map has room for them beside the track.
        this.compact = (this.el.parentElement?.clientWidth ?? 0) < 1300;
        this.applyPrefs();
      }
    }
    const laps = sim.setup.laps;
    setText(this.title, sim.finished || sim.chequered ? `Lap ${sim.leaderLap}${laps !== null ? ` / ${laps}` : ''} · chequered` : `Lap ${sim.leaderLap}${laps !== null ? ` / ${laps}` : ''}`);
    const rules = sim.model.rules;
    sim.order.forEach((car, i) => {
      const row = this.row(car);
      if (this.body.children[i] !== row.el) this.body.insertBefore(row.el, this.body.children[i] ?? null);
      const out = car.status === 'retired';
      row.el.classList.toggle('selected', this.race.selected === car.id);
      row.el.classList.toggle('out', out);
      setText(row.pos, out ? '' : String(car.position));
      const moved = car.gridPosition - car.position;
      setText(row.moved, out || moved === 0 ? '' : moved > 0 ? `▲${moved}` : `▼${-moved}`);
      row.moved.className = `tw-moved ${moved > 0 ? 'up' : 'down'}`;
      setText(row.gap, out ? 'OUT' : gapText(this.interval ? sim.interval(car) : sim.gap(car), true));
      setText(row.last, car.lastLap !== null ? formatLapTime(car.lastLap) : '');
      row.last.className = `tw-time wide ${lapMark(sim, car)}`;
      setText(row.best, car.bestLap !== null ? formatLapTime(car.bestLap) : '');
      row.best.className = `tw-time wide ${sim.fastest?.car === car.id ? 'best' : ''}`;
      for (let s = 0; s < 3; s++) {
        const v = car.sectors[s];
        setText(row.sectors[s], v !== null ? v.toFixed(1) : '');
        row.sectors[s].className = `tw-sector wide ${v !== null ? car.sectorMarks[s] : ''}`;
      }
      const c = rules.tyres.compounds[car.compound];
      setText(row.tyre, `${c.code} ${car.tyreLaps}`);
      row.tyre.style.setProperty('--tyre', c.color);
      setText(row.pit, car.status === 'pit' ? 'PIT' : car.status === 'finished' ? '🏁' : car.stops ? String(car.stops) : '');
      row.pit.classList.toggle('in-pit', car.status === 'pit');
    });
  }

  private row(car: RaceCar): Row {
    const existing = this.rows.get(car.id);
    if (existing) return existing;
    const e = car.entrant;
    const span = (cls: string) => h('span', { class: cls });
    const row: Row = {
      el: h('div', { class: 'tower-row', onclick: () => this.race.select(car.id), title: `${e.name}, ${e.team}` }),
      pos: span('tw-pos'),
      moved: span('tw-moved'),
      code: h('span', { class: 'tw-code' }, h('span', { class: 'tw-team', style: `background:${e.color}` }), e.code),
      gap: span('tw-gap'),
      last: span('tw-time wide'),
      best: span('tw-time wide'),
      sectors: [span('tw-sector wide'), span('tw-sector wide'), span('tw-sector wide')],
      tyre: span('tw-tyre'),
      pit: span('tw-pit'),
    };
    row.el.append(row.pos, row.moved, row.code, row.gap, row.last, row.best, ...row.sectors, row.tyre, row.pit);
    this.rows.set(car.id, row);
    return row;
  }
}

function lapMark(sim: RaceSim, car: RaceCar): SectorMark | '' {
  if (car.lastLap === null) return '';
  if (sim.fastest && sim.fastest.car === car.id && sim.fastest.time === car.lastLap) return 'best';
  return car.lastLap === car.bestLap ? 'personal' : '';
}
