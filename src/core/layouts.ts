/**
 * Layouts: other versions of a circuit that share most of it, as at
 * Silverstone, Brands Hatch or Bahrain. A layout is the full circuit with
 * links taken: a link is a road that leaves the track at one point and joins
 * it again further round, and the layout skips the stretch of track in
 * between. A link across the infield makes a short layout; a loop out into
 * the country and back makes a long one.
 *
 * Where a layout runs on the full circuit it uses the circuit's own stations
 * (the same road at the same height), counted from the start line, which
 * every layout keeps. A link leaves and joins the track along its direction
 * of travel, through its own control points, and is graded over the ground
 * to meet the circuit's heights at both ends. Until its road and verges part
 * from the circuit's, it keeps the circuit's surface height: where the two
 * overlap they are one surface, so neither shows a step or the other's grass.
 */
import { VERGE } from './earthworks.ts';
import { type Vec2, dist, mod, sampleOpenSpline, segmentIntersection } from './geometry.ts';
import type { PitLane } from './pitLane.ts';
import type { RaceSettings } from './race/setup.ts';
import { type ControlPoint, type GradingSettings, type HeightSampler, type Track, finishTrack, gradeProfile } from './track.ts';

export interface LinkDesign {
  /** Where the link leaves and joins the full circuit (world positions; each snaps to the nearest station). */
  from: Vec2;
  to: Vec2;
  /** Control points in between, in the direction of travel. */
  points: ControlPoint[];
}

export interface LayoutDesign {
  name: string;
  links: LinkDesign[];
  /** The layout's own race setup, null until one is set up. */
  race: RaceSettings | null;
}

/** A link as built: the full circuit's stations where it leaves and joins it, and its path from one to the other. */
export interface LinkPath {
  from: number;
  to: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  width: Float64Array;
}

export interface LayoutBuild {
  /** The layout's stations with the start line at station 0, or null when it cannot be built. */
  track: Track | null;
  /** Per station, the full circuit's station it runs on, or -1 on a link. */
  shared: Int32Array;
  /** Each link as built, in the order of the design. */
  links: LinkPath[];
  /** Why the layout cannot be built; empty when it can. */
  errors: string[];
  /** Problems that do not stop it: a link crossing the circuit on the level. */
  warnings: { link: number; message: string }[];
}

/** A link eases from the circuit's surface to its own grading over at least this many metres. */
const MIN_EASE = 30;
/** Most gradient the easing adds. */
const EASE_GRADE = 0.05;

/** A link's end must lie within this distance of the track's edge (metres). */
export const LINK_SNAP = 25;

/**
 * Builds a layout from the full circuit `full` (start line at station 0),
 * with links graded over `heightAt` as the circuit is (`grading`).
 */
