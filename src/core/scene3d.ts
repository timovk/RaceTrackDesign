/**
 * Geometry for the 3D view: the terrain with the earthworks the track needs,
 * the track and pit lane surfaces, and the sides of the map as a model base.
 *
 * Roads (the track and the pit lane) are centrelines with a height and a half
 * width. Around them the ground is shaped as a circuit is built: flat under
 * the road and a grass verge, then an embankment (fill, 1 in 2) down to lower
 * ground or a cutting (1 in 1.4) up into higher ground, until the slope meets
 * the natural terrain. Every road segment nearby puts a floor and a ceiling on
 * the ground, so two parts of the track close together share their banks.
 * Under the roads the ground sits a little lower, so the road surfaces drawn
 * on top never fight it for the same depth.
 *
 * The terrain is a quadtree of square patches, 32 cells each, finer near the
 * roads (down to 2 m) and coarser away from them (up to 1/256 of the map).
 * Patches of different detail meet with small cracks, which skirts hanging
 * down from every patch edge hide.
 *
 * Output is in scene coordinates: x east, y up, z south, in metres, with
 * heights in metres above sea level. Triangles wind anticlockwise seen from
 * outside (upwards for surfaces).
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

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** rgb per vertex (sRGB, 0..1), when the mesh carries colours. */
  colors?: Float32Array;
}

export interface TerrainMesh extends MeshData {
  /** Per vertex: how far the earthworks moved the ground (positive fill, negative cut), metres. */
  bank: Float32Array;
  /** Finest cell size used, metres. */
  finest: number;
}

/** Grass verge beside a road, its crossfall, and the slopes of embankments and cuttings (rise over run). */
export const VERGE = 3;
const VERGE_FALL = 0.03;
export const FILL_SLOPE = 0.5;
export const CUT_SLOPE = 0.7;
/** The ground under a road and its verge sits this far below the surface. */
export const SINK = 0.3;
/** Banks reach at most this far beyond the verge. */
const MAX_BANK = 60;
const BUCKET = 32;
const LEAF = 32;
export const MIN_CELL = 2;
/** A patch is split while the nearest road is closer than this share of its size: 2 m cells within about 40 m of a road, 4 m within 80 m and so on. */
const DETAIL_REACH = 0.32;

export const COLORS = {
  asphalt: [0.23, 0.245, 0.27],
  pitAsphalt: [0.33, 0.34, 0.36],
  line: [0.93, 0.93, 0.9],
  verge: [0.38, 0.55, 0.26],
  soilTop: [0.45, 0.35, 0.25],
  soilBottom: [0.25, 0.19, 0.14],
  waterSide: [0.16, 0.36, 0.55],
} as const;

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
  readonly hm: Heightmap;
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

  constructor(hm: Heightmap, roads: readonly Road[]) {
    this.hm = hm;
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
        const off = Math.abs(r.z[i] - sampleHeight(hm, r.x[i], r.y[i]));
        this.reach[s] = Math.max(r.half[i], r.half[j]) + VERGE + Math.min(MAX_BANK, 10 + off / FILL_SLOPE);
      }
    }

    // Segments listed per bucket of the map they may affect.
    const nb = Math.max(1, Math.ceil(hm.extent / BUCKET));
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
    return sampleHeight(this.hm, x, y);
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
    const g = sampleHeight(this.hm, x, y);
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

// ---- terrain -----------------------------------------------------------------

export interface Leaf {
  x0: number;
  y0: number;
  size: number;
  /** Cells per side. */
  cells: number;
}

/** Road points every few metres, for deciding where the terrain needs detail. */
function roadSamples(roads: readonly Road[]): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const r of roads) {
    const step = Math.max(1, Math.floor(r.x.length / 2000));
    for (let i = 0; i < r.x.length; i += step) {
      x.push(r.x[i]);
      y.push(r.y[i]);
    }
  }
  return { x, y };
}

