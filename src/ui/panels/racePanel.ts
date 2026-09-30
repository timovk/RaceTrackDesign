/** Race mode: set up a race, control playback, follow a car, read the race feed and the results. */
import { formatLapTime } from '../../core/calibration.ts';
import { raceRules } from '../../core/race/rules.ts';
import { MAX_CARS, MAX_LAPS, MAX_MINUTES } from '../../core/race/setup.ts';
import type { Gap, RaceSim } from '../../core/race/sim.ts';
import { randomSeedString } from '../../core/rng.ts';
import { type Control, section, segmented, slider } from '../controls.ts';
import { h, isEditing, setChildren, setText } from '../dom.ts';
import * as fmt from '../format.ts';
import { type RaceController, SPEEDS } from '../raceController.ts';
import type { Store, Topic } from '../store.ts';

/** Live parts refresh at most this often while a race plays. */
const LIVE_INTERVAL_MS = 200;

export class RacePanel {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly race: RaceController;
  private readonly controls: Control[] = [];
  private readonly vehicleSelect: HTMLSelectElement;
  private readonly lengthInput: HTMLInputElement;
  private readonly lengthUnit: HTMLElement;
  private readonly lengthHint: HTMLElement;
  private readonly seed: HTMLInputElement;
  private readonly warnings: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly sessionEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly carEl: HTMLElement;
  private readonly feedEl: HTMLElement;
  private readonly resultsEl: HTMLElement;
  private lastLive = 0;
  private feedCount = -1;

  constructor(store: Store, race: RaceController) {
    this.store = store;
    this.race = race;
    const settings = () => store.raceSettings;

    this.vehicleSelect = h('select', {
      'aria-label': 'Class',
      onchange: () => {
        store.setRaceClass(this.vehicleSelect.value);
        this.vehicleSelect.blur();
      },
    }, ...store.vehicles.map((v) => h('option', { value: v.id }, v.name)));

    const cars = slider({
      label: 'Cars', min: 2, max: MAX_CARS, step: 1,
      get: () => settings().cars,
      format: (v) => String(v),
      onInput: (v) => store.setRaceSettings({ cars: v }),
    });
    const kind = segmented(
      [{ value: 'laps', label: 'Laps' }, { value: 'time', label: 'Time' }],
      () => settings().kind,
      (v) => store.setRaceSettings({ kind: v }),
    );
    this.lengthInput = h('input', {
      type: 'number', class: 'num-input', min: '1', step: '1', 'aria-label': 'Race length',
      onchange: () => {
        const v = Math.round(Number(this.lengthInput.value));
        if (!Number.isFinite(v) || v < 1) return;
        if (settings().kind === 'laps') store.setRaceSettings({ laps: Math.min(MAX_LAPS, v) });
        else store.setRaceSettings({ minutes: Math.min(MAX_MINUTES, v) });
      },
    });
    this.lengthUnit = h('span', { class: 'muted' });
    this.lengthHint = h('p', { class: 'hint' });
    const grid = segmented(
      [
        { value: 'qualifying', label: 'Qualifying', title: 'Grid in qualifying order' },
        { value: 'reversed', label: 'Reversed', title: 'Fastest qualifier starts last' },
        { value: 'random', label: 'Random' },
      ],
      () => settings().grid,
      (v) => store.setRaceSettings({ grid: v }),
    );
    this.controls.push(cars, kind, grid);
    this.seed = h('input', {
      type: 'text', class: 'seed-input', spellcheck: false, 'aria-label': 'Race seed',
      onchange: () => {
        const v = this.seed.value.trim();
        if (v) store.setRaceSettings({ seed: v });
      },
    });
    const dice = h('button', { class: 'btn', title: 'New random race seed', onclick: () => store.setRaceSettings({ seed: randomSeedString() }) }, 'Random');
    const defaults = h('button', {
      class: 'btn subtle', title: 'Grid size and race length as this class usually races',
      onclick: () => {
        const cur = settings();
        const d = store.defaultRace(cur.vehicleId, cur.seed);
        store.setRaceSettings({ cars: d.cars, kind: d.kind, laps: d.laps, minutes: d.minutes });
      },
    }, 'Class default');
    this.warnings = h('div', { class: 'race-warnings' });
    this.startButton = h('button', { class: 'btn primary block', onclick: () => race.start() }, 'Start race');

    this.statusEl = h('div', { class: 'race-status' });
    this.sessionEl = h('div');
    this.carEl = h('div');
    this.feedEl = h('ol', { class: 'race-feed' });
    this.resultsEl = h('div');

    this.el = h('div', { class: 'panel' },
      section('Race',
        h('label', { class: 'field' }, h('span', null, 'Class'), this.vehicleSelect),
        cars.el,
        h('div', { class: 'field' }, h('span', null, 'Length'),
          h('div', { class: 'row' }, kind.el, this.lengthInput, this.lengthUnit)),
        this.lengthHint,
        h('div', { class: 'field' }, h('span', null, 'Grid'), grid.el),
        h('div', { class: 'field' }, h('span', null, 'Seed'), h('div', { class: 'row' }, this.seed, dice)),
        h('p', { class: 'hint' }, 'The same track, settings and seed always give the same race.'),
        defaults,
        this.warnings,
        this.startButton),
      this.sessionEl,
      this.carEl,
      this.resultsEl,
      h('section', { class: 'panel-section' }, h('h3', null, 'Race feed'), this.feedEl),
    );

    store.subscribe((topics) => this.update(topics));
    race.onTick(() => this.live(false));
    this.update(new Set<Topic>(['project', 'race', 'performance']));
  }

