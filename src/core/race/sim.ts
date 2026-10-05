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
 * A car cannot drive through the one ahead. In a race of cars every car has
 * a place across the road as well (metres left of the racing line) and a
 * width: it is held a small gap behind a car in its way, and goes by one
 * that is not. A car held up pulls out when it has the pace and the room to
 * draw level before the road bends, and on the inside of a braking zone it
 * may brake later to get there; the car ahead may move over once to shut
 * the inside, which leaves the outside. Side by side, each keeps to its
 * side until one is clear, and through a corner a car off the racing line
 * can only do what its own line allows (lanes.ts), so the one with the
 * better line comes out ahead. Moving over in front of another car takes a
 * hole, and a corner takes two abreast: so the field leaves the grid in
 * files, fans out as the starts go and funnels into the first corners by
 * the room there is. A car being lapped moves over. Bikes still race in
 * one line: a bike is held behind the one ahead until a braking zone, where
 * it may try to pass, with a chance from the speed and pace difference, the
 * zone and both riders' racecraft. Cars stop in the actual pit lane at the
 * speed limit, for tyres, fuel, a driver change or a change of weather.
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
import { EDGE_GAP, LEFT, RIGHT, SIDE_GAP } from './lanes.ts';
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
/** Race control: racing, neutralised by a safety car, a virtual safety car or a full course yellow, or stopped by a red flag. */
export type FlagPhase = 'green' | 'sc' | 'vsc' | 'fcy' | 'red';

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
  /** In a session: an out lap, a push lap, a cool-down lap, a long-run lap or an in lap (only the middle three are timed). */
  kind?: LapKind;
}

export type LapKind = 'out' | 'push' | 'cool' | 'long' | 'in';

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

/** A period under a safety car, virtual safety car or full course yellow, or stopped by a red flag. */
export interface Neutralisation {
  kind: 'sc' | 'vsc' | 'fcy' | 'red';
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

export interface PitState {
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

export interface Service {
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
  /** The braking zone a car at each station is coming to (from LUNGE_FROM metres before its braking point) or in (up to its slowest point); -1: none. */
  readonly brakingAt: Int16Array;
  /** The braking zone whose braking point comes next from each station; -1: the lap has none. */
  readonly nextZone: Int16Array;
  readonly drsAt: Int16Array;
  /** Fuel carried on the qualifying lap: the race lap's fuel effect counts only above it. */
  readonly qualiFuel: number;
  /** Half the car's width, and its length, metres. */
  readonly half: number;
  readonly length: number;
  finishers = 0;

