/**
 * Minimum-curvature racing line: the smoothest path around the lap that
 * stays inside the track edges, with a margin for the width of the car. It
 * is the standard stand-in for the real line in quasi-steady-state lap
 * simulation (fast drivers use the whole width, which opens up every corner).
 *
 * Each station may move sideways by an offset along the track's left
 * normal. The line minimises its bending energy, the sum over stations of
 *
 *     turn^2 / spacing
 *
 * where `turn` is the angle between the chords to the previous and the next
 * station and `spacing` the mean length of those chords: the integral of
 * curvature squared, measured on the line itself, so moving to the outside
 * of a corner makes it both gentler and longer. Each term depends on three
 * neighbouring offsets, so the exact Hessian is a cyclic band five wide,
 * and Newton's method solves the problem to convergence:
 *
 * - The edge limits are kept by a primal-dual interior-point method: a log
 *   barrier pushes the line off the edges and is weakened step by step until
 *   the line touches them. It makes no yes-or-no choice per station (unlike
 *   an active-set method), so the line moves smoothly with the track and a
 *   track moved a millimetre gives the same lap.
 * - The whole loop is solved at once: numbering the stations alternately
 *   from both ends of the loop turns its cyclic matrix into an ordinary band.
 * - Far from the solution the Hessian may not be positive definite; a
 *   multiple of the identity is then added. Each step is halved until it
 *   lowers the bending energy plus the barrier.
 * - On the inside of a sharp bend the line keeps short of where the normals
 *   of neighbouring stations cross, where the stations would bunch up.
 */
import { headingAndCurvature, wrapAngle } from './geometry.ts';
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

/**
 * Limits on the line's offset from the centreline at each station, in place
 * of the track's edges less the margin: the part of the road a car keeps to
 * with another beside it (see race/lanes.ts).
 */
export interface Corridor {
  lo: ArrayLike<number>;
  hi: ArrayLike<number>;
}
/** Newton steps at most; a 5 km circuit takes about 40. */
const MAX_ITERATIONS = 200;
/** Barrier weight at the start and at the end, where the line is within about a centimetre of the edges it touches. */
const BARRIER_START = 1e-3;
const BARRIER_END = 1e-9;
/** A barrier problem counts as solved when its optimality error is below this many times the barrier weight. */
const BARRIER_TOLERANCE = 10;
/** Share of the gap to a limit (or of a multiplier) a step may use up. */
const TO_BOUNDARY = 0.995;
/** Share of the distance to where neighbouring normals cross that the line may use on the inside of a bend. */
const CROSSING = 0.9;
/** Smoothing of the line's curvature in metres. */
const CURVATURE_SMOOTHING = 3;

