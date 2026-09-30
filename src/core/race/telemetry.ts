/**
 * Telemetry per car and lap. The race records only when each car passed a
 * sample station (every 5 m or so); everything else follows from that and
 * the car:
 *
 * - speed from distance over time between neighbouring samples;
 * - longitudinal acceleration from the change in speed;
 * - lateral acceleration from speed and the racing line's curvature;
 * - gear from speed and the gearing;
 * - throttle and brake from the force the change in speed needs against
 *   drag, rolling resistance and gradient, as in the lap simulation (with
 *   the grip left on a wet track for the brake).
 */
import { AIR_DENSITY, GRAVITY, gearAt, gearTopSpeeds } from '../lapSim.ts';
import type { RaceModel } from './model.ts';
import type { RaceCar, RaceSim } from './sim.ts';
import { gripFactor } from './weather.ts';

export type LapChoice = 'last' | 'best' | 'current' | number;

export interface Telemetry {
  car: number;
  lap: number;
  complete: boolean;
  /** Lap time, when the lap is complete. */
  time: number | null;
  /** Samples: distance along the lap (centreline, metres) and time since the lap started. A complete lap ends with a sample at the line. */
  x: Float64Array;
  t: Float64Array;
  /** m/s */
  v: Float64Array;
  throttle: Float64Array;
  brake: Float64Array;
  gear: Uint8Array;
  /** Accelerations in g; lateral is positive to the right. */
  latG: Float64Array;
  lonG: Float64Array;
  /** Samples with data, from the start (a lap in progress stops where the car is). */
  count: number;
}

/** The lap number a choice refers to, or null when there is no such lap yet. */
export function resolveLap(car: RaceCar, choice: LapChoice): number | null {
  if (choice === 'current') return car.status === 'running' || car.status === 'pit' ? car.lapsDone + 1 : null;
  if (choice === 'last') return car.lapsDone > 0 ? car.lapsDone : null;
  if (choice === 'best') {
    let best: { lap: number; time: number } | null = null;
    for (const h of car.history) if (!best || h.time < best.time) best = { lap: h.lap, time: h.time };
    return best?.lap ?? null;
  }
  return choice >= 1 && choice <= car.lapsDone ? choice : null;
}

export function lapTelemetry(sim: RaceSim, car: RaceCar, choice: LapChoice): Telemetry | null {
  const lap = resolveLap(car, choice);
  if (lap === null) return null;
  const done = lap <= car.lapsDone;
  const trace = done ? car.traces[lap - 1] : car.trace;
  if (!trace) return null;
  const record = done ? car.history[lap - 1] : null;
  const m = car.model;
  const fuel = record ? record.fuel + m.fuelPerLap / 2 : car.fuel;
  const compounds = m.rules.tyres.compounds;
  const grip = record ? gripFactor(compounds[record.compound].type, record.wet) : gripFactor(car.tyreType, sim.wetness);
  return channels(m, car.id, lap, trace, record?.time ?? null, fuel, grip);
}

function channels(m: RaceModel, carId: number, lap: number, trace: Float32Array, lapTime: number | null, fuel: number, gripScale: number): Telemetry {
  const track = m.track;
  const line = m.line;
  const car = m.vehicle;
  const every = m.teleEvery;
  const samples = trace.length;
  const complete = lapTime !== null;
  const size = samples + (complete ? 1 : 0);
  const x = new Float64Array(size);
  const t = new Float64Array(size).fill(NaN);
  const s = new Float64Array(size);
  const stationOf = new Int32Array(size);
  for (let i = 0; i < samples; i++) {
    const k = i * every;
    stationOf[i] = k;
    x[i] = track.s[k];
    s[i] = line.s[k];
    t[i] = trace[i];
  }
  if (complete) {
    x[samples] = track.length;
    s[samples] = line.length;
    t[samples] = lapTime;
    stationOf[samples] = 0;
  }
  let count = 0;
  while (count < size && Number.isFinite(t[count])) count++;

  const v = new Float64Array(size).fill(NaN);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    if (b > a && t[b] > t[a]) v[i] = (s[b] - s[a]) / (t[b] - t[a]);
  }
  // A lap in progress has no sample ahead of the last one: copy its neighbour.
  if (count > 1 && !Number.isFinite(v[count - 1])) v[count - 1] = v[count - 2];

  const lonG = new Float64Array(size).fill(NaN);
  const latG = new Float64Array(size).fill(NaN);
  const throttle = new Float64Array(size).fill(NaN);
  const brake = new Float64Array(size).fill(NaN);
  const gear = new Uint8Array(size);
  const tops = gearTopSpeeds(car);
  const mass = car.mass + Math.max(0, fuel);
  const weight = mass * GRAVITY;
  const q = 0.5 * AIR_DENSITY;
  const cdA = car.cdA[0] + (car.cdA[1] - car.cdA[0]) * m.trim;
  const clA = car.clA[0] + (car.clA[1] - car.clA[0]) * m.trim;
  for (let i = 0; i < count; i++) {
    const vi = v[i];
    if (!Number.isFinite(vi)) continue;
    // The change in speed over two samples either side, so a car held up in traffic, whose speed varies from step to step, does not flicker between throttle and brake.
    const a = Math.max(0, i - 2);
    const b = Math.min(count - 1, i + 2);
    const acc = b > a && t[b] > t[a] && Number.isFinite(v[a]) && Number.isFinite(v[b]) ? (v[b] - v[a]) / (t[b] - t[a]) : 0;
    const k = stationOf[i];
    lonG[i] = acc / GRAVITY;
    latG[i] = (vi * vi * line.curvature[k]) / GRAVITY;
    gear[i] = gearAt(vi, tops);
    const load = weight + q * clA * vi * vi;
    const needed = mass * acc + q * cdA * vi * vi + car.rollingResistance * load + weight * track.gradient[k];
    if (vi >= car.topSpeed - 0.5) {
      throttle[i] = 1;
      brake[i] = 0;
    } else if (needed >= 0) {
      throttle[i] = Math.min(1, (needed * Math.max(vi, 3)) / car.power);
      brake[i] = 0;
    } else {
      throttle[i] = 0;
      const grip = load * car.grip * gripScale * Math.max(0.5, 1 - car.loadSensitivity * (load / weight - 1));
      const limit = car.maxBrakeG !== null ? Math.min(grip, car.maxBrakeG * weight) : grip;
      brake[i] = -needed > 0.05 * weight ? Math.min(1, -needed / limit) : 0;
    }
  }
  return { car: carId, lap, complete, time: lapTime, x, t, v, throttle, brake, gear, latG, lonG, count };
}

/** Time gained or lost along the lap: compare minus reference at each sample both have (positive = compare slower). */
export function deltaTime(reference: Telemetry, compare: Telemetry): Float64Array {
  const n = Math.min(reference.x.length, compare.x.length);
  const out = new Float64Array(reference.x.length).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < reference.count && i < compare.count && reference.x[i] === compare.x[i]) out[i] = compare.t[i] - reference.t[i];
  }
  return out;
}
