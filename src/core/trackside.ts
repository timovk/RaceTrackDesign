/**
 * What stands beside the track for the public and the cameras, in scene
 * coordinates (x east, y up, z south):
 *
 * - advertising boards in front of the barriers, at the line and round the
 *   outside of the corners, each a row of panels with one sign on it;
 * - a gantry over the start line with the lights, and a bridge over the
 *   longest straights, with boards on both faces;
 * - the crowd: people on the rows of the grandstands;
 * - tyre marks on the asphalt: the worn-in ones at the braking points, and
 *   those the cars of a race leave (`RaceSim.marks`).
 *
 * The signs are words from racing, not real companies (core/signs.ts).
 * Everything keeps its real height whatever the view's height exaggeration
 * (each vertex anchored to the ground or the road under it).
 */
import type { Corner, Straight } from './analysis.ts';
import type { BarrierRun } from './barriers.ts';
import type { LapResult } from './lapSim.ts';
import type { PitLane } from './pitLane.ts';
import type { SkidMark } from './race/sim.ts';
import type { RacingLine } from './racingLine.ts';
import { seededRandom } from './rng.ts';
import { type Earthworks, MeshBuilder, type MeshData } from './scene3d.ts';
import { PanelBuilder, SIGNS, START_SIGN, cellUv, signCell } from './signs.ts';
import { type Footprint, STAND_DEPTH, STAND_RISE, STAND_ROWS, type Stand, type TrackIndex, inside } from './scenery.ts';
import type { Track } from './track.ts';

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** A point `offset` metres to the `side` of station k's centre (+1 its left). */
function beside(t: Track, k: number, side: number, offset: number): [number, number] {
  const h = t.heading[k];
  return [t.x[k] + Math.sin(h) * side * offset, t.y[k] - Math.cos(h) * side * offset];
}

// ---- advertising boards ----------------------------------------------------------------

/**
 * Boards stand in front of the rail (BOARD_FRONT metres towards the track;
 * in front of a tyre wall, BOARD_TYRES), from BOARD_FOOT to BOARD_TOP
 * metres over the ground: as high as the rail they hide.
 */
const BOARD_FRONT = 0.3;
const BOARD_TYRES = 1.5;
const BOARD_FOOT = 0.05;
const BOARD_TOP = 1.05;
/** Along the start straight this far either side of the line, and round a corner from this far before it to this far after (metres). */
const BOARDS_AT_LINE = 170;
const BOARDS_BEFORE = 25;
const BOARDS_AFTER = 45;
/** Only corners that turn this much (degrees). */
const BOARD_CORNER = 35;
/** A sign is this long (metres: four times as long as high, as its picture is), and comes this many times in a row before the next one. */
const BOARD_SIGN = 4.2;
const BOARD_REPEAT = 4;

/**
 * One panel of a row of boards: from `a` to `b` along the track (map
 * coordinates and the ground there), facing the track from its `side`, and
 * the part of its sign it shows (0 where the sign begins along the track,
 * 1 where it ends).
 */
export interface Board {
  side: 1 | -1;
  station: number;
  a: { x: number; y: number; g: number };
  b: { x: number; y: number; g: number };
  sign: number;
  from: number;
  to: number;
}

/**
 * Rows of advertising boards in front of the barriers: along the start straight
 * either side of the line, and round the outside of the corners, where the
 * cameras look.
 */
