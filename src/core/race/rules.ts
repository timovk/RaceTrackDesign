/**
 * Race rules per vehicle class from data/racing.json: grid size, crews and
 * pace spread, default race length and start, tyres (dry and wet), fuel, pit
 * stops and driver changes, DRS, slipstream, incident rates, how race
 * control neutralises the race and what the stewards give for contact.
 * Percentages in the file become fractions here. A class missing from the
 * file gets generic defaults for its kind.
 */
import data from '../../../data/racing.json' with { type: 'json' };
import type { VehicleClass } from '../vehicles.ts';

/** Slicks for a dry track, intermediates for a damp or wet one, full wets for heavy rain. */
export type TyreType = 'slick' | 'inter' | 'wet';

export interface Compound {
  name: string;
  /** One letter for the timing tower. */
  code: string;
  color: string;
  type: TyreType;
  /** Lap-time fraction slower than the fastest compound, both new (dry compounds; wet tyres take their pace from the conditions). */
  offset: number;
  /** Distance to the end of the tyre's life on a reference track, in metres. */
  life: number;
  /** Lap-time fraction lost at the end of that life. */
  deg: number;
}

export interface RaceRules {
  /** Short class name for badges ("HYP") and its colour. */
  label: string;
  color: string;
  /** Drivers per car share the driving in stints. */
  field: { cars: number; perTeam: number; drivers: number; carSpread: number; driverSpread: number };
  /** Default length: a distance (laps rounded up) or a duration, plus an optional time limit in seconds; a standing or rolling start. */
  race: { distance: number | null; duration: number | null; timeLimit: number | null; start: 'standing' | 'rolling' };
  pace: { race: number; consistency: number; overtaking: number };
  fuel: { perMetre: number; capacity: number; refuelRate: number };
  tyres: { mustUseTwo: boolean; compounds: Compound[] };
  /** Driver change time, the longest a driver stays in the car (seconds; 0 for no limit), and the time repairing contact damage adds to a stop. */
  pit: { stops: boolean; tyreChange: number; concurrent: boolean; minStops: number; minStationary: number; driverChange: number; driverStint: number; repair: number };
  /** Null when the class has no DRS. */
  drs: { fromLap: number; gap: number } | null;
  air: { towDragCut: number; wakeDownforceLoss: number };
  incidents: { mistake: number; off: number; crash: number; dnfPerMetre: number };
  /**
   * How race control neutralises the race when a car stops on track: a
   * safety car, and a virtual safety car (everyone a share slower than the
   * race lap) or a full course yellow (a speed limit, m/s), or neither.
   */
  flags: { safetyCar: boolean; virtual: 'vsc' | 'fcy' | null; vscSlower: number; fcySpeed: number };
  /** Average wheel energy (J/m) and tyre work per metre on the reference circuits; 0 when unknown. */
  reference: { energy: number; tyreWork: number };
  /** What the stewards give for contact, and how it is served. */
  stewards: StewardRules;
  /** The race weekend: practice, qualifying, red flags, and how much quicker the track gets as it rubbers in. */
  weekend: WeekendRules;
}

/**
 * A penalty: seconds (stood still at the next pit stop, or added to the
 * race time), a drive through the pit lane without stopping, or a warning
 * that costs nothing.
 */
export type Penalty = { kind: 'time'; seconds: number } | { kind: 'driveThrough' } | { kind: 'warning' };

/** The series' penalties for causing a collision or forcing a car off the road. */
export interface StewardRules {
  /** The penalty, and the one given in mitigating circumstances. */
  collision: Penalty;
  lesser: Penalty;
  /** A time penalty is stood still in the box before the work of the car's next pit stop (and added to its race time when it makes none); false: always added. */
  timeAtStop: boolean;
  /** How often a car may cross the line before it comes in for a drive-through. */
  serveLaps: number;
  /** The car has to cross the line under green before it comes in. */
  afterLine: boolean;
  /** A drive-through given in the last laps, or in the last seconds of the race, is not driven: time is added. */
  lateLaps: number;
  lateTime: number;
  /** The time added for a drive-through that is not driven; 0: what the pit lane costs at this circuit, to the next five seconds (the series sets it per event). */
  driveThroughTime: number;
  /** Contact on the first lap is judged more leniently. */
  firstLapLenient: boolean;
  /** Incidents are looked at after the race, unless it is completely clear who was at fault. */
  afterRace: boolean;
}

