/**
 * Scenery for the 3D view, in the scene coordinates of scene3d.ts (x east,
 * y up, z south):
 *
 * - kerbs, red and white, where the racing line runs out to the edge of the
 *   track in a corner (the apex on the inside, the exit on the outside);
 * - run-off areas outside the corners, as deep as the licence check's escape
 *   paths found room for: gravel, behind a band of asphalt at the fastest corners;
 * - the pit building behind the pit boxes, with garage doors, and the pit
 *   wall between the pit lane and the track;
 * - grandstands: one on the start straight, opposite the pits, and at the
 *   main overtaking spots, beyond the run-off;
 * - the lines of the grid boxes;
 * - the marshal posts, behind the run-off, raised on a platform where the
 *   plan needs it, and the flag marshal's rostrum at the line;
 * - trees, seeded from the terrain seed: forests and scattered trees where
 *   the ground is not too steep, wet or high, clear of the track, its banks,
 *   run-off and buildings.
 */
import { CORNER_LABELS, type Corner } from './analysis.ts';
import type { OvertakingZone } from './facilities.ts';
import { SpatialGrid } from './geometry.ts';
import { type Heightmap, sampleHeight } from './heightmap.ts';
import type { RunoffRay } from './licence.ts';
import { createNoise2D, fbm } from './noise.ts';
import type { PitLane } from './pitLane.ts';
import type { RacingLine } from './racingLine.ts';
import { seededRandom } from './rng.ts';
import { type Earthworks, type FaceCorner, type MeshData, MeshBuilder, type Road, SINK, VERGE } from './scene3d.ts';
import type { MarshalPost } from './marshals.ts';
import type { GridSlot } from './startFinish.ts';
import type { Track } from './track.ts';

type Vec3 = [number, number, number];
const UP: Vec3 = [0, 1, 0];

export const KERB_WIDTH = 1.1;
const RED = [0.8, 0.13, 0.13];
const WHITE = [0.93, 0.93, 0.9];
const GRAVEL = [0.83, 0.76, 0.58];
const RUNOFF_ASPHALT = [0.4, 0.42, 0.45];
/** Corners that need at least this much run-off (m) get a band of asphalt this deep before the gravel. */
const ASPHALT_RUNOFF = 80;
const ASPHALT_BAND = 25;

/** A point in the ground plane with a direction, and the model's heights. */
interface Frame {
  x: number;
  y: number;
  z: number;
  /** Unit tangent and left normal (y points south). */
  tx: number;
  ty: number;
  lx: number;
  ly: number;
}

/** Track stations in a grid, for "is another part of the track near here" questions. */
export class TrackIndex {
  readonly t: Track;
  private readonly grid = new SpatialGrid(25);

  constructor(t: Track) {
    this.t = t;
    for (let k = 0; k < t.n; k++) this.grid.insert(t.x[k], t.y[k], k);
  }

  /** The nearest station within `r` metres (skipping those `skip` rejects), or null. */
  nearest(x: number, y: number, r: number, skip?: (k: number) => boolean): { k: number; d: number } | null {
    let best: { k: number; d: number } | null = null;
    this.grid.query(x, y, r, (k) => {
      if (skip?.(k)) return;
      const d = Math.hypot(this.t.x[k] - x, this.t.y[k] - y);
      if (d <= r && (!best || d < best.d)) best = { k, d };
    });
    return best;
  }

  /** Sideways offset of a point from station k, positive to the left. */
  lateral(k: number, x: number, y: number): number {
    const h = this.t.heading[k];
    return (x - this.t.x[k]) * Math.sin(h) - (y - this.t.y[k]) * Math.cos(h);
  }

  /** Whether stations a and b are within `window` stations of each other around the lap. */
  near(a: number, b: number, window: number): boolean {
    const d = Math.abs(a - b);
    return Math.min(d, this.t.n - d) <= window;
  }
}

