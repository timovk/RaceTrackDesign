import { describe, expect, it } from 'vitest';
import { barrierRuns } from '../src/core/barriers.ts';
import { assessLicence } from '../src/core/licence.ts';
import type { SkidMark } from '../src/core/race/sim.ts';
import { Earthworks, type MeshData, pitRoad, trackRoad } from '../src/core/scene3d.ts';
import { STAND_DEPTH, STAND_RISE, STAND_ROWS, TrackIndex, buildPitBuilding, inside, placeGrandstands, runoffAreas } from '../src/core/scenery.ts';
import { ATLAS, NUMBERS, PanelBuilder, SIGNS, START_SIGN, cellUv, numberCell, signCell } from '../src/core/signs.ts';
import { buildTrack } from '../src/core/track.ts';
import { brakingMarks, buildBoards, buildGantries, buildSkidMarks, placeBoards, placeGantries, roadHeight, seatCrowd } from '../src/core/trackside.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { bigRectangle, design, flatMap } from './helpers.ts';
import { car, facilities, metrics, performance, race, start, track as t } from './raceFixture.ts';

// The fixture is a big rectangle of right-hand corners on flat ground at 100 m.
const hm = flatMap(100);
const pit = facilities.pitLane!;
const road = pitRoad(pit, t);
const earth = new Earthworks(hm, [trackRoad(t), road]);
const index = new TrackIndex(t);
const licence = assessLicence({ track: t, metrics, issues: [], performance, facilities, heightmap: hm, vehicles: VEHICLES });
const areas = runoffAreas(t, metrics.corners, licence.runoff, earth, index);
const building = buildPitBuilding(pit, road, { x: t.x[0], y: t.y[0] });
const stands = placeGrandstands(t, metrics.corners, facilities.overtaking, pit, areas, earth, [building.footprint]);
const avoid = [building.footprint, ...stands.map((s) => s.footprint)];
const runs = barrierRuns({ track: t, index, earth, runoff: areas, pit, stands, avoid });

const mod = (a: number, n: number) => ((a % n) + n) % n;
/** Metres round the lap from the line to station k, the shorter way. */
const fromLine = (k: number) => Math.min(mod(k, t.n), mod(-k, t.n)) * t.ds;

/**
 * Checks that every face of a textured mesh shows its picture upright and
 * unmirrored to someone looking at the side it faces: from its first corner
 * the picture runs to that viewer's right and upwards, and the triangles
 * face the way the normal says.
 */
function expectReadable(m: MeshData): void {
  const p = m.positions;
  const uv = m.uvs!;
  expect(p.length / 3).toBe((m.indices.length / 6) * 4);
  for (let v = 0; v < p.length / 3; v += 4) {
    const at = (i: number) => [p[(v + i) * 3], p[(v + i) * 3 + 1], p[(v + i) * 3 + 2]];
    const [a, b, c, d] = [at(0), at(1), at(2), at(3)];
    const n = [m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]];
    // Looking against the normal, the viewer's right (x east, z south).
    const right = [n[2], 0, -n[0]];
    expect((b[0] - a[0]) * right[0] + (b[2] - a[2]) * right[2]).toBeGreaterThan(0);
    expect(d[1]).toBeGreaterThan(a[1]);
    expect(c[1]).toBeGreaterThan(b[1]);
    expect(uv[(v + 1) * 2]).toBeGreaterThan(uv[v * 2]);
    expect(uv[(v + 3) * 2 + 1]).toBeGreaterThan(uv[v * 2 + 1]);
    expect(uv[(v + 2) * 2]).toBeCloseTo(uv[(v + 1) * 2], 9);
    expect(uv[(v + 2) * 2 + 1]).toBeCloseTo(uv[(v + 3) * 2 + 1], 9);
  }
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const facing = (uy * vz - uz * vy) * m.normals[a] + (uz * vx - ux * vz) * m.normals[a + 1] + (ux * vy - uy * vx) * m.normals[a + 2];
    expect(facing).toBeGreaterThan(0);
  }
}

/** The length of a tyre mark, metres. */
const markLength = (m: SkidMark) => m.points.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - m.points[i].x, q.y - m.points[i].y), 0);

