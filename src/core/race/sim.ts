/**
 * The race simulation. Each car is a position along the lap (in stations,
 * counted from the start line across laps) and runs its class's race lap
 * from the model, slowed or sped up per station by its current state:
 *
 *   segment time = race lap segment x car and driver pace x (1 + tyre wear
 *                  + compound + fuel mass + lap-to-lap scatter)
 *                  x slipstream, wake and DRS for the car ahead
 *                  x grip lost on a wet track on the tyres fitted
 *
 * A car cannot drive through the one ahead: it is held a small gap behind
 * it until a braking zone, where it may try to pass. The chance depends on
 * the speed difference at the braking point, the pace difference, the zone
 * and both drivers' racecraft; lapped cars and slower classes let faster
 * cars by. Cars stop in the actual pit lane at the speed limit, for tyres,
 * fuel, a driver change or a change of weather.
 *
 * The race brings mistakes, trips off the track, crashes and technical
 * failures. Race control shows yellow flags where something happened and,
 * when a car stops on track, may neutralise the race with a safety car, a
 * virtual safety car or a full course yellow. Rain comes and goes on a
 * seeded timeline and the track gets wet and dries.
 *
 * Time advances in fixed steps of DT seconds, so a seed always gives the same
 * race whatever the playback speed. Within a step, cars walk station by
 * station and every timing line crossed is timed exactly.
 */
import { formatLapTime } from '../calibration.ts';
import { hashSeed, mulberry32, seededRandom } from '../rng.ts';
import type { Driver, Entrant } from './field.ts';
import { gauss } from './field.ts';
import { type RaceModel, gripBlend, lapRatioAtGrip, launchSpeed } from './model.ts';
import type { RaceRules, TyreType } from './rules.ts';
import type { RaceSetup } from './setup.ts';
import {
  COLD_TYRES, type StintPlan, compoundOfType, needsSecondCompound, pickCompound, planStrategy, stopCost, tyreLoss, tyreTypes, wearPerLap,
} from './strategy.ts';
import {
  RAIN_THRESHOLD, type Weather, aquaplaning, bestTyreType, conditionName, gripFactor, rainAt, riskFactor, wearFactor, wetnessAhead, wetnessAt,
} from './weather.ts';

export const DT = 0.1;

export type CarStatus = 'running' | 'pit' | 'finished' | 'retired';
/** Colour of a sector time: best of anyone in the class, personal best, or neither. */
export type SectorMark = 'best' | 'personal' | 'normal';
/** Race control: racing, or neutralised by a safety car, a virtual safety car or a full course yellow. */
export type FlagPhase = 'green' | 'sc' | 'vsc' | 'fcy';

export interface LapRecord {
  lap: number;
  time: number;
  sectors: [number, number, number];
  position: number;
  /** Position within the class. */
  classPosition: number;
  compound: number;
  tyreLaps: number;
  wear: number;
  fuel: number;
  pit: boolean;
  /** Race time at the line. */
  at: number;
  /** Seconds behind the first car of the class to complete this lap. */
  gap: number;
  /** Speed through the speed trap on this lap, m/s (NaN if not measured). */
  trap: number;
  /** Driver in the car at the line (index into the entrant's drivers). */
  driver: number;
  /** Track wetness at the line, 0..1. */
  wet: number;
  /** Whether part of the lap ran under a safety car, VSC or full course yellow. */
  neutral: boolean;
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
  /** Driver who took over, or null when the driver stayed in. */
  driver: number | null;
  reason: string;
}

export type RaceEventKind = 'start' | 'overtake' | 'pit' | 'fastest' | 'off' | 'contact' | 'retired' | 'chequered' | 'finish' | 'flag' | 'weather';

export interface RaceEvent {
  t: number;
  /** The lap the car was on (the leader's lap for race control and weather). */
  lap: number;
  kind: RaceEventKind;
  text: string;
  /** The car involved, or -1 for race control and the weather. */
  car: number;
  other?: number;
}

/** A period under a safety car, virtual safety car or full course yellow. */
export interface Neutralisation {
  kind: 'sc' | 'vsc' | 'fcy';
  from: number;
  /** NaN while it lasts. */
  to: number;
  reason: string;
}

/** A stretch of track under yellow flags (stations, wrapping), until a race time. */
export interface YellowZone {
  from: number;
  to: number;
  /** The station where it happened. */
  at: number;
  double: boolean;
  until: number;
}

/** Conditions every half minute, for the charts. */
export interface TimelinePoint {
  t: number;
  rain: number;
  wet: number;
  phase: FlagPhase;
  /** Cars running on slicks, intermediates and wets. */
  tyres: [number, number, number];
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
  service: Service;
  record: PitStopRecord;
}

interface Service {
  compound: number | null;
  fuel: number;
  time: number;
  reason: string;
  driver: number | null;
}

/** One class in the race, with its model, rules and class-wide timing. */
export class RaceClass {
  readonly index: number;
  readonly model: RaceModel;
  readonly rules: RaceRules;
  readonly cars: RaceCar[] = [];
  /** Class order, leader first. */
  order: RaceCar[] = [];
  fastest: { car: number; time: number; lap: number } | null = null;
  bestSectors = [Infinity, Infinity, Infinity];
  /** Race time at which the class's first car completed each lap. */
  lapLeaders: number[] = [];
  /** Tyre types the class can fit. */
  readonly types: TyreType[];
  readonly zoneAt: Int16Array;
  readonly drsAt: Int16Array;
  /** Fuel carried on the qualifying lap: the race lap's fuel effect counts only above it. */
  readonly qualiFuel: number;
  finishers = 0;

  constructor(index: number, model: RaceModel) {
    this.index = index;
    this.model = model;
    this.rules = model.rules;
    this.types = tyreTypes(model.rules);
    this.zoneAt = new Int16Array(model.n).fill(-1);
    model.zones.forEach((z, i) => { this.zoneAt[z.station] = i; });
    this.drsAt = new Int16Array(model.n).fill(-1);
    model.drs.forEach((d, i) => { this.drsAt[d.start] = i; });
    this.qualiFuel = Math.min(model.rules.fuel.capacity, 3 * model.fuelPerLap);
  }

  get label(): string {
    return this.rules.label;
  }

  get color(): string {
    return this.rules.color;
  }

  get name(): string {
    return this.model.vehicle.name;
  }
}

export class RaceCar {
  readonly entrant: Entrant;
  readonly id: number;
  readonly cls: RaceClass;
  gridPosition = 0;
  /** Grid slot within the class. */
  classGrid = 0;
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
  tyreType: TyreType = 'slick';
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
  classPosition = 0;
  finishTime: number | null = null;
  retired: { reason: string; lap: number; x: number; y: number; t: number } | null = null;
  history: LapRecord[] = [];
  /** Driver in the car, since when, and each driver's time at the wheel before the current stint. */
  driverIndex = 0;
  driverSince = 0;
  driveTime: number[];
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
  /** No passing before this race progress (after a restart, until the line). */
  holdUntilU = -Infinity;
  stuckLaps = 0;
  stuckBehind = -1;
  /** Lap on which a rival close behind stopped, threatening the undercut. */
  threatLap = -99;
  /** Speed and time at the last braking zone crossed. */
  zone: { index: number; v: number; t: number } | null = null;
  accruedU = 0;
  pittedThisLap = false;
  neutralThisLap = false;
  /** Tyre type the team wants at the next stop because of the weather. */
  wantType: TyreType | null = null;
  incident: { u: number; kind: 'mistake' | 'off' | 'crash' | 'failure' } | null = null;
  trackIndex = 0;
  loopTimes: Float64Array;
  trapT0 = NaN;
  trapV = NaN;
  readonly rng: () => number;

