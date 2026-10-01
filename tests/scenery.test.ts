import { describe, expect, it } from 'vitest';
import { assessLicence } from '../src/core/licence.ts';
import { Earthworks, type MeshData, VERGE, pitRoad, trackRoad } from '../src/core/scene3d.ts';
import {
  KERB_WIDTH, TrackIndex, buildGrandstands, buildGridMarks, buildKerbs, buildPitBuilding, buildRunoff, forest, inside, kerbRuns, placeGrandstands, placeTrees, runoffAreas, runoffTest,
} from '../src/core/scenery.ts';
import { clearView, flyoverPose, hotLapPose, trackShots } from '../src/core/shots.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { flatMap } from './helpers.ts';
import { facilities, metrics, performance, track as t } from './raceFixture.ts';

// The fixture is a big rectangle of right-hand corners on flat ground at 100 m.
const hm = flatMap(100);
const pit = facilities.pitLane!;
const roads = [trackRoad(t), pitRoad(pit, t)];
const earth = new Earthworks(hm, roads);
const index = new TrackIndex(t);
const licence = assessLicence({ track: t, metrics, issues: [], performance, facilities, heightmap: hm, vehicles: VEHICLES });
const areas = runoffAreas(t, metrics.corners, licence.runoff, earth, index);

/** Every triangle's normal, skipping degenerate ones. */
function normals(m: MeshData): { nx: number; ny: number; nz: number }[] {
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
    if (len > 1e-9) out.push({ nx: nx / len, ny: ny / len, nz: nz / len });
  }
  return out;
}

describe('kerbs', () => {
  const line = performance.line;
  const runs = kerbRuns(t, line, metrics.corners);

  it('go where the racing line runs to the edge in a corner: apex, exit and entry', () => {
    // Four right-hand corners: apex kerbs on the right (the line misses the inside edge at one of them), entry and exit kerbs on the left.
    expect(runs.filter((r) => r.side === -1).length).toBeGreaterThanOrEqual(3);
    expect(runs.filter((r) => r.side === 1).length).toBeGreaterThanOrEqual(4);
    expect(new Set(runs.map((r) => r.side))).toEqual(new Set([1, -1]));
    for (const r of runs) {
      // Somewhere in each run the line is right at that edge.
      let k = r.from;
      let touches = false;
      for (let i = 0; i < t.n && !touches; i++, k = (k + 1) % t.n) {
        touches = r.side * line.offset[k] > t.width[k] / 2 - 2;
        if (k === r.to) break;
      }
      expect(touches).toBe(true);
    }
  });

  it('are built just outside the edge, raised a little, facing up or outwards', () => {
    const mesh = buildKerbs(t, runs);
    expect(mesh.positions.length).toBeGreaterThan(0);
    for (const f of normals(mesh)) expect(f.ny).toBeGreaterThan(-1e-6);
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const y = mesh.positions[v * 3 + 1];
      expect(y).toBeGreaterThan(100 - 0.3);
      expect(y).toBeLessThan(100.1);
    }
    expect(KERB_WIDTH).toBeLessThan(VERGE);
  });
});

describe('run-off', () => {
  it('lies outside every corner, as deep as the escape paths allow', () => {
    expect(areas).toHaveLength(metrics.corners.length);
    for (const a of areas) {
      // Right-hand corners: the outside is on the left.
      expect(a.side).toBe(1);
      const rays = licence.runoff.filter((r) => r.corner === a.corner);
      const room = Math.max(...rays.map((r) => Math.min(r.required, r.free))) * 0.75;
      expect(Math.max(...a.depth)).toBeGreaterThan(room - 2.01);
      expect(Math.max(...a.depth)).toBeLessThanOrEqual(room + 1e-9);
    }
    // Nearly flat on flat ground: from the verge's edge (which falls away from the track) a few
    // centimetres up onto the ground, then just above it.
    const mesh = buildRunoff(t, areas, earth);
    for (const f of normals(mesh)) expect(f.ny).toBeGreaterThan(0.95);
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      expect(mesh.positions[v * 3 + 1]).toBeGreaterThan(100 - VERGE * 0.03 - 1e-9);
      expect(mesh.positions[v * 3 + 1]).toBeLessThan(100.2 + 1e-9);
    }
  });

  it('can be tested for a point beside the track', () => {
    const test = runoffTest(t, areas, index);
    const c = metrics.corners[0];
    const h = t.heading[c.apex];
    const at = (off: number) => [t.x[c.apex] + Math.sin(h) * off, t.y[c.apex] - Math.cos(h) * off] as const;
    expect(test(...at(t.width[c.apex] / 2 + VERGE + 5), 0)).toBe(true);
    // Inside the corner there is none.
    expect(test(...at(-(t.width[c.apex] / 2 + VERGE + 5)), 0)).toBe(false);
  });
});