function frame(t: Track, k: number): Frame {
  const h = t.heading[k];
  const tx = Math.cos(h);
  const ty = Math.sin(h);
  return { x: t.x[k], y: t.y[k], z: t.z[k], tx, ty, lx: ty, ly: -tx };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Stations from `from` to `to` going forward around the lap (inclusive). */
function span(from: number, to: number, n: number): number[] {
  const out: number[] = [];
  const len = mod(to - from, n);
  for (let i = 0; i <= len; i++) out.push((from + i) % n);
  return out;
}

// ---- kerbs -------------------------------------------------------------------

export interface KerbRun {
  /** First and last station (going forward, wrapping). */
  from: number;
  to: number;
  /** 1 on the left of the track, -1 on the right. */
  side: 1 | -1;
}

/**
 * Where kerbs go, corner by corner, from where the racing line touches the
 * edges: on the inside where it clips the apex, on the outside where it runs
 * out to the edge after the apex (40 m), and on the outside where it turns
 * in (the last 30 m along that edge). Runs on the same side that overlap
 * (in a chicane) become one.
 */
export function kerbRuns(t: Track, line: RacingLine, corners: readonly Corner[]): KerbRun[] {
  const n = t.n;
  const m = (metres: number) => Math.max(1, Math.round(metres / t.ds));
  const atEdge = (k: number, side: 1 | -1) => side * line.offset[k] > t.width[k] / 2 - 2;
  const runs: { from: number; len: number; side: 1 | -1 }[] = [];
  for (const c of corners) {
    const inside: 1 | -1 = c.direction === 'right' ? -1 : 1;
    const outside = (-inside) as 1 | -1;
    // Apex: the stretch through the corner where the line is on the inside edge.
    const first = mod(c.start - m(10), n);
    const len = mod(c.end + m(10) - first, n);
    let a = -1;
    let b = -1;
    for (let i = 0; i <= len; i++) {
      if (!atEdge((first + i) % n, inside)) continue;
      if (a < 0) a = i;
      b = i;
    }
    if (a >= 0) runs.push({ from: mod(first + a - m(4), n), len: b - a + m(8), side: inside });
    // Exit: where the line first reaches the outside edge after the apex.
    for (let i = 0; i <= mod(c.end - c.apex, n) + m(120); i++) {
      const k = (c.apex + i) % n;
      if (atEdge(k, outside)) {
        runs.push({ from: mod(k - m(4), n), len: m(44), side: outside });
        break;
      }
    }
    // Entry: the last stretch on the outside edge before the turn-in.
    for (let i = 0; i <= m(100); i++) {
      const k = mod(c.start - i, n);
      if (atEdge(k, outside)) {
        runs.push({ from: mod(k - m(30), n), len: m(34), side: outside });
        break;
      }
    }
  }
  // Merge overlapping runs on the same side.
  const merged: KerbRun[] = [];
  for (const side of [1, -1] as const) {
    const mine = runs.filter((r) => r.side === side).sort((p, q) => p.from - q.from);
    let cur: { from: number; len: number } | null = null;
    for (const r of mine) {
      if (cur && mod(r.from - cur.from, n) <= cur.len + 1) cur.len = Math.max(cur.len, mod(r.from - cur.from, n) + r.len);
      else {
        if (cur) merged.push({ from: cur.from, to: mod(cur.from + cur.len, n), side });
        cur = { from: r.from, len: r.len };
      }
    }
    if (cur) merged.push({ from: cur.from, to: mod(cur.from + cur.len, n), side });
  }
  return merged;
}

/** Red and white kerbs, 2 m blocks, just outside the track edge and a little raised. */
export function buildKerbs(t: Track, runs: readonly KerbRun[]): MeshData {
  const mb = new MeshBuilder();
  for (const run of runs) {
    const stations = span(run.from, run.to, t.n);
    for (let i = 0; i + 1 < stations.length; i++) {
      const a = frame(t, stations[i]);
      const b = frame(t, stations[i + 1]);
      const half = (k: number) => t.width[k] / 2;
      const inner = (f: Frame, k: number): FaceCorner => [f.x + f.lx * run.side * half(k), f.z + 0.05, f.y + f.ly * run.side * half(k), f.z];
      const outer = (f: Frame, k: number): FaceCorner => [f.x + f.lx * run.side * (half(k) + KERB_WIDTH), f.z + 0.05, f.y + f.ly * run.side * (half(k) + KERB_WIDTH), f.z];
      const color = stations[i] % 2 === 0 ? RED : WHITE;
      const ia = inner(a, stations[i]);
      const oa = outer(a, stations[i]);
      const ob = outer(b, stations[i + 1]);
      const ib = inner(b, stations[i + 1]);
      mb.face([ia, oa, ob, ib], UP, color);
      // The kerb's outer face, down into the verge.
      mb.face([oa, ob, [ob[0], ob[1] - 0.25, ob[2], ob[3]], [oa[0], oa[1] - 0.25, oa[2], oa[3]]], [a.lx * run.side, 0, a.ly * run.side], color);
    }
  }
  return mb.build();
}

// ---- run-off -----------------------------------------------------------------

export interface RunoffArea {
  corner: number;
  side: 1 | -1;
  /** Stations, forward around the lap, with the depth of the area beyond the verge at each. */
  stations: number[];
  depth: number[];
  asphalt: boolean;
}

/**
 * Run-off outside each corner, from 30 m before the turn-in to 30 m after
 * the exit, as deep as the corner's escape paths are free (up to what they
 * need), tapering at the ends, and stopping short of water, the map edge,
 * other parts of the track and anywhere `blocked` says (another road: the
 * rest of the circuit round a layout).
 */
export function runoffAreas(
  t: Track, corners: readonly Corner[], rays: readonly RunoffRay[], earth: Earthworks, index: TrackIndex, blocked?: (x: number, y: number) => boolean,
): RunoffArea[] {
  const n = t.n;
  const out: RunoffArea[] = [];
  const hm = earth.ground;
  const ramp = Math.round(30 / t.ds);
  const local = Math.round(300 / t.ds);
  for (const c of corners) {
    const mine = rays.filter((r) => r.corner === c.number);
    if (!mine.length) continue;
    let depth = 0;
    let required = 0;
    for (const r of mine) {
      depth = Math.max(depth, Math.min(r.required, r.free));
      required = Math.max(required, r.required);
    }
    // The escape paths run straight on; across the curve the area need not be as deep.
    depth *= 0.75;
    if (depth < 5) continue;
    const side: 1 | -1 = c.direction === 'right' ? 1 : -1;
    const stations = span(mod(c.start - ramp, n), mod(c.end + ramp, n), n);
    const inCorner = mod(c.end - c.start, n);
    const depths = stations.map((k, i) => {
      // Full depth through the corner, tapering over 30 m either side.
      const w = i < ramp ? i / ramp : i > ramp + inCorner ? Math.max(0, 1 - (i - ramp - inCorner) / ramp) : 1;
      const want = depth * (0.15 + 0.85 * w * w * (3 - 2 * w));
      const f = frame(t, k);
      const e = t.width[k] / 2 + VERGE;
      let d = 0;
      for (; d < want; d += 2) {
        const x = f.x + f.lx * side * (e + d);
        const y = f.y + f.ly * side * (e + d);
        if (x < 5 || y < 5 || x > hm.extent - 5 || y > hm.extent - 5) break;
        if (earth.natural(x, y) < hm.waterLevel) break;
        const other = index.nearest(x, y, 40, (j) => index.near(j, k, local));
        if (other && other.d < t.width[other.k] / 2 + VERGE + 3) break;
        if (blocked?.(x, y)) break;
      }
      return Math.max(0, Math.min(d, want));
    });
    out.push({ corner: c.number, side, stations, depth: depths, asphalt: required >= ASPHALT_RUNOFF });
  }
  return out;
}

/** The run-off surfaces, laid over the shaped ground with a point about every 3 m across, a little above it. */
export function buildRunoff(t: Track, areas: readonly RunoffArea[], earth: Earthworks): MeshData {
  const mb = new MeshBuilder();
  for (const a of areas) {
    const J = Math.max(2, Math.ceil(Math.max(...a.depth) / 3));
    // Fast corners: asphalt for the first 25 m, gravel beyond.
    const colorAt = (d: number) => (a.asphalt && d <= ASPHALT_BAND ? RUNOFF_ASPHALT : GRAVEL);
    const rowStart: number[] = [];
    a.stations.forEach((k, i) => {
      const f = frame(t, k);
      const e = t.width[k] / 2 + VERGE;
      rowStart.push(mb.vertexCount);
      // Left to right across the track: outer to inner on the left, inner to outer on the right.
      for (let jj = 0; jj <= J; jj++) {
        const j = a.side === 1 ? J - jj : jj;
        const d = (a.depth[i] * j) / J;
        const off = a.side * (e + d);
        const x = f.x + f.lx * off;
        const y = f.y + f.ly * off;
        const [nx, ny, nz] = groundNormal(earth, x, y);
        // The ground eases up from under the road over the first 2 m beyond the verge: start level with
        // the verge's edge and rise to just above the ground there.
        const ease = Math.max(0, 1 - d / 2);
        const floor = earth.height(x, y) + SINK * ease;
        mb.vertex(x, floor + 0.2 * (1 - ease), y, nx, ny, nz, colorAt(d), floor);
      }
    });
    for (let i = 0; i + 1 < a.stations.length; i++) {
      for (let j = 0; j < J; j++) {
        const p = rowStart[i] + j;
        const q = rowStart[i + 1] + j;
        mb.quad(p, p + 1, q, q + 1);
      }
    }
  }
  return mb.build();
}

function groundNormal(earth: Earthworks, x: number, y: number): Vec3 {
  const d = 2;
  const gx = (earth.height(x + d, y) - earth.height(x - d, y)) / (2 * d);
  const gy = (earth.height(x, y + d) - earth.height(x, y - d)) / (2 * d);
  const len = Math.sqrt(gx * gx + 1 + gy * gy);
  return [-gx / len, 1 / len, -gy / len];
}

// ---- footprints ------------------------------------------------------------------

/** A building's outline in the ground plane, for keeping trees and other buildings off it. */
export interface Footprint {
  x: number[];
  y: number[];
}

export function inside(f: Footprint, x: number, y: number, margin = 0): boolean {
  let hit = false;
  const n = f.x.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if ((f.y[i] > y) !== (f.y[j] > y) && x < ((f.x[j] - f.x[i]) * (y - f.y[i])) / (f.y[j] - f.y[i]) + f.x[i]) hit = !hit;
  }
  if (hit || margin <= 0) return hit;
  for (let i = 0, j = n - 1; i < n; j = i++) if (segmentDistance(x, y, f.x[j], f.y[j], f.x[i], f.y[i]) < margin) return true;
  return false;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const f = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * f), py - (ay + dy * f));
}