describe('signs', () => {
  it('each have a cell of their own in the picture, the numbers under the words', () => {
    const cells = [...SIGNS.map((_, i) => signCell(i)), ...Array.from({ length: NUMBERS }, (_, i) => numberCell(i + 1))];
    for (const [x, y, w, h] of cells) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(ATLAS.width);
      expect(y + h).toBeLessThanOrEqual(ATLAS.height);
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const [a, b] = [cells[i], cells[j]];
        expect(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]).toBe(true);
      }
    }
    // A sign is four times as long as it is high, as the boards are.
    expect(signCell(0)[2] / signCell(0)[3]).toBe(4);
    // Out of range, a number takes the nearest there is.
    expect(numberCell(0)).toEqual(numberCell(1));
    expect(numberCell(999)).toEqual(numberCell(NUMBERS));
  });

  it('give texture coordinates with the top of the picture at 1, a little inside the cell', () => {
    const [left, bottom, right, top] = cellUv(signCell(0));
    expect(left).toBeCloseTo(2 / ATLAS.width, 9);
    expect(right).toBeCloseTo(510 / ATLAS.width, 9);
    expect(top).toBeCloseTo(1 - 2 / ATLAS.height, 9);
    expect(bottom).toBeCloseTo(1 - 126 / ATLAS.height, 9);
  });

  it('are shown the right way round from the side a panel faces, whichever way its corners run', () => {
    // A panel facing south, its corners given from the west (the left of someone looking at it from the south).
    const corners = [[0, 0, 0, 0], [2, 0, 0, 0], [2, 1, 0, 0], [0, 1, 0, 0]] as const;
    const south = new PanelBuilder();
    south.face(corners, [0, 0, 1], [0, 0, 1, 1]);
    expectReadable(south.build());
    // Facing north, the same corners would show it mirrored: from the east then.
    const north = new PanelBuilder();
    north.face([corners[1], corners[0], corners[3], corners[2]], [0, 0, -1], [0, 0, 1, 1]);
    expectReadable(north.build());
    expect(north.build().anchors).toEqual(new Float32Array([0, 0, 0, 0]));
  });
});

describe('advertising boards', () => {
  const boards = placeBoards(t, runs, metrics.corners, earth);
  const built = buildBoards(boards);

  it('stand at the line and round the outside of the corners, nowhere else', () => {
    expect(boards.length).toBeGreaterThan(100);
    expect(boards.some((b) => fromLine(b.station) < 100)).toBe(true);
    for (const c of metrics.corners) {
      // The fixture's corners are right-handers: their outside is on the left.
      expect(c.direction).toBe('right');
      const len = mod(c.end - c.start, t.n);
      expect(boards.some((b) => b.side === 1 && mod(b.station - c.start, t.n) <= len)).toBe(true);
    }
    for (const b of boards) {
      const atCorner = metrics.corners.some((c) => mod(b.station - (c.start - Math.round(25 / t.ds)), t.n) <= mod(c.end - c.start, t.n) + Math.round(70 / t.ds));
      expect(fromLine(b.station) <= 171 || (atCorner && b.side === 1)).toBe(true);
    }
  });

  it('stand in front of the rail, off the road', () => {
    for (const b of boards) {
      const run = runs.find((r) => r.side === b.side && r.stations.includes(b.station))!;
      const rail = run.offset[run.stations.indexOf(b.station)];
      const off = index.lateral(b.station, b.a.x, b.a.y) * b.side;
      expect(off).toBeLessThan(rail + 1);
      expect(off).toBeGreaterThan(t.width[b.station] / 2 + 2);
      expect(b.a.g).toBeCloseTo(100, 6);
    }
  });

  it('carry one sign after another, each as long as four times its height and never cut in two', () => {
    for (const b of boards) {
      const length = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y);
      expect(b.from).toBeGreaterThanOrEqual(-1e-9);
      expect(b.to).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.to).toBeGreaterThan(b.from);
      // A whole sign is 4.2 m long: the panel shows as much of it as it is long.
      expect(length / (b.to - b.from)).toBeCloseTo(4.2, 1);
      expect(b.sign).toBeLessThan(SIGNS.length - 1);
    }
    // Along a row a sign goes on where the panel before stopped, on the same sign.
    let joined = 0;
    for (let i = 0; i + 1 < boards.length; i++) {
      const [a, b] = [boards[i], boards[i + 1]];
      if (a.side !== b.side || Math.hypot(b.a.x - a.b.x, b.a.y - a.b.y) > 1e-6 || a.to > 1 - 1e-6) continue;
      expect(b.from).toBeCloseTo(a.to, 6);
      expect(b.sign).toBe(a.sign);
      joined++;
    }
    expect(joined).toBeGreaterThan(20);
    // The start gantry's sign is kept for the gantry.
    expect(boards.some((b) => b.sign === START_SIGN)).toBe(false);
    expect(new Set(boards.map((b) => b.sign)).size).toBeGreaterThan(3);
  });

  it('face the track and read the right way round from it, a metre high', () => {
    expect(built.faces.indices).toHaveLength(boards.length * 6);
    expectReadable(built.faces);
    boards.forEach((b, i) => {
      // Towards the track's centre from where the board stands.
      const k = b.station;
      const n = [built.faces.normals[i * 12], built.faces.normals[i * 12 + 2]];
      expect((t.x[k] - b.a.x) * n[0] + (t.y[k] - b.a.y) * n[1]).toBeGreaterThan(0);
    });
    for (let v = 0; v < built.faces.positions.length / 3; v++) {
      const y = built.faces.positions[v * 3 + 1];
      expect(y).toBeGreaterThan(100);
      expect(y).toBeLessThan(101.1);
      expect(built.faces.anchors![v]).toBeCloseTo(100, 4);
    }
    expect(built.frames.indices.length).toBeGreaterThan(0);
  });
});