/** The quadtree leaves: patches of LEAF cells, down to MIN_CELL near the roads. */
export function terrainLeaves(hm: Heightmap, roads: readonly Road[]): Leaf[] {
  const extent = hm.extent;
  const rootCell = Math.max(hm.cellSize, extent / 256);
  const rootSize = rootCell * LEAF;
  const roots = Math.max(1, Math.round(extent / rootSize));
  const pts = roadSamples(roads);
  const distance = (x0: number, y0: number, size: number) => {
    let best = Infinity;
    for (let i = 0; i < pts.x.length; i++) {
      const dx = Math.max(x0 - pts.x[i], 0, pts.x[i] - (x0 + size));
      const dy = Math.max(y0 - pts.y[i], 0, pts.y[i] - (y0 + size));
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const out: Leaf[] = [];
  const visit = (x0: number, y0: number, size: number, split: boolean) => {
    const cell = size / LEAF;
    const d = distance(x0, y0, size);
    if (cell / 2 >= MIN_CELL - 1e-9 && d < size * DETAIL_REACH) {
      const half = size / 2;
      visit(x0, y0, half, true);
      visit(x0 + half, y0, half, true);
      visit(x0, y0 + half, half, true);
      visit(x0 + half, y0 + half, half, true);
      return;
    }
    // Of the four parts of a patch split for a nearby road, those not near it themselves keep the coarser detail.
    const cells = split && d >= 2 * size * DETAIL_REACH ? LEAF / 2 : LEAF;
    out.push({ x0, y0, size, cells });
  };
  const size = extent / roots;
  for (let j = 0; j < roots; j++) for (let i = 0; i < roots; i++) visit(i * size, j * size, size, false);
  return out;
}

/** The terrain surface with earthworks, as one mesh of patches with skirts. */
export function buildTerrain(hm: Heightmap, roads: readonly Road[], earth: Earthworks = new Earthworks(hm, roads)): TerrainMesh {
  const leaves = terrainLeaves(hm, roads);
  let vertexCount = 0;
  let indexCount = 0;
  for (const leaf of leaves) {
    vertexCount += (leaf.cells + 1) ** 2 + 4 * leaf.cells;
    indexCount += (leaf.cells * leaf.cells + 4 * leaf.cells) * 6;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const bank = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  const H = new Float64Array((LEAF + 3) ** 2);
  const B = new Float32Array((LEAF + 3) ** 2);
  let finest = Infinity;
  let v = 0;
  let t = 0;
  for (const leaf of leaves) {
    const C = leaf.cells;
    const V = C + 1;
    const G = C + 3;
    const cell = leaf.size / C;
    finest = Math.min(finest, cell);
    // Heights with a one-cell border, so normals at the edges match the neighbours.
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const x = leaf.x0 + (i - 1) * cell;
        const y = leaf.y0 + (j - 1) * cell;
        H[j * G + i] = earth.height(x, y);
        B[j * G + i] = earth.lastRoad ? 0 : earth.lastBank;
      }
    }
    const base = v;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = (j + 1) * G + (i + 1);
        const o = v * 3;
        positions[o] = leaf.x0 + i * cell;
        positions[o + 1] = H[k];
        positions[o + 2] = leaf.y0 + j * cell;
        const nx = -(H[k + 1] - H[k - 1]) / (2 * cell);
        const nz = -(H[k + G] - H[k - G]) / (2 * cell);
        const len = Math.sqrt(nx * nx + 1 + nz * nz);
        normals[o] = nx / len;
        normals[o + 1] = 1 / len;
        normals[o + 2] = nz / len;
        bank[v] = B[k];
        v++;
      }
    }
    for (let j = 0; j < C; j++) {
      for (let i = 0; i < C; i++) {
        const a = base + j * V + i;
        const b = a + 1;
        const c = a + V;
        const d = c + 1;
        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;
        indices[t++] = b;
        indices[t++] = c;
        indices[t++] = d;
      }
    }
    // Skirts: the perimeter again, hanging down, joined to the edge.
    const depth = 2 * cell + 1;
    const ring: number[] = [];
    for (let i = 0; i < C; i++) ring.push(base + i);
    for (let j = 0; j < C; j++) ring.push(base + j * V + C);
    for (let i = C; i > 0; i--) ring.push(base + C * V + i);
    for (let j = C; j > 0; j--) ring.push(base + j * V);
    const skirtBase = v;
    for (const e of ring) {
      const o = v * 3;
      positions[o] = positions[e * 3];
      positions[o + 1] = positions[e * 3 + 1] - depth;
      positions[o + 2] = positions[e * 3 + 2];
      normals[o] = normals[e * 3];
      normals[o + 1] = normals[e * 3 + 1];
      normals[o + 2] = normals[e * 3 + 2];
      bank[v] = bank[e];
      v++;
    }
    // The ring runs east along the north edge, then south, west and north: these faces look outwards.
    for (let r = 0; r < ring.length; r++) {
      const a = ring[r];
      const b = ring[(r + 1) % ring.length];
      const as = skirtBase + r;
      const bs = skirtBase + ((r + 1) % ring.length);
      indices[t++] = a;
      indices[t++] = b;
      indices[t++] = as;
      indices[t++] = b;
      indices[t++] = bs;
      indices[t++] = as;
    }
  }
  return { positions, normals, indices, bank, finest };
}