export function buildLayout(full: Track, layout: LayoutDesign, heightAt: HeightSampler, grading: GradingSettings): LayoutBuild {
  const n = full.n;
  const errors: string[] = [];
  const failed = (): LayoutBuild => ({ track: null, shared: new Int32Array(0), links: [], errors, warnings: [] });
  if (!layout.links.length) {
    errors.push('It has no link: draw one from the track, across to another part of it.');
    return failed();
  }

  // Where each link leaves and joins, taking it the way round that follows the direction of travel.
  const resolved: { index: number; a: number; b: number; points: ControlPoint[] }[] = [];
  layout.links.forEach((link, i) => {
    const name = layout.links.length > 1 ? `Link ${i + 1}` : 'The link';
    const ra = nearestStation(full, link.from);
    const rb = nearestStation(full, link.to);
    if (ra.d > full.width[ra.k] / 2 + LINK_SNAP || rb.d > full.width[rb.k] / 2 + LINK_SNAP) {
      errors.push(`${name} does not start and end on the track.`);
      return;
    }
    const along = (k: number, from: Vec2, to: Vec2) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      return (dx * Math.cos(full.heading[k]) + dy * Math.sin(full.heading[k])) / len;
    };
    const fit = (a: number, b: number, pts: readonly ControlPoint[]) => {
      const at = (k: number) => ({ x: full.x[k], y: full.y[k] });
      const first = pts[0] ?? at(b);
      const last = pts[pts.length - 1] ?? at(a);
      return Math.min(along(a, at(a), first), along(b, last, at(b)));
    };
    const forward = fit(ra.k, rb.k, link.points);
    const reversed = fit(rb.k, ra.k, [...link.points].reverse());
    const flip = reversed > forward;
    const a = flip ? rb.k : ra.k;
    const b = flip ? ra.k : rb.k;
    if (Math.max(forward, reversed) < -0.5) errors.push(`${name} leaves or joins the track against the direction of travel.`);
    else if (a === b) errors.push(`${name} leaves and joins the track at the same place.`);
    else resolved.push({ index: i, a, b, points: flip ? [...link.points].reverse() : link.points });
  });
  if (errors.length) return failed();

  // The stretch each link skips (stations a+1 .. b-1) must keep clear of the start line and of the other links'.
  const span = (r: { a: number; b: number }) => mod(r.b - r.a, n);
  if (resolved.some((r) => mod(-r.a, n) > 0 && mod(-r.a, n) < span(r))) errors.push('It skips the start/finish line, which every layout keeps.');
  const order = [...resolved].sort((p, q) => p.a - q.a);
  for (let i = 0; i + 1 < order.length; i++) {
    const end = order[i].b === 0 ? n : order[i].b;
    if (end > order[i + 1].a) errors.push('Its links overlap: each must rejoin the track before the next one leaves it.');
  }
  if (errors.length) return failed();

  // Each link's path: leaving along the track, through its points, joining along the track; resampled at the station spacing.
  const ds = full.ds;
  const paths = new Map<number, { x: number[]; y: number[]; width: number[]; pinned: Float64Array }>();
  for (const r of resolved) {
    const at = (k: number): Vec2 => ({ x: full.x[k], y: full.y[k] });
    const pts: Vec2[] = [at(r.a), ...r.points, at(r.b)];
    const widths = [full.width[r.a], ...r.points.map((p) => p.width), full.width[r.b]];
    const dir = (k: number): Vec2 => ({ x: Math.cos(full.heading[k]), y: Math.sin(full.heading[k]) });
    const dense = sampleOpenSpline(pts, dir(r.a), dir(r.b));
    const cum = new Float64Array(dense.length);
    for (let k = 1; k < dense.length; k++) cum[k] = cum[k - 1] + dist(dense[k - 1].x, dense[k - 1].y, dense[k].x, dense[k].y);
    const length = cum[dense.length - 1];
    const m = Math.max(1, Math.round(length / ds));
    const path = { x: [] as number[], y: [] as number[], width: [] as number[], pinned: new Float64Array(0) };
    let j = 0;
    for (let s = 1; s < m; s++) {
      const target = (s * length) / m;
      while (j < dense.length - 2 && cum[j + 1] < target) j++;
      const f = cum[j + 1] > cum[j] ? (target - cum[j]) / (cum[j + 1] - cum[j]) : 0;
      const p = dense[j];
      const q = dense[j + 1];
      path.x.push(p.x + (q.x - p.x) * f);
      path.y.push(p.y + (q.y - p.y) * f);
      const u = q.seg === p.seg ? p.u + (q.u - p.u) * f : p.u + (1 - p.u) * f;
      const w = u * u * (3 - 2 * u);
      path.width.push(widths[p.seg] + (widths[p.seg + 1] - widths[p.seg]) * w);
    }
    // Where it leaves and joins, the link shares the circuit's surface until their roads and verges part.
    path.pinned = new Float64Array(path.x.length).fill(NaN);
    const pin = (s: number, near: number) => {
      const on = surfaceNear(full, path.x[s], path.y[s], near);
      if (on.d >= on.half + path.width[s] / 2 + VERGE) return false;
      path.pinned[s] = on.z;
      return true;
    };
    for (let s = 0; s < path.x.length && pin(s, r.a); s++);
    for (let s = path.x.length - 1; s >= 0 && Number.isNaN(path.pinned[s]) && pin(s, r.b); s--);
    paths.set(r.index, path);
  }

  // The layout: round the full circuit from the start line, along each link where it leaves.
  const x: number[] = [];
  const y: number[] = [];
  const width: number[] = [];
  const terrain: number[] = [];
  const fixed: number[] = [];
  const shared: number[] = [];
  const ranges = new Map<number, [number, number]>();
  let li = 0;
  for (let k = 0; k < n;) {
    x.push(full.x[k]);
    y.push(full.y[k]);
    width.push(full.width[k]);
    terrain.push(full.terrain[k]);
    fixed.push(full.z[k]);
    shared.push(k);
    const r = order[li];
    if (r && k === r.a) {
      const path = paths.get(r.index)!;
      const first = x.length;
      for (let s = 0; s < path.x.length; s++) {
        x.push(path.x[s]);
        y.push(path.y[s]);
        width.push(path.width[s]);
        terrain.push(heightAt(path.x[s], path.y[s]));
        fixed.push(NaN);
        shared.push(-1);
      }
      ranges.set(r.index, [first, x.length]);
      li++;
      if (r.b === 0) break;
      k = r.b;
      continue;
    }
    k++;
  }

  const terrainArr = Float64Array.from(terrain);
  const z = gradeProfile(terrainArr, ds, grading, Float64Array.from(fixed));
  // Each link takes the circuit's surface where they overlap, then eases back to its own grading.
  for (const r of resolved) {
    const [first, end] = ranges.get(r.index)!;
    const pinned = paths.get(r.index)!.pinned;
    const m = end - first;
    let left = 0;
    while (left < m && !Number.isNaN(pinned[left])) left++;
    let right = m;
    while (right > left && !Number.isNaN(pinned[right - 1])) right--;
    // How far each end's surface sits off the link's own grading, eased out over the grading's smoothing
    // length, or longer where they differ more (easing adds at most EASE_GRADE to the gradient).
    const ease = (offset: number) => {
      const steps = Math.min(right - left - 1, Math.max(grading.smoothing, MIN_EASE, (1.5 * Math.abs(offset)) / EASE_GRADE) / ds);
      return (s: number) => {
        const u = Math.min(1, s / (steps + 1));
        return offset * (1 - u * u * (3 - 2 * u));
      };
    };
    const fromLeft = left > 0 ? ease(pinned[left - 1] - z[first + left - 1]) : () => 0;
    const fromRight = right < m ? ease(pinned[right] - z[first + right]) : () => 0;
    for (let s = 0; s < m; s++) {
      z[first + s] = s < left || s >= right ? pinned[s] : z[first + s] + fromLeft(s - left + 1) + fromRight(right - s);
    }
  }
  const sharedArr = Int32Array.from(shared);
  const track = finishTrack({
    ds, x: Float64Array.from(x), y: Float64Array.from(y), width: Float64Array.from(width), terrain: terrainArr, z,
    seg: Int32Array.from(shared, (k) => (k >= 0 ? full.seg[k] : -1)), pointStations: new Int32Array(0),
  });

  // Each link's path for drawing, from the station it leaves to the one it joins.
  const links: LinkPath[] = layout.links.map((_, i) => {
    const r = resolved.find((q) => q.index === i)!;
    const [s0, s1] = ranges.get(i)!;
    const count = s1 - s0 + 2;
    const out: LinkPath = { from: r.a, to: r.b, x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count), width: new Float64Array(count) };
    const put = (j: number, px: number, py: number, pz: number, pw: number) => {
      out.x[j] = px;
      out.y[j] = py;
      out.z[j] = pz;
      out.width[j] = pw;
    };
    put(0, full.x[r.a], full.y[r.a], full.z[r.a], full.width[r.a]);
    for (let s = s0; s < s1; s++) put(s - s0 + 1, track.x[s], track.y[s], track.z[s], track.width[s]);
    put(count - 1, full.x[r.b], full.y[r.b], full.z[r.b], full.width[r.b]);
    return out;
  });

  return { track, shared: sharedArr, links, errors: [], warnings: crossings(full, links, layout.links.length) };
}

