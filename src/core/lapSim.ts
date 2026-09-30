/**
 * Quasi-steady-state point-mass lap simulation, the standard method for lap
 * time estimates:
 *
 * 1. The highest cornering speed at every station, from tyre grip, downforce
 *    and vertical curvature (crests unload the tyres, dips load them).
 * 2. A forward pass accelerating from each corner, limited by power, traction
 *    and the grip left over after cornering (a friction ellipse).
 * 3. A backward pass braking into each corner, limited the same way.
 *
 * The speed at each station is the lowest of the three. The car drives the
 * racing line; elevation and vertical curvature come from the track. Cars
 * with an aero range are tried at five trims and run the fastest, the way
 * teams trade downforce against drag for each circuit.
 */
import type { RacingLine } from './racingLine.ts';
import type { Track } from './track.ts';
import type { VehicleClass } from './vehicles.ts';

export interface LapResult {
  vehicleId: string;
  /** Lap time in seconds (flying lap). */
  time: number;
  /** Aero trim used, 0 = low downforce, 1 = high downforce. */
  trim: number;
  /** Per-station values; t[k] is the time at which station k is reached. */
  v: Float64Array;
  t: Float64Array;
  /** Longitudinal and lateral acceleration in m/s2 (lateral positive to the right). */
  ax: Float64Array;
  ay: Float64Array;
  /** Pedal use, 0..1. */
  throttle: Float64Array;
  brake: Float64Array;
  gear: Uint8Array;
  topSpeed: number;
  minSpeed: number;
  avgSpeed: number;
  /** Share of the lap time at full throttle. */
  fullThrottle: number;
  brakingZones: number;
}

export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.2;
const TRIMS = [0, 0.25, 0.5, 0.75, 1];
/** Speed floor, so power divided by speed stays finite at a standstill. */
const MIN_SPEED = 3;

/** Runs the lap at every aero trim the car allows and returns the fastest. */
export function simulateLap(track: Track, line: RacingLine, car: VehicleClass): LapResult {
  const fixed = car.cdA[0] === car.cdA[1] && car.clA[0] === car.clA[1];
  let best: LapResult | null = null;
  for (const trim of fixed ? [0] : TRIMS) {
    const lap = simulateLapAtTrim(track, line, car, trim);
    if (!best || lap.time < best.time) best = lap;
  }
  return best!;
}

export function simulateLapAtTrim(track: Track, line: RacingLine, car: VehicleClass, trim: number): LapResult {
  const n = line.n;
  const m = car.mass;
  const weight = m * GRAVITY;
  const q = 0.5 * AIR_DENSITY;
  const cdA = car.cdA[0] + (car.cdA[1] - car.cdA[0]) * trim;
  const clA = car.clA[0] + (car.clA[1] - car.clA[0]) * trim;
  const vTop = car.topSpeed;

  // Per-station geometry: curvature of the line, slope (sin of the angle) and vertical curvature.
  const kappa = new Float64Array(n);
  const slope = new Float64Array(n);
  const vcurv = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const p = k === 0 ? n - 1 : k - 1;
    const nx = k === n - 1 ? 0 : k + 1;
    kappa[k] = Math.abs(line.curvature[k]);
    slope[k] = (track.z[nx] - track.z[p]) / (line.ds[p] + line.ds[k]);
    vcurv[k] = track.vcurv[k];
  }

  const load = (k: number, v: number) => Math.max(0.05 * weight, m * (GRAVITY + v * v * vcurv[k]) + q * clA * v * v);
  // Grip falls off linearly as the load rises above the car's weight.
  const grip = (fz: number) => fz * car.grip * Math.max(0.5, 1 - car.loadSensitivity * (fz / weight - 1));
  const drag = (v: number) => q * cdA * v * v;
  const drsOpen = car.drs > 0 ? drsStations(line) : null;
  const dragAccelerating = (k: number, v: number) => (drsOpen?.[k] ? (1 - car.drs) * drag(v) : drag(v));

  // 1. Cornering limit per station.
  const vCorner = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const c = kappa[k];
    const fits = (v: number) => grip(load(k, v)) >= m * v * v * c;
    if (c < 1e-6 || fits(vTop)) {
      vCorner[k] = vTop;
      continue;
    }
    let lo = 0;
    let hi = vTop;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    vCorner[k] = lo;
  }

  // Grip left for accelerating or braking after the cornering force is taken (friction ellipse).
  const spareGrip = (k: number, v: number) => {
    const cap = grip(load(k, v));
    const lat = m * v * v * kappa[k];
    const r = lat / cap;
    return r >= 1 ? 0 : cap * Math.sqrt(1 - r * r);
  };
  const driveForce = (k: number, v: number) => {
    let traction = spareGrip(k, v) * car.driveShare;
    if (car.maxAccelG !== null) traction = Math.min(traction, car.maxAccelG * weight);
    return Math.min(traction, car.power / Math.max(v, MIN_SPEED));
  };
  const brakeForce = (k: number, v: number) => {
    const f = spareGrip(k, v);
    return car.maxBrakeG !== null ? Math.min(f, car.maxBrakeG * weight) : f;
  };
  const resistance = (k: number, v: number) => drag(v) + car.rollingResistance * load(k, v) + weight * slope[k];

  // Start both passes at the slowest corner and go round twice, so the loop closes on itself.
  let start = 0;
  for (let k = 1; k < n; k++) if (vCorner[k] < vCorner[start]) start = k;

  // 2. Forward pass: accelerate (with DRS open on long straights).
  const vf = new Float64Array(n);
  vf[start] = vCorner[start];
  for (let i = 1; i <= 2 * n; i++) {
    const k = (start + i) % n;
    const p = (k - 1 + n) % n;
    const v = vf[p];
    const a = (driveForce(p, v) - resistance(p, v) + drag(v) - dragAccelerating(p, v)) / m;
    const next = Math.sqrt(Math.max(1, v * v + 2 * a * line.ds[p]));
    vf[k] = Math.min(next, vCorner[k], vTop);
  }

  // 3. Backward pass: brake.
  const vb = new Float64Array(n);
  vb[start] = vCorner[start];
  for (let i = 1; i <= 2 * n; i++) {
    const k = (start - i + 2 * n * 2) % n;
    const nx = (k + 1) % n;
    const v = vb[nx];
    const d = (brakeForce(k, v) + resistance(k, v)) / m;
    const prev = Math.sqrt(Math.max(1, v * v + 2 * d * line.ds[k]));
    vb[k] = Math.min(prev, vCorner[k], vTop);
  }

  const v = new Float64Array(n);
  for (let k = 0; k < n; k++) v[k] = Math.min(vf[k], vb[k]);

  // Timing and channels.
  const t = new Float64Array(n);
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const throttle = new Float64Array(n);
  const brake = new Float64Array(n);
  const gear = new Uint8Array(n);
  const gearTops = gearTopSpeeds(car);
  let time = 0;
  let fullTime = 0;
  let topSpeed = 0;
  let minSpeed = Infinity;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const dt = (2 * line.ds[k]) / (v[k] + v[k1]);
    t[k] = time;
    time += dt;
    ax[k] = (v[k1] * v[k1] - v[k] * v[k]) / (2 * line.ds[k]);
    ay[k] = v[k] * v[k] * line.curvature[k];
    const needed = m * ax[k] + resistance(k, v[k]) - (ax[k] > 0 ? drag(v[k]) - dragAccelerating(k, v[k]) : 0);
    if (needed > 0) {
      // On the rev limiter the driver is flat out even though less power would hold the speed.
      throttle[k] = v[k] >= vTop - 0.05 ? 1 : Math.min(1, (needed * Math.max(v[k], MIN_SPEED)) / car.power);
    } else if (-needed > 0.05 * weight) {
      brake[k] = Math.min(1, -needed / Math.max(1, brakeForce(k, v[k])));
    }
    if (throttle[k] >= 0.98) fullTime += dt;
    gear[k] = gearFor(v[k], gearTops);
    topSpeed = Math.max(topSpeed, v[k]);
    minSpeed = Math.min(minSpeed, v[k]);
  }

  let brakingZones = 0;
  let run = 0;
  for (let i = 0; i <= n; i++) {
    const on = i < n && brake[(start + i) % n] > 0.3;
    if (on) run++;
    else {
      if (run >= 3) brakingZones++;
      run = 0;
    }
  }

  return {
    vehicleId: car.id,
    time,
    trim,
    v, t, ax, ay, throttle, brake, gear,
    topSpeed,
    minSpeed,
    avgSpeed: line.length / time,
    fullThrottle: fullTime / time,
    brakingZones,
  };
}