// ---- roads -------------------------------------------------------------------

export interface RoadStyle {
  /** Paved surface colour per point (rgb triples), or one colour for all. */
  surface: Float32Array | readonly number[];
  /** White edge lines. */
  lines: boolean;
}

/** A strip across a road, from offset `a` to `b` (metres left of the centreline) and heights relative to the surface. */
interface Strip {
  a: number;
  b: number;
  za: number;
  zb: number;
  color: 'surface' | readonly number[];
}

/**
 * Paved surfaces (with edge lines) and verges for roads, as two meshes: the
 * verges include a short skirt at their outer edge, down into the ground.
 */
export function buildRoads(roads: readonly { road: Road; style: RoadStyle }[]): { paved: MeshData; verges: MeshData } {
  const paved = new MeshBuilder();
  const verges = new MeshBuilder();
  for (const { road, style } of roads) {
    const n = road.x.length;
    const segs = road.closed ? n : n - 1;
    const tangent = (i: number) => {
      const p = road.closed ? (i - 1 + n) % n : Math.max(0, i - 1);
      const q = road.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const dx = road.x[q] - road.x[p];
      const dy = road.y[q] - road.y[p];
      const len = Math.hypot(dx, dy) || 1;
      const dz = road.z[q] - road.z[p];
      return { tx: dx / len, ty: dy / len, g: dz / len };
    };
    const at = (i: number) => {
      const { tx, ty, g } = tangent(i);
      // Left of the direction of travel (y points south), and the surface normal up the slope.
      const lx = ty;
      const ly = -tx;
      const nlen = Math.sqrt(g * g + 1);
      return { lx, ly, nx: -g * tx / nlen, ny: 1 / nlen, nz: -g * ty / nlen };
    };
    const surfaceColor = (i: number): readonly number[] => {
      const s = style.surface;
      return s.length === 3 ? (s as readonly number[]) : [s[i * 3], s[i * 3 + 1], s[i * 3 + 2]];
    };
    const addStrips = (mesh: MeshBuilder, strips: (i: number) => Strip[]) => {
      const count = strips(0).length;
      const firstRow = mesh.vertexCount;
      for (let i = 0; i < n; i++) {
        const f = at(i);
        for (const s of strips(i)) {
          const color = s.color === 'surface' ? surfaceColor(i) : s.color;
          for (const [off, dz] of [[s.a, s.za], [s.b, s.zb]] as const) {
            mesh.vertex(road.x[i] + f.lx * off, road.z[i] + dz, road.y[i] + f.ly * off, f.nx, f.ny, f.nz, color);
          }
        }
      }
      const row = count * 2;
      for (let i = 0; i < segs; i++) {
        const p = firstRow + i * row;
        const q = firstRow + ((i + 1) % n) * row;
        for (let s = 0; s < count; s++) {
          // Offsets run from left to right, so a strip's first vertex is on its left.
          const a = p + s * 2;
          const b = a + 1;
          const c = q + s * 2;
          const d = c + 1;
          mesh.quad(a, b, c, d);
        }
      }
    };
    const line = style.lines ? 0.25 : 0;
    const inset = style.lines ? 0.3 : 0;
    addStrips(paved, (i) => {
      const h = road.half[i];
      if (!style.lines) return [{ a: h, b: -h, za: 0, zb: 0, color: 'surface' }];
      return [
        { a: h, b: h - inset, za: 0, zb: 0, color: COLORS.asphalt },
        { a: h - inset, b: h - inset - line, za: 0, zb: 0, color: COLORS.line },
        { a: h - inset - line, b: -(h - inset - line), za: 0, zb: 0, color: 'surface' },
        { a: -(h - inset - line), b: -(h - inset), za: 0, zb: 0, color: COLORS.line },
        { a: -(h - inset), b: -h, za: 0, zb: 0, color: COLORS.asphalt },
      ];
    });
    const fall = -VERGE_FALL * VERGE;
    const skirt = fall - SINK - 0.6;
    addStrips(verges, (i) => {
      const h = road.half[i];
      return [
        { a: h + VERGE, b: h + VERGE, za: skirt, zb: fall, color: COLORS.verge },
        { a: h + VERGE, b: h, za: fall, zb: 0, color: COLORS.verge },
        { a: -h, b: -h - VERGE, za: 0, zb: fall, color: COLORS.verge },
        { a: -h - VERGE, b: -h - VERGE, za: fall, zb: skirt, color: COLORS.verge },
      ];
    });
  }
  return { paved: paved.build(), verges: verges.build() };
}

