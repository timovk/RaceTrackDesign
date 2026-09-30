/**
 * Race settings (saved in the project) and everything decided before the
 * lights go out: the entry list per class, qualifying, the grid (class by
 * class, the fastest class in front) and the weather.
 */
import { seededRandom } from '../rng.ts';
import type { VehicleClass } from '../vehicles.ts';
import { type Entrant, type FieldContext, gauss, generateField, shuffle } from './field.ts';
import type { RaceModel } from './model.ts';
import type { RaceRules } from './rules.ts';
import { type Weather, type WeatherKind, WEATHER_KINDS, buildWeather } from './weather.ts';

export type GridOrder = 'qualifying' | 'reversed' | 'random';

export interface RaceClassEntry {
  vehicleId: string;
  cars: number;
}

export interface RaceSettings {
  /** One or more classes racing together. */
  classes: RaceClassEntry[];
  /** Race by laps (with the class's time limit, if any) or by time. */
  kind: 'laps' | 'time';
  laps: number;
  minutes: number;
  grid: GridOrder;
  seed: string;
  weather: WeatherKind;
}

export interface QualifyingEntry {
  car: number;
  time: number;
}

export interface RaceSetup {
  /** One model per class, fastest class first; an entrant's classIndex points here. */
  models: RaceModel[];
  /** The fastest class's model: its rules run the race (start, flags, time limit). */
  model: RaceModel;
  settings: RaceSettings;
  entrants: Entrant[];
  /** Per class, fastest first. */
  qualifying: QualifyingEntry[][];
  /** Entrant index per grid slot, pole first, class by class. */
  grid: number[];
  laps: number | null;
  /** Seconds, for a race by time. */
  duration: number | null;
  /** Seconds after which the leader's next crossing ends a race by laps. */
  timeLimit: number | null;
  weather: Weather;
}

export const MAX_CARS = 60;
export const MAX_CLASSES = 4;
export const MAX_LAPS = 1000;
export const MAX_MINUTES = 24 * 60;

/** The class's usual race on a track of this length. */
export function defaultRaceSettings(vehicle: VehicleClass, rules: RaceRules, lapLength: number, lapTime: number, seed: string): RaceSettings {
  const byTime = rules.race.duration !== null;
  const laps = rules.race.distance !== null
    ? Math.ceil(rules.race.distance / lapLength)
    : Math.max(1, Math.round((rules.race.duration ?? 3600) / (lapTime * 1.02)));
  return {
    classes: [{ vehicleId: vehicle.id, cars: Math.min(MAX_CARS, rules.field.cars) }],
    kind: byTime ? 'time' : 'laps',
    laps: Math.min(MAX_LAPS, Math.max(1, laps)),
    minutes: byTime ? Math.round((rules.race.duration ?? 3600) / 60) : Math.max(5, Math.round((laps * lapTime * 1.02) / 60)),
    grid: 'qualifying',
    seed,
    weather: 'dry',
  };
}

/** Total cars over all classes. */
export function totalCars(settings: RaceSettings): number {
  return settings.classes.reduce((a, c) => a + c.cars, 0);
}

/** Checks saved settings; returns null when they are missing or unusable. Reads the single-class format of earlier versions too. */
export function parseRaceSettings(raw: unknown, vehicleIds: readonly string[]): RaceSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
  const list = Array.isArray(r.classes) ? r.classes : [{ vehicleId: r.vehicleId, cars: r.cars }];
  const classes: RaceClassEntry[] = [];
  let room = MAX_CARS;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    const vehicleId = typeof c.vehicleId === 'string' && vehicleIds.includes(c.vehicleId) ? c.vehicleId : null;
    const cars = int(c.cars, 1, MAX_CARS);
    if (!vehicleId || cars === null || classes.some((x) => x.vehicleId === vehicleId) || classes.length >= MAX_CLASSES || room < 1) continue;
    classes.push({ vehicleId, cars: Math.min(cars, room) });
    room -= Math.min(cars, room);
  }
  const laps = int(r.laps, 1, MAX_LAPS);
  const minutes = int(r.minutes, 1, MAX_MINUTES);
  if (!classes.length || laps === null || minutes === null) return null;
  return {
    classes,
    kind: r.kind === 'time' ? 'time' : 'laps',
    laps,
    minutes,
    grid: r.grid === 'reversed' || r.grid === 'random' ? r.grid : 'qualifying',
    seed: typeof r.seed === 'string' || typeof r.seed === 'number' ? String(r.seed) : '1',
    weather: WEATHER_KINDS.includes(r.weather as WeatherKind) ? (r.weather as WeatherKind) : 'dry',
  };
}

