/**
 * A lap as a shape: a polygon with rounded corners, in metres, before any
 * track is built from it. Each corner of the polygon is an arc of its own
 * radius between the two edges it joins; what is left of an edge between two
 * arcs is a straight, and may be nothing at all (a corner that tightens is
 * two arcs, one after the other).
 *
 * Coordinates: x east and y south, so a positive turn is to the right.
 */

export interface Vertex {
  x: number;
  y: number;
  /** Corner radius, metres. */
  r: number;
}

/** A lap; `start` and `main` name the edges (from that vertex to the next) the start line and the longest straight are on. */
export interface Shape {
  v: Vertex[];
  start: number;
  main: number;
  /** Which of the corners that can be asked for by name the lap has. */
  made: { hairpin: boolean; chicane: boolean; esses: boolean; sweeper: boolean };
}

/** Radius ranges of slow, medium and fast corners, metres. */
export const CORNER_RADII = { slow: [16, 45], medium: [45, 120], fast: [120, 290] } as const;
/** A corner under this radius is slow, and over that one fast. */
export const SLOW_BELOW = 45;
export const FAST_ABOVE = 120;
/**
 * A corner reads this much wider on the track as built than it is drawn: the
 * line through its points eases into it and out of it, and rounds its apex.
 * So a corner that is to read as one of 45 m is drawn at 37.5 m.
 */
export const READS_WIDER = 1.2;
/** A straight reads this much shorter on the track as built than it is drawn: the corners at its ends begin before their arcs. */
export const STRAIGHT_CREEP = 50;
/** A bend of this radius or more is no corner as the analysis reads a track: it is part of a straight, or a curve in one. */
export const NO_CORNER = 300;

export const mod = (a: number, n: number) => ((a % n) + n) % n;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Per vertex: the turn (radians, positive to the right), the length of straight its corner takes from each side, and the length of the edge to the next. */
export function turns(v: readonly Vertex[]): { angle: number[]; tangent: number[]; edge: number[] } {
  const n = v.length;
  const angle: number[] = [];
  const tangent: number[] = [];
  const edge: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = v[mod(i - 1, n)];
    const c = v[i];
    const q = v[(i + 1) % n];
    const ax = c.x - p.x, ay = c.y - p.y, bx = q.x - c.x, by = q.y - c.y;
    const a = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    angle.push(a);
    tangent.push(c.r * Math.tan(Math.abs(a) / 2));
    edge.push(Math.hypot(bx, by));
  }
  return { angle, tangent, edge };
}

export function lapLength(v: readonly Vertex[]): number {
  const { angle, tangent, edge } = turns(v);
  let l = 0;
  for (let i = 0; i < v.length; i++) l += edge[i] - tangent[i] - tangent[(i + 1) % v.length] + v[i].r * Math.abs(angle[i]);
  return l;
}

export function centroid(v: readonly { x: number; y: number }[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const p of v) {
    x += p.x / v.length;
    y += p.y / v.length;
  }
  return { x, y };
}

/** With y pointing south, a positive area is a lap that runs clockwise on the map. */
export function signedArea(v: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) a += v[i].x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * v[i].y;
  return a / 2;
}

/** A corner of a lap: one arc, or several the same way with no straight to speak of between them. */
export interface CornerGroup {
  /** The first and the last vertex of it. */
  from: number;
  to: number;
  /** 1 to the right, -1 to the left. */
  sign: number;
  /** How far it turns, radians. */
  turn: number;
  /** Its tightest radius, and the radius the middle half of its turning is made at. */
  radius: number;
  middle: number;
}

/**
 * The corners of a lap, each with the arcs it is made of: arcs the same way
 * with under 40 m of straight between them are one corner, as the analysis
 * reads them on the track (a corner that tightens, the two halves of a turn
 * right round). Every arc is in one, the slightest kink too.
 */
export function cornerGroups(v: readonly Vertex[]): CornerGroup[] {
  const n = v.length;
  const { angle, tangent, edge } = turns(v);
  const joins = (i: number) => {
    const j = (i + 1) % n;
    return Math.sign(angle[i]) === Math.sign(angle[j]) && Math.abs(angle[i]) > 0.05 && Math.abs(angle[j]) > 0.05 && edge[i] - tangent[i] - tangent[j] < 40;
  };
  let first = 0;
  for (let i = 0; i < n; i++) {
    if (!joins(mod(i - 1, n))) {
      first = i;
      break;
    }
  }
  const out: CornerGroup[] = [];
  for (let k = 0; k < n; k++) {
    let i = (first + k) % n;
    const from = i;
    const arcs = [{ turn: Math.abs(angle[i]), radius: v[i].r }];
    while (k < n - 1 && joins(i)) {
      k++;
      i = (first + k) % n;
      arcs.push({ turn: Math.abs(angle[i]), radius: v[i].r });
    }
    const turn = arcs.reduce((a, c) => a + c.turn, 0);
    // The radius the middle half of the turning is made at: the length of that half over its angle.
    let length = 0;
    let before = 0;
    for (const arc of arcs) {
      const lo = Math.max(before, 0.25 * turn), hi = Math.min(before + arc.turn, 0.75 * turn);
      if (hi > lo) length += (hi - lo) * arc.radius;
      before += arc.turn;
    }
    out.push({ from, to: i, sign: Math.sign(angle[from]) || 1, turn, radius: Math.min(...arcs.map((c) => c.radius)), middle: turn > 0 ? length / (0.5 * turn) : v[from].r });
  }
  return out;
}

