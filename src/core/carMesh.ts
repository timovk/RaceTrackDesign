/**
 * Geometry toolkit for the 3D cars: a mesh builder carrying the car
 * material's attributes, cross-section paths, lofts (smooth bodies swept
 * along the car), airfoils, plates, tubes, surfaces of revolution and
 * decal patches.
 *
 * Car coordinates: x forward, y up, z to the right, in metres, with the
 * origin on the ground midway between the axles.
 *
 * Every vertex says how it is coloured (its zone): trim parts carry their
 * own colour and finish (roughness, metalness, clearcoat, glow); painted
 * parts take the team livery in the shader, from the vertex's livery
 * coordinates (u along the car, 0 at the rear and 1 at the front; v around
 * the body, 0 at the bottom, 0.25 on the right, 0.5 on top, 0.75 on the left).
 */

export type V3 = [number, number, number];

/** How a vertex is coloured: its own colour (trim), the per-car tint (tyre compound), or the livery. */
export const ZONE = {
  trim: -1,
  tint: -2,
  /** The livery pattern of the main body. */
  body: 0,
  /** The livery pattern of the side bodywork (sidepods, rider's leathers). */
  side: 1,
  /** Flat livery colours: main, second, accent. */
  solidA: 2,
  solidB: 3,
  solidC: 4,
} as const;

export interface Finish {
  roughness: number;
  metalness: number;
  clearcoat: number;
  /** Glow, as a multiple of the colour (lights). */
  emissive: number;
}

export interface Surface {
  zone: number;
  /** Linear rgb, for trim and as a multiplier on the livery. */
  color: readonly number[];
  finish: Finish;
}

const WHITE = [1, 1, 1];
export const PAINT: Finish = { roughness: 0.32, metalness: 0.15, clearcoat: 1, emissive: 0 };

export function paint(zone: number = ZONE.body): Surface {
  return { zone, color: WHITE, finish: PAINT };
}

export function trim(color: readonly number[], finish: Partial<Finish> = {}): Surface {
  return { zone: ZONE.trim, color, finish: { roughness: 0.5, metalness: 0, clearcoat: 0, emissive: 0, ...finish } };
}

export const CARBON = trim([0.016, 0.017, 0.019], { roughness: 0.72, clearcoat: 0.12 });
export const SATIN_BLACK = trim([0.012, 0.012, 0.014], { roughness: 0.55 });
export const RUBBER = trim([0.018, 0.018, 0.019], { roughness: 0.92 });
export const METAL = trim([0.55, 0.56, 0.58], { roughness: 0.28, metalness: 1 });
export const DARK_METAL = trim([0.12, 0.125, 0.13], { roughness: 0.35, metalness: 1 });
export const GLASS = trim([0.012, 0.016, 0.02], { roughness: 0.04, clearcoat: 1 });
export const TINT: Surface = { zone: ZONE.tint, color: WHITE, finish: { roughness: 0.7, metalness: 0, clearcoat: 0, emissive: 0 } };

export interface CarMeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Livery coordinates, or decal coordinates in a decal mesh. */
  uvs: Float32Array;
  colors: Float32Array;
  /** Per vertex: roughness, metalness, clearcoat, glow. */
  finish: Float32Array;
  zone: Float32Array;
  /** Per vertex: the hinge (x, y) it turns about when the DRS flap opens, and 1 on the flap (0 elsewhere). */
  hinge: Float32Array;
  indices: Uint32Array;
}

