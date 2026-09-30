import type { Heightmap } from '../src/core/heightmap.ts';
import type { ControlPoint, TrackDesign } from '../src/core/track.ts';
import { DEFAULT_GRADING } from '../src/core/track.ts';

/** A heightmap defined by a function of world position (metres), 8 km square by default. */
export function makeHeightmap(fn: (x: number, y: number) => number, opts: { size?: number; extent?: number; waterLevel?: number } = {}): Heightmap {
  const size = opts.size ?? 256;
  const extent = opts.extent ?? 8192;
  const cell = extent / size;
  const data = new Float32Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const z = fn((i + 0.5) * cell, (j + 0.5) * cell);
      data[j * size + i] = z;
      min = Math.min(min, z);
      max = Math.max(max, z);
    }
  }
  return { size, cellSize: cell, extent, data, min, max, waterLevel: opts.waterLevel ?? -Infinity };
}

export const flatMap = (z = 100) => makeHeightmap(() => z);

export function design(points: ControlPoint[], grading = DEFAULT_GRADING): TrackDesign {
  return { points, defaultWidth: 12, grading: { ...grading } };
}

export function circlePoints(cx: number, cy: number, r: number, count = 16, width = 12): ControlPoint[] {
  const pts: ControlPoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = (2 * Math.PI * i) / count;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), width });
  }
  return pts;
}

/**
 * Builds control points by driving a turtle: straights and arcs, with a
 * point every `step` metres so the spline follows the path closely.
 * Positive angles turn right (clockwise on screen, since y points south).
 */
export class Turtle {
  x: number;
  y: number;
  heading: number;
  readonly points: ControlPoint[] = [];
  private readonly step: number;

  constructor(x: number, y: number, headingDeg = 0, step = 10) {
    this.x = x;
    this.y = y;
    this.heading = (headingDeg * Math.PI) / 180;
    this.step = step;
    this.points.push({ x, y, width: 12 });
  }

  straight(length: number): this {
    const k = Math.max(1, Math.round(length / this.step));
    for (let i = 1; i <= k; i++) {
      this.points.push({
        x: this.x + Math.cos(this.heading) * (length * i) / k,
        y: this.y + Math.sin(this.heading) * (length * i) / k,
        width: 12,
      });
    }
    this.x += Math.cos(this.heading) * length;
    this.y += Math.sin(this.heading) * length;
    return this;
  }

  arc(radius: number, angleDeg: number): this {
    const angle = (angleDeg * Math.PI) / 180;
    const side = Math.sign(angle);
    // Centre of the arc sits to the right of the heading for right turns.
    const cx = this.x - Math.sin(this.heading) * radius * side;
    const cy = this.y + Math.cos(this.heading) * radius * side;
    const start = Math.atan2(this.y - cy, this.x - cx);
    const k = Math.max(2, Math.round((Math.abs(angle) * radius) / this.step));
    for (let i = 1; i <= k; i++) {
      const a = start + (angle * i) / k;
      this.points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, width: 12 });
    }
    this.x = cx + Math.cos(start + angle) * radius;
    this.y = cy + Math.sin(start + angle) * radius;
    this.heading += angle;
    return this;
  }

  /** Closed-loop points, dropping the final point when it lands back on the first. */
  close(): ControlPoint[] {
    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1) return this.points.slice(0, -1);
    return this.points.slice();
  }
}

/**
 * A clockwise rectangle with rounded 90-degree corners (radius 50 m) and a
 * left-right chicane on the bottom straight. Top straight is 950 m.
 */
export function chicaneCircuit(): ControlPoint[] {
  const d = 2 * 40 * (1 - Math.cos(Math.PI / 4));
  const adv = 2 * 40 * Math.sin(Math.PI / 4);
  return new Turtle(1050, 1000, 0)
    .straight(950)
    .arc(50, 90)
    .straight(600)
    .arc(50, 90)
    .straight(300)
    .arc(40, -45)
    .arc(40, 45)
    .straight(1700 - adv - 1050)
    .arc(50, 90)
    .straight(1700 + d - 50 - 1050)
    .arc(50, 90)
    .close();
}

/** A rectangle with 1500 m and 800 m straights and 50 m corners, 15 m wide, clockwise. */
export function bigRectangle(width = 15) {
  return new Turtle(3000, 3000, 0, 10)
    .straight(1500).arc(50, 90).straight(800).arc(50, 90).straight(1500).arc(50, 90).straight(800).arc(50, 90)
    .close().map((p) => ({ ...p, width }));
}
