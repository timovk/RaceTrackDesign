/**
 * Minimum-curvature racing line: the smoothest path around the lap that
 * stays inside the track edges, with a margin for the width of the car. It
 * is the standard stand-in for the real line in quasi-steady-state lap
 * simulation (fast drivers use the whole width, which opens up every corner).
 *
 * Each station may move sideways by an offset n along the track's left
 * normal. Around a reference line with curvature k and station spacing h,
 * the curvature of the moved line is, to first order,
 *
 *     k(n) = k - n'' - k^2 n
 *
 * where n'' is the second derivative of the offset along the line and the
 * last term says that moving to the outside of a corner lowers its
 * curvature. The line minimises the integral of k(n)^2, a quadratic in the
 * offsets with a pentadiagonal matrix, solved exactly and re-linearised
 * around the new line a few times:
 *
 * - The loop is cut by pinning two neighbouring stations on a straight, which
 *   leaves an open chain whose matrix is banded; alternate solves put the cut
 *   on two different straights so every station gets to move.
 * - The edge limits are handled by an active-set method: offsets that would
 *   leave the track are held at the edge until the gradient says to release them.
 */
import { headingAndCurvature } from './geometry.ts';
import type { Track } from './track.ts';

export interface RacingLine {
  n: number;
  /** Sideways offset from the centreline in metres, positive to the left. */
  offset: Float64Array;
  x: Float64Array;
  y: Float64Array;
  heading: Float64Array;
  /** Signed curvature of the line in 1/m, positive turning right. */
  curvature: Float64Array;
  /** Length from station k to station k + 1 along the line. */
  ds: Float64Array;
  /** Distance along the line from station 0. */
  s: Float64Array;
  length: number;
}

/** Space kept between the line and each track edge: half a car's width plus a little. */
export const LINE_MARGIN = 1.2;
const LINEARISATIONS = 8;
/** Largest sideways move per linearisation, so each step stays where the first-order model holds. */
const STEP_LIMIT = 4;
const MAX_ACTIVE_SET_ITERATIONS = 80;
/** Smoothing of the line's curvature in metres. */
const CURVATURE_SMOOTHING = 3;

export function computeRacingLine(t: Track, margin = LINE_MARGIN): RacingLine {
  const n = t.n;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const limit = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    nx[k] = Math.sin(t.heading[k]);
    ny[k] = -Math.cos(t.heading[k]);
    limit[k] = Math.max(0, t.width[k] / 2 - margin);
  }

  // Two cuts on the straightest stations, at least a third of a lap apart.
  const cutA = straightest(t, -1);
  const cutB = straightest(t, cutA);

  const offset = new Float64Array(n);
  for (let it = 0; it < LINEARISATIONS; it++) {
    const ref = lineGeometry(t, nx, ny, offset);
    solveStep(ref.curvature, ref.spacing, limit, offset, it % 2 === 0 ? cutA : cutB);
  }

  const g = lineGeometry(t, nx, ny, offset);
  const ds = new Float64Array(n);
  const s = new Float64Array(n);
  let length = 0;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    s[k] = length;
    ds[k] = Math.max(1e-6, Math.hypot(g.x[k1] - g.x[k], g.y[k1] - g.y[k]));
    length += ds[k];
  }
  return { n, offset, x: g.x, y: g.y, heading: g.heading, curvature: g.curvature, ds, s, length };
}

/** Points, heading, curvature and local spacing of the line at the given offsets. */
function lineGeometry(t: Track, nx: Float64Array, ny: Float64Array, offset: Float64Array) {
  const n = t.n;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    x[k] = t.x[k] + offset[k] * nx[k];
    y[k] = t.y[k] + offset[k] * ny[k];
  }
  const seg = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    seg[k] = Math.hypot(x[j] - x[k], y[j] - y[k]);
  }
  const spacing = new Float64Array(n);
  for (let k = 0; k < n; k++) spacing[k] = Math.max(1e-3, (seg[(k - 1 + n) % n] + seg[k]) / 2);
  const { heading, curvature } = headingAndCurvature(x, y, CURVATURE_SMOOTHING / t.ds);
  return { x, y, heading, curvature, spacing };
}

/** The station with the smallest curvature, at least a third of a lap from `avoid` (if given). */
function straightest(t: Track, avoid: number): number {
  let best = -1;
  for (let k = 0; k < t.n; k++) {
    if (avoid >= 0) {
      const d = Math.abs(k - avoid);
      if (Math.min(d, t.n - d) < t.n / 3) continue;
    }
    if (best < 0 || Math.abs(t.curvature[k]) < Math.abs(t.curvature[best])) best = k;
  }
  return best < 0 ? 0 : best;
}

/**
 * One linearised step: finds the change d in offsets minimising
 * sum_k h_k (kappa_k - d''_k - kappa_k^2 d_k)^2 with stations `cut` and
 * `cut + 1` held still and every offset kept within its limit (and within
 * STEP_LIMIT of where it was). Updates `offset` in place.
 */