export class CarMeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private fin: number[] = [];
  private zon: number[] = [];
  private hin: number[] = [];
  private idx: number[] = [];
  /** Vertices added from now on turn with the DRS flap about this hinge (x, y), when set. */
  flapHinge: [number, number] | null = null;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vertex(p: readonly number[], n: readonly number[], uv: readonly number[], s: Surface): number {
    this.pos.push(p[0], p[1], p[2]);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    this.nrm.push(n[0] / len, n[1] / len, n[2] / len);
    this.uv.push(uv[0], uv[1]);
    this.col.push(s.color[0], s.color[1], s.color[2]);
    this.fin.push(s.finish.roughness, s.finish.metalness, s.finish.clearcoat, s.finish.emissive);
    this.zon.push(s.zone);
    const h = this.flapHinge;
    this.hin.push(h ? h[0] : 0, h ? h[1] : 0, h ? 1 : 0);
    return this.pos.length / 3 - 1;
  }

  /** A triangle, wound to face the way its vertex normals point. */
  tri(a: number, b: number, c: number): void {
    const p = this.pos;
    const n = this.nrm;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const sx = n[a * 3] + n[b * 3] + n[c * 3];
    const sy = n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1];
    const sz = n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2];
    if (fx * sx + fy * sy + fz * sz < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }

  /** Two triangles over the quad a-b-c-d (corners in order round it), facing the way its vertex normals point. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Copies the vertices and triangles added since `from` to the other side of the car (z negated). */
  mirror(from: number, fromTri = 0): void {
    const count = this.vertexCount;
    const offset = count - from;
    for (let i = from; i < count; i++) {
      this.pos.push(this.pos[i * 3], this.pos[i * 3 + 1], -this.pos[i * 3 + 2]);
      this.nrm.push(this.nrm[i * 3], this.nrm[i * 3 + 1], -this.nrm[i * 3 + 2]);
      this.uv.push(this.uv[i * 2], this.zon[i] >= 0 ? 1 - this.uv[i * 2 + 1] : this.uv[i * 2 + 1]);
      this.col.push(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
      this.fin.push(this.fin[i * 4], this.fin[i * 4 + 1], this.fin[i * 4 + 2], this.fin[i * 4 + 3]);
      this.zon.push(this.zon[i]);
      this.hin.push(this.hin[i * 3], this.hin[i * 3 + 1], this.hin[i * 3 + 2]);
    }
    const tris = this.idx.length;
    for (let t = fromTri * 3; t < tris; t += 3) {
      const a = this.idx[t];
      const b = this.idx[t + 1];
      const c = this.idx[t + 2];
      if (a < from || b < from || c < from) continue;
      // Mirroring turns the triangle inside out: swap two corners.
      this.idx.push(a + offset, c + offset, b + offset);
    }
  }

  /** Moves and turns the vertices added since `from`: p -> m(p) for points, the same rotation for normals. */
  transform(from: number, m: (p: V3) => V3, rotate: (n: V3) => V3): void {
    for (let i = from; i < this.vertexCount; i++) {
      const p = m([this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]);
      const n = rotate([this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]]);
      this.pos[i * 3] = p[0];
      this.pos[i * 3 + 1] = p[1];
      this.pos[i * 3 + 2] = p[2];
      this.nrm[i * 3] = n[0];
      this.nrm[i * 3 + 1] = n[1];
      this.nrm[i * 3 + 2] = n[2];
    }
  }

  build(): CarMeshData {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nrm),
      uvs: Float32Array.from(this.uv),
      colors: Float32Array.from(this.col),
      finish: Float32Array.from(this.fin),
      zone: Float32Array.from(this.zon),
      hinge: Float32Array.from(this.hin),
      indices: Uint32Array.from(this.idx),
    };
  }
}

// ---- vectors -------------------------------------------------------------------

export function sub(a: readonly number[], b: readonly number[]): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: readonly number[], b: readonly number[], s = 1): V3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a: readonly number[]): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Two unit vectors perpendicular to `axis` and to each other. */
function frame(axis: V3): [V3, V3] {
  const helper: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = norm(cross(axis, helper));
  const b = norm(cross(axis, a));
  return [a, b];
}

// ---- smooth curves -------------------------------------------------------------

/**
 * A smooth curve through points [x, value], monotone between them (no
 * overshoot), constant beyond the ends. The points may be in any order of x.
 */
