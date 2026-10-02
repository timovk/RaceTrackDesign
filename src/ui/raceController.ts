/**
 * Runs a race in the app: builds the simulation from the analysed track,
 * plays it back at a chosen speed (fixed simulation steps, drawn in between
 * with interpolation), skips to the finish in chunks without freezing the
 * page, and drops the race when the track changes underneath it.
 *
 * Structural changes (start, finish, selection) go out as the store's 'race'
 * topic; per-frame progress goes to `onTick` listeners only.
 */
import { raceRules } from '../core/race/rules.ts';
import { buildRaceModel } from '../core/race/model.ts';
import { MAX_CARS, createRaceSetup } from '../core/race/setup.ts';
import { DT, type RaceCar, RaceSim } from '../core/race/sim.ts';
import { type LapChoice, type Telemetry, deltaTime, lapTelemetry, resolveLap } from '../core/race/telemetry.ts';
import type { Store, Topic } from './store.ts';

export const SPEEDS = [1, 5, 20, 100, 500, 1000];
/** Work per frame, so playback and skipping never freeze the page. */
const FRAME_BUDGET_MS = 12;

export interface TelemetrySelection {
  /** Car shown; null follows the selected car, or the leader. */
  car: number | null;
  lap: LapChoice;
  /** Nothing, the fastest lap of the race, or a chosen car and lap. */
  compare: 'none' | 'fastest' | 'car';
  compareCar: number | null;
  compareLap: LapChoice;
}

export interface TelemetryPair {
  carA: RaceCar;
  a: Telemetry | null;
  carB: RaceCar | null;
  b: Telemetry | null;
  delta: Float64Array | null;
  labelA: string;
  labelB: string;
}

const NO_TELEMETRY: TelemetrySelection = { car: null, lap: 'last', compare: 'none', compareCar: null, compareLap: 'best' };

export class RaceController {
  sim: RaceSim | null = null;
  playing = false;
  /** A new race waits on the grid instead of starting at once (the broadcast shows the grid, then starts it). */
  holdStart = false;
  speed = 20;
  /** Interpolation between the last two simulation steps, 0..1. */
  alpha = 1;
  selected: number | null = null;
  follow = false;
  /** Share of the race simulated while skipping to the finish, or null. */
  skipping: number | null = null;
  /** Why the last race was stopped, if it was stopped from outside. */
  notice: string | null = null;
  telemetry: TelemetrySelection = { ...NO_TELEMETRY };
  /** Set when a car is picked on the map or in the tower: the dock opens its telemetry. */
  wantsTelemetry = false;
  /** Class shown in the tower and the dock of a multi-class race, or null for all. */
  classView: number | null = null;

  private readonly store: Store;
  private readonly tickListeners = new Set<() => void>();
  private acc = 0;
  private lastFrame = 0;
  private frame = 0;
  private builtFrom: { layout: number; track: unknown; performance: unknown; facilities: unknown } | null = null;

  constructor(store: Store) {
    this.store = store;
    store.subscribe((topics) => this.onStore(topics));
  }

  onTick(fn: () => void): void {
    this.tickListeners.add(fn);
  }

  /** Why a race cannot start right now, or null when it can. */
  get blocker(): string | null {
    const s = this.store;
    if (!s.track) return 'Draw a closed track first.';
    if (!s.performance || !s.facilities || !s.performanceCurrent) return 'Waiting for the lap-time analysis…';
    const perf = s.performance;
    if (!s.raceSettings.classes.every((c) => perf.laps.some((l) => l.vehicleId === c.vehicleId))) return 'No lap time for this class yet.';
    return null;
  }

  start(): void {
    const s = this.store;
    if (this.blocker) return;
    const settings = s.raceSettings;
    // Save the settings with the project, so the file reproduces this race.
    if (!s.raceSettingsSaved) s.setRaceSettings({});
    const models = settings.classes.map((c) => {
      const vehicle = s.vehicles.find((v) => v.id === c.vehicleId)!;
      return buildRaceModel({
        track: s.track!, performance: s.performance!, facilities: s.facilities!, vehicle, rules: raceRules(vehicle),
        gridSize: MAX_CARS, corners: s.metrics?.corners,
      });
    });
    this.sim = new RaceSim(createRaceSetup(models, settings));
    this.builtFrom = { layout: s.shownLayout, track: s.track, performance: s.performance, facilities: s.facilities };
    this.selected = null;
    this.notice = null;
    this.skipping = null;
    this.classView = null;
    this.telemetry = { ...NO_TELEMETRY };
    this.acc = 0;
    this.alpha = 1;
    if (this.holdStart) this.pause();
    else this.play();
    s.emit('race');
  }

  /** Drops the current race. */
  stop(notice: string | null = null): void {
    this.pause();
    this.sim = null;
    this.builtFrom = null;
    this.skipping = null;
    this.selected = null;
    this.notice = notice;
    this.store.emit('race');
  }

  play(): void {
    if (!this.sim || this.sim.finished || this.skipping !== null) return;
    this.playing = true;
    this.lastFrame = performance.now();
    this.schedule();
    this.store.emit('race');
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.store.emit('race');
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.store.emit('race');
  }

