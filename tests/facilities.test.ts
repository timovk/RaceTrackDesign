import { describe, expect, it } from 'vitest';
import { analyseTrack } from '../src/core/analysis.ts';
import { overtakingZones, placeFacilities } from '../src/core/facilities.ts';
import { drsZones } from '../src/core/lapSim.ts';
import { Earthworks, builtGround, trackRoad } from '../src/core/earthworks.ts';
import { placeMarshalPosts, MAX_POST_SPACING } from '../src/core/marshals.ts';
import { analysePerformance } from '../src/core/performance.ts';
import { MIN_BOX_LENGTH, pitTimeLoss, placePitLane } from '../src/core/pitLane.ts';
import { GRID_SIZE, GRID_SLOT_SPACING, gridSlots, placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { DEFAULT_GRADING, buildTrack, type Track } from '../src/core/track.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { bigRectangle, chicaneCircuit, design } from './helpers.ts';

/** The ground as built round a track on natural ground `heightAt`. */
function asBuilt(t: Track, heightAt: (x: number, y: number) => number) {
  return builtGround(new Earthworks({ extent: 8192, waterLevel: -Infinity, cellSize: 4, height: heightAt }, [trackRoad(t)]));
}

const flat = () => 100;

function built(points = chicaneCircuit()): Track {
  return buildTrack(design(points, { smoothing: 0, maxCutFill: 0 }), flat)!;
}

describe('start/finish', () => {
  it('puts the start on the long straight with room before the first corner', () => {
    const raw = built();
    const sf = placeStartFinish(raw);
    // The 950 m top straight runs from station 0 (x 1050 to 2000).
    expect(raw.y[sf.station]).toBeCloseTo(1000, 0);
    expect(sf.firstCornerDistance).toBeGreaterThanOrEqual(250);
    expect(sf.gridMaxGradient).toBe(0);
    expect(sf.gridStraightness).toBe(1);
    expect(sf.overridden).toBe(false);
  });

  it('follows a hand-placed start line to the nearest station', () => {
    const raw = built();
    const sf = placeStartFinish(raw, { x: 2050, y: 1300 });
    expect(sf.overridden).toBe(true);
    expect(Math.hypot(raw.x[sf.station] - 2050, raw.y[sf.station] - 1300)).toBeLessThan(3);
  });

  it('rotates the track so the start line is station 0', () => {
    const raw = built();
    const t = rotateTrack(raw, 500);
    expect(t.n).toBe(raw.n);
    expect(t.length).toBeCloseTo(raw.length, 9);
    expect(t.x[0]).toBe(raw.x[500]);
    expect(t.curvature[10]).toBe(raw.curvature[510]);
    expect(t.s[0]).toBe(0);
    expect(t.pointStations[0]).toBe((raw.pointStations[0] - 500 + raw.n) % raw.n);
    expect(analyseTrack(t).corners.length).toBe(analyseTrack(raw).corners.length);
  });

  it('lays out a staggered grid behind the line', () => {
    const t = rotateTrack(built(), placeStartFinish(built()).station);
    const slots = gridSlots(t, true);
    expect(slots).toHaveLength(GRID_SIZE);
    expect(Math.hypot(slots[2].x - slots[0].x, slots[2].y - slots[0].y)).toBeCloseTo(2 * GRID_SLOT_SPACING, 0);
    // Pole and second place sit on opposite sides of the centreline.
    const side = (s: { x: number; y: number }) => Math.sign((s.x - t.x[0]) * Math.sin(t.heading[0]) - (s.y - t.y[0]) * Math.cos(t.heading[0]));
    expect(side(slots[0])).not.toBe(side(slots[1]));
  });
});

describe('pit lane', () => {
  const raw = built(bigRectangle());
  const t = rotateTrack(raw, placeStartFinish(raw).station);
  const perf = analysePerformance(t, VEHICLES);
  const f1 = perf.laps.find((l) => l.vehicleId === 'f1')!;
  const input = { track: t, line: perf.line, reference: f1, heightAt: flat, waterLevel: -Infinity, extent: 8192 };

  it('finds a clean pit lane beside the start straight', () => {
    const pit = placePitLane(input)!;
    expect(pit).not.toBeNull();
    expect(pit.problems).toEqual([]);
    expect(pit.adjacentToStart).toBe(true);
    expect(pit.boxLength).toBeGreaterThanOrEqual(MIN_BOX_LENGTH);
    expect(pit.width).toBeGreaterThanOrEqual(12);
    // Every point of the lane stays off the track surface.
    for (let i = 0; i < pit.x.length; i += 10) {
      let nearest = Infinity;
      for (let k = 0; k < t.n; k++) nearest = Math.min(nearest, Math.hypot(t.x[k] - pit.x[i], t.y[k] - pit.y[i]));
      if (i > pit.boxStart && i < pit.boxEnd) expect(nearest).toBeGreaterThan(t.width[0] / 2 + 5);
    }
  });

  it('costs every class time, F1 in a realistic range', () => {
    const pit = placePitLane(input)!;
    for (const lap of perf.laps) expect(pitTimeLoss(pit, lap, 60 / 3.6).loss).toBeGreaterThan(5);
    const loss = pitTimeLoss(pit, f1, 80 / 3.6).loss;
    expect(loss).toBeGreaterThan(12);
    expect(loss).toBeLessThan(35);
  });

  it('keeps out of water', () => {
    expect(placePitLane({ ...input, heightAt: () => -5, waterLevel: 0 })).toBeNull();
  });

  it('uses a hand-placed entry, exit and side', () => {
    const a = 100;
    const b = 400;
    const pit = placePitLane({ ...input, override: { entry: { x: t.x[a], y: t.y[a] }, exit: { x: t.x[b], y: t.y[b] }, side: 1 } })!;
    expect(pit.overridden).toBe(true);
    expect(pit.entry).toBe(a);
    expect(pit.exit).toBe(b);
    expect(pit.side).toBe(1);
  });
});

describe('other facilities', () => {
  const raw = built(bigRectangle());
  const sf = placeStartFinish(raw);
  const t = rotateTrack(raw, sf.station);
  const perf = analysePerformance(t, VEHICLES);

  it('places DRS zones on the longest straights, at most three', () => {
    const zones = drsZones(perf.line);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.length).toBeLessThanOrEqual(3);
    for (const z of zones) expect(z.length).toBeGreaterThanOrEqual(400);
  });

  it('finds overtaking spots at the end of the long straights', () => {
    const f1 = perf.laps.find((l) => l.vehicleId === 'f1')!;
    const zones = overtakingZones(f1, perf.line.ds);
    expect(zones.length).toBeGreaterThanOrEqual(2);
    for (const z of zones) {
      expect(z.speedDrop * 3.6).toBeGreaterThan(60);
      expect(z.runLength).toBeGreaterThan(250);
    }
  });

  it('spaces marshal posts at most 500 m apart on open ground', () => {
    const plan = placeMarshalPosts(t, flat);
    expect(plan.maxGap).toBeLessThanOrEqual(MAX_POST_SPACING);
    expect(plan.allLinked).toBe(true);
    expect(plan.unobserved).toBe(0);
    expect(plan.posts.length).toBeGreaterThanOrEqual(Math.ceil(t.length / MAX_POST_SPACING));
  });

  it('notices when high ground blocks the view', () => {
    const plan = placeMarshalPosts(t, (x, y) => (Math.hypot(x - 3750, y - 3400) < 300 ? 200 : 100));
    expect(plan.posts.length).toBeGreaterThanOrEqual(Math.ceil(t.length / MAX_POST_SPACING));
    // A hill inside the rectangle hides nothing along the straights, but the plan still links every post.
    expect(plan.maxGap).toBeLessThanOrEqual(MAX_POST_SPACING);
  });

  it('sees a stretch graded through a ridge along its cutting', () => {
    // A ridge 9 m high across the top straight; the grading digs the track through it.
    const ridge = (x: number, y: number) => 100 + (Math.abs(y - 3000) < 150 ? 9 * Math.max(0, 1 - Math.abs(x - 3750) / 40) : 0);
    const t = buildTrack(design(bigRectangle(), DEFAULT_GRADING), ridge)!;
    let k = 0;
    while (Math.abs(t.x[k] - 3750) > 2 || Math.abs(t.y[k] - 3000) > 5) k++;
    expect(ridge(t.x[k], t.y[k]) - t.z[k]).toBeGreaterThan(3);
    const plan = placeMarshalPosts(t, asBuilt(t, ridge));
    expect(plan.unobserved).toBe(0);
    expect(plan.allLinked).toBe(true);
    expect(plan.maxGap).toBeLessThanOrEqual(MAX_POST_SPACING);
    // Ordinary posts do: no platforms needed to see along a cutting.
    expect(plan.posts.some((p) => p.raised)).toBe(false);
  });

  it('links posts over a sharp crest, closer to the track or raised where it must', () => {
    // An ungraded track over a sharp bump 5 m high: from the usual places, posts on either side cannot see each other.
    const bump = (x: number, y: number) => 100 + (Math.abs(y - 3000) < 150 ? 5 * Math.max(0, 1 - Math.abs(x - 3750) / 12) : 0);
    const t = buildTrack(design(bigRectangle(), { smoothing: 0, maxCutFill: 0 }), bump)!;
    const plan = placeMarshalPosts(t, asBuilt(t, bump));
    expect(plan.unobserved).toBe(0);
    expect(plan.allLinked).toBe(true);
    expect(plan.maxGap).toBeLessThanOrEqual(MAX_POST_SPACING);
  });

  it('assembles every facility', () => {
    const f = placeFacilities({ track: t, startFinish: sf, performance: perf, vehicles: VEHICLES, heightAt: flat, waterLevel: -Infinity, extent: 8192, overrides: {} });
    expect(f.grid).toHaveLength(GRID_SIZE);
    expect(f.pitLane).not.toBeNull();
    expect(f.pitLoss).toHaveLength(VEHICLES.length);
    const f1 = perf.laps.find((l) => l.vehicleId === 'f1')!;
    expect(f1.v[f.speedTrap.station]).toBeGreaterThanOrEqual(Math.max(...f1.v) - 0.5);
    expect(f.marshals.posts.length).toBeGreaterThan(0);
  });
});