export function placeBoards(t: Track, runs: readonly BarrierRun[], corners: readonly Corner[], earth: Earthworks): Board[] {
  const n = t.n;
  const wanted = [new Uint8Array(n), new Uint8Array(n)];
  const mark = (side: 1 | -1, from: number, to: number) => {
    const len = mod(to - from, n);
    for (let i = 0; i <= len; i++) wanted[side > 0 ? 0 : 1][(from + i) % n] = 1;
  };
  const line = Math.round(BOARDS_AT_LINE / t.ds);
  for (const side of [1, -1] as const) mark(side, mod(-line, n), line % n);
  for (const c of corners) {
    if (c.angle < BOARD_CORNER) continue;
    // A right-hander's outside is on the left.
    mark(c.direction === 'right' ? 1 : -1, mod(c.start - Math.round(BOARDS_BEFORE / t.ds), n), mod(c.end + Math.round(BOARDS_AFTER / t.ds), n));
  }
  const boards: Board[] = [];
  for (const r of runs) {
    const want = wanted[r.side > 0 ? 0 : 1];
    // Metres into the row, or -1 before one begins; and the sign a row starts with.
    let row = -1;
    let sign = 0;
    for (let i = 0; i + 1 < r.stations.length; i++) {
      const k = r.stations[i];
      const k1 = r.stations[i + 1];
      if (!want[k] || !want[k1]) {
        row = -1;
        continue;
      }
      const front = r.tyres[i] || r.tyres[i + 1] ? BOARD_TYRES : BOARD_FRONT;
      const [ax, ay] = beside(t, k, r.side, r.offset[i] - front);
      const [bx, by] = beside(t, k1, r.side, r.offset[i + 1] - front);
      const length = Math.hypot(bx - ax, by - ay);
      // (Where a run breaks off, or the rail steps in or out, no panel spans the gap.)
      if (length > 3 * t.ds + 4 || length < 1) {
        row = -1;
        continue;
      }
      // A new row takes a sign of its own, by where it stands.
      if (row < 0) {
        row = 0;
        sign = (k * 7 + (r.side > 0 ? 0 : 5)) % (SIGNS.length - 1);
      }
      const ga = earth.height(ax, ay);
      const gb = earth.height(bx, by);
      const at = (f: number) => ({ x: ax + (bx - ax) * f, y: ay + (by - ay) * f, g: ga + (gb - ga) * f });
      // The stretch between two posts of the rail, cut where one sign ends and the next begins.
      let done = 0;
      while (done < length - 1e-6) {
        const index = Math.floor((row + done) / BOARD_SIGN + 1e-9);
        const start = index * BOARD_SIGN;
        const end = Math.min(length, start + BOARD_SIGN - row);
        boards.push({
          side: r.side, station: k, a: at(done / length), b: at(end / length), sign: (sign + Math.floor(index / BOARD_REPEAT)) % (SIGNS.length - 1),
          from: (row + done - start) / BOARD_SIGN, to: (row + end - start) / BOARD_SIGN,
        });
        done = end;
      }
      row += length;
    }
  }
  return boards;
}

/** The boards as meshes: their faces towards the track (textured), and their backs and posts (plain). */
export function buildBoards(boards: readonly Board[]): { faces: MeshData; frames: MeshData } {
  const faces = new PanelBuilder();
  const frames = new MeshBuilder();
  const back = [0.34, 0.36, 0.4];
  const post = [0.25, 0.27, 0.3];
  for (const p of boards) {
    const { a, b } = p;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Towards the track: to the right of the direction of travel on the left side, and the other way round.
    const nx = (-dy / len) * p.side;
    const ny = (dx / len) * p.side;
    // Seen from the track the panel reads left to right: from `a` on the left side of the track, from `b` on the right.
    const cell = cellUv(signCell(p.sign));
    const part = p.side > 0 ? [p.from, p.to] : [1 - p.to, 1 - p.from];
    const uv: [number, number, number, number] = [cell[0] + (cell[2] - cell[0]) * part[0], cell[1], cell[0] + (cell[2] - cell[0]) * part[1], cell[3]];
    const [l, r] = p.side > 0 ? [a, b] : [b, a];
    faces.face([
      [l.x, l.g + BOARD_FOOT, l.y, l.g], [r.x, r.g + BOARD_FOOT, r.y, r.g], [r.x, r.g + BOARD_TOP, r.y, r.g], [l.x, l.g + BOARD_TOP, l.y, l.g],
    ], [nx, 0, ny], uv);
    const d = 0.06;
    frames.face([
      [a.x - nx * d, a.g + BOARD_FOOT, a.y - ny * d, a.g], [b.x - nx * d, b.g + BOARD_FOOT, b.y - ny * d, b.g],
      [b.x - nx * d, b.g + BOARD_TOP, b.y - ny * d, b.g], [a.x - nx * d, a.g + BOARD_TOP, a.y - ny * d, a.g],
    ], [-nx, 0, -ny], back);
    // A post behind the panel at its first end, from the ground up.
    const w = 0.06;
    const tx = dx / len;
    const ty = dy / len;
    const px = a.x - nx * 0.12;
    const py = a.y - ny * 0.12;
    frames.face([
      [px - tx * w, a.g - 0.3, py - ty * w, a.g], [px + tx * w, a.g - 0.3, py + ty * w, a.g],
      [px + tx * w, a.g + BOARD_TOP, py + ty * w, a.g], [px - tx * w, a.g + BOARD_TOP, py - ty * w, a.g],
    ], [-nx, 0, -ny], post);
  }
  return { faces: faces.build(), frames: frames.build() };
}

