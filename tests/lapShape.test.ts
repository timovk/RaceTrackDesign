import { describe, expect, it } from 'vitest';
import { type Shape, type Vertex, clear, cornersOf, hullShare, lapLength, signedArea, tracePath, turns } from '../src/core/lapShape.ts';
import { lineRadius, paceOf, peakSpeed } from '../src/core/roughPace.ts';
import { VEHICLES } from '../src/core/vehicles.ts';

const shape = (points: number[][], r = 30): Shape => ({
  v: points.map(([x, y, radius]): Vertex => ({ x, y, r: radius ?? r })), start: 0, main: 0, made: { hairpin: false, chicane: false, esses: false, sweeper: false },
});
// A rectangle of 600 m by 300 m, run clockwise (y points south).
const box = shape([[0, 0], [600, 0], [600, 300], [0, 300]]);

describe('a lap as a shape', () => {
  it('turns once round, each corner an arc that takes its share of the straights either side', () => {
    const { angle, tangent, edge } = turns(box.v);
    expect(angle.reduce((a, x) => a + x, 0)).toBeCloseTo(2 * Math.PI, 9);
    for (const a of angle) expect(a).toBeCloseTo(Math.PI / 2, 9);
    for (const t of tangent) expect(t).toBeCloseTo(30, 9);
    expect(edge).toEqual([600, 300, 600, 300]);
    expect(signedArea(box.v)).toBeGreaterThan(0);
    // Four straights less what the corners take, and four quarter circles.
    expect(lapLength(box.v)).toBeCloseTo(1800 - 8 * 30 + 2 * Math.PI * 30, 9);
  });

  it('is traced as points along it, as far apart as asked or closer', () => {
    const path = tracePath(box, 20);
    // (A little shorter than the lap: the points on an arc are joined by straight lines.)
    expect(lapLength(box.v) - path.length).toBeGreaterThan(0);
    expect(lapLength(box.v) - path.length).toBeLessThan(5);
    for (let i = 1; i < path.x.length; i++) expect(Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1])).toBeLessThanOrEqual(20.01);
    // Each point in a corner or on a straight, never both.
    for (let i = 0; i < path.x.length; i++) expect(path.corner[i] >= 0).not.toBe(path.straight[i] >= 0);
  });

  it('counts its corners as the analysis will', () => {
    expect(cornersOf(box.v).map((c) => Math.round((c.turn * 180) / Math.PI))).toEqual([90, 90, 90, 90]);
    // Two arcs the same way with no straight between them are one corner: this one opens out, from 20 m to 60 m.
    const d = 20 * Math.tan(Math.PI / 8) + 60 * Math.tan(Math.PI / 8);
    const opening = shape([[0, 0], [600 - d * Math.SQRT1_2, 0, 20], [600, d * Math.SQRT1_2, 60], [600, 300], [0, 300]]);
    const corners = cornersOf(opening.v);
    expect(corners.length).toBe(4);
    const one = corners.find((c) => c.radius === 20)!;
    expect((one.turn * 180) / Math.PI).toBeCloseTo(90, 6);
    // The middle half of its turning is made half at each radius.
    expect(one.middle).toBeCloseTo(40, 6);
    // A bend of a few degrees is no corner, nor one of a great radius.
    const kinked = shape([[0, 0], [300, -30], [600, 0], [600, 300], [0, 300]]);
    expect(cornersOf(kinked.v).length).toBe(4);
    const wide = shape([[0, 0], [600, 0], [600, 900, 350], [0, 900, 350]]);
    expect(cornersOf(wide.v).length).toBe(2);
  });

  it('knows how much of the outline round it a lap encloses', () => {
    expect(hullShare(tracePath(box, 10))).toBeGreaterThan(0.97);
    // An L: a square with a quarter cut out encloses three quarters of the outline round it less the corner the outline cuts.
    const ell = shape([[0, 0], [600, 0], [600, 300], [300, 300], [300, 600], [0, 600]]);
    const share = hullShare(tracePath(ell, 10));
    expect(share).toBeGreaterThan(0.8);
    expect(share).toBeLessThan(0.9);
  });

  it('sees two parts of a lap that come too near each other', () => {
    // A lap with a notch that nearly closes: its two sides are 40 m apart.
    const notch = shape([[0, 0], [800, 0], [800, 400], [420, 400], [420, 60], [380, 60], [380, 400], [0, 400]], 15);
    expect(clear(tracePath(notch, 10), 30)).toBe(true);
    expect(clear(tracePath(notch, 10), 55)).toBe(false);
    expect(clear(tracePath(box, 10), 100)).toBe(true);
  });
});

describe('a rough pace', () => {
  const f1 = paceOf(VEHICLES.find((v) => v.id === 'f1')!);
  const tcr = paceOf(VEHICLES.find((v) => v.id === 'tcr')!);

  it('takes a wide corner faster than a tight one, and a Formula 1 car any corner faster than a touring car', () => {
    for (const pace of [f1, tcr, paceOf(null)]) {
      expect(pace.corner(100)).toBeGreaterThan(pace.corner(25));
      expect(pace.corner(5000)).toBeLessThanOrEqual(pace.top);
    }
    expect(f1.corner(60)).toBeGreaterThan(tcr.corner(60) * 1.2);
  });

  it('takes a corner on a wider line than the road, the more so the less it turns', () => {
    // On a road 14 m wide: a flick of 50 degrees at 30 m on a line of 150 m, a right angle on one of 65 m, a turn right round on little more than the road's own.
    expect(lineRadius(30, (50 * Math.PI) / 180, 14)).toBeGreaterThan(140);
    expect(lineRadius(30, (50 * Math.PI) / 180, 14)).toBeLessThan(165);
    expect(lineRadius(30, Math.PI / 2, 14)).toBeCloseTo(65, 0);
    expect(lineRadius(30, Math.PI, 14)).toBeCloseTo(36, 6);
    // A wider road gives a wider line, and no line is tighter than the road.
    expect(lineRadius(30, Math.PI / 2, 20)).toBeGreaterThan(lineRadius(30, Math.PI / 2, 10));
    expect(lineRadius(200, 3, 2)).toBeGreaterThanOrEqual(200);
    // A corner of a few degrees is no corner to a car.
    expect(f1.corner(lineRadius(150, 0.15, 12))).toBe(f1.top);
  });

  it('reaches a higher speed on a longer straight, and no more than the corner at its end takes on none', () => {
    expect(peakSpeed(f1, 30, 30, 0)).toBe(30);
    const short = peakSpeed(f1, 30, 30, 200), long = peakSpeed(f1, 30, 30, 900);
    expect(short).toBeGreaterThan(40);
    expect(long).toBeGreaterThan(short + 15);
    expect(long).toBeLessThanOrEqual(f1.top);
  });
});
