/**
 * Geometry for the 3D view: the terrain with the earthworks the track needs
 * (core/earthworks.ts), the track and pit lane surfaces, and the sides of the
 * map as a model base.
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
import { Earthworks, type Road, SINK, VERGE, VERGE_FALL } from './earthworks.ts';
import type { Heightmap } from './heightmap.ts';
import type { Track } from './track.ts';

export { CUT_SLOPE, Earthworks, FILL_SLOPE, type Ground, type Road, SINK, VERGE, groundOf, pitRoad, trackRoad } from './earthworks.ts';

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** rgb per vertex (sRGB, 0..1), when the mesh carries colours. */
  colors?: Float32Array;
  /**
   * Per vertex, for things of a real size (buildings, kerbs): the height the
   * vertex stands on, so it keeps its real height above it when the view
   * exaggerates the relief (see `anchoredHeight`). A vertex at its anchor moves
   * with the ground. Absent: the whole mesh is part of the landscape.
   */
  anchors?: Float32Array;
}

/**
 * The height to give a vertex in a model whose relief is drawn `relief` times
 * as tall, so that it stays `y - anchor` metres above its (exaggerated) anchor.
 */
export function anchoredHeight(y: number, anchor: number, relief: number): number {
  return anchor + (y - anchor) / relief;
}

/** A face corner: x, height, z, and optionally the floor it stands on (see `MeshBuilder.face`). */
export type FaceCorner = readonly [number, number, number, number?];

export interface TerrainMesh extends MeshData {
  /** Per vertex: how far the earthworks moved the ground (positive fill, negative cut), metres. */
  bank: Float32Array;
  /** Finest cell size used, metres. */
  finest: number;
}

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
  const hm = earth.ground;
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
  private anc: number[] = [];
  private anchored = false;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** A vertex; with an anchor it keeps its real height above that (see `MeshData.anchors`). */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: readonly number[], anchor = y): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(color[0], color[1], color[2]);
    this.anc.push(anchor);
    if (anchor !== y) this.anchored = true;
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
   * A corner with a floor keeps its real height above that floor; corners
   * below their floor (foundations reaching into the ground) move with it.
   */
  face(corners: readonly FaceCorner[], normal: readonly [number, number, number], color: readonly number[]): void {
    const [a, b, c] = corners;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const along = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
    const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const first = this.vertexCount;
    for (const p of corners) this.vertex(p[0], p[1], p[2], normal[0] / len, normal[1] / len, normal[2] / len, color, p[3] === undefined ? p[1] : Math.min(p[1], p[3]));
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
      ...(this.anchored ? { anchors: Float32Array.from(this.anc) } : {}),
    };
  }
}