  constructor(index: number, model: RaceModel) {
    this.index = index;
    this.model = model;
    this.rules = model.rules;
    this.types = tyreTypes(model.rules);
    this.zoneAt = new Int16Array(model.n).fill(-1);
    model.zones.forEach((z, i) => { this.zoneAt[z.station] = i; });
    this.nextZone = new Int16Array(model.n).fill(-1);
    model.zones.forEach((z, i) => {
      const from = model.zones[(i - 1 + model.zones.length) % model.zones.length].station;
      for (let k = (from + 1) % model.n; ; k = (k + 1) % model.n) {
        this.nextZone[k] = i;
        if (k === z.station) break;
      }
    });
    this.brakingAt = new Int16Array(model.n).fill(-1);
    const before = Math.round(LUNGE_FROM / model.track.ds);
    model.zones.forEach((z, i) => {
      for (let k = (z.station - before + model.n) % model.n; k !== z.apex; k = (k + 1) % model.n) this.brakingAt[k] = i;
    });
    this.drsAt = new Int16Array(model.n).fill(-1);
    model.drs.forEach((d, i) => { this.drsAt[d.start] = i; });
    this.qualiFuel = Math.min(model.rules.fuel.capacity, 3 * model.fuelPerLap);
    this.half = model.body.width / 2;
    this.length = model.body.length;
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
  /**
   * Sideways offset from the racing line, metres (positive left), now and at
   * the step before: the car's real place on the road in a race of cars
   * (lanes), only how it is drawn otherwise.
   */
  lateral = 0;
  prevLateral = 0;
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
  // Lanes (a race of cars; see updateLanes):
  /** The car ahead that holds it up, when it is close enough to think of passing it. */
  heldBy: RaceCar | null = null;
  /** The car it has pulled out to pass and on which side (+1 its left), until it is beside it, or gives up at `untilU`. */
  attack: { target: RaceCar; side: 1 | -1; untilU: number; answered?: boolean } | null = null;
  /** Defending: it has moved over to shut this side of the road (+1 its left) until this race progress (-Infinity when not). */
  coverSide: 1 | -1 = 1;
  coverUntilU = -Infinity;
  /** Race time before which it does not look for a way past again. */
  nextTry = 0;
  /** Braking late to get beside the car it is passing: until this race progress (-Infinity when not). */
  lungeUntilU = -Infinity;
  lungePace = 1;
  /** The car beside it that has the right to the road it is on: it has to drop back. */
  squeezed: RaceCar | null = null;
  /** Cars beside it that it came up on from behind, with the place each held: clear ahead of one is a pass. */
  beside: { car: RaceCar; place: number; classPlace: number }[] = [];
  /** The side it has moved to for a faster car to come by (+1 its left; 0 when not giving way), and that car. */
  giveWay: 0 | 1 | -1 = 0;
  giveWayTo: RaceCar | null = null;
  /** Held below the racing line's speed by its own line through a corner, in this step. */
  capped = false;
  /** The part of the road it has with a car beside it: 1 the left, -1 the right, 2 the middle of three; 0 with nobody beside it. */
  lane: 0 | 1 | -1 | 2 = 0;
  /** Speed over the road where it is across it, m/s (`v` is its progress in stations, at the lap's average station length). */
  ground = 0;
  /** Cars beside it now (bodies overlapping along the road): bit 1 one on its left, bit 2 one on its right. */
  flank = 0;
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
  /** How far into its garage the car stands, 0 (in the pit lane) to 1, now and at the step before (sessions). */
  garage = 0;
  prevGarage = 0;
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
/** A car in its garage stands this far beyond the edge of the pit lane (metres). */
const GARAGE_DEPTH = 5;
/** Laps by any car over which rubber builds up most of the way (1 - 1/e) on a green track. */
const RUBBER_LAPS = 400;
/** Seconds of heavy rain that wash most of the rubber away. */
const RUBBER_WASH = 900;
/**
 * Red flags: the chance a crash stops the race (more where it happened at
 * speed, less for bikes, which leave no wreck across the track), or a car
 * stopped where it cannot be moved; rain too heavy to race in, and the
 * longest a race waits before it is called off.
 */
const RED_CRASH = { car: [0.08, 0.22], bike: [0.02, 0.08] } as const;
const RED_STOPPED = 0.02;
const RED_RAIN = 0.85;
const RED_RAIN_EASED = 0.5;
const RED_LONGEST = 3600;
/**
 * A car closer than the following gap to the one ahead drops back at this
 * share of that car's speed, so the gap opens over a second or two, and
 * never comes closer to it than CLOSEST metres along the lap.
 */
const CLOSE_UP = 0.92;
const CLOSEST = 0.5;
/** In lanes: the share of the speed of the car ahead a car inside the following gap does, just inside it and right up behind it (NOSE_TO_TAIL metres between them). */
const EASE_OFF = 0.99;
const EASE_MOST = 0.9;
const NOSE_TO_TAIL = 0.3;
/** On the run from the grid to the first corner, cars run at most this many abreast. */
const ABREAST = 3;
/**
 * Lanes. Two cars count as side by side when they overlap nose to tail or
 * come within ALONG_GAP metres of it; a car has the right to its line over
 * one beside it once it is LEVEL metres ahead (the other is no longer
 * "significantly alongside"), and blocks a car behind unless that car has
 * room to go by (SLACK less than the room side by side takes, so two cars
 * running together do not block each other by a rounding error).
 */
const ALONG_GAP = 1;
const LEVEL = 2;
const SLACK = 0.15;
/**
 * Moving over in front of a car in the next lane takes a hole: that car a
 * car's length and MERGE_GAP of a following gap behind. Until then both keep
 * to their side of the road, through corners too (two files through a
 * corner, not one car cutting across the nose of the next).
 */
const MERGE_GAP = 0.3;
/** A car within this of the racing line (metres) is on it. */
const ON_LINE = 0.3;
/** Sideways speed at most: metres per second, and as a share of the car's own speed (off the grid at least AWAY_SIDEWAYS once it is rolling). */
const SIDEWAYS = 3.5;
const SIDEWAYS_SLOPE = 0.1;
const AWAY_SIDEWAYS = 2;
/** Slipstream: full within TOW_FULL metres to the side of the car ahead, none beyond TOW_REACH; the speed gained in a tow fades over TOW_HOLD seconds out of it. */
const TOW_FULL = 1;
const TOW_REACH = 3;
const TOW_HOLD = 5;
/** The middle car of three abreast does this share of the slower lane's pace through a corner. */
const MIDDLE = 0.96;
/** A car off the racing line with nobody beside it pays this share of what the lane costs. */
const ALONE = 0.5;
/** Cars side by side make for the racing line when a corner is this near (metres); before it each holds its side. */
const CORNER_LOOK = 60;
/** A car beside one with the right to the road lifts to this share of that car's speed until it is clear behind. */
const BACK_OUT = 0.88;
/**
 * Pulling out to pass: a car held up weighs its pace over the next
 * ATTACK_LOOK metres off the line against the car ahead's every TRY_EVERY
 * seconds, and goes when it is at least ATTACK_MIN quicker and that pace,
 * kept up for ATTACK_KEEP of the run to where the road bends, would bring
 * it level with the other car, counting what braking later adds on the
 * inside (a bolder driver needs less). It gives up ATTACK_RUN metres on if
 * it is not beside the other car by then, or once that car is ATTACK_LOST
 * metres up the road, and waits TRY_AGAIN seconds. A car just ahead of the
 * one it wants to pass, on the side it would take, boxes it in (BOXED_IN metres).
 */
const ATTACK_LOOK = 150;
/** A car pulls out to a side only if the road has room for it there over the next RUN_ROOM metres of its run, bar RUN_GIVE metres. */
const RUN_ROOM = 250;
const RUN_GIVE = 1;
/** A car counts as held up by one it would catch within this many seconds. */
const CLOSING_LOOK = 1.5;
const TRY_EVERY = 0.3;
const TRY_AGAIN = 2.5;
const ATTACK_MIN = 0.006;
const ATTACK_KEEP = 0.7;
const ATTACK_RUN = 500;
const ATTACK_LOST = 60;
const BOXED_IN = 25;
/**
 * Into a corner beside another car. A car that has pulled out and is not
 * beside the other yet when the corner comes stays out there only if it
 * will be within LEVEL metres of level where the corner begins, which is
 * what gives it the right to its side of the road: by the speed it is
 * closing at, and on the inside of a braking zone by braking later.
 * LUNGE_LATE metres later for a driver of middling racecraft (half that to
 * half as much again), which brings it forward by that distance times the
 * share of its speed the corner takes: a hairpin after a straight gives
 * most of it, a fast bend nearly nothing. A car right behind another may
 * dive for the inside the same way, from LUNGE_FROM metres before the
 * braking point. Otherwise it falls back in line. If it went and did not
 * get beside the other car after all it has overdone it, and loses
 * LUNGE_MISSED seconds.
 */
/**
 * Defending. A car that sees another pull out for the inside of a braking
 * zone that is DEFEND_LOOK metres or less ahead (and no nearer than
 * DEFEND_LATE: it may not move under braking, nor once the other is beside
 * it; a zone that takes at least DEFEND_DROP of its speed, not a lift in a
 * fast bend) moves over once, far enough that a car no longer fits on that side by
 * COVER_SHORT metres, and stays there to the corner's slowest point. It
 * takes the corner from there, off the racing line, which costs it speed
 * out of it; the other car has the outside. Whether it sees it in time goes
 * by its racecraft: a chance of COVER_LEAST, and COVER_SKILL more for the best.
 */
const DEFEND_LOOK = 400;
const DEFEND_LATE = 60;
const DEFEND_DROP = 0.2;
const COVER_SHORT = 0.3;
const COVER_LEAST = 0.3;
const COVER_SKILL = 0.6;
const LUNGE_LATE = 8;
const LUNGE_FROM = 120;
/** A dive from right behind is made no later than this many metres past the braking point. */
const DIVE_LATEST = 20;
const LUNGE_MISSED = 0.25;
/**
 * Off the grid a car goes round a slower starter wherever there is room,
 * without weighing its pace as it does later in the race (the launch decides
 * that), until AWAY_UNTIL metres before the first corner. From there, and
 * for the rest of the race, the same rules hold as everywhere.
 */
const AWAY_UNTIL = 200;
/** Dirty air in lanes: all of the downforce loss within WAKE_FULL seconds of the car ahead, none beyond WAKE_REACH, falling away with the square in between. */
const WAKE_FULL = 0.2;
const WAKE_REACH = 1;
/** A car being lapped moves this far off the racing line (metres) and lifts this much, from when the faster car is this many seconds behind. */
const GIVE_WAY_ASIDE = 2.6;
const GIVE_WAY_LIFT = 0.06;
const GIVE_WAY_GAP = 1.2;
/** Cars queue at the pit exit this far apart (metres) behind the first, which stops this far short of the end of the speed limit. */
const QUEUE_GAP = 8;
const QUEUE_FRONT = 10;
/** Seconds between cars released from the queue, and the longest the field takes to form up on the grid before the lights. */
const RELEASE_GAP = 1.5;
const FORM_UP = 120;
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
  /** Rubber on the racing line, 0 (a green track) to 1 (fully rubbered in): laid down lap by lap, washed away by rain. */
  rubber = 1;
  /**
   * A red flag: since when and why, when the race (or session) resumes
   * (Infinity while it rains too hard), and the order of the cars when it
   * came out, for the restart and a result if it never does.
   */
  red: { from: number; resumeAt: number; reason: string; order: number[]; rain: boolean; lap: number } | null = null;
  /** Seconds the race has stood under red flags. */
  suspended = 0;
  /** After a red flag: the restart to come (behind the safety car, or a standing start once the field has formed up). */
  restart: 'rolling' | 'standing' | null = null;
  /**
   * Cars stopping in slots on track: forming up for a standing restart (each
   * car's grid slot as race progress, its place across the track, and when
   * the lights go out once all have stopped; NaN until then), or stopped in
   * single file under a red flag (lights Infinity).
   */
  regrid: { slots: Map<number, number>; lateral: Map<number, number>; since: number; lights: number } | null = null;

  protected readonly n: number;
  protected readonly ds: number;
  protected readonly lineDs: Float64Array;
  /**
   * Metres along the racing line from the start line to each station (the
   * lap's length at the end), and how far the line has turned by then
   * (radians, a right-hander positive): a car `y` metres left of the line
   * covers `y` times the turn more road than the line does.
   */
  private readonly lineCum: Float64Array;
  private readonly lineTurn: Float64Array;
  private readonly mark: Uint16Array;
  /** Racing-line distance over which the speed trap measures. */
  private readonly trapBase: number;
  protected readonly rng: () => number;
  /** Race control's own random stream, so the flags do not change the cars' draws. */
  protected readonly controlRng: () => number;
  private readonly baseLimit: number | null;
  /** Race progress where the cars left the pit lane after a red flag with no safety car to lead them. */
  private releaseU = NaN;
  /** Cars that have joined the queue at the pit exit under the red flag. */
  private queued = 0;
  protected readonly weather: Weather;
  protected readonly teams: number;
  /** Team-mates share a pit box, so one waits for the other (not in a session, where each car has a garage). */
  protected sharedBoxes = true;
  protected trackOrder: RaceCar[] = [];
  private finishCount = 0;
  /** Whether cars have a real place across the road and race side by side (every class is cars), or run in one line (bikes). */
  readonly lanes: boolean;
  /** Scratch space for updateLanes: each car's sideways limits and next position, who squeezes it, and the pairs side by side. */
  private laneLo = new Float64Array(0);
  private laneHi = new Float64Array(0);
  private laneNext = new Float64Array(0);
  private laneSqueezed = new Int32Array(0);
  private lanePairs: number[] = [];
  private laneNear: number[] = [];
  private laneLinks: number[] = [];
  /** Race progress of the first corner (or braking zone) on lap 1; until then places change hands as the starts go (bikes run up to ABREAST wide). */
  private readonly firstZoneU: number;
  /** The side of the track the pit lane is on, as a left-normal sign. */
  readonly pitSide: number;
  protected readonly yellowAt: Uint8Array;
  /** The safety car's time per segment, and the station where it leaves the track. */
  private readonly scSeg: Float64Array;
  private readonly scExit: number;
  protected phaseSince = 0;
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
    this.lineCum = new Float64Array(m.n + 1);
    this.lineTurn = new Float64Array(m.n + 1);
    for (let k = 0; k < m.n; k++) {
      this.lineCum[k + 1] = this.lineCum[k] + this.lineDs[k];
      this.lineTurn[k + 1] = this.lineTurn[k] + m.line.curvature[k] * this.lineDs[k];
    }
    this.rng = seededRandom(`${setup.settings.seed}:race`);
    this.controlRng = seededRandom(`${setup.settings.seed}:control`);
    this.baseLimit = setup.duration ?? setup.timeLimit;
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
    this.lanes = this.classes.every((c) => c.model.vehicle.kind === 'car');
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

    // Cars sort themselves into line at the first corner, or the first heavy braking before it.
    this.firstZoneU = Math.min(m.zones.length ? m.zones[0].station : Math.round(n / 4), m.firstCorner >= 0 ? m.firstCorner : Infinity);
    this.pitSide = pitSide(m);
    this.cars = setup.entrants.map((e) => new RaceCar(e, this.classes[e.classIndex], m.samples, setup.settings.seed));
    for (const car of this.cars) car.cls.cars.push(car);
    this.teams = Math.max(1, ...setup.entrants.map((e) => e.teamIndex + 1));
    this.rubber = setup.rubber ?? 1;
    // A session puts its cars in the garages itself (see session.ts).
    if (setup.session) {
      this.order = [...this.cars];
      this.updateClassOrder();
      this.updateConditions(0);
      return;
    }

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
      car.prevLateral = g.lateral;
      const d = car.driver;
      if (rolling) {
        // Already moving in formation: the start is how well each driver times the throttle.
        car.launch = { u: g.u, from: ROLLING_SPEED, factor: 0.97 + 0.03 * d.launch };
        car.v = ROLLING_SPEED;
        car.ground = ROLLING_SPEED;
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
    // Race control may have called the race off.
    if (this.finished) return;
    const track = this.cars.filter((c) => c.status === 'running');
    track.sort((a, b) => mod(b.u, n) - mod(a.u, n));
    track.forEach((c, i) => { c.trackIndex = i; });
    this.trackOrder = track;

    // Slipstream and wake from the car directly ahead.
    const N = track.length;
    for (let i = 0; i < N; i++) {
      const car = track[i];
      let tow = 0;
      car.wake = 0;
      for (let s = 1; s < Math.min(N, this.lanes ? 6 : 4); s++) {
        const a = track[(i - s + N) % N];
        if (a.offTrack) continue;
        const gapT = (mod(a.u - car.u, n) * this.ds) / Math.max(car.v, 20);
        // In lanes only a car on the same piece of road gives a tow: failing that, the next one ahead may.
        const share = this.lanes ? clamp01((TOW_REACH - Math.abs(a.lateral - car.lateral)) / (TOW_REACH - TOW_FULL)) : 1;
        if (share <= 0 && gapT < 1.6) continue;
        // (In lanes the hole in the air closes quickly with distance: most of the tow and of the wake is gone half a second back.)
        const pull = clamp01((1 - gapT) / 0.7);
        const near = clamp01((WAKE_REACH - gapT) / (WAKE_REACH - WAKE_FULL));
        tow = (this.lanes ? pull * pull : pull) * share;
        car.wake = (this.lanes ? near * near : clamp01((1.6 - gapT) / 1.2)) * share;
        break;
      }
      // A car that pulls out of a tow keeps the speed it gained for a few seconds.
      car.tow = this.lanes ? Math.max(tow, car.tow - DT / TOW_HOLD) : tow;
    }
    if (this.lanes) for (const car of track) this.considerPass(car, t0);

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
    for (const car of this.cars) car.prevLateral = car.lateral;
    if (this.lanes) this.updateLanes();
    else {
      this.resolvePasses();
      this.updateLateral();
    }
    this.updateOrder();
    this.checkFinished();
  }

  /** Over when every car has finished or retired; a race cannot run on for ever. */
  protected checkFinished(): void {
    if (this.cars.every((c) => c.status === 'finished' || c.status === 'retired')) this.finished = true;
    const expected = (this.limit ?? (this.setup.laps ?? 1) * this.model.lapTime * 1.2) * 3 + 600;
    if (this.t > expected) this.finished = true;
  }

  /** The race's time limit (or its duration) in race time: later by the time stood under red flags where the clock stops for them. */
  get limit(): number | null {
    if (this.baseLimit === null) return null;
    const stops = this.model.rules.weekend.redFlag.raceClockStops;
    return this.baseLimit + (stops ? this.suspended + (this.red ? this.t - this.red.from : 0) : 0);
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

  protected gapBetween(car: RaceCar, ref: RaceCar): Gap {
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
      const pit = this.model.pit;
      const p = car.pit.prevP + (car.pit.p - car.pit.prevP) * alpha;
      const at = pathPoint(pit.x, pit.y, pit.cum, p);
      const g = car.prevGarage + (car.garage - car.prevGarage) * alpha;
      if (g <= 0) return at;
      // Pushed back into its garage beyond the lane, turning to face the lane.
      const off = g * (pit.width / 2 + GARAGE_DEPTH) * pit.side;
      return { x: at.x + Math.sin(at.heading) * off, y: at.y - Math.cos(at.heading) * off, heading: at.heading + (pit.side * Math.PI * g) / 2 };
    }
    const u = car.prevU + (car.u - car.prevU) * alpha;
    const p = this.linePoint(u, car.prevLateral + (car.lateral - car.prevLateral) * alpha);
    // Moving across the road, the car points where it goes (its left is anticlockwise on the map).
    const along = ((car.u - car.prevU) * this.model.line.length) / this.n;
    if (along > 0.05) p.heading -= Math.atan2(car.lateral - car.prevLateral, along);
    return p;
  }

  /** Where the safety car is, or null when it is not out. */
  safetyCarPose(alpha: number): { x: number; y: number; heading: number } | null {
    const sc = this.safetyCar;
    if (!sc) return null;
    return this.linePoint(sc.prevU + (sc.u - sc.prevU) * alpha, 0);
  }

  protected linePoint(u: number, lateral: number): { x: number; y: number; heading: number } {
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
    const moved = ((car.u - startU) * this.model.line.length) / this.n;
    if (car.status === 'running') {
      car.v = moved / DT;
      car.ground = this.road(startU, car.u, car.lateral) / DT;
    }
    if (car.capped) {
      car.capped = false;
      if (car.status === 'running') {
        // Slower than the racing line through a corner, on its own line: it accelerates away from the speed it has
        // (while it moves: time lost to a mistake is not speed lost), unless it is pulling away already.
        // Its speed along the racing line, in the metres the line really covers there: through a corner a station of
        // the line is not the lap's average length (where it cuts across the road it is longer, round an apex far
        // shorter), and a speed taken from stations alone would come back as a lower limit every step.
        const speed = (this.lineAt(car.u) - this.lineAt(startU)) / budget;
        const l = car.launch;
        // (As fast as that curve allowed where the step began: within a station the speed does not rise.)
        const pulling = l !== null && speed >= 0.97 * l.factor * launchSpeed(car.model.launch, l.from, Math.max(0, this.lineAt(startU) - this.lineAt(l.u)));
        if (!pulling) car.launch = { u: car.u, from: speed, factor: 1 };
      }
    }
  }

  /** Metres along the racing line from the start line to race progress `u`. */
  private lineAt(u: number): number {
    const lap = Math.floor(u / this.n);
    const x = u - lap * this.n;
    const k = Math.min(this.n - 1, Math.floor(x));
    return lap * this.lineCum[this.n] + this.lineCum[k] + (x - k) * this.lineDs[k];
  }

  /**
   * Metres of road from race progress `u0` to `u1` for a car `lateral`
   * metres left of the racing line. Stations are counted along the middle
   * of the track, so round a tight corner they are far apart on the outside
   * and close together on the inside: cars follow each other by this, not
   * by stations.
   */
  private road(u0: number, u1: number, lateral: number): number {
    return this.lineAt(u1) - this.lineAt(u0) + lateral * (this.turnAt(u1) - this.turnAt(u0));
  }

  private turnAt(u: number): number {
    const lap = Math.floor(u / this.n);
    const x = u - lap * this.n;
    const k = Math.min(this.n - 1, Math.floor(x));
    return lap * this.lineTurn[this.n] + this.lineTurn[k] + (x - k) * (this.lineTurn[k + 1] - this.lineTurn[k]);
  }

  /** Race progress `metres` of road on from `u`, for a car `lateral` metres left of the racing line. */
  private onward(u: number, metres: number, lateral: number): number {
    const n = this.n;
    const curvature = this.model.line.curvature;
    let left = metres;
    let at = u;
    for (let guard = 0; left > 1e-9 && guard < 400; guard++) {
      const fl = Math.floor(at);
      const k = mod(fl, n);
      // (Never less than a fifth of the line's own: a car right inside a hairpin still has road to cover.)
      const per = this.lineDs[k] * Math.max(0.2, 1 + curvature[k] * lateral);
      const room = (fl + 1 - at) * per;
      if (room >= left) return at + left / per;
      left -= room;
      at = fl + 1;
    }
    return at;
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
    if (this.lanes) {
      const lat = car.lateral;
      let pace = 1;
      if (car.lungeUntilU > u) {
        // Braking late for the inside: further along than its line allows, by the corner's slowest point (never beyond the car's top speed).
        s = Math.min(s, Math.max(s * car.lungePace, this.lineDs[k] / m.vehicle.topSpeed));
      } else if (car.lane !== 0) {
        // A car beside it: it has its side of the road only, from the braking point on (the middle of three, the worse of both).
        pace = car.lane === 2 ? MIDDLE * Math.min(m.laneCap[LEFT][k], m.laneCap[RIGHT][k]) : m.laneCap[car.lane > 0 ? LEFT : RIGHT][k];
      } else if (lat > ON_LINE || lat < -ON_LINE) {
        // Alone off the racing line where a corner holds that side: its share of what the lane's own line costs
        // here, less than a car kept to the lane pays (it has the rest of the road to use).
        const lane = lat > 0 ? LEFT : RIGHT;
        const held = m.laneCap[lane][k];
        if (held < 1) pace = 1 - ALONE * Math.min(1, Math.abs(lat) / Math.max(1, Math.abs(m.laneShift[lane][k]))) * (1 - held);
      }
      if (pace < 1) {
        s /= Math.max(0.4, pace);
        car.capped = true;
      }
      if (car.giveWay !== 0) s *= 1 + GIVE_WAY_LIFT;
    }
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
      const d = this.lineAt(u) - this.lineAt(car.launch.u);
      cap = launchSpeed(m.launch, car.launch.from, d) * car.launch.factor;
      // Up to speed again (in lanes a car pulls away out of every corner it took off the line, so this is not kept for 3 km).
      if (!Number.isFinite(cap) || (this.lanes && d > 30 && cap * s > this.lineDs[k] * 1.05)) car.launch = null;
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
    // Forming up on the grid: to the car's own slot, staggered so the slots are closer than a following gap.
    const grid = this.regrid && Number.isNaN(this.regrid.lights) ? this.regrid.slots.get(car.id) : undefined;
    if (grid !== undefined) return grid;
    const order = this.trackOrder;
    const N = order.length;
    // The gap grows with the speed of the car ahead (not the follower's own, which would feed back and make it surge and brake by turns).
    const gap = (v: number) => (this.phase === 'sc' ? 10 + 0.25 * v : 6 + 0.12 * v) / this.ds;
    // A car already closer than that (as cars are when they reach the first corner side by side) drops back at a
    // little under the speed of the one ahead rather than stopping dead behind it, never closer than `closest`.
    // In lanes the deeper inside the gap the more it eases off (from 1% to 10% slower), so a queue that has closed
    // up opens again as a ripple, not with every car braking harder than the one ahead; and `closest` is the two
    // cars nose to tail. Cars move front to back, so `d` is to where the car ahead has already got to this step.
    const behind = (d: number, v: number) => car.u + Math.max(d - gap(v), Math.min((CLOSE_UP * v * DT) / this.ds, d - CLOSEST / this.ds));
    // In lanes the same in metres of road (see `road`), by the speed over the road of the car ahead; the deeper
    // inside the gap the more it eases off (from 1% to 10% slower), so a queue that has closed up opens again as
    // a ripple, not with every car braking harder than the one ahead; and never closer than nose to tail.
    const follow = (a: RaceCar, d: number) => {
      const metres = this.road(car.u, car.u + d, car.lateral);
      const g = this.phase === 'sc' ? 10 + 0.25 * a.ground : 6 + 0.12 * a.ground;
      const closest = (a.cls.length + car.cls.length) / 2 + NOSE_TO_TAIL;
      const depth = Math.min(1, Math.max(0, (g - metres) / Math.max(1e-9, g - closest)));
      const pace = EASE_OFF - (EASE_OFF - EASE_MOST) * depth;
      // (Closer than nose to tail, as after a car has moved over right in front of it: it drops back as a car
      // backing out of a place beside another does, and does not stand still.)
      const on = Math.max(metres - g, Math.min(pace * a.ground * DT, Math.max(metres - closest, BACK_OUT * a.ground * DT)));
      return { limit: on > 0 ? this.onward(car.u, on, car.lateral) : car.u, metres, gap: g };
    };
    let limit = Infinity;
    let alongside = 0;
    car.heldBy = null;
    const free = this.lanes && !this.noPassing(car);
    for (let s = 1; s < Math.min(N, this.lanes ? 12 : 6); s++) {
      const a = order[(car.trackIndex - s + N) % N];
      if (a.status !== 'running') continue;
      const d = mod(a.u - car.u, this.n);
      if (this.lanes) {
        if (d * this.ds > 250) break;
        const reach = (a.cls.length + car.cls.length) / 2 + ALONG_GAP;
        // Only a car in its way holds it up.
        if (!this.inTheWay(a, car, free)) {
          // Not in its way, but one of two abreast with a corner coming, which takes no third: it follows them in.
          if (d * this.ds >= reach && !a.offTrack && (a.flank === 3 || a.flank === (car.lateral > a.lateral ? 2 : 1)) && this.cornerSoon(car, mod(Math.floor(car.u), this.n))) {
            limit = Math.min(limit, follow(a, d).limit);
          }
          continue;
        }
        if (d * this.ds < reach) {
          // Beside a car with no room to stay there: it lifts until it is clear behind.
          limit = Math.min(limit, this.onward(car.u, BACK_OUT * a.ground * DT, car.lateral));
        } else {
          const f = follow(a, d);
          limit = Math.min(limit, f.limit);
          // (Held up, or about to be: a car closing fast looks for a way by before it has to lift.)
          if (f.metres < 1.6 * f.gap + 4 + Math.max(0, car.ground - a.ground) * CLOSING_LOOK) car.heldBy = a;
        }
        break;
      }
      // On the run to the first corner a car may run beside (or pass) the next cars ahead, but no more than
      // ABREAST wide: the car beyond those holds it up.
      const full = this.beforeFirstZone(a, car) && ++alongside >= ABREAST;
      if (!full && !this.blocks(a, car)) continue;
      if (d * this.ds <= 250) limit = behind(d, a.v);
      break;
    }
    const sc = this.safetyCar;
    if (sc) {
      const d = mod(sc.u - car.u, this.n);
      const k = mod(Math.floor(sc.u), this.n);
      if (d * this.ds <= 250) limit = Math.min(limit, behind(d, this.lineDs[k] / this.scSeg[k]));
    }
    // Forming up for a standing restart, or stopped on track under a red flag: no further than the car's slot.
    const slot = this.regrid?.slots.get(car.id);
    if (slot !== undefined) limit = Math.min(limit, slot);
    return limit;
  }

  /**
   * Whether `ahead` holds up `car`: not when it is off the track, on the pit
   * entry or exit road, or being passed, and not on the run from the grid to
   * the first corner, where the field runs up to ABREAST wide (see limitFor).
   */
  private blocks(ahead: RaceCar, car: RaceCar): boolean {
    if (ahead.offTrack || car.passing?.target === ahead) return false;
    if (this.beforeFirstZone(ahead, car)) return false;
    if (ahead.exitUntilU > ahead.u) return false;
    const pit = ahead.model.pit;
    if (ahead.pitRequest && pit && mod(pit.entry - ahead.u, this.n) * this.ds < ENTRY_ROAD) return false;
    return true;
  }

  /**
   * Lanes: whether `ahead` is in the way of `car`. Not when it is off the
   * track or on the pit entry or exit road; otherwise when there is no room
   * to go by it where the two are (or the car has to fall in behind it, or
   * may not pass at all: `free` is false).
   */
  private inTheWay(ahead: RaceCar, car: RaceCar, free: boolean): boolean {
    if (ahead.offTrack || ahead.exitUntilU > ahead.u) return false;
    const pit = ahead.model.pit;
    if (ahead.pitRequest && pit && mod(pit.entry - ahead.u, this.n) * this.ds < ENTRY_ROAD) return false;
    if (!free || car.squeezed === ahead) return true;
    return Math.abs(ahead.lateral - car.lateral) < ahead.cls.half + car.cls.half + SIDE_GAP - SLACK;
  }

  /** Away from the grid and not yet near the first corner of the race: the field fans out, each car round the next as its start allows. */
  private away(car: RaceCar): boolean {
    return car.lapsDone === 0 && car.u < this.firstZoneU - AWAY_UNTIL / this.ds;
  }

  /** No passing here and now: under a neutralisation or waved yellows, and before the line after a restart. */
  private noPassing(car: RaceCar): boolean {
    return this.phase !== 'green' || car.u < car.holdUntilU || this.yellowAt[mod(Math.floor(car.u), this.n)] !== 0;
  }

  /** Both cars on the run from the grid to the first corner, free to run side by side. */
  private beforeFirstZone(ahead: RaceCar, car: RaceCar): boolean {
    return car.u < this.firstZoneU && ahead.u < this.firstZoneU;
  }

  protected movePit(car: RaceCar, budget: number, t: number): void {
    const pit = car.model.pit!;
    const ps = car.pit!;
    while (budget > 1e-12 && car.status === 'pit') {
      if (ps.done && this.red && this.phase === 'red' && !this.setup.session && ps.service.reason !== 'red flag') {
        // Stopped on its way out: the pit exit is closed.
        ps.box = Math.max(ps.p, this.queueSlot(car));
        ps.done = false;
        ps.service = { compound: null, fuel: 0, time: Infinity, reason: 'red flag', driver: null };
      }
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
        // Wait for a team-mate still in the box (in a session each car has a garage of its own).
        let start = t;
        for (const o of this.cars) {
          if (this.sharedBoxes && o !== car && o.pit?.stopped && o.entrant.teamIndex === car.entrant.teamIndex) start = Math.max(start, o.pit.stoppedUntil);
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
        if (!this.lanes) this.attemptPass(car, u, t, k, zone);
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
    car.sectorMarks[i] = this.timedSector(car) ? this.markSector(car, i, time) : 'normal';
  }

  /** Whether the sector just driven counts towards the best sectors (in a session, not on an out lap or in lap). */
  protected timedSector(car: RaceCar): boolean {
    void car;
    return true;
  }

  protected markSector(car: RaceCar, i: number, time: number): SectorMark {
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
    car.sectorMarks[2] = this.timedSector(car) ? this.markSector(car, 2, s3) : 'normal';
    const s1 = car.sectors[0] ?? 0;
    const s2 = car.sectors[1] ?? 0;
    car.lapsDone = lap;
    const kind = this.lapKind(car);
    const timed = kind === undefined || kind === 'push' || kind === 'cool' || kind === 'long';
    if (timed) {
      car.lastLap = time;
      if (car.bestLap === null || time < car.bestLap) car.bestLap = time;
    }
    if (this.lapLeaders.length < lap) this.lapLeaders[lap - 1] = t;
    if (cls.lapLeaders.length < lap) cls.lapLeaders[lap - 1] = t;
    car.history.push({
      lap, time, sectors: [s1, s2, s3], position: car.position, classPosition: car.classPosition, compound: car.compound, tyreLaps: car.tyreLaps,
      wear: car.wear, fuel: car.fuel, pit: car.pittedThisLap, at: t, gap: t - cls.lapLeaders[lap - 1], trap: car.trapV,
      driver: car.driverIndex, wet: this.wetness, neutral: car.neutralThisLap, kind,
    });
    car.trapV = NaN;
    car.traces.push(car.trace);
    car.trace = new Float32Array(this.model.samples).fill(NaN);
    if (timed && (lap > 1 || kind !== undefined) && (!cls.fastest || time < cls.fastest.time)) {
      const beaten = cls.fastest !== null;
      cls.fastest = { car: car.id, time, lap };
      this.fastestLap(car, time, lap, beaten, t);
    }
    car.lapStart = t;
    car.sectorStart = t;
    // Every lap lays down a little more rubber.
    this.rubber += (1 - this.rubber) / RUBBER_LAPS;
    return this.afterLap(car, lap, t);
  }

  /** What kind of lap a car has just completed in a session (out lap, push lap, ...); undefined in the race. */
  protected lapKind(car: RaceCar): LapKind | undefined {
    void car;
    return undefined;
  }

  /** A new fastest lap of the class (the first one is not news in a race). */
  protected fastestLap(car: RaceCar, time: number, lap: number, beaten: boolean, t: number): void {
    if (beaten) this.log('fastest', t, `Fastest lap${this.multiClass ? ` in ${car.cls.label}` : ''}: ${car.entrant.code} ${formatLapTime(time)}`, car.id, lap);
  }

  /** After the line: the race's own business (fuel, the flag, the next lap). Returns true when the car is out of it. */
  protected afterLap(car: RaceCar, lap: number, t: number): boolean {
    const cls = car.cls;
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
  protected startLap(car: RaceCar, t: number): void {
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
    const risk = (car.wear > 1 ? 1.5 : 1) * riskFactor(car.tyreType, this.wetness) * this.incidentRisk(car);
    if (risk <= 0) return;
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

  /** Multiplier on a car's chance of trouble on the lap it starts (in a session: higher on a push lap, none on an out lap). */
  protected incidentRisk(car: RaceCar): number {
    void car;
    return 1;
  }

  /** Where along the pit lane a car stops: its team's box (team-mates share one). */
  protected boxFor(car: RaceCar): number {
    const pit = car.model.pit!;
    return pit.boxFrom + ((car.entrant.teamIndex + 0.5) / this.teams) * (pit.boxTo - pit.boxFrom);
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
        const p = pathPoint(pit.x, pit.y, pit.cum, this.boxFor(car));
        car.retired = { ...car.retired!, x: p.x, y: p.y };
        return true;
      }
      this.retire(car, reason, t, r < 0.7 ? 14 : 6);
      this.trackIncident(car.u, r < 0.7 ? 'parked' : 'stopped', t, car);
      return true;
    }
    if (inc.kind === 'crash') {
      this.retire(car, 'crash', t);
      this.log('retired', t, `${car.entrant.code} crashes out${where}`, car.id, lap);
      this.trackIncident(car.u, 'crash', t, car);
      return true;
    }
    if (inc.kind === 'off') {
      const loss = 3 + 7 * car.rng();
      car.delay += loss;
      car.delayShare = 0.9;
      car.offTrack = true;
      this.log('off', t, `${car.entrant.code} goes off${where} (${loss.toFixed(1)} s)`, car.id, lap);
      this.trackIncident(car.u, 'off', t, car);
      return false;
    }
    car.delay += 0.4 + 1.1 * car.rng();
    car.delayShare = Math.max(car.delayShare, 0.5);
    return false;
  }

  protected retire(car: RaceCar, reason: string, t: number, aside = 8): void {
    const p = car.status === 'pit' ? this.pose(car, 1) : this.linePoint(car.u, car.lateral + aside);
    car.status = 'retired';
    car.pit = null;
    car.pitRequest = null;
    car.passing = null;
    car.attack = null;
    car.beside = [];
    car.retired = { reason, lap: car.lapsDone + 1, x: p?.x ?? 0, y: p?.y ?? 0, t };
    if (reason !== 'crash' && !reason.startsWith('collision')) this.log('retired', t, `${car.entrant.code} retires: ${reason}`, car.id, car.lapsDone + 1);
  }

  protected where(u: number): string {
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
  protected trackIncident(u: number, kind: 'off' | 'contact' | 'parked' | 'stopped' | 'crash', t: number, car?: RaceCar): void {
    void car;
    const rnd = this.controlRng;
    if (kind === 'off' || kind === 'contact' || kind === 'parked') {
      this.addYellow(u, false, 20 + 25 * rnd(), t);
      return;
    }
    const recover = 60 + 150 * rnd();
    this.addYellow(u, true, recover, t);
    if (this.chequered || this.red || this.restart) return;
    const flags = this.model.rules.flags;
    const leader = this.order[0];
    // Not on the last lap: the race finishes under yellows.
    if (leader && this.lapsLeft(leader) <= 1) return;
    const k = mod(Math.floor(u), this.n);
    const severity = clamp01((this.model.v[k] - 30) / 50);
    // A big accident, with barriers to repair, stops the race.
    const red = this.model.vehicle.kind === 'bike' ? RED_CRASH.bike : RED_CRASH.car;
    if (rnd() < (kind === 'crash' ? red[0] + red[1] * severity : RED_STOPPED)) {
      this.redFlag(t, kind === 'crash' ? `crash${this.where(u)}` : `stopped car${this.where(u)}`);
      return;
    }
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

  protected addYellow(u: number, double: boolean, duration: number, t: number): void {
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

  protected rebuildYellows(): void {
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
        // In this lap: it leaves the track, and the car behind leads the field to the line (or to the grid, for a standing restart).
        this.safetyCar = null;
        if (this.restart === 'standing') {
          this.formGrid(this.t);
          return;
        }
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
    this.restart = null;
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

  // ---- red flags -------------------------------------------------------------------

  /**
   * Stops the race: any safety car or VSC ends, and every car drives slowly
   * to where the series has it wait: the pit lane, queueing at its exit in
   * the order they arrive, or in single file on track before the line. The
   * race waits until the track is clear (or the rain eases). A bike race
   * stopped late enough is over there and then.
   */
  redFlag(t: number, reason: string, rain = false): void {
    if (this.red || this.chequered) return;
    const rules = this.model.rules.weekend.redFlag;
    const leader = this.order[0];
    if (rules.completeAt !== null && this.setup.laps !== null && leader && leader.lapsDone >= rules.completeAt * this.setup.laps) {
      // Far enough into the race: it is not restarted.
      this.log('flag', t, `Red flag: ${reason}`, -1);
      this.red = { from: t, resumeAt: Infinity, reason, order: [], rain, lap: this.lapLeaders.length + 1 };
      this.callOff(t);
      return;
    }
    this.closeNeutral(t);
    this.safetyCar = null;
    this.restartLeader = null;
    this.virtualUntil = NaN;
    this.restart = null;
    this.regrid = null;
    this.phase = 'red';
    this.phaseSince = t;
    const order = this.order.filter((c) => c.status === 'running' || c.status === 'pit').map((c) => c.id);
    const clear = rules.clear[0] + (rules.clear[1] - rules.clear[0]) * this.controlRng();
    this.red = { from: t, resumeAt: rain ? Infinity : t + clear, reason, order, rain, lap: this.lapLeaders.length + 1 };
    this.queued = 0;
    this.neutral.push({ kind: 'red', from: t, to: NaN, reason });
    this.log('flag', t, `Red flag: ${reason}. The race is stopped`, -1);
    const onTrack = rules.stopAt === 'track';
    if (onTrack) this.redSlots(t);
    for (const car of this.cars) {
      if (car.status !== 'running') continue;
      if (!onTrack) car.pitRequest = 'red flag';
      car.passing = null;
      car.incident = null;
    }
  }

  /** Stopping on track: each car a place in single file before the line, nearest the line first. */
  private redSlots(t: number): void {
    const running = this.cars.filter((c) => c.status === 'running');
    const toLine = (c: RaceCar) => this.n - mod(c.u, this.n);
    running.sort((a, b) => toLine(a) - toLine(b));
    const slots = new Map<number, number>();
    running.forEach((c, i) => slots.set(c.id, Math.ceil(c.u / this.n + 1e-9) * this.n - (QUEUE_FRONT + i * QUEUE_GAP) / this.ds));
    this.regrid = { slots, lateral: new Map(), since: t, lights: Infinity };
  }

  /** The next place in the queue at the pit exit, in the order the cars arrive. */
  private queueSlot(car: RaceCar): number {
    const pit = car.model.pit!;
    const count = Math.max(1, this.red?.order.length ?? 1);
    const gap = Math.min(QUEUE_GAP, (pit.limitTo - pit.limitFrom - QUEUE_FRONT) / count);
    return Math.max(pit.limitFrom, pit.limitTo - QUEUE_FRONT - this.queued++ * gap);
  }

  /** The tyres a car takes for the restart where the rules allow a change: for the conditions, or the first stint of a fresh plan. */
  private restartCompound(car: RaceCar): number | null {
    if (!this.model.rules.weekend.redFlag.work) return null;
    const r = car.rules;
    const type = bestTyreType(wetnessAhead(this.weather, this.t, this.t + 2 * car.model.lapTime), car.cls.types);
    if (type !== 'slick') return compoundOfType(r, type) ?? car.compound;
    const plan = planStrategy({
      model: car.model, tyreFactor: car.driver.tyreWear, laps: this.lapsLeft(car), compound: null, wear: 0, used: car.used, stopsDone: car.stops, canStop: true,
      wearGuess: this.wearGuess(car),
    });
    return plan.stints[0].compound;
  }

  /**
   * While stopped: wait for the track to clear or the rain to ease, then
   * send the field away (behind the safety car where the series has one);
   * a race that cannot resume in time is called off.
   */
  private updateRed(t: number): void {
    const red = this.red!;
    if (red.rain && red.resumeAt === Infinity && this.rain < RED_RAIN_EASED && this.wetness < RED_RAIN) red.resumeAt = t + 600;
    const rules = this.model.rules;
    const outOfTime = !rules.weekend.redFlag.raceClockStops && this.limit !== null && t >= this.limit;
    if (outOfTime || t - red.from > RED_LONGEST) {
      this.callOff(t);
      return;
    }
    const onTrack = rules.weekend.redFlag.stopAt === 'track';
    // Everyone has to have stopped first.
    const waiting = this.cars.some((c) => (onTrack ? c.status === 'running' && c.v > 0.5 : c.status === 'running'));
    if (t < red.resumeAt || waiting) return;
    this.suspended += t - red.from;
    this.red = null;
    this.closeNeutral(t);
    const rank = (c: RaceCar) => {
      const i = red.order.indexOf(c.id);
      return i < 0 ? 999 : i;
    };
    const queued = this.cars.filter((c) => c.status === 'pit' && c.pit?.service.reason === 'red flag')
      .sort((a, b) => (onTrack ? rank(a) - rank(b) : a.pit!.box > b.pit!.box ? -1 : 1));
    queued.forEach((c, i) => {
      const ps = c.pit!;
      ps.service.compound = this.restartCompound(c);
      ps.service.time = 0;
      // On track the field leaves first and the cars in the pit lane follow it out.
      ps.stoppedUntil = t + (onTrack ? 25 : 2) + i * RELEASE_GAP;
    });
    const red2 = rules.weekend.redFlag;
    const wet = this.wetness > 0.3;
    const standing = red2.restart === 'standing' && !(red2.rollingWhenWet && wet);
    this.restart = standing ? 'standing' : 'rolling';
    const pit = this.model.pit;
    const running = this.cars.filter((c) => c.status === 'running');
    if (rules.flags.safetyCar && (running.length || (pit && queued.length))) {
      // The safety car leads the field away (in this lap): a lap behind it, then the restart.
      const front = running.length ? running.reduce((a, b) => (b.u > a.u ? b : a)) : null;
      const u = front ? front.u + SC_AHEAD / this.ds : queued[0].pit!.uEntry + pit!.span + SC_AHEAD / this.ds;
      this.regrid = null;
      this.phase = 'sc';
      this.phaseSince = t;
      this.safetyCar = { u, prevU: u, startU: u, clearAt: t, in: true };
      this.neutral.push({ kind: 'sc', from: t, to: NaN, reason: 'restart after the red flag' });
      this.log('flag', t, `The race resumes behind the safety car${standing ? ', for a standing restart' : ''}`, -1);
    } else {
      // No safety car (bikes): a sighting lap, then a new start from the grid.
      this.regrid = null;
      this.restart = 'standing';
      this.phase = 'sc';
      this.phaseSince = t;
      this.releaseU = queued.length && pit ? queued[0].pit!.uEntry + pit.span : running[0]?.u ?? 0;
      this.neutral.push({ kind: 'sc', from: t, to: NaN, reason: 'restart after the red flag' });
      this.log('flag', t, 'The race resumes: a sighting lap, then a new start from the grid', -1);
    }
    // Each car's tyres for the restart on track, if they may be changed: fitted where it stands.
    for (const car of running) {
      const c = this.restartCompound(car);
      if (c !== null && c !== car.compound) this.fitTyres(car, c);
    }
  }

  private fitTyres(car: RaceCar, compound: number): void {
    car.compound = compound;
    car.tyreType = car.rules.tyres.compounds[compound].type;
    car.wear = 0;
    car.tyreLaps = 0;
    car.used |= 1 << compound;
  }

  /**
   * A standing restart: the field takes grid slots behind the line and stops
   * there, in race order (in grid order when a bike race is restarted from
   * scratch within its first laps).
   */
  private formGrid(t: number): void {
    const running = this.order.filter((c) => c.status === 'running');
    if (!running.length) {
      this.goGreen(t);
      return;
    }
    const leader = running[0];
    if (this.model.rules.weekend.redFlag.completeAt !== null && leader.lapsDone < 3) running.sort((a, b) => a.gridPosition - b.gridPosition);
    const lead = running.reduce((a, b) => (b.u > a.u ? b : a));
    const line = Math.ceil(lead.u / this.n + 1e-9) * this.n;
    const slots = new Map<number, number>();
    const lateral = new Map<number, number>();
    running.forEach((c, i) => {
      const g = this.model.grid[Math.min(i, this.model.grid.length - 1)];
      slots.set(c.id, line + g.u);
      lateral.set(c.id, g.lateral);
    });
    this.regrid = { slots, lateral, since: t, lights: NaN };
    this.log('flag', t, 'The field forms up on the grid for a standing restart', -1);
  }

  /** On the grid: the lights once everyone has stopped in their slot (or after a while), then a standing start. */
  private updateGrid(t: number): void {
    const g = this.regrid!;
    if (g.lights === Infinity) return;
    if (Number.isNaN(g.lights)) {
      const settled = [...g.slots].every(([id, slot]) => {
        const c = this.cars[id];
        return c.status !== 'running' || (slot - c.u < 1.5 && c.v < 0.5);
      });
      if (settled || t - g.since > FORM_UP) g.lights = t + 5;
      return;
    }
    if (t < g.lights) return;
    this.regrid = null;
    this.restart = null;
    this.closeNeutral(t);
    this.phase = 'green';
    for (const car of this.cars) {
      if (car.status !== 'running') continue;
      car.v = 0;
      car.launch = { u: car.u, from: 0, factor: 0.94 + 0.06 * car.driver.launch };
      car.startDelay = t + 0.15 + 0.3 * (1 - car.driver.launch) * car.rng();
    }
    this.log('start', t, 'Lights out: the race restarts', this.order[0]?.id ?? -1);
  }

  /**
   * The race cannot go on: classified as it stood a lap or two before the
   * lap the red flag came out on (by laps done at that moment, then who got
   * there first).
   */
  private callOff(t: number): void {
    const red = this.red!;
    this.red = null;
    this.closeNeutral(t);
    // Laps back from the lap the red flag came out on (0: as each car last crossed a timing line, here the line).
    const back = this.model.rules.weekend.redFlag.resultLapsBack;
    const lap = back > 0 ? red.lap - back : red.lap - 1;
    const at = back > 0 && lap >= 1 ? this.lapLeaders[lap - 1] + 1e-6 : red.from;
    const standing = (c: RaceCar) => {
      let laps = 0;
      let when = Infinity;
      for (const h of c.history) {
        if (h.at > at) break;
        laps = h.lap;
        when = h.at;
      }
      return { laps, when };
    };
    const score = new Map(this.cars.map((c) => [c.id, standing(c)]));
    for (const car of this.cars) {
      if (car.status === 'running' || car.status === 'pit') {
        car.status = 'finished';
        car.finishTime = score.get(car.id)!.when;
        car.pit = null;
        car.pitRequest = null;
      }
    }
    this.order.sort((a, b) => {
      const ra = a.status === 'retired' ? 1 : 0;
      const rb = b.status === 'retired' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      const sa = score.get(a.id)!;
      const sb = score.get(b.id)!;
      return sb.laps - sa.laps || sa.when - sb.when;
    });
    this.order.forEach((c, i) => { c.position = i + 1; });
    this.updateClassOrder();
    this.regrid = null;
    this.restart = null;
    this.chequered = true;
    this.finished = true;
    this.phase = 'green';
    const leader = this.order[0];
    const who = leader ? `${this.multiClass ? `${leader.entrant.code} ${leader.entrant.team}` : leader.entrant.name} wins, ` : '';
    this.log('chequered', t, `The race is not resumed: ${who}the result as it stood ${back > 0 && lap >= 1 ? `after lap ${lap}` : 'at the red flag'}`, leader?.id ?? -1);
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
    // Rain washes the rubber off the racing line.
    if (this.rain > RAIN_THRESHOLD) this.rubber *= Math.exp((-DT * this.rain) / RUBBER_WASH);
    if (this.yellows.length && this.yellows.some((z) => z.until <= t)) {
      this.yellows = this.yellows.filter((z) => z.until > t);
      this.rebuildYellows();
    }
    if ((this.phase === 'vsc' || this.phase === 'fcy') && t >= this.virtualUntil) this.goGreen(t);
    if (this.restartLeader && this.restartLeader.status !== 'running') this.goGreen(t);
    if (!this.setup.session) {
      // Rain too heavy to race in stops it (not a bike race: riders change bikes and race on).
      const heavy = this.rain > RED_RAIN && this.wetness > RED_RAIN && this.model.rules.weekend.redFlag.rain;
      if (!this.red && !this.chequered && !this.restart && heavy && t > 0) this.redFlag(t, 'heavy rain', true);
      if (this.red) this.updateRed(t);
      // Without a safety car to lead it, the field forms up on the grid near the end of its sighting lap.
      if (this.restart === 'standing' && !this.safetyCar && !this.regrid && this.phase === 'sc' && !this.red && !this.finished) {
        const lead = this.order.find((c) => c.status === 'running');
        if (lead && lead.u > this.releaseU + this.n / 2 && mod(lead.u, this.n) >= this.scExit) this.formGrid(t);
      }
      if (this.regrid) this.updateGrid(t);
    }
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

  protected lapPaceFor(car: RaceCar): number {
    const m = car.model;
    const c = car.rules.tyres.compounds[car.compound];
    const wear = car.wear + 0.5 * wearPerLap(m, car.compound, car.driver.tyreWear) * wearFactor(car.tyreType, this.wetness);
    const extraFuel = Math.max(0, car.fuel - 0.5 * m.fuelPerLap * car.burn - car.cls.qualiFuel);
    const loss = this.paceLoss(car) + c.offset + tyreLoss(c, wear) + m.fuelSensitivity * extraFuel + car.saving * FUEL_SAVE_COST + car.cold
      + aquaplaning(car.tyreType, this.wetness);
    // A green track is slower until rubber builds up on the racing line.
    const green = car.rules.weekend.evolution * (1 - this.rubber);
    return (1 + car.entrant.carPace + car.driver.pace) * (1 + loss) * (1 + car.noise) * (1 + green) * this.lapFactor(car);
  }

  /** Lap-time fraction a driver gives away against a qualifying lap: race pace (managing tyres and fuel, engine modes). */
  protected paceLoss(car: RaceCar): number {
    return car.rules.pace.race;
  }

  /** Lap-time factor for the kind of lap (sessions: out laps, in laps and cool-down laps are slow); 1 in the race. */
  protected lapFactor(car: RaceCar): number {
    void car;
    return 1;
  }

  /** Tyre wear and fuel burn since the last accrual, in proportion to the distance covered. */
  protected accrue(car: RaceCar, u: number): void {
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

  protected expectedLap(car: RaceCar): number {
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
      car.compound = wet ?? pickCompound(m, stint, car.driver.tyreWear, 0, stint >= laps, this.wearGuess(car));
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
          model: m, tyreFactor: car.driver.tyreWear, laps, compound: null, wear: 0, used: 0, stopsDone: 0, canStop: true, wearGuess: this.wearGuess(car),
        }, car.rng, 0.0015 * laps * m.lapTime);
        car.plan = plan.stints;
        car.compound = plan.stints[0].compound;
        car.nextStopLap = plan.stints.length > 1 ? this.jitterStop(car, plan.stints[0].laps, laps) : null;
      }
    }
    car.tyreType = r.tyres.compounds[car.compound].type;
    car.used = 1 << car.compound;
  }

  /** The tyre wear the car's team believes in per compound (a share of the real wear), from what practice showed; undefined when it knows. */
  protected wearGuess(car: RaceCar): readonly number[] | undefined {
    return this.setup.wearGuess?.[car.id];
  }

  /** Teams do not all stop on the optimal lap: spread planned stops by a lap or two. */
  private jitterStop(car: RaceCar, lap: number, lastLap: number): number {
    return Math.max(2, Math.min(lastLap - 2, lap + Math.round(gauss(car.rng) * 1.5)));
  }

  // ---- pit stops -------------------------------------------------------------------

  protected decide(car: RaceCar, t: number): void {
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

  protected enterPit(car: RaceCar, u: number, t: number): void {
    this.accrue(car, u);
    // Under a red flag the pit lane is where the race waits: queue at the exit.
    const queue = this.phase === 'red' && !!this.red && !this.setup.session;
    const box = queue ? this.queueSlot(car) : this.boxFor(car);
    // The car ahead in the class, if close, now faces the undercut.
    const ahead = car.cls.order[car.classPosition - 2];
    const iv = ahead ? this.gapBetween(car, ahead) : null;
    if (!queue && ahead && ahead.status === 'running' && iv?.kind === 'time' && iv.value < 3) ahead.threatLap = car.lapsDone + 1;
    const service: Service = queue ? { compound: null, fuel: 0, time: Infinity, reason: 'red flag', driver: null } : this.planService(car, car.pitRequest ?? 'plan');
    const record: PitStopRecord = {
      car: car.id, lap: car.lapsDone + 1, entry: t, exit: NaN, stationary: NaN,
      from: car.compound, to: service.compound, fuel: service.fuel, driver: service.driver, reason: service.reason,
    };
    if (!queue && !this.setup.session) this.stops.push(record);
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
  protected planService(car: RaceCar, reason: string): Service {
    const m = car.model;
    const r = car.rules;
    const left = this.lapsLeft(car);
    const type = car.wantType ?? bestTyreType(wetnessAhead(this.weather, this.t, this.t + 2 * m.lapTime), car.cls.types);
    car.wantType = null;
    const tyreWear = car.driver.tyreWear;
    if (!r.pit.stops) {
      const compound = type === 'slick' ? pickCompound(m, left, tyreWear, car.used, true, this.wearGuess(car)) : compoundOfType(r, type);
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
        compound = car.tyreType !== 'slick' || car.wear + stint * wpl > 0.9 || mustSwitch ? pickCompound(m, stint, tyreWear, car.used, lastSet, this.wearGuess(car)) : null;
      }
    } else if (type !== 'slick') {
      compound = compoundOfType(r, type);
    } else {
      const plan = planStrategy({
        model: m, tyreFactor: tyreWear, laps: left, compound: null, wear: 0, used: car.used, stopsDone: car.stops + 1, canStop: true, wearGuess: this.wearGuess(car),
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

  protected finishService(car: RaceCar, t: number): void {
    const s = car.pit!.service;
    if (s.reason === 'red flag') {
      // Away from the queue for the restart, on new tyres if they were changed.
      if (s.compound !== null && s.compound !== car.compound) this.fitTyres(car, s.compound);
      car.pitRequest = null;
      car.pit!.record.stationary = t - car.pit!.stopStart;
      if (car.rules.fuel.refuelRate <= 0 && car.rules.pit.stops && car.tyreType === 'slick') {
        const left = this.lapsLeft(car);
        const plan = planStrategy({
          model: car.model, tyreFactor: car.driver.tyreWear, laps: left, compound: car.compound, wear: car.wear, used: car.used, stopsDone: car.stops, canStop: true,
          wearGuess: this.wearGuess(car),
        });
        car.plan = plan.stints;
        car.nextStopLap = plan.stints.length > 1 ? this.jitterStop(car, car.lapsDone + plan.stints[0].laps, car.lapsDone + left) : null;
      }
      return;
    }
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
        wearGuess: this.wearGuess(car),
      });
      car.plan = plan.stints;
      car.nextStopLap = plan.stints.length > 1 ? this.jitterStop(car, car.lapsDone + plan.stints[0].laps, car.lapsDone + left) : null;
    }
  }

  protected exitPit(car: RaceCar, v: number, t: number): void {
    car.pit!.record.exit = t;
    car.status = 'running';
    car.pit = null;
    car.accruedU = car.u;
    car.launch = { u: car.u, from: v, factor: 1 };
    car.exitUntilU = car.u + EXIT_BLEND / this.ds;
    car.cold = COLD_TYRES;
    car.lapPace = this.lapPaceFor(car);
    car.lateral = this.pitSide * 4;
    car.prevLateral = car.lateral;
    car.attack = null;
    car.beside = [];
    car.v = v;
  }

  // ---- racing in lanes ------------------------------------------------------------------

  /** Metres `a` is ahead of `b` round the lap (negative behind), whatever lap each is on. */
  private aheadBy(a: RaceCar, b: RaceCar): number {
    let d = mod(a.u - b.u, this.n);
    if (d > this.n / 2) d -= this.n;
    return d * this.ds;
  }

  /**
   * A car held up looks for a way past: pulls out to the side of the car
   * ahead where there is room, when its pace off the line over the next
   * stretch beats that car's by enough to draw level before the road bends.
   * The inside for the next corner comes first.
   */
  private considerPass(car: RaceCar, t: number): void {
    const a = car.heldBy;
    if (!a || car.attack || t < car.nextTry) return;
    car.nextTry = t + TRY_EVERY;
    if (a.status !== 'running' || car.offTrack || car.pitRequest || car.exitUntilU > car.u || car.giveWay !== 0 || this.noPassing(car)) return;
    // A car that is making way for it moves over by itself.
    if (a.giveWayTo === car) return;
    const d = this.aheadBy(a, car);
    if (d <= 0) return;
    if (this.away(car)) {
      // Off the grid: round a slower starter on whichever side has room, the nearer to the middle of the road first.
      const k = mod(Math.floor(a.u), this.n);
      const toMiddle: 1 | -1 = a.lateral + this.model.line.offset[k] > 0 ? -1 : 1;
      const gap = a.cls.half + car.cls.half + SIDE_GAP;
      for (const side of [toMiddle, -toMiddle as 1 | -1]) {
        if (!this.roomBeside(car, a, a.lateral + side * gap, d)) continue;
        car.attack = { target: a, side, untilU: this.firstZoneU };
        return;
      }
      return;
    }
    // How readily the class's drivers go for a pass (0: never).
    const keen = car.rules.pace.overtaking;
    if (keen <= 0) return;
    const n = this.n;
    const m = car.model;
    const k0 = mod(Math.floor(car.u), n);
    // Its own time over the stretch ahead on either side of the line, with the tow and the open wing it has, against the other car's.
    const look = Math.round(ATTACK_LOOK / this.ds);
    const drsFor = m.drsRatio ? car.drsUntilU - car.u : 0;
    const lift = a.giveWay !== 0 ? 1 + GIVE_WAY_LIFT : 1;
    let his = 0;
    let left = 0;
    let right = 0;
    for (let j = 0; j < look; j++) {
      const k = (k0 + j) % n;
      let r = 1 + car.tow * (m.towRatio[k] - 1);
      if (j < drsFor) r += m.drsRatio![k] - 1;
      const own = m.seg[k] * car.lapPace * r;
      his += a.model.seg[k] * a.lapPace * lift;
      left += own / Math.max(0.4, m.laneCap[LEFT][k]);
      right += own / Math.max(0.4, m.laneCap[RIGHT][k]);
    }
    // The inside for the next corner: the right for a right-hander.
    const curvature = this.model.line.curvature;
    let first: 1 | -1 = 1;
    for (let j = 0, end = Math.round(400 / this.ds); j < end; j += 3) {
      const c = curvature[(k0 + j) % n];
      if (c > 1 / 400 || c < -1 / 400) {
        first = c > 0 ? -1 : 1;
        break;
      }
    }
    const sep = a.cls.half + car.cls.half + SIDE_GAP;
    // At a braking point, close enough behind to out-brake it: a dive down the inside.
    const zone = car.cls.brakingAt[k0];
    if (zone >= 0) {
      const side = m.zones[zone].inside;
      // (With the corner still to come: it has to get out from behind the other car first, and there is no doing that once they turn in.)
      const early = mod(m.zones[zone].station - k0 + Math.round(DIVE_LATEST / this.ds), n) < n / 2;
      if (early && this.roomBeside(car, a, a.lateral + side * sep, d) && this.intoCorner(car, a, d, side, k0)) car.attack = { target: a, side, untilU: car.u + ATTACK_RUN / this.ds };
      return;
    }
    const sides: (1 | -1)[] = first > 0 ? [1, -1] : [-1, 1];
    for (const side of sides) {
      const lane = side > 0 ? LEFT : RIGHT;
      const advantage = 1 - (side > 0 ? left : right) / his;
      if (advantage < ATTACK_MIN) continue;
      if (!this.roomBeside(car, a, a.lateral + side * sep, d)) continue;
      // The run it has: to where a corner holds that side of the road.
      const held = m.laneCap[lane];
      let run = 0;
      for (const end = Math.round(900 / this.ds); run < end && held[(k0 + run) % n] > 0.97; run++);
      // And the road it has: no use pulling out to a side the racing line is about to take all of.
      if (!this.roomAlong(car, side, sep, k0, Math.min(run, Math.round(RUN_ROOM / this.ds)))) continue;
      // Enough to be level with it by the braking point (near enough to have the right to its side of the road
      // there), counting what braking later on the inside adds.
      const braking = run * this.ds < 900 ? car.cls.brakingAt[(k0 + run) % n] : -1;
      const late = braking >= 0 && m.zones[braking].inside === side ? this.late(car) * m.zones[braking].drop : 0;
      const gain = advantage * ATTACK_KEEP * run * this.ds + late;
      if (gain * keen < (d - LEVEL) * (1.2 - 0.4 * car.driver.racecraft)) continue;
      car.attack = { target: a, side, untilU: car.u + ATTACK_RUN / this.ds };
      return;
    }
  }

  /**
   * Whether `car` could run at sideways position `slot`, beside the car `a`
   * that is `d` metres ahead of it: on the road there, with nobody in that
   * strip from beside itself to a little beyond `a` (it would be boxed in).
   */
  private roomBeside(car: RaceCar, a: RaceCar, slot: number, d: number): boolean {
    const n = this.n;
    const k = mod(Math.floor(a.u), n);
    const half = this.model.track.width[k] / 2 - car.cls.half - EDGE_GAP;
    const offset = this.model.line.offset[k];
    if (slot < -half - offset - 0.05 || slot > half - offset + 0.05) return false;
    const order = this.trackOrder;
    const N = order.length;
    const behind = car.cls.length + ALONG_GAP;
    for (let s = -Math.min(3, N - 1); s <= Math.min(10, N - 1); s++) {
      if (s === 0) continue;
      const o = order[(((car.trackIndex - s) % N) + N) % N];
      if (o === a || o === car || o.status !== 'running' || o.offTrack) continue;
      if (Math.abs(o.lateral - slot) >= o.cls.half + car.cls.half + SIDE_GAP - SLACK) continue;
      const rel = this.aheadBy(o, car);
      if (rel > -behind && rel < d + BOXED_IN) return false;
    }
    return true;
  }

  /**
   * Whether there is room for `car` beside a car on the racing line, on side
   * `side` of it, all the way over the next `stations` from station `k`
   * (bar a metre or so: beside each other, the car on the line gives a little).
   */
  private roomAlong(car: RaceCar, side: 1 | -1, sep: number, k: number, stations: number): boolean {
    const n = this.n;
    const widths = this.model.track.width;
    const offset = this.model.line.offset;
    for (let j = 0; j <= stations; j += 3) {
      const q = (k + j) % n;
      const edge = widths[q] / 2 - car.cls.half - EDGE_GAP;
      if ((side > 0 ? edge - offset[q] : edge + offset[q]) < sep - RUN_GIVE) return false;
    }
    return true;
  }

  /** How much later than the car ahead a driver dares to brake, metres. */
  private late(car: RaceCar): number {
    return LUNGE_LATE * (0.5 + car.driver.racecraft) * Math.min(car.rules.pace.overtaking, 1.5);
  }

  /**
   * A car coming to a corner `d` metres behind the car `a` it is after
   * (centre to centre), on side `side` of it at station `k`: whether it
   * stays out there for the corner. It does if the speed it is closing at,
   * and braking later where that is the inside of a braking zone, bring it
   * level enough by the corner to have the right to its side of the road;
   * then it is committed until the corner's slowest point.
   */
  private intoCorner(car: RaceCar, a: RaceCar, d: number, side: 1 | -1, k: number): boolean {
    const n = this.n;
    const zone = car.cls.brakingAt[k];
    const z = zone >= 0 ? car.model.zones[zone] : null;
    const gain = z && z.inside === side ? this.late(car) * z.drop : 0;
    // To where the corner begins: the braking point (it may be past it already), or where the road bends.
    const ahead = z ? mod(z.station - k, n) : 0;
    const toCorner = z ? (ahead < n / 2 ? ahead * this.ds : 0) : CORNER_LOOK;
    const closing = (Math.max(0, car.v - a.v) * toCorner) / Math.max(car.v, 20);
    if (d - closing - gain > LEVEL) return false;
    const end = z ? mod(z.apex - k, n) * this.ds : CORNER_LOOK + 60;
    if (end < 10) return false;
    car.lungeUntilU = car.u + end / this.ds;
    car.lungePace = gain > 0 ? Math.max(0.8, 1 - gain / end) : 1;
    return true;
  }

  /** Whether a corner holds the car's side of the road within CORNER_LOOK metres: time to make for the racing line. */
  private cornerSoon(car: RaceCar, k: number): boolean {
    const held = car.model.laneCap[car.lateral > 0 ? LEFT : RIGHT];
    for (let j = 0, end = Math.round(CORNER_LOOK / this.ds); j <= end; j += 2) if (held[(k + j) % this.n] < 0.98) return true;
    return false;
  }

  /**
   * Whether `def` moves over for `car` before it is held up: in a race, for a
   * car of its own class that is lapping it. (A slower class holds its line
   * and keeps its pace: the faster car finds its own way by.)
   */
  protected makesWay(def: RaceCar, car: RaceCar): boolean {
    return car.cls === def.cls && car.u - def.u > this.n / 2;
  }

  /**
   * Where every car goes across the road, once all have moved along it.
   *
   * Each car makes for the place it wants at no more than SIDEWAYS: the pit
   * side on the pit entry and exit roads, its slot on the grid, beside the
   * car it has pulled out to pass, aside for a car lapping it, and otherwise
   * the racing line; but a car with another beside it, or close behind it in
   * the next lane (MERGE_GAP), holds its side until a corner is near: moving
   * over takes a hole. That is all that keeps the field in its files from
   * the grid to the first corner and two abreast through it. Then no two
   * cars side by side may be closer than their widths and SIDE_GAP, and all
   * stay on the road:
   *
   * - A car at least LEVEL metres ahead of the one beside it has the right to
   *   its line: the other makes room. If it has none (it is against the
   *   edge), it is squeezed, and lifts until it is clear behind (limitFor).
   * - Level, neither may move in on the other; the edges may still push one
   *   into the other (the racing line swings across the road through a
   *   corner, and positions are measured from it), and then the other makes
   *   room: the inside car takes the apex, the outside car the exit.
   * - A car with one close behind it in the next lane that has to keep to
   *   its side too takes its line as far as that car has room to give.
   *
   * A corner takes two abreast: of three, the one furthest back is squeezed
   * and drops in behind before they turn in, and no car moves up beside two
   * as a third (limitFor).
   *
   * A car that comes up beside another from behind and gets clear ahead of
   * it has passed it.
   */
  private updateLanes(): void {
    const n = this.n;
    const ds = this.ds;
    const line = this.model.line;
    const widths = this.model.track.width;
    const pit = this.model.pit;
    const cars = this.trackOrder.filter((c) => c.status === 'running');
    cars.sort((a, b) => mod(b.u, n) - mod(a.u, n));
    const N = cars.length;
    if (this.laneNext.length < N) {
      this.laneLo = new Float64Array(N);
      this.laneHi = new Float64Array(N);
      this.laneNext = new Float64Array(N);
      this.laneSqueezed = new Int32Array(N);
    }
    const lo = this.laneLo;
    const hi = this.laneHi;
    const next = this.laneNext;
    const squeezed = this.laneSqueezed;

    // Pairs side by side: i is ahead of j, or level with it. Two cars nose to tail on the same piece of road are
    // not a pair (the one behind is held up, not pushed aside), unless their bodies overlap.
    const pairs = this.lanePairs;
    pairs.length = 0;
    // And cars in different lanes with too little between them for the one ahead to move over in front of the other.
    const near = this.laneNear;
    near.length = 0;
    for (let i = 0; i < N; i++) {
      squeezed[i] = 0;
      const a = cars[i];
      for (let s = 1; s < N; s++) {
        const j = (i + s) % N;
        const b = cars[j];
        const d = mod(a.u - b.u, n) * ds;
        if (d > 30) break;
        const reach = (a.cls.length + b.cls.length) / 2;
        const apart = Math.abs(a.lateral - b.lateral) >= a.cls.half + b.cls.half + SIDE_GAP - SLACK - 0.05;
        if (d >= reach + ALONG_GAP) {
          if (apart && d < reach + ALONG_GAP + MERGE_GAP * (6 + 0.12 * a.v)) near.push(i, j);
          continue;
        }
        if (d < reach - 0.3 || apart) pairs.push(i, j);
      }
    }
    // Bit 1: has a car beside it, or close behind it in another lane: it keeps to its side of the road.
    for (let p = 0; p < pairs.length; p++) squeezed[pairs[p]] = 1;
    for (let p = 0; p < near.length; p += 2) squeezed[near[p]] = 1;
    // The cars that keep apart: those side by side, and a car with one close behind it in another lane that has to
    // keep to its side too (one that is free to tuck in behind is no concern of the car ahead).
    // (Those side by side last: where both cannot be had, it is the cars beside each other that must not touch.)
    const links = this.laneLinks;
    links.length = 0;
    for (let p = 0; p < near.length; p += 2) if (squeezed[near[p + 1]] === 1) links.push(near[p], near[p + 1], 1);
    for (let p = 0; p < pairs.length; p += 2) links.push(pairs[p], pairs[p + 1], 0);

    // Defending: a car with one coming up its inside for a braking zone shuts that side, once, if it sees it in time.
    if (!this.setup.session) {
      for (const car of cars) {
        const attack = car.attack;
        if (!attack || attack.answered || car.lungeUntilU > -Infinity) continue;
        const def = attack.target;
        const kd = mod(Math.floor(def.u), n);
        const zone = def.cls.nextZone[kd];
        if (zone < 0) continue;
        const z = def.model.zones[zone];
        const to = mod(z.station - kd, n) * ds;
        if (to > DEFEND_LOOK || z.inside !== attack.side || z.drop < DEFEND_DROP) continue;
        attack.answered = true;
        // Not for a car lapping it, nor one of another class; and too late once that car is beside it or the braking point is here.
        if (def.cls !== car.cls || car.u > def.u || to < DEFEND_LATE || this.aheadBy(def, car) < (def.cls.length + car.cls.length) / 2 + ALONG_GAP + 1) continue;
        if (def.attack || def.giveWay !== 0 || def.pitRequest || def.exitUntilU > def.u || def.offTrack || this.noPassing(def)) continue;
        if (def.rng() > COVER_LEAST + COVER_SKILL * def.driver.racecraft) continue;
        def.coverSide = attack.side;
        def.coverUntilU = def.u + mod(z.apex - kd, n);
      }
    }

    for (let i = 0; i < N; i++) {
      const car = cars[i];
      const k = mod(Math.floor(car.u), n);
      const half = Math.max(0, widths[k] / 2 - car.cls.half - EDGE_GAP);
      lo[i] = -half - line.offset[k];
      hi[i] = half - line.offset[k];
      const closed = this.noPassing(car);

      // An attack ends beside its target (then the two sort it out), when the target is gone, or when it has come to nothing.
      const attack = car.attack;
      let chasing = false;
      if (attack) {
        const tgt = attack.target;
        const d = this.aheadBy(tgt, car);
        const reach = (car.cls.length + tgt.cls.length) / 2 + ALONG_GAP;
        const lunging = car.lungeUntilU > -Infinity;
        if (tgt.status !== 'running' || tgt.offTrack || closed || d > ATTACK_LOST || d < -reach || (lunging ? car.u > car.lungeUntilU : d >= reach && car.u > attack.untilU)) {
          car.attack = null;
          if (d >= reach) {
            car.nextTry = this.t + TRY_AGAIN;
            if (lunging && tgt.status === 'running') {
              // Braked too late for nothing: it runs deep and falls back in line.
              car.delay += LUNGE_MISSED;
              car.delayShare = Math.max(car.delayShare, 0.35);
            }
          }
          car.lungeUntilU = -Infinity;
        } else if (d >= reach) {
          chasing = true;
          // The door is shut on that side: round the other.
          if (!lunging && tgt.coverUntilU > tgt.u && tgt.coverSide === attack.side) attack.side = -attack.side as 1 | -1;
          // Coming to a corner and not beside it yet: on into it if it will be level enough there, else fall back in line.
          if (!lunging && this.cornerSoon(car, k) && !this.intoCorner(car, tgt, d, attack.side, k)) {
            car.attack = null;
            car.nextTry = this.t + TRY_AGAIN;
            chasing = false;
          }
        }
      }

      let want = 0;
      if (car.exitUntilU > car.u && pit) want = this.pitSide * 1e3;
      else if (car.pitRequest && pit && mod(pit.entry - car.u, n) * ds < ENTRY_ROAD) want = this.pitSide * 1e3;
      else if (this.regrid?.lateral.has(car.id)) want = this.regrid.lateral.get(car.id)!;
      else if (closed) want = 0;
      else if (chasing) want = attack!.target.lateral + attack!.side * (car.cls.half + attack!.target.cls.half + SIDE_GAP);
      else if (car.coverUntilU > car.u) {
        // Shutting the inside: over until a car does not fit there, and no further once one is beside it.
        const edge = car.coverSide > 0 ? hi[i] : lo[i];
        want = squeezed[i] === 1 ? car.lateral : edge - car.coverSide * (2 * car.cls.half + SIDE_GAP - COVER_SHORT);
        if ((want - car.lateral) * car.coverSide < 0) want = car.lateral;
      } else if (car.giveWay !== 0) want = car.giveWay * GIVE_WAY_ASIDE;
      else if (squeezed[i] === 1 && !this.cornerSoon(car, k)) want = car.lateral;
      // (Off the grid a car jinks out from behind another at little more than walking pace.)
      const rate = Math.min(SIDEWAYS, Math.max(SIDEWAYS_SLOPE * car.v, this.away(car) && car.v > 2 ? AWAY_SIDEWAYS : 0)) * DT;
      const to = car.lateral + Math.max(-rate, Math.min(rate, want - car.lateral));
      next[i] = to < lo[i] ? lo[i] : to > hi[i] ? hi[i] : to;
      squeezed[i] = -1;
    }

    for (let pass = 0; pass < 3; pass++) {
      for (let p = 0; p < links.length; p += 3) {
        const i = links[p];
        const j = links[p + 1];
        const apartOnly = links[p + 2] === 1;
        const a = cars[i];
        const b = cars[j];
        // Which side of `a` the other car is on: as they stand; in the same spot, where it has more room.
        let dir = Math.sign(b.lateral - a.lateral);
        if (dir === 0) dir = hi[j] - b.lateral > b.lateral - lo[j] ? 1 : -1;
        const deficit = a.cls.half + b.cls.half + SIDE_GAP - (next[j] - next[i]) * dir;
        if (deficit <= 1e-6) continue;
        const roomA = Math.max(0, dir > 0 ? next[i] - lo[i] : hi[i] - next[i]);
        const roomB = Math.max(0, dir > 0 ? hi[j] - next[j] : next[j] - lo[j]);
        const lead = apartOnly || mod(a.u - b.u, n) * ds >= LEVEL;
        let ma: number;
        let mb: number;
        if (lead) {
          mb = Math.min(roomB, deficit);
          ma = Math.min(roomA, deficit - mb);
          // From here on `b` keeps clear of `a` on this side, whoever else pushes it (a car between two others has no
          // room at all). Not for one that is merely close behind in the next lane: pushed across, it is behind `a`.
          if (!apartOnly) {
            const bound = next[i] - dir * ma + dir * (a.cls.half + b.cls.half + SIDE_GAP);
            if (dir > 0) lo[j] = Math.min(hi[j], Math.max(lo[j], bound));
            else hi[j] = Math.max(lo[j], Math.min(hi[j], bound));
          }
        } else {
          ma = Math.min(roomA, deficit / 2);
          mb = Math.min(roomB, deficit - ma);
          ma = Math.min(roomA, deficit - mb);
        }
        next[i] -= dir * ma;
        next[j] += dir * mb;
        // No room for both, or the car with the right to the road kept off its line by one with nowhere to go.
        // (Not a car that is merely close behind in the next lane: it is not beside the other, and keeps its place.)
        if (!apartOnly && pass === 2 && (deficit - ma - mb > 0.02 || (lead && ma > 0.005 && roomB - mb < 0.005))) squeezed[j] = i;
      }
    }

    for (let i = 0; i < N; i++) {
      const car = cars[i];
      car.lateral = next[i];
      car.lane = 0;
      car.flank = 0;
    }
    for (let p = 0; p < pairs.length; p += 2) {
      const a = cars[pairs[p]];
      const b = cars[pairs[p + 1]];
      const left = b.lateral > a.lateral ? b : a;
      const right = left === a ? b : a;
      left.flank |= 2;
      right.flank |= 1;
    }
    // A corner takes two abreast: of three, the one furthest back drops in behind before they turn in.
    for (let i = 0; i < N; i++) {
      const mid = cars[i];
      if (mid.flank !== 3 || !this.cornerSoon(mid, mod(Math.floor(mid.u), n))) continue;
      let rear = i;
      let other = -1;
      for (let p = 0; p < pairs.length; p += 2) {
        const j = pairs[p] === i ? pairs[p + 1] : pairs[p + 1] === i ? pairs[p] : -1;
        if (j < 0) continue;
        if (cars[j].u < cars[rear].u) {
          other = rear;
          rear = j;
        } else if (other < 0 || rear === i) other = other < 0 ? j : other;
      }
      if (squeezed[rear] < 0) squeezed[rear] = rear === i ? other : i;
    }
    for (let i = 0; i < N; i++) cars[i].squeezed = squeezed[i] >= 0 ? cars[squeezed[i]] : null;
    // Each car of a pair has its side of the road; of two that keep apart without being side by side, the one off the racing line.
    for (let p = 0; p < links.length; p += 3) {
      const a = cars[links[p]];
      const b = cars[links[p + 1]];
      const both = links[p + 2] === 0;
      const left = b.lateral > a.lateral ? b : a;
      const right = left === a ? b : a;
      if (both || left.lateral > ON_LINE) left.lane = left.lane === -1 || left.lane === 2 ? 2 : 1;
      if (both || right.lateral < -ON_LINE) right.lane = right.lane === 1 || right.lane === 2 ? 2 : -1;
    }

    // A car that comes up beside another from behind is fighting it for its place.
    for (let p = 0; p < pairs.length; p += 2) {
      const a = cars[pairs[p]];
      const b = cars[pairs[p + 1]];
      if (b.beside.some((f) => f.car === a) || a.beside.some((f) => f.car === b)) continue;
      b.beside.push({ car: a, place: a.position, classPlace: a.classPosition });
    }
    for (const car of cars) {
      if (!car.beside.length) continue;
      car.beside = car.beside.filter((f) => {
        const o = f.car;
        if (o.status !== 'running') return false;
        const d = this.aheadBy(car, o);
        const clear = (car.cls.length + o.cls.length) / 2 + ALONG_GAP;
        if (d >= clear) {
          // No reply at once: the car passed lifts, falls in behind and needs a while to line one up.
          o.nextTry = Math.max(o.nextTry, this.t + TRY_AGAIN);
          // (Not on the run from the grid to the first corner, where places change hands as the starts go.)
          // (Nor where there is no passing: two cars side by side when the race is neutralised fall into line as
          // they are, the one ahead in front, and that is no overtake.)
          if (!this.setup.session && car.cls === o.cls && car.u > o.u && car.u - o.u < n / 2 && o.exitUntilU <= o.u && !o.offTrack && !(car.lapsDone === 0 && car.u < this.firstZoneU)
            && !this.noPassing(car)) {
            this.passed(car, o, f.place, f.classPlace);
          }
          return false;
        }
        return d > -clear - 2;
      });
    }

    // Out of the way of a car coming to lap it, where that costs nothing; back once it is clear ahead.
    for (let i = 0; i < N; i++) {
      const def = cars[i];
      let to: RaceCar | null = null;
      if (!def.attack && !def.pitRequest && def.exitUntilU <= def.u && !this.noPassing(def)) {
        // Still letting the same car by: until it is clear ahead, or has dropped away.
        const was = def.giveWayTo;
        if (was && was.status === 'running') {
          const d = this.aheadBy(was, def);
          if (d < (def.cls.length + was.cls.length) / 2 + ALONG_GAP && d > -GIVE_WAY_GAP * Math.max(was.v, 20)) to = was;
        }
        for (let s = 1; !to && s < Math.min(N, 4); s++) {
          const c = cars[(i + s) % N];
          if (mod(def.u - c.u, n) * ds > GIVE_WAY_GAP * Math.max(c.v, 20)) break;
          if (this.makesWay(def, c) || (c.heldBy === def && c.cls === def.cls && this.yields(def, c))) to = c;
        }
      }
      let side: 0 | 1 | -1 = 0;
      if (to) {
        // Off the racing line to the side with more road, where no corner holds that side (once aside, it stays there).
        side = def.giveWay;
        const k = mod(Math.floor(def.u), n);
        const left = hi[i] - def.lateral;
        const right = def.lateral - lo[i];
        if (side === 0 || (side > 0 ? left : right) < 0.5) side = left > right ? 1 : -1;
        if (def.giveWay === 0 && this.cornerSoon({ model: def.model, lateral: side } as RaceCar, k)) side = 0;
      }
      def.giveWay = side;
      def.giveWayTo = side !== 0 ? to : null;
    }
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
    const lapping = this.yields(def, car);
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

  /** Whether `def` lets `car` by without a fight: in a race, a backmarker being lapped. */
  protected yields(def: RaceCar, car: RaceCar): boolean {
    return car.u > def.u;
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
      this.trackIncident(victim.u, 'crash', this.t, victim);
    } else {
      this.log('contact', this.t, `Contact between ${a.entrant.code} and ${b.entrant.code}${where}`, a.id, lap, b.id);
      this.trackIncident(a.u, 'contact', this.t, a);
    }
  }

  private detectDrs(car: RaceCar, u: number, t: number, region: number): void {
    const drs = car.rules.drs;
    if (!drs || region < 0) return;
    // Shut under a neutralisation and on a wet track.
    if (this.phase === 'green' && this.wetness <= DRS_WET) {
      const near = this.nearestAhead(car);
      const gap = near ? t - near.car.drsCross[region] : Infinity;
      if (this.drsAllowed(car, gap)) car.drsUntilU = u + car.model.drs[region].length;
    }
    car.drsCross[region] = t;
  }

  /** Whether a car may open its wing at a detection point, `gap` seconds behind the car ahead: in a race, within the class's gap from its set lap. */
  protected drsAllowed(car: RaceCar, gap: number): boolean {
    const drs = car.rules.drs!;
    return car.lapsDone + 1 >= drs.fromLap && gap >= 0 && gap <= drs.gap;
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
      if (d > this.n / 2 && this.phase !== 'green') {
        // The race is neutralised before the attacker got ahead: no passing now, it lines up behind again.
        car.passing = null;
        continue;
      }
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
      this.passed(car, def);
    }
  }

  /**
   * A pass completed, for the place `def` held (in the race and in its
   * class): a real overtake in the class is news, a leader lapping a
   * backmarker is not.
   */
  protected passed(car: RaceCar, def: RaceCar, place = def.position, classPlace = def.classPosition): void {
    if (car.cls !== def.cls || car.u <= def.u || car.u - def.u >= this.n / 2) return;
    const where = this.where(car.u - 60 / this.ds);
    const text = this.multiClass
      ? `${car.entrant.code} passes ${def.entrant.code} for ${car.cls.label} P${classPlace}${where}`
      : `${car.entrant.code} passes ${def.entrant.code} for P${place}${where}`;
    this.log('overtake', this.t, text, car.id, car.lapsDone + 1, def.id);
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
      else if (this.regrid?.lateral.has(car.id)) target = this.regrid.lateral.get(car.id)!;
      target = Math.max(-half - this.model.line.offset[k], Math.min(half - this.model.line.offset[k], target));
      const step = 3 * DT;
      car.lateral += Math.max(-step, Math.min(step, target - car.lateral));
    }
  }

  protected updateOrder(): void {
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

  protected updateClassOrder(): void {
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

  protected log(kind: RaceEventKind, t: number, text: string, car: number, lap = this.leaderLap, other?: number): void {
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
