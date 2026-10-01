/**
 * Camera shots of the track for the 3D view, and the camera paths of a
 * flyover and a hot lap. Positions are in world coordinates: x east, y south,
 * z up (height above sea level).
 *
 * A fixed shot looks at a spot from where a spectator or a camera tower
 * would be: each numbered corner from outside, beyond its run-off; the start
 * from behind the grid; the pit boxes along the lane; the steepest climb and
 * drop from beside their foot, looking up; and the highest point. A camera
 * whose view a hill would block is raised until it sees over it.
 */
import type { TrackMetrics } from './analysis.ts';
import type { LapResult } from './lapSim.ts';
import type { PitLane } from './pitLane.ts';
import type { RacingLine } from './racingLine.ts';
import { VERGE } from './scene3d.ts';
import { cornerName } from './scenery.ts';
import type { Track } from './track.ts';

export type Vec3 = [number, number, number];

export interface Shot {
  id: string;
  label: string;
  camera: Vec3;
  target: Vec3;
}

export interface Pose {
  camera: Vec3;
  target: Vec3;
}

export interface ShotInput {
  track: Track;
  metrics: TrackMetrics;
  pit: PitLane | null;
  /** Shaped ground height. */
  height: (x: number, y: number) => number;
  /** Run-off depth beyond the verge beside station k on a side (1 left, -1 right). */
  runoff?: (k: number, side: 1 | -1) => number;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Point on the track at station k, offset `side` metres to the left and `up` metres above the surface. */
function trackPoint(t: Track, k: number, side = 0, up = 0): Vec3 {
  const h = t.heading[k];
  return [t.x[k] + Math.sin(h) * side, t.y[k] - Math.cos(h) * side, t.z[k] + up];
}

/** Raises the camera until the ground no longer blocks its view of the target, and keeps it above the ground. */
export function clearView(camera: Vec3, target: Vec3, height: (x: number, y: number) => number): Vec3 {
  const cam: Vec3 = [...camera];
  cam[2] = Math.max(cam[2], height(cam[0], cam[1]) + 2);
  for (let tries = 0; tries < 40; tries++) {
    let blocked = false;
    for (let i = 1; i < 48 && !blocked; i++) {
      const f = i / 48;
      const x = cam[0] + (target[0] - cam[0]) * f;
      const y = cam[1] + (target[1] - cam[1]) * f;
      const z = cam[2] + (target[2] - cam[2]) * f;
      // Near the target the line of sight may graze the ground it looks at.
      if (f < 0.93 && height(x, y) > z - 0.5) blocked = true;
    }
    if (!blocked) return cam;
    cam[2] += 6;
  }
  return cam;
}

/** The side of station k whose ground `reach` metres out is lower, for a clear view from the side. */
function lowerSide(t: Track, k: number, reach: number, height: (x: number, y: number) => number): 1 | -1 {
  const l = trackPoint(t, k, reach);
  const r = trackPoint(t, k, -reach);
  return height(l[0], l[1]) <= height(r[0], r[1]) ? 1 : -1;
}

export function trackShots(input: ShotInput): Shot[] {
  const { track: t, metrics, pit, height } = input;
  const n = t.n;
  const shots: Shot[] = [];
  const add = (id: string, label: string, camera: Vec3, target: Vec3) => shots.push({ id, label, camera: clearView(camera, target, height), target });

  // The start, from above and behind the grid, looking down the straight.
  const behind = mod(-Math.round(240 / t.ds), n);
  add('start', 'Start and grid', trackPoint(t, behind, 0, 22), trackPoint(t, Math.round(60 / t.ds) % n, 0, 1));

  if (pit) {
    // Back along the boxes from beyond their exit end, from above the pit wall, facing the garages
    // (which stand on the pit side of the lane).
    const last = pit.x.length - 1;
    const end = Math.min(last, pit.boxEnd);
    const from = Math.max(0, end - 10);
    const dx = pit.x[end] - pit.x[from];
    const dy = pit.y[end] - pit.y[from];
    const len = Math.hypot(dx, dy) || 1;
    const lx = (dy / len) * pit.side;
    const ly = (-dx / len) * pit.side;
    const mid = Math.min(last, Math.round((pit.boxStart + end) / 2));
    const camera: Vec3 = [pit.x[end] + (dx / len) * 50 - lx * 18, pit.y[end] + (dy / len) * 50 - ly * 18, height(pit.x[end], pit.y[end]) + 20];
    const tx = pit.x[mid] + lx * 6;
    const ty = pit.y[mid] + ly * 6;
    add('pit', 'Pit lane', camera, [tx, ty, height(tx, ty) + 3]);
  }

  for (const c of metrics.corners) {
    const k = c.apex;
    const side: 1 | -1 = c.direction === 'right' ? 1 : -1;
    const depth = input.runoff?.(k, side) ?? 0;
    // A camera tower just beyond the run-off.
    const out = t.width[k] / 2 + VERGE + depth + 15;
    const cam = trackPoint(t, k, side * out);
    cam[2] = Math.max(height(cam[0], cam[1]) + 16, t.z[k] + 12);
    add(`corner-${c.number}`, cornerName(c), cam, trackPoint(t, k, 0, 1));
  }

  // Steepest climb and drop, averaged over about 40 m, seen from beside the bottom of the slope
  // (on the side where the ground is lower), looking up the road.
  const win = Math.max(1, Math.round(20 / t.ds));
  let up = 0;
  let down = 0;
  const grade = (k: number) => (t.z[(k + win) % n] - t.z[mod(k - win, n)]) / (2 * win * t.ds);
  for (let k = 0; k < n; k++) {
    if (grade(k) > grade(up)) up = k;
    if (grade(k) < grade(down)) down = k;
  }
  const slopeShot = (id: string, label: string, k: number, dir: 1 | -1) => {
    const bottom = mod(k - dir * Math.round(80 / t.ds), n);
    const top = mod(k + dir * Math.round(30 / t.ds), n);
    const side = lowerSide(t, bottom, 40, height);
    add(id, label, trackPoint(t, bottom, side * 30, 4), trackPoint(t, top, 0, 2));
  };
  if (grade(up) > 0.02) slopeShot('climb', `Steepest climb (${Math.round(grade(up) * 100)}%)`, up, 1);
  if (grade(down) < -0.02) slopeShot('drop', `Steepest drop (${Math.round(-grade(down) * 100)}%)`, down, -1);

  // The highest point.
  let top = 0;
  for (let k = 1; k < n; k++) if (t.z[k] > t.z[top]) top = k;
  const topSide = lowerSide(t, top, 150, height);
  add('high', 'Highest point', trackPoint(t, top, topSide * 150, 22), trackPoint(t, top, 0, 2));
  return shots;
}

/** Station and fraction to the next at time `time` into a lap (wrapping). */
function lapPosition(lap: LapResult, time: number): { k: number; f: number } {
  const n = lap.t.length;
  const tt = mod(time, lap.time);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lap.t[mid] <= tt) lo = mid;
    else hi = mid - 1;
  }
  const next = lo + 1 < n ? lap.t[lo + 1] : lap.time;
  const f = next > lap.t[lo] ? (tt - lap.t[lo]) / (next - lap.t[lo]) : 0;
  return { k: lo, f: Math.max(0, Math.min(1, f)) };
}