  constructor(entrant: Entrant, cls: RaceClass, samples: number, seed: string) {
    this.entrant = entrant;
    this.id = entrant.index;
    this.cls = cls;
    this.loopTimes = new Float64Array(2 * cls.model.loops).fill(NaN);
    this.trace = new Float32Array(samples).fill(NaN);
    this.drsCross = new Float64Array(cls.model.drs.length).fill(-Infinity);
    this.driveTime = entrant.drivers.map(() => 0);
    this.rng = mulberry32(hashSeed(`${seed}:car:${entrant.index}`));
  }

  get model(): RaceModel {
    return this.cls.model;
  }

  get rules(): RaceRules {
    return this.cls.rules;
  }

  get driver(): Driver {
    return this.entrant.drivers[this.driverIndex];
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
/** Stationary time for a class that does not stop, coming in only to change tyres (or swap bikes) for the weather. */
const WEATHER_SWAP = 8;
/** Speed at which a rolling start is taken, m/s. */
const ROLLING_SPEED = 100 / 3.6;
/** Segment-time factors through single and double waved yellows, and the zone around the incident (metres). */
const SINGLE_YELLOW = 1.06;
const DOUBLE_YELLOW = 1.2;
const YELLOW_BEFORE = 250;
const YELLOW_AFTER = 60;
/** Under a safety car, cars keep at least this much slower than their race lap until they reach the queue. */
const SC_DELTA = 1.25;
/** The safety car's speed: a share of the fastest class's race speed, and a top speed (m/s). */
const SC_PACE = 0.7;
const SC_TOP = 55;
/** Laps the safety car leads at least, and where it first appears ahead of the leader (metres). */
const SC_MIN_LAPS = 2;
const SC_AHEAD = 150;
/** Seconds over which cars slow down when the race is neutralised. */
const NEUTRAL_RAMP = 5;
/** DRS stays shut on a track wetter than this. */
const DRS_WET = 0.3;
const TIMELINE_EVERY = 30;
const TYRE_INDEX: Record<TyreType, number> = { slick: 0, inter: 1, wet: 2 };
const FAILURES_CAR = ['engine', 'gearbox', 'hydraulics', 'electrics', 'brakes', 'suspension', 'power unit', 'cooling'];
const FAILURES_BIKE = ['engine', 'electronics', 'gearbox', 'brakes', 'chain'];

export class RaceSim {
  readonly setup: RaceSetup;
  /** The fastest class's model; the track, timing lines and grid are the same for every class. */
  readonly model: RaceModel;
  readonly classes: RaceClass[];
  readonly cars: RaceCar[];
  /** Race order, leader first; retired cars at the end. */
  order: RaceCar[];
  t = 0;
  finished = false;
  chequered = false;
  events: RaceEvent[] = [];
  /** Every pit stop, in the order they started. */
  stops: PitStopRecord[] = [];
  /** Race time at which the first car completed each lap (index = lap - 1). */
  lapLeaders: number[] = [];
  /** Race control. */
  phase: FlagPhase = 'green';
  safetyCar: { u: number; prevU: number; startU: number; clearAt: number; in: boolean } | null = null;
  neutral: Neutralisation[] = [];
  yellows: YellowZone[] = [];
  /** Conditions now, and every half minute so far. */
  rain = 0;
  wetness = 0;
  timeline: TimelinePoint[] = [];

  private readonly n: number;
  private readonly ds: number;
  private readonly lineDs: Float64Array;
  private readonly mark: Uint16Array;
  /** Racing-line distance over which the speed trap measures. */
  private readonly trapBase: number;
  private readonly rng: () => number;
  /** Race control's own random stream, so the flags do not change the cars' draws. */
  private readonly controlRng: () => number;
  private readonly limit: number | null;
  private readonly weather: Weather;
  private readonly teams: number;
  private trackOrder: RaceCar[] = [];
  private finishCount = 0;
  /** Race progress of the first braking zone on lap 1; until then nobody is held up. */
  private readonly firstZoneU: number;
  private readonly pitSide: number;
  private readonly yellowAt: Uint8Array;
  /** The safety car's time per segment, and the station where it leaves the track. */
  private readonly scSeg: Float64Array;
  private readonly scExit: number;
  private phaseSince = 0;
  private virtualUntil = NaN;
  /** After a safety car: the car that leads the field to the line, where racing resumes. */
  private restartLeader: RaceCar | null = null;
  /** Grip blend weights per tyre type at the current wetness. */
  private gripW: [number, number][] = [[0, 0], [0, 0], [0, 0]];
  private raining = false;
  private nextTimeline = 0;

  constructor(setup: RaceSetup) {
    this.setup = setup;
    const m = setup.model;
    this.model = m;
    this.n = m.n;
    this.ds = m.track.ds;
    this.lineDs = m.line.ds;
    this.rng = seededRandom(`${setup.settings.seed}:race`);
    this.controlRng = seededRandom(`${setup.settings.seed}:control`);
    this.limit = setup.duration ?? setup.timeLimit;
    this.weather = setup.weather;

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
    this.classes = setup.models.map((cm, i) => new RaceClass(i, cm));
    for (const c of this.classes) {
      c.model.zones.forEach((z) => { this.mark[z.station] |= ZONE; });
      c.model.drs.forEach((d) => { this.mark[d.start] |= DRS; });
    }
    // Every class may come in, if only to change tyres for the weather.
    if (m.pit) {
      this.mark[m.pit.entry] |= PIT_IN;
      this.mark[mod(m.pit.entry - Math.round(DECISION_DISTANCE / this.ds), n)] |= DECIDE;
    }
    this.yellowAt = new Uint8Array(n);
    this.scSeg = new Float64Array(n);
    for (let k = 0; k < n; k++) this.scSeg[k] = Math.max(m.seg[k] / SC_PACE, this.lineDs[k] / SC_TOP);
    // The safety car pulls into the pit lane when it is near the end of the lap, else just before the line.
    const pitToLine = m.pit ? mod(n - m.pit.entry, n) * this.ds : Infinity;
    this.scExit = pitToLine < 1500 ? m.pit!.entry : mod(n - Math.round(400 / this.ds), n);

    this.firstZoneU = m.zones.length ? m.zones[0].station : Math.round(n / 4);
    this.pitSide = pitSide(m);
    this.cars = setup.entrants.map((e) => new RaceCar(e, this.classes[e.classIndex], m.samples, setup.settings.seed));
    for (const car of this.cars) car.cls.cars.push(car);
    this.teams = Math.max(1, ...setup.entrants.map((e) => e.teamIndex + 1));

    const rolling = m.rules.race.start === 'rolling';
    const lapsEstimate = this.classes.map((c) => this.lapsLeftAtStart(c));
    const classSlots = this.classes.map(() => 0);
    setup.grid.forEach((index, slot) => {
      const car = this.cars[index];
      const g = m.grid[slot];
      car.gridPosition = slot + 1;
      car.classGrid = ++classSlots[car.cls.index];
      car.u = g.u;
      car.prevU = g.u;
      car.accruedU = 0;
      car.lateral = g.lateral;
      const d = car.driver;
      if (rolling) {
        // Already moving in formation: the start is how well each driver times the throttle.
        car.launch = { u: g.u, from: ROLLING_SPEED, factor: 0.97 + 0.03 * d.launch };
        car.v = ROLLING_SPEED;
      } else {
        car.startDelay = 0.15 + 0.3 * (1 - d.launch) * car.rng() + 0.05 * car.rng();
        car.launch = { u: g.u, from: 0, factor: 0.94 + 0.06 * d.launch };
      }
      this.prepareStart(car, lapsEstimate[car.cls.index]);
    });
    this.order = [...this.cars].sort((a, b) => a.gridPosition - b.gridPosition);
    this.updateClassOrder();
    this.updateConditions(0);
    for (const car of this.cars) this.startLap(car, 0);
    this.log('start', 0, rolling ? 'Green flag: rolling start' : 'Lights out', this.order[0].id);
    if (this.raining || this.wetness > 0.08) this.log('weather', 0, `${conditionName(this.wetness)} track${this.raining ? ', raining' : ''}`, -1);
  }

  /** Laps the leader has started, for "Lap 12/58". */
  get leaderLap(): number {
    const leader = this.order[0];
    const lap = leader ? Math.max(1, leader.lapsDone + (leader.status === 'finished' ? 0 : 1)) : 1;
    return this.setup.laps !== null ? Math.min(this.setup.laps, lap) : lap;
  }

  /** Fastest lap of the race over all classes. */
  get fastest(): { car: number; time: number; lap: number } | null {
    let best: { car: number; time: number; lap: number } | null = null;
    for (const c of this.classes) if (c.fastest && (!best || c.fastest.time < best.time)) best = c.fastest;
    return best;
  }

  get multiClass(): boolean {
    return this.classes.length > 1;
  }

  /** Advances one fixed step. */
  step(): void {
    if (this.finished) return;
    const t0 = this.t;
    const n = this.n;
    this.updateConditions(t0);
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

    // The safety car first, so the car behind it sees where it went.
    if (this.safetyCar) this.moveSafetyCar();
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

  /** Gap to the leader of the car's class. */
  classGap(car: RaceCar): Gap {
    const leader = car.cls.order[0];
    return car === leader ? { kind: 'leader', value: 0 } : this.gapBetween(car, leader);
  }

  /** Gap to the car one place ahead in the class. */
  classInterval(car: RaceCar): Gap {
    const i = car.cls.order.indexOf(car);
    if (i <= 0) return { kind: 'leader', value: 0 };
    return this.gapBetween(car, car.cls.order[i - 1]);
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

  /** Time the driver in the car has been at the wheel in this stint, and each driver's total. */
  driveTimes(car: RaceCar): number[] {
    const end = car.finishTime ?? car.retired?.t ?? this.t;
    return car.driveTime.map((d, i) => d + (i === car.driverIndex ? Math.max(0, end - car.driverSince) : 0));
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

  /** Where the safety car is, or null when it is not out. */
  safetyCarPose(alpha: number): { x: number; y: number; heading: number } | null {
    const sc = this.safetyCar;
    if (!sc) return null;
    return this.linePoint(sc.prevU + (sc.u - sc.prevU) * alpha, 0);
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
    // Held up: take the whole step to reach the car ahead rather than dash up to it and wait, so the speed stays smooth.
    let stretch = 1;
    if (limit < Infinity && limit > u) {
      let need = 0;
      for (let x = u; x < limit && need < budget;) {
        const fl = Math.floor(x);
        const to = Math.min(fl + 1, limit);
        need += (to - x) * this.segmentTime(car, mod(fl, n), x);
        x = to;
      }
      if (need > 1e-9 && need < budget) stretch = budget / need;
    }
    while (budget > 1e-12) {
      const fl = Math.floor(u);
      const k = mod(fl, n);
      const segT = this.segmentTime(car, k, u) * stretch;
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
    const m = car.model;
    let r = 1 + car.tow * (m.towRatio[k] - 1) + car.wake * (m.wakeRatio[k] - 1);
    if (m.drsRatio && car.drsUntilU > u) r += m.drsRatio[k] - 1;
    let s = m.seg[k] * car.lapPace * r;
    // Less grip on a wet track, depending on the tyres.
    const gw = this.gripW[TYRE_INDEX[car.tyreType]];
    if (gw[0] !== 0) s *= 1 + gw[0] * (m.gripRatio[0][k] - 1) + gw[1] * (m.gripRatio[1][k] - m.gripRatio[0][k]);
    // Alongside in a pass: a little quicker, but never beyond the car's top speed.
    if (car.passing) s = Math.max(s * 0.9, this.lineDs[k] / m.vehicle.topSpeed);
    const yellow = this.yellowAt[k];
    if (yellow) s *= yellow === 2 ? DOUBLE_YELLOW : SINGLE_YELLOW;
    if (this.phase !== 'green') {
      // Neutralised: no faster than the VSC delta, the full course yellow limit or the safety car delta.
      const floor = this.phase === 'vsc' ? m.seg[k] * (1 + this.model.rules.flags.vscSlower)
        : this.phase === 'fcy' ? this.lineDs[k] / this.model.rules.flags.fcySpeed
          : m.seg[k] * SC_DELTA;
      if (floor > s) s += (floor - s) * Math.min(1, (this.t - this.phaseSince) / NEUTRAL_RAMP);
    }
    // Speed caps: pulling away (start, pit exit, restart) and braking for the pit entry.
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

  /** How far a car may go before running into the car ahead (or the safety car). */
  private limitFor(car: RaceCar): number {
    const order = this.trackOrder;
    const N = order.length;
    // The gap grows with the speed of the car ahead (not the follower's own, which would feed back and make it surge and brake by turns).
    const gap = (v: number) => (this.phase === 'sc' ? 10 + 0.25 * v : 6 + 0.12 * v) / this.ds;
    let limit = Infinity;
    for (let s = 1; s < Math.min(N, 6); s++) {
      const a = order[(car.trackIndex - s + N) % N];
      if (a.status !== 'running' || !this.blocks(a, car)) continue;
      const d = mod(a.u - car.u, this.n);
      if (d * this.ds <= 250) limit = car.u + d - gap(a.v);
      break;
    }
    const sc = this.safetyCar;
    if (sc) {
      const d = mod(sc.u - car.u, this.n);
      const k = mod(Math.floor(sc.u), this.n);
      if (d * this.ds <= 250) limit = Math.min(limit, car.u + d - gap(this.lineDs[k] / this.scSeg[k]));
    }
    return limit;
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
    const pit = ahead.model.pit;
    if (ahead.pitRequest && pit && mod(pit.entry - ahead.u, this.n) * this.ds < ENTRY_ROAD) return false;
    return true;
  }

  private movePit(car: RaceCar, budget: number, t: number): void {
    const pit = car.model.pit!;
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
    const m = car.model;
    const pit = m.pit!;
    const ps = car.pit!;
    const lim = pit.limit;
    let v: number;
    if (p < pit.limitFrom) v = Math.sqrt(lim * lim + 2 * PIT_BRAKE * (pit.limitFrom - p));
    else if (p <= pit.limitTo) v = lim;
    else v = launchSpeed(m.launch, lim, p - pit.limitTo);
    if (!ps.done) v = Math.min(v, Math.sqrt(2 * BOX_BRAKE * Math.max(0, ps.box - p)) + 0.6);
    else if (p < pit.limitTo) v = Math.min(v, launchSpeed(m.launch, 0, Math.max(0, p - ps.box)) + 0.6);
    // Under a full course yellow the limit holds all the way out.
    if (this.phase === 'fcy') v = Math.min(v, Math.max(lim, this.model.rules.flags.fcySpeed));
    return Math.min(v, m.vehicle.topSpeed);
  }

  /** Race progress of a car in the pit lane: the lane mapped onto the stretch of lap it bypasses. */
  private updatePitU(car: RaceCar, t: number): void {
    const pit = car.model.pit!;
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
      // After a safety car, racing resumes when the car leading the field reaches the line.
      if (this.restartLeader === car) this.goGreen(t);
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
      const zone = car.cls.zoneAt[k];
      if (zone >= 0) {
        this.attemptPass(car, u, t, k, zone);
        car.zone = { index: zone, v: car.v, t };
      }
    }
    if (m & DRS) this.detectDrs(car, u, t, car.cls.drsAt[k]);
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
    if (time < car.cls.bestSectors[i]) {
      car.cls.bestSectors[i] = time;
      mark = 'best';
    }
    return mark;
  }

  /** A lap completed. Returns true when the car has finished the race. */
  private lapLine(car: RaceCar, u: number, t: number): boolean {
    const lap = Math.round(u / this.n);
    const cls = car.cls;
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
    if (cls.lapLeaders.length < lap) cls.lapLeaders[lap - 1] = t;
    car.history.push({
      lap, time, sectors: [s1, s2, s3], position: car.position, classPosition: car.classPosition, compound: car.compound, tyreLaps: car.tyreLaps,
      wear: car.wear, fuel: car.fuel, pit: car.pittedThisLap, at: t, gap: t - cls.lapLeaders[lap - 1], trap: car.trapV,
      driver: car.driverIndex, wet: this.wetness, neutral: car.neutralThisLap,
    });
    car.trapV = NaN;
    car.traces.push(car.trace);
    car.trace = new Float32Array(this.model.samples).fill(NaN);
    if (lap > 1 && (!cls.fastest || time < cls.fastest.time)) {
      const beaten = cls.fastest !== null;
      cls.fastest = { car: car.id, time, lap };
      if (beaten) this.log('fastest', t, `Fastest lap${this.multiClass ? ` in ${cls.label}` : ''}: ${car.entrant.code} ${formatLapTime(time)}`, car.id, lap);
    }
    car.lapStart = t;
    car.sectorStart = t;

    // Stuck behind the same car of the class for several laps: a reason to try the undercut.
    const ahead = cls.order[car.classPosition - 2];
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
    const under = this.phase === 'sc' ? ' under the safety car' : this.phase === 'vsc' ? ' under the VSC' : this.phase === 'fcy' ? ' under a full course yellow' : '';
    this.log('chequered', t, `Chequered flag${under}: ${this.multiClass ? `${car.entrant.code} ${car.entrant.team} wins overall` : `${car.entrant.name} wins`}`, car.id, lap);
    // The race ends at the flag: the safety car pulls in and nothing more is neutralised.
    if (this.phase !== 'green') this.goGreen(t, false);
    return true;
  }

  private finish(car: RaceCar, t: number): void {
    car.status = 'finished';
    car.finishTime = t;
    car.pit = null;
    this.finishCount++;
    car.cls.finishers++;
    if (this.multiClass) {
      if (car.cls.finishers === 1) this.log('finish', t, `${car.cls.label}: ${car.entrant.code} ${car.entrant.team} wins the class`, car.id, car.lapsDone);
    } else if (this.finishCount > 1 && this.finishCount <= 3) this.log('finish', t, `${car.entrant.code} finishes P${this.finishCount}`, car.id, car.lapsDone);
  }

  /** Per-lap draws: pace scatter, and whether this lap brings a mistake, a trip off, a crash or a failure. */
  private startLap(car: RaceCar, t: number): void {
    const d = car.driver;
    // More scatter on a wet track.
    car.noise = Math.max(-2.5, Math.min(2.5, gauss(car.rng))) * d.consistency * (1 + this.wetness);
    car.pittedThisLap = false;
    car.neutralThisLap = this.phase !== 'green';
    car.cold = 0;
    car.lapPace = this.lapPaceFor(car);
    car.incident = null;
    if (car.status !== 'running') return;
    const inc = car.rules.incidents;
    const risk = (car.wear > 1 ? 1.5 : 1) * riskFactor(car.tyreType, this.wetness);
    const lapStartU = car.lapsDone * this.n;
    const zones = car.model.zones;
    const atZone = () => (zones.length ? zones[Math.floor(car.rng() * zones.length)].station : Math.floor(car.rng() * this.n));
    const r = car.rng();
    let acc = inc.dnfPerMetre * this.model.line.length * car.entrant.reliability;
    if (r < acc) {
      car.incident = { u: lapStartU + Math.floor(car.rng() * this.n), kind: 'failure' };
      return;
    }
    acc += inc.crash * d.errorRate * risk;
    if (r < acc) {
      car.incident = { u: lapStartU + atZone(), kind: 'crash' };
      return;
    }
    acc += inc.off * d.errorRate * risk;
    if (r < acc) {
      car.incident = { u: lapStartU + atZone(), kind: 'off' };
      return;
    }
    acc += inc.mistake * d.errorRate * risk;
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
      const list = car.model.vehicle.kind === 'bike' ? FAILURES_BIKE : FAILURES_CAR;
      const reason = list[Math.floor(car.rng() * list.length)];
      // The car limps back to the pits, stops where the marshals can leave it, or has to be recovered.
      const r = this.controlRng();
      const pit = car.model.pit;
      if (r < 0.35 && pit) {
        this.retire(car, reason, t);
        const box = pit.boxFrom + ((car.entrant.teamIndex + 0.5) / this.teams) * (pit.boxTo - pit.boxFrom);
        const p = pathPoint(pit.x, pit.y, pit.cum, box);
        car.retired = { ...car.retired!, x: p.x, y: p.y };
        return true;
      }
      this.retire(car, reason, t, r < 0.7 ? 14 : 6);
      this.trackIncident(car.u, r < 0.7 ? 'parked' : 'stopped', t);
      return true;
    }
    if (inc.kind === 'crash') {
      this.retire(car, 'crash', t);
      this.log('retired', t, `${car.entrant.code} crashes out${where}`, car.id, lap);
      this.trackIncident(car.u, 'crash', t);
      return true;
    }
    if (inc.kind === 'off') {
      const loss = 3 + 7 * car.rng();
      car.delay += loss;
      car.delayShare = 0.9;
      car.offTrack = true;
      this.log('off', t, `${car.entrant.code} goes off${where} (${loss.toFixed(1)} s)`, car.id, lap);
      this.trackIncident(car.u, 'off', t);
      return false;
    }
    car.delay += 0.4 + 1.1 * car.rng();
    car.delayShare = Math.max(car.delayShare, 0.5);
    return false;
  }

  private retire(car: RaceCar, reason: string, t: number, aside = 8): void {
    const p = car.status === 'pit' ? this.pose(car, 1) : this.linePoint(car.u, car.lateral + aside);
    car.status = 'retired';
    car.pit = null;
    car.pitRequest = null;
    car.passing = null;
    car.retired = { reason, lap: car.lapsDone + 1, x: p?.x ?? 0, y: p?.y ?? 0, t };
    if (reason !== 'crash' && !reason.startsWith('collision')) this.log('retired', t, `${car.entrant.code} retires: ${reason}`, car.id, car.lapsDone + 1);
  }

  private where(u: number): string {
    const c = this.model.cornerAt[mod(Math.floor(u), this.n)];
    return c ? ` at T${c}` : '';
  }

  // ---- race control ----------------------------------------------------------------

  /**
   * Flags for something that happened at race progress `u`: a yellow for a
   * trip off or contact, a double yellow for a car stopped on track, and for
   * a crash or a car that has to be recovered, often a safety car, a virtual
   * safety car or a full course yellow (by the fastest class's rules).
   */
  private trackIncident(u: number, kind: 'off' | 'contact' | 'parked' | 'stopped' | 'crash', t: number): void {
    const rnd = this.controlRng;
    if (kind === 'off' || kind === 'contact' || kind === 'parked') {
      this.addYellow(u, false, 20 + 25 * rnd(), t);
      return;
    }
    const recover = 60 + 150 * rnd();
    this.addYellow(u, true, recover, t);
    if (this.chequered) return;
    const flags = this.model.rules.flags;
    const leader = this.order[0];
    // Not on the last lap: the race finishes under yellows.
    if (leader && this.lapsLeft(leader) <= 1) return;
    const k = mod(Math.floor(u), this.n);
    const severity = clamp01((this.model.v[k] - 30) / 50);
    // Series with a full course yellow keep the safety car for barrier repairs and big clean-ups.
    const fcy = flags.virtual === 'fcy';
    let pSc = !flags.safetyCar ? 0 : kind === 'crash' ? (fcy ? 0.15 + 0.25 * severity : 0.3 + 0.4 * severity) : fcy ? 0.05 : 0.12;
    const pVirtual = flags.virtual ? (kind === 'crash' ? 0.6 : 0.45) : 0;
    // Without a virtual safety car, a stopped car more often needs the real one.
    if (flags.safetyCar && !flags.virtual) pSc = Math.min(0.95, pSc + (kind === 'crash' ? 0.35 : 0.3));
    const r = rnd();
    const reason = kind === 'crash' ? `crash${this.where(u)}` : `stopped car${this.where(u)}`;
    if (r < pSc) this.deploySafetyCar(t, 180 + 300 * rnd(), reason);
    else if (r < pSc + pVirtual) this.startVirtual(t, flags.virtual!, recover, reason);
  }

  private addYellow(u: number, double: boolean, duration: number, t: number): void {
    const k = mod(Math.floor(u), this.n);
    this.yellows.push({
      from: mod(k - Math.round(YELLOW_BEFORE / this.ds), this.n),
      to: mod(k + Math.round(YELLOW_AFTER / this.ds), this.n),
      at: k,
      double,
      until: t + duration,
    });
    this.rebuildYellows();
  }

  private rebuildYellows(): void {
    this.yellowAt.fill(0);
    for (const z of this.yellows) {
      const len = mod(z.to - z.from, this.n);
      const level = z.double ? 2 : 1;
      for (let i = 0; i <= len; i++) {
        const k = (z.from + i) % this.n;
        if (this.yellowAt[k] < level) this.yellowAt[k] = level;
      }
    }
  }

  private startVirtual(t: number, kind: 'vsc' | 'fcy', duration: number, reason: string): void {
    if (this.phase === 'sc') {
      if (this.safetyCar) this.safetyCar.clearAt = Math.max(this.safetyCar.clearAt, t + duration);
      return;
    }
    if (this.phase === kind) {
      this.virtualUntil = Math.max(this.virtualUntil, t + duration);
      return;
    }
    this.phase = kind;
    this.phaseSince = t;
    this.virtualUntil = t + duration;
    this.neutral.push({ kind, from: t, to: NaN, reason });
    this.log('flag', t, `${kind === 'vsc' ? 'Virtual safety car' : 'Full course yellow'}: ${reason}`, -1);
  }

  /** Sends the safety car out just ahead of the leader, in a gap between cars. */
  private deploySafetyCar(t: number, clearance: number, reason: string): void {
    if (this.safetyCar) {
      this.safetyCar.clearAt = Math.max(this.safetyCar.clearAt, t + clearance);
      return;
    }
    const leader = this.order.find((c) => c.status === 'running' || c.status === 'pit');
    if (!leader) return;
    let u = leader.u + SC_AHEAD / this.ds;
    for (let tries = 0; tries < 20; tries++) {
      // A car just behind that spot would run into it: go ahead of that car instead.
      const close = this.cars.find((c) => c.status === 'running' && mod(u - c.u, this.n) * this.ds < 60);
      if (!close) break;
      u = close.u + 40 / this.ds;
    }
    if (this.phase === 'vsc' || this.phase === 'fcy') this.closeNeutral(t);
    this.phase = 'sc';
    this.phaseSince = t;
    this.safetyCar = { u, prevU: u, startU: u, clearAt: t + clearance, in: false };
    this.neutral.push({ kind: 'sc', from: t, to: NaN, reason });
    this.log('flag', t, `Safety car: ${reason}`, -1);
  }

  private moveSafetyCar(): void {
    const sc = this.safetyCar!;
    sc.prevU = sc.u;
    let budget = DT;
    let u = sc.u;
    while (budget > 1e-12) {
      const fl = Math.floor(u);
      const segT = this.scSeg[mod(fl, this.n)];
      const need = (fl + 1 - u) * segT;
      if (need > budget) {
        u += budget / segT;
        break;
      }
      budget -= need;
      u = fl + 1;
      // At the line, once the track is clear and it has led a full lap: in this lap.
      if (!sc.in && mod(u, this.n) === 0 && this.t >= sc.clearAt && u - sc.startU >= (SC_MIN_LAPS - 1) * this.n) {
        sc.in = true;
        this.log('flag', this.t, 'Safety car in this lap', -1);
      }
      if (sc.in && mod(u, this.n) === this.scExit) {
        // In this lap: it leaves the track, and the car behind leads the field to the line.
        this.safetyCar = null;
        const behind = this.cars.filter((c) => c.status === 'running').sort((a, b) => mod(u - a.u, this.n) - mod(u - b.u, this.n))[0];
        this.restartLeader = behind ?? null;
        if (!behind) this.goGreen(this.t);
        return;
      }
    }
    sc.u = u;
  }

  /** Back to racing: everyone pulls away from their current speed; after a safety car, no passing before the line. */
  private goGreen(t: number, announce = true): void {
    const afterSc = this.phase === 'sc';
    this.closeNeutral(t);
    this.phase = 'green';
    this.safetyCar = null;
    const leader = this.restartLeader;
    this.restartLeader = null;
    this.virtualUntil = NaN;
    for (const car of this.cars) {
      if (car.status !== 'running') continue;
      car.launch = { u: car.u, from: car.v, factor: 1 };
      if (afterSc && car !== leader) car.holdUntilU = Math.ceil(car.u / this.n - 1e-9) * this.n;
    }
    if (announce) this.log('flag', t, 'Green flag: racing resumes', -1);
  }

  private closeNeutral(t: number): void {
    const last = this.neutral[this.neutral.length - 1];
    if (last && Number.isNaN(last.to)) last.to = t;
  }

  /** Weather, flags and grip at the start of a step; ends a virtual safety car when its time is up; records the timeline. */
  private updateConditions(t: number): void {
    const w = this.weather;
    this.rain = rainAt(w, t);
    this.wetness = wetnessAt(w, t);
    for (const type of ['slick', 'inter', 'wet'] as const) this.gripW[TYRE_INDEX[type]] = gripBlend(gripFactor(type, this.wetness));
    if (!this.raining && this.rain > RAIN_THRESHOLD + 0.02) {
      this.raining = true;
      if (t > 0) this.log('weather', t, 'Rain is falling', -1);
    } else if (this.raining && this.rain < RAIN_THRESHOLD) {
      this.raining = false;
      if (t > 0) this.log('weather', t, `The rain has stopped (${conditionName(this.wetness).toLowerCase()} track)`, -1);
    }
    if (this.yellows.length && this.yellows.some((z) => z.until <= t)) {
      this.yellows = this.yellows.filter((z) => z.until > t);
      this.rebuildYellows();
    }
    if ((this.phase === 'vsc' || this.phase === 'fcy') && t >= this.virtualUntil) this.goGreen(t);
    if (this.restartLeader && this.restartLeader.status !== 'running') this.goGreen(t);
    if (this.phase !== 'green') {
      for (const car of this.cars) if (car.status === 'running' || car.status === 'pit') car.neutralThisLap = true;
    }
    if (t >= this.nextTimeline) {
      this.nextTimeline += TIMELINE_EVERY;
      const tyres: [number, number, number] = [0, 0, 0];
      for (const car of this.cars) if (car.status === 'running' || car.status === 'pit') tyres[TYRE_INDEX[car.tyreType]]++;
      this.timeline.push({ t, rain: this.rain, wet: this.wetness, phase: this.phase, tyres });
    }
  }

  // ---- pace, tyres and fuel ------------------------------------------------------

  private lapPaceFor(car: RaceCar): number {
    const m = car.model;
    const c = car.rules.tyres.compounds[car.compound];
    const wear = car.wear + 0.5 * wearPerLap(m, car.compound, car.driver.tyreWear) * wearFactor(car.tyreType, this.wetness);
    const extraFuel = Math.max(0, car.fuel - 0.5 * m.fuelPerLap * car.burn - car.cls.qualiFuel);
    const loss = car.rules.pace.race + c.offset + tyreLoss(c, wear) + m.fuelSensitivity * extraFuel + car.saving * FUEL_SAVE_COST + car.cold
      + aquaplaning(car.tyreType, this.wetness);
    return (1 + car.entrant.carPace + car.driver.pace) * (1 + loss) * (1 + car.noise);
  }

  /** Tyre wear and fuel burn since the last accrual, in proportion to the distance covered. */
  private accrue(car: RaceCar, u: number): void {
    const frac = Math.max(0, (u - car.accruedU) / this.n);
    car.accruedU = u;
    car.wear += frac * wearPerLap(car.model, car.compound, car.driver.tyreWear) * wearFactor(car.tyreType, this.wetness);
    car.fuel -= frac * car.model.fuelPerLap * car.burn;
  }

  /** Laps a car still has to race, the current one included. */
  private lapsLeft(car: RaceCar): number {
    const lapTime = this.expectedLap(car);
    if (this.chequered) return 1;
    const leader = this.order[0];
    const leaderLap = this.expectedLap(leader);
    const leaderLine = this.t + (1 - mod(leader.u, this.n) / this.n) * leaderLap;
    const lineAt = this.t + (1 - mod(car.u, this.n) / this.n) * lapTime;
    // The flag falls at the leader's crossing; everyone else takes it at their next crossing after that.
    const lapsTo = (flag: number) => 1 + (lineAt >= flag ? 0 : Math.ceil((flag - lineAt) / lapTime));
    let left = Infinity;
    if (this.setup.laps !== null) {
      left = this.setup.laps - car.lapsDone;
      // A slower class does not get to run all the laps.
      if (car.cls !== leader.cls) left = Math.min(left, lapsTo(leaderLine + Math.max(0, this.setup.laps - leader.lapsDone - 1) * leaderLap));
    }
    if (this.limit !== null) {
      let flag = leaderLine;
      if (flag < this.limit) flag += Math.ceil((this.limit - flag) / leaderLap) * leaderLap;
      left = Math.min(left, lapsTo(flag));
    }
    return Math.max(1, left);
  }

  private expectedLap(car: RaceCar): number {
    const recent = car.history.slice(-3).filter((h) => !h.pit && h.lap > 1 && !h.neutral);
    if (recent.length) return recent.reduce((s, h) => s + h.time, 0) / recent.length;
    const m = car.model;
    const w = this.wetness;
    return m.lapTime * (1 + car.entrant.carPace + car.driver.pace) * (1 + car.rules.pace.race + 0.01 + aquaplaning(car.tyreType, w)) * lapRatioAtGrip(m, gripFactor(car.tyreType, w));
  }

  private lapsLeftAtStart(cls: RaceClass): number {
    const lap = cls.model.lapTime * (1 + cls.rules.pace.race);
    if (this.setup.laps !== null) {
      const byLimit = this.limit !== null ? Math.ceil(this.limit / lap) : Infinity;
      let laps = Math.min(this.setup.laps, byLimit);
      if (cls.index > 0) {
        // The flag falls when the overall leader has done the laps.
        const lead = this.model.lapTime * (1 + this.model.rules.pace.race);
        laps = Math.min(laps, Math.ceil(Math.min(this.setup.laps * lead, this.limit ?? Infinity) / lap));
      }
      return laps;
    }
    return Math.ceil((this.limit ?? 3600) / (cls.model.lapTime * (1 + cls.rules.pace.race + 0.01))) + 1;
  }

  /** Fuel load, starting tyres (wet-weather ones on a wet track) and the stint plan before the start. */
  private prepareStart(car: RaceCar, laps: number): void {
    const m = car.model;
    const r = car.rules;
    const fuel = r.fuel;
    const refuel = fuel.refuelRate > 0 && !!m.pit && r.pit.stops;
    const needed = laps * m.fuelPerLap * 1.02 + 0.5 * m.fuelPerLap;
    const startType = bestTyreType(wetnessAhead(this.weather, 0, m.lapTime * 2), car.cls.types);
    const wet = startType !== 'slick' ? compoundOfType(r, startType) : null;
    if (refuel) {
      car.fuel = Math.min(fuel.capacity, needed);
      const stint = Math.min(laps, car.fuel / m.fuelPerLap);
      car.compound = wet ?? pickCompound(m, stint, car.driver.tyreWear, 0, stint >= laps);
    } else {
      car.fuel = Math.min(fuel.capacity, needed);
      if (needed > fuel.capacity) {
        // Not enough fuel for the distance: lift and coast to make it last.
        car.saving = Math.min(0.3, 1 - fuel.capacity / needed);
        car.burn = 1 - car.saving;
      }
      if (wet !== null) {
        // The dry plan waits until the track dries.
        car.compound = wet;
      } else {
        const plan = planStrategy({
          model: m, tyreFactor: car.driver.tyreWear, laps, compound: null, wear: 0, used: 0, stopsDone: 0, canStop: true,
        }, car.rng, 0.0015 * laps * m.lapTime);
        car.plan = plan.stints;
        car.compound = plan.stints[0].compound;
        car.nextStopLap = plan.stints.length > 1 ? this.jitterStop(car, plan.stints[0].laps, laps) : null;
      }
    }
    car.tyreType = r.tyres.compounds[car.compound].type;
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
    const m = car.model;
    const r = car.rules;
    this.accrue(car, car.u);
    const refuel = r.fuel.refuelRate > 0;
    const lap = car.lapsDone + 1;
    let reason: string | null = null;
    if (r.pit.stops && refuel && car.fuel < m.fuelPerLap * car.burn * 1.2) reason = 'fuel';
    // Rain coming or the track drying: a change of tyres.
    const call = this.weatherCall(car, left);
    if (call) {
      car.wantType = call;
      reason ??= call === 'slick' ? 'slicks' : call === 'inter' ? 'intermediates' : 'wets';
    }
    if (!r.pit.stops) {
      // A class that does not stop comes in only for the weather.
      if (reason) car.pitRequest = reason;
      return;
    }
    if (!reason) {
      if (car.wear > 1.08 && left > 3) reason = 'tyres';
      else if (car.stops < r.pit.minStops && left <= 3) reason = 'mandatory';
      else if (this.phase !== 'green' && left > 2 && this.cheapStop(car, lap, left)) reason = this.phase === 'sc' ? 'safety car' : this.phase === 'vsc' ? 'VSC' : 'full course yellow';
      else if (!refuel && car.nextStopLap !== null && car.tyreType === 'slick') {
        const toGo = car.nextStopLap - lap;
        if (toGo <= 0) reason = 'plan';
        else if (toGo <= 6) {
          // A rival close behind has just stopped (the undercut): cover it; or try the undercut when stuck behind someone.
          if (car.threatLap >= lap - 1 && this.rng() < 0.4 + 0.4 * car.driver.racecraft) reason = 'cover';
          else if (car.stuckLaps >= 2 && toGo <= 5 && this.rng() < 0.5) reason = 'undercut';
        }
      }
    }
    if (reason) car.pitRequest = reason;
    void t;
  }

  /**
   * Whether to take the cheap stop a neutralised race offers, when the car
   * still has to stop before the end: a planned stop due soon, half a tank
   * gone, worn tyres or a driver change due.
   */
  private cheapStop(car: RaceCar, lap: number, left: number): boolean {
    const r = car.rules;
    const m = car.model;
    const refuel = r.fuel.refuelRate > 0;
    const stint = car.plan.length ? car.plan[0].laps : 20;
    const lapTime = this.expectedLap(car);
    // Another stop is needed anyway: for fuel, for tyres, for the driver or by the plan.
    const fuelShort = refuel && car.fuel < left * m.fuelPerLap * car.burn * 1.02;
    const tyresShort = car.wear + left * wearPerLap(m, car.compound, car.driver.tyreWear) > 1.3;
    const crew = car.entrant.drivers.length > 1 && r.pit.driverStint > 0;
    const driverShort = crew && this.t - car.driverSince + left * lapTime > r.pit.driverStint * 1.05;
    if (!fuelShort && !tyresShort && !driverShort && car.nextStopLap === null) return false;
    const due = car.nextStopLap !== null && car.nextStopLap - lap <= Math.max(2, 0.4 * stint);
    const worn = car.wear > 0.5 && tyresShort;
    const fuel = fuelShort && car.fuel < 0.5 * r.fuel.capacity;
    const driver = driverShort && this.t - car.driverSince > 0.6 * r.pit.driverStint;
    if (!due && !worn && !fuel && !driver) return false;
    return this.controlRng() < (this.phase === 'sc' ? 0.85 : 0.6);
  }

  /**
   * The tyre type to change to for the conditions over the next laps (what
   * the team sees on the radar), when the time it gains outweighs a stop;
   * teams weigh it a little differently. Null to stay out.
   */
  private weatherCall(car: RaceCar, left: number): TyreType | null {
    const types = car.cls.types;
    if (types.length < 2 || !car.model.pit) return null;
    const m = car.model;
    const lap = m.lapTime;
    const ahead = wetnessAhead(this.weather, this.t + 0.3 * lap, this.t + 2.5 * lap);
    const best = bestTyreType(ahead, types);
    const now = car.tyreType;
    if (best === now) return null;
    // Wet tyres on a drying track overheat and wear out, costing more than their pace alone.
    const overheat = wearFactor(now, ahead) > 2.5 ? 0.02 : 0;
    // Slicks on a wet track also risk a crash.
    const danger = now === 'slick' && ahead > 0.3 ? 1.5 : 1;
    const lapCost = (type: TyreType) => lapRatioAtGrip(m, gripFactor(type, ahead)) * (1 + aquaplaning(type, ahead));
    const gain = (lapCost(now) + overheat - lapCost(best)) * danger;
    const horizon = Math.min(left - 1, 8);
    const cost = (car.rules.pit.stops ? stopCost(m) : (m.pit?.driveThroughLoss ?? 20) + WEATHER_SWAP) * (0.6 + 0.8 * car.rng());
    return gain * lap * horizon > cost ? best : null;
  }

  private enterPit(car: RaceCar, u: number, t: number): void {
    const pit = car.model.pit!;
    this.accrue(car, u);
    const box = pit.boxFrom + ((car.entrant.teamIndex + 0.5) / this.teams) * (pit.boxTo - pit.boxFrom);
    // The car ahead in the class, if close, now faces the undercut.
    const ahead = car.cls.order[car.classPosition - 2];
    const iv = ahead ? this.gapBetween(car, ahead) : null;
    if (ahead && ahead.status === 'running' && iv?.kind === 'time' && iv.value < 3) ahead.threatLap = car.lapsDone + 1;
    const service = this.planService(car, car.pitRequest ?? 'plan');
    const record: PitStopRecord = {
      car: car.id, lap: car.lapsDone + 1, entry: t, exit: NaN, stationary: NaN,
      from: car.compound, to: service.compound, fuel: service.fuel, driver: service.driver, reason: service.reason,
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

  /** What the crew does: tyres (which compound, for the conditions), fuel, a driver change, and how long it takes. */
  private planService(car: RaceCar, reason: string): Service {
    const m = car.model;
    const r = car.rules;
    const left = this.lapsLeft(car);
    const type = car.wantType ?? bestTyreType(wetnessAhead(this.weather, this.t, this.t + 2 * m.lapTime), car.cls.types);
    car.wantType = null;
    const tyreWear = car.driver.tyreWear;
    if (!r.pit.stops) {
      const compound = type === 'slick' ? pickCompound(m, left, tyreWear, car.used, true) : compoundOfType(r, type);
      return { compound, fuel: 0, time: Math.max(r.pit.tyreChange, WEATHER_SWAP), reason, driver: null };
    }
    let compound: number | null;
    let fuel = 0;
    let stint = left;
    if (r.fuel.refuelRate > 0) {
      const needed = left * m.fuelPerLap * 1.02 + 0.5 * m.fuelPerLap - car.fuel;
      fuel = Math.max(0, Math.min(r.fuel.capacity - car.fuel, needed));
      stint = Math.min(left, (car.fuel + fuel) / m.fuelPerLap);
      const lastSet = car.fuel + fuel >= left * m.fuelPerLap;
      if (type !== 'slick') {
        compound = type !== car.tyreType || car.wear > 0.6 ? compoundOfType(r, type) : null;
      } else {
        const wpl = wearPerLap(m, car.compound, tyreWear);
        const mustSwitch = needsSecondCompound(r, car.used) && lastSet;
        compound = car.tyreType !== 'slick' || car.wear + stint * wpl > 0.9 || mustSwitch ? pickCompound(m, stint, tyreWear, car.used, lastSet) : null;
      }
    } else if (type !== 'slick') {
      compound = compoundOfType(r, type);
    } else {
      const plan = planStrategy({
        model: m, tyreFactor: tyreWear, laps: left, compound: null, wear: 0, used: car.used, stopsDone: car.stops + 1, canStop: true,
      });
      compound = plan.stints[0].compound;
      stint = plan.stints[0].laps;
    }
    const driver = this.nextDriver(car, stint * this.expectedLap(car));
    const tyreT = compound !== null ? r.pit.tyreChange * (1 + 0.08 * gauss(car.rng)) : 0;
    const fuelT = r.fuel.refuelRate > 0 ? fuel / r.fuel.refuelRate : 0;
    const driverT = driver !== null ? r.pit.driverChange : 0;
    // A driver change happens while refuelling; tyres either at the same time or afterwards.
    let time = r.pit.concurrent ? Math.max(tyreT, fuelT, driverT) : Math.max(fuelT, driverT) + tyreT;
    if (car.stops < r.pit.minStops) time = Math.max(time, r.pit.minStationary);
    if (compound !== null && car.rng() < 0.04) time += 2 + 6 * car.rng();
    return { compound, fuel, time: Math.max(0.8, time), reason, driver };
  }

  /**
   * The driver to take over, or null to stay in: a crew changes when the
   * driver in the car would pass the class's longest stint before the next
   * stop, and hands over to whoever has driven least.
   */
  private nextDriver(car: RaceCar, nextStint: number): number | null {
    const crew = car.entrant.drivers;
    const limit = car.rules.pit.driverStint;
    if (crew.length < 2 || limit <= 0) return null;
    const inCar = this.t - car.driverSince;
    if (inCar + nextStint <= limit * 1.05) return null;
    const totals = this.driveTimes(car);
    let best = -1;
    for (let i = 0; i < crew.length; i++) if (i !== car.driverIndex && (best < 0 || totals[i] < totals[best])) best = i;
    return best;
  }

  private finishService(car: RaceCar, t: number): void {
    const s = car.pit!.service;
    car.pit!.record.stationary = t - car.pit!.stopStart;
    const lap = car.lapsDone + 1;
    const r = car.rules;
    const old = r.tyres.compounds[car.compound];
    if (s.compound !== null) {
      car.compound = s.compound;
      car.tyreType = r.tyres.compounds[s.compound].type;
      car.wear = 0;
      car.tyreLaps = 0;
      car.used |= 1 << s.compound;
    }
    let change = '';
    if (s.driver !== null) {
      car.driveTime[car.driverIndex] += t - car.driverSince;
      car.driverIndex = s.driver;
      car.driverSince = t;
      change = `, ${car.driver.name} takes over`;
    }
    car.fuel += s.fuel;
    car.stops++;
    car.lastStopLap = lap;
    car.pitRequest = null;
    const tyres = s.compound !== null ? `${old.name} → ${r.tyres.compounds[s.compound].name}` : 'no tyres';
    const fuel = s.fuel > 0 ? `, ${Math.round(s.fuel)} kg fuel` : '';
    this.log('pit', t, `${car.entrant.code} pits: ${tyres}${fuel}${change}, ${s.time.toFixed(1)} s`, car.id, lap);
    if (r.fuel.refuelRate <= 0 && r.pit.stops) {
      if (car.tyreType !== 'slick') {
        car.plan = [];
        car.nextStopLap = null;
        return;
      }
      const left = this.lapsLeft(car);
      const plan = planStrategy({
        model: car.model, tyreFactor: car.driver.tyreWear, laps: left, compound: car.compound, wear: car.wear, used: car.used, stopsDone: car.stops, canStop: true,
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

  private attemptPass(car: RaceCar, u: number, t: number, k: number, zoneIndex: number): void {
    // No passing under yellows, a neutralisation or before the line after a restart.
    if (this.phase !== 'green' || this.yellowAt[k] || u < car.holdUntilU) return;
    if (u < car.cooldownU || car.passing || car.offTrack || car.exitUntilU > car.u || car.pitRequest) return;
    const near = this.nearestAhead(car);
    if (!near) return;
    const def = near.car;
    const gapT = near.d / Math.max(car.v, 20);
    if (gapT > 0.6 || def.passing?.target === car || !this.blocks(def, car)) return;
    const lapping = car.u > def.u;
    // A car of a faster class comes up behind a slower one: it gets by like a leader lapping a backmarker.
    const traffic = !lapping && def.cls !== car.cls && car.cls.model.lapTime < def.cls.model.lapTime;
    let p: number;
    let skill = 1;
    if (lapping || traffic) p = lapping ? 0.9 : 0.85;
    else {
      const zone = car.model.zones[zoneIndex];
      // Compare speeds at the same braking point: the defender has usually started braking already.
      const defV = def.zone && def.zone.index === zoneIndex && def.cls === car.cls && t - def.zone.t < 2 ? def.zone.v : def.v;
      const speedAdv = car.v / Math.max(defV, 1) - 1;
      const paceAdv = (def.lapPace - car.lapPace) / def.lapPace;
      const adv = speedAdv + 2 * paceAdv;
      skill = 0.75 + 0.5 * (car.driver.racecraft - def.driver.racecraft);
      // Closer is better: full chance within 0.3 s, falling to 40% at 0.6 s.
      const reach = 1 - 0.6 * clamp01((gapT - 0.3) / 0.3);
      p = zone.quality * car.rules.pace.overtaking * clamp01((adv - 0.015) / 0.07) * skill * reach;
      if (car.lapsDone === 0) p *= 1.3;
      p = Math.min(0.8, p);
    }
    if (p < 0.02) return;
    car.cooldownU = u + 150 / this.ds;
    if (this.rng() < p) {
      car.passing = { target: def, untilU: car.u + 250 / this.ds };
      def.delay += lapping || traffic ? 0.3 : 0.25;
      def.delayShare = Math.max(def.delayShare, 0.35);
      return;
    }
    if (lapping || traffic) return;
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
      this.trackIncident(victim.u, 'crash', this.t);
    } else {
      this.log('contact', this.t, `Contact between ${a.entrant.code} and ${b.entrant.code}${where}`, a.id, lap, b.id);
      this.trackIncident(a.u, 'contact', this.t);
    }
  }

  private detectDrs(car: RaceCar, u: number, t: number, region: number): void {
    const drs = car.rules.drs;
    if (!drs || region < 0) return;
    // Shut under a neutralisation and on a wet track.
    if (this.phase === 'green' && this.wetness <= DRS_WET) {
      const near = this.nearestAhead(car);
      const gap = near ? t - near.car.drsCross[region] : Infinity;
      if (car.lapsDone + 1 >= drs.fromLap && gap >= 0 && gap <= drs.gap) car.drsUntilU = u + car.model.drs[region].length;
    }
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
      if (car.cls === def.cls && car.u > def.u && car.u - def.u < this.n / 2) {
        // A real overtake in the class, not a leader lapping a backmarker.
        const where = this.where(car.u - 60 / this.ds);
        const text = this.multiClass
          ? `${car.entrant.code} passes ${def.entrant.code} for ${car.cls.label} P${def.classPosition}${where}`
          : `${car.entrant.code} passes ${def.entrant.code} for P${def.position}${where}`;
        this.log('overtake', this.t, text, car.id, car.lapsDone + 1, def.id);
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
    this.updateClassOrder();
  }

  private updateClassOrder(): void {
    if (this.classes.length === 1) {
      const cls = this.classes[0];
      cls.order = this.order;
      for (const c of this.order) c.classPosition = c.position;
      return;
    }
    for (const cls of this.classes) cls.order = [];
    for (const c of this.order) {
      c.cls.order.push(c);
      c.classPosition = c.cls.order.length;
    }
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
