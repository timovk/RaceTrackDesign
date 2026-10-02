/**
 * The barriers round a circuit, in scene coordinates (x east, y up, z
 * south), as at a real one:
 *
 * - steel guardrail (two W-beam rails on posts every 2 m) along both sides,
 *   BARRIER_GAP metres beyond the verge where there is no run-off (or at the
 *   foot of a cutting's bank, or the top of an embankment, when that comes
 *   sooner), and just behind the run-off at the corners;
 * - a tyre wall in front of the rail at the back of each gravel trap, its
 *   face covered in belting, red and white;
 * - catch fencing behind the rail, 3.5 m high, along the grandstands and the
 *   start and finish straight away from the pits.
 *
 * Barriers stop short of what is in their way: the pit lane on its side
 * (the pit wall is the barrier there), other roads and other parts of the
 * track, water, the map's edge and buildings. They follow the shaped
 * ground and keep their real height whatever the view's height
 * exaggeration (each vertex anchored to the ground under it).
 */
import { type Earthworks, MeshBuilder, type MeshData, VERGE } from './scene3d.ts';
import type { PitLane } from './pitLane.ts';
import { type Footprint, type RunoffArea, type Stand, type TrackIndex, inside } from './scenery.ts';
import type { Track } from './track.ts';

/** Grass between the verge and the rail where there is no run-off (m). */
export const BARRIER_GAP = 4;
/** The rail stands this far behind the run-off's far edge (m). */
const BEHIND_RUNOFF = 1.5;
/** Where there is no run-off, the rail comes in to where the ground beyond the verge has risen or fallen this much (m): a bank. */
const BANK_STEP = 0.6;
/** Away from the run-off the rail holds the nearest line within this many stations either way, so it does not zigzag. */
const SMOOTH = 5;
/** Run-off this deep (m) at a station is a gravel trap with a tyre wall at its back. */
const TRAP = 3;
/** Rails: two W-beams, bottom and top heights (m). */
const RAILS: readonly [number, number][] = [[0.4, 0.71], [0.71, 1.02]];
const TYRE_DEPTH = 1.3;
const TYRE_HEIGHT = 0.95;
export const FENCE_HEIGHT = 3.5;
/** Fence posts every this many stations. */
const FENCE_EVERY = 2;
/** Fencing where a grandstand's front is within this distance (m) of the rail, and this far either side of the line (m). */
const FENCE_NEAR_STAND = 45;
const FENCE_AT_LINE = 200;

export interface BarrierRun {
  side: 1 | -1;
  /** Stations along the run, forward round the lap, and the rail's distance from the centreline at each (m). */
  stations: number[];
  offset: number[];
  /** A tyre wall in front of the rail, catch fencing behind it. */
  tyres: boolean[];
  fence: boolean[];
}

