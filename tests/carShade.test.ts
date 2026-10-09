import { describe, expect, it } from 'vitest';
import { BODIES, buildCar } from '../src/core/carBodies.ts';
import { CARBON, CarMeshBuilder, type CarMeshData, GLASS, Loft, MATERIAL, PART, SEAM, SectionPath, ZONE, box, paint, patch, trim } from '../src/core/carMesh.ts';
import { bakeOcclusion, groundShadow, transferOcclusion } from '../src/core/carShade.ts';
import { ReplayBuffer } from '../src/core/race/replay.ts';
import { car, start } from './raceFixture.ts';

const GREY = trim([0.5, 0.5, 0.5]);

/** A box as a mesh of its own. */
function boxMesh(lo: [number, number, number], hi: [number, number, number]): CarMeshData {
  const mb = new CarMeshBuilder();
  box(mb, lo, hi, GREY);
  return mb.build();
}

/** The mean occlusion of the vertices that `pick` takes. */
function meanAo(m: CarMeshData, pick: (i: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < m.ao.length; i++) {
    if (!pick(i)) continue;
    sum += m.ao[i];
    n++;
  }
  return n ? sum / n : NaN;
}

/** A round tube of a body, 2 m long and 0.5 m in radius about (y 0.6, z 0), with its section's points named. */
function tubeLoft(mb: CarMeshBuilder): Loft {
  const r = 0.5;
  return new Loft(mb, {
    stations: [1, 0.5, 0, -0.5, -1],
    u: (x) => (x + 1) / 2,
    section: () => new SectionPath(0, 0.6 - r, paint(ZONE.body)).mark('keel').round(r, 0.6, 12, 2, 'across').mark('side').round(0, 0.6 + r, 12, 2, 'up').mark('spine'),
  });
}

describe('baked shading', () => {
  it('leaves a face open to the sky light, and darkens what is shut in or close over the road', () => {
    // A slab 20 cm over the road.
    const slab = boxMesh([-1, 0.2, -0.5], [1, 0.3, 0.5]);
    expect(Array.from(slab.ao).every((v) => v === 1)).toBe(true);
    bakeOcclusion(slab, [slab]);
    const top = meanAo(slab, (i) => slab.normals[i * 3 + 1] > 0.9);
    const under = meanAo(slab, (i) => slab.normals[i * 3 + 1] < -0.9);
    expect(top).toBeGreaterThan(0.98);
    // The road counts for half: the underside is dim, not black.
    expect(under).toBeLessThan(0.85);
    expect(under).toBeGreaterThan(0.55);
    // A wing a hand over it shuts the top in.
    const lid = boxMesh([-2, 0.38, -1.5], [2, 0.42, 1.5]);
    bakeOcclusion(slab, [slab, lid]);
    expect(meanAo(slab, (i) => slab.normals[i * 3 + 1] > 0.9)).toBeLessThan(0.35);
    // Far over it, it makes no difference; and a part that turns takes no road.
    bakeOcclusion(slab, [slab, boxMesh([-1, 1.5, -0.5], [1, 1.6, 0.5])], { ground: null });
    expect(meanAo(slab, () => true)).toBeGreaterThan(0.98);
    for (const v of slab.ao) expect(v >= 0 && v <= 1).toBe(true);
  });

  it('hands the shading on to the same shape at another level of detail', () => {
    const a = boxMesh([-1, 0.2, -0.5], [1, 0.3, 0.5]);
    bakeOcclusion(a, [a]);
    const b = boxMesh([-1, 0.2, -0.5], [1, 0.3, 0.5]);
    transferOcclusion(a, b);
    expect(Array.from(b.ao)).toEqual(Array.from(a.ao));
    // Each face takes its own: the top stays light though the underside is 10 cm off.
    expect(meanAo(b, (i) => b.normals[i * 3 + 1] > 0.9)).toBeGreaterThan(0.98);
    // Nothing near: left as it was.
    const far = boxMesh([5, 0.2, -0.5], [6, 0.3, 0.5]);
    transferOcclusion(a, far);
    expect(Array.from(far.ao).every((v) => v === 1)).toBe(true);
  });

  it('lays a soft shadow on the road under what is low, and none under what is high', () => {
    const s = groundShadow([boxMesh([-1, 0.1, -0.5], [1, 0.4, 0.5])]);
    const at = (x: number, z: number) => s.data[Math.floor((x - s.x0) / s.cell) * s.nz + Math.floor((z - s.z0) / s.cell)];
    expect(s.data).toHaveLength(s.nx * s.nz);
    // The grid reaches beyond the box, and its corners are clear.
    expect(s.x0).toBeLessThan(-1.3);
    expect(s.x0 + s.nx * s.cell).toBeGreaterThan(1.3);
    expect(at(s.x0 + 0.02, s.z0 + 0.02)).toBe(0);
    // Dark under the middle, fading out across the edge.
    expect(at(0, 0)).toBeGreaterThan(170);
    const across = [0.3, 0.45, 0.55, 0.7, 0.9].map((z) => at(0, z));
    for (let i = 1; i < across.length; i++) expect(across[i]).toBeLessThanOrEqual(across[i - 1]);
    expect(across[0]).toBeGreaterThan(across[4] + 100);
    expect(across[4]).toBeLessThan(12);
    // Lower is darker; a wing a metre up lays nothing.
    const low = groundShadow([boxMesh([-1, 0.02, -0.5], [1, 0.4, 0.5])]);
    expect(low.data[Math.floor(low.nx / 2) * low.nz + Math.floor(low.nz / 2)]).toBeGreaterThan(at(0, 0));
    expect(Math.max(...groundShadow([boxMesh([-1, 1, -0.5], [1, 1.1, 0.5])]).data)).toBe(0);
  });
});