export function curve(points: readonly (readonly [number, number])[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const slopes: number[] = [];
  for (let i = 0; i + 1 < n; i++) slopes.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  // Fritsch-Carlson tangents.
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i + 1 < n; i++) m[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  if (n > 1) {
    m[0] = slopes[0];
    m[n - 1] = slopes[n - 2];
  }
  for (let i = 0; i + 1 < n; i++) {
    if (slopes[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slopes[i];
    const b = m[i + 1] / slopes[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slopes[i];
      m[i + 1] = t * b * slopes[i];
    }
  }
  return (x: number) => {
    if (n === 1 || x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i + 2 < n && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** 0 below a, 1 above b, smooth in between. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Positions from `from` to `to` (in either order), denser where `density` is higher. */
export function stations(from: number, to: number, count: number, density: (x: number) => number = () => 1): number[] {
  const samples = 400;
  const cum = [0];
  for (let i = 1; i <= samples; i++) {
    const x = from + ((to - from) * (i - 0.5)) / samples;
    cum.push(cum[i - 1] + Math.max(1e-3, density(x)));
  }
  const total = cum[samples];
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (j < samples && cum[j + 1] < target) j++;
    const f = cum[j + 1] > cum[j] ? (target - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    out.push(from + ((to - from) * Math.min(samples, j + f)) / samples);
  }
  out[0] = from;
  out[count - 1] = to;
  return out;
}

// ---- cross sections ------------------------------------------------------------

/**
 * Half a cross section, in the (z, y) plane: from the bottom centre round
 * the right side to the top centre, mirrored for the left. Segments take a
 * surface; a point where the surface changes, or marked hard, becomes a
 * crease (its own vertices on each side). Every section of a loft must be
 * built with the same calls, so their points match up.
 */
export class SectionPath {
  readonly z: number[] = [];
  readonly y: number[] = [];
  /** The surface of the segment ending at each point (the first point: the first segment's). */
  readonly surface: Surface[] = [];
  readonly hard: boolean[] = [];
  private current: Surface;

  constructor(z: number, y: number, surface: Surface) {
    this.current = surface;
    this.z.push(z);
    this.y.push(y);
    this.surface.push(surface);
    this.hard.push(false);
  }

  get length(): number {
    return this.z.length;
  }

  /** The surface for the segments that follow; a change makes a crease at the current point. */
  use(surface: Surface): this {
    if (surface !== this.current) this.hard[this.hard.length - 1] = true;
    this.current = surface;
    return this;
  }

  /** Marks the current point as a crease. */
  crease(): this {
    this.hard[this.hard.length - 1] = true;
    return this;
  }

  private push(z: number, y: number): void {
    this.z.push(z);
    this.y.push(y);
    this.surface.push(this.current);
    this.hard.push(false);
  }

  /** A straight line to (z, y) in n steps. */
  line(z: number, y: number, n = 1): this {
    const z0 = this.z[this.z.length - 1];
    const y0 = this.y[this.y.length - 1];
    for (let i = 1; i <= n; i++) this.push(z0 + ((z - z0) * i) / n, y0 + ((y - y0) * i) / n);
    return this;
  }

  /**
   * A quarter superellipse to (z, y) in n steps, bulging towards the corner
   * that turns first `across` (horizontally, then vertically) or first `up`
   * (vertically, then horizontally). e = 2 is an ellipse; larger is squarer.
   */
  round(z: number, y: number, n: number, e = 2, first: 'across' | 'up' = 'up'): this {
    const z0 = this.z[this.z.length - 1];
    const y0 = this.y[this.y.length - 1];
    const p = 2 / e;
    for (let i = 1; i <= n; i++) {
      const t = (Math.PI / 2) * (i / n);
      const c = Math.pow(Math.cos(t), p);
      const s = Math.pow(Math.sin(t), p);
      if (first === 'up') this.push(z + (z0 - z) * c, y0 + (y - y0) * s);
      else this.push(z0 + (z - z0) * s, y + (y0 - y) * c);
    }
    return this;
  }
}

// ---- lofts ---------------------------------------------------------------------

export interface LoftOptions {
  /** Positions along the car, front to rear (decreasing x). A repeated x makes a crease across the body. */
  stations: readonly number[];
  /** The half section at x. */
  section: (x: number, ring: number) => SectionPath;
  /** Sideways offset of the section's centre line at x (for lofts off the middle of the car); default 0. */
  offsetZ?: (x: number) => number;
  /** Mirror the half section to a full ring (default), or use it as the right half only, open at the centre. */
  mirror?: boolean;
  /** Livery u for a position along the car. */
  u: (x: number) => number;
  /** Close the ends with flat caps of these surfaces. */
  capFront?: Surface;
  capRear?: Surface;
}

/** A body swept through cross sections along the car, with its rings kept for decals. */
export class Loft {
  /** Per ring: x, and the full ring's points (z, y) and outward normals in the section plane. */
  readonly rings: { x: number; z: number[]; y: number[] }[] = [];

  constructor(mb: CarMeshBuilder, o: LoftOptions) {
    const mirror = o.mirror ?? true;
    const offset = o.offsetZ ?? (() => 0);
    const paths = o.stations.map((x, i) => o.section(x, i));
    const count = paths[0].length;
    for (const p of paths) if (p.length !== count) throw new Error(`Loft sections differ: ${p.length} points against ${count}.`);
    // Columns round the full ring: the half path, then its mirror (without repeating the centre points).
    // Each takes the surface of one segment (`seg`, the index of the point that segment ends at), per ring.
    // A point is a crease where any section has one, so every ring splits the same columns.
    type Column = { src: number; side: 1 | -1; seg: number; hardBefore: boolean };
    const hard = Array.from({ length: count }, (_, i) => paths.some((p) => p.hard[i]));
    const cols: Column[] = [];
    const pushCol = (src: number, side: 1 | -1, seg: number) => cols.push({ src, side, seg, hardBefore: false });
    const crease = (src: number, side: 1 | -1, seg: number) => {
      pushCol(src, side, seg);
      cols[cols.length - 1].hardBefore = true;
    };
    // The right side: each point ends a segment (and takes its surface); at a crease the next segment starts on a vertex of its own.
    for (let i = 0; i < count; i++) {
      pushCol(i, 1, i === 0 ? Math.min(1, count - 1) : i);
      if (hard[i] && i > 0 && i + 1 < count) crease(i, 1, i + 1);
    }
    // The left side, from the top centre down: the mirror of segment i + 1 runs from point i + 1 to point i.
    if (mirror) {
      if (hard[count - 1]) crease(count - 1, -1, count - 1);
      for (let i = count - 2; i >= 1; i--) {
        pushCol(i, -1, i + 1);
        if (hard[i]) crease(i, -1, i);
      }
      // The last segment joins back onto the bottom centre, the first column.
    }
    const nc = cols.length;
    const nr = paths.length;
    // Positions and livery v (arc length round each ring).
    const P: V3[][] = [];
    const V: number[][] = [];
    for (let r = 0; r < nr; r++) {
      const x = o.stations[r];
      const p = paths[r];
      const oz = offset(x);
      const ringPts: V3[] = cols.map((c) => [x, p.y[c.src], oz + c.side * p.z[c.src]]);
      P.push(ringPts);
      const along = [0];
      for (let c = 1; c < nc; c++) along.push(along[c - 1] + Math.hypot(ringPts[c][1] - ringPts[c - 1][1], ringPts[c][2] - ringPts[c - 1][2]));
      const total = along[nc - 1] + (mirror ? Math.hypot(ringPts[0][1] - ringPts[nc - 1][1], ringPts[0][2] - ringPts[nc - 1][2]) : 0) || 1;
      V.push(along.map((a) => (mirror ? a / total : (0.5 * a) / (along[nc - 1] || 1))));
      this.rings.push({ x, z: ringPts.map((q) => q[2]), y: ringPts.map((q) => q[1]) });
    }
    // Normals: area-weighted face normals of the grid, per vertex; creases are separate vertices.
    const N: V3[][] = P.map((ring) => ring.map((): V3 => [0, 0, 0]));
    const closed = mirror;
    const faces: [number, number, number, number][] = [];
    for (let r = 0; r + 1 < nr; r++) {
      for (let c = 0; c < nc; c++) {
        const c1 = c + 1;
        if (c1 >= nc && !closed) break;
        if (cols[c1 % nc]?.hardBefore && c1 < nc) {
          // A crease: the two vertices at the same point are not joined by a face.
          continue;
        }
        faces.push([r, c, r + 1, c1 % nc]);
      }
    }
    const accumulate = (r: number, c: number, n: V3) => {
      const t = N[r][c];
      t[0] += n[0];
      t[1] += n[1];
      t[2] += n[2];
    };
    for (const [r, c, r1, c1] of faces) {
      const a = P[r][c];
      const b = P[r1][c];
      const d = P[r][c1];
      const e = P[r1][c1];
      // Rings run front to rear and columns round the right side first, so this points outward.
      const n = cross(sub(a, e), sub(d, b));
      accumulate(r, c, n);
      accumulate(r1, c, n);
      accumulate(r, c1, n);
      accumulate(r1, c1, n);
    }
    // Ends of a crease across the body (a repeated station) take their neighbours' normals.
    const ids: number[][] = [];
    for (let r = 0; r < nr; r++) {
      const row: number[] = [];
      for (let c = 0; c < nc; c++) {
        let n = N[r][c];
        if (Math.hypot(n[0], n[1], n[2]) < 1e-12) {
          // No face of its own (a ring at a crease across the body): point away from the section's middle.
          let cy = 0;
          for (const q of P[r]) cy += q[1] / nc;
          n = [0, P[r][c][1] - cy, P[r][c][2] - offset(o.stations[r])];
        }
        row.push(mb.vertex(P[r][c], n, [o.u(o.stations[r]), V[r][c]], paths[r].surface[cols[c].seg]));
      }
      ids.push(row);
    }
    for (const [r, c, r1, c1] of faces) {
      // Skip faces between two rings at the same position.
      if (Math.abs(o.stations[r] - o.stations[r1]) < 1e-9) continue;
      mb.quad(ids[r][c], ids[r][c1], ids[r1][c1], ids[r1][c]);
    }
    if (o.capFront) this.cap(mb, P[0], o.capFront, 1, o.u(o.stations[0]));
    if (o.capRear) this.cap(mb, P[nr - 1], o.capRear, -1, o.u(o.stations[nr - 1]));
  }

  private cap(mb: CarMeshBuilder, ring: V3[], s: Surface, dir: 1 | -1, u: number): void {
    const centre: V3 = [0, 0, 0];
    for (const p of ring) {
      centre[0] += p[0] / ring.length;
      centre[1] += p[1] / ring.length;
      centre[2] += p[2] / ring.length;
    }
    const n: V3 = [dir, 0, 0];
    const c = mb.vertex(centre, n, [u, 0.5], s);
    const ids = ring.map((p) => mb.vertex(p, n, [u, 0.5], s));
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      if (dir === 1) mb.tri(c, b, a);
      else mb.tri(c, a, b);
    }
  }

  /**
   * The point of the body under p, looking from the middle of its section
   * at p's x: the surface point in the direction of p, with the outward
   * normal there. Null outside the loft's length.
   */
  project(p: readonly number[]): { point: V3; normal: V3 } | null {
    const rings = this.rings;
    let r = -1;
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i].x;
      const b = rings[i + 1].x;
      if ((p[0] <= a && p[0] >= b) || (p[0] >= a && p[0] <= b)) {
        if (Math.abs(a - b) < 1e-9) continue;
        r = i;
        break;
      }
    }
    if (r < 0) return null;
    const A = rings[r];
    const B = rings[r + 1];
    const f = (p[0] - A.x) / (B.x - A.x);
    const zs = A.z.map((z, i) => z + (B.z[i] - z) * f);
    const ys = A.y.map((y, i) => y + (B.y[i] - y) * f);
    let cz = 0;
    let cy = 0;
    for (let i = 0; i < zs.length; i++) {
      cz += zs[i] / zs.length;
      cy += ys[i] / ys.length;
    }
    const dz = p[2] - cz;
    const dy = p[1] - cy;
    let best: { t: number; z: number; y: number; nz: number; ny: number } | null = null;
    for (let i = 0; i < zs.length; i++) {
      const j = (i + 1) % zs.length;
      const ez = zs[j] - zs[i];
      const ey = ys[j] - ys[i];
      const den = dz * ey - dy * ez;
      if (Math.abs(den) < 1e-12) continue;
      // Ray c + t (dz, dy) against the edge i + s (ez, ey).
      const t = ((zs[i] - cz) * ey - (ys[i] - cy) * ez) / den;
      const s = ((zs[i] - cz) * dy - (ys[i] - cy) * dz) / den;
      if (t <= 0 || s < 0 || s > 1) continue;
      if (!best || t > best.t) {
        // Outward: the edge normal pointing away from the centre.
        let nz = ey;
        let ny = -ez;
        if (nz * dz + ny * dy < 0) {
          nz = -nz;
          ny = -ny;
        }
        best = { t, z: cz + dz * t, y: cy + dy * t, nz, ny };
      }
    }
    if (!best) return null;
    return { point: [p[0], best.y, best.z], normal: norm([0, best.ny, best.nz]) };
  }
}

// ---- decals --------------------------------------------------------------------

/**
 * A decal patch laid on a loft: a grid over the rectangle `w` x `h` metres
 * centred on `centre`, spanned by the directions `right` and `up`, each point
 * moved onto the body (see Loft.project) and lifted 4 mm off it. Its decal
 * coordinates run over `rect` (u0, v0, u1, v1) of a car's decal cell.
 */
export function decal(
  mb: CarMeshBuilder, body: Loft, centre: V3, right: V3, up: V3, w: number, h: number,
  rect: readonly [number, number, number, number], nx = 6, ny = 3,
): void {
  const s = trim([1, 1, 1], { roughness: 0.3, clearcoat: 1 });
  const ids: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const a = i / nx - 0.5;
      const b = j / ny - 0.5;
      const p = add(add(centre, right, a * w), up, b * h);
      const hit = body.project(p) ?? { point: p, normal: norm(cross(right, up)) };
      const q = add(hit.point, hit.normal, 0.004);
      row.push(mb.vertex(q, hit.normal, [rect[0] + (rect[2] - rect[0]) * (i / nx), rect[1] + (rect[3] - rect[1]) * (j / ny)], s));
    }
    ids.push(row);
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = ids[j][i];
      const b = ids[j][i + 1];
      const c = ids[j + 1][i + 1];
      const d = ids[j + 1][i];
      mb.quad(a, b, c, d);
    }
  }
}

