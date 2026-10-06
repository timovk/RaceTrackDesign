// Runs races on the real circuits in data/circuits and prints how much overtaking each sees: the numbers the
// overtaking model is tuned against. A race is the class's default one, without practice or qualifying.
// It prints the drivers' trouble too, against the class's own figures per lap (data/racing.json): what the chances of
// mistakes and contact in the race are tuned to keep.
// Run: node scripts/raceTrial.ts [class=f1] [seeds=2] [circuit ...]
import { analyseTrack } from '../src/core/analysis.ts';
import { placeFacilities } from '../src/core/facilities.ts';
import { analysePerformance } from '../src/core/performance.ts';
import { type RaceModel, buildRaceModel } from '../src/core/race/model.ts';
import { type RaceRules, raceRules } from '../src/core/race/rules.ts';
import { MAX_CARS, createRaceSetup, defaultRaceSettings } from '../src/core/race/setup.ts';
import { RaceSim } from '../src/core/race/sim.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { buildTrack } from '../src/core/track.ts';
import { VEHICLES, type VehicleClass } from '../src/core/vehicles.ts';
import { circuitNames, loadCircuitDesign } from './circuitData.ts';

const EXTENT = 16384;

/** A real circuit as a race model for one class (by its own rules, or `rules`): flat, moved onto the map so the pit lane can be placed. */
export function circuitRace(name: string, vehicle: VehicleClass, rules: RaceRules = raceRules(vehicle)): RaceModel {
  const design = loadCircuitDesign(name);
  let minX = Infinity;
  let minY = Infinity;
  for (const p of design.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  for (const p of design.points) {
    p.x += 1500 - minX;
    p.y += 1500 - minY;
  }
  const raw = buildTrack(design, () => 0)!;
  const sf = placeStartFinish(raw);
  const track = rotateTrack(raw, sf.station);
  const metrics = analyseTrack(track);
  const performance = analysePerformance(track, [vehicle]);
  const facilities = placeFacilities({ track, startFinish: sf, performance, vehicles: [vehicle], heightAt: () => 0, waterLevel: -Infinity, extent: EXTENT, overrides: {} });
  return buildRaceModel({ track, performance, facilities, vehicle, rules, gridSize: MAX_CARS, corners: metrics.corners });
}

/** The class's default race on a circuit, without practice or qualifying, on a dry track. */
export function trialRace(model: RaceModel, seed: string): RaceSim {
  const settings = { ...defaultRaceSettings(model.vehicle, model.rules, model.line.length, model.lapTime, seed), skip: ['p1', 'p2', 'p3', 'qualifying'], weather: 'dry' as const };
  return new RaceSim(createRaceSetup(model, settings));
}

function main(): void {
  const [classId = 'f1', seedCount = '2', ...only] = process.argv.slice(2);
  const vehicle = VEHICLES.find((v) => v.id === classId);
  if (!vehicle) throw new Error(`No class "${classId}".`);
  const seeds = Number(seedCount);
  console.log(`${vehicle.name}, ${seeds} race(s) per circuit; passes are overtakes for position after lap 1.`);
  console.log('Per race: touches (contact that only costs time), trouble (trips off, spins, cars forced off and damage) and cars out by a crash or a collision.\n');
  console.log('circuit            km  width  laps  passes  per car  touches  trouble   out  winner');
  const all = { races: 0, passes: 0, carLaps: 0, mistakes: 0, touches: 0, trouble: 0, out: 0 };
  let counted = false;
  const t0 = performance.now();
  for (const name of only.length ? only : circuitNames()) {
    const model = circuitRace(name, vehicle);
    let width = 0;
    for (let k = 0; k < model.n; k++) width += model.track.width[k] / model.n;
    const sum = { passes: 0, carLaps: 0, mistakes: 0, touches: 0, trouble: 0, out: 0 };
    let laps = 0;
    let cars = 0;
    let winner = 0;
    for (let s = 0; s < seeds; s++) {
      const sim = trialRace(model, `trial${s}`);
      while (!sim.finished) sim.step();
      const y = sim.tally;
      counted ||= sim.lanes;
      sum.passes += sim.events.filter((e) => e.kind === 'overtake' && e.lap > 1).length;
      sum.carLaps += sim.cars.reduce((a, c) => a + c.lapsDone, 0);
      sum.mistakes += y.mistakes;
      sum.touches += y.touches;
      // (Bikes race in one line and keep no tally: their trips off are in the feed, their mistakes are not counted.)
      sum.trouble += sim.lanes ? y.offs + y.spins + y.forcedOff + y.tapped + y.damaged : sim.events.filter((e) => e.kind === 'off').length;
      sum.out += sim.cars.filter((c) => c.status === 'retired' && /^(crash|collision|puncture)/.test(c.retired!.reason)).length;
      laps = sim.order[0].lapsDone;
      cars = sim.cars.length;
      winner += sim.order[0].finishTime ?? sim.t;
    }
    all.races += seeds;
    for (const key of Object.keys(sum) as (keyof typeof sum)[]) all[key] += sum[key];
    const per = (v: number, w: number, digits = 1) => (v / seeds).toFixed(digits).padStart(w);
    console.log(
      `${name.padEnd(16)} ${(model.line.length / 1000).toFixed(2).padStart(5)} ${width.toFixed(1).padStart(6)} ${String(laps).padStart(5)} ${per(sum.passes, 7)} ${per(sum.passes / cars, 8, 2)} ${per(sum.touches, 8)} ${per(sum.trouble, 8)} ${per(sum.out, 5)}  ${(winner / seeds / 60).toFixed(1)} min`,
    );
  }
  const inc = raceRules(vehicle).incidents;
  const rate = (v: number) => (v / all.carLaps).toFixed(5);
  console.log(`\nmean ${(all.passes / all.races).toFixed(1)} passes a race over ${all.races} races, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`per lap and car, against the class's figures: mistakes and touches ${counted ? rate(all.mistakes + all.touches) : 'not counted'} (${inc.mistake}), trouble ${rate(all.trouble)} (${inc.off}), cars out ${rate(all.out)} (${inc.crash})`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/raceTrial.ts')) main();
