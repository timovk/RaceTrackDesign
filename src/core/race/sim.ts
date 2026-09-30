/**
 * The race simulation. Each car is a position along the lap (in stations,
 * counted from the start line across laps) and runs the race lap from the
 * model, slowed or sped up per station by its current state:
 *
 *   segment time = race lap segment x car and driver pace x (1 + tyre wear
 *                  + compound + fuel mass + lap-to-lap scatter)
 *                  x slipstream, wake and DRS for the car ahead
 *
 * A car cannot drive through the one ahead: it is held a small gap behind
 * it until a braking zone, where it may try to pass. The chance depends on
 * the speed difference at the braking point, the pace difference, the zone
 * and both drivers' racecraft; lapped cars let leaders by. Cars stop in the
 * actual pit lane at the speed limit, and the race brings mistakes, trips
 * off the track, crashes and technical failures.
 *
 * Time advances in fixed steps of DT seconds, so a seed always gives the same
 * race whatever the playback speed. Within a step, cars walk station by
 * station and every timing line crossed is timed exactly.
 */
import { formatLapTime } from '../calibration.ts';
import { hashSeed, mulberry32, seededRandom } from '../rng.ts';
import type { Entrant } from './field.ts';
import { gauss } from './field.ts';
import { type RaceModel, launchSpeed } from './model.ts';
import type { RaceRules } from './rules.ts';
import type { RaceSetup } from './setup.ts';
import { COLD_TYRES, type StintPlan, pickCompound, planStrategy, popcount, tyreLoss, wearPerLap } from './strategy.ts';

export const DT = 0.1;

export type CarStatus = 'running' | 'pit' | 'finished' | 'retired';
/** Colour of a sector time: best of anyone, personal best, or neither. */
export type SectorMark = 'best' | 'personal' | 'normal';

export interface LapRecord {
  lap: number;
  time: number;
  sectors: [number, number, number];
  position: number;
  compound: number;
  tyreLaps: number;
  wear: number;
  fuel: number;
  pit: boolean;
  /** Race time at the line. */
  at: number;
  /** Seconds behind the first car to complete this lap. */
  gap: number;
  /** Speed through the speed trap on this lap, m/s (NaN if not measured). */
  trap: number;
}

export interface PitStopRecord {
  car: number;
  lap: number;
  /** Race time at the pit entry and exit (NaN until the car is out). */
  entry: number;
  exit: number;
  /** Time standing in the box, including waiting for a team-mate (NaN until done). */
  stationary: number;
  from: number;
  /** Compound fitted, or null when the tyres stayed on. */
  to: number | null;
  fuel: number;
  reason: string;
}

export type RaceEventKind = 'start' | 'overtake' | 'pit' | 'fastest' | 'off' | 'contact' | 'retired' | 'chequered' | 'finish';

export interface RaceEvent {
  t: number;
  /** The lap the car was on. */
  lap: number;
  kind: RaceEventKind;
  text: string;
  car: number;
  other?: number;
}

interface PitState {
  p: number;
  prevP: number;
  box: number;
  uEntry: number;
  stopped: boolean;
  stoppedUntil: number;
  stopStart: number;
  done: boolean;
  service: { compound: number | null; fuel: number; time: number; reason: string };
  record: PitStopRecord;
}

export class RaceCar {
  readonly entrant: Entrant;
  readonly id: number;
  gridPosition = 0;
  status: CarStatus = 'running';
  /** Race progress in stations from the start line; negative on the grid. */
  u = 0;
  prevU = 0;
  /** m/s. */
  v = 0;
  /** Cosmetic sideways offset from the racing line, metres (positive left). */
  lateral = 0;
  lapsDone = 0;
  lapStart = 0;
  lastLap: number | null = null;
  bestLap: number | null = null;
  sectors: (number | null)[] = [null, null, null];
  sectorMarks: SectorMark[] = ['normal', 'normal', 'normal'];
  bestSectors = [Infinity, Infinity, Infinity];
  sectorStart = 0;
  compound = 0;
  wear = 0;
  tyreLaps = 0;
  used = 0;
  fuel = 0;
  stops = 0;
  lastStopLap = -99;
  plan: StintPlan[] = [];
  nextStopLap: number | null = null;
  pit: PitState | null = null;
  pitRequest: string | null = null;
  position = 0;
  finishTime: number | null = null;
  retired: { reason: string; lap: number; x: number; y: number } | null = null;
  history: LapRecord[] = [];
  /**
   * Telemetry: for each completed lap, the time since the start of the lap
   * at every sample station (NaN where not reached), and the same for the
   * lap in progress.
   */
  traces: Float32Array[] = [];
  trace: Float32Array;

  // Internal state.
  startDelay = 0;
  launch: { u: number; from: number; factor: number } | null = null;
  lapPace = 1;
  noise = 0;
  cold = 0;
  burn = 1;
  saving = 0;
  delay = 0;
  delayShare = 0.5;
  offTrack = false;
  exitUntilU = -Infinity;
  drsUntilU = -Infinity;
  drsCross: Float64Array;
  tow = 0;
  wake = 0;
  passing: { target: RaceCar; untilU: number } | null = null;
  cooldownU = -Infinity;
  stuckLaps = 0;
  stuckBehind = -1;
  /** Lap on which a rival close behind stopped, threatening the undercut. */
  threatLap = -99;
  /** Speed and time at the last braking zone crossed. */
  zone: { index: number; v: number; t: number } | null = null;
  accruedU = 0;
  pittedThisLap = false;
  incident: { u: number; kind: 'mistake' | 'off' | 'crash' | 'failure' } | null = null;
  trackIndex = 0;
  loopTimes: Float64Array;
  trapT0 = NaN;
  trapV = NaN;
  readonly rng: () => number;

  constructor(entrant: Entrant, loops: number, drsRegions: number, samples: number, seed: string) {
    this.entrant = entrant;
    this.id = entrant.index;
    this.loopTimes = new Float64Array(2 * loops).fill(NaN);
    this.trace = new Float32Array(samples).fill(NaN);
    this.drsCross = new Float64Array(drsRegions).fill(-Infinity);
    this.rng = mulberry32(hashSeed(`${seed}:car:${entrant.index}`));
  }
}

export interface Gap {
  /** 'leader' for the car in front, 'time' in seconds, 'laps' down, or 'none' (no timing yet, or retired). */
  kind: 'leader' | 'time' | 'laps' | 'none';
  value: number;
}

// Per-station marks, so crossing a station with nothing on it costs one lookup.
const LINE = 1;
const SECTOR = 2;
const LOOP = 4;
const DECIDE = 8;
const PIT_IN = 16;
const ZONE = 32;
const DRS = 64;
const TELE = 128;
const TRAP_START = 256;
const TRAP = 512;
/** The speed trap measures over the last this many metres before its line. */
const TRAP_BASE = 20;