// ---- gantries ----------------------------------------------------------------------

/** The start gantry: its posts this far outside the track's edge, its beam from this height to this height over the road. */
const GANTRY_OUT = 1.4;
const GANTRY_LOW = 6.2;
const GANTRY_HIGH = 7.5;
/** A bridge: its posts this far beyond the track's edge (behind the barrier), its deck between these heights. */
const BRIDGE_OUT = 11;
const BRIDGE_LOW = 6.6;
const BRIDGE_HIGH = 8.4;
/** Bridges go over straights at least this long (metres), two at most, not within this distance of the line. */
const BRIDGE_STRAIGHT = 300;
const BRIDGES = 2;
const BRIDGE_FROM_LINE = 300;

/** A gantry across the track at a station: the start gantry with the lights, or a bridge with boards. */
export interface Gantry {
  kind: 'start' | 'bridge';
  station: number;
  /** Its two ends (map coordinates, the ground there and whether a post stands there: the start gantry has none in the pit lane). */
  ends: { x: number; y: number; g: number; post: boolean }[];
  /** Height of the road under it. */
  road: number;
  sign: number;
}

/** Distance from a point to a polyline. */
function toPath(xs: Float64Array, ys: Float64Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < xs.length; i++) {
    const dx = xs[i + 1] - xs[i];
    const dy = ys[i + 1] - ys[i];
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((x - xs[i]) * dx + (y - ys[i]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (xs[i] + dx * f), y - (ys[i] + dy * f)));
  }
  return best;
}

/**
 * The gantries: one over the start line (a post left out where it would
 * stand in the pit lane: the beam then hangs from the other), and bridges
 * over the middle of the longest straights where both posts have free
 * ground, clear of the pit lane, the buildings and the other roads.
 */
