import { describe, expect, it } from 'vitest';
import { BODIES, buildCar } from '../src/core/carBodies.ts';
import { CarMeshBuilder, type CarMeshData, Loft, SectionPath, ZONE, curve, paint, plate, triangulate } from '../src/core/carMesh.ts';
import { bodyFor, liveryFor, spreadCars } from '../src/core/raceCars.ts';
import { VEHICLES } from '../src/core/vehicles.ts';

/** Every triangle's normal and centroid, skipping degenerate ones. */
function faces(m: CarMeshData): { n: number[]; c: number[]; vn: number[] }[] {
  const p = m.positions;
  const out = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-10) continue;
    const vn = [0, 1, 2].map((k) => m.normals[a * 3 + k] + m.normals[b * 3 + k] + m.normals[c * 3 + k]);
    out.push({ n: n.map((v) => v / len), c: [0, 1, 2].map((k) => (p[a * 3 + k] + p[b * 3 + k] + p[c * 3 + k]) / 3), vn });
  }
  return out;
}

function bounds(m: CarMeshData): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.positions[i + k]);
      hi[k] = Math.max(hi[k], m.positions[i + k]);
    }
  }
  return { lo, hi };
}

describe('car geometry toolkit', () => {
  it('lofts a closed body with outward normals and livery coordinates round it', () => {
    const mb = new CarMeshBuilder();
    const xs = [2, 1, 0, -1, -2];
    const loft = new Loft(mb, {
      stations: xs, u: (x) => (x + 2) / 4,
      section: () => new SectionPath(0, 0, paint()).line(0.5, 0, 2).round(0, 1, 6, 2, 'up'),
    });
    const m = mb.build();
    for (const f of faces(m)) {
      // Away from the body's axis (z = 0, y = 0.5) and the way the vertex normals point.
      expect(f.n[1] * (f.c[1] - 0.5) + f.n[2] * f.c[2]).toBeGreaterThan(0);
      expect(f.n[0] * f.vn[0] + f.n[1] * f.vn[1] + f.n[2] * f.vn[2]).toBeGreaterThan(0);
    }
    for (let i = 0; i < m.uvs.length; i += 2) {
      expect(m.uvs[i]).toBeGreaterThanOrEqual(0);
      expect(m.uvs[i]).toBeLessThanOrEqual(1);
      expect(m.uvs[i + 1]).toBeGreaterThanOrEqual(0);
      expect(m.uvs[i + 1]).toBeLessThan(1);
    }
    // The top is v = 0.5, the right side below it, the left above.
    const hit = loft.project([0, 2, 0])!;
    expect(hit.point[1]).toBeCloseTo(1, 6);
    expect(hit.normal[1]).toBeGreaterThan(0.95);
    const side = loft.project([0, 0.3, 5])!;
    // On the rounded flank, half way up.
    expect(side.point[2]).toBeGreaterThan(0.4);
    expect(side.normal[2]).toBeGreaterThan(0.7);
  });

  it('keeps a crease where the surface changes, taking each ring its own surface', () => {
    const mb = new CarMeshBuilder();
    const glass = { ...paint(ZONE.solidC) };
    new Loft(mb, {
      stations: [1, 0, 0, -1], u: () => 0.5,
      section: (_x, i) => new SectionPath(0, 0, paint()).line(0.5, 0, 1).line(0.5, 0.5, 1).use(i >= 2 ? glass : paint()).line(0, 1, 1),
    });
    const m = mb.build();
    const zones = new Set(Array.from(m.zone));
    expect(zones.has(ZONE.solidC)).toBe(true);
    expect(zones.has(ZONE.body)).toBe(true);
  });

  it('smooth curves pass through their points without overshooting', () => {
    const f = curve([[0, 0], [1, 1], [2, 1], [3, 0]]);
    expect(f(1)).toBeCloseTo(1, 9);
    for (let x = 0; x <= 3; x += 0.05) {
      expect(f(x)).toBeLessThanOrEqual(1 + 1e-9);
      expect(f(x)).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(f(-5)).toBe(0);
  });

  it('triangulates concave outlines and builds closed plates', () => {
    const outline: [number, number][] = [[0, 0], [2, 0], [2, 2], [1, 1], [0, 2]];
    const tris = triangulate(outline);
    expect(tris).toHaveLength(3);
    const mb = new CarMeshBuilder();
    plate(mb, outline, 0, 0.1, paint());
    const m = mb.build();
    // Every face points away from the plate's middle plane or out of its rim.
    for (const f of faces(m)) expect(f.n[0] * f.vn[0] + f.n[1] * f.vn[1] + f.n[2] * f.vn[2]).toBeGreaterThan(0);
  });
});

describe('car models', () => {
  for (const body of BODIES) {
    it(`${body}: builds at three levels of detail, real size, on its wheels`, () => {
      const car = buildCar(body);
      expect(car.lods).toHaveLength(3);
      const counts = car.lods.map((l) => l.body.indices.length / 3);
      // Less detail at each level, and within budget.
      expect(counts[0]).toBeGreaterThan(counts[1]);
      expect(counts[1]).toBeGreaterThan(counts[2]);
      expect(counts[0]).toBeLessThan(30_000);
      expect(counts[2]).toBeLessThan(4_000);
      const b = bounds(car.lods[0].body);
      // Within a few centimetres of its length, width and height, on the ground.
      expect(b.hi[0] - b.lo[0]).toBeGreaterThan(car.length * 0.92);
      expect(b.hi[0] - b.lo[0]).toBeLessThan(car.length * 1.08);
      // Mirrors may stand a little proud of the body.
      expect(b.hi[2] - b.lo[2]).toBeLessThan(car.width + 0.2);
      // A wing may stand above the roof.
      expect(b.hi[1]).toBeLessThan(car.height + 0.2);
      expect(b.lo[1]).toBeGreaterThan(-0.05);
      for (const lod of car.lods) {
        for (const v of lod.body.positions) expect(Number.isFinite(v)).toBe(true);
        expect(lod.wheel.indices.length).toBeGreaterThan(0);
      }
      // Wheels on the ground, inside the body's width.
      for (const w of car.wheels) {
        expect(w.y).toBeCloseTo(w.radius, 9);
        expect(Math.abs(w.z) + w.width / 2).toBeLessThanOrEqual(car.width / 2 + 0.02);
      }
      expect(car.wheels.filter((w) => w.front)).toHaveLength(car.kind === 'bike' ? 1 : 2);
      // Faces point the way their vertex normals do.
      for (const f of faces(car.lods[1].body)) expect(f.n[0] * f.vn[0] + f.n[1] * f.vn[1] + f.n[2] * f.vn[2]).toBeGreaterThan(-1e-9);
      // Number decals at full detail, in the decal cell.
      const d = car.lods[0].decals;
      expect(d.indices.length).toBeGreaterThan(0);
      for (const v of d.uvs) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  }

  it('turns only the DRS flap of a single-seater about its hinge', () => {
    const f1 = buildCar('f1').lods[0].body;
    let flap = 0;
    for (let i = 0; i < f1.hinge.length; i += 3) if (f1.hinge[i + 2] > 0.5) flap++;
    expect(flap).toBeGreaterThan(20);
    expect(flap).toBeLessThan(f1.positions.length / 3 / 10);
    const gt = buildCar('gt3').lods[0].body;
    for (let i = 0; i < gt.hinge.length; i += 3) expect(gt.hinge[i + 2]).toBe(0);
  });
});

describe('race cars in 3D', () => {
  it('picks each class its own model, and a near one for classes without', () => {
    for (const v of VEHICLES) expect(BODIES).toContain(bodyFor(v));
    expect(bodyFor(VEHICLES.find((v) => v.id === 'motogp')!)).toBe('motogp');
    expect(bodyFor({ id: 'custom-bike', kind: 'bike', mass: 220, clA: 0 })).toBe('motogp');
    expect(bodyFor({ id: 'custom-proto', kind: 'car', mass: 1030, clA: [3, 4] })).toBe('hypercar');
    expect(bodyFor({ id: 'custom-saloon', kind: 'car', mass: 1300, clA: 0.5 })).toBe('tcr');
  });

  it('gives a team the same livery every time, with a second colour that stands out', () => {
    const a = liveryFor('Boreal Racing Team', '#1e5bc6');
    expect(liveryFor('Boreal Racing Team', '#1e5bc6')).toEqual(a);
    expect(a.b).not.toBe(a.a);
    expect(a.pattern).toBeGreaterThanOrEqual(0);
    expect(a.pattern).toBeLessThan(5);
    const patterns = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((t) => liveryFor(`Team ${t}`, '#d11d1d').pattern));
    expect(patterns.size).toBeGreaterThan(2);
  });

  const track = { n: 1000, ds: 2, width: new Float64Array(1000).fill(12), lineOffset: new Float64Array(1000).fill(0) };

  it('moves overlapping cars side by side within the track, and leaves others alone', () => {
    const cars = [
      { id: 0, u: 100, lateral: 0, length: 5.6, width: 2 },
      { id: 1, u: 100.5, lateral: 0.2, length: 5.6, width: 2 },
      { id: 2, u: 300, lateral: 0, length: 5.6, width: 2 },
    ];
    const extra = spreadCars(cars, track, new Map(), Infinity);
    const l0 = cars[0].lateral + extra.get(0)!;
    const l1 = cars[1].lateral + extra.get(1)!;
    expect(Math.abs(l0 - l1)).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(extra.get(2)).toBe(0);
    for (const c of cars) expect(Math.abs(c.lateral + extra.get(c.id)!)).toBeLessThanOrEqual(6 - 1 + 1e-9);
  });

  it('eases cars aside at a few metres per second of race time, and keeps a car on a narrow track', () => {
    const cars = [{ id: 0, u: 10, lateral: 0, length: 5, width: 2 }, { id: 1, u: 10.2, lateral: 0, length: 5, width: 2 }];
    const first = spreadCars(cars, track, new Map([[0, 0], [1, 0]]), 0.1);
    expect(Math.abs(first.get(0)!)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(Math.abs(first.get(0)!)).toBeGreaterThan(0);
    const narrow = { ...track, width: new Float64Array(1000).fill(3) };
    const squeezed = spreadCars(cars, narrow, new Map(), Infinity);
    for (const c of cars) expect(Math.abs(c.lateral + squeezed.get(c.id)!)).toBeLessThanOrEqual(1.5 - 1 + 1e-9);
    // Across the start line: the end of the lap is next to its beginning.
    const wrap = spreadCars([{ id: 0, u: 999.5, lateral: 0, length: 5, width: 2 }, { id: 1, u: 1000.2, lateral: 0, length: 5, width: 2 }], track, new Map(), Infinity);
    expect(Math.abs(wrap.get(0)! - wrap.get(1)!)).toBeGreaterThan(2);
  });
});