/** The corners of a lap as the analysis will count them: a turn of under 15 degrees, or one that will read as of 300 m radius or more, is none. */
export function cornersOf(v: readonly Vertex[]): CornerGroup[] {
  return cornerGroups(v).filter((c) => c.turn >= 0.26 && c.radius * READS_WIDER < NO_CORNER);
}

/** The lap as points every `step` metres or closer, each with the distance from the first. */
export interface Path {
  x: number[];
  y: number[];
  s: number[];
  /** Index of the vertex whose corner the point is in, or -1 on a straight. */
  corner: number[];
  /** Edge index of the straight the point is on, or -1 in a corner. */
  straight: number[];
  length: number;
}

export function tracePath(shape: Shape, step: number): Path {
  const v = shape.v;
  const n = v.length;
  const { angle, tangent } = turns(v);
  const out: Path = { x: [], y: [], s: [], corner: [], straight: [], length: 0 };
  let dist = 0;
  const push = (x: number, y: number, corner: number, straight: number) => {
    const k = out.x.length;
    if (k) dist += Math.hypot(x - out.x[k - 1], y - out.y[k - 1]);
    out.x.push(x);
    out.y.push(y);
    out.s.push(dist);
    out.corner.push(corner);
    out.straight.push(straight);
  };
  for (let i = 0; i < n; i++) {
    const p = v[mod(i - 1, n)];
    const c = v[i];
    const q = v[(i + 1) % n];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(q.x - c.x, q.y - c.y);
    const d1x = (c.x - p.x) / l1, d1y = (c.y - p.y) / l1;
    const d2x = (q.x - c.x) / l2, d2y = (q.y - c.y) / l2;
    const t = tangent[i];
    const t1x = c.x - d1x * t, t1y = c.y - d1y * t;
    // The corner at vertex i: an arc from the end of the straight before it to the start of the one after.
    const sign = Math.sign(angle[i]) || 1;
    const cx = t1x - d1y * c.r * sign, cy = t1y + d1x * c.r * sign;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    const arc = c.r * Math.abs(angle[i]);
    const parts = Math.max(1, Math.ceil(arc / step));
    for (let k = 0; k <= parts; k++) {
      const a = a0 + (angle[i] * k) / parts;
      push(cx + c.r * Math.cos(a), cy + c.r * Math.sin(a), i, -1);
    }
    // The straight on to the next corner.
    const t2x = c.x + d2x * t, t2y = c.y + d2y * t;
    const len = l2 - t - tangent[(i + 1) % n];
    const bits = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k < bits; k++) push(t2x + d2x * (len * k) / bits, t2y + d2y * (len * k) / bits, -1, i);
  }
  out.length = dist + Math.hypot(out.x[0] - out.x[out.x.length - 1], out.y[0] - out.y[out.y.length - 1]);
  return out;
}

/** The points of a path by the square of side `cell` each lies in. */
export function cells(path: Path, cell: number): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  for (let i = 0; i < path.x.length; i++) {
    const key = Math.floor(path.x[i] / cell) * 65536 + Math.floor(path.y[i] / cell);
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }
  return grid;
}

/** Whether point i of a path has another part of the lap within `within` metres: one at least `apart` metres from it along the lap. */
export function hasNeighbour(path: Path, grid: Map<number, number[]>, cell: number, i: number, within: number, apart: number): boolean {
  const cx = Math.floor(path.x[i] / cell), cy = Math.floor(path.y[i] / cell);
  const reach = Math.ceil(within / cell);
  for (let gx = cx - reach; gx <= cx + reach; gx++) {
    for (let gy = cy - reach; gy <= cy + reach; gy++) {
      const list = grid.get(gx * 65536 + gy);
      if (!list) continue;
      for (const j of list) {
        const along2 = Math.abs(path.s[j] - path.s[i]);
        if (along2 < apart || path.length - along2 < apart) continue;
        if (Math.hypot(path.x[i] - path.x[j], path.y[i] - path.y[j]) < within) return true;
      }
    }
  }
  return false;
}

/** Whether no two parts of the lap come within `gap` metres of each other (parts less than 2.5 gaps apart along the lap are neighbours). */
export function clear(path: Path, gap: number): boolean {
  const grid = cells(path, gap);
  const near = Math.max(gap * 2.5, 110);
  for (let i = 0; i < path.x.length; i++) if (hasNeighbour(path, grid, gap, i, gap, near)) return false;
  return true;
}

/** How much of the smallest outline without a dent that goes round the lap the lap itself encloses: 1 for a loop with no dent in it; real circuits have 0.65. */
export function hullShare(path: Path): number {
  const n = path.x.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += path.x[i] * path.y[(i + 1) % n] - path.x[(i + 1) % n] * path.y[i];
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => path.x[a] - path.x[b] || path.y[a] - path.y[b]);
  const cross = (o: number, a: number, b: number) => (path.x[a] - path.x[o]) * (path.y[b] - path.y[o]) - (path.y[a] - path.y[o]) * (path.x[b] - path.x[o]);
  const half = (order: number[]) => {
    const out: number[] = [];
    for (const i of order) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], i) <= 0) out.pop();
      out.push(i);
    }
    return out.slice(0, -1);
  };
  const hull = half(idx).concat(half([...idx].reverse()));
  let around = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    around += path.x[p] * path.y[q] - path.x[q] * path.y[p];
  }
  return Math.abs(area) / Math.max(1e-9, Math.abs(around));
}
