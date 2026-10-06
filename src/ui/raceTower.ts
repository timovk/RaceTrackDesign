/**
 * The timing tower over the map in Race mode, in the look of Formula 1's
 * broadcast graphics of 2010 to 2014: slanted dark bars, the position in a
 * box of its own (red for the leader, white with a red number for the cars
 * that would go out in qualifying), the driver's three letters and a gap or
 * a lap time, with the tyres and the stops added at the end of each row. A
 * badge on top shows the lap ("Lap 16 / 56") or the session and its clock
 * ("Q2 4:31"). Times widens the tower with places gained, the last and best
 * lap and the latest sector times, coloured purple (best in the class),
 * green (personal best) or yellow. A banner shows the flags. In a
 * multi-class race each row carries its class, gaps are within the class,
 * and tabs show one class at a time. Rows are reused and refreshed a few
 * times a second.
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
  tyreAge: HTMLElement;
  pit: HTMLElement;
  end: HTMLElement;
}

export class TimingTower {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly race: RaceController;
  private readonly badge: HTMLElement;
  private readonly badgeLabel: HTMLElement;
  private readonly badgeValue: HTMLElement;
  private readonly badgeExtra: HTMLElement;
  private readonly weather: HTMLElement;
  private readonly flag: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  private readonly gapHead: HTMLButtonElement;
  private readonly sizeButton: HTMLButtonElement;
  private rows = new Map<number, Row>();
  private sim: RaceSim | null = null;
  /** In a race: intervals to the car ahead, not gaps to the leader. In a session: gaps to the fastest, not lap times. */
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
    this.badgeLabel = h('span', { class: 'tb-label' });
    this.badgeValue = h('span', { class: 'tb-value' });
    this.badgeExtra = h('span', { class: 'tb-extra', hidden: true });
    this.badge = h('div', { class: 'tower-badge' }, this.badgeLabel, this.badgeValue, this.badgeExtra);
    this.weather = h('span', { class: 'tower-weather' });
    this.flag = h('div', { class: 'tower-flag', hidden: true });
    this.tabs = h('div', { class: 'tower-tabs', hidden: true });
    this.gapHead = h('button', { class: 'tower-toggle', onclick: () => this.setPrefs({ interval: !this.interval }) });
    this.sizeButton = h('button', { class: 'tower-toggle tower-size', title: 'Show or hide places gained, lap and sector times', onclick: () => this.setPrefs({ compact: !this.compact }) });
    this.body = h('div', { class: 'tower-body' });
    this.el = h('div', { class: 'tower', hidden: true },
      h('div', { class: 'tower-head' }, this.badge, this.weather, this.sizeButton),
      this.flag,
      this.tabs,
      h('div', { class: 'tower-row tower-labels' },
        h('span', { class: 'tw-pos' }),
        h('div', { class: 'tw-bar' },
          h('span', { class: 'tw-class' }, 'Class'), h('span', { class: 'tw-code' }, 'Driver'), h('span', { class: 'tw-gap' }, this.gapHead),
          h('span', { class: 'tw-moved wide' }), h('span', { class: 'tw-time wide' }, 'Last'), h('span', { class: 'tw-time wide' }, 'Best'),
          h('span', { class: 'tw-sector wide' }, 'S1'), h('span', { class: 'tw-sector wide' }, 'S2'), h('span', { class: 'tw-sector wide' }, 'S3'),
          h('span', { class: 'tw-tyre' }, 'Tyre'), h('span', { class: 'tw-pit' }, 'Pit')),
        h('span', { class: 'tw-end' })),
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
    const session = this.sim instanceof SessionSim;
    this.el.classList.toggle('compact', this.compact);
    setText(this.gapHead, session ? (this.interval ? 'Gap' : 'Time') : this.interval ? 'Interval' : 'Gap');
    this.gapHead.title = session ? 'Switch between best lap times and gaps to the fastest' : 'Switch between gap to the leader and interval to the car ahead';
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

  /** The badge on top: the lap of a race (and the time left in a race by time), or the session and its clock. */
  private updateBadge(sim: RaceSim, session: SessionSim | null): void {
    const over = sim.finished || sim.chequered;
    this.badge.classList.toggle('session', !!session);
    this.badge.classList.toggle('over', over);
    if (session) {
      setText(this.badgeLabel, session.spec.name);
      setText(this.badgeValue, over ? '' : clock(session.timeLeft));
      this.badgeExtra.hidden = true;
      return;
    }
    const laps = sim.setup.laps;
    const limit = sim.limit;
    setText(this.badgeLabel, 'Lap');
    setText(this.badgeValue, `${sim.leaderLap}${laps !== null ? ` / ${laps}` : ''}`);
    // A race by time: what is left of it; and the chequered flag once it is out.
    const left = sim.setup.duration !== null && limit !== null && !over ? clock(Math.max(0, limit - sim.t)) : '';
    this.badgeExtra.hidden = !left && !over;
    this.badgeExtra.classList.toggle('chequer', over);
    setText(this.badgeExtra, over ? '' : left);
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
      // Lap and sector times only when the map has room for them beside the track.
      if (!this.sizeChosen) this.compact = (this.el.parentElement?.clientWidth ?? 0) < 1300;
      this.applyPrefs();
    }
    this.el.classList.toggle('multi', sim.multiClass);
    this.updateTabs(sim);
    const session = sim instanceof SessionSim ? sim : null;
    this.el.classList.toggle('session', !!session);
    this.updateBadge(sim, session);
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
      // (On the grid, before the first step has put the cars in order: the grid slot.)
      const started = car.position > 0;
      const pos = started ? (view === null ? car.position : car.classPosition) : view === null ? car.gridPosition : car.classGrid;
      row.el.classList.toggle('selected', this.race.selected === car.id);
      row.el.classList.toggle('out', out);
      row.el.classList.toggle('lead', !out && pos === 1);
      // Qualifying: the cars that would go out if it ended now.
      row.el.classList.toggle('drop', advance !== undefined && car.classPosition > advance);
      row.el.classList.toggle('cut', advance !== undefined && car.classPosition === advance + 1);
      setText(row.pos, out ? '' : String(pos));
      setText(row.cls, multi ? (view === null ? `${car.cls.label} ${out ? '' : car.classPosition}` : car.cls.label) : '');
      const moved = session || !started ? 0 : multi ? car.classGrid - car.classPosition : car.gridPosition - car.position;
      setText(row.moved, out || moved === 0 ? '' : moved > 0 ? `▲${moved}` : `▼${-moved}`);
      row.moved.className = `tw-moved wide ${moved > 0 ? 'up' : 'down'}`;
      const gap = multi ? (this.interval ? sim.classInterval(car) : sim.classGap(car)) : this.interval ? sim.interval(car) : sim.gap(car);
      const noTime = session && car.bestLap === null;
      // In a session the lap times themselves, as on a qualifying broadcast (or the gaps to the fastest).
      setText(row.gap, out ? 'Out' : noTime ? 'No time' : session && !this.interval ? formatLapTime(car.bestLap!) : gapText(gap, true));
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
      setText(row.tyre, c.code);
      setText(row.tyreAge, String(car.tyreLaps));
      row.tyre.style.setProperty('--tyre', c.color);
      let end = '';
      if (session) {
        // What the car is doing: in the garage, on an out lap or an in lap, or on a push lap (marked at the end of the row).
        const s = session.of(car);
        const mark = car.status === 'retired' ? 'OUT' : !s || s.phase === 'garage' ? 'GAR' : car.status === 'pit' ? 'PIT' : s.phase === 'out' ? 'OUT' : s.phase === 'in' ? 'IN' : s.phase === 'cool' ? 'COOL' : s.phase === 'long' ? 'RUN' : '';
        setText(row.pit, mark);
        row.pit.classList.toggle('in-pit', mark === 'GAR' || mark === 'PIT');
        row.pit.classList.remove('damaged');
        if (car.status === 'running' && s?.phase === 'push') end = 'hot';
        else if (sim.chequered && car.status !== 'running') end = 'flag';
      } else {
        // Damage that has the car making for the pits shows until it is repaired.
        const damaged = car.status === 'running' && car.damage !== null && car.damage.kind !== 'body';
        setText(row.pit, car.status === 'pit' ? 'PIT' : damaged ? 'DMG' : car.stops ? String(car.stops) : '');
        row.pit.classList.toggle('in-pit', car.status === 'pit');
        row.pit.classList.toggle('damaged', damaged);
        if (car.status === 'finished') end = 'flag';
      }
      row.end.className = `tw-end ${end}`;
    });
  }

  private row(car: RaceCar): Row {
    const existing = this.rows.get(car.id);
    if (existing) return existing;
    const e = car.entrant;
    const span = (cls: string) => h('span', { class: cls });
    const driver = h('span', { class: 'tw-driver' });
    const tyre = h('b');
    const tyreAge = span('tw-age');
    const row: Row = {
      el: h('div', { class: 'tower-row', onclick: () => this.race.select(car.id, true), title: `${e.name}, ${e.team}` }),
      pos: span('tw-pos'),
      cls: h('span', { class: 'tw-class', style: `--class:${car.cls.color}` }),
      moved: span('tw-moved wide'),
      code: h('span', { class: 'tw-code' }, h('span', { class: 'tw-team', style: `background:${e.color}` }), e.code, driver),
      driver,
      gap: span('tw-gap'),
      last: span('tw-time wide'),
      best: span('tw-time wide'),
      sectors: [span('tw-sector wide'), span('tw-sector wide'), span('tw-sector wide')],
      tyre,
      tyreAge,
      pit: span('tw-pit'),
      end: span('tw-end'),
    };
    row.el.append(
      row.pos,
      h('div', { class: 'tw-bar' }, row.cls, row.code, row.gap, row.moved, row.last, row.best, ...row.sectors, h('span', { class: 'tw-tyre' }, tyre, tyreAge), row.pit),
      row.end);
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
