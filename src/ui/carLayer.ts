/**
 * The race in the 3D view: every car (and the safety car) drawn as its
 * model, in its team's livery, where the race puts it; wheels turning and
 * steering, bikes leaning into corners, DRS flaps opening, a soft shadow
 * underneath. Cars sit on the drawn ground at their real size whatever the
 * height exaggeration, tilted with the road.
 *
 * Each car model is instanced per level of detail; a car takes the level
 * that its size on screen calls for, so a car seen through a long lens
 * keeps its detail. Cars that would overlap are moved side by side
 * (core/raceCars.ts) in the picture only.
 *
 * Positions are scene coordinates (x east, y up, z south), outside the
 * height-scaled model group, so the cars never stretch.
 */
import * as THREE from 'three';
import { type CarModel, buildCar } from '../core/carBodies.ts';
import { DT, type RaceCar, type RaceSim } from '../core/race/sim.ts';
import { type Livery, SAFETY_LIVERY, bodyFor, liveryFor, spreadCars } from '../core/raceCars.ts';
import type { RacingLine } from '../core/racingLine.ts';
import { type Earthworks, SINK } from '../core/scene3d.ts';
import { TrackIndex } from '../core/scenery.ts';
import { type DecalCar, DECAL_GRID, carGeometry, carMaterial, decalAtlas, decalMaterial, linearRgb, shadowTexture, skyEnvironment } from './carMaterials.ts';

interface LodMeshes {
  body: THREE.InstancedMesh;
  decals: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
}

interface BodySet {
  model: CarModel;
  lods: LodMeshes[];
  capacity: number;
}

interface CarLook {
  set: BodySet;
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  pattern: number;
  variation: number;
  cell: [number, number];
}

/** A car as drawn this frame. */
export interface ShownCar {
  /** The race car's id, or -1 for the safety car. */
  id: number;
  look: CarLook;
  matrix: THREE.Matrix4;
  wheels: THREE.Matrix4[];
  /** Middle of the car, scene coordinates. */
  position: THREE.Vector3;
  drs: number;
  compound: [number, number, number];
  lod: number;
}

export interface CarContext {
  earth: Earthworks;
  /** The scene height for a real height (the height exaggeration). */
  sceneY: (z: number) => number;
  /** Side of the pit lane the garages are on (+1 left of the direction of travel). */
  pitSide: number;
}

/** Projected length in pixels above which a car takes the full model, and the medium one. */
const LOD_FULL = 150;
const LOD_MEDIUM = 36;
const SAFETY_ID = -1;

// Scratch objects, reused every frame.
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpM = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const FLIP = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI);

export class CarLayer {
  readonly group = new THREE.Group();
  private readonly envMap: THREE.Texture;
  private readonly material: THREE.MeshPhysicalMaterial;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private decalMat: THREE.MeshPhysicalMaterial | null = null;
  private atlas: THREE.Texture | null = null;
  private sets = new Map<string, BodySet>();
  private shadowMesh: THREE.InstancedMesh | null = null;
  private sim: RaceSim | null = null;
  private looks: CarLook[] = [];
  private safetyLook: CarLook | null = null;
  private index: TrackIndex | null = null;
  private spread = new Map<number, number>();
  private aside = new Map<number, number>();
  private lastT = -1;
  /** Cars as drawn, kept from frame to frame (by id) so their matrices are reused. */
  private pool = new Map<number, ShownCar>();
  shown: ShownCar[] = [];