/** Links that cross the full circuit on the level (away from where they leave and join it). */
function crossings(full: Track, links: readonly LinkPath[], count: number): LayoutBuild['warnings'] {
  const out: LayoutBuild['warnings'] = [];
  const n = full.n;
  links.forEach((l, i) => {
    const near = (k: number, end: number) => Math.min(mod(k - end, n), mod(end - k, n)) * full.ds < full.width[end] / 2 + 40;
    let crosses = false;
    for (let j = 0; j + 1 < l.x.length && !crosses; j++) {
      for (let k = 0; k < n && !crosses; k++) {
        if (near(k, l.from) || near(k, l.to)) continue;
        const k1 = (k + 1) % n;
        if (segmentIntersection(l.x[j], l.y[j], l.x[j + 1], l.y[j + 1], full.x[k], full.y[k], full.x[k1], full.y[k1]) >= 0) crosses = true;
      }
    }
    if (crosses) out.push({ link: i, message: `${count > 1 ? `Link ${i + 1}` : 'The link'} crosses the circuit on the level.` });
  });
  return out;
}

/** The layout's station on the full circuit's station `k`, or -1 when the layout skips it. */
export function layoutStation(build: LayoutBuild, k: number): number {
  for (let i = 0; i < build.shared.length; i++) if (build.shared[i] === k) return i;
  return -1;
}