const CONTINUE = 0;
const STOP = 1;
const PIT = 2;

/** Pit lane movement sub-step, seconds. */
const PIT_STEP = 0.05;
const PIT_BRAKE = 9;
const BOX_BRAKE = 8;
/** Distance before the pit entry at which the stop is decided. */
const DECISION_DISTANCE = 500;
/** Metres after the pit exit (blend line) and before the entry (entry road) where a car is off the racing line. */
const EXIT_BLEND = 300;
const ENTRY_ROAD = 250;
/** Lap-time fraction per unit of fuel saved (lift and coast). */
const FUEL_SAVE_COST = 0.08;
const FAILURES_CAR = ['engine', 'gearbox', 'hydraulics', 'electrics', 'brakes', 'suspension', 'power unit', 'cooling'];
const FAILURES_BIKE = ['engine', 'electronics', 'gearbox', 'brakes', 'chain'];

export class RaceSim {
  readonly setup: RaceSetup;
  readonly model: RaceModel;
  readonly cars: RaceCar[];
  /** Race order, leader first; retired cars at the end. */
  order: RaceCar[];
  t = 0;
  finished = false;
  chequered = false;
  events: RaceEvent[] = [];
  fastest: { car: number; time: number; lap: number } | null = null;
  bestSectors = [Infinity, Infinity, Infinity];
  /** Every pit stop, in the order they started. */
  stops: PitStopRecord[] = [];
  /** Race time at which the first car completed each lap (index = lap - 1). */
  lapLeaders: number[] = [];

  private readonly rules: RaceRules;
  private readonly n: number;
  private readonly ds: number;
  private readonly lineDs: Float64Array;
  private readonly mark: Uint16Array;
  /** Racing-line distance over which the speed trap measures. */
  private readonly trapBase: number;
  private readonly zoneAt: Int16Array;
  private readonly drsAt: Int16Array;
  private readonly rng: () => number;
  private readonly qualiFuel: number;
  private readonly limit: number | null;
  private trackOrder: RaceCar[] = [];
  private finishCount = 0;
  /** Race progress of the first braking zone on lap 1; until then nobody is held up. */
  private readonly firstZoneU: number;
  private readonly pitSide: number;

  constructor(setup: RaceSetup) {
    this.setup = setup;
    const m = setup.model;
    this.model = m;
    this.rules = m.rules;
    this.n = m.n;
    this.ds = m.track.ds;
    this.lineDs = m.line.ds;
    this.rng = seededRandom(`${setup.settings.seed}:race`);
    this.limit = setup.duration ?? setup.timeLimit;
    this.qualiFuel = Math.min(this.rules.fuel.capacity, 3 * m.fuelPerLap);

    const n = this.n;
    this.mark = new Uint16Array(n);
    this.mark[0] |= LINE;
    this.mark[m.sectors[0]] |= SECTOR;
    this.mark[m.sectors[1]] |= SECTOR;
    for (let k = 0; k < n; k += m.loopEvery) this.mark[k] |= LOOP;
    for (let k = 0; k < n; k += m.teleEvery) this.mark[k] |= TELE;
    const trapStart = mod(m.speedTrap - Math.max(1, Math.round(TRAP_BASE / this.ds)), n);
    this.mark[trapStart] |= TRAP_START;
    this.mark[m.speedTrap] |= TRAP;
    this.trapBase = mod(m.line.s[m.speedTrap] - m.line.s[trapStart], m.line.length);
    this.zoneAt = new Int16Array(n).fill(-1);
    m.zones.forEach((z, i) => {
      this.zoneAt[z.station] = i;
      this.mark[z.station] |= ZONE;
    });
    this.drsAt = new Int16Array(n).fill(-1);
    m.drs.forEach((d, i) => {
      this.drsAt[d.start] = i;
      this.mark[d.start] |= DRS;
    });
    if (m.pit && this.rules.pit.stops) {
      this.mark[m.pit.entry] |= PIT_IN;
      this.mark[mod(m.pit.entry - Math.round(DECISION_DISTANCE / this.ds), n)] |= DECIDE;
    }

    this.firstZoneU = m.zones.length ? m.zones[0].station : Math.round(n / 4);
    this.pitSide = pitSide(m);
    this.cars = setup.entrants.map((e) => new RaceCar(e, m.loops, m.drs.length, m.samples, setup.settings.seed));
    const lapsEstimate = this.lapsLeftAtStart();
    setup.grid.forEach((index, slot) => {
      const car = this.cars[index];
      const g = m.grid[slot];
      car.gridPosition = slot + 1;
      car.u = g.u;
      car.prevU = g.u;
      car.accruedU = 0;
      car.lateral = g.lateral;
      car.startDelay = 0.15 + 0.3 * (1 - car.entrant.launch) * car.rng() + 0.05 * car.rng();
      car.launch = { u: g.u, from: 0, factor: 0.94 + 0.06 * car.entrant.launch };
      this.prepareStart(car, lapsEstimate);
    });
    this.order = [...this.cars].sort((a, b) => a.gridPosition - b.gridPosition);
    this.order.forEach((c, i) => { c.position = i + 1; });
    for (const car of this.cars) this.startLap(car, 0);
    this.log('start', 0, 'Lights out', this.order[0].id);
  }

  /** Laps the leader has started, for "Lap 12/58". */
  get leaderLap(): number {
    const leader = this.order[0];
    const lap = leader ? Math.max(1, leader.lapsDone + (leader.status === 'finished' ? 0 : 1)) : 1;
    return this.setup.laps !== null ? Math.min(this.setup.laps, lap) : lap;
  }