export interface BarrierInput {
  track: Track;
  index: TrackIndex;
  earth: Earthworks;
  runoff: readonly RunoffArea[];
  pit: PitLane | null;
  stands: readonly Stand[];
  /** Buildings to keep clear of. */
  avoid: readonly Footprint[];
  /** Other roads (the rest of the circuit round a layout). */
  blocked?: (x: number, y: number) => boolean;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Where a station's barrier stands: `offset` metres to the `side` of the centreline. */
function barrierPoint(t: Track, k: number, side: 1 | -1, offset: number): [number, number] {
  const h = t.heading[k];
  return [t.x[k] + Math.sin(h) * side * offset, t.y[k] - Math.cos(h) * side * offset];
}

/** The barrier runs along both sides of the track. */
export function barrierRuns(input: BarrierInput): BarrierRun[] {
  const { track: t, index, earth } = input;
  const n = t.n;
  const hm = earth.ground;
  const local = Math.round(300 / t.ds);
  const out: BarrierRun[] = [];
  for (const side of [1, -1] as const) {
    const depth = new Float64Array(n);
    for (const a of input.runoff) {
      if (a.side !== side) continue;
      a.stations.forEach((k, i) => (depth[k] = Math.max(depth[k], a.depth[i])));
    }
    const pitSide = input.pit && input.pit.side === side ? input.pit : null;
    const raw = new Float64Array(n);
    const behindRunoff = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const edge = t.width[k] / 2 + VERGE;
      raw[k] = edge + Math.max(BARRIER_GAP, depth[k] + BEHIND_RUNOFF);
      if (depth[k] >= 0.5) {
        behindRunoff[k] = raw[k];
        continue;
      }
      // At the foot of a cutting's bank, or the top of an embankment, rather than part way along it.
      const [ex, ey] = barrierPoint(t, k, side, edge);
      const level = earth.height(ex, ey);
      for (let d = 1; d <= BARRIER_GAP; d += 0.5) {
        const [x, y] = barrierPoint(t, k, side, edge + d);
        if (Math.abs(earth.height(x, y) - level) > BANK_STEP) {
          raw[k] = edge + Math.max(1, d - 0.5);
          break;
        }
      }
    }
    // A steady line: away from the run-off, the nearest the rail comes within SMOOTH stations either way; then it
    // changes by at most a metre a metre, never coming in over the run-off.
    const offset = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      offset[k] = raw[k];
      if (behindRunoff[k]) continue;
      for (let j = -SMOOTH; j <= SMOOTH; j++) {
        const kk = mod(k + j, n);
        if (!behindRunoff[kk]) offset[k] = Math.min(offset[k], raw[kk]);
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i <= n; i++) {
        const k = mod(pass ? -i : i, n);
        const prev = mod(pass ? -i + 1 : i - 1, n);
        offset[k] = Math.max(behindRunoff[k], Math.min(offset[k], offset[prev] + t.ds));
      }
    }
    const ok = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      // Along the pit lane its wall is the barrier.
      if (pitSide && mod(k - pitSide.entry, n) <= mod(pitSide.exit - pitSide.entry, n)) continue;
      const [x, y] = barrierPoint(t, k, side, offset[k]);
      if (x < 5 || y < 5 || x > hm.extent - 5 || y > hm.extent - 5) continue;
      if (earth.natural(x, y) < hm.waterLevel) continue;
      // Not on another road's verge: the pit lane beyond its ends, the rest of the circuit.
      if (earth.clearance(x, y) < VERGE + 0.5) continue;
      const other = index.nearest(x, y, 40, (j) => index.near(j, k, local));
      if (other && other.d < t.width[other.k] / 2 + VERGE + 1) continue;
      if (input.blocked?.(x, y)) continue;
      if (input.avoid.some((f) => inside(f, x, y, 1.5))) continue;
      ok[k] = 1;
    }
    const tyres = (k: number) => depth[k] > TRAP;
    const fence = (k: number) => {
      const [x, y] = barrierPoint(t, k, side, offset[k]);
      if (!pitSide && (k * t.ds < FENCE_AT_LINE || (n - k) * t.ds < FENCE_AT_LINE)) return true;
      return input.stands.some((s) => s.front.some((p) => Math.hypot(p.x - x, p.y - y) < FENCE_NEAR_STAND));
    };
    const runOf = (stations: number[]): BarrierRun => ({
      side, stations, offset: stations.map((k) => offset[k]), tyres: stations.map(tyres), fence: stations.map(fence),
    });
    const start = ok.indexOf(0);
    if (start < 0) {
      // All the way round: one run, closed.
      out.push(runOf([...Array.from({ length: n }, (_, k) => k), 0]));
      continue;
    }
    let run: number[] = [];
    for (let i = 1; i <= n; i++) {
      const k = (start + i) % n;
      if (ok[k]) run.push(k);
      if ((!ok[k] || i === n) && run.length) {
        if (run.length * t.ds >= 12) out.push(runOf(run));
        run = [];
      }
    }
  }
  return out;
}

/** Whether a point lies between the track and its barrier (within `margin` metres behind it): for keeping things behind the barrier. */
export function insideBarriers(t: Track, runs: readonly BarrierRun[], index: TrackIndex): (x: number, y: number, margin: number) => boolean {
  const reach = [new Float32Array(t.n), new Float32Array(t.n)];
  for (const r of runs) r.stations.forEach((k, i) => (reach[r.side === 1 ? 0 : 1][k] = r.offset[i]));
  return (x, y, margin) => {
    const near = index.nearest(x, y, 150);
    if (!near) return false;
    const lat = index.lateral(near.k, x, y);
    const r = reach[lat >= 0 ? 0 : 1][near.k];
    return r > 0 && Math.abs(lat) < r + margin;
  };
}

