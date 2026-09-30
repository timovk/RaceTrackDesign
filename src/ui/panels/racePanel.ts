/** Race mode: set up a race (one or more classes, length, grid, weather), control playback, follow a car, read the race feed and the results. */
import { formatLapTime } from '../../core/calibration.ts';
import { eventsCsv, lapsCsv, resultsCsv, telemetryCsv } from '../../core/race/export.ts';
import { raceRules } from '../../core/race/rules.ts';
import { MAX_CARS, MAX_CLASSES, MAX_LAPS, MAX_MINUTES, totalCars } from '../../core/race/setup.ts';
import type { Gap, RaceCar, RaceClass, RaceSim } from '../../core/race/sim.ts';
import { conditionName } from '../../core/race/weather.ts';
import { randomSeedString } from '../../core/rng.ts';
import { type Control, section, segmented } from '../controls.ts';
import { h, isEditing, setChildren, setText } from '../dom.ts';
import { download, slug } from '../download.ts';
import * as fmt from '../format.ts';
import { type RaceController, SPEEDS } from '../raceController.ts';
import type { Store, Topic } from '../store.ts';

/** Live parts refresh at most this often while a race plays. */
const LIVE_INTERVAL_MS = 200;

const WEATHER_HINTS = {
  dry: '',
  changeable: 'Showers come and go; teams change tyres as the track gets wet and dries.',
  wet: 'Raining from the start; it may stop and let the track dry.',
};

export class RacePanel {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly race: RaceController;
  private readonly controls: Control[] = [];
  private readonly classList: HTMLElement;
  private readonly addClassButton: HTMLButtonElement;
  private readonly totalEl: HTMLElement;
  private readonly lengthInput: HTMLInputElement;
  private readonly lengthUnit: HTMLElement;
  private readonly lengthHint: HTMLElement;
  private readonly weatherHint: HTMLElement;
  private readonly seed: HTMLInputElement;
  private readonly warnings: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly sessionEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly carEl: HTMLElement;
  private readonly feedEl: HTMLElement;
  private readonly resultsEl: HTMLElement;
  private classKey = '';
  private lastLive = 0;
  private feedCount = -1;

  private readonly exportMap: () => void;