export function placeGantries(
  t: Track, straights: readonly Straight[], pit: PitLane | null, earth: Earthworks, avoid: readonly Footprint[], blocked?: (x: number, y: number) => boolean,
): Gantry[] {
  const out: Gantry[] = [];
  const inPit = (x: number, y: number, margin: number) => !!pit && toPath(pit.x, pit.y, x, y) < pit.width / 2 + margin;
  const end = (k: number, side: number, offset: number) => {
    const [x, y] = beside(t, k, side, offset);
    return { x, y, g: earth.height(x, y) };
  };
  // The start gantry, over the line: the grid looks up at its lights.
  const k0 = 0;
  const ends = ([1, -1] as const).map((side) => {
    const e = end(k0, side, t.width[k0] / 2 + GANTRY_OUT);
    return { ...e, post: !inPit(e.x, e.y, 0.3) && !avoid.some((f) => inside(f, e.x, e.y, 0.5)) };
  });
  if (ends.some((e) => e.post)) out.push({ kind: 'start', station: k0, ends, road: t.z[k0], sign: START_SIGN });
  // Bridges over the longest straights.
  const n = t.n;
  const far = (k: number) => Math.min(mod(k, n), mod(-k, n)) * t.ds >= BRIDGE_FROM_LINE;
  let sign = 1;
  let bridges = 0;
  for (const s of [...straights].sort((a, b) => b.length - a.length)) {
    if (bridges >= BRIDGES || s.length < BRIDGE_STRAIGHT) break;
    const len = mod(s.end - s.start, n);
    // The middle first, then either side of it.
    for (const share of [0.5, 0.35, 0.65]) {
      const k = (s.start + Math.round(len * share)) % n;
      if (!far(k)) continue;
      const pair = ([1, -1] as const).map((side) => ({ ...end(k, side, t.width[k] / 2 + BRIDGE_OUT), post: true }));
      const free = pair.every((e) => !inPit(e.x, e.y, 3) && !avoid.some((f) => inside(f, e.x, e.y, 3)) && !(blocked?.(e.x, e.y) ?? false)
        && earth.natural(e.x, e.y) > earth.ground.waterLevel + 0.5 && Math.abs(e.g - t.z[k]) < 6);
      if (!free) continue;
      out.push({ kind: 'bridge', station: k, ends: pair, road: t.z[k], sign: sign++ });
      bridges++;
      break;
    }
  }
  return out;
}

