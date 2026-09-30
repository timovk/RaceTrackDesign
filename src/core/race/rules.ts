/**
 * Race rules per vehicle class from data/racing.json: grid size, crews and
 * pace spread, default race length and start, tyres (dry and wet), fuel, pit
 * stops and driver changes, DRS, slipstream, incident rates and how race
 * control neutralises the race. Percentages in the file become fractions
 * here. A class missing from the file gets generic defaults for its kind.
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
  /** Driver change time and the longest a driver stays in the car (seconds; 0 for no limit). */
  pit: { stops: boolean; tyreChange: number; concurrent: boolean; minStops: number; minStationary: number; driverChange: number; driverStint: number };
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
  };
}

const FILE = isObject(data) && isObject((data as Json).classes) ? ((data as Json).classes as Json) : {};

/** Rules for a class: from data/racing.json, or defaults for its kind. */
export function raceRules(vehicle: Pick<VehicleClass, 'id' | 'kind' | 'drs'>): RaceRules {
  return parseRaceRules(FILE[vehicle.id], vehicle);
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