describe('gantries', () => {
  const gantries = placeGantries(t, metrics.straights, pit, earth, avoid);
  const bridges = gantries.filter((g) => g.kind === 'bridge');

  it('put one over the start line, with no post in the pit lane', () => {
    const first = gantries.filter((g) => g.kind === 'start');
    expect(first).toHaveLength(1);
    expect(first[0].station).toBe(0);
    expect(first[0].sign).toBe(START_SIGN);
    expect(first[0].ends).toHaveLength(2);
    expect(first[0].ends.some((e) => e.post)).toBe(true);
    for (const e of first[0].ends) {
      expect(Math.abs(index.lateral(0, e.x, e.y))).toBeGreaterThan(t.width[0] / 2 + 1);
      if (e.post) for (const f of avoid) expect(inside(f, e.x, e.y)).toBe(false);
    }
  });

  it('put a bridge over the long straights, away from the line and clear of the buildings', () => {
    expect(bridges.length).toBeGreaterThanOrEqual(1);
    expect(bridges.length).toBeLessThanOrEqual(2);
    for (const g of bridges) {
      expect(fromLine(g.station)).toBeGreaterThanOrEqual(300);
      expect(metrics.straights.some((s) => s.length >= 300 && mod(g.station - s.start, t.n) <= mod(s.end - s.start, t.n))).toBe(true);
      for (const e of g.ends) {
        expect(e.post).toBe(true);
        expect(Math.abs(index.lateral(g.station, e.x, e.y))).toBeCloseTo(t.width[g.station] / 2 + 11, 6);
        for (const f of avoid) expect(inside(f, e.x, e.y, 3)).toBe(false);
      }
    }
    // No two with the same sign, and none with the start's.
    expect(new Set(gantries.map((g) => g.sign)).size).toBe(gantries.length);
    // Short straights get none.
    const short = metrics.straights.map((s) => ({ ...s, length: 250 }));
    expect(placeGantries(t, short, pit, earth, avoid).filter((g) => g.kind === 'bridge')).toHaveLength(0);
    // Nor a site where something is in the way.
    expect(placeGantries(t, metrics.straights, pit, earth, avoid, () => true).filter((g) => g.kind === 'bridge')).toHaveLength(0);
  });

  it('are built high over the road, their boards readable from both ways', () => {
    const built = buildGantries(t, gantries);
    expect(built.structure.indices.length).toBeGreaterThan(0);
    expectReadable(built.faces);
    // Half of the boards face up the track and half down it.
    let ahead = 0;
    for (let v = 0; v < built.faces.normals.length / 3; v += 4) {
      const k = gantries.reduce((best, g) => (Math.hypot(t.x[g.station] - built.faces.positions[v * 3], t.y[g.station] - built.faces.positions[v * 3 + 2])
        < Math.hypot(t.x[best.station] - built.faces.positions[v * 3], t.y[best.station] - built.faces.positions[v * 3 + 2]) ? g : best)).station;
      const along = built.faces.normals[v * 3] * Math.cos(t.heading[k]) + built.faces.normals[v * 3 + 2] * Math.sin(t.heading[k]);
      expect(Math.abs(along)).toBeCloseTo(1, 5);
      if (along > 0) ahead++;
    }
    expect(ahead).toBe(built.faces.normals.length / 3 / 4 / 2);
    // Nothing hangs lower than five metres over the road: the lights under the start gantry are the lowest.
    for (const m of [built.structure, built.faces]) {
      for (let v = 0; v < m.positions.length / 3; v++) {
        const [x, y, z] = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
        const g = gantries.find((g) => Math.hypot(t.x[g.station] - x, t.y[g.station] - z) < 30)!;
        if (Math.abs(index.lateral(g.station, x, z)) < t.width[g.station] / 2) expect(y).toBeGreaterThan(g.road + 5);
        expect(y).toBeLessThan(g.road + 9);
        expect(m.anchors![v]).toBeLessThanOrEqual(g.road + 1e-4);
      }
    }
    // The start lights: five housings of two lamps, facing the grid.
    const lamps: number[] = [];
    const c = built.structure.colors!;
    for (let v = 0; v < c.length / 3; v++) if (Math.abs(c[v * 3] - 0.32) < 1e-6 && Math.abs(c[v * 3 + 1] - 0.05) < 1e-6) lamps.push(v);
    expect(lamps).toHaveLength(5 * 2 * 4);
    for (const v of lamps) {
      expect(built.structure.normals[v * 3] * Math.cos(t.heading[0]) + built.structure.normals[v * 3 + 2] * Math.sin(t.heading[0])).toBeCloseTo(-1, 5);
    }
  });
});