function solveStep(kappa: Float64Array, h: Float64Array, limit: Float64Array, offset: Float64Array, cut: number): void {
  const n = kappa.length;
  const m = n - 2;
  const station = (i: number) => (cut + 2 + i) % n;
  const indexOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < m; i++) indexOf[station(i)] = i;

  // Normal equations H d = r of the chain (pinned stations have d = 0 and drop out).
  const d0 = new Float64Array(m);
  const d1 = new Float64Array(m); // H[i][i-1]
  const d2 = new Float64Array(m); // H[i][i-2]
  const rhs = new Float64Array(m);
  const st = [0, 0, 0];
  const cf = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const inv = 1 / (h[k] * h[k]);
    // Row k of the linear map d -> change in curvature at k.
    st[0] = (k - 1 + n) % n;
    st[1] = k;
    st[2] = (k + 1) % n;
    cf[0] = -inv;
    cf[1] = 2 * inv - kappa[k] * kappa[k];
    cf[2] = -inv;
    const w = h[k];
    for (let p = 0; p < 3; p++) {
      const ii = indexOf[st[p]];
      if (ii < 0) continue;
      rhs[ii] -= w * cf[p] * kappa[k];
      for (let q = 0; q < 3; q++) {
        const jj = indexOf[st[q]];
        if (jj < 0) continue;
        const v = w * cf[p] * cf[q];
        if (p === q) d0[ii] += v;
        else if (p > q) {
          // Each unordered pair once, stored in the lower band of the later chain index.
          const hi = Math.max(ii, jj);
          if (Math.abs(ii - jj) === 1) d1[hi] += v;
          else d2[hi] += v;
        }
      }
    }
  }
  for (let i = 0; i < m; i++) d0[i] += 1e-9;

  // Bounds on the change: stay on the track and within the step limit.
  const lo = new Float64Array(m);
  const hi = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const k = station(i);
    lo[i] = Math.max(-limit[k] - offset[k], -STEP_LIMIT);
    hi[i] = Math.min(limit[k] - offset[k], STEP_LIMIT);
    if (lo[i] > hi[i]) lo[i] = hi[i] = Math.max(-limit[k], Math.min(limit[k], offset[k])) - offset[k];
  }

  // Active-set iterations: -1 held at the lower bound, +1 at the upper bound, 0 free.
  const state = new Int8Array(m);
  for (let i = 0; i < m; i++) if (hi[i] - lo[i] < 1e-9) state[i] = 1;
  const x = new Float64Array(m);
  for (let iter = 0; iter < MAX_ACTIVE_SET_ITERATIONS; iter++) {
    solveBanded(d0, d1, d2, rhs, state, (i) => (state[i] > 0 ? hi[i] : lo[i]), x);
    let changed = false;
    for (let i = 0; i < m; i++) {
      if (state[i] !== 0) continue;
      if (x[i] > hi[i]) { state[i] = 1; changed = true; }
      else if (x[i] < lo[i]) { state[i] = -1; changed = true; }
    }
    if (!changed) {
      // Release held changes whose gradient points back inside the bounds.
      for (let i = 0; i < m; i++) {
        if (state[i] === 0 || hi[i] - lo[i] < 1e-9) continue;
        let g = d0[i] * x[i] - rhs[i];
        if (i >= 1) g += d1[i] * x[i - 1];
        if (i >= 2) g += d2[i] * x[i - 2];
        if (i + 1 < m) g += d1[i + 1] * x[i + 1];
        if (i + 2 < m) g += d2[i + 2] * x[i + 2];
        if ((state[i] === 1 && g > 1e-12) || (state[i] === -1 && g < -1e-12)) {
          state[i] = 0;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < m; i++) {
    const k = station(i);
    offset[k] = Math.max(-limit[k], Math.min(limit[k], offset[k] + Math.max(lo[i], Math.min(hi[i], x[i]))));
  }
}

/**
 * Solves the symmetric pentadiagonal system (diagonal d0, sub-diagonals d1
 * and d2) with held variables fixed at `held(i)`, by LDL^T factorisation.
 */
function solveBanded(
  d0: Float64Array, d1: Float64Array, d2: Float64Array, rhs: Float64Array,
  state: Int8Array, held: (i: number) => number, out: Float64Array,
): void {
  const m = d0.length;
  const a0 = Float64Array.from(d0);
  const a1 = Float64Array.from(d1);
  const a2 = Float64Array.from(d2);
  const b = Float64Array.from(rhs);
  // Replace held rows and columns by identity, moving their known values to the right-hand side.
  for (let i = 0; i < m; i++) {
    if (state[i] === 0) continue;
    const v = held(i);
    if (i + 1 < m) { b[i + 1] -= a1[i + 1] * v; a1[i + 1] = 0; }
    if (i + 2 < m) { b[i + 2] -= a2[i + 2] * v; a2[i + 2] = 0; }
    if (i >= 1) { b[i - 1] -= a1[i] * v; a1[i] = 0; }
    if (i >= 2) { b[i - 2] -= a2[i] * v; a2[i] = 0; }
    a0[i] = 1;
    b[i] = v;
  }
  // Factorise A = L D L^T with unit lower L (bands l1, l2).
  const D = new Float64Array(m);
  const l1 = new Float64Array(m);
  const l2 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    if (i >= 2) l2[i] = a2[i] / D[i - 2];
    if (i >= 1) l1[i] = (a1[i] - (i >= 2 ? l2[i] * l1[i - 1] * D[i - 2] : 0)) / D[i - 1];
    D[i] = a0[i] - (i >= 1 ? l1[i] * l1[i] * D[i - 1] : 0) - (i >= 2 ? l2[i] * l2[i] * D[i - 2] : 0);
    if (Math.abs(D[i]) < 1e-15) D[i] = 1e-15;
  }
  // Forward, diagonal and backward substitution.
  for (let i = 0; i < m; i++) out[i] = b[i] - (i >= 1 ? l1[i] * out[i - 1] : 0) - (i >= 2 ? l2[i] * out[i - 2] : 0);
  for (let i = 0; i < m; i++) out[i] /= D[i];
  for (let i = m - 1; i >= 0; i--) out[i] -= (i + 1 < m ? l1[i + 1] * out[i + 1] : 0) + (i + 2 < m ? l2[i + 2] * out[i + 2] : 0);
}