  /** Advances one fixed step. */
  step(): void {
    if (this.finished) return;
    const t0 = this.t;
    const n = this.n;
    const track = this.cars.filter((c) => c.status === 'running');
    track.sort((a, b) => mod(b.u, n) - mod(a.u, n));
    track.forEach((c, i) => { c.trackIndex = i; });
    this.trackOrder = track;

    // Slipstream and wake from the car directly ahead.
    const N = track.length;
    for (let i = 0; i < N; i++) {
      const car = track[i];
      car.tow = 0;
      car.wake = 0;
      for (let s = 1; s < Math.min(N, 4); s++) {
        const a = track[(i - s + N) % N];
        if (a.offTrack) continue;
        const gapT = (mod(a.u - car.u, n) * this.ds) / Math.max(car.v, 20);
        car.tow = clamp01((1 - gapT) / 0.7);
        car.wake = clamp01((1.6 - gapT) / 1.2);
        break;
      }
    }

    // Move cars front to back, starting behind the biggest gap so nobody waits on a car not yet moved.
    let first = 0;
    let biggest = -1;
    for (let i = 0; i < N; i++) {
      const gap = N === 1 ? n : mod(track[(i - 1 + N) % N].u - track[i].u, n);
      if (gap > biggest) {
        biggest = gap;
        first = i;
      }
    }
    for (let s = 0; s < N; s++) {
      const car = track[(first + s) % N];
      if (car.status === 'running') this.moveTrackCar(car, t0);
    }
    for (const car of this.cars) {
      if (car.status === 'pit' && car.pit && !track.includes(car)) {
        car.prevU = car.u;
        car.pit.prevP = car.pit.p;
        this.movePit(car, DT, t0);
      }
    }

    this.t = t0 + DT;
    this.resolvePasses();
    this.updateLateral();
    this.updateOrder();
    if (this.cars.every((c) => c.status === 'finished' || c.status === 'retired')) this.finished = true;
    // Safety net: a race cannot run on for ever.
    const expected = (this.limit ?? (this.setup.laps ?? 1) * this.model.lapTime * 1.2) * 3 + 600;
    if (this.t > expected) this.finished = true;
  }

  /** Steps until `seconds` of race time have passed or the race is over. */
  advance(seconds: number): void {
    const end = this.t + seconds - 1e-9;
    while (!this.finished && this.t < end) this.step();
  }

  // ---- timing ------------------------------------------------------------------

  gap(car: RaceCar): Gap {
    const leader = this.order[0];
    return car === leader ? { kind: 'leader', value: 0 } : this.gapBetween(car, leader);
  }

  /** Gap to the car one place ahead in the race. */
  interval(car: RaceCar): Gap {
    const i = this.order.indexOf(car);
    if (i <= 0) return { kind: 'leader', value: 0 };
    return this.gapBetween(car, this.order[i - 1]);
  }

  private gapBetween(car: RaceCar, ref: RaceCar): Gap {
    if (car.status === 'retired') return { kind: 'none', value: 0 };
    const diff = ref.u - car.u;
    if (diff >= this.n - 1e-9) return { kind: 'laps', value: Math.floor((diff + 1e-9) / this.n) };
    if (car.u <= 0) return { kind: 'none', value: 0 };
    const lap = Math.floor(car.u / this.n);
    const loop = Math.floor(mod(car.u, this.n) / this.model.loopEvery);
    const slot = (lap & 1) * this.model.loops + loop;
    const a = car.loopTimes[slot];
    const b = ref.loopTimes[slot];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { kind: 'none', value: 0 };
    return { kind: 'time', value: Math.max(0, a - b) };
  }

  // ---- rendering ---------------------------------------------------------------

  /** Map position between the last two steps (alpha 0..1), or null when the car is off the map. */
  pose(car: RaceCar, alpha: number): { x: number; y: number; heading: number } | null {
    if (car.status === 'finished') return null;
    if (car.status === 'retired') return car.retired ? { x: car.retired.x, y: car.retired.y, heading: 0 } : null;
    if (car.status === 'pit' && car.pit && this.model.pit) {
      const p = car.pit.prevP + (car.pit.p - car.pit.prevP) * alpha;
      return pathPoint(this.model.pit.x, this.model.pit.y, this.model.pit.cum, p);
    }
    const u = car.prevU + (car.u - car.prevU) * alpha;
    return this.linePoint(u, car.lateral);
  }

  private linePoint(u: number, lateral: number): { x: number; y: number; heading: number } {
    const line = this.model.line;
    const n = this.n;
    const pos = mod(u, n);
    const k = Math.floor(pos) % n;
    const k1 = (k + 1) % n;
    const f = pos - Math.floor(pos);
    const h = line.heading[k];
    const x = line.x[k] + (line.x[k1] - line.x[k]) * f + Math.sin(h) * lateral;
    const y = line.y[k] + (line.y[k1] - line.y[k]) * f - Math.cos(h) * lateral;
    return { x, y, heading: h };
  }

  // ---- movement ----------------------------------------------------------------

  private moveTrackCar(car: RaceCar, t0: number): void {
    car.prevU = car.u;
    let t = t0;
    let budget = DT;
    if (car.startDelay > t0) {
      const wait = Math.min(DT, car.startDelay - t0);
      budget -= wait;
      t += wait;
      if (budget <= 1e-12) {
        car.v = 0;
        return;
      }
    }
    if (car.delay > 0) {
      const loss = Math.min(car.delay, budget * car.delayShare);
      car.delay -= loss;
      budget -= loss;
      t += loss;
      if (car.delay <= 1e-9) {
        car.delay = 0;
        car.offTrack = false;
      }
    }
    const startU = car.u;
    this.walk(car, budget, t, this.limitFor(car));
    if (car.status === 'running') car.v = ((car.u - startU) * this.model.line.length) / this.n / DT;
  }

  /** Moves a car on track for `budget` seconds, stopping short of `limit` (a race-progress value). */
  private walk(car: RaceCar, budget: number, t: number, limit: number): void {
    const n = this.n;
    let u = car.u;
    while (budget > 1e-12) {
      const fl = Math.floor(u);
      const k = mod(fl, n);
      const segT = this.segmentTime(car, k, u);
      const next = fl + 1;
      if (next > limit) {
        const room = limit - u;
        if (room > 0) u += Math.min(room, budget / segT);
        break;
      }
      const need = (next - u) * segT;
      if (need > budget) {
        u += budget / segT;
        break;
      }
      budget -= need;
      t += need;
      u = next;
      car.u = u;
      const r = this.cross(car, next, t);
      if (r === STOP) return;
      if (r === PIT) {
        this.movePit(car, budget, t);
        return;
      }
    }
    car.u = u;
  }

  private segmentTime(car: RaceCar, k: number, u: number): number {
    const m = this.model;
    let r = 1 + car.tow * (m.towRatio[k] - 1) + car.wake * (m.wakeRatio[k] - 1);
    if (m.drsRatio && car.drsUntilU > u) r += m.drsRatio[k] - 1;
    let s = m.seg[k] * car.lapPace * r;
    if (car.passing) s *= 0.9;
    // Speed caps: pulling away (start, pit exit) and braking for the pit entry.
    let cap = Infinity;
    if (car.launch) {
      const d = ((u - car.launch.u) * m.line.length) / this.n;
      cap = launchSpeed(m.launch, car.launch.from, d) * car.launch.factor;
      if (!Number.isFinite(cap)) car.launch = null;
    }
    if (car.pitRequest && m.pit) {
      const toEntry = mod(m.pit.entry - u, this.n) * this.ds;
      if (toEntry < 800) cap = Math.min(cap, Math.sqrt(m.pit.limit * m.pit.limit + 2 * PIT_BRAKE * (toEntry + m.pit.limitFrom)));
    }
    if (cap < Infinity) s = Math.max(s, this.lineDs[k] / Math.max(cap, 1));
    return s;
  }