const GALVANISED = [0.66, 0.68, 0.7];
const POST = [0.48, 0.5, 0.52];
const RUBBER = [0.09, 0.09, 0.1];
const BELT = [[0.78, 0.1, 0.1], [0.92, 0.92, 0.9]] as const;

/** The rails and posts (steel) and the tyre walls, as meshes with vertex colours. */
export function buildBarriers(t: Track, runs: readonly BarrierRun[], earth: Earthworks): { steel: MeshData; tyres: MeshData } {
  const mb = new MeshBuilder();
  const walls = new MeshBuilder();
  for (const r of runs) {
    const pts = r.stations.map((k, i) => {
      const [x, y] = barrierPoint(t, k, r.side, r.offset[i]);
      return { x, y, g: earth.height(x, y) };
    });
    // Towards the track at each point, level.
    const toward = r.stations.map((k) => {
      const h = t.heading[k];
      return [-Math.sin(h) * r.side, Math.cos(h) * r.side] as const;
    });
    // W-beam profile, out towards the track (m) against height up the beam (share of it).
    const W = [[0, 0], [0.07, 0.18], [0.07, 0.36], [0.02, 0.5], [0.07, 0.64], [0.07, 0.82], [0, 1]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      // Where a gravel trap ends the rail turns in towards the track, across a few metres.
      if (Math.hypot(b.x - a.x, b.y - a.y) > 30) continue;
      const ta = toward[i];
      const tb = toward[i + 1];
      for (const [lo, hi] of RAILS) {
        for (let j = 0; j + 1 < W.length; j++) {
          const [o0, h0] = W[j];
          const [o1, h1] = W[j + 1];
          const y0 = lo + (hi - lo) * h0;
          const y1 = lo + (hi - lo) * h1;
          // The face's normal: towards the track, tilted by the profile's slope.
          const dy = y1 - y0;
          const dout = o1 - o0;
          const len = Math.hypot(dy, dout) || 1;
          const up = -dout / len;
          const flat = dy / len;
          mb.face([
            [a.x + ta[0] * o0, a.g + y0, a.y + ta[1] * o0, a.g],
            [b.x + tb[0] * o0, b.g + y0, b.y + tb[1] * o0, b.g],
            [b.x + tb[0] * o1, b.g + y1, b.y + tb[1] * o1, b.g],
            [a.x + ta[0] * o1, a.g + y1, a.y + ta[1] * o1, a.g],
          ], [ta[0] * flat, up, ta[1] * flat], GALVANISED);
        }
        // The back of the rail and its top edge.
        mb.face([[a.x, a.g + lo, a.y, a.g], [b.x, b.g + lo, b.y, b.g], [b.x, b.g + hi, b.y, b.g], [a.x, a.g + hi, a.y, a.g]], [-ta[0], 0, -ta[1]], GALVANISED);
      }
      if (r.tyres[i] && r.tyres[i + 1]) {
        // The tyre wall: its belted face towards the track, red and white by turns every 4 m, the tyres' tops black.
        const belt = BELT[Math.floor(i / 2) % 2];
        const fa = [a.x + ta[0] * TYRE_DEPTH, a.y + ta[1] * TYRE_DEPTH];
        const fb = [b.x + tb[0] * TYRE_DEPTH, b.y + tb[1] * TYRE_DEPTH];
        const ga = earth.height(fa[0], fa[1]);
        const gb = earth.height(fb[0], fb[1]);
        walls.face([[fa[0], ga - 0.1, fa[1], ga], [fb[0], gb - 0.1, fb[1], gb], [fb[0], gb + TYRE_HEIGHT, fb[1], gb], [fa[0], ga + TYRE_HEIGHT, fa[1], ga]], [ta[0], 0, ta[1]], belt);
        walls.face([
          [fa[0], ga + TYRE_HEIGHT, fa[1], ga], [fb[0], gb + TYRE_HEIGHT, fb[1], gb],
          [b.x + tb[0] * 0.1, b.g + TYRE_HEIGHT, b.y + tb[1] * 0.1, b.g], [a.x + ta[0] * 0.1, a.g + TYRE_HEIGHT, a.y + ta[1] * 0.1, a.g],
        ], [0, 1, 0], RUBBER);
      }
    }
    // Posts every 2 m, just behind the rails; the catch fence's taller ones behind them.
    const post = (cx: number, cy: number, ta: readonly [number, number], g: number, s: number, top: number) => {
      const along = [ta[1], -ta[0]];
      const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [cx + along[0] * s * u + ta[0] * s * v, cy + along[1] * s * u + ta[1] * s * v]);
      for (let e = 0; e < 4; e++) {
        const p0 = c[e];
        const p1 = c[(e + 1) % 4];
        const nx = (p0[0] + p1[0]) / 2 - cx;
        const ny = (p0[1] + p1[1]) / 2 - cy;
        mb.face([[p0[0], g - 0.2, p0[1], g], [p1[0], g - 0.2, p1[1], g], [p1[0], g + top, p1[1], g], [p0[0], g + top, p0[1], g]], [nx, 0, ny], POST);
      }
    };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const ta = toward[i];
      post(p.x - ta[0] * 0.09, p.y - ta[1] * 0.09, ta, p.g, 0.06, RAILS[1][1]);
      const fenceEnd = i === pts.length - 1 || !r.fence[i + 1] || (i > 0 && !r.fence[i - 1]);
      if (r.fence[i] && (i % FENCE_EVERY === 0 || fenceEnd)) {
        const [fx, fy] = barrierPoint(t, r.stations[i], r.side, r.offset[i] + 0.35);
        post(fx, fy, ta, earth.height(fx, fy), 0.05, FENCE_HEIGHT + 0.1);
      }
    }
  }
  return { steel: mb.build(), tyres: walls.build() };
}