describe('buildings', () => {
  const road = pitRoad(pit, t);
  const building = buildPitBuilding(pit, road);

  it('puts the pit building on the far side of the pit lane, off the track', () => {
    expect(building.mesh.positions.length).toBeGreaterThan(0);
    for (let k = 0; k < t.n; k += 5) expect(inside(building.footprint, t.x[k], t.y[k])).toBe(false);
    // Beyond the lane, away from the track, at the middle of the boxes.
    const i = Math.floor((pit.boxStart + pit.boxEnd) / 2);
    const dx = pit.x[i + 1] - pit.x[i];
    const dy = pit.y[i + 1] - pit.y[i];
    const len = Math.hypot(dx, dy);
    const off = pit.width / 2 + 10;
    expect(inside(building.footprint, pit.x[i] + (dy / len) * pit.side * off, pit.y[i] - (dx / len) * pit.side * off)).toBe(true);
    expect(inside(building.footprint, pit.x[i], pit.y[i])).toBe(false);
  });

  it('places grandstands clear of the track and the pits', () => {
    const stands = placeGrandstands(t, metrics.corners, facilities.overtaking, pit, areas, earth, [building.footprint]);
    expect(stands.length).toBeGreaterThanOrEqual(2);
    for (const s of stands) {
      for (let k = 0; k < t.n; k += 3) expect(inside(s.footprint, t.x[k], t.y[k], t.width[k] / 2)).toBe(false);
      for (const p of s.front) expect(earth.clearance(p.x, p.y)).toBeGreaterThan(VERGE);
    }
    const mesh = buildGrandstands(stands);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it('marks the grid boxes on the track', () => {
    const marks = buildGridMarks(t, facilities.grid, index);
    expect(marks.indices).toHaveLength(facilities.grid.length * 6);
    for (const f of normals(marks)) expect(f.ny).toBeGreaterThan(0.99);
  });
});

describe('trees', () => {
  const test = runoffTest(t, areas, index);
  const avoid = (x: number, y: number) => test(x, y, 10);
  const woods = forest(hm, 'seed');
  const trees = placeTrees(earth, woods, avoid);

  it('grow from the terrain seed, the same every time', () => {
    expect(trees.count).toBeGreaterThan(1000);
    expect([...forest(hm, 'seed').slice(0, 50)]).toEqual([...woods.slice(0, 50)]);
    expect([...forest(hm, 'other').slice(0, 50)]).not.toEqual([...woods.slice(0, 50)]);
  });

  it('keep off the track, its verges and the run-off', () => {
    for (let i = 0; i < trees.count; i++) {
      const x = trees.data[i * 5];
      const y = trees.data[i * 5 + 2];
      expect(earth.clearance(x, y)).toBeGreaterThanOrEqual(20);
      expect(avoid(x, y)).toBe(false);
      expect(trees.data[i * 5 + 1]).toBeCloseTo(100 - 0.3, 3);
    }
  });
});

describe('camera shots', () => {
  const height = (x: number, y: number) => earth.height(x, y);
  const shots = trackShots({ track: t, metrics, pit, height, runoff: (k, side) => {
    const a = areas.find((r) => r.side === side && r.stations.includes(k));
    return a ? a.depth[a.stations.indexOf(k)] : 0;
  } });

  it('has the start, the pit lane, every corner and the highest point, each with a clear view', () => {
    const ids = shots.map((s) => s.id);
    expect(ids).toContain('start');
    expect(ids).toContain('pit');
    expect(ids).toContain('high');
    for (const c of metrics.corners) expect(ids).toContain(`corner-${c.number}`);
    // Flat ground: no climb or drop to show.
    expect(ids).not.toContain('climb');
    for (const s of shots) {
      expect(s.camera[2]).toBeGreaterThan(height(s.camera[0], s.camera[1]) + 1.9);
      expect(clearView(s.camera, s.target, height)).toEqual(s.camera);
    }
    // Corner shots stand outside the corner, beyond the run-off.
    const c = metrics.corners[0];
    const shot = shots.find((s) => s.id === `corner-${c.number}`)!;
    expect(index.lateral(c.apex, shot.camera[0], shot.camera[1])).toBeGreaterThan(t.width[c.apex] / 2 + VERGE + 30);
    // The pit shot looks at the garage fronts: from the far side of the lane, looking back along the boxes.
    const pitShot = shots.find((s) => s.id === 'pit')!;
    const e = pit.boxEnd;
    const dx = pit.x[e] - pit.x[e - 10];
    const dy = pit.y[e] - pit.y[e - 10];
    const across = (p: number[]) => ((p[0] - pit.x[e]) * dy - (p[1] - pit.y[e]) * dx) * pit.side;
    expect(across(pitShot.camera)).toBeLessThan(0);
    expect(across(pitShot.target)).toBeGreaterThan(0);
    expect((pitShot.target[0] - pitShot.camera[0]) * dx + (pitShot.target[1] - pitShot.camera[1]) * dy).toBeLessThan(0);
  });

  it('raises a camera to see over a hill', () => {
    const ridge = (x: number) => (Math.abs(x - 50) < 5 ? 40 : 0);
    const cam = clearView([0, 0, 5], [100, 0, 1], (x) => ridge(x));
    expect(cam[2]).toBeGreaterThan(40);
  });

  it('drives the hot lap on the racing line at the lap\'s pace, and flies over the track', () => {
    const lap = performance.laps.find((l) => l.vehicleId === 'f1')!;
    const a = hotLapPose(t, performance.line, lap, 0, 1);
    expect(a.camera[0]).toBeCloseTo(performance.line.x[0], 6);
    expect(a.camera[2]).toBeCloseTo(t.z[0] + 1, 6);
    // After t seconds the camera is where the lap says the car is.
    const k = Math.floor(t.n / 3);
    const b = hotLapPose(t, performance.line, lap, lap.t[k], 1);
    expect(Math.hypot(b.camera[0] - performance.line.x[k], b.camera[1] - performance.line.y[k])).toBeLessThan(0.01);
    expect(Math.hypot(b.target[0] - b.camera[0], b.target[1] - b.camera[1])).toBeGreaterThan(30);
    const fly = flyoverPose(t, 500, height);
    expect(fly.camera[2]).toBeGreaterThan(height(fly.camera[0], fly.camera[1]) + 30);
  });
});
