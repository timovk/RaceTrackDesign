import { describe, expect, it } from 'vitest';
import { analyseTrack } from '../src/core/analysis.ts';
import { buildTrack, heightmapSampler } from '../src/core/track.ts';
import { Turtle, chicaneCircuit, circlePoints, design, flatMap, makeHeightmap } from './helpers.ts';

describe('track metrics', () => {
  it('reads direction, length and elevation from a circle on a slope', () => {
    const tilt = makeHeightmap((x) => 100 + 0.04 * x);
    const t = buildTrack(design(circlePoints(4096, 4096, 400), { smoothing: 0, maxCutFill: 0 }), heightmapSampler(tilt))!;
    const m = analyseTrack(t);
    expect(m.direction).toBe('clockwise');
    expect(m.length).toBeCloseTo(t.length, 6);
    expect(m.elevationRange).toBeGreaterThan(0.04 * 800 * 0.98);
    expect(m.elevationRange).toBeLessThan(0.04 * 800 * 1.02);
    expect(m.totalClimb).toBeCloseTo(m.elevationRange, 0);
    expect(m.maxUphill).toBeCloseTo(0.04, 2);
    expect(m.maxDownhill).toBeCloseTo(-0.04, 2);
  });

  it('flips direction when the points are reversed', () => {
    const t = buildTrack(design(circlePoints(4096, 4096, 400).reverse()), heightmapSampler(flatMap()))!;
    const m = analyseTrack(t);
    expect(m.direction).toBe('anticlockwise');
    expect(m.corners.every((c) => c.direction === 'left')).toBe(true);
  });

  it('computes earthworks when grading flattens a bump', () => {
    const bump = makeHeightmap((x, y) => 100 + 15 * Math.exp(-((x - 4396) ** 2 + (y - 4096) ** 2) / (2 * 60 ** 2)));
    const t = buildTrack(design(circlePoints(4096, 4096, 300), { smoothing: 150, maxCutFill: 20 }), heightmapSampler(bump))!;
    const m = analyseTrack(t);
    expect(m.maxCut).toBeGreaterThan(3);
    expect(m.cutVolume).toBeGreaterThan(1000);
  });
});

describe('corner detection', () => {
  const t = buildTrack(design(chicaneCircuit()), heightmapSampler(flatMap()))!;
  const m = analyseTrack(t);

  it('finds four square corners and a two-part chicane', () => {
    expect(m.corners.map((c) => `${c.direction}:${c.type}`)).toEqual([
      'right:medium', 'right:medium', 'left:chicane', 'right:chicane', 'right:medium', 'right:medium',
    ]);
    expect(m.corners.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(m.rightTurns).toBe(5);
    expect(m.leftTurns).toBe(1);
  });

  it('measures corner angles and radii', () => {
    const square = m.corners.filter((c) => c.type === 'medium');
    for (const c of square) {
      expect(c.angle).toBeGreaterThan(85);
      expect(c.angle).toBeLessThan(95);
      expect(c.minRadius).toBeGreaterThan(40);
      expect(c.minRadius).toBeLessThan(55);
    }
    const chicane = m.corners.filter((c) => c.type === 'chicane');
    for (const c of chicane) {
      expect(c.angle).toBeGreaterThan(38);
      expect(c.angle).toBeLessThan(52);
    }
  });

  it('finds the 950 m top straight as the longest', () => {
    expect(m.longestStraight).not.toBeNull();
    expect(m.longestStraight!.length).toBeGreaterThan(900);
    expect(m.longestStraight!.length).toBeLessThan(960);
  });

  it('does not count a long gentle arc as one straight', () => {
    const t = buildTrack(design(circlePoints(4096, 4096, 1500, 24)), heightmapSampler(flatMap()))!;
    const straights = analyseTrack(t).straights;
    for (const st of straights) expect(st.length).toBeLessThan(1500 * ((15 * Math.PI) / 180) + 10);
  });

  it('classifies a tight 180-degree turn as a hairpin', () => {
    const pts = new Turtle(2000, 2000, 0).straight(800).arc(30, 180).straight(800).arc(30, 180).close();
    const hm = analyseTrack(buildTrack(design(pts), heightmapSampler(flatMap()))!);
    expect(hm.corners.map((c) => c.type)).toEqual(['hairpin', 'hairpin']);
    expect(hm.minRadius).toBeLessThan(35);
  });

  it('keeps a corner whole when it spans the first control point', () => {
    // Start the loop in the middle of a corner.
    const pts = new Turtle(2000, 2000, 0).arc(80, 45).straight(600).arc(80, 180).straight(600).arc(80, 135).close();
    const hm = analyseTrack(buildTrack(design(pts), heightmapSampler(flatMap()))!);
    expect(hm.corners).toHaveLength(2);
    for (const c of hm.corners) expect(c.angle).toBeGreaterThan(170);
  });
});