/**
 * Builds the field, qualifying, grid and weather. `models` holds one model
 * per entry of `settings.classes`, in the same order; classes are then
 * ordered fastest first.
 */
export function createRaceSetup(models: RaceModel | readonly RaceModel[], settings: RaceSettings): RaceSetup {
  const given = Array.isArray(models) ? models : [models as RaceModel];
  const order = settings.classes
    .map((c, i) => ({ entry: c, model: given[i] }))
    .filter((c) => c.model && c.entry.cars > 0)
    .sort((a, b) => a.model.qualifyingTime - b.model.qualifyingTime);
  if (!order.length) throw new Error('A race needs at least one class with cars.');

  const ctx: FieldContext = { classIndex: 0, firstIndex: 0, firstTeam: 0, numbers: new Set(), codes: new Set(), teamWords: new Set() };
  const entrants: Entrant[] = [];
  const qualifying: QualifyingEntry[][] = [];
  const grid: number[] = [];
  order.forEach(({ entry, model }, ci) => {
    ctx.classIndex = ci;
    ctx.firstIndex = entrants.length;
    ctx.firstTeam = entrants.length ? Math.max(...entrants.map((e) => e.teamIndex)) + 1 : 0;
    const field = generateField(model.rules, entry.cars, seededRandom(`${settings.seed}:field:${entry.vehicleId}`), ctx);
    entrants.push(...field);
    const q = runQualifying(model, field, seededRandom(`${settings.seed}:qualifying${ci ? `:${entry.vehicleId}` : ''}`));
    qualifying.push(q);
    let slots = q.map((x) => x.car);
    if (settings.grid === 'reversed') slots = slots.reverse();
    else if (settings.grid === 'random') slots = shuffle(slots, seededRandom(`${settings.seed}:grid${ci ? `:${entry.vehicleId}` : ''}`));
    grid.push(...slots);
  });

  const lead = order[0].model;
  const laps = settings.kind === 'laps' ? settings.laps : null;
  const duration = settings.kind === 'time' ? settings.minutes * 60 : null;
  const expected = duration ?? (lead.rules.race.timeLimit !== null ? Math.min(lead.rules.race.timeLimit, (laps ?? 1) * lead.lapTime * 1.05) : (laps ?? 1) * lead.lapTime * 1.05);
  return {
    models: order.map((c) => c.model),
    model: lead,
    settings,
    entrants,
    qualifying,
    grid,
    laps,
    duration,
    timeLimit: settings.kind === 'laps' ? lead.rules.race.timeLimit : null,
    weather: buildWeather(settings.weather, settings.seed, expected),
  };
}

/**
 * Three flying laps each on fresh tyres and low fuel, by the car's fastest
 * driver: the qualifying lap from the lap-time model scaled by the car and
 * driver, with the driver's scatter and the odd mistake. The best lap counts.
 */
export function runQualifying(model: RaceModel, entrants: Entrant[], rng: () => number): QualifyingEntry[] {
  const out = entrants.map((e) => {
    const d = e.drivers[0];
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      let time = model.qualifyingTime * e.pace * (1 + gauss(rng) * d.consistency * 0.6);
      if (rng() < 0.08 * d.errorRate) time *= 1 + 0.005 + 0.02 * rng();
      best = Math.min(best, time);
    }
    return { car: e.index, time: best };
  });
  return out.sort((a, b) => a.time - b.time);
}