  constructor(store: Store, race: RaceController, exportMap: () => void) {
    this.store = store;
    this.race = race;
    this.exportMap = exportMap;
    const settings = () => store.raceSettings;

    this.classList = h('div', { class: 'class-list' });
    this.addClassButton = h('button', { class: 'btn small', title: 'Race another class on the same track', onclick: () => store.addRaceClass() }, 'Add class');
    this.totalEl = h('span', { class: 'muted small' });
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
    const weather = segmented(
      [
        { value: 'dry', label: 'Dry' },
        { value: 'changeable', label: 'Changeable', title: 'Showers during the race' },
        { value: 'wet', label: 'Wet', title: 'Rain from the start' },
      ],
      () => settings().weather,
      (v) => store.setRaceSettings({ weather: v }),
    );
    this.weatherHint = h('p', { class: 'hint' });
    this.controls.push(kind, grid, weather);
    this.seed = h('input', {
      type: 'text', class: 'seed-input', spellcheck: false, 'aria-label': 'Race seed',
      onchange: () => {
        const v = this.seed.value.trim();
        if (v) store.setRaceSettings({ seed: v });
      },
    });
    const dice = h('button', { class: 'btn', title: 'New random race seed', onclick: () => store.setRaceSettings({ seed: randomSeedString() }) }, 'Random');
    const defaults = h('button', {
      class: 'btn subtle small', title: 'The first class\'s usual race length, and each class\'s usual grid',
      onclick: () => {
        const cur = settings();
        const d = store.defaultRace(cur.classes[0].vehicleId, cur.seed);
        let room = MAX_CARS;
        const classes = cur.classes.map((c, i) => {
          const cars = Math.max(1, Math.min(room - (cur.classes.length - 1 - i), i === 0 ? d.classes[0].cars : store.defaultRace(c.vehicleId, cur.seed).classes[0].cars));
          room -= cars;
          return { ...c, cars };
        });
        store.setRaceSettings({ classes, kind: d.kind, laps: d.laps, minutes: d.minutes });
      },
    }, 'Class default');
    const endurance = h('button', {
      class: 'btn subtle small', title: 'Hypercars, LMP2 and GT3 together for six hours, as in the World Endurance Championship',
      onclick: () => store.setEnduranceEvent(),
    }, 'WEC-style event');
    this.warnings = h('div', { class: 'race-warnings' });
    this.startButton = h('button', { class: 'btn primary block', onclick: () => race.start() }, 'Start race');

    this.statusEl = h('div', { class: 'race-status' });
    this.sessionEl = h('div');
    this.carEl = h('div');
    this.feedEl = h('ol', { class: 'race-feed' });
    this.resultsEl = h('div');

    this.el = h('div', { class: 'panel' },
      section('Race',
        h('div', { class: 'field' }, h('span', null, 'Classes'), this.classList, h('div', { class: 'row' }, this.addClassButton, this.totalEl)),
        h('div', { class: 'field' }, h('span', null, 'Length'),
          h('div', { class: 'row' }, kind.el, this.lengthInput, this.lengthUnit)),
        this.lengthHint,
        h('div', { class: 'field' }, h('span', null, 'Grid'), grid.el),
        h('div', { class: 'field' }, h('span', null, 'Weather'), weather.el),
        this.weatherHint,
        h('div', { class: 'field' }, h('span', null, 'Seed'), h('div', { class: 'row' }, this.seed, dice)),
        h('p', { class: 'hint' }, 'The same track, settings and seed always give the same race, weather included.'),
        h('div', { class: 'row' }, defaults, endurance),
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
    this.updateClasses();
    for (const c of this.controls) c.update();
    if (!isEditing(this.lengthInput)) this.lengthInput.value = String(set.kind === 'laps' ? set.laps : set.minutes);
    setText(this.lengthUnit, set.kind === 'laps' ? 'laps' : 'minutes');
    if (!isEditing(this.seed)) this.seed.value = set.seed;
    setText(this.weatherHint, WEATHER_HINTS[set.weather]);

    const vehicles = set.classes.map((c) => s.vehicles.find((v) => v.id === c.vehicleId)!);
    const lead = vehicles[0];
    const rules = raceRules(lead);
    const lap = s.performance?.laps.find((l) => l.vehicleId === lead.id);
    const length = s.track?.length ?? 0;
    let hint = '';
    if (length > 0) {
      const of = vehicles.length > 1 ? ` for ${lead.name}` : '';
      if (set.kind === 'laps') {
        const limit = rules.race.timeLimit ? `, time limit ${Math.round(rules.race.timeLimit / 60)} min` : '';
        hint = `${fmt.km(set.laps * length, 0)}${lap ? `, about ${Math.round((set.laps * lap.time * 1.03) / 60)} min` : ''}${limit}.`;
      } else if (lap) {
        hint = `About ${Math.round((set.minutes * 60) / (lap.time * 1.03))} laps of ${fmt.km(length)}${of}.`;
      }
      if (vehicles.length > 1) hint += ` The flag falls for the overall leader; the fastest class's rules (${lead.name}) set the start and the flags.`;
    }
    setText(this.lengthHint, hint);

    const notes: string[] = [];
    for (const vehicle of vehicles) {
      const lic = s.licence?.classes.find((c) => c.id === vehicle.id);
      if (lic && !lic.allowed) notes.push(`${vehicle.name} needs ${lic.needs}; this circuit is estimated lower. The race runs anyway.`);
    }
    if (s.facilities && !s.facilities.pitLane && vehicles.some((v) => raceRules(v).pit.stops)) notes.push('No pit lane on this circuit, so nobody can stop: tyres and fuel have to last.');
    if (new Set(vehicles.map((v) => v.kind)).size > 1) notes.push('Cars and bikes never race together in reality; the race runs anyway.');
    setChildren(this.warnings, ...notes.map((n) => h('p', { class: 'race-warning' }, n)));

    const blocker = this.race.blocker;
    this.startButton.disabled = blocker !== null || this.race.skipping !== null;
    this.startButton.title = blocker ?? '';
    setText(this.startButton, blocker ?? (this.race.sim ? 'Restart race' : 'Start race'));
  }

  /** The class list: rebuilt when classes are added, removed or changed, values updated in place otherwise. */
  private updateClasses(): void {
    const s = this.store;
    const set = s.raceSettings;
    const key = set.classes.map((c) => c.vehicleId).join(',');
    if (key !== this.classKey && !this.classList.contains(document.activeElement)) {
      this.classKey = key;
      const taken = set.classes.map((x) => x.vehicleId);
      setChildren(this.classList, ...taken.map((_, i) => this.classRow(i, taken.length, taken)));
    }
    set.classes.forEach((c, i) => {
      const row = this.classList.children[i];
      if (!row) return;
      const select = row.querySelector('select');
      if (select && !isEditing(select)) select.value = c.vehicleId;
      const input = row.querySelector('input');
      if (input && !isEditing(input)) input.value = String(c.cars);
      const badge = row.querySelector<HTMLElement>('.class-badge');
      const rules = raceRules(s.vehicles.find((v) => v.id === c.vehicleId)!);
      if (badge) {
        setText(badge, rules.label);
        badge.style.setProperty('--class', rules.color);
      }
    });
    const total = totalCars(set);
    setText(this.totalEl, `${total} of ${MAX_CARS} cars`);
    this.addClassButton.disabled = set.classes.length >= MAX_CLASSES || total >= MAX_CARS;
  }

  private classRow(i: number, count: number, taken: string[]): HTMLElement {
    const store = this.store;
    const select = h('select', {
      'aria-label': `Class ${i + 1}`,
      onchange: () => {
        store.setRaceClass(i, select.value);
        select.blur();
      },
    }, ...store.vehicles.map((v) => h('option', { value: v.id, disabled: count > 1 && taken.includes(v.id) && taken[i] !== v.id }, v.name)));
    const cars = h('input', {
      type: 'number', class: 'num-input', min: '1', max: String(MAX_CARS), step: '1', 'aria-label': 'Cars in this class',
      onchange: () => {
        const v = Number(cars.value);
        if (Number.isFinite(v) && v >= 1) store.setRaceCars(i, v);
      },
    });
    return h('div', { class: 'class-row' },
      h('span', { class: 'class-badge' }),
      select,
      cars,
      h('span', { class: 'muted small' }, 'cars'),
      count > 1 ? h('button', { class: 'icon-btn', title: 'Remove this class', onclick: () => store.removeRaceClass(i) }, '×') : null);
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
      h('p', { class: 'hint' }, 'Click a car on the map or in the timing tower to follow it and see its telemetry below the map.'),
    ), this.exportSection(sim));
    this.updateResults(sim);
  }