/** The gantries as meshes: posts, beams and the lights (plain), and the boards on both faces (textured). */
export function buildGantries(t: Track, gantries: readonly Gantry[]): { structure: MeshData; faces: MeshData } {
  const mb = new MeshBuilder();
  const faces = new PanelBuilder();
  const steel = [0.3, 0.32, 0.36];
  const dark = [0.1, 0.11, 0.13];
  const lamp = [0.32, 0.05, 0.05];
  /** A box from two corners of its base rectangle (centre line a to b, `half` wide) between two heights over a floor. */
  const box = (a: { x: number; y: number }, b: { x: number; y: number }, half: number, lo: number, hi: number, floor: number, color: readonly number[]) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const c = (p: { x: number; y: number }, s: number, h: number): [number, number, number, number] => [p.x + nx * half * s, floor + h, p.y + ny * half * s, floor];
    mb.face([c(a, 1, lo), c(b, 1, lo), c(b, 1, hi), c(a, 1, hi)], [nx, 0, ny], color);
    mb.face([c(a, -1, lo), c(b, -1, lo), c(b, -1, hi), c(a, -1, hi)], [-nx, 0, -ny], color);
    mb.face([c(a, 1, hi), c(b, 1, hi), c(b, -1, hi), c(a, -1, hi)], [0, 1, 0], color);
    mb.face([c(a, 1, lo), c(b, 1, lo), c(b, -1, lo), c(a, -1, lo)], [0, -1, 0], color);
    mb.face([c(a, 1, lo), c(a, -1, lo), c(a, -1, hi), c(a, 1, hi)], [-dx / len, 0, -dy / len], color);
    mb.face([c(b, 1, lo), c(b, -1, lo), c(b, -1, hi), c(b, 1, hi)], [dx / len, 0, dy / len], color);
  };
  for (const g of gantries) {
    const [l, r] = g.ends;
    const bridge = g.kind === 'bridge';
    const lo = bridge ? BRIDGE_LOW : GANTRY_LOW;
    const hi = bridge ? BRIDGE_HIGH : GANTRY_HIGH;
    const depth = bridge ? 1.6 : 0.5;
    const h = t.heading[g.station];
    // Along the track, and across it from the left end to the right.
    const fx = Math.cos(h);
    const fy = Math.sin(h);
    const span = Math.hypot(r.x - l.x, r.y - l.y);
    for (const e of g.ends) {
      if (!e.post) continue;
      const w = bridge ? 0.7 : 0.35;
      box({ x: e.x - fx * w, y: e.y - fy * w }, { x: e.x + fx * w, y: e.y + fy * w }, w, Math.min(0, e.g - g.road) - 0.5, hi, g.road, steel);
    }
    box(l, r, depth, lo, hi, g.road, bridge ? [0.42, 0.44, 0.48] : steel);
    // A board on each face, the sign repeated along it.
    const uv = cellUv(signCell(g.sign));
    const panels = Math.max(1, Math.round(span / ((hi - lo - 0.2) * 4.2)));
    for (const dir of [1, -1]) {
      // Seen from in front of this face, left to right.
      const [from, to] = dir > 0 ? [r, l] : [l, r];
      const ox = fx * dir * (depth + 0.03);
      const oy = fy * dir * (depth + 0.03);
      for (let i = 0; i < panels; i++) {
        const p = (s: number): [number, number] => [from.x + ((to.x - from.x) * s) + ox, from.y + ((to.y - from.y) * s) + oy];
        const [ax, ay] = p(i / panels);
        const [bx, by] = p((i + 1) / panels);
        faces.face([
          [ax, g.road + lo + 0.1, ay, g.road], [bx, g.road + lo + 0.1, by, g.road], [bx, g.road + hi - 0.1, by, g.road], [ax, g.road + hi - 0.1, ay, g.road],
        ], [fx * dir, 0, fy * dir], uv);
      }
    }
    if (bridge) continue;
    // The start lights under the beam, facing the grid: five housings, two lamps each.
    const across = { x: (r.x - l.x) / span, y: (r.y - l.y) / span };
    const mid = { x: (l.x + r.x) / 2 - fx * (depth + 0.25), y: (l.y + r.y) / 2 - fy * (depth + 0.25) };
    for (let i = -2; i <= 2; i++) {
      const c = { x: mid.x + across.x * i * 0.9, y: mid.y + across.y * i * 0.9 };
      box({ x: c.x - across.x * 0.3, y: c.y - across.y * 0.3 }, { x: c.x + across.x * 0.3, y: c.y + across.y * 0.3 }, 0.14, lo - 1.0, lo - 0.05, g.road, dark);
      for (const up of [0.3, 0.68]) {
        const s = 0.16;
        const x = c.x - fx * 0.15;
        const y = c.y - fy * 0.15;
        mb.face([
          [x - across.x * s, g.road + lo - 1 + up - s, y - across.y * s, g.road], [x + across.x * s, g.road + lo - 1 + up - s, y + across.y * s, g.road],
          [x + across.x * s, g.road + lo - 1 + up + s, y + across.y * s, g.road], [x - across.x * s, g.road + lo - 1 + up + s, y - across.y * s, g.road],
        ], [-fx, 0, -fy], lamp);
      }
    }
  }
  return { structure: mb.build(), faces: faces.build() };
}

// ---- the crowd ----------------------------------------------------------------------

/** Seats this far apart along a row, and this share of them taken. */
const SEAT = 0.62;
const CROWD_FILL = 0.84;
const SHIRTS: readonly (readonly number[])[] = [
  [0.85, 0.12, 0.14], [0.95, 0.95, 0.93], [0.12, 0.3, 0.7], [0.95, 0.75, 0.1], [0.1, 0.1, 0.12], [0.2, 0.55, 0.3], [0.9, 0.45, 0.1], [0.55, 0.6, 0.66],
  [0.75, 0.2, 0.5], [0.3, 0.65, 0.85], [0.92, 0.9, 0.8], [0.45, 0.12, 0.14],
];

/** The people on the grandstands: where each sits (scene coordinates), the floor of their stand, which way they face and the colour they wear. */
export interface Crowd {
  count: number;
  /** x, height, z per person. */
  positions: Float32Array;
  /** The stand's floor level, to keep each person's real height above it. */
  floors: Float32Array;
  /** Angle about the vertical each one faces (radians, 0 looking along +z). */
  facing: Float32Array;
  /** rgb per person (sRGB, 0..1). */
  colors: Float32Array;
}