  /** How far a car may go before running into the car ahead. */
  private limitFor(car: RaceCar): number {
    const order = this.trackOrder;
    const N = order.length;
    for (let s = 1; s < Math.min(N, 6); s++) {
      const a = order[(car.trackIndex - s + N) % N];
      if (a.status !== 'running' || !this.blocks(a, car)) continue;
      const d = mod(a.u - car.u, this.n);
      if (d * this.ds > 250) return Infinity;
      return car.u + d - (6 + 0.12 * car.v) / this.ds;
    }
    return Infinity;
  }

  /**
   * Whether `ahead` holds up `car`: not when it is off the track, on the pit
   * entry or exit road, or being passed, and not on the run from the grid to
   * the first braking zone, where the field spreads across the track.
   */
  private blocks(ahead: RaceCar, car: RaceCar): boolean {
    if (ahead.offTrack || car.passing?.target === ahead) return false;
    if (car.u < this.firstZoneU && ahead.u < this.firstZoneU) return false;
    if (ahead.exitUntilU > ahead.u) return false;
    const pit = this.model.pit;
    if (ahead.pitRequest && pit && mod(pit.entry - ahead.u, this.n) * this.ds < ENTRY_ROAD) return false;
    return true;
  }

  private movePit(car: RaceCar, budget: number, t: number): void {
    const pit = this.model.pit!;
    const ps = car.pit!;
    while (budget > 1e-12 && car.status === 'pit') {
      if (ps.stopped) {
        const wait = Math.min(budget, ps.stoppedUntil - t);
        if (wait > 0) {
          budget -= wait;
          t += wait;
        }
        if (t >= ps.stoppedUntil - 1e-9) {
          ps.stopped = false;
          ps.done = true;
          this.finishService(car, t);
        }
        continue;
      }
      const h = Math.min(budget, PIT_STEP);
      const v = Math.max(0.5, this.laneSpeed(car, ps.p));
      const p = ps.p + v * h;
      if (!ps.done && p >= ps.box) {
        const tt = Math.max(0, (ps.box - ps.p) / v);
        budget -= tt;
        t += tt;
        ps.p = ps.box;
        this.updatePitU(car, t);
        ps.stopped = true;
        ps.stopStart = t;
        // Wait for a team-mate still in the box.
        let start = t;
        for (const o of this.cars) {
          if (o !== car && o.pit?.stopped && o.entrant.teamIndex === car.entrant.teamIndex) start = Math.max(start, o.pit.stoppedUntil);
        }
        ps.stoppedUntil = start + ps.service.time;
        continue;
      }
      if (p >= pit.length) {
        const tt = Math.max(0, (pit.length - ps.p) / v);
        budget -= tt;
        t += tt;
        ps.p = pit.length;
        this.updatePitU(car, t);
        if (car.status !== 'pit') return;
        this.exitPit(car, v, t);
        this.walk(car, budget, t, Infinity);
        return;
      }
      ps.p = p;
      budget -= h;
      t += h;
      this.updatePitU(car, t);
    }
    if (car.status === 'pit' && car.pit) car.v = car.pit.stopped ? 0 : this.laneSpeed(car, car.pit.p);
  }

  /** Speed at a point along the pit lane: braking to the limit, the limit, pulling away from the box and to the exit. */
  private laneSpeed(car: RaceCar, p: number): number {
    const pit = this.model.pit!;
    const ps = car.pit!;
    const lim = pit.limit;
    let v: number;
    if (p < pit.limitFrom) v = Math.sqrt(lim * lim + 2 * PIT_BRAKE * (pit.limitFrom - p));
    else if (p <= pit.limitTo) v = lim;
    else v = launchSpeed(this.model.launch, lim, p - pit.limitTo);
    if (!ps.done) v = Math.min(v, Math.sqrt(2 * BOX_BRAKE * Math.max(0, ps.box - p)) + 0.6);
    else if (p < pit.limitTo) v = Math.min(v, launchSpeed(this.model.launch, 0, Math.max(0, p - ps.box)) + 0.6);
    return Math.min(v, this.model.vehicle.topSpeed);
  }

  /** Race progress of a car in the pit lane: the lane mapped onto the stretch of lap it bypasses. */
  private updatePitU(car: RaceCar, t: number): void {
    const pit = this.model.pit!;
    const ps = car.pit!;
    const target = ps.uEntry + (ps.p / pit.length) * pit.span;
    while (Math.floor(car.u) + 1 <= target + 1e-9) {
      const next = Math.floor(car.u) + 1;
      car.u = next;
      if (this.cross(car, next, t) === STOP) return;
    }
    car.u = Math.max(car.u, target);
  }

  // ---- station events ------------------------------------------------------------

  private cross(car: RaceCar, u: number, t: number): number {
    const k = mod(u, this.n);
    if (car.incident && u >= car.incident.u && car.status === 'running') {
      if (this.applyIncident(car, t)) return STOP;
    }
    const m = this.mark[k];
    if (m === 0) return CONTINUE;
    if (m & LOOP) {
      const lap = Math.floor(u / this.n);
      car.loopTimes[(lap & 1) * this.model.loops + Math.floor(k / this.model.loopEvery)] = t;
    }
    if (m & SECTOR) this.sector(car, k === this.model.sectors[0] ? 0 : 1, t);
    if (m & LINE && u > 0) {
      if (this.lapLine(car, u, t)) return STOP;
    }
    // Telemetry and the speed trap (after the line, so a new lap's trace starts at zero).
    if (m & TELE) car.trace[k / this.model.teleEvery] = t - car.lapStart;
    if (m & TRAP_START) car.trapT0 = t;
    if (m & TRAP && t > car.trapT0) car.trapV = this.trapBase / (t - car.trapT0);
    if (car.status !== 'running') return CONTINUE;
    if (m & DECIDE) this.decide(car, t);
    if (m & PIT_IN && car.pitRequest) {
      this.enterPit(car, u, t);
      return PIT;
    }
    if (m & ZONE) {
      this.attemptPass(car, u, t, this.zoneAt[k]);
      car.zone = { index: this.zoneAt[k], v: car.v, t };
    }
    if (m & DRS) this.detectDrs(car, u, t, this.drsAt[k]);
    return CONTINUE;
  }

  private sector(car: RaceCar, i: number, t: number): void {
    const time = t - car.sectorStart;
    car.sectorStart = t;
    car.sectors[i] = time;
    if (i === 0) car.sectors[1] = car.sectors[2] = null;
    car.sectorMarks[i] = this.markSector(car, i, time);
  }