  private exportSection(sim: RaceSim): HTMLElement {
    const name = slug(this.store.project.name);
    const tag = `${name}-${sim.classes.map((c) => c.model.vehicle.id).join('-')}-${sim.setup.settings.seed}`;
    const telemetry = () => {
      const pair = this.race.telemetryPair();
      if (!pair?.a) {
        alert('No telemetry yet: the car has not completed a lap.');
        return;
      }
      download(`${tag}-telemetry-${pair.labelA.replace(/[\s#]+/g, '')}.csv`, telemetryCsv(pair.a, pair.b, pair.delta, pair.labelA, pair.labelB));
    };
    return section('Export',
      h('div', { class: 'row' },
        h('button', { class: 'btn small', title: 'Classification as CSV', onclick: () => download(`${tag}-results.csv`, resultsCsv(sim)) }, 'Results'),
        h('button', { class: 'btn small', title: 'Every lap of every car as CSV', onclick: () => download(`${tag}-laps.csv`, lapsCsv(sim)) }, 'Laps'),
        h('button', { class: 'btn small', title: 'The race feed (passes, stops, incidents, flags and weather) as CSV', onclick: () => download(`${tag}-feed.csv`, eventsCsv(sim)) }, 'Feed'),
        h('button', { class: 'btn small', title: 'The telemetry shown below the map as CSV', onclick: telemetry }, 'Telemetry'),
        h('button', { class: 'btn small', title: 'The map as it is on screen, as a PNG image', onclick: () => this.exportMap() }, 'Map image')),
      h('p', { class: 'hint' }, 'CSV files open in any spreadsheet. Results, laps and the feed cover the race so far.'));
  }