describe('the pit building', () => {
  it('numbers its garages along the lane, readable from it', () => {
    expectReadable(building.signs);
    const quads = building.signs.positions.length / 12;
    // One number per garage, and the two halves of the board behind the podium.
    const numbers = [...Array(quads).keys()].filter((q) => building.signs.uvs![q * 8 + 1] < 0.5);
    expect(numbers.length).toBeGreaterThan(10);
    expect(quads - numbers.length).toBe(2);
    numbers.forEach((q, i) => {
      const [left, bottom] = cellUv(numberCell(i + 1));
      expect(building.signs.uvs![q * 8]).toBeCloseTo(left, 6);
      expect(building.signs.uvs![q * 8 + 1]).toBeCloseTo(bottom, 6);
      // Over the door, facing the lane.
      const p = building.signs.positions;
      expect(p[q * 12 + 1]).toBeGreaterThan(100 + 4.5);
      expect(p[q * 12 + 7]).toBeLessThan(100 + 5.4);
      const k = Math.round((pit.boxStart + pit.boxEnd) / 2);
      expect((pit.x[k] - p[q * 12]) * building.signs.normals[q * 12] + (pit.y[k] - p[q * 12 + 2]) * building.signs.normals[q * 12 + 2]).toBeGreaterThan(0);
    });
  });

  it('has its tower at the end nearer the start line', () => {
    const top = (m: MeshData) => {
      let best = 0;
      for (let v = 1; v < m.positions.length / 3; v++) if (m.positions[v * 3 + 1] > m.positions[best * 3 + 1]) best = v;
      return { x: m.positions[best * 3], y: m.positions[best * 3 + 2], h: m.positions[best * 3 + 1] };
    };
    const ends = [pit.boxStart, pit.boxEnd].map((i) => ({ x: pit.x[i], y: pit.y[i] }));
    const near = (p: { x: number; y: number }, to: { x: number; y: number }) => Math.hypot(p.x - to.x, p.y - to.y);
    const line = { x: t.x[0], y: t.y[0] };
    const nearer = near(ends[0], line) < near(ends[1], line) ? 0 : 1;
    const withLine = top(building.mesh);
    expect(withLine.h).toBeCloseTo(100 + 16.1, 3);
    expect(near(withLine, ends[nearer])).toBeLessThan(near(withLine, ends[1 - nearer]));
    // Told of no line, it stands at the pit exit's end.
    const without = top(buildPitBuilding(pit, road).mesh);
    expect(near(without, ends[1])).toBeLessThan(near(without, ends[0]));
  });

  it('paints the lane and stands the timing desks on the pit wall', () => {
    const paint = building.markings;
    expect(paint.indices.length).toBeGreaterThan(0);
    for (let v = 0; v < paint.positions.length / 3; v++) {
      expect(paint.normals[v * 3 + 1]).toBeCloseTo(1, 6);
      expect(paint.positions[v * 3 + 1]).toBeGreaterThan(100);
      expect(paint.positions[v * 3 + 1]).toBeLessThan(100.05);
    }
  });
});