  /** Selects a car (or clears the selection when it is already selected); `open` asks the dock to show its telemetry. */
  select(id: number | null, open = false): void {
    if (id !== null && !this.sim?.cars[id]) return;
    this.selected = this.selected === id ? null : id;
    if (this.selected !== null) {
      this.telemetry.car = this.selected;
      this.wantsTelemetry = open;
    }
    this.store.emit('race');
    this.tick();
  }

  setClassView(cls: number | null): void {
    this.classView = cls;
    this.store.emit('race');
    this.tick();
  }

  setTelemetry(changes: Partial<TelemetrySelection>): void {
    Object.assign(this.telemetry, changes);
    this.store.emit('race');
  }

  /** The telemetry to show: the chosen car and lap, and the comparison with its delta. */
  telemetryPair(): TelemetryPair | null {
    const sim = this.sim;
    if (!sim) return null;
    const sel = this.telemetry;
    const carA = sim.cars[sel.car ?? this.selected ?? sim.order[0].id];
    const a = lapTelemetry(sim, carA, sel.lap);
    let carB: RaceCar | null = null;
    let lapB: LapChoice = sel.compareLap;
    if (sel.compare === 'fastest' && sim.fastest) {
      carB = sim.cars[sim.fastest.car];
      lapB = sim.fastest.lap;
    } else if (sel.compare === 'car' && sel.compareCar !== null) {
      carB = sim.cars[sel.compareCar];
    }
    const b = carB ? lapTelemetry(sim, carB, lapB) : null;
    const label = (car: RaceCar, lap: number | null) => `${car.entrant.code}${lap !== null ? ` L${lap}` : ''}`;
    return {
      carA, a, carB, b,
      delta: a && b ? deltaTime(a, b) : null,
      labelA: label(carA, a?.lap ?? resolveLap(carA, sel.lap)),
      labelB: carB ? label(carB, b?.lap ?? null) : '',
    };
  }

  setFollow(on: boolean): void {
    this.follow = on;
    this.store.emit('race');
    this.tick();
  }

  /** Runs the rest of the race as fast as possible, a slice per frame. */
  finishNow(): void {
    const sim = this.sim;
    if (!sim || sim.finished) return;
    this.pause();
    const expected = sim.setup.duration ?? sim.setup.timeLimit ?? (sim.setup.laps ?? 1) * sim.model.lapTime * 1.08;
    this.skipping = Math.min(0.99, sim.t / expected);
    this.store.emit('race');
    const slice = () => {
      if (this.sim !== sim) return;
      const end = performance.now() + FRAME_BUDGET_MS;
      while (!sim.finished && performance.now() < end) {
        for (let i = 0; i < 50 && !sim.finished; i++) sim.step();
      }
      this.alpha = 1;
      if (sim.finished) {
        this.skipping = null;
        this.store.emit('race');
      } else {
        this.skipping = Math.min(0.99, sim.t / expected);
        this.frame = requestAnimationFrame(slice);
      }
      this.tick();
    };
    this.frame = requestAnimationFrame(slice);
  }

  private schedule(): void {
    this.frame = requestAnimationFrame((now) => this.advance(now));
  }

  private advance(now: number): void {
    const sim = this.sim;
    if (!sim || !this.playing) return;
    // A long gap (a hidden tab) must not turn into a huge jump.
    const real = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.acc += real * this.speed;
    const end = performance.now() + FRAME_BUDGET_MS;
    while (this.acc >= DT && !sim.finished) {
      sim.step();
      this.acc -= DT;
      if (performance.now() > end) {
        // Too much work for one frame: drop the backlog rather than fall ever further behind.
        this.acc = Math.min(this.acc, DT);
        break;
      }
    }
    this.alpha = Math.min(1, this.acc / DT);
    this.tick();
    if (sim.finished) {
      this.playing = false;
      this.alpha = 1;
      this.store.emit('race');
      return;
    }
    this.schedule();
  }

  private tick(): void {
    for (const fn of this.tickListeners) fn();
  }

  /**
   * A race belongs to the layout and track it was built on: drop it when
   * that track or its analysis changes, or another layout is picked. Design
   * shows the full circuit, which leaves a race on a layout running.
   */
  private onStore(topics: Set<Topic>): void {
    if (!this.sim || !this.builtFrom) return;
    if (!topics.has('track') && !topics.has('performance') && !topics.has('layout')) return;
    const s = this.store;
    const b = this.builtFrom;
    if (s.layout !== b.layout && s.shownLayout !== b.layout) {
      this.stop('Another layout was picked, so the race was stopped. Start it again to race on it.');
      return;
    }
    const shown = s.shownLayout === b.layout;
    if (s.trackOf(b.layout) !== b.track || (shown && ((s.performance && s.performance !== b.performance) || (s.facilities && s.facilities !== b.facilities)))) {
      this.stop('The track changed, so the race was stopped. Start it again to race on the new layout.');
    }
  }
}