export function computeRacingLine(t: Track, margin = LINE_MARGIN, corridor?: Corridor): RacingLine {
  const n = t.n;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    nx[k] = Math.sin(t.heading[k]);
    ny[k] = -Math.cos(t.heading[k]);
    const limit = Math.max(0, t.width[k] / 2 - margin);
    lo[k] = corridor ? corridor.lo[k] : -limit;
    hi[k] = corridor ? corridor.hi[k] : limit;
  }
  // Neighbouring normals cross at chord / turn on the inside of a bend (the right for a right-hander).
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const turn = wrapAngle(t.heading[k1] - t.heading[k]);
    if (Math.abs(turn) < 1e-9) continue;
    const reach = (CROSSING * Math.hypot(t.x[k1] - t.x[k], t.y[k1] - t.y[k])) / Math.abs(turn);
    if (turn > 0) {
      lo[k] = Math.max(lo[k], -reach);
      lo[k1] = Math.max(lo[k1], -reach);
    } else {
      hi[k] = Math.min(hi[k], reach);
      hi[k1] = Math.min(hi[k1], reach);
    }
  }
  // Stations with no room to move stay on the centreline (in a corridor: in its middle, or where the bend's inside ends).
  const held = new Uint8Array(n);
  const offset = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (!corridor) {
      held[k] = Math.min(-lo[k], hi[k]) < 1e-6 ? 1 : 0;
      continue;
    }
    if (hi[k] - lo[k] < 1e-6) {
      held[k] = 1;
      // Limits that cross (a road too narrow for the corridor, or normals crossing inside it): the one nearer the centreline holds.
      const at = Math.abs(lo[k]) < Math.abs(hi[k]) ? lo[k] : hi[k];
      lo[k] = hi[k] = offset[k] = at;
    } else offset[k] = (lo[k] + hi[k]) / 2;
  }

  const trial = new Float64Array(n);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const g = new Float64Array(n);
  const h0 = new Float64Array(n);
  const h1 = new Float64Array(n);
  const h2 = new Float64Array(n);
  const diag = new Float64Array(n);
  const rhs = new Float64Array(n);
  const step = new Float64Array(n);
  // Multipliers of the lower and upper limits.
  const zl = new Float64Array(n);
  const zu = new Float64Array(n);
  const solver = new CyclicSolver(n);

  const place = (o: Float64Array) => {
    for (let k = 0; k < n; k++) {
      px[k] = t.x[k] + o[k] * nx[k];
      py[k] = t.y[k] + o[k] * ny[k];
    }
  };
  const barrier = (o: Float64Array, mu: number) => {
    let sum = 0;
    for (let k = 0; k < n; k++) if (!held[k]) sum += Math.log(o[k] - lo[k]) + Math.log(hi[k] - o[k]);
    return -mu * sum;
  };

  let mu = BARRIER_START;
  for (let k = 0; k < n; k++) {
    if (held[k]) continue;
    zl[k] = mu / (offset[k] - lo[k]);
    zu[k] = mu / (hi[k] - offset[k]);
  }
  place(offset);
  let energy = bending(px, py);
  let shift = 0;
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    place(offset);
    bendingDerivatives(px, py, nx, ny, g, h0, h1, h2);
    let error = 0;
    for (let k = 0; k < n; k++) {
      if (held[k]) continue;
      const sl = offset[k] - lo[k];
      const su = hi[k] - offset[k];
      error = Math.max(error, Math.abs(g[k] - zl[k] + zu[k]), Math.abs(sl * zl[k] - mu), Math.abs(su * zu[k] - mu));
    }
    if (error < BARRIER_TOLERANCE * mu) {
      if (mu <= BARRIER_END) break;
      mu = Math.max(BARRIER_END, Math.min(0.2 * mu, mu * Math.sqrt(mu)));
      continue;
    }

    // Newton step for the barrier problem: (H + Zl/Sl + Zu/Su) step = -(g - mu/Sl + mu/Su).
    for (let k = 0; k < n; k++) {
      if (held[k]) {
        diag[k] = h0[k];
        rhs[k] = 0;
        continue;
      }
      const sl = offset[k] - lo[k];
      const su = hi[k] - offset[k];
      diag[k] = h0[k] + zl[k] / sl + zu[k] / su;
      rhs[k] = g[k] - mu / sl + mu / su;
    }
    while (!solver.solve(diag, h1, h2, shift, rhs, held, step)) shift = shift > 0 ? 4 * shift : 1e-6 * meanAbs(h0);

    // Largest steps that keep the offsets inside their limits and the multipliers positive.
    let primal = 1;
    let dual = 1;
    let slope = 0;
    for (let k = 0; k < n; k++) {
      if (held[k]) continue;
      const sl = offset[k] - lo[k];
      const su = hi[k] - offset[k];
      if (step[k] < 0) primal = Math.min(primal, (-TO_BOUNDARY * sl) / step[k]);
      else if (step[k] > 0) primal = Math.min(primal, (TO_BOUNDARY * su) / step[k]);
      const dzl = mu / sl - zl[k] - (zl[k] / sl) * step[k];
      const dzu = mu / su - zu[k] + (zu[k] / su) * step[k];
      if (dzl < 0) dual = Math.min(dual, (-TO_BOUNDARY * zl[k]) / dzl);
      if (dzu < 0) dual = Math.min(dual, (-TO_BOUNDARY * zu[k]) / dzu);
      slope += rhs[k] * step[k];
    }

    // Backtrack until the step lowers the bending energy plus the barrier.
    const merit = energy + barrier(offset, mu);
    let alpha = primal;
    let improved = false;
    for (let tries = 0; tries < 40 && !improved; tries++) {
      for (let k = 0; k < n; k++) trial[k] = offset[k] + alpha * step[k];
      place(trial);
      const e = bending(px, py);
      if (e + barrier(trial, mu) <= merit + 1e-4 * alpha * slope) {
        energy = e;
        improved = true;
      } else alpha /= 2;
    }
    if (!improved) break;
    if (alpha === primal) shift /= 4;

    for (let k = 0; k < n; k++) {
      if (held[k]) continue;
      const sl = offset[k] - lo[k];
      const su = hi[k] - offset[k];
      zl[k] += dual * (mu / sl - zl[k] - (zl[k] / sl) * step[k]);
      zu[k] += dual * (mu / su - zu[k] + (zu[k] / su) * step[k]);
      offset[k] = trial[k];
      // Keep each multiplier within a wide band of mu / gap, so the barrier Hessian stays sound.
      const nl = offset[k] - lo[k];
      const nu = hi[k] - offset[k];
      zl[k] = Math.max(mu / (1e10 * nl), Math.min(zl[k], (1e10 * mu) / nl));
      zu[k] = Math.max(mu / (1e10 * nu), Math.min(zu[k], (1e10 * mu) / nu));
    }
  }

  place(offset);
  const x = Float64Array.from(px);
  const y = Float64Array.from(py);
  const { heading, curvature } = headingAndCurvature(x, y, CURVATURE_SMOOTHING / t.ds);
  const ds = new Float64Array(n);
  const s = new Float64Array(n);
  let length = 0;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    s[k] = length;
    ds[k] = Math.max(1e-6, Math.hypot(x[k1] - x[k], y[k1] - y[k]));
    length += ds[k];
  }
  return { n, offset, x, y, heading, curvature, ds, s, length };
}

