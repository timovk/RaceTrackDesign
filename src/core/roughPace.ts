/**
 * A class's pace, roughly: what a corner of a given radius takes, and how
 * hard it pulls away and brakes at a speed (m/s, m/s2). The track generator
 * uses it while a lap is still a drawing: to know where a car brakes hard,
 * and how deep the run-off beyond a corner has to be. The lap times come
 * from the real lap simulation.
 */
import type { VehicleClass } from './vehicles.ts';

export interface Pace {
  top: number;
  corner(r: number): number;
  drive(v: number): number;
  brake(v: number): number;
}

const AIR = 1.2;
const G = 9.81;

/** Without a class: cornering and braking at 14 m/s2, pulling away at 6, no faster than 85 m/s. */
export function paceOf(vehicle: VehicleClass | null): Pace {
  if (!vehicle) return { top: 85, corner: (r) => Math.min(85, Math.sqrt(14 * r)), drive: () => 6, brake: () => 14 };
  const m = vehicle.mass;
  const down = (0.5 * AIR * (vehicle.clA[0] + vehicle.clA[1])) / 2 / m;
  const drag = (0.5 * AIR * (vehicle.cdA[0] + vehicle.cdA[1])) / 2 / m;
  // A little under the tyre's grip: it loses some under load, and no lap uses all of it.
  const mu = vehicle.grip * 0.92;
  const top = vehicle.topSpeed;
  return {
    top,
    corner: (r) => {
      const left = 1 - mu * down * r;
      return left <= 0.05 ? top : Math.min(top, Math.sqrt((mu * G * r) / left));
    },
    drive: (v) => Math.min(mu * (G + down * v * v) * vehicle.driveShare, (vehicle.maxAccelG ?? 9) * G, vehicle.power / (m * Math.max(v, 8))) - drag * v * v,
    brake: (v) => Math.min(mu * (G + down * v * v), (vehicle.maxBrakeG ?? 9) * G) + drag * v * v,
  };
}

/** The highest speed on a straight of `length` metres left at `from` and ended at `to`. */
export function peakSpeed(pace: Pace, from: number, to: number, length: number): number {
  if (length <= 1) return Math.min(from, to);
  const steps = Math.max(1, Math.ceil(length / 25));
  const ds = length / steps;
  const up = new Float64Array(steps + 1);
  up[0] = from;
  for (let k = 0; k < steps; k++) up[k + 1] = Math.min(pace.top, Math.sqrt(Math.max(1, up[k] * up[k] + 2 * pace.drive(up[k]) * ds)));
  let down = to;
  let peak = Math.min(up[steps], down);
  for (let k = steps - 1; k >= 0; k--) {
    down = Math.sqrt(down * down + 2 * pace.brake(down) * ds);
    peak = Math.max(peak, Math.min(up[k], down));
  }
  return peak;
}

/**
 * The radius of the line a car takes through a corner: from the outside of
 * the road in to the inside at the apex and out again, which is a far wider
 * arc than the road's own where the corner turns little. A flick of 50
 * degrees at 30 m on a road 14 m wide is taken on a line of 150 m; a right
 * angle there on one of 65 m; a turn right round on hardly more than the
 * road's own.
 */
export function lineRadius(radius: number, turn: number, width: number): number {
  // (What a car has of the road either side of its middle: half the width, less half its own.)
  const half = Math.min(Math.max(0, width / 2 - 1), 0.8 * radius);
  const c = Math.cos(Math.min(Math.abs(turn), Math.PI) / 2);
  return 1 - c < 1e-4 ? 1e6 : Math.max(radius, (radius + half - (radius - half) * c) / (1 - c));
}

/** A fall in speed of this much (m/s) into a corner is heavy braking: 90 km/h. */
export const HEAVY_BRAKING = 25;