/** A point on the racing line (or the centreline) at a fractional station, with the track height. */
function onLine(t: Track, line: RacingLine | null, u: number, up: number): Vec3 {
  const n = t.n;
  const k = Math.floor(mod(u, n));
  const k1 = (k + 1) % n;
  const f = mod(u, n) - k;
  const xs = line ? line.x : t.x;
  const ys = line ? line.y : t.y;
  return [xs[k] + (xs[k1] - xs[k]) * f, ys[k] + (ys[k1] - ys[k]) * f, t.z[k] + (t.z[k1] - t.z[k]) * f + up];
}

/** The mean of points ahead, for a steady look direction. */
function lookAhead(t: Track, line: RacingLine | null, u: number, metres: readonly number[], up: number): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  for (const m of metres) {
    const p = onLine(t, line, u + m / t.ds, up);
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }
  return [sum[0] / metres.length, sum[1] / metres.length, sum[2] / metres.length];
}

/** The driver's view at `time` into a flying lap: on the racing line at eye height, looking ahead through the corner. */
export function hotLapPose(t: Track, line: RacingLine, lap: LapResult, time: number, eye: number): Pose {
  const { k, f } = lapPosition(lap, time);
  const u = k + f;
  return { camera: onLine(t, line, u, eye), target: lookAhead(t, line, u, [25, 45, 65], eye - 0.3) };
}

/** A drone following the centreline `distance` metres into the lap, behind and above, looking ahead. */
export function flyoverPose(t: Track, distance: number, height: (x: number, y: number) => number): Pose {
  const u = mod(distance, t.length) / t.ds;
  const camera = lookAhead(t, null, u, [-70, -60, -50], 40);
  camera[2] = Math.max(camera[2], height(camera[0], camera[1]) + 30);
  return { camera, target: lookAhead(t, null, u, [40, 100, 160], 0) };
}

/** Speed of the flyover drone, m/s. */
export const FLYOVER_SPEED = 60;

export function flyoverDuration(t: Track): number {
  return t.length / FLYOVER_SPEED;
}
