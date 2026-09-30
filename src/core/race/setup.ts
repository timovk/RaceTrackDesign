/**
 * Race settings (saved in the project) and everything decided before the
 * lights go out: the entry list, a qualifying session and the grid.
 */
import { seededRandom } from '../rng.ts';
import type { VehicleClass } from '../vehicles.ts';
import { type Entrant, gauss, generateField, shuffle } from './field.ts';
import type { RaceModel } from './model.ts';
import type { RaceRules } from './rules.ts';

export type GridOrder = 'qualifying' | 'reversed' | 'random';

export interface RaceSettings {
  vehicleId: string;
  cars: number;
  /** Race by laps (with the class's time limit, if any) or by time. */
  kind: 'laps' | 'time';
  laps: number;
  minutes: number;
  grid: GridOrder;
  seed: string;
}

export interface QualifyingEntry {
  car: number;
  time: number;
}

export interface RaceSetup {
  model: RaceModel;
  settings: RaceSettings;
  entrants: Entrant[];
  /** Fastest first. */
  qualifying: QualifyingEntry[];
  /** Entrant index per grid slot, pole first. */
  grid: number[];
  laps: number | null;
  /** Seconds, for a race by time. */
  duration: number | null;
  /** Seconds after which the leader's next crossing ends a race by laps. */
  timeLimit: number | null;
}

export const MAX_CARS = 40;
export const MAX_LAPS = 1000;
export const MAX_MINUTES = 24 * 60;

/** The class's usual race on a track of this length. */
export function defaultRaceSettings(vehicle: VehicleClass, rules: RaceRules, lapLength: number, lapTime: number, seed: string): RaceSettings {
  const byTime = rules.race.duration !== null;
  const laps = rules.race.distance !== null
    ? Math.ceil(rules.race.distance / lapLength)
    : Math.max(1, Math.round((rules.race.duration ?? 3600) / (lapTime * 1.02)));
  return {
    vehicleId: vehicle.id,
    cars: Math.min(MAX_CARS, rules.field.cars),
    kind: byTime ? 'time' : 'laps',
    laps: Math.min(MAX_LAPS, Math.max(1, laps)),
    minutes: byTime ? Math.round((rules.race.duration ?? 3600) / 60) : Math.max(5, Math.round((laps * lapTime * 1.02) / 60)),
    grid: 'qualifying',
    seed,
  };
}

/** Checks saved settings; returns null when they are missing or unusable. */
export function parseRaceSettings(raw: unknown, vehicleIds: readonly string[]): RaceSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
  const vehicleId = typeof r.vehicleId === 'string' && vehicleIds.includes(r.vehicleId) ? r.vehicleId : null;
  const cars = int(r.cars, 1, MAX_CARS);
  const laps = int(r.laps, 1, MAX_LAPS);
  const minutes = int(r.minutes, 1, MAX_MINUTES);
  if (!vehicleId || cars === null || laps === null || minutes === null) return null;
  return {
    vehicleId,
    cars,
    kind: r.kind === 'time' ? 'time' : 'laps',
    laps,
    minutes,
    grid: r.grid === 'reversed' || r.grid === 'random' ? r.grid : 'qualifying',
    seed: typeof r.seed === 'string' || typeof r.seed === 'number' ? String(r.seed) : '1',
  };
}

export function createRaceSetup(model: RaceModel, settings: RaceSettings): RaceSetup {
  const rng = seededRandom(`${settings.seed}:field:${settings.vehicleId}`);
  const entrants = generateField(model.rules, settings.cars, rng);
  const qualifying = runQualifying(model, entrants, seededRandom(`${settings.seed}:qualifying`));
  let grid = qualifying.map((q) => q.car);
  if (settings.grid === 'reversed') grid = grid.reverse();
  else if (settings.grid === 'random') grid = shuffle(grid, seededRandom(`${settings.seed}:grid`));
  return {
    model,
    settings,
    entrants,
    qualifying,
    grid,
    laps: settings.kind === 'laps' ? settings.laps : null,
    duration: settings.kind === 'time' ? settings.minutes * 60 : null,
    timeLimit: settings.kind === 'laps' ? model.rules.race.timeLimit : null,
  };
}

/**
 * Three flying laps each on fresh tyres and low fuel: the qualifying lap
 * from the lap-time model scaled by the car and driver, with the driver's
 * scatter and the odd mistake. The best lap counts.
 */
export function runQualifying(model: RaceModel, entrants: Entrant[], rng: () => number): QualifyingEntry[] {
  const out = entrants.map((e) => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      let time = model.qualifyingTime * e.pace * (1 + gauss(rng) * e.consistency * 0.6);
      if (rng() < 0.08 * e.errorRate) time *= 1 + 0.005 + 0.02 * rng();
      best = Math.min(best, time);
    }
    return { car: e.index, time: best };
  });
  return out.sort((a, b) => a.time - b.time);
}