/** A white line across the track at the start/finish. */
export function startLine(t: Track): MeshData {
  const mesh = new MeshBuilder();
  const k = 0;
  const hx = Math.cos(t.heading[k]);
  const hy = Math.sin(t.heading[k]);
  const lx = hy;
  const ly = -hx;
  const half = t.width[k] / 2;
  const along = 0.5;
  const z = t.z[k] + 0.02;
  for (const [s, o] of [[-along, half], [-along, -half], [along, half], [along, -half]] as const) {
    mesh.vertex(t.x[k] + hx * s + lx * o, z, t.y[k] + hy * s + ly * o, 0, 1, 0, COLORS.line);
  }
  mesh.quad(0, 1, 2, 3);
  return mesh.build();
}

// ---- the model base ------------------------------------------------------------

/**
 * The sides of the map, as on a model: soil from the base up to the ground
 * along each edge, and water up to the water level where the edge lies under
 * water. `base` is the height of the bottom.
 */
export function buildSides(earth: Earthworks, base: number): MeshData {
  const hm = earth.hm;
  const mesh = new MeshBuilder();
  const e = hm.extent;
  const steps = Math.max(8, Math.round(e / Math.max(hm.cellSize, 8)));
  // Corners in order, each side with its outward normal (clockwise seen from above).
  const sides: [number, number, number, number, number, number][] = [
    [0, 0, e, 0, 0, -1],
    [e, 0, e, e, 1, 0],
    [e, e, 0, e, 0, 1],
    [0, e, 0, 0, -1, 0],
  ];
  const water = hm.waterLevel;
  for (const [x0, y0, x1, y1, nx, ny] of sides) {
    for (let i = 0; i < steps; i++) {
      const pa = { x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps };
      const pb = { x: x0 + ((x1 - x0) * (i + 1)) / steps, y: y0 + ((y1 - y0) * (i + 1)) / steps };
      const ha = earth.height(clampEdge(pa.x, e), clampEdge(pa.y, e));
      const hb = earth.height(clampEdge(pb.x, e), clampEdge(pb.y, e));
      const panel = (za0: number, za1: number, zb0: number, zb1: number, c0: readonly number[], c1: readonly number[]) => {
        const a = mesh.vertex(pa.x, za0, pa.y, nx, 0, ny, c0);
        mesh.vertex(pa.x, za1, pa.y, nx, 0, ny, c1);
        mesh.vertex(pb.x, zb0, pb.y, nx, 0, ny, c0);
        mesh.vertex(pb.x, zb1, pb.y, nx, 0, ny, c1);
        // Bottom and top at pa, then at pb; seen from outside, pa is on the right.
        mesh.tri(a, a + 1, a + 2);
        mesh.tri(a + 1, a + 3, a + 2);
      };
      panel(base, ha, base, hb, COLORS.soilBottom, COLORS.soilTop);
      if (water > ha || water > hb) panel(Math.min(ha, water), water, Math.min(hb, water), water, COLORS.waterSide, COLORS.waterSide);
    }
  }
  return mesh.build();
}

function clampEdge(v: number, e: number): number {
  return Math.min(e - 1e-6, Math.max(1e-6, v));
}

// ---- helpers -------------------------------------------------------------------

/** Grows vertex and index lists for a mesh with colours. */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: readonly number[]): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(color[0], color[1], color[2]);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /**
   * A quad from a row (a left, b right) to the next row (c left, d right),
   * the rows running in the direction of travel.
   */
  quad(a: number, b: number, c: number, d: number): void {
    // Left to right across, then forward: anticlockwise seen from above (y up, z south).
    this.idx.push(a, b, c, b, d, c);
  }

  /**
   * A flat face with one colour, from corners in order around it, turned so
   * that it faces along `normal` (its own vertices, so edges stay sharp).
   */
  face(corners: readonly (readonly [number, number, number])[], normal: readonly [number, number, number], color: readonly number[]): void {
    const [a, b, c] = corners;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const along = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
    const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const first = this.vertexCount;
    for (const p of corners) this.vertex(p[0], p[1], p[2], normal[0] / len, normal[1] / len, normal[2] / len, color);
    for (let i = 1; i + 1 < corners.length; i++) {
      if (along >= 0) this.tri(first, first + i, first + i + 1);
      else this.tri(first, first + i + 1, first + i);
    }
  }

  build(): MeshData {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nrm),
      colors: Float32Array.from(this.col),
      indices: Uint32Array.from(this.idx),
    };
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