// ---- pit building ------------------------------------------------------------------

/** Points along a polyline at given distances, with the direction there. */
function along(xs: Float64Array, ys: Float64Array, zs: Float64Array, at: readonly number[]): Frame[] {
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  let i = 0;
  return at.map((s) => {
    while (i < xs.length - 2 && cum[i + 1] < s) i++;
    const span = cum[i + 1] - cum[i] || 1;
    const f = Math.max(0, Math.min(1, (s - cum[i]) / span));
    const dx = xs[i + 1] - xs[i];
    const dy = ys[i + 1] - ys[i];
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    return { x: xs[i] + dx * f, y: ys[i] + dy * f, z: zs[i] + (zs[i + 1] - zs[i]) * f, tx, ty, lx: ty, ly: -tx };
  });
}

/** Distance along a polyline to points `from` and `to`. */
function pathLength(xs: Float64Array, ys: Float64Array, from: number, to: number): [number, number] {
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  const at = (i: number) => cum[Math.max(0, Math.min(cum.length - 1, i))];
  return [at(from), at(to)];
}

const PIT_DEPTH = 16;
const PIT_HEIGHT = 8;
const DOOR = 7;
const PILLAR = 1.5;

/**
 * The pit building along the pit boxes, on the far side of the lane from
 * the track: garage doors facing the lane under a lighter upper floor, a flat
 * roof over the front, and the pit wall between the lane and the track.
 */
