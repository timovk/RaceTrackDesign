/**
 * Everything that can stand between a camera and a car, or that a camera
 * could wrongly stand in: the ground as it is drawn, and what is built on
 * it (the grandstands with their roofs, the pit building, the gantries, the
 * marshal posts).
 *
 * It answers two questions, fast enough to ask every frame: may a camera
 * stand here (`standing`), and is this line of sight clear (`between`).
 *
 * Heights are as the 3D view draws them: the ground exaggerated by the
 * view's relief (`display`), and whatever is built keeping its real size
 * on the ground it stands on (see `MeshData.anchors`). Positions are map
 * coordinates (x east, y south), z up.
 *
 * Left out: the trees (the broadcast clears the ones in its cameras' way,
 * see `treesInSight`), the catch fences (a camera behind one is put high
 * enough to look over it, see cameraPlan.ts), the rails, tyre walls and
 * advertising boards, a metre high, which a camera looks over, and the
 * towers the cameras themselves stand on.
 */
import type { Display, Vec3 } from './shots.ts';

export type SolidKind = 'grandstand' | 'pit building' | 'gantry' | 'marshal post';
/** What is in the way: something built, or the ground. */
export type Blocker = SolidKind | 'ground';

/** A block of something built: an outline without a dent on the map, between two heights. */
export interface Solid {
  kind: SolidKind;
  /** Its outline on the map, corner by corner (either way round). */
  x: number[];
  y: number[];
  /** The real height it stands on, and how far above that it begins and ends: it keeps this size however tall the relief is drawn. */
  anchor: number;
  lo: number;
  hi: number;
}

/** The ground is kept as a raster of cells this size (metres), in tiles of this many cells, filled as they are asked for. */
const CELL = 3;
const TILE = 32;
/** The solids are kept by the square of this size (metres) they lie on. */
const SQUARE = 40;
/** A line of sight may graze the ground by this much (metres), as the track it looks at lies in it. */
const GRAZE = 0.2;

interface Prism {
  kind: SolidKind;
  /** Outline, anticlockwise in map coordinates. */
  x: Float64Array;
  y: Float64Array;
  /** Drawn heights. */
  z0: number;
  z1: number;
  /** Bounding box. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class Solids {
  private readonly ground: (x: number, y: number) => number;
  private readonly tiles = new Map<number, Float32Array>();
  private readonly prisms: Prism[] = [];
  private readonly squares = new Map<number, number[]>();
  private readonly seen: Int32Array;
  private stamp = 0;

  /**
   * `ground` is the real height of the ground as built (the earthworks'),
   * `display` what the view draws a real height at.
   */
  constructor(ground: (x: number, y: number) => number, display: Display, solids: readonly Solid[] = []) {
    this.ground = (x, y) => display(ground(x, y));
    for (const s of solids) {
      const n = s.x.length;
      if (n < 3 || !(s.hi > s.lo)) continue;
      // Anticlockwise, whichever way it was given.
      let area = 0;
      for (let i = 0; i < n; i++) area += s.x[i] * s.y[(i + 1) % n] - s.x[(i + 1) % n] * s.y[i];
      const order = area >= 0 ? s.x.map((_, i) => i) : s.x.map((_, i) => n - 1 - i);
      const p: Prism = {
        kind: s.kind,
        x: Float64Array.from(order.map((i) => s.x[i])),
        y: Float64Array.from(order.map((i) => s.y[i])),
        z0: display(s.anchor) + s.lo,
        z1: display(s.anchor) + s.hi,
        minX: Math.min(...s.x), maxX: Math.max(...s.x), minY: Math.min(...s.y), maxY: Math.max(...s.y),
      };
      const index = this.prisms.push(p) - 1;
      for (let j = Math.floor(p.minY / SQUARE); j <= Math.floor(p.maxY / SQUARE); j++) {
        for (let i = Math.floor(p.minX / SQUARE); i <= Math.floor(p.maxX / SQUARE); i++) {
          const key = square(i, j);
          const list = this.squares.get(key);
          if (list) list.push(index);
          else this.squares.set(key, [index]);
        }
      }
    }
    this.seen = new Int32Array(this.prisms.length);
  }

  /** How many blocks of built things it holds. */
  get count(): number {
    return this.prisms.length;
  }