/** A flat decal: the rectangle `w` x `h` centred on `centre`, facing along right x up (or a flat panel of another surface). */
export function flatDecal(
  mb: CarMeshBuilder, centre: V3, right: V3, up: V3, w: number, h: number, rect: readonly [number, number, number, number] = [0, 0, 1, 1],
  s: Surface = trim([1, 1, 1], { roughness: 0.3, clearcoat: 1 }),
): void {
  const n = norm(cross(right, up));
  const c = add(centre, n, 0.003);
  const p = (a: number, b: number) => add(add(c, right, a * w), up, b * h);
  const v0 = mb.vertex(p(-0.5, -0.5), n, [rect[0], rect[1]], s);
  const v1 = mb.vertex(p(0.5, -0.5), n, [rect[2], rect[1]], s);
  const v2 = mb.vertex(p(0.5, 0.5), n, [rect[2], rect[3]], s);
  const v3 = mb.vertex(p(-0.5, 0.5), n, [rect[0], rect[3]], s);
  mb.quad(v0, v1, v2, v3);
}

// ---- airfoils and plates -------------------------------------------------------

/** A closed airfoil outline, chord 1 from the leading edge (0) to the trailing edge (1), cambered downwards (for downforce). */
function airfoil(n: number, thickness: number, camber: number): [number, number][] {
  const pts: [number, number][] = [];
  const yt = (x: number) => 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x: number) => -camber * 4 * x * (1 - x);
  // Upper surface from the trailing edge to the leading edge, then the lower back; cosine spacing.
  for (let i = 0; i <= n; i++) {
    const x = 0.5 * (1 + Math.cos((Math.PI * i) / n));
    pts.push([x, yc(x) + yt(x)]);
  }
  for (let i = 1; i < n; i++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / n));
    pts.push([x, yc(x) - yt(x)]);
  }
  return pts;
}

