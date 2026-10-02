import { describe, expect, it } from 'vitest';
import { BARRIER_GAP, FENCE_HEIGHT, barrierRuns, buildBarriers, buildFences, insideBarriers } from '../src/core/barriers.ts';
import { assessLicence } from '../src/core/licence.ts';
import { Earthworks, VERGE, pitRoad, trackRoad } from '../src/core/scene3d.ts';
import { TrackIndex, buildPitBuilding, inside, placeGrandstands, runoffAreas } from '../src/core/scenery.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { flatMap, makeHeightmap } from './helpers.ts';
import { facilities, metrics, performance, track as t } from './raceFixture.ts';

// The fixture is a big rectangle of right-hand corners on flat ground at 100 m.
const hm = flatMap(100);
const pit = facilities.pitLane!;
const roads = [trackRoad(t), pitRoad(pit, t)];
const earth = new Earthworks(hm, roads);
const index = new TrackIndex(t);
const licence = assessLicence({ track: t, metrics, issues: [], performance, facilities, heightmap: hm, vehicles: VEHICLES });
const areas = runoffAreas(t, metrics.corners, licence.runoff, earth, index);
const building = buildPitBuilding(pit, pitRoad(pit, t));
const stands = placeGrandstands(t, metrics.corners, facilities.overtaking, pit, areas, earth, [building.footprint]);
const avoid = [building.footprint, ...stands.map((s) => s.footprint)];
const runs = barrierRuns({ track: t, index, earth, runoff: areas, pit, stands, avoid });

const at = (k: number, side: number, offset: number) => {
  const h = t.heading[k];
  return [t.x[k] + Math.sin(h) * side * offset, t.y[k] - Math.cos(h) * side * offset] as const;
};
const runoffDepth = (k: number, side: number) => Math.max(0, ...areas.filter((a) => a.side === side && a.stations.includes(k)).map((a) => a.depth[a.stations.indexOf(k)]));

describe('barriers', () => {
  it('run along both sides, but not along the pit lane, where its wall is the barrier', () => {
    for (const side of [1, -1]) expect(runs.some((r) => r.side === side)).toBe(true);
    const along = (k: number) => ((k - pit.entry + t.n) % t.n) <= ((pit.exit - pit.entry + t.n) % t.n);
    for (const r of runs.filter((r) => r.side === pit.side)) for (const k of r.stations) expect(along(k)).toBe(false);
    // Most of the other side is lined.
    const lined = new Set(runs.filter((r) => r.side === -pit.side).flatMap((r) => r.stations));
    expect(lined.size).toBeGreaterThan(t.n * 0.9);
  });

  it('stand beyond the verge on flat ground, and just behind the run-off at the corners, with a tyre wall at a gravel trap', () => {
    let trapped = 0;
    for (const r of runs) {
      r.stations.forEach((k, i) => {
        const edge = t.width[k] / 2 + VERGE;
        const depth = runoffDepth(k, r.side);
        expect(r.offset[i]).toBeCloseTo(edge + Math.max(BARRIER_GAP, depth + 1.5), 6);
        expect(r.tyres[i]).toBe(depth > 3);
        if (r.tyres[i]) trapped++;
      });
    }
    expect(trapped).toBeGreaterThan(50);
  });

  it('keep clear of buildings and other roads', () => {
    for (const r of runs) {
      r.stations.forEach((k, i) => {
        const [x, y] = at(k, r.side, r.offset[i]);
        for (const f of avoid) expect(inside(f, x, y, 1.4)).toBe(false);
        expect(earth.clearance(x, y)).toBeGreaterThanOrEqual(VERGE + 0.5 - 1e-6);
      });
    }
  });

  it('carry catch fencing along the stands and by the line away from the pits', () => {
    const fenced = runs.flatMap((r) => r.stations.filter((_, i) => r.fence[i]).map((k) => ({ k, side: r.side })));
    expect(fenced.some((f) => f.side === -pit.side && f.k < 50)).toBe(true);
    if (stands.length) expect(fenced.length).toBeGreaterThan(50);
  });

  it('come in to the foot of a cutting rather than stand part way up its bank', () => {
    // The track 3 m down in a cutting all the way round.
    const cut = new Earthworks(flatMap(103), roads);
    const inCut = barrierRuns({ track: t, index, earth: cut, runoff: [], pit, stands: [], avoid: [] });
    for (const r of inCut) {
      r.stations.forEach((k, i) => {
        const edge = t.width[k] / 2 + VERGE;
        expect(r.offset[i]).toBeLessThan(edge + 2.6);
        const [x, y] = at(k, r.side, r.offset[i]);
        expect(cut.height(x, y)).toBeLessThan(100 + 1.2);
      });
    }
  });

  it('keep a steady line on bumpy ground', () => {
    const bumpy = new Earthworks(makeHeightmap((x, y) => 100 + 2 * Math.sin(x / 23) * Math.cos(y / 31), { size: 1024 }), roads);
    for (const r of barrierRuns({ track: t, index, earth: bumpy, runoff: [], pit, stands: [], avoid: [] })) {
      for (let i = 1; i < r.stations.length; i++) expect(Math.abs(r.offset[i] - r.offset[i - 1])).toBeLessThanOrEqual(t.ds + 1e-9);
    }
  });

  it('tell what lies between the track and them', () => {
    const behind = insideBarriers(t, runs, index);
    const r = runs.find((r) => r.side === -pit.side)!;
    const i = Math.floor(r.stations.length / 2);
    const k = r.stations[i];
    expect(behind(...at(k, r.side, r.offset[i] - 1), 0)).toBe(true);
    expect(behind(...at(k, r.side, r.offset[i] + 3), 0)).toBe(false);
    expect(behind(...at(k, r.side, r.offset[i] + 1), 1.5)).toBe(true);
  });

  it('are built at their real size on the ground', () => {
    const { steel, tyres } = buildBarriers(t, runs, earth);
    expect(steel.indices.length).toBeGreaterThan(1000);
    expect(tyres.indices.length).toBeGreaterThan(100);
    for (const m of [steel, tyres]) {
      for (let v = 0; v < m.positions.length / 3; v++) {
        const lift = m.positions[v * 3 + 1] - m.anchors![v];
        expect(lift).toBeGreaterThanOrEqual(-0.2 - 1e-4);
        expect(lift).toBeLessThan(FENCE_HEIGHT + 0.2);
      }
    }
    const fences = buildFences(t, runs, earth);
    expect(fences.uvs!.length).toBe((fences.positions.length / 3) * 2);
    for (let v = 0; v < fences.positions.length / 3; v++) {
      const lift = fences.positions[v * 3 + 1] - fences.anchors![v];
      expect(lift).toBeGreaterThanOrEqual(-1e-4);
      expect(lift).toBeLessThanOrEqual(FENCE_HEIGHT + 1e-4);
      // v runs up the fence in metres.
      expect(fences.uvs![v * 2 + 1]).toBeCloseTo(lift, 3);
    }
  });
});