export interface PracticeSession {
  name: string;
  minutes: number;
  /** Day of the weekend (1 = the first); the track loses some rubber overnight. */
  day: number;
  /** Teams run their race simulations (long runs on race fuel) in this session. */
  longRuns: boolean;
}

/**
 * Where the cars of a qualifying stage come from: a result so far (a stage
 * by name, or "practice": the best laps over the practice sessions listed,
 * 1-based, or all of them), and which of its cars: the best `count`, the
 * rest after them, or every other car (odd or even places, for groups).
 */
export interface StageSource {
  from: string;
  take: 'top' | 'rest' | 'odd' | 'even';
  count: number;
  practice?: number[];
}

/** One stage of qualifying: a session and who takes part (everyone when `entry` is empty). */
export interface QualifyingStage {
  name: string;
  minutes: number;
  entry: StageSource[];
  /** For crews: the driver who drives (0 = the fastest); missing for the team's choice (the fastest). */
  driver?: number;
}

export interface WeekendRules {
  practice: PracticeSession[];
  qualifyingDay: number;
  /**
   * Qualifying stages in the order they run. A car's grid place comes from
   * the last stage it took part in (later stages in front; stages run side
   * by side as groups share their places in turn), or, with `average`, from
   * the mean of its best laps over the stages.
   */
  qualifying: QualifyingStage[];
  /** Knockout counts are for this many cars; with more or fewer, as many go out at each step, the last stage keeping its size. */
  knockout: boolean;
  average: boolean;
  /** Lap-time fraction a green track gives away against one fully rubbered in. */
  evolution: number;
  redFlag: RedFlagRules;
}

export interface RedFlagRules {
  /** Where the cars wait: queued at the pit exit, or stopped in single file on track before the line. */
  stopAt: 'pitlane' | 'track';
  /** Whether the time a race is stopped is added to its time limit (or duration). */
  raceClockStops: boolean;
  /** How the race resumes: a standing start from the grid, or behind the safety car (rolling, also always on a wet track with `rollingWhenWet`). */
  restart: 'standing' | 'rolling';
  rollingWhenWet: boolean;
  /** Whether the tyres may be changed while the race is stopped. */
  work: boolean;
  /** A race not resumed is classified this many laps before the lap the red flag came out on. */
  resultLapsBack: number;
  /** Share of the distance after which a stopped race is over rather than restarted (bikes), or null. */
  completeAt: number | null;
  /** Whether rain alone can stop the race (bikes race on, changing bikes). */
  rain: boolean;
  /** Shortest and longest a race stays stopped while the track is cleared, seconds. */
  clear: [number, number];
  /** Whether a session's clock stops while it is red-flagged. */
  sessionClockStops: { practice: boolean; qualifying: boolean };
  /** What a car that brings out a red flag in qualifying loses: nothing, its best lap, its two best, or every time. */
  qualifyingPenalty: 'none' | 'best' | 'best2' | 'all';
}

const TYRE_TYPES: readonly TyreType[] = ['slick', 'inter', 'wet'];
/** Added to a class that lists no wet-weather tyre. */
const DEFAULT_WET = { name: 'Wet', code: 'W', color: '#3fb6ff', type: 'wet', lifeKm: 150, degPct: 1.5 };

type Json = Record<string, unknown>;