function meanAbs(a: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]);
  return sum / a.length;
}

/** Bending energy of a closed polyline: the sum of turn^2 / spacing over its points. */
function bending(x: Float64Array, y: Float64Array): number {
  const n = x.length;
  let e = 0;
  for (let k = 0; k < n; k++) {
    const p = k === 0 ? n - 1 : k - 1;
    const q = k === n - 1 ? 0 : k + 1;
    const ax = x[k] - x[p];
    const ay = y[k] - y[p];
    const bx = x[q] - x[k];
    const by = y[q] - y[k];
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    e += (turn * turn) / ((Math.sqrt(ax * ax + ay * ay) + Math.sqrt(bx * bx + by * by)) / 2);
  }
  return e;
}

/**
 * Gradient `g` and Hessian of the bending energy with respect to the offsets
 * along the normals (nx, ny). The Hessian comes as cyclic bands:
 * h0[i] = H[i][i], h1[i] = H[i][i+1], h2[i] = H[i][i+2].
 */
function bendingDerivatives(
  x: Float64Array, y: Float64Array, nx: Float64Array, ny: Float64Array,
  g: Float64Array, h0: Float64Array, h1: Float64Array, h2: Float64Array,
): void {
  const n = x.length;
  g.fill(0);
  h0.fill(0);
  h1.fill(0);
  h2.fill(0);
  // Each term is a function of the chords a = P[k] - P[k-1] and b = P[k+1] - P[k], as (ax, ay, bx, by).
  const dTurn = new Float64Array(4);
  const dSpacing = new Float64Array(4);
  const grad = new Float64Array(4);
  const hess = new Float64Array(16);
  // How (ax, ay, bx, by) change with the offsets of stations k-1, k and k+1, a row each.
  const chain = new Float64Array(12);
  const local = new Float64Array(9);
  for (let k = 0; k < n; k++) {
    const p = k === 0 ? n - 1 : k - 1;
    const q = k === n - 1 ? 0 : k + 1;
    const ax = x[k] - x[p];
    const ay = y[k] - y[p];
    const bx = x[q] - x[k];
    const by = y[q] - y[k];
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const a1 = Math.sqrt(a2);
    const b1 = Math.sqrt(b2);
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    const spacing = (a1 + b1) / 2;

    dTurn[0] = ay / a2;
    dTurn[1] = -ax / a2;
    dTurn[2] = -by / b2;
    dTurn[3] = bx / b2;
    dSpacing[0] = ax / (2 * a1);
    dSpacing[1] = ay / (2 * a1);
    dSpacing[2] = bx / (2 * b1);
    dSpacing[3] = by / (2 * b1);
    // Partial derivatives of turn^2 / spacing.
    const fT = (2 * turn) / spacing;
    const fS = -(turn * turn) / (spacing * spacing);
    const fTT = 2 / spacing;
    const fTS = (-2 * turn) / (spacing * spacing);
    const fSS = (2 * turn * turn) / (spacing * spacing * spacing);
    for (let i = 0; i < 4; i++) {
      grad[i] = fT * dTurn[i] + fS * dSpacing[i];
      for (let j = 0; j < 4; j++) {
        hess[i * 4 + j] = fTT * dTurn[i] * dTurn[j] + fTS * (dTurn[i] * dSpacing[j] + dSpacing[i] * dTurn[j]) + fSS * dSpacing[i] * dSpacing[j];
      }
    }
    // Second derivatives of the turn (the chord angles) and of the spacing (the chord lengths), within a and within b.
    const a4 = a2 * a2;
    const b4 = b2 * b2;
    const a3 = 2 * a2 * a1;
    const b3 = 2 * b2 * b1;
    addBlock(hess, 0, fT * (-2 * ax * ay) / a4 + fS * (ay * ay) / a3, fT * (ax * ax - ay * ay) / a4 - fS * (ax * ay) / a3, fT * (2 * ax * ay) / a4 + fS * (ax * ax) / a3);
    addBlock(hess, 2, fT * (2 * bx * by) / b4 + fS * (by * by) / b3, fT * (by * by - bx * bx) / b4 - fS * (bx * by) / b3, fT * (-2 * bx * by) / b4 + fS * (bx * bx) / b3);

    chain.fill(0);
    chain[0] = -nx[p];
    chain[1] = -ny[p];
    chain[4] = nx[k];
    chain[5] = ny[k];
    chain[6] = -nx[k];
    chain[7] = -ny[k];
    chain[10] = nx[q];
    chain[11] = ny[q];
    for (let r = 0; r < 3; r++) {
      for (let c = r; c < 3; c++) {
        let v = 0;
        for (let i = 0; i < 4; i++) {
          let row = 0;
          for (let j = 0; j < 4; j++) row += hess[i * 4 + j] * chain[c * 4 + j];
          v += chain[r * 4 + i] * row;
        }
        local[r * 3 + c] = v;
      }
    }
    for (let i = 0; i < 4; i++) {
      g[p] += grad[i] * chain[i];
      g[k] += grad[i] * chain[4 + i];
      g[q] += grad[i] * chain[8 + i];
    }
    h0[p] += local[0];
    h0[k] += local[4];
    h0[q] += local[8];
    h1[p] += local[1];
    h1[k] += local[5];
    h2[p] += local[2];
  }
}