  private update(topics: Set<Topic>): void {
    if (topics.has('project') || topics.has('race') || topics.has('performance') || topics.has('track')) this.updateSetup();
    if (topics.has('race') || topics.has('mode')) {
      this.updateSession();
      this.live(true);
    }
  }

  private updateSetup(): void {
    const s = this.store;
    const set = s.raceSettings;
    const vehicle = s.vehicles.find((v) => v.id === set.vehicleId)!;
    this.vehicleSelect.value = set.vehicleId;
    for (const c of this.controls) c.update();
    if (!isEditing(this.lengthInput)) this.lengthInput.value = String(set.kind === 'laps' ? set.laps : set.minutes);
    setText(this.lengthUnit, set.kind === 'laps' ? 'laps' : 'minutes');
    if (!isEditing(this.seed)) this.seed.value = set.seed;

    const rules = raceRules(vehicle);
    const lap = s.performance?.laps.find((l) => l.vehicleId === vehicle.id);
    const length = s.track?.length ?? 0;
    let hint = '';
    if (length > 0) {
      if (set.kind === 'laps') {
        const limit = rules.race.timeLimit ? `, time limit ${Math.round(rules.race.timeLimit / 60)} min` : '';
        hint = `${fmt.km(set.laps * length, 0)}${lap ? `, about ${Math.round((set.laps * lap.time * 1.03) / 60)} min` : ''}${limit}.`;
      } else if (lap) {
        hint = `About ${Math.round((set.minutes * 60) / (lap.time * 1.03))} laps of ${fmt.km(length)}.`;
      }
    }
    setText(this.lengthHint, hint);

    const notes: string[] = [];
    const lic = s.licence?.classes.find((c) => c.id === vehicle.id);
    if (lic && !lic.allowed) notes.push(`${vehicle.name} needs ${lic.needs}; this circuit is estimated lower. The race runs anyway.`);
    if (s.facilities && !s.facilities.pitLane && rules.pit.stops) notes.push('No pit lane on this circuit, so nobody can stop: tyres and fuel have to last.');
    setChildren(this.warnings, ...notes.map((n) => h('p', { class: 'race-warning' }, n)));

    const blocker = this.race.blocker;
    this.startButton.disabled = blocker !== null || this.race.skipping !== null;
    this.startButton.title = blocker ?? '';
    setText(this.startButton, blocker ?? (this.race.sim ? 'Restart race' : 'Start race'));
  }