describe('the crowd', () => {
  const crowd = seatCrowd(stands, 'seed');

  it('fills most seats of the grandstands, the same people every time', () => {
    const full = seatCrowd(stands, 'seed', 1);
    expect(full.count).toBeGreaterThan(1000);
    expect(crowd.count / full.count).toBeGreaterThan(0.8);
    expect(crowd.count / full.count).toBeLessThan(0.88);
    expect(seatCrowd(stands, 'seed', 0).count).toBe(0);
    expect(seatCrowd([], 'seed').count).toBe(0);
    expect(seatCrowd(stands, 'seed').positions).toEqual(crowd.positions);
    expect(seatCrowd(stands, 'other').positions).not.toEqual(crowd.positions);
    expect(crowd.positions).toHaveLength(crowd.count * 3);
    expect(crowd.colors).toHaveLength(crowd.count * 3);
    expect(crowd.facing).toHaveLength(crowd.count);
  });

  it('sits on the rows of a stand, looking at the track', () => {
    // (As the crowd keeps them: single precision.)
    const bases = new Set(stands.map((s) => Math.fround(s.base)));
    const levels = new Set<number>();
    for (let i = 0; i < crowd.count; i += 7) {
      const [x, h, y] = [crowd.positions[i * 3], crowd.positions[i * 3 + 1], crowd.positions[i * 3 + 2]];
      // Behind the front edge of a stand, on its rows (its footprint is only the outline between its ends).
      const behind = Math.min(...stands.map((s) => Math.min(...s.front.slice(1).map((b, j) => {
        const a = s.front[j];
        const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const f = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / len2));
        return Math.hypot(x - (a.x + (b.x - a.x) * f), y - (a.y + (b.y - a.y) * f));
      }))));
      expect(behind).toBeGreaterThan(1);
      expect(behind).toBeLessThan(STAND_DEPTH);
      expect(bases.has(crowd.floors[i])).toBe(true);
      const row = (h - crowd.floors[i] - 1) / STAND_RISE;
      expect(row).toBeCloseTo(Math.round(row), 4);
      expect(Math.round(row)).toBeGreaterThanOrEqual(0);
      expect(Math.round(row)).toBeLessThan(STAND_ROWS);
      levels.add(Math.round(row));
      // A step the way they look brings them nearer the track.
      const a = crowd.facing[i];
      const before = index.nearest(x, y, 200)!.d;
      const after = index.nearest(x + Math.sin(a) * 2, y + Math.cos(a) * 2, 200)!.d;
      expect(after).toBeLessThan(before - 1.5);
    }
    expect(levels.size).toBe(STAND_ROWS);
    // In more than a few colours.
    const shirts = new Set<string>();
    for (let i = 0; i < crowd.count; i++) shirts.add(`${crowd.colors[i * 3]},${crowd.colors[i * 3 + 1]},${crowd.colors[i * 3 + 2]}`);
    expect(shirts.size).toBeGreaterThan(8);
  });
});