export function buildPitBuilding(pit: PitLane, road: Road): { mesh: MeshData; footprint: Footprint } {
  const mb = new MeshBuilder();
  const halfLane = pit.width / 2;
  const [s0, s1] = pathLength(pit.x, pit.y, pit.boxStart, pit.boxEnd);
  // Doors and pillars in turn along the boxes.
  const cuts: number[] = [];
  const doors: boolean[] = [];
  for (let s = s0, door = true; s < s1; door = !door) {
    cuts.push(s);
    doors.push(door);
    s = Math.min(s1, s + (door ? DOOR : PILLAR));
    if (s >= s1) cuts.push(s1);
  }
  const frames = along(pit.x, pit.y, road.z, cuts);
  const out = (f: Frame, d: number): [number, number] => [f.x + f.lx * pit.side * d, f.y + f.ly * pit.side * d];
  const light = [0.85, 0.87, 0.89];
  const door = [0.2, 0.22, 0.25];
  const back = [0.74, 0.76, 0.79];
  const roof = [0.52, 0.55, 0.6];
  const front = halfLane + 1.5;
  const rear = front + PIT_DEPTH;
  // A point `d` metres out from the lane's centre and `h` metres above the floor there.
  const at = (f: Frame, d: number, h: number): FaceCorner => {
    const [x, y] = out(f, d);
    return [x, f.z + h, y, f.z];
  };
  const doorTop = 4.5;
  const top = PIT_HEIGHT + 0.6;
  const eave = front - 1.5;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    // The walls reach 3 m into the ground below the lower end.
    const base = Math.min(a.z, b.z) - 3;
    const foot = (f: Frame, d: number) => at(f, d, base - f.z);
    const o: Vec3 = [a.lx * pit.side, 0, a.ly * pit.side];
    const facing: Vec3 = [-o[0], 0, -o[2]];
    mb.face([foot(a, front), foot(b, front), at(b, front, doorTop), at(a, front, doorTop)], facing, doors[i] ? door : light);
    mb.face([at(a, front, doorTop), at(b, front, doorTop), at(b, front, PIT_HEIGHT), at(a, front, PIT_HEIGHT)], facing, light);
    mb.face([foot(a, rear), foot(b, rear), at(b, rear, PIT_HEIGHT), at(a, rear, PIT_HEIGHT)], o, back);
    // Roof, reaching out over the lane edge.
    mb.face([at(a, eave, top), at(b, eave, top), at(b, rear, top), at(a, rear, top)], UP, roof);
    mb.face([at(a, eave, PIT_HEIGHT), at(b, eave, PIT_HEIGHT), at(b, eave, top), at(a, eave, top)], facing, light);
    mb.face([at(a, eave, PIT_HEIGHT), at(b, eave, PIT_HEIGHT), at(b, front, PIT_HEIGHT), at(a, front, PIT_HEIGHT)], [0, -1, 0], back);
  }
  // End walls.
  for (const [f, dir] of [[frames[0], -1], [frames[frames.length - 1], 1]] as const) {
    mb.face([at(f, front, -3), at(f, rear, -3), at(f, rear, top), at(f, front, top)], [f.tx * dir, 0, f.ty * dir], back);
  }
  // The pit wall: concrete, a little over a metre high, between the lane and the track.
  const wallCuts: number[] = [];
  const w0 = Math.max(0, s0 - 10);
  const w1 = s1 + 10;
  for (let s = w0; s < w1; s += 6) wallCuts.push(s);
  wallCuts.push(w1);
  const wall = along(pit.x, pit.y, road.z, wallCuts);
  const concrete = [0.78, 0.79, 0.8];
  // The apron in front of the garages: paved from the lane's edge to the doors.
  const apron = [0.33, 0.34, 0.36];
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    mb.face([at(a, halfLane - 0.05, 0.012), at(b, halfLane - 0.05, 0.012), at(b, front, 0.012), at(a, front, 0.012)], UP, apron);
  }
  const inner = -(halfLane + 0.7);
  const outer = inner - 0.4;
  for (let i = 0; i + 1 < wall.length; i++) {
    const a = wall[i];
    const b = wall[i + 1];
    const o: Vec3 = [a.lx * pit.side, 0, a.ly * pit.side];
    mb.face([at(a, inner, 1.1), at(b, inner, 1.1), at(b, outer, 1.1), at(a, outer, 1.1)], UP, concrete);
    mb.face([at(a, inner, -0.5), at(b, inner, -0.5), at(b, inner, 1.1), at(a, inner, 1.1)], o, concrete);
    mb.face([at(a, outer, -0.5), at(b, outer, -0.5), at(b, outer, 1.1), at(a, outer, 1.1)], [-o[0], 0, -o[2]], concrete);
  }
  const first = frames[0];
  const last = frames[frames.length - 1];
  const corners = [out(first, front - 2), out(last, front - 2), out(last, rear + 2), out(first, rear + 2)];
  return { mesh: mb.build(), footprint: { x: corners.map((c) => c[0]), y: corners.map((c) => c[1]) } };
}

// ---- grandstands -----------------------------------------------------------------

export interface Stand {
  /** The front edge, facing the track, with the outward direction (away from the track) at each point. */
  front: { x: number; y: number; ox: number; oy: number }[];
  /** Height of the lowest row's floor, and of the ground below the stand's lowest point. */
  base: number;
  foot: number;
  footprint: Footprint;
}

const STAND_DEPTH = 15;
const STAND_ROWS = 7;
const STAND_RISE = 1.1;

/**
 * A grandstand along stations `from`..`to` on one side, `offset` metres from
 * the centreline, if the ground there is free (on the map, dry, not steep,
 * clear of every road and of the given footprints).
 */
