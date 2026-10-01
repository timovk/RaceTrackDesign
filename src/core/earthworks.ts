/**
 * The ground as a circuit is built on it. Roads (the track and the pit lane)
 * are centrelines with a height and a half width. Around them the ground is
 * shaped: flat under the road and a grass verge, then an embankment (fill,
 * 1 in 2) down to lower ground or a cutting (1 in 1.4) up into higher ground,
 * until the slope meets the natural terrain. Every road segment nearby puts a
 * floor and a ceiling on the ground, so two parts of the track close together
 * share their banks. Under the roads the ground sits a little lower (SINK),
 * so the road surfaces drawn on top in 3D never fight it for the same depth.
 *
 * The 3D view draws this ground; the licence check traces the marshals' sight
 * lines over it (`builtGround`), since a track graded into a hillside is seen
 * along its cutting, not through the hill that was dug away.
 */
import { type Heightmap, sampleHeight } from './heightmap.ts';
import type { PitLane } from './pitLane.ts';
import type { Track } from './track.ts';

export interface Road {
  x: Float64Array;
  y: Float64Array;
  /** Surface height. */
  z: Float64Array;
  /** Half the paved width. */
  half: Float64Array;
  closed: boolean;
}

/** The natural ground: its size, water level, cell size and height anywhere. */
export interface Ground {
  extent: number;
  waterLevel: number;
  cellSize: number;
  height: (x: number, y: number) => number;
}

export function groundOf(hm: Heightmap): Ground {
  return { extent: hm.extent, waterLevel: hm.waterLevel, cellSize: hm.cellSize, height: (x, y) => sampleHeight(hm, x, y) };
}

/** Grass verge beside a road, its crossfall, and the slopes of embankments and cuttings (rise over run). */
export const VERGE = 3;
export const VERGE_FALL = 0.03;
export const FILL_SLOPE = 0.5;
export const CUT_SLOPE = 0.7;
/** The ground under a road and its verge sits this far below the surface. */
export const SINK = 0.3;
/** Banks reach at most this far beyond the verge. */
const MAX_BANK = 60;
const BUCKET = 32;

/** The track as a road. */
export function trackRoad(t: Track): Road {
  const half = new Float64Array(t.n);
  for (let k = 0; k < t.n; k++) half[k] = t.width[k] / 2;
  return { x: t.x, y: t.y, z: t.z, half, closed: true };
}

/**
 * The pit lane as a road, level with the stretch of track it runs beside (or
 * blending between the track at its ends, for a lane across the infield),
 * narrowing where it leaves and rejoins the track.
 */
export function pitRoad(pit: PitLane, t: Track): Road {
  const m = pit.x.length;
  const z = new Float64Array(m);
  const half = new Float64Array(m);
  const ramp = Math.max(1, Math.min(m / 2, 60 / t.ds));
  for (let i = 0; i < m; i++) {
    const f = i / Math.max(1, m - 1);
    z[i] = pit.kind === 'parallel' ? t.z[(pit.entry + i) % t.n] : t.z[pit.entry] * (1 - f) + t.z[pit.exit] * f;
    const r = Math.min(1, Math.min(i, m - 1 - i) / ramp);
    half[i] = (pit.width / 2) * (0.45 + 0.55 * r);
  }
  return { x: pit.x, y: pit.y, z, half, closed: false };
}

/**
 * The ground with earthworks for a set of roads. `height` gives the shaped
 * ground at any point; after a call, `lastBank` holds how far the earthworks
 * moved it there (positive fill, negative cut) and `lastRoad` whether the
 * point lies under a road or its verge.
 */
export class Earthworks {
  /** The natural ground under the earthworks. */
  readonly ground: Ground;
  lastBank = 0;
  lastRoad = false;
  private readonly ax: Float64Array;
  private readonly ay: Float64Array;
  private readonly bx: Float64Array;
  private readonly by: Float64Array;
  private readonly za: Float64Array;
  private readonly zb: Float64Array;
  private readonly ha: Float64Array;
  private readonly hb: Float64Array;
  private readonly reach: Float64Array;
  private readonly nb: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(ground: Heightmap | Ground, roads: readonly Road[]) {
    this.ground = 'data' in ground ? groundOf(ground) : ground;
    const natural = this.ground.height;
    let count = 0;
    for (const r of roads) count += r.closed ? r.x.length : Math.max(0, r.x.length - 1);
    this.ax = new Float64Array(count);
    this.ay = new Float64Array(count);
    this.bx = new Float64Array(count);
    this.by = new Float64Array(count);
    this.za = new Float64Array(count);
    this.zb = new Float64Array(count);
    this.ha = new Float64Array(count);
    this.hb = new Float64Array(count);
    this.reach = new Float64Array(count);
    let s = 0;
    for (const r of roads) {
      const n = r.x.length;
      const segs = r.closed ? n : n - 1;
      for (let i = 0; i < segs; i++, s++) {
        const j = (i + 1) % n;
        this.ax[s] = r.x[i];
        this.ay[s] = r.y[i];
        this.bx[s] = r.x[j];
        this.by[s] = r.y[j];
        this.za[s] = r.z[i];
        this.zb[s] = r.z[j];
        this.ha[s] = r.half[i];
        this.hb[s] = r.half[j];
        // Banks reach further the more the road sits off the ground.
        const off = Math.abs(r.z[i] - natural(r.x[i], r.y[i]));
        this.reach[s] = Math.max(r.half[i], r.half[j]) + VERGE + Math.min(MAX_BANK, 10 + off / FILL_SLOPE);
      }
    }

    // Segments listed per bucket of the map they may affect.
    const nb = Math.max(1, Math.ceil(this.ground.extent / BUCKET));
    this.nb = nb;
    const counts = new Int32Array(nb * nb + 1);
    const each = (fn: (b: number, seg: number) => void) => {
      for (let i = 0; i < count; i++) {
        const r = this.reach[i];
        const i0 = clampInt(Math.floor((Math.min(this.ax[i], this.bx[i]) - r) / BUCKET), 0, nb - 1);
        const i1 = clampInt(Math.floor((Math.max(this.ax[i], this.bx[i]) + r) / BUCKET), 0, nb - 1);
        const j0 = clampInt(Math.floor((Math.min(this.ay[i], this.by[i]) - r) / BUCKET), 0, nb - 1);
        const j1 = clampInt(Math.floor((Math.max(this.ay[i], this.by[i]) + r) / BUCKET), 0, nb - 1);
        for (let bj = j0; bj <= j1; bj++) for (let bi = i0; bi <= i1; bi++) fn(bj * nb + bi, i);
      }
    };
    each((b) => { counts[b + 1]++; });
    for (let b = 0; b < nb * nb; b++) counts[b + 1] += counts[b];
    this.start = counts;
    this.items = new Int32Array(counts[nb * nb]);
    const fill = counts.slice(0, nb * nb);
    each((b, seg) => { this.items[fill[b]++] = seg; });
  }