/** A crowd for the grandstands: most seats taken, in a mix of colours, the same every time for the same seed. */
export function seatCrowd(stands: readonly Stand[], seed: string, fill = CROWD_FILL): Crowd {
  const rng = seededRandom(`${seed}:crowd`);
  const pos: number[] = [];
  const floors: number[] = [];
  const facing: number[] = [];
  const colors: number[] = [];
  const rowDepth = STAND_DEPTH / STAND_ROWS;
  for (const s of stands) {
    for (let i = 0; i + 1 < s.front.length; i++) {
      const a = s.front[i];
      const b = s.front[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const seats = Math.max(1, Math.floor(len / SEAT));
      for (let r = 0; r < STAND_ROWS; r++) {
        const z = s.base + 1 + r * STAND_RISE;
        const d = (r + 0.6) * rowDepth;
        for (let j = 0; j < seats; j++) {
          const taken = rng() < fill;
          const jitter = (rng() - 0.5) * 0.12;
          const shirt = SHIRTS[Math.floor(rng() * SHIRTS.length)];
          if (!taken) continue;
          const f = (j + 0.5) / seats;
          const ox = a.ox + (b.ox - a.ox) * f;
          const oy = a.oy + (b.oy - a.oy) * f;
          pos.push(a.x + (b.x - a.x) * f + ox * (d + jitter), z, a.y + (b.y - a.y) * f + oy * (d + jitter));
          floors.push(s.base);
          // Towards the track: against the stand's outward direction.
          facing.push(Math.atan2(-ox, -oy));
          colors.push(shirt[0], shirt[1], shirt[2]);
        }
      }
    }
  }
  return { count: floors.length, positions: Float32Array.from(pos), floors: Float32Array.from(floors), facing: Float32Array.from(facing), colors: Float32Array.from(colors) };
}

// ---- tyre marks --------------------------------------------------------------------

/** A mark is this wide per wheel, lies this far over the road, and is this dark at most (a lock-up, a spin, wheelspin; worn-in rubber far less). */
const MARK_WIDTH = 0.3;
const MARK_LIFT = 0.025;
const MARK_DARK: Record<SkidMark['kind'], number> = { lock: 0.62, spin: 0.78, start: 0.7 };
/** Worn-in marks at a braking point: where the lap brakes this hard, this many streaks per 100 m of it, each this long (metres). */
const BRAKING = 0.55;
const STREAKS = 9;
const STREAK = [14, 46];

/** A point this far past the edge of the road still counts as on it (metres). */
const ROAD_EDGE = 1;

/**
 * The height of the road under a point: between the two stations it lies
 * between (the road is level across, and the ground under it lies lower).
 * Off the road, the ground `ground` gives.
 */
export function roadHeight(index: TrackIndex, ground: (x: number, y: number) => number): (x: number, y: number) => number {
  const t = index.t;
  return (x, y) => {
    const near = index.nearest(x, y, 30);
    if (!near || Math.abs(index.lateral(near.k, x, y)) > t.width[near.k] / 2 + ROAD_EDGE) return ground(x, y);
    const k = near.k;
    const h = t.heading[k];
    const along = ((x - t.x[k]) * Math.cos(h) + (y - t.y[k]) * Math.sin(h)) / t.ds;
    const other = mod(k + (along >= 0 ? 1 : -1), t.n);
    return t.z[k] + (t.z[other] - t.z[k]) * Math.min(1, Math.abs(along));
  };
}

/** Tyre marks as a mesh on the road: per vertex how dark it is (0 to 1), and per mark the race time it begins and where its triangles end. */
export interface SkidMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Darkness per vertex. */
  alphas: Float32Array;
  anchors: Float32Array;
  indices: Uint32Array;
  /** For each mark, in order: the race time it is from, and the number of indices up to and including it. */
  times: Float64Array;
  ends: Uint32Array;
}

