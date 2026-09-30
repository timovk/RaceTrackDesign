/**
 * Race rules per vehicle class from data/racing.json: grid size and pace
 * spread, default race length, tyres, fuel, pit stops, DRS, slipstream and
 * incident rates. Percentages in the file become fractions here. A class
 * missing from the file gets generic defaults for its kind.
 */
import data from '../../../data/racing.json' with { type: 'json' };
import type { VehicleClass } from '../vehicles.ts';

export interface Compound {
  name: string;
  /** One letter for the timing tower. */
  code: string;
  color: string;
  /** Lap-time fraction slower than the fastest compound, both new. */
  offset: number;
  /** Distance to the end of the tyre's life on a reference track, in metres. */
  life: number;
  /** Lap-time fraction lost at the end of that life. */
  deg: number;
}

export interface RaceRules {
  field: { cars: number; perTeam: number; carSpread: number; driverSpread: number };
  /** Default length: a distance (laps rounded up) or a duration, plus an optional time limit in seconds. */
  race: { distance: number | null; duration: number | null; timeLimit: number | null };
  pace: { race: number; consistency: number; overtaking: number };
  fuel: { perMetre: number; capacity: number; refuelRate: number };
  tyres: { mustUseTwo: boolean; compounds: Compound[] };
  pit: { stops: boolean; tyreChange: number; concurrent: boolean; minStops: number; minStationary: number };
  /** Null when the class has no DRS. */
  drs: { fromLap: number; gap: number } | null;
  air: { towDragCut: number; wakeDownforceLoss: number };
  incidents: { mistake: number; off: number; crash: number; dnfPerMetre: number };
  /** Average wheel energy (J/m) and tyre work per metre on the reference circuits; 0 when unknown. */
  reference: { energy: number; tyreWork: number };
}

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
  const ref = group('reference');

  const compoundsRaw = Array.isArray(tyres.compounds) && tyres.compounds.length ? tyres.compounds : [{}];
  const compounds = compoundsRaw.map((c, i): Compound => {
    const g = isObject(c) ? c : {};
    const name = typeof g.name === 'string' && g.name.trim() ? g.name : `Compound ${i + 1}`;
    return {
      name,
      code: typeof g.code === 'string' && g.code.trim() ? g.code.trim().slice(0, 2) : name[0].toUpperCase(),
      color: typeof g.color === 'string' ? g.color : '#d0d4da',
      offset: num(g, 'offsetPct', 0, 0, 20) / 100,
      life: num(g, 'lifeKm', 200, 5, 5000) * 1000,
      deg: num(g, 'degPct', 1.5, 0, 20) / 100,
    };
  });

  const distanceKm = race.distanceKm === undefined ? null : num(race, 'distanceKm', 100, 1, 10000);
  const minutes = race.minutes === undefined ? null : num(race, 'minutes', 60, 1, 1440 * 2);
  const maxMinutes = race.maxMinutes === undefined ? null : num(race, 'maxMinutes', 120, 1, 1440 * 2);
  const hasDrs = vehicle.drs > 0 && isObject(r.drs);
  const drs = group('drs');

  return {
    field: {
      cars: Math.round(num(field, 'cars', 20, 1, 80)),
      perTeam: Math.round(num(field, 'perTeam', 2, 1, 4)),
      carSpread: num(field, 'carSpreadPct', 0.3, 0, 5) / 100,
      driverSpread: num(field, 'driverSpreadPct', 0.4, 0, 5) / 100,
    },
    race: {
      distance: distanceKm === null && minutes === null ? 100_000 : distanceKm === null ? null : distanceKm * 1000,
      duration: distanceKm === null && minutes !== null ? minutes * 60 : null,
      timeLimit: maxMinutes === null ? null : maxMinutes * 60,
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