  constructor(renderer: THREE.WebGLRenderer) {
    this.envMap = skyEnvironment(renderer);
    this.material = carMaterial(this.envMap);
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.6,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    });
  }

  /** Builds the cars for a race, or clears them. */
  setRace(sim: RaceSim | null): void {
    if (sim === this.sim) return;
    this.clear();
    this.sim = sim;
    if (!sim) return;
    this.index = new TrackIndex(sim.model.track);
    const counts = new Map<string, number>();
    const bodyOf = (car: RaceCar) => bodyFor(car.cls.model.vehicle);
    for (const car of sim.cars) counts.set(bodyOf(car), (counts.get(bodyOf(car)) ?? 0) + 1);
    counts.set('safety-car', (counts.get('safety-car') ?? 0) + 1);
    const decals: DecalCar[] = [];
    for (const car of sim.cars) {
      const kind = buildCar(bodyOf(car)).kind;
      decals.push({
        number: String(car.entrant.number), team: car.entrant.team,
        style: kind === 'single-seater' ? 'painted' : kind === 'bike' ? 'panel' : 'roundel',
        panel: kind !== 'single-seater' && kind !== 'bike' && sim.multiClass ? car.cls.color : undefined,
      });
    }
    decals.push({ number: '', team: 'Safety Car', style: 'painted' });
    this.atlas = decalAtlas(decals);
    this.decalMat = decalMaterial(this.atlas, this.envMap);
    for (const [body, count] of counts) this.sets.set(body, this.buildSet(buildCar(body), count));
    const cellOf = (i: number): [number, number] => [i % DECAL_GRID, Math.floor(i / DECAL_GRID)];
    const look = (set: BodySet, l: Livery, i: number): CarLook => ({
      set, a: linearRgb(l.a), b: linearRgb(l.b), c: linearRgb(l.c), pattern: l.pattern, variation: l.variation, cell: cellOf(i),
    });
    this.looks = sim.cars.map((car, i) => look(this.sets.get(bodyOf(car))!, liveryFor(car.entrant.team, car.entrant.color), i));
    this.safetyLook = look(this.sets.get('safety-car')!, SAFETY_LIVERY, sim.cars.length);
    this.shadowMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.shadowMaterial, sim.cars.length + 1);
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.count = 0;
    this.shadowMesh.renderOrder = 1;
    this.group.add(this.shadowMesh);
  }

  private buildSet(model: CarModel, capacity: number): BodySet {
    const lods = model.lods.map((lod, i) => {
      const wheelCount = capacity * model.wheels.length;
      const body = new THREE.InstancedMesh(carGeometry(lod.body, capacity), this.material, capacity);
      const decals = new THREE.InstancedMesh(carGeometry(lod.decals, capacity, true), this.decalMat!, capacity);
      const wheels = new THREE.InstancedMesh(carGeometry(lod.wheel, wheelCount), this.material, wheelCount);
      for (const m of [body, decals, wheels]) {
        m.frustumCulled = false;
        m.count = 0;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(m);
      }
      body.castShadow = i < 2;
      wheels.castShadow = i < 2;
      return { body, decals, wheels };
    });
    return { model, lods, capacity };
  }

  private clear(): void {
    for (const set of this.sets.values()) {
      for (const lod of set.lods) {
        for (const m of [lod.body, lod.decals, lod.wheels]) {
          this.group.remove(m);
          m.geometry.dispose();
          m.dispose();
        }
      }
    }
    this.sets.clear();
    if (this.shadowMesh) {
      this.group.remove(this.shadowMesh);
      this.shadowMesh.geometry.dispose();
      this.shadowMesh.dispose();
      this.shadowMesh = null;
    }
    this.decalMat?.dispose();
    this.decalMat = null;
    this.atlas?.dispose();
    this.atlas = null;
    this.looks = [];
    this.safetyLook = null;
    this.spread.clear();
    this.aside.clear();
    this.lastT = -1;
    this.pool.clear();
    this.shown = [];
  }

  /** Places every car for the race at `alpha` between its last two steps, as seen by `camera` (for the level of detail). */
  update(sim: RaceSim, alpha: number, ctx: CarContext, camera: THREE.PerspectiveCamera, viewHeight: number): void {
    if (sim !== this.sim) this.setRace(sim);
    const m = sim.model;
    const t = m.track;
    const line = m.line;
    const n = t.n;
    const ds = t.ds;
    const now = sim.t - DT * (1 - alpha);
    const dt = this.lastT < 0 ? Infinity : now - this.lastT;
    this.lastT = now;
    const lerpU = (car: RaceCar) => car.prevU + (car.u - car.prevU) * alpha;
    // Side by side where cars would overlap.
    const onTrack = sim.cars.filter((c) => c.status === 'running');
    this.spread = spreadCars(
      onTrack.map((c) => ({ id: c.id, u: lerpU(c), lateral: c.lateral, length: this.looks[c.id].set.model.length, width: this.looks[c.id].set.model.width })),
      { n, ds, width: t.width, lineOffset: line.offset },
      this.spread, dt,
    );
    const surface = (x: number, y: number) => {
      const z = ctx.earth.height(x, y);
      return z + (ctx.earth.lastRoad ? SINK : 0);
    };
    const pxPerM = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const shown: ShownCar[] = [];
    const place = (id: number, look: CarLook, x: number, y: number, heading: number, dist: number, speed: number, curvature: number, steerK: number, drs: number, compound: [number, number, number]) => {
      const model = look.set.model;
      let s = this.pool.get(id);
      if (!s || s.look !== look) {
        s = { id, look, matrix: new THREE.Matrix4(), wheels: model.wheels.map(() => new THREE.Matrix4()), position: new THREE.Vector3(), drs, compound, lod: 2 };
        this.pool.set(id, s);
      }
      const cx = Math.cos(heading);
      const cy = Math.sin(heading);
      const half = model.wheelbase / 2;
      const yf = ctx.sceneY(surface(x + cx * half, y + cy * half));
      const yr = ctx.sceneY(surface(x - cx * half, y - cy * half));
      const pitch = Math.atan2(yf - yr, model.wheelbase);
      const roll = model.kind === 'bike' ? Math.max(-1.0, Math.min(1.0, Math.atan((speed * speed * curvature) / 9.81))) : 0;
      tmpV.set(x, (yf + yr) / 2, y);
      tmpQ.setFromEuler(tmpE.set(roll, -heading, pitch, 'YZX'));
      s.matrix.compose(tmpV, tmpQ, ONE);
      const steer = Math.max(-0.45, Math.min(0.45, Math.atan(model.wheelbase * steerK)));
      model.wheels.forEach((w, j) => {
        const flip = w.z < 0;
        const spin = (dist / w.radius) * (flip ? 1 : -1);
        // Steer, turn the left wheels round (outer face out), then spin about the axle.
        tmpQ.setFromAxisAngle(AXIS_Y, w.front ? -steer : 0);
        if (flip) tmpQ.multiply(FLIP);
        tmpQ.multiply(tmpQ2.setFromAxisAngle(AXIS_Z, spin));
        tmpS.set(w.radius / model.wheelRadius, w.radius / model.wheelRadius, w.width / model.wheelWidth);
        tmpM.compose(tmpV2.set(w.x, w.y, w.z), tmpQ, tmpS);
        s!.wheels[j].multiplyMatrices(s!.matrix, tmpM);
      });
      s.position.set(0, model.height / 2, 0).applyMatrix4(s.matrix);
      s.drs = drs;
      s.compound = compound;
      const px = (model.length / Math.max(1, camera.position.distanceTo(s.position))) * pxPerM;
      s.lod = px > LOD_FULL ? 0 : px > LOD_MEDIUM ? 1 : 2;
      shown.push(s);
    };
    for (const car of sim.cars) {
      if (car.status === 'finished') continue;
      const look = this.looks[car.id];
      const compoundHex = car.rules.tyres.compounds[car.compound]?.color ?? '#dddddd';
      const compound = linearRgb(compoundHex);
      if (car.status === 'retired') {
        const pose = sim.pose(car, alpha);
        if (!pose) continue;
        // Parked beside the track, turned off the racing line.
        const near = this.index?.nearest(pose.x, pose.y, 60);
        const heading = near ? t.heading[near.k] + 0.5 : 0;
        place(car.id, look, pose.x, pose.y, heading, 0, 0, 0, 0, 0, compound);
        continue;
      }
      if (car.status === 'pit') {
        const pose = sim.pose(car, alpha);
        if (!pose) continue;
        // In its box: aside from the fast lane, towards the garage.
        const want = car.pit?.stopped ? 3.2 : 0;
        const prev = this.aside.get(car.id) ?? 0;
        const a = dt > 5 ? want : prev + Math.max(-dt * 2, Math.min(dt * 2, want - prev));
        this.aside.set(car.id, a);
        const off = a * ctx.pitSide;
        const x = pose.x + Math.sin(pose.heading) * off;
        const y = pose.y - Math.cos(pose.heading) * off;
        const p = car.pit ? car.pit.prevP + (car.pit.p - car.pit.prevP) * alpha : 0;
        place(car.id, look, x, y, pose.heading, p, car.v, 0, 0, 0, compound);
        continue;
      }
      this.aside.delete(car.id);
      const u = lerpU(car);
      const lateral = car.lateral + (this.spread.get(car.id) ?? 0);
      const p = linePoint(line, n, u, lateral);
      const k = Math.floor(((u % n) + n) % n) % n;
      const drs = car.drsUntilU > u ? 1 : 0;
      place(car.id, look, p.x, p.y, p.heading, u * ds, car.v, line.curvature[k], line.curvature[k], drs, compound);
    }
    const sc = sim.safetyCar;
    if (sc && this.safetyLook) {
      const u = sc.prevU + (sc.u - sc.prevU) * alpha;
      const p = linePoint(line, n, u, 0);
      const k = Math.floor(((u % n) + n) % n) % n;
      place(SAFETY_ID, this.safetyLook, p.x, p.y, p.heading, u * ds, ((sc.u - sc.prevU) * ds) / DT, 0, line.curvature[k], 0, linearRgb('#dddddd'));
    }
    this.shown = shown;
    // Forget cars no longer shown (finished).
    if (this.pool.size > shown.length) {
      const ids = new Set(shown.map((s) => s.id));
      for (const id of this.pool.keys()) if (!ids.has(id)) this.pool.delete(id);
    }
    this.write();
  }

  /** Writes the shown cars into the instanced meshes. */
  private write(): void {
    for (const set of this.sets.values()) {
      for (let level = 0; level < set.lods.length; level++) {
        const lod = set.lods[level];
        const cars = this.shown.filter((s) => s.look.set === set && s.lod === level);
        const wheelsPer = set.model.wheels.length;
        lod.body.count = cars.length;
        lod.decals.count = cars.length;
        lod.wheels.count = cars.length * wheelsPer;
        const g = lod.body.geometry;
        const livA = g.getAttribute('livA') as THREE.InstancedBufferAttribute;
        const livB = g.getAttribute('livB') as THREE.InstancedBufferAttribute;
        const livC = g.getAttribute('livC') as THREE.InstancedBufferAttribute;
        const style = g.getAttribute('livStyle') as THREE.InstancedBufferAttribute;
        const cell = lod.decals.geometry.getAttribute('decalCell') as THREE.InstancedBufferAttribute;
        const tint = lod.wheels.geometry.getAttribute('livA') as THREE.InstancedBufferAttribute;
        cars.forEach((s, i) => {
          lod.body.setMatrixAt(i, s.matrix);
          lod.decals.setMatrixAt(i, s.matrix);
          livA.setXYZ(i, ...s.look.a);
          livB.setXYZ(i, ...s.look.b);
          livC.setXYZ(i, ...s.look.c);
          style.setXYZW(i, s.look.pattern, s.look.variation, s.drs, 0);
          cell.setXY(i, ...s.look.cell);
          s.wheels.forEach((w, j) => {
            lod.wheels.setMatrixAt(i * wheelsPer + j, w);
            tint.setXYZ(i * wheelsPer + j, ...s.compound);
          });
        });
        for (const a of [livA, livB, livC, style, cell, tint]) a.needsUpdate = true;
        lod.body.instanceMatrix.needsUpdate = true;
        lod.decals.instanceMatrix.needsUpdate = true;
        lod.wheels.instanceMatrix.needsUpdate = true;
      }
    }
    const sh = this.shadowMesh;
    if (sh) {
      sh.count = this.shown.length;
      this.shown.forEach((s, i) => {
        const model = s.look.set.model;
        s.matrix.decompose(tmpV, tmpQ, tmpS);
        tmpV.y += 0.03;
        tmpS.set(model.length * 1.08, 1, model.width * (model.kind === 'bike' ? 1.6 : 1.2));
        sh.setMatrixAt(i, tmpM.compose(tmpV, tmpQ, tmpS));
      });
      sh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The middle of a car on screen, scene coordinates, or null when it is not shown. */
  positionOf(id: number): THREE.Vector3 | null {
    return this.shown.find((s) => s.id === id)?.position ?? null;
  }

  /** The car under a point on screen (normalised device coordinates), within about `radius` pixels. */
  pick(px: number, py: number, camera: THREE.Camera, width: number, height: number, radius = 26): number | null {
    let best: number | null = null;
    let bestD = radius;
    const v = new THREE.Vector3();
    for (const s of this.shown) {
      if (s.id === SAFETY_ID) continue;
      v.copy(s.position).project(camera);
      if (v.z > 1) continue;
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.shadowMaterial.map?.dispose();
    this.shadowMaterial.dispose();
    this.envMap.dispose();
  }
}

/** A point on the racing line at a fractional station, `lateral` metres to its left, with the line's heading. */
function linePoint(line: RacingLine, n: number, u: number, lateral: number): { x: number; y: number; heading: number } {
  const pos = ((u % n) + n) % n;
  const k = Math.floor(pos) % n;
  const k1 = (k + 1) % n;
  const f = pos - Math.floor(pos);
  // Heading between the two stations, the short way round.
  let dh = line.heading[k1] - line.heading[k];
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  const h = line.heading[k] + dh * f;
  return {
    x: line.x[k] + (line.x[k1] - line.x[k]) * f + Math.sin(h) * lateral,
    y: line.y[k] + (line.y[k1] - line.y[k]) * f - Math.cos(h) * lateral,
    heading: h,
  };
}