function tryStand(t: Track, from: number, to: number, side: 1 | -1, offset: number, earth: Earthworks, avoid: readonly Footprint[]): Stand | null {
  const hm = earth.ground;
  const step = Math.max(1, Math.round(6 / t.ds));
  const stations = span(from, to, t.n).filter((_, i, all) => i % step === 0 || i === all.length - 1);
  const front: Stand['front'] = [];
  let hi = -Infinity;
  let lo = Infinity;
  for (const k of stations) {
    const f = frame(t, k);
    const ox = f.lx * side;
    const oy = f.ly * side;
    for (const d of [offset, offset + STAND_DEPTH / 2, offset + STAND_DEPTH]) {
      const x = f.x + ox * d;
      const y = f.y + oy * d;
      if (x < 15 || y < 15 || x > hm.extent - 15 || y > hm.extent - 15) return null;
      if (earth.natural(x, y) < hm.waterLevel + 0.5) return null;
      if (earth.clearance(x, y) < Math.min(6, offset - t.width[k] / 2 - 1)) return null;
      if (avoid.some((a) => inside(a, x, y, 6))) return null;
      const g = earth.height(x, y);
      hi = Math.max(hi, g);
      lo = Math.min(lo, g);
    }
    front.push({ x: f.x + ox * offset, y: f.y + oy * offset, ox, oy });
  }
  if (front.length < 2 || hi - lo > 12) return null;
  const a = front[0];
  const b = front[front.length - 1];
  const footprint: Footprint = {
    x: [a.x, b.x, b.x + b.ox * STAND_DEPTH, a.x + a.ox * STAND_DEPTH],
    y: [a.y, b.y, b.y + b.oy * STAND_DEPTH, a.y + a.oy * STAND_DEPTH],
  };
  return { front, base: hi + 0.2, foot: lo - 1, footprint };
}

/**
 * Grandstands: the main one on the start straight, opposite the pits, and
 * up to three at the corners after the best overtaking spots, beyond their
 * run-off. Stands that do not fit are left out.
 */
export function placeGrandstands(
  t: Track, corners: readonly Corner[], overtaking: readonly OvertakingZone[], pit: PitLane | null,
  runoff: readonly RunoffArea[], earth: Earthworks, avoid: readonly Footprint[],
): Stand[] {
  const n = t.n;
  const stands: Stand[] = [];
  const taken = [...avoid];
  const add = (s: Stand | null) => {
    if (!s) return false;
    stands.push(s);
    taken.push(s.footprint);
    return true;
  };
  const edge = (k: number) => t.width[k] / 2 + VERGE;

  // Main grandstand, across the start straight from the pits when they are there.
  const from = mod(-Math.round(30 / t.ds), n);
  const to = Math.round(130 / t.ds) % n;
  const pitNearStart = pit && (pit.kind === 'parallel') && (mod(-pit.entry, n) * t.ds < 400 || mod(pit.exit, n) * t.ds < 400);
  const sides: (1 | -1)[] = pitNearStart ? [(-pit!.side) as 1 | -1] : [1, -1];
  for (const side of sides) if (add(tryStand(t, from, to, side, edge(0) + 9, earth, taken))) break;

  // At the corners after the biggest braking zones.
  const zones = [...overtaking].sort((a, b) => b.speedDrop - a.speedDrop).slice(0, 3);
  for (const z of zones) {
    const c = [...corners].sort((a, b) => mod(a.start - z.station, n) - mod(b.start - z.station, n))[0];
    if (!c) continue;
    const side: 1 | -1 = c.direction === 'right' ? 1 : -1;
    const area = runoff.find((r) => r.corner === c.number);
    const depth = area ? Math.max(...area.depth) : 0;
    const f0 = mod(c.start - Math.round(50 / t.ds), n);
    const f1 = mod(c.start + Math.round(40 / t.ds), n);
    for (const extra of [10, 25]) if (add(tryStand(t, f0, f1, side, edge(c.start) + depth + extra, earth, taken))) break;
  }
  return stands;
}