  /** The drawn height of the ground at a point. */
  groundAt(x: number, y: number): number {
    const gx = x / CELL;
    const gy = y / CELL;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const a = this.cell(i, j);
    const b = this.cell(i + 1, j);
    const c = this.cell(i, j + 1);
    const d = this.cell(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  private cell(i: number, j: number): number {
    const ti = Math.floor(i / TILE);
    const tj = Math.floor(j / TILE);
    const key = square(ti, tj);
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new Float32Array(TILE * TILE);
      for (let v = 0; v < TILE; v++) for (let u = 0; u < TILE; u++) tile[v * TILE + u] = this.ground((ti * TILE + u) * CELL, (tj * TILE + v) * CELL);
      this.tiles.set(key, tile);
    }
    return tile[(j - tj * TILE) * TILE + (i - ti * TILE)];
  }

  /** The blocks on the squares a line crosses, each once: calls `visit` with each. */
  private along(ax: number, ay: number, bx: number, by: number, visit: (p: Prism) => void): void {
    if (!this.prisms.length) return;
    const stamp = ++this.stamp;
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(d / (SQUARE / 2)));
    let last = NaN;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const i = Math.floor((ax + (bx - ax) * f) / SQUARE);
      const j = Math.floor((ay + (by - ay) * f) / SQUARE);
      // (A line may clip the corner of a square between two samples: its neighbours are looked at too.)
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const key = square(i + di, j + dj);
          if (di === 0 && dj === 0 && key === last) continue;
          const list = this.squares.get(key);
          if (!list) continue;
          for (const index of list) {
            if (this.seen[index] === stamp) continue;
            this.seen[index] = stamp;
            visit(this.prisms[index]);
          }
        }
      }
      last = square(i, j);
    }
  }

  /**
   * The first thing between two points (drawn heights), or null when the
   * line is clear. The last `skip` metres are not looked at: the line ends
   * on the track, or on a car in front of its garage.
   */
  between(a: Vec3, b: Vec3, skip = 6): Blocker | null {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const d = Math.hypot(dx, dy);
    const end = d - skip;
    if (end <= 0) return null;
    let first = Infinity;
    let what: Blocker | null = null;
    // The ground: tried every metre and a half near the camera, where a bank or a hillside is nearest, and less often further out.
    for (let s = 1.5; s < end; s += Math.min(10, Math.max(1.5, 0.04 * s))) {
      const f = s / d;
      if (this.groundAt(a[0] + dx * f, a[1] + dy * f) > a[2] + dz * f - GRAZE) {
        first = f;
        what = 'ground';
        break;
      }
    }
    const limit = Math.min(first, end / d);
    this.along(a[0], a[1], a[0] + dx * limit, a[1] + dy * limit, (p) => {
      const f = enters(p, a, dx, dy, dz, limit);
      if (f < first) {
        first = f;
        what = p.kind;
      }
    });
    return what;
  }

  /** The first thing built between two points, the ground not looked at; or null. */
  builtBetween(a: Vec3, b: Vec3, skip = 6): SolidKind | null {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const d = Math.hypot(dx, dy);
    if (d - skip <= 0) return null;
    const limit = (d - skip) / d;
    let first = Infinity;
    let what: SolidKind | null = null;
    this.along(a[0], a[1], a[0] + dx * limit, a[1] + dy * limit, (p) => {
      const f = enters(p, a, dx, dy, dz, limit);
      if (f < first) {
        first = f;
        what = p.kind;
      }
    });
    return what;
  }

  /**
   * Whether a camera has a clear picture of a point: the line to it clear of
   * the ground and of anything built, and nothing built in the lines to
   * `half` metres either side of it either (a wall right beside the line of
   * sight would fill half the picture).
   */
  framed(a: Vec3, b: Vec3, half: number, skip = 6): boolean {
    return this.between(a, b, skip) === null && this.beside(a, b, half, skip) === null;
  }

  /** What is built in the lines from a point to `half` metres either side of another, or null. */
  beside(a: Vec3, b: Vec3, half: number, skip = 6): SolidKind | null {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    const px = (-dy / d) * half;
    const py = (dx / d) * half;
    return this.builtBetween(a, [b[0] + px, b[1] + py, b[2]], skip) ?? this.builtBetween(a, [b[0] - px, b[1] - py, b[2]], skip);
  }

  /** Whether the line between two points is clear. */
  clear(a: Vec3, b: Vec3, skip = 6): boolean {
    return this.between(a, b, skip) === null;
  }

  /**
   * What a camera at a point (drawn height z) would stand in: something
   * built within `margin` metres of it, or the ground when it is under it
   * or the ground within `margin` metres rises to its height. Null when it
   * stands free. A camera stands on a tower from the ground up, so anything
   * built under it counts too, unless it is `mounted` on it (a platform on a
   * roof): then only what it is in.
   */
  standing(x: number, y: number, z: number, margin = 2, mounted = false): Blocker | null {
    let hit: Blocker | null = null;
    this.along(x - margin, y - margin, x + margin, y + margin, (p) => {
      if (hit || z < p.z0 - margin || (mounted && z > p.z1 + 0.5)) return;
      if (x < p.minX - margin || x > p.maxX + margin || y < p.minY - margin || y > p.maxY + margin) return;
      if (distanceTo(p, x, y) < margin) hit = p.kind;
    });
    if (hit) return hit;
    if (this.groundAt(x, y) > z - 1) return 'ground';
    for (let k = 0; k < 8; k++) {
      const angle = (k * Math.PI) / 4;
      if (this.groundAt(x + Math.cos(angle) * margin, y + Math.sin(angle) * margin) > z - 0.5) return 'ground';
    }
    return null;
  }

  /** The highest the ground and anything built reach within `r` metres of a point (drawn height). */
  topWithin(x: number, y: number, r: number): number {
    let top = this.groundAt(x, y);
    const rings = Math.max(1, Math.ceil(r / 12));
    for (let ring = 1; ring <= rings; ring++) {
      const rr = (r * ring) / rings;
      const around = Math.max(8, Math.ceil((2 * Math.PI * rr) / 12));
      for (let k = 0; k < around; k++) {
        const angle = (k * 2 * Math.PI) / around;
        top = Math.max(top, this.groundAt(x + Math.cos(angle) * rr, y + Math.sin(angle) * rr));
      }
    }
    for (const p of this.prisms) {
      if (x < p.minX - r || x > p.maxX + r || y < p.minY - r || y > p.maxY + r) continue;
      if (distanceTo(p, x, y) < r) top = Math.max(top, p.z1);
    }
    return top;
  }

  /** Fills the ground's raster over a box of the map now, so that no line of sight has to wait for it later. */
  prepare(minX: number, minY: number, maxX: number, maxY: number): void {
    for (let tj = Math.floor(minY / (CELL * TILE)); tj <= Math.floor(maxY / (CELL * TILE)); tj++) {
      for (let ti = Math.floor(minX / (CELL * TILE)); ti <= Math.floor(maxX / (CELL * TILE)); ti++) this.cell(ti * TILE, tj * TILE);
    }
  }
}