  private markSector(car: RaceCar, i: number, time: number): SectorMark {
    let mark: SectorMark = 'normal';
    if (time < car.bestSectors[i]) {
      car.bestSectors[i] = time;
      mark = 'personal';
    }
    if (time < this.bestSectors[i]) {
      this.bestSectors[i] = time;
      mark = 'best';
    }
    return mark;
  }

  /** A lap completed. Returns true when the car has finished the race. */
  private lapLine(car: RaceCar, u: number, t: number): boolean {
    const lap = Math.round(u / this.n);
    this.accrue(car, u);
    car.tyreLaps++;
    const time = t - car.lapStart;
    const s3 = t - car.sectorStart;
    car.sectors[2] = s3;
    car.sectorMarks[2] = this.markSector(car, 2, s3);
    const s1 = car.sectors[0] ?? 0;
    const s2 = car.sectors[1] ?? 0;
    car.lapsDone = lap;
    car.lastLap = time;
    if (car.bestLap === null || time < car.bestLap) car.bestLap = time;
    if (this.lapLeaders.length < lap) this.lapLeaders[lap - 1] = t;
    car.history.push({
      lap, time, sectors: [s1, s2, s3], position: car.position, compound: car.compound, tyreLaps: car.tyreLaps,
      wear: car.wear, fuel: car.fuel, pit: car.pittedThisLap, at: t, gap: t - this.lapLeaders[lap - 1], trap: car.trapV,
    });
    car.trapV = NaN;
    car.traces.push(car.trace);
    car.trace = new Float32Array(this.model.samples).fill(NaN);
    if (lap > 1 && (!this.fastest || time < this.fastest.time)) {
      const beaten = this.fastest !== null;
      this.fastest = { car: car.id, time, lap };
      if (beaten) this.log('fastest', t, `Fastest lap: ${car.entrant.code} ${formatLapTime(time)}`, car.id, lap);
    }
    car.lapStart = t;
    car.sectorStart = t;

    // Stuck behind the same car for several laps: a reason to try the undercut.
    const ahead = this.order[car.position - 2];
    const iv = ahead ? this.gapBetween(car, ahead) : null;
    if (ahead && iv?.kind === 'time' && iv.value < 1) {
      car.stuckLaps = car.stuckBehind === ahead.id ? car.stuckLaps + 1 : 1;
      car.stuckBehind = ahead.id;
    } else {
      car.stuckLaps = 0;
      car.stuckBehind = -1;
    }

    if (car.fuel < 0) {
      this.retire(car, 'out of fuel', t);
      return true;
    }
    if (this.chequered || this.takesChequer(car, lap, t)) {
      this.finish(car, t);
      return true;
    }
    this.startLap(car, t);
    return false;
  }

  private takesChequer(car: RaceCar, lap: number, t: number): boolean {
    const byLaps = this.setup.laps !== null && lap >= this.setup.laps;
    const byTime = this.limit !== null && t >= this.limit;
    if (!byLaps && !byTime) return false;
    const leader = this.cars.every((o) => o === car || (o.status !== 'running' && o.status !== 'pit') || o.u <= car.u + 1e-9);
    if (!leader) return false;
    this.chequered = true;
    this.log('chequered', t, `Chequered flag: ${car.entrant.name} wins`, car.id, lap);
    return true;
  }

  private finish(car: RaceCar, t: number): void {
    car.status = 'finished';
    car.finishTime = t;
    car.pit = null;
    this.finishCount++;
    if (this.finishCount > 1 && this.finishCount <= 3) this.log('finish', t, `${car.entrant.code} finishes P${this.finishCount}`, car.id, car.lapsDone);
  }

  /** Per-lap draws: pace scatter, and whether this lap brings a mistake, a trip off, a crash or a failure. */
  private startLap(car: RaceCar, t: number): void {
    car.noise = Math.max(-2.5, Math.min(2.5, gauss(car.rng))) * car.entrant.consistency;
    car.pittedThisLap = false;
    car.cold = 0;
    car.lapPace = this.lapPaceFor(car);
    car.incident = null;
    if (car.status !== 'running') return;
    const inc = this.rules.incidents;
    const e = car.entrant;
    const worn = car.wear > 1 ? 1.5 : 1;
    const lapStartU = car.lapsDone * this.n;
    const zones = this.model.zones;
    const atZone = () => (zones.length ? zones[Math.floor(car.rng() * zones.length)].station : Math.floor(car.rng() * this.n));
    const r = car.rng();
    let acc = inc.dnfPerMetre * this.model.line.length * e.reliability;
    if (r < acc) {
      car.incident = { u: lapStartU + Math.floor(car.rng() * this.n), kind: 'failure' };
      return;
    }
    acc += inc.crash * e.errorRate * worn;
    if (r < acc) {
      car.incident = { u: lapStartU + atZone(), kind: 'crash' };
      return;
    }
    acc += inc.off * e.errorRate * worn;
    if (r < acc) {
      car.incident = { u: lapStartU + atZone(), kind: 'off' };
      return;
    }
    acc += inc.mistake * e.errorRate * worn;
    if (r < acc) car.incident = { u: lapStartU + atZone(), kind: 'mistake' };
    void t;
  }

  /** Returns true when the car is out of the race. */
  private applyIncident(car: RaceCar, t: number): boolean {
    const inc = car.incident!;
    car.incident = null;
    const where = this.where(inc.u);
    const lap = car.lapsDone + 1;
    if (inc.kind === 'failure') {
      const list = this.model.vehicle.kind === 'bike' ? FAILURES_BIKE : FAILURES_CAR;
      this.retire(car, list[Math.floor(car.rng() * list.length)], t);
      return true;
    }
    if (inc.kind === 'crash') {
      this.retire(car, 'crash', t);
      this.log('retired', t, `${car.entrant.code} crashes out${where}`, car.id, lap);
      return true;
    }
    if (inc.kind === 'off') {
      const loss = 3 + 7 * car.rng();
      car.delay += loss;
      car.delayShare = 0.9;
      car.offTrack = true;
      this.log('off', t, `${car.entrant.code} goes off${where} (${loss.toFixed(1)} s)`, car.id, lap);
      return false;
    }
    car.delay += 0.4 + 1.1 * car.rng();
    car.delayShare = Math.max(car.delayShare, 0.5);
    return false;
  }