export function parseRaceRules(raw: unknown, vehicle: Pick<VehicleClass, 'id' | 'kind' | 'drs'>): RaceRules {
  const r = isObject(raw) ? raw : {};
  const where = `Race rules "${vehicle.id}"`;
  const group = (key: string): Json => (isObject(r[key]) ? (r[key] as Json) : {});
  const num = (g: Json, key: string, fallback: number, min: number, max: number): number => {
    const v = g[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${where}: "${key}" must be a number between ${min} and ${max}.`);
    return v;
  };
  const bool = (g: Json, key: string, fallback: boolean): boolean => (typeof g[key] === 'boolean' ? (g[key] as boolean) : fallback);
  const bike = vehicle.kind === 'bike';

  const field = group('field');
  const race = group('race');
  const pace = group('pace');
  const fuel = group('fuel');
  const tyres = group('tyres');
  const pit = group('pit');
  const air = group('air');
  const inc = group('incidents');
  const flags = group('flags');
  const ref = group('reference');
  const stewards = group('stewards');
  const penalty = (key: string, fallback: Penalty): Penalty => {
    const v = stewards[key];
    if (v === undefined || v === null) return fallback;
    if (v === 'driveThrough') return { kind: 'driveThrough' };
    if (v === 'warning') return { kind: 'warning' };
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 600) throw new Error(`${where}: "${key}" must be seconds (up to 600), "driveThrough" or "warning".`);
    return { kind: 'time', seconds: v };
  };

  const compoundsRaw = Array.isArray(tyres.compounds) && tyres.compounds.length ? [...tyres.compounds] : [{}];
  if (!compoundsRaw.some((c) => isObject(c) && (c.type === 'inter' || c.type === 'wet'))) compoundsRaw.push(DEFAULT_WET);
  const compounds = compoundsRaw.map((c, i): Compound => {
    const g = isObject(c) ? c : {};
    const name = typeof g.name === 'string' && g.name.trim() ? g.name : `Compound ${i + 1}`;
    const type = TYRE_TYPES.includes(g.type as TyreType) ? (g.type as TyreType) : 'slick';
    return {
      name,
      code: typeof g.code === 'string' && g.code.trim() ? g.code.trim().slice(0, 2) : name[0].toUpperCase(),
      color: typeof g.color === 'string' ? g.color : '#d0d4da',
      type,
      offset: type === 'slick' ? num(g, 'offsetPct', 0, 0, 20) / 100 : 0,
      life: num(g, 'lifeKm', 200, 5, 5000) * 1000,
      deg: num(g, 'degPct', 1.5, 0, 20) / 100,
    };
  });
  if (!compounds.some((c) => c.type === 'slick')) throw new Error(`${where}: at least one compound must be a slick.`);

  const distanceKm = race.distanceKm === undefined ? null : num(race, 'distanceKm', 100, 1, 10000);
  const minutes = race.minutes === undefined ? null : num(race, 'minutes', 60, 1, 1440 * 2);
  const maxMinutes = race.maxMinutes === undefined ? null : num(race, 'maxMinutes', 120, 1, 1440 * 2);
  const hasDrs = vehicle.drs > 0 && isObject(r.drs);
  const drs = group('drs');
  const virtual = flags.virtual === 'vsc' || flags.virtual === 'fcy' ? flags.virtual : flags.virtual === undefined && !bike ? 'vsc' : null;

  return {
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 5) : vehicle.id.slice(0, 4).toUpperCase(),
    color: typeof r.color === 'string' ? r.color : '#9aa4b1',
    field: {
      cars: Math.round(num(field, 'cars', 20, 1, 80)),
      perTeam: Math.round(num(field, 'perTeam', 2, 1, 4)),
      drivers: Math.round(num(field, 'drivers', 1, 1, 4)),
      carSpread: num(field, 'carSpreadPct', 0.3, 0, 5) / 100,
      driverSpread: num(field, 'driverSpreadPct', 0.4, 0, 5) / 100,
    },
    race: {
      distance: distanceKm === null && minutes === null ? 100_000 : distanceKm === null ? null : distanceKm * 1000,
      duration: distanceKm === null && minutes !== null ? minutes * 60 : null,
      timeLimit: maxMinutes === null ? null : maxMinutes * 60,
      start: race.start === 'rolling' ? 'rolling' : 'standing',
    },
    pace: {
      race: num(pace, 'racePct', 0.5, 0, 10) / 100,
      consistency: num(pace, 'consistencyPct', 0.3, 0, 5) / 100,
      overtaking: num(pace, 'overtaking', bike ? 1.6 : 1.1, 0, 5),
    },
    fuel: {
      perMetre: num(fuel, 'kgPerKm', bike ? 0.15 : 0.4, 0, 10) / 1000,
      capacity: num(fuel, 'capacityKg', bike ? 20 : 100, 1, 1000),
      refuelRate: num(fuel, 'refuelKgPerS', 0, 0, 100),
    },
    tyres: { mustUseTwo: bool(tyres, 'mustUseTwo', false) && compounds.length > 1, compounds },
    pit: {
      stops: bool(pit, 'stops', !bike),
      tyreChange: num(pit, 'tyreChangeS', 10, 0, 300),
      concurrent: bool(pit, 'concurrent', false),
      minStops: Math.round(num(pit, 'minStops', 0, 0, 20)),
      minStationary: num(pit, 'minStationaryS', 0, 0, 600),
      driverChange: num(pit, 'driverChangeS', 25, 0, 300),
      driverStint: num(pit, 'driverStintMinutes', 0, 0, 1440) * 60,
      repair: num(pit, 'repairS', bike ? 0 : 30, 0, 3600),
    },
    drs: hasDrs ? { fromLap: Math.round(num(drs, 'fromLap', 3, 1, 100)), gap: num(drs, 'gapS', 1, 0.1, 5) } : null,
    air: {
      towDragCut: num(air, 'towDragCut', bike ? 0.3 : 0.2, 0, 0.8),
      wakeDownforceLoss: num(air, 'wakeDownforceLoss', bike ? 0 : 0.15, 0, 0.8),
    },
    incidents: {
      mistake: num(inc, 'mistakePerLap', 0.02, 0, 1),
      off: num(inc, 'offPerLap', 0.003, 0, 1),
      crash: num(inc, 'crashPerLap', bike ? 0.004 : 0.0004, 0, 1),
      dnfPerMetre: num(inc, 'dnfPer1000Km', 0.15, 0, 100) / 1_000_000,
    },
    flags: {
      safetyCar: bool(flags, 'safetyCar', !bike),
      virtual,
      vscSlower: num(flags, 'vscPct', 35, 5, 100) / 100,
      fcySpeed: num(flags, 'fcyKmh', 80, 20, 200) / 3.6,
    },
    reference: {
      energy: num(ref, 'energyMJPerKm', 0, 0, 1000) * 1000,
      tyreWork: num(ref, 'tyreWork', 0, 0, 1000),
    },
    stewards: {
      collision: penalty('collision', { kind: 'time', seconds: 10 }),
      lesser: penalty('lesser', { kind: 'time', seconds: 5 }),
      timeAtStop: bool(stewards, 'timeAtStop', true),
      serveLaps: Math.round(num(stewards, 'serveLaps', 2, 1, 10)),
      afterLine: bool(stewards, 'afterLine', false),
      lateLaps: Math.round(num(stewards, 'lateLaps', 3, 0, 20)),
      lateTime: num(stewards, 'lateMinutes', 0, 0, 120) * 60,
      driveThroughTime: num(stewards, 'driveThroughS', 20, 0, 300),
      firstLapLenient: bool(stewards, 'firstLapLenient', false),
      afterRace: bool(stewards, 'afterRace', false),
    },
    weekend: parseWeekend(group('weekend'), where, num, bool),
  };
}

type Num = (g: Json, key: string, fallback: number, min: number, max: number) => number;
type Bool = (g: Json, key: string, fallback: boolean) => boolean;

/**
 * The weekend group: practice sessions, the qualifying stages, track
 * evolution and the red-flag rules. Defaults: two hours of practice on the
 * first day, one qualifying session on the second, the race resuming behind
 * the safety car.
 */
function parseWeekend(w: Json, where: string, num: Num, bool: Bool): WeekendRules {
  const practiceRaw = Array.isArray(w.practice) ? w.practice : [{ name: 'Practice 1', minutes: 60 }, { name: 'Practice 2', minutes: 60, longRuns: true }];
  const practice = practiceRaw.map((p, i): PracticeSession => {
    const g = isObject(p) ? p : {};
    return {
      name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : `Practice ${i + 1}`,
      minutes: num(g, 'minutes', 60, 5, 600),
      day: Math.round(num(g, 'day', 1, 1, 7)),
      longRuns: bool(g, 'longRuns', practiceRaw.length === 1),
    };
  });
  const stagesRaw = Array.isArray(w.qualifying) && w.qualifying.length ? w.qualifying : [{ name: 'Qualifying', minutes: 30 }];
  const names = new Set<string>(['practice']);
  const stages = stagesRaw.map((s, i): QualifyingStage => {
    const g = isObject(s) ? s : {};
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : `Q${i + 1}`;
    if (names.has(name)) throw new Error(`${where}: qualifying stage "${name}" is named twice.`);
    const entry = (Array.isArray(g.entry) ? g.entry : []).map((e): StageSource => {
      const x = isObject(e) ? e : {};
      if (typeof x.from !== 'string' || !names.has(x.from)) throw new Error(`${where}: qualifying stage "${name}" takes cars from a result that does not come before it.`);
      const take = x.take === 'rest' || x.take === 'odd' || x.take === 'even' ? x.take : 'top';
      const practiceList = Array.isArray(x.practice) ? x.practice.filter((v): v is number => typeof v === 'number' && v >= 1 && v <= practice.length) : undefined;
      return { from: x.from, take, count: Math.round(num(x, 'count', 10, 0, 80)), practice: practiceList };
    });
    names.add(name);
    return { name, minutes: num(g, 'minutes', 15, 3, 240), entry, driver: g.driver === undefined ? undefined : Math.round(num(g, 'driver', 0, 0, 3)) };
  });
  const red = isObject(w.redFlag) ? w.redFlag : {};
  const penalty = red.qualifyingPenalty;
  const lastDay = Math.max(1, ...practice.map((p) => p.day));
  return {
    practice,
    qualifyingDay: Math.round(num(w, 'qualifyingDay', lastDay + (practice.length > 1 ? 0 : 1), 1, 7)),
    qualifying: stages,
    knockout: bool(w, 'knockout', false),
    average: bool(w, 'averageTimes', false),
    evolution: num(w, 'evolutionPct', 1, 0, 10) / 100,
    redFlag: {
      stopAt: red.stopAt === 'track' ? 'track' : 'pitlane',
      raceClockStops: bool(red, 'raceClockStops', false),
      restart: red.restart === 'standing' ? 'standing' : 'rolling',
      rollingWhenWet: bool(red, 'rollingWhenWet', false),
      work: bool(red, 'work', true),
      resultLapsBack: Math.round(num(red, 'resultLapsBack', 2, 0, 5)),
      completeAt: red.completeAtPct === undefined ? null : num(red, 'completeAtPct', 75, 1, 100) / 100,
      rain: bool(red, 'rain', true),
      clear: clearTimes(red, where),
      sessionClockStops: {
        practice: bool(red, 'practiceClockStops', false),
        qualifying: bool(red, 'qualifyingClockStops', true),
      },
      qualifyingPenalty: penalty === 'best' || penalty === 'best2' || penalty === 'all' ? penalty : 'none',
    },
  };
}

/** The clearing-up time of a stopped race: [shortest, longest] minutes in the file, 15 to 40 by default. */
function clearTimes(red: Json, where: string): [number, number] {
  const v = red.clearMinutes;
  if (v === undefined) return [900, 2400];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && x >= 1 && x <= 180) || v[0] > v[1]) {
    throw new Error(`${where}: "clearMinutes" must be [shortest, longest], 1 to 180 minutes.`);
  }
  return [v[0] * 60, v[1] * 60];
}

const FILE = isObject(data) && isObject((data as Json).classes) ? ((data as Json).classes as Json) : {};

/** Rules for a class: from data/racing.json, or defaults for its kind. */
export function raceRules(vehicle: Pick<VehicleClass, 'id' | 'kind' | 'drs'>): RaceRules {
  return parseRaceRules(FILE[vehicle.id], vehicle);
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