function square(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}

/** Distance on the map from a point to a block's outline: 0 inside it. */
function distanceTo(p: Prism, x: number, y: number): number {
  const n = p.x.length;
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = p.x[j] - p.x[i];
    const ey = p.y[j] - p.y[i];
    if (ex * (y - p.y[i]) - ey * (x - p.x[i]) < 0) inside = false;
    const len2 = ex * ex + ey * ey;
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x[i]) * ex + (y - p.y[i]) * ey) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (p.x[i] + ex * f), y - (p.y[i] + ey * f)));
  }
  return inside ? 0 : best;
}

/**
 * How far along a line (as a share of it, up to `limit`) it enters a block,
 * or Infinity when it does not. The line runs from `a` by (dx, dy, dz).
 */
function enters(p: Prism, a: Vec3, dx: number, dy: number, dz: number, limit: number): number {
  let t0 = 0;
  let t1 = limit;
  const n = p.x.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = p.x[j] - p.x[i];
    const ey = p.y[j] - p.y[i];
    // Inside is to the left of each edge: e x (P - Pi) >= 0.
    const at = ex * (a[1] - p.y[i]) - ey * (a[0] - p.x[i]);
    const rate = ex * dy - ey * dx;
    if (Math.abs(rate) < 1e-12) {
      if (at < 0) return Infinity;
      continue;
    }
    const t = -at / rate;
    if (rate > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return Infinity;
  }
  // Over the outline from t0 to t1: is it between the block's heights anywhere there?
  const za = a[2] + dz * t0;
  const zb = a[2] + dz * t1;
  if (Math.max(za, zb) < p.z0 || Math.min(za, zb) > p.z1) return Infinity;
  if (za >= p.z0 && za <= p.z1) return t0;
  // It comes down into it from above, or up into it from below.
  const edge = za > p.z1 ? p.z1 : p.z0;
  return Math.abs(dz) < 1e-12 ? t0 : (edge - a[2]) / dz;
}