  /** Status, selected car and feed: cheap enough to refresh a few times a second. */
  private live(force: boolean): void {
    const sim = this.race.sim;
    if (!sim || this.store.mode !== 'race') {
      if (force) {
        setChildren(this.carEl);
        setChildren(this.feedEl, h('li', { class: 'muted small' }, 'Overtakes, pit stops, incidents, flags and the weather appear here during a race.'));
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
    const state = sim.finished ? 'Finished' : sim.chequered ? 'Chequered flag' : r.skipping !== null ? `Simulating… ${Math.round(r.skipping * 100)}%` : r.playing ? 'Racing' : 'Paused';
    const progress = r.skipping ?? (laps !== null ? Math.min(1, (sim.leaderLap - 1) / laps) : sim.setup.duration ? Math.min(1, sim.t / sim.setup.duration) : 0);
    const fastest = sim.multiClass ? null : sim.fastest;
    const flag = sim.finished ? null : flagText(sim);
    setChildren(this.statusEl,
      h('div', { class: 'race-status-row' },
        h('span', { class: 'race-status-main' }, lapText),
        h('span', { class: 'race-clock' }, clock(sim.t)),
        timeLeft !== null ? h('span', { class: 'muted' }, `${clock(timeLeft)} left`) : null),
      h('div', { class: 'progress-track' }, h('div', { class: 'progress-fill', style: `width:${Math.round((sim.finished ? 1 : progress) * 100)}%` })),
      h('div', { class: 'race-conditions' },
        flag ? h('span', { class: `flag-badge ${flag.kind}` }, flag.text) : null,
        h('span', { class: 'muted small' }, weatherText(sim))),
      h('div', { class: 'muted small' }, state, fastest ? ` · fastest lap ${sim.cars[fastest.car].entrant.code} ${formatLapTime(fastest.time)}` : ''),
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
    const rules = car.rules;
    const compound = rules.tyres.compounds[car.compound];
    const crew = e.drivers.length > 1;
    const row = (label: string, value: string | Node) => [h('dt', null, label), h('dd', null, value)];
    const moved = car.classGrid - car.classPosition;
    const status = car.status === 'retired' ? `Out: ${car.retired?.reason ?? 'retired'}` : car.status === 'finished' ? 'Finished' : car.status === 'pit' ? 'In the pit lane' : car.pitRequest ? `Pitting this lap (${car.pitRequest})` : 'Racing';
    const plan = car.status === 'running' && !car.pitRequest
      ? car.tyreType !== 'slick' ? 'when the track dries, or the tyres are worn'
        : rules.fuel.refuelRate > 0
          ? `when fuel runs low (${Math.round(car.fuel)} kg, about ${Math.floor(car.fuel / Math.max(0.01, car.model.fuelPerLap))} laps)`
          : !rules.pit.stops ? 'none (only for the weather)' : car.nextStopLap !== null ? `planned around lap ${car.nextStopLap}` : 'none planned'
      : null;
    const position = sim.multiClass
      ? h('span', null, classBadge(car.cls), ` P${car.classPosition} in class, P${car.position} overall`)
      : `P${car.position}`;
    const grid = sim.multiClass ? car.classGrid : car.gridPosition;
    const times = crew ? sim.driveTimes(car) : [];
    setChildren(this.carEl, h('section', { class: 'panel-section' },
      h('div', { class: 'car-head' },
        h('span', { class: 'car-number', style: `background:${e.color}` }, String(e.number)),
        h('div', null,
          h('div', { class: 'strong' }, crew ? e.team : e.name),
          h('div', { class: 'muted small' }, crew ? `${car.driver.name} driving` : e.team)),
        h('button', { class: `chip${r.follow ? ' on' : ''}`, title: 'Keep the map centred on this car', onclick: () => r.setFollow(!r.follow) }, 'Follow'),
        h('button', { class: 'icon-btn', title: 'Deselect', onclick: () => r.select(null) }, '×')),
      h('dl', { class: 'stats' },
        ...row('Position', h('span', null, position, moved ? ` (${moved > 0 ? '+' : ''}${moved} from grid P${grid})` : ` (grid P${grid})`)),
        ...row(sim.multiClass ? 'Gap to class leader' : 'Gap to leader', gapText(sim.multiClass ? sim.classGap(car) : sim.gap(car), true)),
        ...row('Interval', gapText(sim.multiClass ? sim.classInterval(car) : sim.interval(car), false)),
        ...row('Last lap', car.lastLap !== null ? formatLapTime(car.lastLap) : '—'),
        ...row('Best lap', car.bestLap !== null ? formatLapTime(car.bestLap) : '—'),
        ...row('Tyres', h('span', null, h('span', { class: 'tyre', style: `--tyre:${compound.color}` }, compound.code), ` ${compound.name}, ${car.tyreLaps} laps, ${Math.round(Math.min(car.wear, 9.99) * 100)}% worn`)),
        ...(rules.fuel.refuelRate > 0 || car.saving > 0 ? row('Fuel', `${Math.max(0, car.fuel).toFixed(1)} kg${car.saving > 0 ? `, saving ${Math.round(car.saving * 100)}%` : ''}`) : []),
        ...(crew ? row('Drivers', h('span', { class: 'crew' }, ...e.drivers.map((d, i) =>
          h('span', { class: i === car.driverIndex && car.status !== 'retired' && car.status !== 'finished' ? 'strong' : '' }, `${d.name} ${clock(times[i])}`)))) : []),
        ...row('Stops', String(car.stops)),
        ...(plan ? row('Next stop', plan) : []),
        ...row('Speed', car.status === 'running' || car.status === 'pit' ? fmt.speed(car.v) : '—'),
        ...row('Status', status),
      )));
  }

  private updateFeed(sim: RaceSim): void {
    this.feedCount = sim.events.length;
    const recent = sim.events.slice(-80).reverse();
    setChildren(this.feedEl, ...recent.map((ev) =>
      h('li', { class: `feed-item ${ev.kind}${ev.car < 0 ? ' plain' : ''}`, onclick: () => ev.kind !== 'start' && ev.car >= 0 && this.race.select(ev.car) },
        h('span', { class: 'feed-lap' }, `L${ev.lap}`),
        h('span', { class: 'feed-text' }, ev.text))));
  }

  private updateResults(sim: RaceSim): void {
    if (!sim.finished) {
      setChildren(this.resultsEl, gridSection(sim, this.race));
      return;
    }
    const fast = sim.fastest;
    const overtakes = sim.events.filter((e) => e.kind === 'overtake').length;
    const stops = sim.events.filter((e) => e.kind === 'pit').length;
    const neutral = sim.neutral.length ? ` ${countText(sim.neutral.filter((p) => p.kind === 'sc').length, 'safety car')}${sim.neutral.some((p) => p.kind !== 'sc') ? `, ${countText(sim.neutral.filter((p) => p.kind !== 'sc').length, sim.model.rules.flags.virtual === 'fcy' ? 'full course yellow' : 'VSC')}` : ''}.` : '';
    if (!sim.multiClass) {
      const winner = sim.order[0];
      setChildren(this.resultsEl, section('Result',
        resultTable(sim, sim.order, this.race),
        h('p', { class: 'hint' },
          `${winner.entrant.name} (${winner.entrant.team}) wins.`,
          fast ? ` Fastest lap ${sim.cars[fast.car].entrant.code} ${formatLapTime(fast.time)} on lap ${fast.lap}.` : '',
          ` ${overtakes} overtakes, ${stops} pit stops.${neutral}`),
      ), gridSection(sim, this.race));
      return;
    }
    const overall = sim.order[0];
    setChildren(this.resultsEl, section('Result',
      h('p', { class: 'hint' }, `${overall.entrant.code} ${overall.entrant.team} (${overall.cls.label}) wins overall. ${overtakes} overtakes in class, ${stops} pit stops.${neutral}`),
      ...sim.classes.map((cls) => h('div', { class: 'class-result' },
        h('h4', null, classBadge(cls), ` ${cls.name}`,
          cls.fastest ? h('span', { class: 'muted small' }, ` · fastest lap ${sim.cars[cls.fastest.car].entrant.code} ${formatLapTime(cls.fastest.time)}`) : null),
        resultTable(sim, cls.order, this.race))),
    ), gridSection(sim, this.race));
  }
}

/** Classification of these cars (a whole race, or one class of it). */
function resultTable(sim: RaceSim, cars: RaceCar[], race: RaceController): HTMLElement {
  const multi = sim.multiClass;
  const winner = cars[0];
  const rows = cars.map((car) => {
    const e = car.entrant;
    let time: string;
    if (car.status === 'retired') time = `DNF (${car.retired?.reason ?? ''})`;
    else if (car === winner) time = winner.finishTime !== null ? clock(winner.finishTime, true) : '';
    else time = gapText(multi ? sim.classGap(car) : sim.gap(car), true);
    const pos = multi ? car.classPosition : car.position;
    const moved = (multi ? car.classGrid : car.gridPosition) - pos;
    const who = e.drivers.length > 1 ? h('span', { class: 'muted' }, ` ${e.drivers.map((d) => d.code).join('/')}`) : null;
    return h('tr', { class: race.selected === car.id ? 'focused' : '', onclick: () => race.select(car.id) },
      h('td', { class: 'num' }, car.status === 'retired' ? '—' : String(pos)),
      h('td', null, h('span', { class: 'dot', style: `background:${e.color}` }), e.code, who),
      h('td', { class: 'num' }, String(car.lapsDone)),
      h('td', { class: 'num' }, time),
      h('td', { class: 'num' }, car.bestLap !== null ? formatLapTime(car.bestLap) : '—'),
      h('td', { class: 'num' }, String(car.stops)),
      h('td', { class: `num ${moved > 0 ? 'up' : moved < 0 ? 'down' : 'muted'}` }, car.status === 'retired' ? '' : moved > 0 ? `+${moved}` : moved < 0 ? String(moved) : '='));
  });
  return h('table', { class: 'table results' },
    h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Pos'), h('th', null, 'Driver'), h('th', { class: 'num' }, 'Laps'),
      h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Best'), h('th', { class: 'num' }, 'Stops'), h('th', { class: 'num' }, 'Grid'))),
    h('tbody', null, ...rows));
}

function gridSection(sim: RaceSim, race: RaceController): HTMLElement {
  const tables = sim.classes.map((cls, ci) => {
    const q = sim.setup.qualifying[ci];
    const best = q[0]?.time ?? 0;
    const slots = sim.setup.grid.map((index, slot) => ({ index, slot })).filter((g) => sim.cars[g.index].cls === cls);
    const rows = slots.map(({ index, slot }) => {
      const e = sim.setup.entrants[index];
      const time = q.find((x) => x.car === index)!.time;
      return h('tr', { onclick: () => race.select(index) },
        h('td', { class: 'num' }, String(slot + 1)),
        h('td', null, h('span', { class: 'dot', style: `background:${e.color}` }), `${e.code} `, h('span', { class: 'muted' }, e.team)),
        h('td', { class: 'num' }, formatLapTime(time)),
        h('td', { class: 'num muted' }, time === best ? '' : `+${(time - best).toFixed(3)}`));
    });
    return h('div', null,
      sim.multiClass ? h('h4', null, classBadge(cls), ` ${cls.name}`) : null,
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Grid'), h('th', null, 'Driver'), h('th', { class: 'num' }, 'Qualifying'), h('th', { class: 'num' }, 'Gap'))),
        h('tbody', null, ...rows)));
  });
  const order = sim.setup.settings.grid === 'qualifying' ? 'qualifying order' : sim.setup.settings.grid === 'reversed' ? 'reversed qualifying order' : 'random order';
  return h('details', { class: 'panel-section' },
    h('summary', null, h('h3', null, 'Qualifying and grid')),
    ...tables,
    h('p', { class: 'hint' }, `Best of three flying laps each${sim.cars.some((c) => c.entrant.drivers.length > 1) ? ' by the car\'s fastest driver' : ''}; the grid is in ${order}${sim.multiClass ? ', the fastest class in front' : ''}.`));
}

/** A class label in its colour. */
export function classBadge(cls: RaceClass): HTMLElement {
  return h('span', { class: 'class-badge', style: `--class:${cls.color}` }, cls.label);
}

/** What race control shows now, or null when the track is green. */
export function flagText(sim: RaceSim): { kind: string; text: string } | null {
  if (sim.phase === 'sc') return { kind: 'sc', text: sim.safetyCar?.in ? 'Safety car in this lap' : sim.safetyCar ? 'Safety car' : 'Safety car: restart' };
  if (sim.phase === 'vsc') return { kind: 'vsc', text: 'Virtual safety car' };
  if (sim.phase === 'fcy') return { kind: 'fcy', text: 'Full course yellow' };
  if (sim.yellows.some((z) => z.double)) return { kind: 'yellow', text: 'Double yellow' };
  if (sim.yellows.length) return { kind: 'yellow', text: 'Yellow flag' };
  return null;
}

/** "Wet track (54%), raining" */
export function weatherText(sim: RaceSim): string {
  const w = sim.wetness;
  const track = w < 0.02 ? 'Dry track' : `${conditionName(w)} track (${Math.round(w * 100)}%)`;
  return `${track}${sim.rain > 0.05 ? `, ${sim.rain > 0.6 ? 'heavy rain' : 'raining'}` : ''}`;
}

function countText(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
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