describe('strips and patches on a body', () => {
  it('lays a shut line along the body and round it, just off the surface, the same on both sides', () => {
    const mb = new CarMeshBuilder();
    const loft = tubeLoft(mb);
    const from = mb.vertexCount;
    loft.seamAlong(mb, 'side', 0.8, -0.8, 0.01, SEAM, 1);
    loft.seamRound(mb, 0.25, 'keel', 'spine', 0.01, SEAM, 1);
    const right = mb.vertexCount;
    loft.seamAlong(mb, 'side', 0.8, -0.8, 0.01, SEAM, -1);
    loft.seamRound(mb, 0.25, 'keel', 'spine', 0.01, SEAM, -1);
    const m = mb.build();
    expect(right - from).toBeGreaterThan(20);
    expect(m.positions.length / 3 - right).toBe(right - from);
    for (let i = from; i < m.positions.length / 3; i++) {
      const [x, y, z] = [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      // On the tube: half a metre from its axis, give or take the lift and the flats between its points.
      expect(Math.hypot(y - 0.6, z)).toBeGreaterThan(0.495);
      expect(Math.hypot(y - 0.6, z)).toBeLessThan(0.506);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.8 + 1e-6);
      // The normal points out of the tube.
      expect(m.normals[i * 3 + 1] * (y - 0.6) + m.normals[i * 3 + 2] * z).toBeGreaterThan(0.45);
      // The right side's strips on the right, the left side's on the left (the line round the body starts and ends on the middle).
      if (i < right) expect(z).toBeGreaterThan(-0.006);
      else expect(z).toBeLessThan(0.006);
    }
    // The line along the side is at the body's widest; the one round it spans it from the bottom to the top.
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = from; i < right; i++) {
      lowest = Math.min(lowest, m.positions[i * 3 + 1]);
      highest = Math.max(highest, m.positions[i * 3 + 1]);
    }
    expect(lowest).toBeLessThan(0.11);
    expect(highest).toBeGreaterThan(1.09);
    expect(() => loft.seamAlong(mb, 'nowhere', 0.5, -0.5, 0.01, SEAM)).toThrow();
  });

  it('lays a patch on top of the body or on its side, and none where there is no body', () => {
    const mb = new CarMeshBuilder();
    const loft = tubeLoft(mb);
    const from = mb.vertexCount;
    patch(mb, loft, 'top', 0, 0.1, 0.4, 0.2, CARBON);
    const top = mb.vertexCount;
    patch(mb, loft, 'left', 0, 0.6, 0.4, 0.2, GLASS);
    const side = mb.vertexCount;
    // Beside the tube, and beyond its end.
    patch(mb, loft, 'top', 0, 2, 0.4, 0.2, CARBON);
    patch(mb, loft, 'top', 3, 0, 0.4, 0.2, CARBON);
    const m = mb.build();
    expect(top - from).toBe(15);
    expect(side - top).toBe(15);
    for (let i = from; i < side; i++) {
      const [y, z] = [m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      expect(Math.hypot(y - 0.6, z)).toBeGreaterThan(0.497);
      expect(Math.hypot(y - 0.6, z)).toBeLessThan(0.506);
      if (i < top) expect(y).toBeGreaterThan(1.05);
      else expect(z).toBeLessThan(-0.47);
      expect(m.material[i]).toBe(i < top ? MATERIAL.carbon : MATERIAL.glass);
    }
    // (A patch that misses the body is left out.)
    expect(mb.vertexCount - side).toBe(0);
  });
});

