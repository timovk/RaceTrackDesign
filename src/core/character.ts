/**
 * What a circuit is like, in figures that can be set against real circuits:
 * how many corners it has and how much it turns, the mix of slow and fast,
 * how its straights divide the lap and how much of it is dead straight,
 * gently curved or long corners, and how the lap lies on the ground
 * (spread out or compact, one loop or wrapped round itself).
 *
 * The same measures are taken of the real circuits in data/circuits and of
 * generated ones; `REAL_CIRCUITS` holds what the real ones come to, and the
 * track generator is set from it (tests/character.test.ts keeps both honest).
 */
import { type TrackMetrics, analyseTrack } from './analysis.ts';
import type { Track } from './track.ts';

export interface Character {
  cornersPerKm: number;
  /** Degrees turned, either way, per kilometre. */
  turningPerKm: number;
  /** The middle corner's turn, degrees. */
  cornerAngle: number;
  /** Shares of the corners of 15 degrees or more that are slow (under 45 m), medium and fast (over 120 m), by the radius the middle half of a corner's turning is made at. */
  slow: number;
  medium: number;
  fast: number;
  /** How much tighter the tightest point of a corner is than the middle of it: 1 for an arc of one radius. */
  tightening: number;
  /** Share of the corners that turn the other way from the one before. */
  alternating: number;
  /** The longest straight and the next, as shares of the lap. */
  longestStraight: number;
  secondStraight: number;
  /** Share of the lap that is dead straight: the road, evened out over 60 m, at over 2 km of radius for 150 m or more. */
  deadStraight: number;
  /** Share of the lap that is gently curved: the road, evened out over 60 m, at 300 m to 2 km of radius. */
  bowed: number;
  /** Share of the lap that is long corners: the road, evened out over 60 m, turning one way at under 300 m for 150 m or more. */
  longBends: number;
  /** The lap's greatest extent (the diagonal of the box round it) as a share of its length. */
  spread: number;
  /** Share of the smallest outline without a dent round the lap that the lap encloses. */
  hull: number;
  /** Share of the lap with another part of it within 120 m (one at least 300 m away along the lap). */
  folded: number;
}

/**
 * What the 25 real circuits in data/circuits come to: for each measure, the
 * value a tenth, a half and nine tenths of the way up the list. They are
 * mostly Grand Prix circuits of this century, drawn from maps: a corner's
 * tightest point reads tighter than it is (so the mix goes by the middle of
 * a corner), and there are no heights.
 */
export const REAL_CIRCUITS: Readonly<Record<keyof Character, readonly [number, number, number]>> = {
  cornersPerKm: [2.24, 3.25, 4.17],
  turningPerKm: [235, 308, 370],
  cornerAngle: [71, 85, 107],
  slow: [0.2, 0.47, 0.65],
  medium: [0.14, 0.38, 0.57],
  fast: [0.07, 0.15, 0.32],
  tightening: [1.18, 1.38, 1.98],
  alternating: [0.33, 0.67, 0.78],
  longestStraight: [0.1, 0.14, 0.21],
  secondStraight: [0.05, 0.09, 0.15],
  deadStraight: [0.21, 0.32, 0.5],
  bowed: [0.1, 0.22, 0.29],
  longBends: [0.04, 0.16, 0.31],
  spread: [0.29, 0.35, 0.43],
  hull: [0.49, 0.65, 0.79],
  folded: [0, 0.32, 0.59],
};

/** A corner counts for the mix from this many degrees. */
const MIX_FROM = 15;
const SLOW_BELOW = 45;
const FAST_ABOVE = 120;
const FOLD_WITHIN = 120;
const FOLD_APART = 300;
/** The road is evened out over this length (metres) to see what it does, not the wobble of how it was drawn or built. */
const EVEN_OVER = 60;
const BOWED_FROM = 300;
const STRAIGHT_FROM = 2000;
const STRAIGHT_FOR = 150;
const LONG_BEND = 150;