/** Stepped seating rising away from the track, a back wall and a roof over the upper rows. */
export function buildGrandstands(stands: readonly Stand[]): MeshData {
  const mb = new MeshBuilder();
  const seats = [[0.18, 0.36, 0.66], [0.24, 0.45, 0.77]];
  const riser = [0.62, 0.65, 0.69];
  const wall = [0.8, 0.82, 0.85];
  const roofTop = [0.9, 0.91, 0.92];
  const roofUnder = [0.52, 0.54, 0.58];
  const plinth = [0.6, 0.6, 0.58];
  const rowDepth = STAND_DEPTH / STAND_ROWS;
  for (const s of stands) {
    const top = s.base + 1 + STAND_ROWS * STAND_RISE;
    const roof = top + 3.5;
    const at = (p: Stand['front'][number], d: number, z: number): FaceCorner => [p.x + p.ox * d, z, p.y + p.oy * d, s.base];
    for (let i = 0; i + 1 < s.front.length; i++) {
      const a = s.front[i];
      const b = s.front[i + 1];
      const toward: Vec3 = [-a.ox, 0, -a.oy];
      const away: Vec3 = [a.ox, 0, a.oy];
      mb.face([at(a, 0, s.foot), at(b, 0, s.foot), at(b, 0, s.base), at(a, 0, s.base)], toward, plinth);
      for (let r = 0; r < STAND_ROWS; r++) {
        const z0 = r === 0 ? s.base : s.base + 1 + (r - 1) * STAND_RISE;
        const z1 = s.base + 1 + r * STAND_RISE;
        mb.face([at(a, r * rowDepth, z0), at(b, r * rowDepth, z0), at(b, r * rowDepth, z1), at(a, r * rowDepth, z1)], toward, riser);
        mb.face([at(a, r * rowDepth, z1), at(b, r * rowDepth, z1), at(b, (r + 1) * rowDepth, z1), at(a, (r + 1) * rowDepth, z1)], UP, seats[r % 2]);
      }
      mb.face([at(a, STAND_DEPTH, s.foot), at(b, STAND_DEPTH, s.foot), at(b, STAND_DEPTH, roof), at(a, STAND_DEPTH, roof)], away, wall);
      const r0 = STAND_DEPTH * 0.3;
      mb.face([at(a, r0, roof), at(b, r0, roof), at(b, STAND_DEPTH + 0.5, roof), at(a, STAND_DEPTH + 0.5, roof)], UP, roofTop);
      mb.face([at(a, r0, roof - 0.4), at(b, r0, roof - 0.4), at(b, STAND_DEPTH, roof - 0.4), at(a, STAND_DEPTH, roof - 0.4)], [0, -1, 0], roofUnder);
      mb.face([at(a, r0, roof - 0.4), at(b, r0, roof - 0.4), at(b, r0, roof), at(a, r0, roof)], toward, roofTop);
    }
    // End walls: the slope of the seating, from the front row up to the roof at the back.
    for (const [p, q, sign] of [[s.front[0], s.front[1], -1], [s.front[s.front.length - 1], s.front[s.front.length - 2], -1]] as const) {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const normal: Vec3 = [(dx / len) * sign, 0, (dy / len) * sign];
      mb.face([at(p, 0, s.foot), at(p, STAND_DEPTH, s.foot), at(p, STAND_DEPTH, roof), at(p, 0, s.base + 1)], normal, wall);
    }
  }
  return mb.build();
}

// ---- grid ----------------------------------------------------------------------

/** A short white line across each grid slot's half of the track, at the front of the box. */
export function buildGridMarks(t: Track, slots: readonly GridSlot[], index: TrackIndex): MeshData {
  const mb = new MeshBuilder();
  for (const s of slots) {
    const near = index.nearest(s.x, s.y, 30);
    if (!near) continue;
    const road = t.z[near.k];
    const z = road + 0.02;
    const hx = Math.cos(s.heading);
    const hy = Math.sin(s.heading);
    const lx = hy;
    const ly = -hx;
    const cx = s.x + hx * 2.5;
    const cy = s.y + hy * 2.5;
    const w = 1.8;
    const l = 0.15;
    mb.face([
      [cx + lx * w - hx * l, z, cy + ly * w - hy * l, road],
      [cx - lx * w - hx * l, z, cy - ly * w - hy * l, road],
      [cx - lx * w + hx * l, z, cy - ly * w + hy * l, road],
      [cx + lx * w + hx * l, z, cy + ly * w + hy * l, road],
    ], UP, WHITE);
  }
  return mb.build();
}

// ---- marshal posts --------------------------------------------------------------

/** Where a marshal post stands in the scenery, and which way it faces. */
export interface PostSite {
  station: number;
  x: number;
  y: number;
  /** The ground there, and the floor the marshals stand on (raised posts on a platform). */
  ground: number;
  floor: number;
  /** Unit vectors in the ground plane: towards the track, and along it in the direction of travel. */
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  raised: boolean;
  /** The flag marshal's rostrum at the line: a platform, without the hut and light panel of a post. */
  rostrum?: boolean;
  footprint: Footprint;
}

/** A post's pad: half its length along the track, and its depth. */
export const PAD_HALF = 2.2;
export const PAD_DEPTH = 3;
const PLATFORM = 3;
const ROSTRUM = 2;

/**
 * Sites for the marshal posts: where the plan puts them, moved straight
 * back from the track until clear of roads, run-off and buildings (posts
 * stand behind the run-off, as at real circuits). `blocked` says whether a
 * point is taken.
 */
export function marshalPostSites(t: Track, posts: readonly MarshalPost[], earth: Earthworks, blocked: (x: number, y: number) => boolean): PostSite[] {
  return posts.map((p) => {
    const f = frame(t, p.station);
    const ox = f.lx * p.side;
    const oy = f.ly * p.side;
    const start = (p.x - f.x) * ox + (p.y - f.y) * oy;
    return postSite(t, p.station, ox, oy, start, start + 120, p.raised ? PLATFORM : 0, earth, blocked)
      ?? postSite(t, p.station, ox, oy, start, start, p.raised ? PLATFORM : 0, earth, () => false)!;
  });
}

/**
 * The flag marshal's rostrum at the line, on the pit side when there is
 * room right beside the track, else on the other side.
 */
export function lineFlagSite(t: Track, pitSide: 1 | -1, earth: Earthworks, blocked: (x: number, y: number) => boolean): PostSite {
  const f = frame(t, 0);
  const edge = t.width[0] / 2 + VERGE + 1.5;
  for (const side of [pitSide, -pitSide]) {
    const site = postSite(t, 0, f.lx * side, f.ly * side, edge, edge + 6, ROSTRUM, earth, blocked);
    if (site) return { ...site, rostrum: true };
  }
  return { ...postSite(t, 0, f.lx * pitSide, f.ly * pitSide, edge, edge, ROSTRUM, earth, () => false)!, rostrum: true };
}