  private retire(car: RaceCar, reason: string, t: number): void {
    const p = car.status === 'pit' ? this.pose(car, 1) : this.linePoint(car.u, car.lateral + 8);
    car.status = 'retired';
    car.pit = null;
    car.pitRequest = null;
    car.passing = null;
    car.retired = { reason, lap: car.lapsDone + 1, x: p?.x ?? 0, y: p?.y ?? 0 };
    if (reason !== 'crash' && !reason.startsWith('collision')) this.log('retired', t, `${car.entrant.code} retires: ${reason}`, car.id, car.lapsDone + 1);
  }

  private where(u: number): string {
    const c = this.model.cornerAt[mod(Math.floor(u), this.n)];
    return c ? ` at T${c}` : '';
  }

  // ---- pace, tyres and fuel ------------------------------------------------------

  private lapPaceFor(car: RaceCar): number {
    const m = this.model;
    const c = this.rules.tyres.compounds[car.compound];
    const wear = car.wear + 0.5 * wearPerLap(m, car.compound, car.entrant.tyreWear);
    const extraFuel = Math.max(0, car.fuel - 0.5 * m.fuelPerLap * car.burn - this.qualiFuel);
    const loss = this.rules.pace.race + c.offset + tyreLoss(c, wear) + m.fuelSensitivity * extraFuel + car.saving * FUEL_SAVE_COST + car.cold;
    return car.entrant.pace * (1 + loss) * (1 + car.noise);
  }

  /** Tyre wear and fuel burn since the last accrual, in proportion to the distance covered. */
  private accrue(car: RaceCar, u: number): void {
    const frac = Math.max(0, (u - car.accruedU) / this.n);
    car.accruedU = u;
    car.wear += frac * wearPerLap(this.model, car.compound, car.entrant.tyreWear);
    car.fuel -= frac * this.model.fuelPerLap * car.burn;
  }

  /** Laps a car still has to race, the current one included. */
  private lapsLeft(car: RaceCar): number {
    const lapTime = this.expectedLap(car);
    if (this.chequered) return 1;
    let left = Infinity;
    if (this.setup.laps !== null) left = this.setup.laps - car.lapsDone;
    if (this.limit !== null) {
      // The leader takes the flag at its first crossing after the time limit; everyone else at their first crossing after that.
      const leader = this.order[0];
      const leaderLap = this.expectedLap(leader);
      let flag = this.t + (1 - mod(leader.u, this.n) / this.n) * leaderLap;
      if (flag < this.limit) flag += Math.ceil((this.limit - flag) / leaderLap) * leaderLap;
      const lineAt = this.t + (1 - mod(car.u, this.n) / this.n) * lapTime;
      left = Math.min(left, 1 + (lineAt >= flag ? 0 : Math.ceil((flag - lineAt) / lapTime)));
    }
    return Math.max(1, left);
  }

  private expectedLap(car: RaceCar): number {
    const recent = car.history.slice(-3).filter((h) => !h.pit && h.lap > 1);
    if (recent.length) return recent.reduce((s, h) => s + h.time, 0) / recent.length;
    return this.model.lapTime * car.entrant.pace * (1 + this.rules.pace.race + 0.01);
  }

  private lapsLeftAtStart(): number {
    if (this.setup.laps !== null) {
      const byLimit = this.limit !== null ? Math.ceil(this.limit / (this.model.lapTime * (1 + this.rules.pace.race))) : Infinity;
      return Math.min(this.setup.laps, byLimit);
    }
    return Math.ceil((this.limit ?? 3600) / (this.model.lapTime * (1 + this.rules.pace.race + 0.01))) + 1;
  }

  /** Fuel load, starting tyres and the stint plan before the start. */
  private prepareStart(car: RaceCar, laps: number): void {
    const m = this.model;
    const fuel = this.rules.fuel;
    const refuel = fuel.refuelRate > 0 && !!m.pit && this.rules.pit.stops;
    const needed = laps * m.fuelPerLap * 1.02 + 0.5 * m.fuelPerLap;
    if (refuel) {
      car.fuel = Math.min(fuel.capacity, needed);
      const stint = Math.min(laps, car.fuel / m.fuelPerLap);
      car.compound = pickCompound(m, stint, car.entrant.tyreWear, 0, stint >= laps);
    } else {
      car.fuel = Math.min(fuel.capacity, needed);
      if (needed > fuel.capacity) {
        // Not enough fuel for the distance: lift and coast to make it last.
        car.saving = Math.min(0.3, 1 - fuel.capacity / needed);
        car.burn = 1 - car.saving;
      }
      const plan = planStrategy({
        model: m, tyreFactor: car.entrant.tyreWear, laps, compound: null, wear: 0, used: 0, stopsDone: 0, canStop: true,
      }, car.rng, 0.0015 * laps * m.lapTime);
      car.plan = plan.stints;
      car.compound = plan.stints[0].compound;
      car.nextStopLap = plan.stints.length > 1 ? this.jitterStop(car, plan.stints[0].laps, laps) : null;
    }
    car.used = 1 << car.compound;
  }

  /** Teams do not all stop on the optimal lap: spread planned stops by a lap or two. */
  private jitterStop(car: RaceCar, lap: number, lastLap: number): number {
    return Math.max(2, Math.min(lastLap - 2, lap + Math.round(gauss(car.rng) * 1.5)));
  }

  // ---- pit stops -------------------------------------------------------------------

  private decide(car: RaceCar, t: number): void {
    if (car.pitRequest || this.chequered) return;
    const left = this.lapsLeft(car);
    if (left <= 1) return;
    const m = this.model;
    const refuel = this.rules.fuel.refuelRate > 0;
    const lap = car.lapsDone + 1;
    this.accrue(car, car.u);
    let reason: string | null = null;
    // The next chance to stop is a lap away.
    if (refuel && car.fuel < m.fuelPerLap * car.burn * 1.2) reason = 'fuel';
    else if (car.wear > 1.08 && left > 3) reason = 'tyres';
    else if (car.stops < this.rules.pit.minStops && left <= 3) reason = 'mandatory';
    else if (!refuel && car.nextStopLap !== null) {
      const toGo = car.nextStopLap - lap;
      if (toGo <= 0) reason = 'plan';
      else if (toGo <= 6) {
        // A rival close behind has just stopped (the undercut): cover it; or try the undercut when stuck behind someone.
        if (car.threatLap >= lap - 1 && this.rng() < 0.4 + 0.4 * car.entrant.racecraft) reason = 'cover';
        else if (car.stuckLaps >= 2 && toGo <= 5 && this.rng() < 0.5) reason = 'undercut';
      }
    }
    if (reason) car.pitRequest = reason;
    void t;
  }