/** Adds a symmetric 2x2 block (v00, v01, v11) to a 4x4 matrix at row and column `at`. */
function addBlock(m: Float64Array, at: number, v00: number, v01: number, v11: number): void {
  m[at * 4 + at] += v00;
  m[at * 4 + at + 1] += v01;
  m[(at + 1) * 4 + at] += v01;
  m[(at + 1) * 4 + at + 1] += v11;
}

/**
 * Solves a symmetric cyclic pentadiagonal system. Numbering the stations
 * alternately from both ends of the loop (0, 1, m-1, 2, m-2, ...) puts every
 * pair of stations up to two apart at most four places apart, so the matrix
 * becomes an ordinary band and is factorised as L D L^T.
 */
class CyclicSolver {
  private readonly m: number;
  private readonly order: Int32Array;
  private readonly pos: Int32Array;
  /** Row i holds the diagonal and the four entries left of it, then L. */
  private readonly band: Float64Array;
  private readonly b: Float64Array;
  private readonly d: Float64Array;

  constructor(m: number) {
    this.m = m;
    this.order = new Int32Array(m);
    this.pos = new Int32Array(m);
    for (let i = 1, lo = 1, hi = m - 1; lo <= hi; ) {
      this.order[i++] = lo++;
      if (lo <= hi) this.order[i++] = hi--;
    }
    for (let i = 0; i < m; i++) this.pos[this.order[i]] = i;
    this.band = new Float64Array(m * 5);
    this.b = new Float64Array(m);
    this.d = new Float64Array(m);
  }