describe('tyre marks', () => {
  const straight = (kind: SkidMark['kind'], points: number, time = 0): SkidMark => ({
    t: time, car: 0, kind, half: 0.8, points: Array.from({ length: points }, (_, i) => ({ x: 1000 + i * 3, y: 2000, heading: 0 })),
  });

  it('are two strips on the road, one per wheel, facing up', () => {
    const m = buildSkidMarks([straight('lock', 6)], () => 100);
    expect(m.positions).toHaveLength(2 * 6 * 2 * 3);
    expect(m.indices).toHaveLength(2 * 5 * 6);
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
      const p = m.positions;
      // (The y part of the triangle's normal: up.)
      expect((p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2])).toBeGreaterThan(0);
    }
    for (let v = 0; v < m.positions.length / 3; v++) {
      // Heading east, the car's left is north: the wheels run 0.8 m either side, each strip 0.3 m wide.
      const off = Math.abs(m.positions[v * 3 + 2] - 2000);
      expect(Math.abs(off - 0.8)).toBeCloseTo(0.15, 4);
      expect(m.positions[v * 3 + 1]).toBeGreaterThan(100);
      expect(m.positions[v * 3 + 1]).toBeLessThan(100.05);
      expect(m.anchors[v]).toBeCloseTo(100, 4);
      expect(m.normals[v * 3 + 1]).toBe(1);
    }
  });

  it('fade in and out along a lock-up, and away from where a car stood on the grid', () => {
    const lock = buildSkidMarks([straight('lock', 10)], () => 100);
    // Per wheel, ten rows of two vertices.
    const row = (m: typeof lock, i: number) => m.alphas[i * 2];
    expect(row(lock, 0)).toBe(0);
    expect(row(lock, 9)).toBe(0);
    expect(row(lock, 4)).toBeGreaterThan(0.5);
    expect(row(lock, 1)).toBeLessThan(row(lock, 3));
    const off = buildSkidMarks([straight('start', 10)], () => 100);
    expect(row(off, 0)).toBeGreaterThan(0.5);
    expect(row(off, 9)).toBe(0);
    for (let i = 1; i < 10; i++) expect(row(off, i)).toBeLessThan(row(off, i - 1));
    // Worn-in rubber is the same mark, less dark.
    const worn = buildSkidMarks([straight('lock', 10)], () => 100, 0.5);
    expect(row(worn, 4)).toBeCloseTo(row(lock, 4) / 2, 6);
    // A spin is the darkest of them.
    expect(row(buildSkidMarks([straight('spin', 10)], () => 100), 4)).toBeGreaterThan(row(lock, 4));
  });

  it('say when each was made, so that a replay can leave the later ones out', () => {
    const m = buildSkidMarks([straight('lock', 4, 10), straight('spin', 1, 20), straight('lock', 3, 30)], () => 100);
    expect([...m.times]).toEqual([10, 20, 30]);
    // (A mark of one point is not drawn yet.)
    expect([...m.ends]).toEqual([36, 36, 60]);
    expect(m.indices).toHaveLength(60);
  });

  it('lie on the road where it is higher than the ground under it, level across', () => {
    // A road climbing to the east, with the ground beside it somewhere else altogether.
    const slope = buildTrack(design(bigRectangle(), { smoothing: 0, maxCutFill: 0 }), (x) => 100 + x * 0.01)!;
    const at = roadHeight(new TrackIndex(slope), () => 0);
    for (let k = 10; k < slope.n; k += 97) {
      const h = slope.heading[k];
      const next = (k + 1) % slope.n;
      // On a station, halfway to the next, and three metres to the left of it.
      expect(at(slope.x[k], slope.y[k])).toBeCloseTo(slope.z[k], 6);
      expect(at((slope.x[k] + slope.x[next]) / 2, (slope.y[k] + slope.y[next]) / 2)).toBeCloseTo((slope.z[k] + slope.z[next]) / 2, 2);
      expect(at(slope.x[k] + Math.sin(h) * 3, slope.y[k] - Math.cos(h) * 3)).toBeCloseTo(slope.z[k], 6);
      // Well off the road, the ground.
      expect(at(slope.x[k] + Math.sin(h) * 20, slope.y[k] - Math.cos(h) * 20)).toBe(0);
    }
  });

  it('are worn in where every lap brakes hard, along the racing line', () => {
    const lap = performance.laps[0];
    const worn = brakingMarks(t, performance.line, lap, 'seed');
    expect(worn.length).toBeGreaterThan(8);
    for (const m of worn) {
      expect(m.t).toBe(-Infinity);
      expect(m.kind).toBe('lock');
      expect(markLength(m)).toBeGreaterThan(10);
      expect(markLength(m)).toBeLessThan(50);
      // It begins where the lap brakes, within a few metres of the line the cars take.
      const k = index.nearest(m.points[0].x, m.points[0].y, 30)!.k;
      let braking = false;
      for (let i = -3; i <= 3; i++) braking ||= lap.brake[mod(k + i, t.n)] >= 0.5;
      expect(braking).toBe(true);
      expect(Math.abs(index.lateral(k, m.points[0].x, m.points[0].y) - performance.line.offset[k])).toBeLessThan(2.5);
    }
    // The same every time, and none where nobody brakes.
    expect(brakingMarks(t, performance.line, lap, 'seed')).toEqual(worn);
    expect(brakingMarks(t, performance.line, { ...lap, brake: new Float64Array(t.n) }, 'seed')).toHaveLength(0);
    expect(buildSkidMarks(worn, () => 100, 0.7).indices.length).toBeGreaterThan(0);
  });
});