  private enterPit(car: RaceCar, u: number, t: number): void {
    const pit = this.model.pit!;
    this.accrue(car, u);
    const teams = Math.max(1, ...this.setup.entrants.map((e) => e.teamIndex + 1));
    const box = pit.boxFrom + ((car.entrant.teamIndex + 0.5) / teams) * (pit.boxTo - pit.boxFrom);
    // The car ahead, if close, now faces the undercut.
    const ahead = this.order[car.position - 2];
    const iv = ahead ? this.gapBetween(car, ahead) : null;
    if (ahead && ahead.status === 'running' && iv?.kind === 'time' && iv.value < 3) ahead.threatLap = car.lapsDone + 1;
    const service = this.planService(car, car.pitRequest ?? 'plan');
    const record: PitStopRecord = {
      car: car.id, lap: car.lapsDone + 1, entry: t, exit: NaN, stationary: NaN,
      from: car.compound, to: service.compound, fuel: service.fuel, reason: service.reason,
    };
    this.stops.push(record);
    car.status = 'pit';
    car.pit = { p: 0, prevP: 0, box, uEntry: u, stopped: false, stoppedUntil: 0, stopStart: t, done: false, service, record };
    car.pittedThisLap = true;
    car.drsUntilU = -Infinity;
    car.passing = null;
    car.offTrack = false;
    car.delay = 0;
    car.incident = null;
  }

  /** What the crew does: tyres (and which compound), fuel, and how long it takes. */
  private planService(car: RaceCar, reason: string): PitState['service'] {
    const m = this.model;
    const r = this.rules;
    const left = this.lapsLeft(car);
    let compound: number | null;
    let fuel = 0;
    if (r.fuel.refuelRate > 0) {
      const needed = left * m.fuelPerLap * 1.02 + 0.5 * m.fuelPerLap - car.fuel;
      fuel = Math.max(0, Math.min(r.fuel.capacity - car.fuel, needed));
      const stint = Math.min(left, (car.fuel + fuel) / m.fuelPerLap);
      const lastSet = car.fuel + fuel >= left * m.fuelPerLap;
      const wpl = wearPerLap(m, car.compound, car.entrant.tyreWear);
      const mustSwitch = r.tyres.mustUseTwo && popcount(car.used) < 2 && lastSet;
      compound = car.wear + stint * wpl > 0.9 || mustSwitch ? pickCompound(m, stint, car.entrant.tyreWear, car.used, lastSet) : null;
    } else {
      const plan = planStrategy({
        model: m, tyreFactor: car.entrant.tyreWear, laps: left, compound: null, wear: 0, used: car.used, stopsDone: car.stops + 1, canStop: true,
      });
      compound = plan.stints[0].compound;
    }
    const tyreT = compound !== null ? r.pit.tyreChange * (1 + 0.08 * gauss(car.rng)) : 0;
    const fuelT = r.fuel.refuelRate > 0 ? fuel / r.fuel.refuelRate : 0;
    let time = r.pit.concurrent ? Math.max(tyreT, fuelT) : tyreT + fuelT;
    if (car.stops < r.pit.minStops) time = Math.max(time, r.pit.minStationary);
    if (compound !== null && car.rng() < 0.04) time += 2 + 6 * car.rng();
    return { compound, fuel, time: Math.max(0.8, time), reason };
  }

  private finishService(car: RaceCar, t: number): void {
    const s = car.pit!.service;
    car.pit!.record.stationary = t - car.pit!.stopStart;
    const lap = car.lapsDone + 1;
    const r = this.rules;
    const old = r.tyres.compounds[car.compound];
    if (s.compound !== null) {
      car.compound = s.compound;
      car.wear = 0;
      car.tyreLaps = 0;
      car.used |= 1 << s.compound;
    }
    car.fuel += s.fuel;
    car.stops++;
    car.lastStopLap = lap;
    car.pitRequest = null;
    const tyres = s.compound !== null ? `${old.name} → ${r.tyres.compounds[s.compound].name}` : 'no tyres';
    const fuel = s.fuel > 0 ? `, ${Math.round(s.fuel)} kg fuel` : '';
    this.log('pit', t, `${car.entrant.code} pits: ${tyres}${fuel}, ${s.time.toFixed(1)} s`, car.id, lap);
    if (r.fuel.refuelRate <= 0) {
      const left = this.lapsLeft(car);
      const plan = planStrategy({
        model: this.model, tyreFactor: car.entrant.tyreWear, laps: left, compound: car.compound, wear: car.wear, used: car.used, stopsDone: car.stops, canStop: true,
      });
      car.plan = plan.stints;
      car.nextStopLap = plan.stints.length > 1 ? this.jitterStop(car, car.lapsDone + plan.stints[0].laps, car.lapsDone + left) : null;
    }
  }

  private exitPit(car: RaceCar, v: number, t: number): void {
    car.pit!.record.exit = t;
    car.status = 'running';
    car.pit = null;
    car.accruedU = car.u;
    car.launch = { u: car.u, from: v, factor: 1 };
    car.exitUntilU = car.u + EXIT_BLEND / this.ds;
    car.cold = COLD_TYRES;
    car.lapPace = this.lapPaceFor(car);
    car.lateral = this.pitSide * 4;
    car.v = v;
  }

  // ---- racing ----------------------------------------------------------------------