describe('the shading and the parts of the car models', () => {
  for (const body of BODIES) {
    it(`${body}: is shaded underneath and in its crevices, and lays a shadow of its own shape`, () => {
      const model = buildCar(body);
      for (const lod of model.lods) {
        for (const m of [lod.body, lod.wheel]) {
          expect(m.ao).toHaveLength(m.positions.length / 3);
          expect(m.material).toHaveLength(m.positions.length / 3);
          for (const v of m.ao) expect(v >= 0 && v <= 1).toBe(true);
        }
        // What looks down from low over the road is darker than what looks up at the sky.
        const b = lod.body;
        const under = meanAo(b, (i) => b.normals[i * 3 + 1] < -0.7 && b.positions[i * 3 + 1] < 0.25);
        const top = meanAo(b, (i) => b.normals[i * 3 + 1] > 0.7 && b.positions[i * 3 + 1] > 0.5);
        // (A bike's belly is high over the road for its size, and its rider shuts in what looks up.)
        if (model.kind !== 'bike') expect(under).toBeLessThan(top - 0.15);
        expect(meanAo(b, () => true)).toBeGreaterThan(0.4);
        // A wheel on its own is mostly open.
        expect(meanAo(lod.wheel, () => true)).toBeGreaterThan(0.5);
      }
      const s = model.shadow;
      expect(s.data).toHaveLength(s.nx * s.nz);
      const at = (x: number, z: number) => s.data[Math.floor((x - s.x0) / s.cell) * s.nz + Math.floor((z - s.z0) / s.cell)];
      // Dark under the middle of the car and under a tyre, clear at the corners, and no bigger than the car and a margin.
      const w = model.wheels[0];
      // (A bike is narrow: its shadow is thinner.)
      expect(Math.max(at(0, 0), at(w.x, w.z))).toBeGreaterThan(model.kind === 'bike' ? 120 : 150);
      expect(at(w.x, w.z)).toBeGreaterThan(100);
      for (const [i, j] of [[0, 0], [0, s.nz - 1], [s.nx - 1, 0], [s.nx - 1, s.nz - 1]]) expect(s.data[i * s.nz + j]).toBe(0);
      expect(s.nx * s.cell).toBeLessThan(model.length + 1.5);
      expect(s.nx * s.cell).toBeGreaterThan(model.length + 0.5);
      expect(s.nz * s.cell).toBeLessThan(model.width + 1.3);
    });
  }

  it('says what a surface is made of: carbon on the floor and the wings, rubber on the tyres, glass in the windows', () => {
    const has = (m: CarMeshData, kind: number) => Array.from(m.material).filter((k) => k === kind).length;
    const f1 = buildCar('f1').lods[1];
    expect(has(f1.body, MATERIAL.carbon)).toBeGreaterThan(500);
    expect(has(f1.body, MATERIAL.rubber)).toBe(0);
    expect(has(f1.wheel, MATERIAL.rubber)).toBeGreaterThan(200);
    const gt3 = buildCar('gt3').lods[1].body;
    expect(has(gt3, MATERIAL.glass)).toBeGreaterThan(200);
    // Glass is where the cabin is: above the shoulder line.
    for (let i = 0; i < gt3.material.length; i++) if (gt3.material[i] === MATERIAL.glass) expect(gt3.positions[i * 3 + 1]).toBeGreaterThan(0.7);
    // What is painted is plain.
    for (let i = 0; i < gt3.zone.length; i++) if (gt3.zone[i] >= 0) expect(gt3.material[i]).toBe(MATERIAL.plain);
  });

  it('marks the part that comes off at the front: a front wing, or a splitter and its dive planes', () => {
    const part = (m: CarMeshData, id: number) => {
      const out: number[] = [];
      for (let i = 0; i < m.hinge.length / 3; i++) if (m.hinge[i * 3 + 2] === id) out.push(i);
      return out;
    };
    for (const body of ['f1', 'f2', 'indycar', 'hypercar', 'gt3', 'tcr']) {
      const model = buildCar(body);
      for (const lod of model.lods) {
        const nose = part(lod.body, PART.nose);
        expect(nose.length).toBeGreaterThan(7);
        // All of it at the front of the car, and low: no higher than the wheels.
        for (const i of nose) {
          expect(lod.body.positions[i * 3]).toBeGreaterThan(model.wheelbase / 2 - 0.1);
          expect(lod.body.positions[i * 3 + 1]).toBeLessThan(0.75);
        }
        // The body itself stays: most of the car is no part.
        expect(part(lod.body, PART.none).length).toBeGreaterThan(nose.length);
        // A wheel is no part.
        expect(part(lod.wheel, PART.none)).toHaveLength(lod.wheel.positions.length / 3);
      }
    }
    // A single-seater's front wing is the whole width of the car; a bike has nothing to lose.
    const f1 = buildCar('f1').lods[1].body;
    const zs = part(f1, PART.nose).map((i) => f1.positions[i * 3 + 2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(1.8);
    expect(part(buildCar('motogp').lods[1].body, PART.nose)).toHaveLength(0);
  });

  it('draws the shut lines between the panels only on the level for close-ups', () => {
    const seams = (m: CarMeshData) => {
      let n = 0;
      for (let i = 0; i < m.colors.length / 3; i++) if (Math.abs(m.colors[i * 3] - SEAM.color[0]) < 1e-6 && m.finish[i * 4] > 0.94) n++;
      return n;
    };
    for (const body of ['f1', 'hypercar', 'gt3', 'tcr']) {
      const model = buildCar(body);
      expect(seams(model.lods[0].body)).toBeGreaterThan(100);
      for (const lod of model.lods.slice(1)) expect(seams(lod.body)).toBe(0);
    }
    // A touring car has four doors: more shut lines than a GT.
    expect(seams(buildCar('tcr').lods[0].body)).toBeGreaterThan(seams(buildCar('gt3').lods[0].body));
  });
});

describe('damage in a replay', () => {
  it('is what the car had then, not what it has now', () => {
    const sim = start(car('f1'), { laps: 3, cars: 4 });
    const buffer = new ReplayBuffer(20);
    for (let i = 0; i < 100; i++) {
      if (i === 40) sim.cars[1].damage = { kind: 'wing', pace: 0.02 };
      if (i === 70) sim.cars[1].damage = null;
      sim.step();
      buffer.record(sim);
    }
    const then = (stepsAgo: number) => buffer.view(sim, buffer.to - stepsAgo * 0.1 + 0.05)!.view.cars[1].damage;
    expect(then(80)).toBeNull();
    expect(then(45)).toEqual({ kind: 'wing', pace: 0 });
    expect(then(10)).toBeNull();
    expect(sim.cars[1].damage).toBeNull();
    // The others had none.
    expect(buffer.view(sim, buffer.to - 4.45)!.view.cars[0].damage).toBeNull();
  });
});