  private updateSession(): void {
    const r = this.race;
    const sim = r.sim;
    if (!sim) {
      setChildren(this.sessionEl, r.notice ? h('section', { class: 'panel-section' }, h('p', { class: 'race-warning' }, r.notice)) : null);
      setChildren(this.resultsEl);
      return;
    }
    const speeds = segmented(SPEEDS.map((v) => ({ value: String(v), label: `${v}×` })), () => String(r.speed), (v) => r.setSpeed(Number(v)));
    const done = sim.finished;
    const skipping = r.skipping !== null;
    setChildren(this.sessionEl, section('Playback',
      this.statusEl,
      h('div', { class: 'row' },
        h('button', { class: 'btn', disabled: done || skipping, onclick: () => r.togglePlay(), title: 'Play or pause (P)' }, r.playing ? 'Pause' : 'Play'),
        h('button', { class: 'btn', disabled: done || skipping, onclick: () => r.finishNow(), title: 'Simulate the rest of the race at once' }, 'Finish now'),
        h('button', { class: 'btn subtle', onclick: () => r.stop() }, 'End')),
      h('div', { class: 'field' }, h('span', null, 'Speed'), speeds.el),
      h('p', { class: 'hint' }, 'Click a car on the map or in the timing tower to follow it.'),
    ));
    this.updateResults(sim);
  }

  /** Status, selected car and feed: cheap enough to refresh a few times a second. */
  private live(force: boolean): void {
    const sim = this.race.sim;
    if (!sim || this.store.mode !== 'race') {
      if (force) {
        setChildren(this.carEl);
        setChildren(this.feedEl, h('li', { class: 'muted small' }, 'Overtakes, pit stops and incidents appear here during a race.'));
        this.feedCount = -1;
      }
      return;
    }
    const now = performance.now();
    if (!force && now - this.lastLive < LIVE_INTERVAL_MS) return;
    this.lastLive = now;
    this.updateStatus(sim);
    this.updateCar(sim);
    if (sim.events.length !== this.feedCount || force) this.updateFeed(sim);
  }

  private updateStatus(sim: RaceSim): void {
    const r = this.race;
    const laps = sim.setup.laps;
    const lapText = laps !== null ? `Lap ${sim.leaderLap} / ${laps}` : `Lap ${sim.leaderLap}`;
    const timeLeft = sim.setup.duration !== null ? Math.max(0, sim.setup.duration - sim.t) : null;
    const flag = sim.finished ? 'Finished' : sim.chequered ? 'Chequered flag' : r.skipping !== null ? `Simulating… ${Math.round(r.skipping * 100)}%` : r.playing ? 'Racing' : 'Paused';
    const progress = r.skipping ?? (laps !== null ? Math.min(1, (sim.leaderLap - 1) / laps) : sim.setup.duration ? Math.min(1, sim.t / sim.setup.duration) : 0);
    setChildren(this.statusEl,
      h('div', { class: 'race-status-row' },
        h('span', { class: 'race-status-main' }, lapText),
        h('span', { class: 'race-clock' }, clock(sim.t)),
        timeLeft !== null ? h('span', { class: 'muted' }, `${clock(timeLeft)} left`) : null),
      h('div', { class: 'progress-track' }, h('div', { class: 'progress-fill', style: `width:${Math.round((sim.finished ? 1 : progress) * 100)}%` })),
      h('div', { class: 'muted small' }, flag, sim.fastest ? ` · fastest lap ${sim.cars[sim.fastest.car].entrant.code} ${formatLapTime(sim.fastest.time)}` : ''),
    );
  }

