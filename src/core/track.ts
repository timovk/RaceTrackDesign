/**
 * Turns the designer's control points into a dense, evenly spaced list of
 * stations: position, heading, curvature, width and graded elevation every
 * couple of metres. Everything downstream (metrics, warnings, the profile and
 * later the lap and race simulations) reads from these stations.
 *
 * Sign convention: world y points south, so a positive curvature is a
 * right-hand corner and a positive gradient is uphill in the direction of travel.
 */
import { mod, sampleClosedSpline, smoothCircular, wrapAngle } from './geometry.ts';
import { type Heightmap, sampleHeight } from './heightmap.ts';

export interface ControlPoint {
  x: number;
  y: number;
  /** Track width in metres at this point; blends smoothly to the next point. */
  width: number;
}

export interface GradingSettings {
  /** Length in metres over which the terrain profile is smoothed; 0 follows the terrain exactly. */
  smoothing: number;
  /** Largest allowed cut or fill in metres. */
  maxCutFill: number;
}

export interface TrackDesign {
  /** Control points in the direction of travel. */
  points: ControlPoint[];
  /** Width given to new points. */
  defaultWidth: number;
  grading: GradingSettings;
}

export interface Track {
  /** Number of stations. */
  n: number;
  /** Distance between stations in metres. */
  ds: number;
  /** Lap length in metres. */
  length: number;
  x: Float64Array;
  y: Float64Array;
  /** Distance from the first control point in metres. */
  s: Float64Array;
  /** Direction of travel in radians (atan2 in world coordinates). */
  heading: Float64Array;
  /** Signed curvature in 1/m; positive turns right. */
  curvature: Float64Array;
  width: Float64Array;
  /** Natural ground elevation under the centreline. */
  terrain: Float64Array;
  /** Graded track elevation. */
  z: Float64Array;
  /** dz/ds; 0.05 is 5% uphill. */
  gradient: Float64Array;
  /** d2z/ds2 in 1/m; negative on crests, positive in dips. */
  vcurv: Float64Array;
  leftX: Float64Array;
  leftY: Float64Array;
  rightX: Float64Array;
  rightY: Float64Array;
  /** Control segment each station belongs to. */
  seg: Int32Array;
  /** Station at each control point. */
  pointStations: Int32Array;
}

export const STATION_SPACING = 2;
/** Curvature is smoothed over about this many metres to remove sampling noise. */
const CURVATURE_SMOOTHING = 4;
const VCURV_SMOOTHING = 6;

export const DEFAULT_GRADING: GradingSettings = { smoothing: 60, maxCutFill: 12 };
export const DEFAULT_WIDTH = 12;

export function emptyDesign(): TrackDesign {
  return { points: [], defaultWidth: DEFAULT_WIDTH, grading: { ...DEFAULT_GRADING } };
}