/** A DRS zone needs this much straight: radius above 1 km for at least 300 m. */
const DRS_MIN_STRAIGHT = 300;
const DRS_MAX_CURVATURE = 1 / 1000;

/**
 * Stations where an opened rear wing is allowed: along straights of at least
 * 300 m, the way qualifying DRS zones sit on the main straights.
 */
export function drsStations(line: { n: number; curvature: Float64Array; ds: Float64Array }): Uint8Array {
  const n = line.n;
  const open = new Uint8Array(n);
  // Start from a curved station so no straight is split by the wrap-around.
  let origin = 0;
  for (let k = 1; k < n; k++) if (Math.abs(line.curvature[k]) > Math.abs(line.curvature[origin])) origin = k;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i <= n; i++) {
    const k = (origin + i) % n;
    const straight = i < n && Math.abs(line.curvature[k]) < DRS_MAX_CURVATURE;
    if (straight) {
      if (runStart < 0) {
        runStart = i;
        runLength = 0;
      }
      runLength += line.ds[k];
    } else if (runStart >= 0) {
      if (runLength >= DRS_MIN_STRAIGHT) for (let j = runStart; j < i; j++) open[(origin + j) % n] = 1;
      runStart = -1;
    }
  }
  return open;
}

/**
 * Top speed of each gear, spaced so the ratio between gears is constant from
 * first gear up to the car's top speed (a running product, no pow).
 */
export function gearTopSpeeds(car: VehicleClass): Float64Array {
  const tops = new Float64Array(car.gears);
  if (car.gears === 1) {
    tops[0] = car.topSpeed;
    return tops;
  }
  // Find the step ratio r with first * r^(gears-1) = top by bisection on r.
  const target = car.topSpeed / Math.max(1, car.firstGearSpeed);
  let lo = 1;
  let hi = 4;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    let p = 1;
    for (let g = 1; g < car.gears; g++) p *= mid;
    if (p < target) lo = mid;
    else hi = mid;
  }
  let s = car.firstGearSpeed;
  for (let g = 0; g < car.gears; g++) {
    tops[g] = s;
    s *= lo;
  }
  tops[car.gears - 1] = car.topSpeed;
  return tops;
}

function gearFor(v: number, tops: Float64Array): number {
  for (let g = 0; g < tops.length; g++) if (v <= tops[g] * 0.97) return g + 1;
  return tops.length;
}