describe('the marks a race leaves', () => {
  it('begin with wheelspin off the grid, from the driven wheels at the back', () => {
    const sim = start(car('f1'), { cars: 12 });
    expect(sim.marks).toHaveLength(12);
    for (const m of sim.marks) {
      const c = sim.cars.find((x) => x.id === m.car)!;
      const at = sim.pose(c, 1)!;
      expect(m.kind).toBe('start');
      expect(m.points).toHaveLength(2);
      // The best starters leave three metres, the worst nine.
      expect(markLength(m)).toBeGreaterThanOrEqual(3 - 1e-6);
      expect(markLength(m)).toBeLessThanOrEqual(9 + 1e-6);
      // From behind the middle of the car, the way it points, once it gets away.
      const ahead = (p: { x: number; y: number }) => (p.x - at.x) * Math.cos(at.heading) + (p.y - at.y) * Math.sin(at.heading);
      expect(ahead(m.points[0])).toBeCloseTo(-0.3 * c.cls.length, 1);
      expect(ahead(m.points[1])).toBeGreaterThan(ahead(m.points[0]));
      expect(m.t).toBeGreaterThan(0);
      expect(m.t).toBeLessThan(2);
      expect(m.half).toBeLessThan(c.cls.half);
    }
  });

  it('are locked wheels for every mistake and a slide for every spin, on the road', () => {
    const sim = race(car('gt3'), { cars: 16, laps: 12, seed: '5' });
    const locks = sim.marks.filter((m) => m.kind === 'lock');
    const spins = sim.marks.filter((m) => m.kind === 'spin');
    // A rolling start leaves no wheelspin.
    expect(sim.marks.some((m) => m.kind === 'start')).toBe(false);
    expect(sim.tally.mistakes).toBeGreaterThan(10);
    expect(locks.length).toBeGreaterThanOrEqual(sim.tally.mistakes + sim.tally.offs);
    expect(spins.length).toBe(sim.tally.spins + sim.tally.crashes);
    expect(spins.length).toBeGreaterThan(0);
    for (const m of locks) {
      expect(markLength(m)).toBeGreaterThan(5);
      expect(markLength(m)).toBeLessThan(45);
    }
    for (const m of spins) expect(markLength(m)).toBeGreaterThan(20);
    for (const m of sim.marks) {
      expect(m.t).toBeLessThanOrEqual(sim.t);
      for (const p of m.points) expect(index.nearest(p.x, p.y, 40)).not.toBeNull();
    }
  });

  it('are none for bikes', () => {
    const sim = race(car('motogp'), { cars: 12, laps: 6 });
    expect(sim.marks).toHaveLength(0);
  });
});