/** Builds stations for a closed track; null when there are fewer than three points. */
export function buildTrack(design: TrackDesign, hm: Heightmap, spacing = STATION_SPACING): Track | null {
  const pts = design.points;
  if (pts.length < 3) return null;

  const dense = sampleClosedSpline(pts);
  const cum = new Float64Array(dense.length);
  for (let k = 1; k < dense.length; k++) {
    const dx = dense[k].x - dense[k - 1].x;
    const dy = dense[k].y - dense[k - 1].y;
    cum[k] = cum[k - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  const length = cum[dense.length - 1];
  if (length < 10 * spacing) return null;
  const n = Math.round(length / spacing);
  const ds = length / n;

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const s = new Float64Array(n);
  const width = new Float64Array(n);
  const seg = new Int32Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = k * ds;
    while (j < dense.length - 2 && cum[j + 1] < target) j++;
    const span = cum[j + 1] - cum[j];
    const f = span > 0 ? (target - cum[j]) / span : 0;
    const a = dense[j];
    const b = dense[j + 1];
    x[k] = a.x + (b.x - a.x) * f;
    y[k] = a.y + (b.y - a.y) * f;
    s[k] = target;
    const i = a.seg;
    // Parameter within the segment; the closing sample carries u = 1 of the last segment.
    const u = b.seg === i ? a.u + (b.u - a.u) * f : a.u + (1 - a.u) * f;
    const w = u * u * (3 - 2 * u);
    width[k] = pts[i].width + (pts[(i + 1) % pts.length].width - pts[i].width) * w;
    seg[k] = i;
  }

  // Station of each control point: where its segment starts along the dense curve.
  const pointStations = new Int32Array(pts.length);
  for (let k = 0, i = 0; k < dense.length - 1 && i < pts.length; k++) {
    if (dense[k].seg === i && dense[k].u === 0) {
      pointStations[i] = mod(Math.round(cum[k] / ds), n);
      i++;
    }
  }

  // Headings of the chords between stations, then curvature as the change in heading per metre.
  const chord = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    chord[k] = Math.atan2(y[k1] - y[k], x[k1] - x[k]);
  }
  const heading = new Float64Array(n);
  const rawCurv = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const prev = chord[mod(k - 1, n)];
    const turn = wrapAngle(chord[k] - prev);
    heading[k] = wrapAngle(prev + turn / 2);
    rawCurv[k] = turn / ds;
  }
  const curvature = smoothCircular(rawCurv, CURVATURE_SMOOTHING / ds);

  const terrain = new Float64Array(n);
  for (let k = 0; k < n; k++) terrain[k] = sampleHeight(hm, x[k], y[k]);
  const z = gradeProfile(terrain, ds, design.grading);

  const gradient = new Float64Array(n);
  const rawV = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const zp = z[mod(k - 1, n)];
    const zn = z[(k + 1) % n];
    gradient[k] = (zn - zp) / (2 * ds);
    rawV[k] = (zn - 2 * z[k] + zp) / (ds * ds);
  }
  const vcurv = smoothCircular(rawV, VCURV_SMOOTHING / ds);

  const leftX = new Float64Array(n);
  const leftY = new Float64Array(n);
  const rightX = new Float64Array(n);
  const rightY = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // With y pointing south, the driver's left is the heading rotated anticlockwise on screen.
    const nx = Math.sin(heading[k]);
    const ny = -Math.cos(heading[k]);
    const half = width[k] / 2;
    leftX[k] = x[k] + nx * half;
    leftY[k] = y[k] + ny * half;
    rightX[k] = x[k] - nx * half;
    rightY[k] = y[k] - ny * half;
  }

  return {
    n, ds, length, x, y, s, heading, curvature, width, terrain, z, gradient, vcurv,
    leftX, leftY, rightX, rightY, seg, pointStations,
  };
}

/**
 * Grades the terrain profile the way a circuit is built: smooth it, but never
 * cut or fill more than the limit. Alternating smoothing and clamping settles
 * on a profile that is smooth wherever the limit allows and hugs the limit
 * where the terrain is too rough to flatten. Working from coarse to fine
 * smoothing rounds off the kinks where the clamp takes over; a final
 * relaxation lets the profile bridge small bumps where the limit binds
 * instead of copying them, and ending on a clamp keeps the limit exact.
 */
export function gradeProfile(terrain: Float64Array, ds: number, grading: GradingSettings): Float64Array {
  const n = terrain.length;
  const sigma = grading.smoothing / ds;
  const limit = Math.max(0, grading.maxCutFill);
  if (sigma < 0.5) return Float64Array.from(terrain);
  const clamp = (z: Float64Array) => {
    for (let k = 0; k < n; k++) {
      const lo = terrain[k] - limit;
      const hi = terrain[k] + limit;
      if (z[k] < lo) z[k] = lo;
      else if (z[k] > hi) z[k] = hi;
    }
  };

  const finest = Math.min(sigma, 4 / ds);
  let z: Float64Array = Float64Array.from(terrain);
  for (let sg = sigma; ; sg /= 2) {
    const s = Math.max(sg, finest);
    for (let rep = 0; rep < 2; rep++) {
      z = smoothCircular(z, s);
      clamp(z);
    }
    if (s <= finest) break;
  }

  // Projected relaxation: each step spreads the profile by a variance of half a
  // station, so this adds at most about 20 m of extra smoothing.
  const reach = Math.min(sigma / 2, 10 / ds);
  const steps = Math.round(2 * reach * reach);
  let next: Float64Array = new Float64Array(n);
  for (let it = 0; it < steps; it++) {
    for (let k = 0; k < n; k++) {
      next[k] = 0.5 * z[k] + 0.25 * (z[k === 0 ? n - 1 : k - 1] + z[k === n - 1 ? 0 : k + 1]);
    }
    clamp(next);
    [z, next] = [next, z];
  }
  return z;
}
