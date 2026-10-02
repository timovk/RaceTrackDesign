/**
 * The timing tower over the map in Race mode: position, driver, gap to the
 * leader or interval to the car ahead, last and best lap, the latest sector
 * times coloured purple (best in the class), green (personal best) or
 * yellow, tyres and stops. A banner shows the flags, the header the weather.
 * In a multi-class race each row carries its class, gaps are within the
 * class, and tabs show one class at a time. Rows are reused and refreshed a
 * few times a second.
 */
import { formatLapTime } from '../core/calibration.ts';
import { SessionSim } from '../core/race/session.ts';
import type { RaceCar, RaceSim, SectorMark } from '../core/race/sim.ts';
import { h, setChildren, setText } from './dom.ts';
import { clock, flagText, gapText } from './panels/racePanel.ts';
import type { RaceController } from './raceController.ts';
import type { Store, Topic } from './store.ts';

const REFRESH_MS = 160;
const PREFS_KEY = 'racetrackdesign.tower';

interface Row {
  el: HTMLElement;
  pos: HTMLElement;
  cls: HTMLElement;
  moved: HTMLElement;
  code: HTMLElement;
  driver: HTMLElement;
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
  private readonly weather: HTMLElement;
  private readonly flag: HTMLElement;
  private readonly tabs: HTMLElement;
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
  private tabsKey = '';

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
    this.weather = h('span', { class: 'tower-weather' });
    this.flag = h('div', { class: 'tower-flag', hidden: true });
    this.tabs = h('div', { class: 'tower-tabs', hidden: true });
    this.gapHead = h('button', { class: 'tower-toggle', title: 'Switch between gap to the leader and interval to the car ahead', onclick: () => this.setPrefs({ interval: !this.interval }) });
    this.sizeButton = h('button', { class: 'tower-toggle', title: 'Show or hide lap and sector times', onclick: () => this.setPrefs({ compact: !this.compact }) });
    this.body = h('div', { class: 'tower-body' });
    this.el = h('div', { class: 'tower', hidden: true },
      h('div', { class: 'tower-head' }, this.title, this.weather, this.sizeButton),
      this.flag,
      this.tabs,
      h('div', { class: 'tower-row tower-labels' },
        h('span', { class: 'tw-pos' }, ''), h('span', { class: 'tw-class' }, 'Class'), h('span', { class: 'tw-moved' }, ''), h('span', { class: 'tw-code' }, 'Driver'),
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

  /** Class tabs of a multi-class race: all classes, or one. */
  private updateTabs(sim: RaceSim): void {
    const view = this.race.classView;
    const key = sim.multiClass ? `${sim.classes.map((c) => c.label).join(',')}:${view}` : '';
    if (key === this.tabsKey) return;
    this.tabsKey = key;
    this.tabs.hidden = !sim.multiClass;
    if (!sim.multiClass) return;
    const tab = (label: string, cls: number | null, color?: string) =>
      h('button', { class: `tower-tab${view === cls ? ' on' : ''}`, style: color ? `--class:${color}` : '', onclick: () => this.race.setClassView(cls) }, label);
    setChildren(this.tabs, tab('All', null), ...sim.classes.map((c) => tab(c.label, c.index, c.color)));
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
      this.tabsKey = '-';
      if (!this.sizeChosen) {
        // Lap and sector times only when the map has room for them beside the track.
        this.compact = (this.el.parentElement?.clientWidth ?? 0) < 1300;
        this.applyPrefs();
      }
    }
    this.el.classList.toggle('multi', sim.multiClass);
    this.updateTabs(sim);
    const session = sim instanceof SessionSim ? sim : null;
    this.el.classList.toggle('session', !!session);
    if (session) {
      setText(this.title, `${session.spec.name} · ${session.finished || session.chequered ? 'chequered' : clock(session.timeLeft)}`);
    } else {
      const laps = sim.setup.laps;
      const limit = sim.limit;
      const left = sim.setup.duration !== null && limit !== null && !sim.chequered ? ` · ${clock(Math.max(0, limit - sim.t))}` : '';
      setText(this.title, `Lap ${sim.leaderLap}${laps !== null ? ` / ${laps}` : ''}${sim.finished || sim.chequered ? ' · chequered' : left}`);
    }
    const w = sim.wetness;
    setText(this.weather, w >= 0.02 || sim.rain > 0.05 ? `${sim.rain > 0.05 ? 'Rain · ' : ''}wet ${Math.round(w * 100)}%` : '');
    const flag = sim.finished ? null : flagText(sim);
    this.flag.hidden = !flag;
    if (flag) {
      setText(this.flag, flag.text);
      this.flag.className = `tower-flag ${flag.kind}`;
    }

    const view = sim.multiClass ? this.race.classView : null;
    const cars = view === null ? sim.order : sim.classes[view].order;
    const multi = sim.multiClass;
    // Rows of cars no longer shown leave the body.
    const shown = new Set(cars.map((c) => c.id));
    for (const [id, row] of this.rows) if (!shown.has(id) && row.el.parentElement) row.el.remove();
    const advance = session?.spec.advance;
    cars.forEach((car, i) => {
      const row = this.row(car);
      if (this.body.children[i] !== row.el) this.body.insertBefore(row.el, this.body.children[i] ?? null);
      // In a session a car out of it keeps its time.
      const out = car.status === 'retired' && (!session || car.bestLap === null);
      const pos = view === null ? car.position : car.classPosition;
      row.el.classList.toggle('selected', this.race.selected === car.id);
      row.el.classList.toggle('out', out);
      // Qualifying: the cars that would go out if it ended now.
      row.el.classList.toggle('drop', advance !== undefined && car.classPosition > advance);
      row.el.classList.toggle('cut', advance !== undefined && car.classPosition === advance + 1);
      setText(row.pos, out ? '' : String(pos));
      setText(row.cls, multi ? (view === null ? `${car.cls.label} ${out ? '' : car.classPosition}` : car.cls.label) : '');
      const moved = session ? 0 : multi ? car.classGrid - car.classPosition : car.gridPosition - car.position;
      setText(row.moved, out || moved === 0 ? '' : moved > 0 ? `▲${moved}` : `▼${-moved}`);
      row.moved.className = `tw-moved ${moved > 0 ? 'up' : 'down'}`;
      const gap = multi ? (this.interval ? sim.classInterval(car) : sim.classGap(car)) : this.interval ? sim.interval(car) : sim.gap(car);
      const noTime = session && car.bestLap === null;
      setText(row.gap, out ? 'OUT' : noTime ? 'NO TIME' : gapText(gap, true));
      setText(row.driver, car.entrant.drivers.length > 1 ? car.driver.code : '');
      setText(row.last, car.lastLap !== null ? formatLapTime(car.lastLap) : '');
      row.last.className = `tw-time wide ${lapMark(car)}`;
      setText(row.best, car.bestLap !== null ? formatLapTime(car.bestLap) : '');
      row.best.className = `tw-time wide ${car.cls.fastest?.car === car.id ? 'best' : ''}`;
      for (let s = 0; s < 3; s++) {
        const v = car.sectors[s];
        setText(row.sectors[s], v !== null ? v.toFixed(1) : '');
        row.sectors[s].className = `tw-sector wide ${v !== null ? car.sectorMarks[s] : ''}`;
      }
      const c = car.rules.tyres.compounds[car.compound];
      setText(row.tyre, `${c.code} ${car.tyreLaps}`);
      row.tyre.style.setProperty('--tyre', c.color);
      if (session) {
        // What the car is doing: in the garage, on an out lap or an in lap, or on a push lap (nothing shown).
        const s = session.of(car);
        const mark = car.status === 'retired' ? 'OUT' : !s || s.phase === 'garage' ? 'GAR' : car.status === 'pit' ? 'PIT' : s.phase === 'out' ? 'OUT' : s.phase === 'in' ? 'IN' : s.phase === 'cool' ? 'COOL' : s.phase === 'long' ? 'RUN' : '';
        setText(row.pit, mark);
        row.pit.classList.toggle('in-pit', mark === 'GAR' || mark === 'PIT');
      } else {
        setText(row.pit, car.status === 'pit' ? 'PIT' : car.status === 'finished' ? '🏁' : car.stops ? String(car.stops) : '');
        row.pit.classList.toggle('in-pit', car.status === 'pit');
      }
    });
  }

  private row(car: RaceCar): Row {
    const existing = this.rows.get(car.id);
    if (existing) return existing;
    const e = car.entrant;
    const span = (cls: string) => h('span', { class: cls });
    const driver = h('span', { class: 'tw-driver' });
    const row: Row = {
      el: h('div', { class: 'tower-row', onclick: () => this.race.select(car.id, true), title: `${e.name}, ${e.team}` }),
      pos: span('tw-pos'),
      cls: h('span', { class: 'tw-class', style: `--class:${car.cls.color}` }),
      moved: span('tw-moved'),
      code: h('span', { class: 'tw-code' }, h('span', { class: 'tw-team', style: `background:${e.color}` }), e.code, driver),
      driver,
      gap: span('tw-gap'),
      last: span('tw-time wide'),
      best: span('tw-time wide'),
      sectors: [span('tw-sector wide'), span('tw-sector wide'), span('tw-sector wide')],
      tyre: span('tw-tyre'),
      pit: span('tw-pit'),
    };
    row.el.append(row.pos, row.cls, row.moved, row.code, row.gap, row.last, row.best, ...row.sectors, row.tyre, row.pit);
    this.rows.set(car.id, row);
    return row;
  }
}

function lapMark(car: RaceCar): SectorMark | '' {
  if (car.lastLap === null) return '';
  const fastest = car.cls.fastest;
  if (fastest && fastest.car === car.id && fastest.time === car.lastLap) return 'best';
  return car.lastLap === car.bestLap ? 'personal' : '';
}