  /**
   * Solves (H + shift I) x = -g, where H has diagonal h0 and h1[i] = H[i][i+1],
   * h2[i] = H[i][i+2] (indices round the loop), with `held` unknowns at 0.
   * False when the matrix is not positive definite.
   */
  solve(
    h0: Float64Array, h1: Float64Array, h2: Float64Array, shift: number, g: Float64Array,
    held: Uint8Array, out: Float64Array,
  ): boolean {
    const { m, pos, order, band: A, b, d } = this;
    A.fill(0);
    for (let s = 0; s < m; s++) {
      const I = pos[s];
      A[I * 5] = h0[s] + shift;
      b[I] = -g[s];
      const J1 = pos[(s + 1) % m];
      const J2 = pos[(s + 2) % m];
      A[Math.max(I, J1) * 5 + Math.abs(I - J1)] = h1[s];
      A[Math.max(I, J2) * 5 + Math.abs(I - J2)] = h2[s];
    }
    for (let s = 0; s < m; s++) {
      if (!held[s]) continue;
      const I = pos[s];
      for (let j = 1; j <= 4; j++) {
        if (I - j >= 0) A[I * 5 + j] = 0;
        if (I + j < m) A[(I + j) * 5 + j] = 0;
      }
      A[I * 5] = 1;
      b[I] = 0;
    }
    // In place: A[i * 5 + j] becomes L[i][i - j].
    for (let i = 0; i < m; i++) {
      const j0 = Math.max(0, i - 4);
      for (let j = j0; j < i; j++) {
        let v = A[i * 5 + (i - j)];
        for (let k = Math.max(j0, j - 4); k < j; k++) v -= A[i * 5 + (i - k)] * A[j * 5 + (j - k)] * d[k];
        A[i * 5 + (i - j)] = v / d[j];
      }
      let v = A[i * 5];
      for (let k = j0; k < i; k++) v -= A[i * 5 + (i - k)] * A[i * 5 + (i - k)] * d[k];
      if (!(v > 0)) return false;
      d[i] = v;
    }
    for (let i = 0; i < m; i++) {
      for (let k = Math.max(0, i - 4); k < i; k++) b[i] -= A[i * 5 + (i - k)] * b[k];
    }
    for (let i = 0; i < m; i++) b[i] /= d[i];
    for (let i = m - 1; i >= 0; i--) {
      for (let k = i + 1; k <= Math.min(m - 1, i + 4); k++) b[i] -= A[k * 5 + (k - i)] * b[k];
    }
    for (let i = 0; i < m; i++) out[order[i]] = b[i];
    return true;
  }
}