function postSite(
  t: Track, k: number, ox: number, oy: number, from: number, to: number, raise: number, earth: Earthworks, blocked: (x: number, y: number) => boolean,
): PostSite | null {
  const f = frame(t, k);
  for (let d = from; d <= to; d += 2) {
    const x = f.x + ox * d;
    const y = f.y + oy * d;
    // The whole pad must be clear: its corners and middle.
    const corners: [number, number][] = [-1, 1].flatMap((a) => [0, PAD_DEPTH].map((b) => [x + f.tx * a * PAD_HALF + ox * b, y + f.ty * a * PAD_HALF + oy * b] as [number, number]));
    if (from !== to && [[x, y], ...corners].some(([px, py]) => earth.clearance(px, py) < 1 || blocked(px, py))) continue;
    const ground = Math.max(...[[x, y], ...corners].map(([px, py]) => earth.height(px, py)));
    return {
      station: k, x, y, ground, floor: ground + 0.15 + raise, fx: -ox, fy: -oy, tx: f.tx, ty: f.ty, raised: raise > 0,
      footprint: { x: corners.map((c) => c[0]), y: corners.map((c) => c[1]) },
    };
  }
  return null;
}

/**
 * The marshal posts: a concrete pad with a small orange-roofed hut at the
 * back, the light panel on a pole facing the cars as they come, and for a
 * raised post (or the rostrum at the line) a platform on legs with a rail.
 * The marshals, their flags and the panel's light are drawn by the view.
 */
export function buildMarshalPosts(sites: readonly PostSite[]): MeshData {
  const mb = new MeshBuilder();
  const concrete = [0.64, 0.64, 0.62];
  const hut = [0.92, 0.92, 0.9];
  const roof = [0.93, 0.42, 0.08];
  const steel = [0.45, 0.47, 0.5];
  const panel = [0.06, 0.06, 0.07];
  for (const s of sites) {
    // Local coordinates: `a` along the track, `b` away from it (0 at the pad's front edge), heights above the floor.
    const box = (a0: number, a1: number, b0: number, b1: number, z0: number, z1: number, color: readonly number[], floor = s.floor) => {
      const at = (a: number, b: number, z: number): FaceCorner => [s.x + s.tx * a - s.fx * b, floor + z, s.y + s.ty * a - s.fy * b, s.ground];
      const along: Vec3 = [s.tx, 0, s.ty];
      const toward: Vec3 = [s.fx, 0, s.fy];
      mb.face([at(a0, b0, z1), at(a1, b0, z1), at(a1, b1, z1), at(a0, b1, z1)], UP, color);
      mb.face([at(a0, b0, z0), at(a1, b0, z0), at(a1, b0, z1), at(a0, b0, z1)], toward, color);
      mb.face([at(a0, b1, z0), at(a1, b1, z0), at(a1, b1, z1), at(a0, b1, z1)], [-toward[0], 0, -toward[2]], color);
      mb.face([at(a0, b0, z0), at(a0, b1, z0), at(a0, b1, z1), at(a0, b0, z1)], [-along[0], 0, -along[2]], color);
      mb.face([at(a1, b0, z0), at(a1, b1, z0), at(a1, b1, z1), at(a1, b0, z1)], along, color);
    };
    if (s.raised) {
      // Legs from below the ground up to the deck, the deck and a rail round its front and ends.
      const below = s.ground - s.floor - 0.5;
      for (const a of [-PAD_HALF + 0.1, PAD_HALF - 0.3]) for (const b of [0.1, PAD_DEPTH - 0.3]) box(a, a + 0.2, b, b + 0.2, below, -0.15, steel);
      box(-PAD_HALF, PAD_HALF, 0, PAD_DEPTH, -0.15, 0, steel);
      box(-PAD_HALF, PAD_HALF, 0, 0.06, 0.95, 1.05, steel);
      box(-PAD_HALF, -PAD_HALF + 0.06, 0, PAD_DEPTH, 0.95, 1.05, steel);
      box(PAD_HALF - 0.06, PAD_HALF, 0, PAD_DEPTH, 0.95, 1.05, steel);
      for (const a of [-PAD_HALF, PAD_HALF - 0.06]) box(a, a + 0.06, 0, 0.06, 0, 0.95, steel);
    } else {
      box(-PAD_HALF, PAD_HALF, 0, PAD_DEPTH, s.ground - s.floor - 0.3, 0, concrete);
    }
    if (s.rostrum) continue;
    // The hut at the back of the pad.
    box(-1, 1, PAD_DEPTH - 1.4, PAD_DEPTH, 0, 2.1, hut);
    box(-1.15, 1.15, PAD_DEPTH - 1.6, PAD_DEPTH + 0.1, 2.1, 2.25, roof);
    // The light panel on its pole at the upstream end of the pad, its face towards the oncoming cars.
    box(-PAD_HALF - 0.05, -PAD_HALF + 0.05, 0.3, 0.4, 0, 2.2, steel);
    box(-PAD_HALF - 0.12, -PAD_HALF + 0.02, 0.05, 0.65, 2.2, 2.8, panel);
  }
  return mb.build();
}

// ---- trees ---------------------------------------------------------------------

export interface Trees {
  /** Per tree: x, ground height, z (south), height in metres, kind (0 conifer, 1 broadleaf). */
  data: Float32Array;
  count: number;
}

/** Most trees drawn; more are thinned out evenly. */
export const MAX_TREES = 40_000;

/**
 * Where trees could grow on a terrain, from its seed: forests where a slow
 * noise says so and single trees elsewhere, thinning out on steep ground and
 * towards the high ground, none in water. Conifers take over higher up. The
 * same for a terrain whatever the track; placeTrees then clears the track.
 * Per tree: x, natural ground height, z (south), height in metres, kind.
 */