/**
 * The catch fencing's wire-mesh panels behind the rail where the runs ask
 * for it, with uv for the mesh texture: u along the fence and v up it, in
 * metres. Its posts are part of `buildBarriers`.
 */
export function buildFences(t: Track, runs: readonly BarrierRun[], earth: Earthworks): MeshData {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const anc: number[] = [];
  const idx: number[] = [];
  const vertex = (x: number, y: number, z: number, nx: number, nz: number, u: number, v: number, ground: number) => {
    pos.push(x, y, z);
    nrm.push(nx, 0, nz);
    uv.push(u, v);
    anc.push(ground);
    return pos.length / 3 - 1;
  };
  for (const r of runs) {
    // Contiguous stretches of fencing, posts every FENCE_EVERY stations.
    let stretch: { x: number; y: number; g: number; tx: number; ty: number }[] = [];
    const flush = () => {
      if (stretch.length >= 2) {
        let u = 0;
        for (let i = 0; i + 1 < stretch.length; i++) {
          const a = stretch[i];
          const b = stretch[i + 1];
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len > 12) {
            u += len;
            continue;
          }
          const base = vertex(a.x, a.g, a.y, a.tx, a.ty, u, 0, a.g);
          vertex(b.x, b.g, b.y, b.tx, b.ty, u + len, 0, b.g);
          vertex(b.x, b.g + FENCE_HEIGHT, b.y, b.tx, b.ty, u + len, FENCE_HEIGHT, b.g);
          vertex(a.x, a.g + FENCE_HEIGHT, a.y, a.tx, a.ty, u, FENCE_HEIGHT, a.g);
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          u += len;
        }
      }
      stretch = [];
    };
    r.stations.forEach((k, i) => {
      if (!r.fence[i]) {
        flush();
        return;
      }
      // Points where the posts are: every FENCE_EVERY stations and at both ends of a stretch.
      const end = i === r.stations.length - 1 || !r.fence[i + 1] || (i > 0 && !r.fence[i - 1]);
      if (i % FENCE_EVERY !== 0 && !end) return;
      const h = t.heading[k];
      const tx = -Math.sin(h) * r.side;
      const ty = Math.cos(h) * r.side;
      // Just behind the rail's posts.
      const [bx, by] = barrierPoint(t, k, r.side, r.offset[i] + 0.35);
      stretch.push({ x: bx, y: by, g: earth.height(bx, by), tx, ty });
    });
    flush();
  }
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    indices: Uint32Array.from(idx),
    anchors: Float32Array.from(anc),
    uvs: Float32Array.from(uv),
  };
}
