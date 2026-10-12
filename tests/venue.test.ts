import { describe, expect, it } from 'vitest';
import { inside, standBlocks, STAND_DEPTH, STAND_ROOF } from '../src/core/scenery.ts';
import { barrierOffsets, venueSolids } from '../src/core/venue.ts';
import { bigRectangle, design, flatMap } from './helpers.ts';
import { circuit } from './tvFixture.ts';

describe('what stands round a track', () => {
  const c = circuit(design(bigRectangle(), { smoothing: 0, maxCutFill: 0 }), flatMap(100));
  const v = c.venue;

  it('is placed in one go: the pit building, the grandstands, the barriers, the gantries and the marshal posts', () => {
    expect(v.building).not.toBeNull();
    expect(v.stands.length).toBeGreaterThan(0);
    expect(v.barriers.length).toBeGreaterThan(0);
    expect(v.gantries.length).toBeGreaterThan(0);
    expect(v.posts.length).toBeGreaterThan(3);
    // Each clear of what was placed before it.
    for (const s of v.stands) {
      const mid = s.front[Math.floor(s.front.length / 2)];
      expect(inside(v.building!.footprint, mid.x + mid.ox * 7, mid.y + mid.oy * 7, 2)).toBe(false);
    }
    expect(v.footprints.length).toBeGreaterThanOrEqual(1 + v.stands.length + v.posts.length + 1);
  });

  it('says what of it is in the way of a view', () => {
    const solids = venueSolids(v);
    const kinds = new Set(solids.map((s) => s.kind));
    for (const kind of ['pit building', 'grandstand', 'gantry', 'marshal post'] as const) expect(kinds, kind).toContain(kind);
    for (const s of solids) {
      expect(s.x.length).toBeGreaterThanOrEqual(3);
      expect(s.hi).toBeGreaterThan(s.lo);
    }
    // The pit building garage by garage, its tower higher; a gantry's beam well over the road.
    const pit = solids.filter((s) => s.kind === 'pit building');
    expect(pit.length).toBe(v.building!.blocks.length);
    expect(Math.max(...pit.map((s) => s.hi))).toBeGreaterThan(Math.min(...pit.map((s) => s.hi)) + 5);
    for (const s of solids.filter((x) => x.kind === 'gantry')) expect(s.lo).toBeGreaterThan(5);
  });

  it('gives a grandstand as its rows, its back wall and its roof', () => {
    const s = v.stands[0];
    const blocks = standBlocks(s);
    expect(blocks.length).toBe(4 * (s.front.length - 1));
    expect(Math.max(...blocks.map((b) => b.hi))).toBeCloseTo(STAND_ROOF, 6);
    // The roof is a slab over the upper rows: open under it at the front.
    const roof = blocks.find((b) => b.lo > 10)!;
    expect(roof.hi - roof.lo).toBeLessThan(1);
    const a = s.front[0];
    const d = Math.hypot(roof.x[0] - a.x, roof.y[0] - a.y);
    expect(d).toBeGreaterThan(STAND_DEPTH * 0.25);
  });

  it('knows where the barrier stands at every station, and where it carries a fence', () => {
    const { offset, fence } = barrierOffsets(c.track, v.barriers);
    expect(offset[0].length).toBe(c.track.n);
    let known = 0;
    for (let k = 0; k < c.track.n; k++) {
      for (const side of [0, 1]) {
        if (!Number.isFinite(offset[side][k])) continue;
        known++;
        expect(offset[side][k]).toBeGreaterThan(c.track.width[k] / 2);
      }
    }
    expect(known).toBeGreaterThan(c.track.n);
    // Fenced at the line, opposite the pits.
    expect(fence[0][0] + fence[1][0]).toBeGreaterThan(0);
  });
});