export function forest(hm: Heightmap, seed: string): Float32Array {
  const natural = (x: number, y: number) => sampleHeight(hm, x, y);
  const rng = seededRandom(`${seed}:trees`);
  const forest = createNoise2D(seededRandom(`${seed}:forest`));
  const patch = createNoise2D(seededRandom(`${seed}:patch`));
  const spacing = Math.max(10, hm.extent / 600);
  const cells = Math.floor(hm.extent / spacing);
  const hasWater = Number.isFinite(hm.waterLevel);
  const landMin = hasWater ? Math.max(hm.min, hm.waterLevel) : hm.min;
  const range = Math.max(hm.max - landMin, 120);
  const found: number[] = [];
  const smooth = (a: number, b: number, v: number) => {
    const f = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return f * f * (3 - 2 * f);
  };
  for (let j = 1; j < cells - 1; j++) {
    for (let i = 1; i < cells - 1; i++) {
      const x = (i + rng()) * spacing;
      const y = (j + rng()) * spacing;
      const r = rng();
      const woods = smooth(-0.05, 0.4, fbm(forest, x / 650, y / 650, 3, 0.5));
      const patchy = 0.55 + 0.45 * (0.5 + 0.5 * fbm(patch, x / 150, y / 150, 2, 0.5));
      let chance = woods * patchy + 0.02;
      if (r >= chance) continue;
      const g = natural(x, y);
      if (g < hm.waterLevel + 0.8) continue;
      const height = (g - landMin) / range;
      chance *= 1 - smooth(0.7, 0.9, height);
      const sx = (natural(x + 4, y) - natural(x - 4, y)) / 8;
      const sy = (natural(x, y + 4) - natural(x, y - 4)) / 8;
      chance *= 1 - smooth(0.3, 0.55, Math.hypot(sx, sy));
      if (r >= chance) continue;
      const conifer = height > 0.45 || fbm(patch, x / 400 + 17, y / 400 - 5, 2, 0.5) > 0.25;
      found.push(x, g, y, (conifer ? 11 : 9) * (0.75 + 0.6 * rng()), conifer ? 0 : 1);
    }
  }
  return Float32Array.from(found);
}

/**
 * The trees of a forest that are clear of the roads and their banks (20 m
 * from the edge) and of whatever `avoid` says, standing on the shaped
 * ground; thinned out evenly beyond MAX_TREES.
 */
export function placeTrees(earth: Earthworks, candidates: Float32Array, avoid: (x: number, y: number) => boolean): Trees {
  const kept: number[] = [];
  for (let i = 0; i < candidates.length; i += 5) {
    const x = candidates[i];
    const y = candidates[i + 2];
    if (earth.clearance(x, y) < 20 || avoid(x, y)) continue;
    kept.push(i);
  }
  const count = Math.min(MAX_TREES, kept.length);
  const data = new Float32Array(count * 5);
  for (let j = 0; j < count; j++) {
    // An even share everywhere when there are too many.
    const i = kept[Math.floor((j * kept.length) / count)];
    const x = candidates[i];
    const y = candidates[i + 2];
    data[j * 5] = x;
    data[j * 5 + 1] = earth.height(x, y) - 0.3;
    data[j * 5 + 2] = y;
    data[j * 5 + 3] = candidates[i + 3];
    data[j * 5 + 4] = candidates[i + 4];
  }
  return { data, count };
}

/**
 * Whether a point lies on run-off, near the outside of a corner: tests the
 * nearest station within 150 m against the depth of the run-off beside it.
 */
export function runoffTest(t: Track, areas: readonly RunoffArea[], index: TrackIndex): (x: number, y: number, margin: number) => boolean {
  const left = new Float32Array(t.n);
  const right = new Float32Array(t.n);
  for (const a of areas) {
    a.stations.forEach((k, i) => {
      const arr = a.side === 1 ? left : right;
      arr[k] = Math.max(arr[k], a.depth[i]);
    });
  }
  // Cells of 50 m within 160 m of the track: a quick no for everything further away.
  const CELL = 50;
  let maxX = 0;
  let maxY = 0;
  for (let k = 0; k < t.n; k++) {
    maxX = Math.max(maxX, t.x[k]);
    maxY = Math.max(maxY, t.y[k]);
  }
  const cols = Math.ceil((maxX + 200) / CELL);
  const rows = Math.ceil((maxY + 200) / CELL);
  const near = new Uint8Array(cols * rows);
  const reach = Math.ceil(160 / CELL);
  for (let k = 0; k < t.n; k += 5) {
    const ci = Math.floor(t.x[k] / CELL);
    const cj = Math.floor(t.y[k] / CELL);
    for (let j = Math.max(0, cj - reach); j <= Math.min(rows - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(cols - 1, ci + reach); i++) near[j * cols + i] = 1;
    }
  }
  return (x, y, margin) => {
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(y / CELL);
    if (ci < 0 || cj < 0 || ci >= cols || cj >= rows || !near[cj * cols + ci]) return false;
    const nearest = index.nearest(x, y, 150);
    if (!nearest) return false;
    const lat = index.lateral(nearest.k, x, y);
    const depth = lat >= 0 ? left[nearest.k] : right[nearest.k];
    if (depth <= 0) return false;
    return Math.abs(lat) < t.width[nearest.k] / 2 + VERGE + depth + margin;
  };
}

/** A corner's name for labels and shots: "T3 hairpin". */
export function cornerName(c: Corner): string {
  return `T${c.number} ${CORNER_LABELS[c.type].toLowerCase()}`;
}