export interface WingOptions {
  /** Leading edge at the inner end and at the outer end (z is the span). */
  from: V3;
  to: V3;
  chord: number;
  /** Chord at the outer end (default: the same). */
  tipChord?: number;
  /** Angle of attack in radians, trailing edge up positive (more downforce). */
  angle: number;
  thickness?: number;
  camber?: number;
  /** Points per side of the outline. */
  n?: number;
  /** Sections along the span. */
  spanSteps?: number;
  surface: Surface;
  /** Livery u for the element. */
  u?: number;
  /** Cap the ends (when no endplate covers them). */
  caps?: boolean;
}

/** A wing element: an airfoil swept between two leading-edge points. */
export function wing(mb: CarMeshBuilder, o: WingOptions): void {
  const n = o.n ?? 10;
  const outline = airfoil(n, o.thickness ?? 0.12, o.camber ?? 0.06);
  const steps = o.spanSteps ?? 1;
  const ca = Math.cos(o.angle);
  const sa = Math.sin(o.angle);
  const sections: V3[][] = [];
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const le = add(o.from, sub(o.to, o.from), f);
    const chord = o.chord + ((o.tipChord ?? o.chord) - o.chord) * f;
    // Chord runs rearward (-x); rotate by the angle about the span axis.
    // The chord runs rearward (-x); turning by the angle lifts the trailing edge.
    sections.push(outline.map(([cx, cy]): V3 => {
      const x = -cx * chord;
      const y = cy * chord;
      return [le[0] + x * ca + y * sa, le[1] - x * sa + y * ca, le[2]];
    }));
  }
  const m = outline.length;
  const ids: number[][] = [];
  for (let s = 0; s <= steps; s++) {
    const row: number[] = [];
    for (let i = 0; i < m; i++) {
      const prev = sections[s][(i - 1 + m) % m];
      const next = sections[s][(i + 1) % m];
      const t = sub(next, prev);
      // The outline runs clockwise seen from +z (over the top towards the front), so outward is (-ty, tx).
      const nrm = norm([-t[1], t[0], 0]);
      row.push(mb.vertex(sections[s][i], nrm, [o.u ?? 0.5, 0.5], o.surface));
    }
    ids.push(row);
  }
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      mb.quad(ids[s][i], ids[s][j], ids[s + 1][j], ids[s + 1][i]);
    }
  }
  if (o.caps ?? true) {
    for (const [s, dir] of [[0, -1], [steps, 1]] as const) {
      const nz: V3 = [0, 0, (Math.sign(o.to[2] - o.from[2]) || 1) * dir];
      const capIds = sections[s].map((p) => mb.vertex(p, nz, [o.u ?? 0.5, 0.5], o.surface));
      for (let i = 1; i + 1 < m; i++) mb.tri(capIds[0], capIds[i], capIds[i + 1]);
    }
  }
}

