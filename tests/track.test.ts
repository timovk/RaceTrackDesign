import { describe, expect, it } from 'vitest';
import { sampleClosedSpline, simplifyPolyline, smoothCircular } from '../src/core/geometry.ts';
import { buildTrack, gradeProfile } from '../src/core/track.ts';
import { circlePoints, design, flatMap, makeHeightmap } from './helpers.ts';

describe('closed spline', () => {
  it('passes through every control point and closes', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 90 }, { x: 10, y: 60 }];
    const dense = sampleClosedSpline(pts);
    for (let i = 0; i < pts.length; i++) {
      const hit = dense.find((d) => d.seg === i && d.u === 0)!;
      expect(hit.x).toBeCloseTo(pts[i].x, 9);
      expect(hit.y).toBeCloseTo(pts[i].y, 9);
    }
    const last = dense[dense.length - 1];
    expect(last.x).toBe(pts[0].x);
    expect(last.y).toBe(pts[0].y);
  });
});

describe('geometry helpers', () => {
  it('smooths without changing the mean of a closed signal', () => {
    const src = Array.from({ length: 200 }, (_, i) => (i % 20 < 10 ? 1 : -1) + 3);
    const out = smoothCircular(src, 5);
    const mean = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0) / a.length;
    expect(mean(out)).toBeCloseTo(mean(src), 9);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThan(1);
  });

  it('simplifies a noisy straight line to its ends', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 10, y: (i % 2) * 0.5 }));
    expect(simplifyPolyline(pts, 2)).toHaveLength(2);
  });
});

describe('track stations', () => {
  const R = 300;
  const circle = buildTrack(design(circlePoints(4096, 4096, R)), flatMap())!;

  it('measures a circle close to 2 pi r', () => {
    expect(circle.length).toBeGreaterThan(2 * Math.PI * R * 0.995);
    expect(circle.length).toBeLessThan(2 * Math.PI * R * 1.005);
  });

  it('spaces stations evenly at about 2 m', () => {
    expect(circle.ds).toBeGreaterThan(1.9);
    expect(circle.ds).toBeLessThan(2.1);
    expect(circle.n * circle.ds).toBeCloseTo(circle.length, 6);
  });

  it('gives a clockwise circle positive curvature of 1/r', () => {
    let sum = 0;
    for (let k = 0; k < circle.n; k++) sum += circle.curvature[k];
    expect(sum / circle.n).toBeCloseTo(1 / R, 4);
    for (let k = 0; k < circle.n; k++) {
      expect(circle.curvature[k]).toBeGreaterThan(0.9 / R);
      expect(circle.curvature[k]).toBeLessThan(1.1 / R);
    }
  });

  it('puts the left edge outside a clockwise circle', () => {
    const k = 100;
    const dl = Math.hypot(circle.leftX[k] - 4096, circle.leftY[k] - 4096);
    const dr = Math.hypot(circle.rightX[k] - 4096, circle.rightY[k] - 4096);
    expect(dl).toBeCloseTo(R + 6, 0);
    expect(dr).toBeCloseTo(R - 6, 0);
  });

  it('blends width between control points', () => {
    const pts = circlePoints(4096, 4096, R, 4);
    pts[0].width = 10;
    pts[1].width = 20;
    pts[2].width = 10;
    pts[3].width = 10;
    const t = buildTrack(design(pts), flatMap())!;
    expect(t.width[t.pointStations[0]]).toBeCloseTo(10, 1);
    expect(t.width[t.pointStations[1]]).toBeCloseTo(20, 1);
    const mid = Math.round((t.pointStations[0] + t.pointStations[1]) / 2);
    expect(t.width[mid]).toBeGreaterThan(12);
    expect(t.width[mid]).toBeLessThan(18);
  });

  it('needs at least three points', () => {
    expect(buildTrack(design(circlePoints(4096, 4096, R, 2)), flatMap())).toBeNull();
  });

  it('reads gradients from a tilted plane', () => {
    const tilt = makeHeightmap((x) => 0.05 * x);
    const t = buildTrack(design(circlePoints(4096, 4096, R), { smoothing: 0, maxCutFill: 0 }), tilt)!;
    let max = 0;
    for (let k = 0; k < t.n; k++) max = Math.max(max, t.gradient[k]);
    expect(max).toBeGreaterThan(0.048);
    expect(max).toBeLessThan(0.052);
  });
});

describe('grading', () => {
  it('smooths bumps but respects the cut and fill limit', () => {
    const n = 2000;
    // Long hills plus short bumps every 20 m.
    const terrain = Float64Array.from({ length: n }, (_, k) => 100 + 20 * Math.sin((2 * Math.PI * k) / 200) + 2 * Math.sin((2 * Math.PI * k) / 10));
    const z = gradeProfile(terrain, 2, { smoothing: 80, maxCutFill: 5 });
    let maxDev = 0;
    let rough = 0;
    let roughT = 0;
    for (let k = 1; k < n - 1; k++) {
      maxDev = Math.max(maxDev, Math.abs(z[k] - terrain[k]));
      rough += Math.abs(z[k + 1] - 2 * z[k] + z[k - 1]);
      roughT += Math.abs(terrain[k + 1] - 2 * terrain[k] + terrain[k - 1]);
    }
    expect(maxDev).toBeLessThanOrEqual(5 + 1e-9);
    expect(rough).toBeLessThan(roughT / 10);
  });

  it('follows the terrain exactly with no smoothing', () => {
    const terrain = Float64Array.from({ length: 100 }, (_, k) => k % 5);
    expect(gradeProfile(terrain, 2, { smoothing: 0, maxCutFill: 10 })).toEqual(terrain);
  });
});
