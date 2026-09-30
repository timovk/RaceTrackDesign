/** Small 2D geometry helpers shared by the track builder and the editor. */

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Index modulo n that is never negative. */
export function mod(i: number, n: number): number {
  return ((i % n) + n) % n;
}

export interface SplineSample {
  x: number;
  y: number;
  /** Control segment: the curve between point `seg` and point `seg + 1`. */
  seg: number;
  /** Position within the segment, 0..1. */
  u: number;
}

/**
 * Samples a closed centripetal Catmull-Rom spline through `pts`. Centripetal
 * parameterisation never forms cusps or loops within a segment, however the
 * points are spaced. Samples are at most about `maxStep` metres apart; the
 * first point is repeated at the end to close the loop.
 */
export function sampleClosedSpline(pts: readonly Vec2[], maxStep = 0.5): SplineSample[] {
  const n = pts.length;
  const out: SplineSample[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[mod(i - 1, n)];
    const p1 = pts[i];
    const p2 = pts[mod(i + 1, n)];
    const p3 = pts[mod(i + 2, n)];
    const d01 = Math.max(1e-4, Math.sqrt(dist(p0.x, p0.y, p1.x, p1.y)));
    const d12 = Math.max(1e-4, Math.sqrt(dist(p1.x, p1.y, p2.x, p2.y)));
    const d23 = Math.max(1e-4, Math.sqrt(dist(p2.x, p2.y, p3.x, p3.y)));
    // Hermite tangents of the centripetal curve, scaled to the unit parameter interval.
    const m1x = ((p1.x - p0.x) / d01 - (p2.x - p0.x) / (d01 + d12) + (p2.x - p1.x) / d12) * d12;
    const m1y = ((p1.y - p0.y) / d01 - (p2.y - p0.y) / (d01 + d12) + (p2.y - p1.y) / d12) * d12;
    const m2x = ((p2.x - p1.x) / d12 - (p3.x - p1.x) / (d12 + d23) + (p3.x - p2.x) / d23) * d12;
    const m2y = ((p2.y - p1.y) / d12 - (p3.y - p1.y) / (d12 + d23) + (p3.y - p2.y) / d23) * d12;
    const chord = d12 * d12;
    const steps = Math.max(8, Math.ceil((1.5 * chord) / maxStep));
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      out.push({
        x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
        y: h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y,
        seg: i,
        u,
      });
    }
  }
  out.push({ x: pts[0].x, y: pts[0].y, seg: n - 1, u: 1 });
  return out;
}

/**
 * Smooths a closed-loop signal with a triweight kernel whose standard
 * deviation is `sigma` samples. Uses only arithmetic, so it is deterministic.
 */
export function smoothCircular(src: ArrayLike<number>, sigma: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  if (sigma < 0.5 || n === 0) {
    for (let i = 0; i < n; i++) out[i] = src[i];
    return out;
  }
  const r = Math.ceil(3 * sigma);
  const kernel = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let k = -r; k <= r; k++) {
    const q = 1 - (k / (r + 1)) * (k / (r + 1));
    const w = q * q * q;
    kernel[k + r] = w;
    sum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += kernel[k + r] * src[mod(i + k, n)];
    out[i] = acc;
  }
  return out;
}

/** Ramer-Douglas-Peucker simplification of an open polyline. */
export function simplifyPolyline(pts: readonly Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegmentDistance(pts[i].x, pts[i].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** Intersection parameter t along segment a (0..1) if segments a1-a2 and b1-b2 properly cross, else -1. */
export function segmentIntersection(
  a1x: number, a1y: number, a2x: number, a2y: number,
  b1x: number, b1y: number, b2x: number, b2y: number,
): number {
  const rx = a2x - a1x;
  const ry = a2y - a1y;
  const sx = b2x - b1x;
  const sy = b2y - b1y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return -1;
  const qx = b1x - a1x;
  const qy = b1y - a1y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Buckets indices by grid cell for fast neighbourhood queries. */
export class SpatialGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly cellSize: number;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  insert(x: number, y: number, index: number): void {
    const k = this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(index);
    else this.cells.set(k, [index]);
  }

  /** Calls `fn` for every index in cells overlapping the square of half-size `r` around (x, y). */
  query(x: number, y: number, r: number, fn: (index: number) => void): void {
    const x0 = Math.floor((x - r) / this.cellSize);
    const x1 = Math.floor((x + r) / this.cellSize);
    const y0 = Math.floor((y - r) / this.cellSize);
    const y1 = Math.floor((y + r) / this.cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (bucket) for (const i of bucket) fn(i);
      }
    }
  }
}
