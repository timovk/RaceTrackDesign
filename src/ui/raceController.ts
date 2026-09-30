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
import { DT, RaceSim } from '../core/race/sim.ts';
import type { Store, Topic } from './store.ts';

export const SPEEDS = [1, 5, 20, 100, 500];
/** Work per frame, so playback and skipping never freeze the page. */
const FRAME_BUDGET_MS = 12;

export class RaceController {
  sim: RaceSim | null = null;
  playing = false;
  speed = 20;
  /** Interpolation between the last two simulation steps, 0..1. */
  alpha = 1;
  selected: number | null = null;
  follow = false;
  /** Share of the race simulated while skipping to the finish, or null. */
  skipping: number | null = null;
  /** Why the last race was stopped, if it was stopped from outside. */
  notice: string | null = null;

  private readonly store: Store;
  private readonly tickListeners = new Set<() => void>();
  private acc = 0;
  private lastFrame = 0;
  private frame = 0;
  private builtFrom: { track: unknown; performance: unknown; facilities: unknown } | null = null;

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
    if (!s.performance.laps.some((l) => l.vehicleId === s.raceSettings.vehicleId)) return 'No lap time for this class yet.';
    return null;
  }

  start(): void {
    const s = this.store;
    if (this.blocker) return;
    const settings = s.raceSettings;
    // Save the settings with the project, so the file reproduces this race.
    if (!s.project.race) s.setRaceSettings({});
    const vehicle = s.vehicles.find((v) => v.id === settings.vehicleId)!;
    const model = buildRaceModel({
      track: s.track!, performance: s.performance!, facilities: s.facilities!, vehicle, rules: raceRules(vehicle),
      gridSize: MAX_CARS, corners: s.metrics?.corners,
    });
    this.sim = new RaceSim(createRaceSetup(model, settings));
    this.builtFrom = { track: s.track, performance: s.performance, facilities: s.facilities };
    this.selected = null;
    this.notice = null;
    this.skipping = null;
    this.acc = 0;
    this.alpha = 1;
    this.play();
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

  select(id: number | null): void {
    this.selected = this.selected === id ? null : id;
    this.store.emit('race');
    this.tick();
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

  /** A race belongs to the track it was built on: drop it when the track or its analysis changes. */
  private onStore(topics: Set<Topic>): void {
    if (!this.sim || !this.builtFrom) return;
    if (!topics.has('track') && !topics.has('performance')) return;
    const s = this.store;
    const b = this.builtFrom;
    if (s.track !== b.track || (s.performance && s.performance !== b.performance) || (s.facilities && s.facilities !== b.facilities)) {
      this.stop('The track changed, so the race was stopped. Start it again to race on the new layout.');
    }
  }
}