/** Ear-clipping triangulation of a simple polygon (any winding); returns index triples. */
export function triangulate(pts: readonly (readonly [number, number])[]): [number, number, number][] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  const ccw = area > 0;
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: [number, number, number][] = [];
  const crossZ = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]) => {
    const d1 = crossZ(a, b, p);
    const d2 = crossZ(b, c, p);
    const d3 = crossZ(c, a, p);
    return ccw ? d1 > 0 && d2 > 0 && d3 > 0 : d1 < 0 && d2 < 0 && d3 < 0;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      const turn = crossZ(pts[a], pts[b], pts[c]);
      if (ccw ? turn <= 1e-12 : turn >= -1e-12) continue;
      let ear = true;
      for (const k of idx) {
        if (k === a || k === b || k === c) continue;
        if (inside(pts[k], pts[a], pts[b], pts[c])) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * A flat plate: the outline (x, y) in the side view, `thickness` thick
 * across the car, centred at z. For endplates, fins and floors seen from
 * the side; `plan` puts the outline in the (x, z) plane at height y instead.
 */
export function plate(mb: CarMeshBuilder, outline: readonly (readonly [number, number])[], at: number, thickness: number, surface: Surface, plan = false, u = 0.5): void {
  const tris = triangulate(outline);
  const h = thickness / 2;
  const point = (p: readonly number[], side: number): V3 => (plan ? [p[0], at + side * h, p[1]] : [p[0], p[1], at + side * h]);
  const normal = (side: number): V3 => (plan ? [0, side, 0] : [0, 0, side]);
  for (const side of [1, -1]) {
    const ids = outline.map((p) => mb.vertex(point(p, side), normal(side), [u, 0.5], surface));
    for (const [a, b, c] of tris) mb.tri(ids[a], ids[b], ids[c]);
  }
  // The rim, its normals outward in the plate's plane.
  const n = outline.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += outline[i][0] * outline[j][1] - outline[j][0] * outline[i][1];
  }
  const turn = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % n];
    const ea = q[0] - p[0];
    const eb = q[1] - p[1];
    // Outward of an anticlockwise outline in its own plane is (eb, -ea).
    const out: V3 = plan ? [eb * turn, 0, -ea * turn] : [eb * turn, -ea * turn, 0];
    const a = mb.vertex(point(p, 1), out, [u, 0.5], surface);
    const b = mb.vertex(point(q, 1), out, [u, 0.5], surface);
    const c = mb.vertex(point(q, -1), out, [u, 0.5], surface);
    const d = mb.vertex(point(p, -1), out, [u, 0.5], surface);
    mb.quad(a, b, c, d);
  }
}