  private updateCar(sim: RaceSim): void {
    const r = this.race;
    const car = r.selected !== null ? sim.cars[r.selected] : null;
    if (!car) {
      setChildren(this.carEl);
      return;
    }
    const e = car.entrant;
    const rules = sim.model.rules;
    const compound = rules.tyres.compounds[car.compound];
    const row = (label: string, value: string | Node) => [h('dt', null, label), h('dd', null, value)];
    const moved = car.gridPosition - car.position;
    const status = car.status === 'retired' ? `Out: ${car.retired?.reason ?? 'retired'}` : car.status === 'finished' ? 'Finished' : car.status === 'pit' ? 'In the pit lane' : car.pitRequest ? `Pitting this lap (${car.pitRequest})` : 'Racing';
    const plan = car.status === 'running' && !car.pitRequest
      ? rules.fuel.refuelRate > 0
        ? `when fuel runs low (${Math.round(car.fuel)} kg, about ${Math.floor(car.fuel / Math.max(0.01, sim.model.fuelPerLap))} laps)`
        : car.nextStopLap !== null ? `planned around lap ${car.nextStopLap}` : 'none planned'
      : null;
    setChildren(this.carEl, h('section', { class: 'panel-section' },
      h('div', { class: 'car-head' },
        h('span', { class: 'car-number', style: `background:${e.color}` }, String(e.number)),
        h('div', null, h('div', { class: 'strong' }, e.name), h('div', { class: 'muted small' }, e.team)),
        h('button', { class: `chip${r.follow ? ' on' : ''}`, title: 'Keep the map centred on this car', onclick: () => r.setFollow(!r.follow) }, 'Follow'),
        h('button', { class: 'icon-btn', title: 'Deselect', onclick: () => r.select(null) }, '×')),
      h('dl', { class: 'stats' },
        ...row('Position', `P${car.position}${moved ? ` (${moved > 0 ? '+' : ''}${moved} from grid P${car.gridPosition})` : ` (grid P${car.gridPosition})`}`),
        ...row('Gap to leader', gapText(sim.gap(car), true)),
        ...row('Interval', gapText(sim.interval(car), false)),
        ...row('Last lap', car.lastLap !== null ? formatLapTime(car.lastLap) : '—'),
        ...row('Best lap', car.bestLap !== null ? formatLapTime(car.bestLap) : '—'),
        ...row('Tyres', h('span', null, h('span', { class: 'tyre', style: `--tyre:${compound.color}` }, compound.code), ` ${compound.name}, ${car.tyreLaps} laps, ${Math.round(Math.min(car.wear, 9.99) * 100)}% worn`)),
        ...(rules.fuel.refuelRate > 0 || car.saving > 0 ? row('Fuel', `${Math.max(0, car.fuel).toFixed(1)} kg${car.saving > 0 ? `, saving ${Math.round(car.saving * 100)}%` : ''}`) : []),
        ...row('Stops', String(car.stops)),
        ...(plan ? row('Next stop', plan) : []),
        ...row('Speed', car.status === 'running' || car.status === 'pit' ? fmt.speed(car.v) : '—'),
        ...row('Status', status),
      )));
  }

  private updateFeed(sim: RaceSim): void {
    this.feedCount = sim.events.length;
    const recent = sim.events.slice(-60).reverse();
    setChildren(this.feedEl, ...recent.map((ev) =>
      h('li', { class: `feed-item ${ev.kind}`, onclick: () => ev.kind !== 'start' && this.race.select(ev.car) },
        h('span', { class: 'feed-lap' }, `L${ev.lap}`),
        h('span', { class: 'feed-text' }, ev.text))));
  }