/**
 * The full circuit's pit lane for a layout, its entry and exit as stations
 * of the layout; null when the layout skips any of the track beside it.
 */
export function layoutPitLane(build: LayoutBuild, pit: PitLane, n: number): PitLane | null {
  const entry = layoutStation(build, pit.entry);
  const exit = layoutStation(build, pit.exit);
  if (entry < 0 || exit < 0) return null;
  // Every station from entry to exit must be the full circuit's, in order.
  const steps = mod(pit.exit - pit.entry, n);
  const m = build.shared.length;
  for (let s = 0; s <= steps; s++) if (build.shared[(entry + s) % m] !== (pit.entry + s) % n) return null;
  return { ...pit, entry, exit };
}

/**
 * The track's surface near station `near` (within 200 m along it) closest to
 * a point: the distance from its centreline, its half width and its height
 * there (the surface is level across).
 */
function surfaceNear(t: Track, x: number, y: number, near: number): { d: number; half: number; z: number } {
  const reach = Math.min(Math.floor(t.n / 2), Math.ceil(200 / t.ds));
  let best = { d: Infinity, half: 0, z: 0 };
  for (let i = -reach; i < reach; i++) {
    const k = mod(near + i, t.n);
    const k1 = (k + 1) % t.n;
    const dx = t.x[k1] - t.x[k];
    const dy = t.y[k1] - t.y[k];
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((x - t.x[k]) * dx + (y - t.y[k]) * dy) / len2)) : 0;
    const d = dist(x, y, t.x[k] + dx * f, t.y[k] + dy * f);
    if (d < best.d) best = { d, half: (t.width[k] + (t.width[k1] - t.width[k]) * f) / 2, z: t.z[k] + (t.z[k1] - t.z[k]) * f };
  }
  return best;
}

function nearestStation(t: Track, p: Vec2): { k: number; d: number } {
  let k = 0;
  let d = Infinity;
  for (let i = 0; i < t.n; i++) {
    const di = dist(t.x[i], t.y[i], p.x, p.y);
    if (di < d) {
      d = di;
      k = i;
    }
  }
  return { k, d };
}