/**
 * Tyre marks as two strips each, one per wheel across the car, on the
 * ground `height` gives; a mark fades in and out along its length (wheelspin
 * only out). `dark` scales how dark they are.
 */
export function buildSkidMarks(marks: readonly SkidMark[], height: (x: number, y: number) => number, dark = 1): SkidMesh {
  const pos: number[] = [];
  const alpha: number[] = [];
  const anc: number[] = [];
  const idx: number[] = [];
  const times: number[] = [];
  const ends: number[] = [];
  for (const m of marks) {
    const pts = m.points;
    const last = pts.length - 1;
    const peak = MARK_DARK[m.kind] * dark;
    if (last >= 1) {
      for (const wheel of [-1, 1]) {
        const first = pos.length / 3;
        pts.forEach((p, i) => {
          // The car's left is (sin h, -cos h) on the map.
          const lx = Math.sin(p.heading);
          const ly = -Math.cos(p.heading);
          const fade = m.kind === 'start' ? 1 - i / last : Math.min(1, (3 * Math.min(i, last - i)) / last + (last < 3 ? 0.6 : 0));
          for (const edge of [-1, 1]) {
            const o = wheel * m.half + (edge * MARK_WIDTH) / 2;
            const x = p.x + lx * o;
            const y = p.y + ly * o;
            const g = height(x, y);
            pos.push(x, g + MARK_LIFT, y);
            anc.push(g);
            alpha.push(peak * Math.max(0, Math.min(1, fade)));
          }
        });
        for (let i = 0; i < last; i++) {
          // (Each row runs from the car's right to its left: wound to face up.)
          const a = first + i * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
    }
    times.push(m.t);
    ends.push(idx.length);
  }
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  return {
    positions: Float32Array.from(pos), normals, alphas: Float32Array.from(alpha), anchors: Float32Array.from(anc), indices: Uint32Array.from(idx),
    times: Float64Array.from(times), ends: Uint32Array.from(ends),
  };
}

/**
 * The marks worn into the asphalt where every lap brakes hard: streaks
 * along the racing line, a little either side of it, more of them the
 * longer the braking. They are no race's: their time is -Infinity.
 */
export function brakingMarks(t: Track, line: RacingLine, lap: LapResult, seed: string, half = 0.75): SkidMark[] {
  const rng = seededRandom(`${seed}:rubber`);
  const n = t.n;
  const marks: SkidMark[] = [];
  let k = 0;
  // Start outside a braking zone, so one that wraps past the line is not cut in two.
  while (k < n && lap.brake[k] >= BRAKING) k++;
  const from = k % n;
  for (let i = 0; i < n; i++) {
    const s = (from + i) % n;
    if (lap.brake[s] < BRAKING) continue;
    let len = 0;
    while (len < n && lap.brake[(s + len) % n] >= BRAKING) len++;
    const metres = len * t.ds;
    const count = Math.max(2, Math.round((metres / 100) * STREAKS));
    for (let c = 0; c < count; c++) {
      const start = s + rng() * len * 0.8;
      const length = STREAK[0] + (STREAK[1] - STREAK[0]) * rng() * rng();
      const off = (rng() - 0.5) * 2.6;
      const points: SkidMark['points'] = [];
      const steps = Math.max(2, Math.ceil(length / 4));
      for (let j = 0; j <= steps; j++) {
        const u = start + ((length / t.ds) * j) / steps;
        const a = Math.floor(mod(u, n));
        const b = (a + 1) % n;
        const f = u - Math.floor(u);
        const h = line.heading[a];
        points.push({ x: line.x[a] + (line.x[b] - line.x[a]) * f + Math.sin(h) * off, y: line.y[a] + (line.y[b] - line.y[a]) * f - Math.cos(h) * off, heading: h });
      }
      marks.push({ t: -Infinity, car: -1, kind: 'lock', half: half * (0.85 + 0.3 * rng()), points });
    }
    i += len;
  }
  return marks;
}
