import { describe, expect, it } from 'vitest';
import {
  CUT_SLOPE, Earthworks, FILL_SLOPE, MIN_CELL, type MeshData, type Road, SINK, VERGE, buildRoads, buildSides, buildTerrain, pitRoad, startLine, terrainLeaves, trackRoad,
} from '../src/core/scene3d.ts';
import { buildTrack, heightmapSampler } from '../src/core/track.ts';
import { facilities, track as fixtureTrack } from './raceFixture.ts';
import { circlePoints, design, flatMap, makeHeightmap } from './helpers.ts';

/** A straight open road along x at y = 2000, from x = 1000 to 3000, at height z and 12 m wide. */
function straight(z: number): Road {
  const n = 101;
  const x = new Float64Array(n);
  const y = new Float64Array(n).fill(2000);
  for (let i = 0; i < n; i++) x[i] = 1000 + i * 20;
  return { x, y, z: new Float64Array(n).fill(z), half: new Float64Array(n).fill(6), closed: false };
}

/** Normals of every triangle, from its winding. */
function faceNormals(m: MeshData): { nx: number; ny: number; nz: number; cx: number; cz: number }[] {
  const p = m.positions;
  const out = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // Zero-area triangles (where a side panel runs out) have no direction.
    if (len < 1e-9) continue;
    out.push({ nx: nx / len, ny: ny / len, nz: nz / len, cx: (p[a] + p[b] + p[c]) / 3, cz: (p[a + 2] + p[b + 2] + p[c + 2]) / 3 });
  }
  return out;
}

/** Whether each terrain vertex belongs to a patch's grid (not its skirt): each patch lists its grid, then the skirt. */
function gridVertices(leaves: { cells: number }[]): boolean[] {
  const out: boolean[] = [];
  for (const l of leaves) {
    for (let i = 0; i < (l.cells + 1) ** 2; i++) out.push(true);
    for (let i = 0; i < 4 * l.cells; i++) out.push(false);
  }
  return out;
}

describe('earthworks', () => {
  const hm = flatMap(100);

  it('builds an embankment down from a road above the ground', () => {
    const earth = new Earthworks(hm, [straight(120)]);
    // Under the road and its verge, a little below the surface.
    expect(earth.height(2000, 2000)).toBeCloseTo(120 - SINK, 6);
    expect(earth.lastRoad).toBe(true);
    // Down the bank at 1 in 2 from the verge edge.
    const edge = 6 + VERGE;
    const verge = 120 - 0.03 * VERGE;
    expect(earth.height(2000, 2000 + edge + 4)).toBeCloseTo(verge - FILL_SLOPE * 4, 6);
    expect(earth.lastBank).toBeGreaterThan(15);
    // Where the bank meets the ground, the natural ground again.
    expect(earth.height(2000, 2000 + edge + 60)).toBeCloseTo(100, 6);
    expect(earth.height(2000, 2600)).toBe(100);
  });

  it('cuts into higher ground', () => {
    const earth = new Earthworks(hm, [straight(80)]);
    const edge = 6 + VERGE;
    expect(earth.height(2000, 2000 - edge - 4)).toBeCloseTo(80 - 0.03 * VERGE + CUT_SLOPE * 4, 6);
    expect(earth.lastBank).toBeLessThan(-10);
  });

  it('leaves the ground alone beside a road at ground level, apart from the verge', () => {
    const earth = new Earthworks(hm, [straight(100)]);
    expect(earth.height(2000, 2000 + 6 + VERGE + 5)).toBeCloseTo(100, 6);
  });

  it('copes with two roads at different heights close together', () => {
    const low = straight(90);
    const high = { ...straight(110), y: new Float64Array(101).fill(2030) };
    const earth = new Earthworks(hm, [low, high]);
    for (let y = 2000; y <= 2030; y += 1) {
      const z = earth.height(2000, y);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeGreaterThan(89 - SINK - 0.01);
      expect(z).toBeLessThan(110.01);
    }
  });
});