export function trackCharacter(t: Track, metrics: TrackMetrics = analyseTrack(t)): Character {
  const { n, ds } = t;
  const km = t.length / 1000;
  let turning = 0;
  for (let k = 0; k < n; k++) turning += Math.abs(t.curvature[k]) * ds;
  // Corners: the radius the middle half of each one's turning is made at.
  const corners = metrics.corners;
  let slow = 0, medium = 0, fast = 0, counted = 0;
  const tighter: number[] = [];
  for (const c of corners) {
    const cum: number[] = [];
    let total = 0;
    for (let k = c.start; ; k = (k + 1) % n) {
      total += Math.abs(t.curvature[k]) * ds;
      cum.push(total);
      if (k === c.end) break;
    }
    const a = cum.findIndex((v) => v >= 0.25 * total), b = cum.findIndex((v) => v >= 0.75 * total);
    const middle = Math.max(c.minRadius, ((b - a) * ds) / (0.5 * total || 1));
    if (c.angle < MIX_FROM) continue;
    counted++;
    tighter.push(middle / c.minRadius);
    if (middle < SLOW_BELOW) slow++;
    else if (middle > FAST_ABOVE) fast++;
    else medium++;
  }
  // Straight, bowed or cornering: by the curvature evened out along the lap.
  const half = Math.max(1, Math.round(EVEN_OVER / 2 / ds));
  const even = new Float64Array(n);
  let sum = 0;
  for (let k = -half; k <= half; k++) sum += t.curvature[(k + n) % n];
  for (let k = 0; k < n; k++) {
    even[k] = sum / (2 * half + 1);
    sum += t.curvature[(k + half + 1) % n] - t.curvature[(k - half + n) % n];
  }
  let bowed = 0, dead = 0;
  for (let k = 0; k < n; k++) {
    const r = 1 / Math.max(1e-9, Math.abs(even[k]));
    if (r >= BOWED_FROM && r <= STRAIGHT_FROM) bowed++;
  }
  // (Counted from where the road turns most, so that no straight lies across the place the count begins.)
  let origin = 0;
  for (let k = 1; k < n; k++) if (Math.abs(even[k]) > Math.abs(even[origin])) origin = k;
  for (let i = 0, run = 0; i <= n; i++) {
    if (i < n && Math.abs(even[(origin + i) % n]) < 1 / STRAIGHT_FROM) run++;
    else {
      if (run * ds >= STRAIGHT_FOR) dead += run;
      run = 0;
    }
  }
  // Long corners, counted from where the road is straightest.
  let straightest = 0;
  for (let k = 1; k < n; k++) if (Math.abs(even[k]) < Math.abs(even[straightest])) straightest = k;
  let long = 0;
  for (let i = 0, run = 0, side = 0; i <= n; i++) {
    const c = i < n ? even[(straightest + i) % n] : 0;
    const now = Math.abs(c) > 1 / BOWED_FROM ? Math.sign(c) : 0;
    if (now && now === side) run++;
    else {
      if (side && run * ds >= LONG_BEND) long += run;
      side = now;
      run = now ? 1 : 0;
    }
  }
  const middleOf = (list: number[]) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
  const alternating = corners.length > 1 ? corners.filter((c, i) => c.direction !== corners[(i + 1) % corners.length].direction).length / corners.length : 0;
  const straights = metrics.straights.map((s) => s.length).sort((a, b) => b - a);
  // How the lap lies on the ground, from a point every dozen metres.
  const step = Math.max(1, Math.round(12 / ds));
  const xs: number[] = [], ys: number[] = [], at: number[] = [];
  for (let k = 0; k < n; k += step) {
    xs.push(t.x[k]);
    ys.push(t.y[k]);
    at.push(k * ds);
  }
  const m = xs.length;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, area = 0;
  for (let i = 0; i < m; i++) {
    x0 = Math.min(x0, xs[i]);
    x1 = Math.max(x1, xs[i]);
    y0 = Math.min(y0, ys[i]);
    y1 = Math.max(y1, ys[i]);
    area += xs[i] * ys[(i + 1) % m] - xs[(i + 1) % m] * ys[i];
  }
  let folded = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const along = Math.abs(at[i] - at[j]);
      if (along < FOLD_APART || t.length - along < FOLD_APART) continue;
      if (Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) < FOLD_WITHIN) {
        folded++;
        break;
      }
    }
  }
  return {
    cornersPerKm: corners.length / km,
    turningPerKm: (turning * 180) / Math.PI / km,
    cornerAngle: middleOf(corners.map((c) => c.angle)),
    slow: counted ? slow / counted : 0, medium: counted ? medium / counted : 0, fast: counted ? fast / counted : 0,
    tightening: middleOf(tighter),
    alternating,
    longestStraight: (straights[0] ?? 0) / t.length, secondStraight: (straights[1] ?? 0) / t.length,
    deadStraight: dead / n, bowed: bowed / n, longBends: long / n,
    spread: Math.hypot(x1 - x0, y1 - y0) / t.length,
    hull: Math.abs(area) / Math.max(1e-9, hullArea2(xs, ys)),
    folded: folded / m,
  };
}

/** Twice the area of the smallest outline without a dent round a set of points. */
function hullArea2(x: readonly number[], y: readonly number[]): number {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b] || y[a] - y[b]);
  const cross = (o: number, a: number, b: number) => (x[a] - x[o]) * (y[b] - y[o]) - (y[a] - y[o]) * (x[b] - x[o]);
  const half = (order: number[]) => {
    const out: number[] = [];
    for (const i of order) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], i) <= 0) out.pop();
      out.push(i);
    }
    return out.slice(0, -1);
  };
  const hull = half(idx).concat(half([...idx].reverse()));
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    area += x[p] * y[q] - x[q] * y[p];
  }
  return Math.abs(area);
}

/** The value a tenth, a half and nine tenths of the way up a list. */
export function spreadOf(values: readonly number[]): [number, number, number] {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
  return [at(0.1), at(0.5), at(0.9)];
}