  private nearestAhead(car: RaceCar): { car: RaceCar; d: number } | null {
    let best: RaceCar | null = null;
    let bestD = Infinity;
    for (const o of this.cars) {
      if (o === car || o.status !== 'running' || o.offTrack) continue;
      const d = mod(o.u - car.u, this.n);
      if (d > 0 && d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best ? { car: best, d: bestD * this.ds } : null;
  }

  private attemptPass(car: RaceCar, u: number, t: number, zoneIndex: number): void {
    if (u < car.cooldownU || car.passing || car.offTrack || car.exitUntilU > car.u || car.pitRequest) return;
    const near = this.nearestAhead(car);
    if (!near) return;
    const def = near.car;
    const gapT = near.d / Math.max(car.v, 20);
    if (gapT > 0.6 || def.passing?.target === car || !this.blocks(def, car)) return;
    const lapping = car.u > def.u;
    let p: number;
    let skill = 1;
    if (lapping) p = 0.9;
    else {
      const zone = this.model.zones[zoneIndex];
      // Compare speeds at the same braking point: the defender has usually started braking already.
      const defV = def.zone && def.zone.index === zoneIndex && t - def.zone.t < 2 ? def.zone.v : def.v;
      const speedAdv = car.v / Math.max(defV, 1) - 1;
      const paceAdv = (def.lapPace - car.lapPace) / def.lapPace;
      const adv = speedAdv + 2 * paceAdv;
      skill = 0.75 + 0.5 * (car.entrant.racecraft - def.entrant.racecraft);
      // Closer is better: full chance within 0.3 s, falling to 40% at 0.6 s.
      const reach = 1 - 0.6 * clamp01((gapT - 0.3) / 0.3);
      p = zone.quality * this.rules.pace.overtaking * clamp01((adv - 0.015) / 0.07) * skill * reach;
      if (car.lapsDone === 0) p *= 1.3;
      p = Math.min(0.8, p);
    }
    if (p < 0.02) return;
    car.cooldownU = u + 150 / this.ds;
    if (this.rng() < p) {
      car.passing = { target: def, untilU: car.u + 250 / this.ds };
      def.delay += lapping ? 0.3 : 0.25;
      def.delayShare = Math.max(def.delayShare, 0.35);
      return;
    }
    if (lapping) return;
    // The move did not come off: the attacker backs out and loses a little, and now and then they touch.
    car.delay += 0.1 + 0.25 * car.rng();
    car.delayShare = Math.max(car.delayShare, 0.35);
    if (this.rng() < 0.01 * (1.3 - skill * 0.6)) this.contact(car, def);
  }

  private contact(a: RaceCar, b: RaceCar): void {
    const lap = a.lapsDone + 1;
    for (const c of [a, b]) {
      c.delay += 1 + 3 * c.rng();
      c.delayShare = 0.8;
    }
    b.offTrack = true;
    const where = this.where(a.u);
    if (this.rng() < 0.1) {
      const victim = this.rng() < 0.5 ? a : b;
      this.log('contact', this.t, `Contact between ${a.entrant.code} and ${b.entrant.code}${where}: ${victim.entrant.code} is out`, a.id, lap, b.id);
      this.retire(victim, 'collision damage', this.t);
    } else {
      this.log('contact', this.t, `Contact between ${a.entrant.code} and ${b.entrant.code}${where}`, a.id, lap, b.id);
    }
  }

  private detectDrs(car: RaceCar, u: number, t: number, region: number): void {
    const drs = this.rules.drs;
    if (!drs || region < 0) return;
    const near = this.nearestAhead(car);
    const gap = near ? t - near.car.drsCross[region] : Infinity;
    if (car.lapsDone + 1 >= drs.fromLap && gap >= 0 && gap <= drs.gap) car.drsUntilU = u + this.model.drs[region].length;
    car.drsCross[region] = t;
  }

  /** Completes passes once the attacker is ahead, or forces them at the end of the move. */
  private resolvePasses(): void {
    for (const car of this.cars) {
      const pass = car.passing;
      if (!pass) continue;
      const def = pass.target;
      if (car.status !== 'running' || def.status !== 'running') {
        car.passing = null;
        continue;
      }
      let d = mod(car.u - def.u, this.n);
      if (d > this.n / 2) {
        if (car.u < pass.untilU) continue;
        // Out of road: put the attacker just ahead.
        this.advanceTo(car, car.u + (this.n - d) + 4 / this.ds);
        if (car.status !== 'running') {
          car.passing = null;
          continue;
        }
        d = mod(car.u - def.u, this.n);
      }
      if (d * this.ds < 2) continue;
      car.passing = null;
      // No instant switchback: the car just passed needs a while to line up a reply.
      def.cooldownU = Math.max(def.cooldownU, def.u + this.n * 0.15);
      if (car.u > def.u && car.u - def.u < this.n / 2) {
        // A real overtake, not a leader lapping a backmarker.
        const pos = this.order.indexOf(def) + 1;
        this.log('overtake', this.t, `${car.entrant.code} passes ${def.entrant.code} for P${pos}${this.where(car.u - 60 / this.ds)}`, car.id, car.lapsDone + 1, def.id);
      }
    }
  }

  private advanceTo(car: RaceCar, target: number): void {
    while (car.status === 'running' && Math.floor(car.u) + 1 <= target) {
      const next = Math.floor(car.u) + 1;
      car.u = next;
      const r = this.cross(car, next, this.t);
      if (r === STOP) return;
      if (r === PIT) {
        this.movePit(car, 0, this.t);
        return;
      }
    }
    if (car.status === 'running') car.u = Math.max(car.u, target);
  }

  /** Side-by-side offsets for drawing, and the pit lane side on the entry and exit roads. */
  private updateLateral(): void {
    const pit = this.model.pit;
    const widths = this.model.track.width;
    for (const car of this.cars) {
      if (car.status !== 'running') continue;
      const k = mod(Math.floor(car.u), this.n);
      const half = widths[k] / 2 - 1.2;
      let target = 0;
      if (car.passing) target = (this.model.line.curvature[(k + 40) % this.n] > 0 ? -1 : 1) * 2.5;
      else if (car.exitUntilU > car.u && pit) target = this.pitSide * half;
      else if (car.pitRequest && pit && mod(pit.entry - car.u, this.n) * this.ds < ENTRY_ROAD) target = this.pitSide * half;
      else if (car.u < this.firstZoneU && car.lapsDone === 0) target = car.lateral;
      target = Math.max(-half - this.model.line.offset[k], Math.min(half - this.model.line.offset[k], target));
      const step = 3 * DT;
      car.lateral += Math.max(-step, Math.min(step, target - car.lateral));
    }
  }

  private updateOrder(): void {
    this.order.sort((a, b) => {
      const ra = a.status === 'retired' ? 1 : 0;
      const rb = b.status === 'retired' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      if (Math.abs(b.u - a.u) > 1e-9) return b.u - a.u;
      return (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity);
    });
    this.order.forEach((c, i) => { c.position = i + 1; });
  }

  private log(kind: RaceEventKind, t: number, text: string, car: number, lap = this.leaderLap, other?: number): void {
    this.events.push({ t, lap, kind, text, car, other });
  }
}

/** The side of the track the pit lane is on, as a left-normal sign. */
function pitSide(m: RaceModel): number {
  const pit = m.pit;
  if (!pit || pit.x.length < 2) return 1;
  const i = Math.min(pit.x.length - 1, Math.floor(pit.x.length / 2));
  const k = (pit.entry + Math.round((i / (pit.x.length - 1)) * pit.span)) % m.n;
  const nx = Math.sin(m.track.heading[k]);
  const ny = -Math.cos(m.track.heading[k]);
  return (pit.x[i] - m.track.x[k]) * nx + (pit.y[i] - m.track.y[k]) * ny >= 0 ? 1 : -1;
}

function pathPoint(xs: Float64Array, ys: Float64Array, cum: Float64Array, p: number): { x: number; y: number; heading: number } {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= p) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const f = Math.max(0, Math.min(1, (p - cum[lo]) / span));
  return { x: xs[lo] + (xs[hi] - xs[lo]) * f, y: ys[lo] + (ys[hi] - ys[lo]) * f, heading: Math.atan2(ys[hi] - ys[lo], xs[hi] - xs[lo]) };
}

export function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