  private updateResults(sim: RaceSim): void {
    if (!sim.finished) {
      setChildren(this.resultsEl, gridSection(sim, this.race));
      return;
    }
    const winner = sim.order[0];
    const rows = sim.order.map((car) => {
      const e = car.entrant;
      let time: string;
      if (car.status === 'retired') time = `DNF (${car.retired?.reason ?? ''})`;
      else if (car === winner) time = winner.finishTime !== null ? clock(winner.finishTime, true) : '';
      else time = gapText(sim.gap(car), true);
      const moved = car.gridPosition - car.position;
      return h('tr', { class: this.race.selected === car.id ? 'focused' : '', onclick: () => this.race.select(car.id) },
        h('td', { class: 'num' }, car.status === 'retired' ? '—' : String(car.position)),
        h('td', null, h('span', { class: 'dot', style: `background:${e.color}` }), e.code),
        h('td', { class: 'num' }, String(car.lapsDone)),
        h('td', { class: 'num' }, time),
        h('td', { class: 'num' }, car.bestLap !== null ? formatLapTime(car.bestLap) : '—'),
        h('td', { class: 'num' }, String(car.stops)),
        h('td', { class: `num ${moved > 0 ? 'up' : moved < 0 ? 'down' : 'muted'}` }, car.status === 'retired' ? '' : moved > 0 ? `+${moved}` : moved < 0 ? String(moved) : '='));
    });
    const fast = sim.fastest;
    const overtakes = sim.events.filter((e) => e.kind === 'overtake').length;
    setChildren(this.resultsEl, section('Result',
      h('table', { class: 'table results' },
        h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Pos'), h('th', null, 'Driver'), h('th', { class: 'num' }, 'Laps'),
          h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Best'), h('th', { class: 'num' }, 'Stops'), h('th', { class: 'num' }, 'Grid'))),
        h('tbody', null, ...rows)),
      h('p', { class: 'hint' },
        `${winner.entrant.name} (${winner.entrant.team}) wins.`,
        fast ? ` Fastest lap ${sim.cars[fast.car].entrant.code} ${formatLapTime(fast.time)} on lap ${fast.lap}.` : '',
        ` ${overtakes} overtakes, ${sim.events.filter((e) => e.kind === 'pit').length} pit stops.`),
    ), gridSection(sim, this.race));
  }
}

function gridSection(sim: RaceSim, race: RaceController): HTMLElement {
  const best = sim.setup.qualifying[0]?.time ?? 0;
  const rows = sim.setup.grid.map((index, slot) => {
    const e = sim.setup.entrants[index];
    const q = sim.setup.qualifying.find((x) => x.car === index)!;
    return h('tr', { onclick: () => race.select(index) },
      h('td', { class: 'num' }, String(slot + 1)),
      h('td', null, h('span', { class: 'dot', style: `background:${e.color}` }), `${e.code} `, h('span', { class: 'muted' }, e.team)),
      h('td', { class: 'num' }, formatLapTime(q.time)),
      h('td', { class: 'num muted' }, q.time === best ? '' : `+${(q.time - best).toFixed(3)}`));
  });
  const order = sim.setup.settings.grid === 'qualifying' ? 'qualifying order' : sim.setup.settings.grid === 'reversed' ? 'reversed qualifying order' : 'random order';
  return h('details', { class: 'panel-section' },
    h('summary', null, h('h3', null, 'Qualifying and grid')),
    h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Grid'), h('th', null, 'Driver'), h('th', { class: 'num' }, 'Qualifying'), h('th', { class: 'num' }, 'Gap'))),
      h('tbody', null, ...rows)),
    h('p', { class: 'hint' }, `Best of three flying laps each; the grid is in ${order}.`));
}

/** Race clock: "1:02:03" or "12:03". */
export function clock(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secText = tenths ? sec.toFixed(3).padStart(6, '0') : String(Math.floor(sec)).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${String(min).padStart(2, '0')}:${secText}` : `${min}:${secText}`;
}

export function gapText(g: Gap, toLeader: boolean): string {
  if (g.kind === 'leader') return toLeader ? 'Leader' : '—';
  if (g.kind === 'laps') return `+${g.value} lap${g.value === 1 ? '' : 's'}`;
  if (g.kind === 'time') return `+${g.value.toFixed(g.value < 100 ? 3 : 1)}`;
  return '—';
}