describe('terrain mesh', () => {
  // A hillside: 8% up to the east, and a circuit graded across it.
  const hm = makeHeightmap((x) => 100 + 0.08 * (x - 4096), { size: 256, extent: 8192 });
  const t = buildTrack(design(circlePoints(4096, 4096, 400, 16)), heightmapSampler(hm))!;
  const roads = [trackRoad(t)];
  const mesh = buildTerrain(hm, roads);

  it('is finest near the track and coarse far from it', () => {
    const leaves = terrainLeaves(hm, roads);
    expect(Math.min(...leaves.map((l) => l.size / l.cells))).toBe(MIN_CELL);
    expect(Math.max(...leaves.map((l) => l.size / l.cells))).toBe(32);
    expect(mesh.finest).toBe(MIN_CELL);
    expect(mesh.positions.length / 3).toBeLessThan(800_000);
  });

  it('faces up everywhere, with skirts standing upright', () => {
    for (const f of faceNormals(mesh)) expect(f.ny).toBeGreaterThan(-1e-6);
  });

  it('sits just under the track and on the natural ground far away', () => {
    const p = mesh.positions;
    const grid = gridVertices(terrainLeaves(hm, roads));
    expect(grid).toHaveLength(p.length / 3);
    let under = 0;
    for (let v = 0; v < p.length / 3; v++) {
      if (!grid[v]) continue;
      const x = p[v * 3];
      const z = p[v * 3 + 2];
      const r = Math.hypot(x - 4096, z - 4096);
      if (Math.abs(r - 400) < 3) {
        // Within half the track width of the centreline: below the surface at the nearest station.
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k < t.n; k++) {
          const d = Math.hypot(t.x[k] - x, t.y[k] - z);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        expect(p[v * 3 + 1]).toBeLessThan(t.z[best] - SINK + 0.2);
        under++;
      }
      if (r > 900 && r < 1000 && mesh.bank[v] === 0) expect(p[v * 3 + 1]).toBeCloseTo(100 + 0.08 * (x - 4096), 3);
    }
    expect(under).toBeGreaterThan(100);
    // The graded track crosses the slope, so there is fill on one side and cut on the other.
    let fill = 0;
    let cut = 0;
    for (const b of mesh.bank) {
      if (b > 1) fill++;
      if (b < -1) cut++;
    }
    expect(fill).toBeGreaterThan(0);
    expect(cut).toBeGreaterThan(0);
  });
});

describe('roads', () => {
  const t = fixtureTrack;
  const { paved, verges } = buildRoads([{ road: trackRoad(t), style: { surface: [0.2, 0.2, 0.2], lines: true } }]);

  it('faces the paved surface up and lies at track height', () => {
    for (const f of faceNormals(paved)) expect(f.ny).toBeGreaterThan(0.9);
    for (let v = 0; v < paved.positions.length / 3; v++) expect(paved.positions[v * 3 + 1]).toBeCloseTo(100, 6);
    // Five strips (asphalt, line, asphalt, line, asphalt) of two vertices per station.
    expect(paved.positions.length / 3).toBe(t.n * 10);
  });

  it('adds verges and skirts that face up or outwards', () => {
    for (const f of faceNormals(verges)) expect(f.ny).toBeGreaterThan(-1e-6);
    const outward = faceNormals(verges).filter((f) => Math.abs(f.ny) < 1e-3);
    expect(outward.length).toBeGreaterThan(0);
  });

  it('colours the surface per station when asked', () => {
    const colours = new Float32Array(t.n * 3);
    for (let k = 0; k < t.n; k++) colours[k * 3] = k / t.n;
    const { paved: tinted } = buildRoads([{ road: trackRoad(t), style: { surface: colours, lines: false } }]);
    expect(tinted.positions.length / 3).toBe(t.n * 2);
    expect(tinted.colors![0]).toBe(0);
    expect(tinted.colors![(t.n - 1) * 6]).toBeCloseTo((t.n - 1) / t.n, 6);
  });

  it('draws the start line across the track', () => {
    const line = startLine(t);
    expect(line.indices).toHaveLength(6);
    for (const f of faceNormals(line)) expect(f.ny).toBeGreaterThan(0.99);
  });

  it('makes the pit lane level with the track beside it, narrower where it joins', () => {
    const pit = facilities.pitLane!;
    const road = pitRoad(pit, t);
    expect(road.closed).toBe(false);
    for (let i = 0; i < road.z.length; i++) expect(road.z[i]).toBeCloseTo(100, 6);
    const mid = Math.floor(road.half.length / 2);
    expect(road.half[mid]).toBeCloseTo(pit.width / 2, 6);
    expect(road.half[0]).toBeLessThan(pit.width / 2);
  });
});

describe('model base', () => {
  it('stands on the base and faces outwards, with water up to the water level at the edge', () => {
    const hm = makeHeightmap((x) => 40 + 0.02 * x, { size: 128, extent: 4096, waterLevel: 60 });
    const earth = new Earthworks(hm, []);
    const sides = buildSides(earth, 0);
    const p = sides.positions;
    let bottom = 0;
    let water = 0;
    for (let v = 0; v < p.length / 3; v++) {
      if (p[v * 3 + 1] === 0) bottom++;
      if (sides.colors![v * 3 + 2] > 0.5) water++;
    }
    expect(bottom).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);
    for (const f of faceNormals(sides)) {
      // Outward: the normal points away from the map centre.
      const out = f.nx * (f.cx - 2048) + f.nz * (f.cz - 2048);
      expect(out).toBeGreaterThan(0);
    }
  });
});
