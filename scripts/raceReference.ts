// Prints each class's average wheel energy and tyre work per kilometre on the real circuits in data/circuits.
// These are the "reference" values in data/racing.json: a track that needs more energy than the reference burns
// proportionally more fuel, and one with more tyre work wears the tyres faster.
// Run: node scripts/raceReference.ts
import { simulateLap } from '../src/core/lapSim.ts';
import { lapEnergy, lapTyreWork } from '../src/core/race/model.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { circuitNames, loadCircuits } from './circuitData.ts';

const circuits = [...loadCircuits(circuitNames()).values()];
console.log(`${circuits.length} circuits\n`);
console.log('class        energy MJ/km   tyre work');
for (const car of VEHICLES) {
  let energy = 0;
  let work = 0;
  for (const c of circuits) {
    const lap = simulateLap(c.track, c.line, car);
    energy += lapEnergy(lap, c.line, car) / c.line.length;
    work += lapTyreWork(lap, c.line) / c.line.length;
  }
  energy /= circuits.length;
  work /= circuits.length;
  console.log(`${car.id.padEnd(12)} ${(energy / 1000).toFixed(2).padStart(12)} ${work.toFixed(3).padStart(11)}`);
}