  /** Natural ground height, ignoring the earthworks. */
  natural(x: number, y: number): number {
    return this.ground.height(x, y);
  }

  /** Distance from a point to the nearest road edge (negative on a road), or Infinity when no road is within its reach. */
  clearance(x: number, y: number): number {
    const bi = Math.floor(x / BUCKET);
    const bj = Math.floor(y / BUCKET);
    if (bi < 0 || bj < 0 || bi >= this.nb || bj >= this.nb) return Infinity;
    const b = bj * this.nb + bi;
    let best = Infinity;
    for (let q = this.start[b]; q < this.start[b + 1]; q++) {
      const s = this.items[q];
      const ax = this.ax[s];
      const ay = this.ay[s];
      const dx = this.bx[s] - ax;
      const dy = this.by[s] - ay;
      const len2 = dx * dx + dy * dy;
      let f = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const d = Math.hypot(x - (ax + dx * f), y - (ay + dy * f)) - (this.ha[s] + (this.hb[s] - this.ha[s]) * f);
      if (d < best) best = d;
    }
    return best;
  }

  height(x: number, y: number): number {
    const g = this.ground.height(x, y);
    this.lastBank = 0;
    this.lastRoad = false;
    const bi = Math.floor(x / BUCKET);
    const bj = Math.floor(y / BUCKET);
    if (bi < 0 || bj < 0 || bi >= this.nb || bj >= this.nb) return g;
    const b = bj * this.nb + bi;
    const from = this.start[b];
    const to = this.start[b + 1];
    if (from === to) return g;
    let lo = -Infinity;
    let hi = Infinity;
    let zoneD = Infinity;
    let zoneZ = 0;
    let edgeGap = Infinity;
    for (let q = from; q < to; q++) {
      const s = this.items[q];
      const ax = this.ax[s];
      const ay = this.ay[s];
      const dx = this.bx[s] - ax;
      const dy = this.by[s] - ay;
      const len2 = dx * dx + dy * dy;
      let f = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const px = x - (ax + dx * f);
      const py = y - (ay + dy * f);
      const d = Math.sqrt(px * px + py * py);
      if (d > this.reach[s]) continue;
      const zc = this.za[s] + (this.zb[s] - this.za[s]) * f;
      const hc = this.ha[s] + (this.hb[s] - this.ha[s]) * f;
      const e = hc + VERGE;
      if (d <= e) {
        if (d < zoneD) {
          zoneD = d;
          zoneZ = zc - VERGE_FALL * Math.max(0, d - hc);
        }
        continue;
      }
      // Beyond the verge: an embankment below, a cutting above.
      const ze = zc - VERGE_FALL * VERGE;
      const run = d - e;
      const floor = ze - FILL_SLOPE * run;
      const ceiling = ze + CUT_SLOPE * run;
      if (floor > lo) lo = floor;
      if (ceiling < hi) hi = ceiling;
      if (run < edgeGap) edgeGap = run;
    }
    if (zoneD < Infinity) {
      this.lastRoad = true;
      this.lastBank = zoneZ - g;
      return zoneZ - SINK;
    }
    if (lo === -Infinity) return g;
    // Two roads at different heights close together cannot both be met: split the difference.
    const shaped = lo > hi ? (lo + hi) / 2 : g < lo ? lo : g > hi ? hi : g;
    this.lastBank = shaped - g;
    // Just beyond the verge the ground eases up from under the road to its bank.
    return shaped - SINK * Math.max(0, 1 - edgeGap / 2);
  }
}

/**
 * The height of the ground as built at any point: the road surface on the
 * track and pit lane (not the ground sunk under them for drawing), the
 * verges, the banks, and the natural ground beyond.
 */
export function builtGround(earth: Earthworks): (x: number, y: number) => number {
  return (x, y) => {
    const z = earth.height(x, y);
    return earth.lastRoad ? z + SINK : z;
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