// ---- tubes and solids of revolution ----------------------------------------------

/** A tube from a to b, radius ra to rb, its section squashed to `flat` (1 round) along `wide` (the direction it is widest). */
export function tube(mb: CarMeshBuilder, a: V3, b: V3, ra: number, rb: number, segments: number, surface: Surface, flat = 1, wide?: V3, caps = true): void {
  const axis = norm(sub(b, a));
  let [e1, e2] = frame(axis);
  if (wide) {
    e1 = norm(sub(wide, add([0, 0, 0], axis, dot(wide, axis))));
    e2 = norm(cross(axis, e1));
  }
  const ring = (c: V3, r: number) => {
    const ids: number[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (2 * Math.PI * i) / segments;
      const dir = add(add([0, 0, 0], e1, Math.cos(t)), e2, Math.sin(t) * flat);
      const nrm = add(add([0, 0, 0], e1, Math.cos(t) * flat), e2, Math.sin(t));
      ids.push(mb.vertex(add(c, dir, r), nrm, [0.5, 0.5], surface));
    }
    return ids;
  };
  const A = ring(a, ra);
  const B = ring(b, rb);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    mb.quad(A[i], A[j], B[j], B[i]);
  }
  if (caps) {
    const ca = mb.vertex(a, sub([0, 0, 0], axis), [0.5, 0.5], surface);
    const cb = mb.vertex(b, axis, [0.5, 0.5], surface);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      mb.tri(ca, A[j], A[i]);
      mb.tri(cb, B[i], B[j]);
    }
  }
}

/** A tube along a polyline (bent with parallel-transported frames), constant radius. */
export function pipe(mb: CarMeshBuilder, points: readonly V3[], radius: number, segments: number, surface: Surface, flat = 1, caps = true): void {
  const n = points.length;
  const tangents = points.map((_, i) => norm(sub(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)])));
  let [e1] = frame(tangents[0]);
  const rings: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    // Parallel transport: remove the tangent component and renormalise.
    e1 = norm(sub(e1, add([0, 0, 0], t, dot(e1, t))));
    const e2 = norm(cross(t, e1));
    const ids: number[] = [];
    for (let s = 0; s < segments; s++) {
      const a = (2 * Math.PI * s) / segments;
      const dir = add(add([0, 0, 0], e1, Math.cos(a) * flat), e2, Math.sin(a));
      const nrm = add(add([0, 0, 0], e1, Math.cos(a)), e2, Math.sin(a) * flat);
      ids.push(mb.vertex(add(points[i], dir, radius), nrm, [0.5, 0.5], surface));
    }
    rings.push(ids);
  }
  for (let i = 0; i + 1 < n; i++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      mb.quad(rings[i][s], rings[i][s1], rings[i + 1][s1], rings[i + 1][s]);
    }
  }
  if (caps) {
    const first = mb.vertex(points[0], sub([0, 0, 0], tangents[0]), [0.5, 0.5], surface);
    const last = mb.vertex(points[n - 1], tangents[n - 1], [0.5, 0.5], surface);
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      mb.tri(first, rings[0][s1], rings[0][s]);
      mb.tri(last, rings[n - 1][s], rings[n - 1][s1]);
    }
  }
}

