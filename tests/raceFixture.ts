// A flat four-corner circuit with its analysis, facilities and a race builder, shared by the race tests.
import { analyseTrack } from '../src/core/analysis.ts';
import { placeFacilities } from '../src/core/facilities.ts';
import { analysePerformance } from '../src/core/performance.ts';
import { buildRaceModel, type RaceModel } from '../src/core/race/model.ts';
import { raceRules, type RaceRules } from '../src/core/race/rules.ts';
import { MAX_CARS, type RaceSettings, createRaceSetup, defaultRaceSettings } from '../src/core/race/setup.ts';
import { RaceSim } from '../src/core/race/sim.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { buildTrack } from '../src/core/track.ts';
import { VEHICLES, type VehicleClass } from '../src/core/vehicles.ts';
import { bigRectangle, design } from './helpers.ts';

const raw = buildTrack(design(bigRectangle(), { smoothing: 0, maxCutFill: 0 }), () => 100)!;
const sf = placeStartFinish(raw);
export const track = rotateTrack(raw, sf.station);
export const metrics = analyseTrack(track);
export const performance = analysePerformance(track, VEHICLES);
export const facilities = placeFacilities({
  track, startFinish: sf, performance, vehicles: VEHICLES, heightAt: () => 100, waterLevel: -Infinity, extent: 8192, overrides: {},
});
export const car = (id: string) => VEHICLES.find((v) => v.id === id)!;

export function model(vehicle: VehicleClass, rules: RaceRules = raceRules(vehicle)): RaceModel {
  return buildRaceModel({ track, performance, facilities, vehicle, rules, gridSize: MAX_CARS, corners: metrics.corners });
}

/** Settings changes, with `cars` as a shorthand for the size of a single-class field. */
export type RaceChanges = Partial<RaceSettings> & { cars?: number };

/** Sets up a race without running it. */
export function start(vehicle: VehicleClass, changes: RaceChanges = {}, rules?: RaceRules): RaceSim {
  const m = model(vehicle, rules);
  const { cars, ...rest } = changes;
  const settings: RaceSettings = { ...defaultRaceSettings(vehicle, m.rules, m.line.length, m.lapTime, '11'), ...rest };
  if (cars !== undefined) settings.classes = [{ vehicleId: vehicle.id, cars }];
  return new RaceSim(createRaceSetup(m, settings));
}

/** Runs a race to the end. */
export function race(vehicle: VehicleClass, changes: RaceChanges = {}, rules?: RaceRules): RaceSim {
  const sim = start(vehicle, changes, rules);
  while (!sim.finished) sim.step();
  return sim;
}

/** Several classes together, set up but not run; `rules` can replace a class's rules. */
export function multiClass(entries: { vehicle: VehicleClass; cars: number; rules?: RaceRules }[], changes: Partial<RaceSettings> = {}): RaceSim {
  const models = entries.map((e) => model(e.vehicle, e.rules));
  const lead = entries[0].vehicle;
  const settings: RaceSettings = {
    ...defaultRaceSettings(lead, models[0].rules, models[0].line.length, models[0].lapTime, '11'),
    ...changes,
    classes: entries.map((e) => ({ vehicleId: e.vehicle.id, cars: e.cars })),
  };
  return new RaceSim(createRaceSetup(models, settings));
}

export function runToEnd(sim: RaceSim): RaceSim {
  while (!sim.finished) sim.step();
  return sim;
}

/** Rules with no incidents, so tests are about racing alone. */
export function calm(vehicle: VehicleClass, extra: Record<string, unknown> = {}): RaceRules {
  const r = raceRules(vehicle);
  return { ...r, incidents: { mistake: 0, off: 0, crash: 0, dnfPerMetre: 0 }, ...extra } as RaceRules;
}
