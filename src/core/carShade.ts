/**
 * Shading worked out once per car model, from its geometry:
 *
 * - how much of the sky each vertex sees (ambient occlusion): rays from the
 *   vertex over the half space its normal points into, against the car's
 *   own triangles and the road under it. Dark under the wings, in the wheel
 *   arches, round the cockpit and underneath;
 * - the shadow the car lays on the road right under it: its outline seen
 *   from above, darker the lower the car is over the road, with a soft edge.
 *
 * Car coordinates: x forward, y up, z to the right, the road at y = 0.
 */
import type { CarMeshData } from './carMesh.ts';

/** Triangles that block light. */
export interface Occluder {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/** Triangles in a grid of cubes, for casting short rays against them. */
class TriangleGrid {
  /** Nine numbers per triangle. */
  readonly tri: Float32Array;
  private readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  private readonly size: [number, number, number] = [1, 1, 1];
  private readonly cell: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  private readonly stamp: Uint32Array;
  private ray = 0;

  constructor(parts: readonly Occluder[], cell: number) {
    let count = 0;
    for (const p of parts) count += p.indices.length / 3;
    const tri = new Float32Array(count * 9);
    const max = [-Infinity, -Infinity, -Infinity];
    let o = 0;
    for (const p of parts) {
      for (let i = 0; i < p.indices.length; i++) {
        for (let k = 0; k < 3; k++) {
          const v = p.positions[p.indices[i] * 3 + k];
          tri[o++] = v;
          if (v < this.min[k]) this.min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
    }
    this.tri = tri;
    if (!count) this.min = [0, 0, 0];
    // No more than 96 cubes a side: a longer car gets bigger ones.
    this.cell = Math.max(cell, ...[0, 1, 2].map((k) => (count ? (max[k] - this.min[k]) / 96 : 0)));
    for (let k = 0; k < 3; k++) {
      this.min[k] -= this.cell * 0.5;
      this.size[k] = count ? Math.max(1, Math.ceil((max[k] - this.min[k]) / this.cell + 0.5)) : 1;
    }
    const [nx, ny, nz] = this.size;
    const cells = nx * ny * nz;
    const span = (t: number): [number, number, number, number, number, number] => {
      const b: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const lo = Math.min(tri[t * 9 + k], tri[t * 9 + 3 + k], tri[t * 9 + 6 + k]);
        const hi = Math.max(tri[t * 9 + k], tri[t * 9 + 3 + k], tri[t * 9 + 6 + k]);
        b[k] = Math.max(0, Math.min(this.size[k] - 1, Math.floor((lo - this.min[k]) / this.cell)));
        b[k + 3] = Math.max(0, Math.min(this.size[k] - 1, Math.floor((hi - this.min[k]) / this.cell)));
      }
      return b;
    };
    // Count, then fill: every cube lists the triangles whose box reaches it.
    const counts = new Uint32Array(cells + 1);
    const each = (fn: (cell: number, t: number) => void) => {
      for (let t = 0; t < count; t++) {
        const b = span(t);
        for (let i = b[0]; i <= b[3]; i++) for (let j = b[1]; j <= b[4]; j++) for (let k = b[2]; k <= b[5]; k++) fn((i * ny + j) * nz + k, t);
      }
    };
    each((c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.start = counts;
    this.items = new Uint32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    each((c, t) => {
      this.items[fill[c]++] = t;
    });
    this.stamp = new Uint32Array(count);
  }

  /** How far along the ray (a unit direction) the first triangle found lies, or Infinity when none within `reach`. */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number): number {
    const tri = this.tri;
    if (!tri.length) return Infinity;
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];
    // Into the grid's box.
    let t0 = 0;
    let t1 = reach;
    for (let k = 0; k < 3; k++) {
      const lo = this.min[k];
      const hi = lo + this.size[k] * this.cell;
      if (Math.abs(d[k]) < 1e-12) {
        if (o[k] < lo || o[k] > hi) return Infinity;
        continue;
      }
      let a = (lo - o[k]) / d[k];
      let b = (hi - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return Infinity;
    }
    const id = ++this.ray;
    const pos = [0, 0, 0];
    const step = [0, 0, 0];
    const next = [0, 0, 0];
    const delta = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p = o[k] + d[k] * (t0 + 1e-6);
      pos[k] = Math.max(0, Math.min(this.size[k] - 1, Math.floor((p - this.min[k]) / this.cell)));
      step[k] = d[k] > 0 ? 1 : -1;
      const edge = this.min[k] + (pos[k] + (d[k] > 0 ? 1 : 0)) * this.cell;
      next[k] = Math.abs(d[k]) < 1e-12 ? Infinity : (edge - o[k]) / d[k];
      delta[k] = Math.abs(d[k]) < 1e-12 ? Infinity : this.cell / Math.abs(d[k]);
    }
    const ny = this.size[1];
    const nz = this.size[2];
    // The nearest hit so far: a triangle is tried once, in the first cube that lists it, and may be hit beyond that cube.
    let best = Infinity;
    for (;;) {
      const c = (pos[0] * ny + pos[1]) * nz + pos[2];
      const leave = Math.min(next[0], next[1], next[2]);
      for (let i = this.start[c]; i < this.start[c + 1]; i++) {
        const t = this.items[i];
        if (this.stamp[t] === id) continue;
        this.stamp[t] = id;
        const q = t * 9;
        // Moller-Trumbore, both faces.
        const e1x = tri[q + 3] - tri[q], e1y = tri[q + 4] - tri[q + 1], e1z = tri[q + 5] - tri[q + 2];
        const e2x = tri[q + 6] - tri[q], e2y = tri[q + 7] - tri[q + 1], e2z = tri[q + 8] - tri[q + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tri[q], sy = oy - tri[q + 1], sz = oz - tri[q + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t2 = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t2 > 1e-5 && t2 < best) best = t2;
      }
      if (best <= leave + 1e-6 || leave > t1) return best <= reach ? best : Infinity;
      const k = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
      pos[k] += step[k];
      if (pos[k] < 0 || pos[k] >= this.size[k]) return best <= reach ? best : Infinity;
      next[k] += delta[k];
    }
  }
}

/** Unit directions over the half space round +z, more of them near it (weighted by the cosine), the same every time. */
function hemisphere(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const a = i * golden;
    out[i * 3] = r * Math.cos(a);
    out[i * 3 + 1] = r * Math.sin(a);
    out[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - r * r));
  }
  return out;
}

/** How much the road counts for, against a part of the car as near. */
const ROAD_SHARE = 0.5;

export interface BakeOptions {
  /** Things further away than this block no light (metres). */
  reach?: number;
  rays?: number;
  /** The rays start this far off the surface. */
  bias?: number;
  /** Height of the road, which blocks light too; null for a part that turns (a wheel). */
  ground?: number | null;
}

/**
 * Bakes ambient occlusion into `mesh.ao`: per vertex the share of the half
 * space over it that is open, 1 with nothing near and 0 shut in. Something
 * close blocks more than something at the end of the reach.
 */
export function bakeOcclusion(mesh: CarMeshData, occluders: readonly Occluder[], o: BakeOptions = {}): void {
  const reach = o.reach ?? 0.45;
  const rays = o.rays ?? 24;
  const bias = o.bias ?? 0.012;
  const ground = o.ground === undefined ? 0 : o.ground;
  const grid = new TriangleGrid(occluders, Math.max(0.04, reach / 7));
  const dirs = hemisphere(rays);
  const p = mesh.positions;
  const n = mesh.normals;
  for (let i = 0; i < mesh.ao.length; i++) {
    const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
    // Two directions across the normal.
    const hx = Math.abs(ny) < 0.9 ? 0 : 1;
    const hy = Math.abs(ny) < 0.9 ? 1 : 0;
    let ax = ny * 0 - nz * hy, ay = nz * hx - nx * 0, az = nx * hy - ny * hx;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
    const ox = p[i * 3] + nx * bias, oy = p[i * 3 + 1] + ny * bias, oz = p[i * 3 + 2] + nz * bias;
    let shut = 0;
    for (let r = 0; r < rays; r++) {
      const u = dirs[r * 3], v = dirs[r * 3 + 1], w = dirs[r * 3 + 2];
      const dx = ax * u + bx * v + nx * w, dy = ay * u + by * v + ny * w, dz = az * u + bz * v + nz * w;
      const t = grid.cast(ox, oy, oz, dx, dy, dz, reach);
      // The road blocks the sky too, but it is lit itself and throws light back up: it counts for half.
      const tg = ground !== null && dy < -1e-6 ? Math.max(0, (ground - oy) / dy) : Infinity;
      if (t < reach && t <= tg) shut += 1 - (t / reach) ** 2;
      else if (tg < reach) shut += ROAD_SHARE * (1 - (tg / reach) ** 2);
    }
    mesh.ao[i] = Math.max(0, 1 - shut / rays);
  }
}

/**
 * Gives `to` the occlusion baked into `from`, the same model at another
 * level of detail: each vertex takes that of the nearest vertex facing much
 * the same way (within `reach`; otherwise it stays as it is).
 */
export function transferOcclusion(from: CarMeshData, to: CarMeshData, reach = 0.15): void {
  const cell = reach;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const buckets = new Map<string, number[]>();
  const fp = from.positions;
  for (let i = 0; i < from.ao.length; i++) {
    const k = key(fp[i * 3], fp[i * 3 + 1], fp[i * 3 + 2]);
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }
  const tp = to.positions;
  for (let i = 0; i < to.ao.length; i++) {
    const x = tp[i * 3], y = tp[i * 3 + 1], z = tp[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1;
    let bestD = reach * reach;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = buckets.get(`${cx + a},${cy + b},${cz + c}`);
      if (!list) continue;
      for (const j of list) {
        const facing = from.normals[j * 3] * to.normals[i * 3] + from.normals[j * 3 + 1] * to.normals[i * 3 + 1] + from.normals[j * 3 + 2] * to.normals[i * 3 + 2];
        // A vertex facing another way counts as further off, so that the two faces of a thin plate keep apart.
        const d = (fp[j * 3] - x) ** 2 + (fp[j * 3 + 1] - y) ** 2 + (fp[j * 3 + 2] - z) ** 2 + (facing > 0.5 ? 0 : reach * reach * 0.5);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
    }
    if (best >= 0) to.ao[i] = from.ao[best];
  }
}

/** The shadow right under a car: a grid over the road, a darkness per cell. */
export interface GroundShadow {
  /** Cells along the car (x) and across it (z). */
  nx: number;
  nz: number;
  /** The grid's corner with the lowest x and z, and the size of a cell (metres). */
  x0: number;
  z0: number;
  cell: number;
  /** Darkness per cell, 0 to 255: row by row along x, each row running across the car. */
  data: Uint8Array;
}

/** A car lays no shadow from parts higher than this over the road (metres), and the grid reaches this far beyond the car. */
const SHADOW_HEIGHT = 0.75;
const SHADOW_MARGIN = 0.48;

function boxBlur(src: Float32Array, nx: number, nz: number, radius: number): Float32Array {
  const pass = (a: Float32Array, along: boolean) => {
    const out = new Float32Array(a.length);
    const n = along ? nx : nz;
    const m = along ? nz : nx;
    for (let j = 0; j < m; j++) {
      let sum = 0;
      const at = (i: number) => a[along ? i * nz + j : j * nz + i];
      for (let i = -radius; i <= radius; i++) if (i >= 0 && i < n) sum += at(i);
      for (let i = 0; i < n; i++) {
        out[along ? i * nz + j : j * nz + i] = sum / (2 * radius + 1);
        if (i - radius >= 0) sum -= at(i - radius);
        if (i + radius + 1 < n) sum += at(i + radius + 1);
      }
    }
    return out;
  };
  // Twice over: a soft edge without corners.
  return pass(pass(pass(pass(src, true), false), true), false);
}

/**
 * The shadow under a car from its parts (the body, and the wheels where they
 * stand): seen from above, each cell as dark as the lowest thing over it is
 * low, blurred to a soft edge that is tight under the tyres and the floor
 * and wide round the whole car.
 */
export function groundShadow(parts: readonly Occluder[], cell = 0.04): GroundShadow {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) {
      if (p.positions[i + 1] > SHADOW_HEIGHT) continue;
      x0 = Math.min(x0, p.positions[i]);
      x1 = Math.max(x1, p.positions[i]);
      z0 = Math.min(z0, p.positions[i + 2]);
      z1 = Math.max(z1, p.positions[i + 2]);
    }
  }
  if (!(x1 > x0)) return { nx: 1, nz: 1, x0: 0, z0: 0, cell, data: new Uint8Array(1) };
  x0 -= SHADOW_MARGIN;
  z0 -= SHADOW_MARGIN;
  const nx = Math.ceil((x1 + SHADOW_MARGIN - x0) / cell);
  const nz = Math.ceil((z1 + SHADOW_MARGIN - z0) / cell);
  const low = new Float32Array(nx * nz).fill(Infinity);
  for (const p of parts) {
    const pos = p.positions;
    for (let t = 0; t < p.indices.length; t += 3) {
      const a = p.indices[t] * 3, b = p.indices[t + 1] * 3, c = p.indices[t + 2] * 3;
      if (Math.min(pos[a + 1], pos[b + 1], pos[c + 1]) > SHADOW_HEIGHT) continue;
      const ax = pos[a], az = pos[a + 2], bx = pos[b], bz = pos[b + 2], cx = pos[c], cz = pos[c + 2];
      const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(area) < 1e-10) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell));
      const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / cell));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const x = x0 + (i + 0.5) * cell;
          const z = z0 + (j + 0.5) * cell;
          const wb = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / area;
          const wc = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / area;
          if (wb < -0.02 || wc < -0.02 || wb + wc > 1.02) continue;
          const y = Math.max(0, pos[a + 1] + (pos[b + 1] - pos[a + 1]) * wb + (pos[c + 1] - pos[a + 1]) * wc);
          if (y < low[i * nz + j]) low[i * nz + j] = y;
        }
      }
    }
  }
  const dark = new Float32Array(nx * nz);
  for (let i = 0; i < dark.length; i++) dark[i] = low[i] < SHADOW_HEIGHT ? (1 - low[i] / SHADOW_HEIGHT) ** 1.5 : 0;
  const tight = boxBlur(dark, nx, nz, Math.max(1, Math.round(0.05 / cell)));
  const wide = boxBlur(dark, nx, nz, Math.max(2, Math.round(0.16 / cell)));
  const data = new Uint8Array(nx * nz);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(255 * Math.min(1, 0.55 * tight[i] + 0.45 * wide[i]));
  return { nx, nz, x0, z0, cell, data };
}