/**
 * A solid of revolution about the z axis through `centre`: the profile is
 * (radius, z) pairs, each segment with its surface; a point marked hard
 * gets its own vertices on each side. For wheels.
 */
export function revolve(
  mb: CarMeshBuilder, centre: V3, profile: readonly { r: number; z: number; surface: Surface; hard?: boolean }[], segments: number,
): void {
  // Columns: profile points, creases doubled.
  const cols: { r: number; z: number; surface: Surface }[] = [];
  profile.forEach((p, i) => {
    cols.push({ r: p.r, z: p.z, surface: p.surface });
    if (p.hard && i + 1 < profile.length) cols.push({ r: p.r, z: p.z, surface: profile[i + 1].surface });
  });
  // Profile normals in the (r, z) plane, from neighbours on the same side of a crease.
  const nc = cols.length;
  const normals: [number, number][] = cols.map((c, i) => {
    const sameBefore = i > 0 && !(cols[i - 1].r === c.r && cols[i - 1].z === c.z);
    const sameAfter = i + 1 < nc && !(cols[i + 1].r === c.r && cols[i + 1].z === c.z);
    const prev = sameBefore ? cols[i - 1] : c;
    const next = sameAfter ? cols[i + 1] : c;
    let dr = next.r - prev.r;
    let dz = next.z - prev.z;
    if (Math.abs(dr) + Math.abs(dz) < 1e-12) {
      dr = 0;
      dz = 1;
    }
    // The profile runs from the outer face (+z) up round the tread to the inner face: outward is (-dz, dr).
    const l = Math.hypot(dz, dr) || 1;
    return [-dz / l, dr / l];
  });
  const ids: number[][] = [];
  for (let s = 0; s <= segments; s++) {
    const a = (2 * Math.PI * s) / segments;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const row: number[] = [];
    for (let i = 0; i < nc; i++) {
      const c = cols[i];
      const [nr, nz] = normals[i];
      row.push(mb.vertex([centre[0] + c.r * ca, centre[1] + c.r * sa, centre[2] + c.z], [nr * ca, nr * sa, nz], [s / segments, i / nc], c.surface));
    }
    ids.push(row);
  }
  for (let s = 0; s < segments; s++) {
    for (let i = 0; i + 1 < nc; i++) {
      if (cols[i].r === cols[i + 1].r && cols[i].z === cols[i + 1].z) continue;
      mb.quad(ids[s][i], ids[s + 1][i], ids[s + 1][i + 1], ids[s][i + 1]);
    }
  }
}

/** An ellipsoid (or the part of it within the angle ranges), its surface chosen per direction. */
export function ellipsoid(
  mb: CarMeshBuilder, centre: V3, radii: V3, segments: number, rings: number, surface: (dir: V3) => Surface,
  lat: [number, number] = [-Math.PI / 2, Math.PI / 2], lon: [number, number] = [0, 2 * Math.PI], lift = 0,
): void {
  const ids: number[][] = [];
  for (let j = 0; j <= rings; j++) {
    const phi = lat[0] + ((lat[1] - lat[0]) * j) / rings;
    const row: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const th = lon[0] + ((lon[1] - lon[0]) * i) / segments;
      // x forward, y up, z right.
      const dir: V3 = [Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)];
      const p: V3 = [centre[0] + dir[0] * (radii[0] + lift), centre[1] + dir[1] * (radii[1] + lift), centre[2] + dir[2] * (radii[2] + lift)];
      const n = norm([dir[0] / radii[0], dir[1] / radii[1], dir[2] / radii[2]]);
      row.push(mb.vertex(p, n, [0.5, 0.5], surface(dir)));
    }
    ids.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      mb.quad(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
    }
  }
}

/** A box between two corners. */
export function box(mb: CarMeshBuilder, lo: V3, hi: V3, surface: Surface, u = 0.5): void {
  const faces: { n: V3; pts: V3[] }[] = [
    { n: [1, 0, 0], pts: [[hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]], [hi[0], lo[1], hi[2]]] },
    { n: [-1, 0, 0], pts: [[lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [lo[0], hi[1], lo[2]], [lo[0], lo[1], lo[2]]] },
    { n: [0, 1, 0], pts: [[lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]] },
    { n: [0, -1, 0], pts: [[lo[0], lo[1], hi[2]], [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]]] },
    { n: [0, 0, 1], pts: [[lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]] },
    { n: [0, 0, -1], pts: [[hi[0], lo[1], lo[2]], [lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]]] },
  ];
  for (const f of faces) {
    const ids = f.pts.map((p) => mb.vertex(p, f.n, [u, 0.5], surface));
    mb.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}
