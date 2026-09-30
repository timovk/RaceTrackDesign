import { describe, expect, it } from 'vitest';
import { buildTrack } from '../src/core/track.ts';
import { ranges, validateTrack } from '../src/core/validate.ts';
import { Turtle, circlePoints, design, flatMap, makeHeightmap } from './helpers.ts';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('station ranges', () => {
  it('joins a run across the wrap-around', () => {
    const flags = [1, 1, 0, 0, 1, 0, 1, 1];
    expect(ranges(8, (k) => flags[k] === 1)).toEqual([[4, 4], [6, 1]]);
  });

  it('handles all and none', () => {
    expect(ranges(5, () => true)).toEqual([[0, 4]]);
    expect(ranges(5, () => false)).toEqual([]);
  });
});

describe('design warnings', () => {
  it('passes a clean circle', () => {
    const g = { smoothing: 60, maxCutFill: 12 };
    const t = buildTrack(design(circlePoints(4096, 4096, 400), g), flatMap())!;
    expect(validateTrack(t, flatMap(), g)).toEqual([]);
  });

  it('flags a figure of eight as a crossing', () => {
    const pts = [
      { x: 3000, y: 3000 }, { x: 3600, y: 3600 }, { x: 4200, y: 3000 }, { x: 4200, y: 3600 },
      { x: 3600, y: 3000 }, { x: 3000, y: 3600 },
    ].map((p) => ({ ...p, width: 12 }));
    const hm = flatMap();
    const t = buildTrack(design(pts), hm)!;
    const issues = validateTrack(t, hm, design(pts).grading);
    expect(codes(issues)).toContain('crossing');
    expect(codes(issues)).not.toContain('overlap');
  });

  it('flags steep gradients by severity', () => {
    const g = { smoothing: 0, maxCutFill: 0 };
    const steep = makeHeightmap((x) => 0.25 * x);
    const t = buildTrack(design(circlePoints(4096, 4096, 400), g), steep)!;
    const issues = validateTrack(t, steep, g);
    expect(codes(issues)).toContain('too-steep');
    expect(codes(issues)).toContain('steep');
    expect(issues[0].severity).toBe('error');
  });

  it('flags a corner tighter than the track is wide', () => {
    const pts = new Turtle(2000, 2000, 0, 3).straight(400).arc(5, 180).straight(400).arc(60, 180).close();
    const hm = flatMap();
    const t = buildTrack(design(pts), hm)!;
    expect(codes(validateTrack(t, hm, design(pts).grading))).toContain('too-tight');
  });

  it('flags track through water and off the map', () => {
    const hm = makeHeightmap((x) => x / 100, { waterLevel: 20 });
    const t = buildTrack(design(circlePoints(300, 4096, 600)), hm)!;
    const found = codes(validateTrack(t, hm, design([]).grading));
    expect(found).toContain('water');
    expect(found).toContain('off-map');
  });

  it('flags parallel stretches with no room between them', () => {
    // A long thin loop: the two straights are 20 m apart centre to centre, leaving 8 m between edges.
    const pts = new Turtle(2000, 2000, 0, 10).straight(800).arc(10, 180).straight(800).arc(10, 180).close();
    const hm = flatMap();
    const t = buildTrack(design(pts), hm)!;
    expect(codes(validateTrack(t, hm, design(pts).grading))).toContain('close');
  });
});
