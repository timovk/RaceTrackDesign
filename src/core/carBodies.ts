/**
 * The 3D cars: single-seaters (Formula 1, Formula 2, IndyCar), prototypes
 * (Hypercar, LMP2), GT and touring cars, the safety car, and bikes with
 * their riders, each built from smooth swept bodies, airfoil wings, tubes
 * and plates (core/carMesh.ts), at three levels of detail.
 *
 * A car is a body mesh (paint and trim; the DRS flap marked to turn about
 * its hinge), a decal mesh (number panels and team names, coordinates in a
 * car's cell of the decal atlas) and one wheel (axle along z, outer face
 * towards +z), with where its wheels go. Sizes are those of the real cars.
 *
 * Car coordinates: x forward, y up, z to the right, origin on the ground
 * midway between the axles.
 */
import {
  CARBON, type CarMeshData, CarMeshBuilder, DARK_METAL, GLASS, LAMP, Loft, RUBBER, SATIN_BLACK, SectionPath, type Surface, TINT, type V3, ZONE,
  box, curve, decal, ellipsoid, flatDecal, paint, pipe, plate, revolve, smoothstep, stations, trim, tube, wing,
} from './carMesh.ts';

export type BodyKind = 'single-seater' | 'prototype' | 'gt' | 'touring' | 'bike';

export interface WheelPlace {
  /** Centre, in car coordinates. */
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
  front: boolean;
}

export interface CarLod {
  body: CarMeshData;
  decals: CarMeshData;
  /** One wheel: centred on the origin, axle along z, outer face towards +z, at this wheel size (scaled per wheel). */
  wheel: CarMeshData;
}

export interface CarModel {
  id: string;
  kind: BodyKind;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  wheels: WheelPlace[];
  /** Full detail first. */
  lods: CarLod[];
  /** The driver's eye, for an onboard view. */
  eye: V3;
  /** The wheel mesh is built at this radius and width; each wheel scales it to its own. */
  wheelRadius: number;
  wheelWidth: number;
  /** The lights that switch on and off (LAMP kinds), each at its middle in car coordinates. */
  lamps: LampPlace[];
}

export interface LampPlace {
  kind: number;
  at: V3;
}

/**
 * The lights of a body mesh: its lamp vertices grouped by kind, and by side
 * of the car for a kind that reaches out to the sides (a pair), each group
 * at its middle.
 */
export function lampPlaces(body: CarMeshData): LampPlace[] {
  const reach = new Map<number, number>();
  for (let i = 0; i < body.lamp.length; i++) {
    if (body.lamp[i]) reach.set(body.lamp[i], Math.max(reach.get(body.lamp[i]) ?? 0, Math.abs(body.positions[i * 3 + 2])));
  }
  const groups = new Map<string, { kind: number; sum: V3; count: number }>();
  for (let i = 0; i < body.lamp.length; i++) {
    const kind = body.lamp[i];
    if (!kind) continue;
    const z = body.positions[i * 3 + 2];
    const key = `${kind}:${reach.get(kind)! > 0.15 ? Math.sign(z) : 0}`;
    const g = groups.get(key) ?? { kind, sum: [0, 0, 0] as V3, count: 0 };
    for (let j = 0; j < 3; j++) g.sum[j] += body.positions[i * 3 + j];
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ kind: g.kind, at: g.sum.map((v) => v / g.count) as V3 }));
}

/** Where decals take their picture from in a car's cell of the decal atlas (u0, v0, u1, v1): the number panel (upper half) and the team name (lower half). */
export const DECAL_NUMBER: readonly [number, number, number, number] = [0, 0.5, 1, 1];
export const DECAL_NUMBER_SQUARE: readonly [number, number, number, number] = [0.25, 0.5, 0.75, 1];
export const DECAL_TEAM: readonly [number, number, number, number] = [0, 0.05, 1, 0.45];

/** Segment counts for a level of detail (0 full, 1 medium, 2 far). */
function steps(n: number, lod: number): number {
  return Math.max(1, Math.round(n / [1, 2, 4][lod]));
}

const RIGHT: V3 = [1, 0, 0];
const UP: V3 = [0, 1, 0];

/** Directions for a decal read from the right side, the left side, and from in front looking down at the top. */
const SIDE_R = { right: RIGHT, up: UP };
const SIDE_L = { right: [-1, 0, 0] as V3, up: UP };
const TOP = { right: [0, 0, -1] as V3, up: [-1, 0, 0] as V3 };

/** Repeats each crease position (a sharp change of surface across the body) in a list of stations, front to rear. */
function withCreases(base: number[], creases: number[]): { xs: number[]; region: number[] } {
  const xs = [...base.filter((x) => !creases.some((c) => Math.abs(c - x) < 0.01)), ...creases, ...creases].sort((a, b) => b - a);
  // The first of a repeated pair belongs to the region in front of it, the second to the one behind.
  const region = xs.map((x, i) => (i > 0 && xs[i - 1] === x ? x - 1e-4 : i + 1 < xs.length && xs[i + 1] === x ? x + 1e-4 : x));
  return { xs, region };
}

// ---- wheels --------------------------------------------------------------------

/**
 * A wheel at unit size proportions: the tyre with its compound band on the
 * outer sidewall (tinted per car), the rim and the wheel cover or spokes.
 */
function buildWheel(radius: number, width: number, rimRadius: number, lod: number, spokes: boolean): CarMeshData {
  const mb = new CarMeshBuilder();
  const w = width / 2;
  const R = radius;
  const r = rimRadius;
  const cover = trim([0.06, 0.062, 0.066], { roughness: 0.3, metalness: 1 });
  const rim = trim(spokes ? [0.42, 0.43, 0.45] : [0.09, 0.09, 0.1], { roughness: 0.3, metalness: 1 });
  const seg = steps(48, lod);
  const profile: { r: number; z: number; surface: Surface; hard?: boolean }[] = [
    { r: 0.001, z: w - 0.045, surface: cover },
    { r: r * 0.35, z: w - 0.04, surface: cover },
    { r: r - 0.025, z: w - 0.03, surface: cover, hard: true },
    { r: r - 0.01, z: w - 0.012, surface: rim },
    { r, z: w - 0.004, surface: rim, hard: true },
    { r: r + 0.012, z: w + 0.004, surface: RUBBER, hard: true },
    { r: r + 0.03, z: w + 0.012, surface: RUBBER, hard: true },
    { r: r + 0.052, z: w + 0.016, surface: TINT, hard: true },
    { r: R - 0.06, z: w + 0.012, surface: RUBBER },
    { r: R - 0.025, z: w - 0.008, surface: RUBBER },
    { r: R - 0.004, z: w - 0.035, surface: RUBBER },
    { r: R, z: w - 0.06, surface: RUBBER },
    { r: R, z: -w + 0.06, surface: RUBBER },
    { r: R - 0.004, z: -w + 0.035, surface: RUBBER },
    { r: R - 0.025, z: -w + 0.008, surface: RUBBER },
    { r: R - 0.06, z: -w - 0.01, surface: RUBBER },
    { r: r + 0.012, z: -w - 0.004, surface: RUBBER, hard: true },
    { r, z: -w + 0.004, surface: rim },
    { r: r - 0.02, z: -w + 0.03, surface: DARK_METAL },
    { r: 0.001, z: -w + 0.05, surface: DARK_METAL },
  ];
  const simple = lod === 2 ? profile.filter((_, i) => [0, 2, 4, 5, 7, 8, 11, 12, 15, 16, 17, 19].includes(i)) : profile;
  revolve(mb, [0, 0, 0], simple, seg);
  if (lod < 2) {
    // The wheel nut, and spokes behind an open rim (wheels without covers).
    tube(mb, [0, 0, w - 0.05], [0, 0, w - 0.005], 0.035, 0.03, steps(12, lod), trim([0.7, 0.6, 0.1], { roughness: 0.3, metalness: 1 }));
    if (spokes) {
      const n = 10;
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const d: V3 = [Math.cos(a), Math.sin(a), 0];
        tube(mb, [d[0] * 0.05, d[1] * 0.05, w - 0.04], [d[0] * (r - 0.02), d[1] * (r - 0.02), w - 0.025], 0.014, 0.01, 5, rim, 0.5);
      }
    }
  }
  return mb.build();
}

// ---- single-seaters ------------------------------------------------------------

interface SingleSeaterSpec {
  id: string;
  wheelbase: number;
  width: number;
  /** Front and rear overhang from the axles to the nose tip and the rear wing's trailing edge. */
  front: number;
  rear: number;
  tyreR: number;
  frontW: number;
  rearW: number;
  rimR: number;
  /** Top of the airbox / roll hoop. */
  height: number;
  screen: 'halo' | 'aeroscreen';
  /** Modern wide sidepods with a downwash ramp, or slimmer older ones. */
  sidepods: 'modern' | 'classic';
  frontWingElements: number;
  wheelCovers: boolean;
}

const F1: SingleSeaterSpec = {
  id: 'f1', wheelbase: 3.6, width: 2.0, front: 1.13, rear: 0.92, tyreR: 0.36, frontW: 0.305, rearW: 0.405, rimR: 0.23,
  height: 0.96, screen: 'halo', sidepods: 'modern', frontWingElements: 4, wheelCovers: true,
};
const F2: SingleSeaterSpec = {
  id: 'f2', wheelbase: 3.135, width: 1.9, front: 1.05, rear: 0.95, tyreR: 0.34, frontW: 0.29, rearW: 0.38, rimR: 0.23,
  height: 1.0, screen: 'halo', sidepods: 'classic', frontWingElements: 2, wheelCovers: false,
};
const INDYCAR: SingleSeaterSpec = {
  id: 'indycar', wheelbase: 3.0, width: 1.97, front: 1.12, rear: 1.05, tyreR: 0.33, frontW: 0.26, rearW: 0.36, rimR: 0.19,
  height: 1.02, screen: 'aeroscreen', sidepods: 'classic', frontWingElements: 3, wheelCovers: false,
};

function singleSeater(s: SingleSeaterSpec, lod: number): { body: CarMeshData; decals: CarMeshData } {
  const mb = new CarMeshBuilder();
  const dm = new CarMeshBuilder();
  const fa = s.wheelbase / 2;
  const ra = -s.wheelbase / 2;
  const tip = fa + s.front;
  const tail = ra - s.rear;
  const u = (x: number) => (x - tail) / (tip - tail);
  const fz = s.width / 2 - s.frontW / 2;
  const rz = s.width / 2 - s.rearW / 2;
  const H = s.height;
  // The cockpit opening and the driver: just behind the middle of the car.
  const cockpitFront = fa - 1.0;
  const cockpitRear = fa - 1.95;
  const helmetX = fa - 1.6;
  const k = (pts: [number, number][]) => curve(pts.map(([x, v]) => [x, v] as [number, number]));
  // Chassis: nose, monocoque and engine cover; heights relative to the axles.
  const bottom = k([[tip, 0.17], [fa + 0.4, 0.13], [fa - 0.4, 0.09], [ra, 0.09], [tail + 0.6, 0.12]]);
  const top = k([[tip, 0.27], [fa + 0.6, 0.38], [fa - 0.2, 0.56], [cockpitFront, 0.66], [cockpitRear, 0.67], [cockpitRear - 0.5, 0.62], [ra + 0.4, 0.47], [ra - 0.1, 0.38], [tail + 0.65, 0.33]]);
  const half = k([[tip, 0.06], [fa + 0.6, 0.11], [fa, 0.16], [fa - 0.5, 0.25], [cockpitFront, 0.35], [cockpitRear + 0.15, 0.4], [cockpitRear - 0.35, 0.34], [ra + 0.9, 0.26], [ra + 0.1, 0.17], [tail + 0.65, 0.1]]);
  // The airbox above and behind the driver, tapering into the engine cover spine.
  const airTop = k([[cockpitRear + 0.05, 0.67], [cockpitRear - 0.18, H - 0.03], [cockpitRear - 0.6, H - 0.12], [ra + 0.9, 0.72], [ra + 0.2, 0.5], [tail + 0.65, 0.34]]);
  const airHalf = k([[cockpitRear + 0.05, 0.23], [cockpitRear - 0.2, 0.15], [cockpitRear - 0.8, 0.14], [ra + 0.3, 0.11], [tail + 0.65, 0.08]]);
  const base = stations(tip, tail + 0.62, steps(56, lod), (x) => 1 + 2.5 * Math.exp(-(((x - helmetX) / 0.9) ** 2)) + 1.5 * Math.exp(-(((x - tip) / 0.3) ** 2)));
  const { xs, region } = withCreases(base, [cockpitFront, cockpitRear]);
  const n = (v: number) => steps(v, lod);
  const body = paint(ZONE.body);
  const chassis = new Loft(mb, {
    stations: xs,
    u,
    capRear: SATIN_BLACK,
    section: (x, i) => {
      const rx = region[i];
      const inCockpit = rx < cockpitFront && rx > cockpitRear;
      const b = bottom(x);
      const t = top(x);
      const w = half(x);
      const behind = rx <= cockpitRear + 0.05;
      const at = behind ? Math.max(t, airTop(x)) : t;
      const aw = behind ? Math.min(airHalf(x), w * 0.7) : w * 0.6;
      const p = new SectionPath(0, b, body);
      p.line(w * 0.55, b, n(2)).round(w, b + (t - b) * 0.3, n(4), 2.6, 'across').line(w, t - (t - b) * 0.22, n(2)).round(w * 0.62, t, n(5), 2.4, 'up');
      if (inCockpit) {
        // The cockpit: down into the opening round the driver.
        p.line(0.27, t, 1).use(SATIN_BLACK).round(0.2, t - 0.26, n(4), 2, 'up').line(0, t - 0.28, 1);
      } else {
        p.line(aw, t, 1).round(aw * 0.45, at, n(4), 2.2, 'up').line(0, at, 1);
      }
      return p;
    },
  });
  // Sidepods.
  const podFront = s.sidepods === 'modern' ? fa - 1.15 : fa - 1.25;
  const podRear = ra + 0.25;
  const podTop = k(s.sidepods === 'modern'
    ? [[podFront, 0.6], [podFront - 0.5, 0.62], [podFront - 1.2, 0.5], [podRear + 0.3, 0.32], [podRear, 0.24]]
    : [[podFront, 0.56], [podFront - 0.4, 0.58], [podRear + 0.6, 0.45], [podRear, 0.3]]);
  const podHalf = k(s.sidepods === 'modern'
    ? [[podFront, 0.19], [podFront - 0.4, 0.23], [podFront - 1.1, 0.2], [podRear + 0.3, 0.1], [podRear, 0.05]]
    : [[podFront, 0.15], [podFront - 0.4, 0.18], [podRear + 0.5, 0.13], [podRear, 0.05]]);
  const podZ = k([[podFront, s.width / 2 - 0.42], [podFront - 0.8, s.width / 2 - 0.45], [podRear + 0.3, 0.36], [podRear, 0.26]]);
  const podStart = mb.vertexCount;
  new Loft(mb, {
    stations: stations(podFront, podRear, n(22), (x) => 1 + 2 * Math.exp(-(((x - podFront) / 0.3) ** 2))),
    u,
    offsetZ: podZ,
    capFront: SATIN_BLACK,
    section: (x) => {
      const b = 0.1;
      const t = podTop(x);
      const w = podHalf(x);
      return new SectionPath(0, b, paint(ZONE.side)).line(w * 0.7, b, n(2)).round(w, b + (t - b) * 0.35, n(3), 2.4, 'across').line(w, t - (t - b) * 0.3, n(2)).round(0, t, n(6), 2.2, 'up');
    },
  });
  mb.mirror(podStart);
  // Floor, with the diffuser rising behind the rear axle.
  const floorPts: [number, number][] = [
    [fa - 0.55, -0.45], [fa - 0.95, -(s.width / 2 - 0.08)], [ra + 0.42, -(s.width / 2 - 0.08)], [ra + 0.28, -(rz - s.rearW / 2 - 0.03)],
    [ra - 0.05, -(rz - s.rearW / 2 - 0.03)], [ra - 0.05, rz - s.rearW / 2 - 0.03], [ra + 0.28, rz - s.rearW / 2 - 0.03],
    [ra + 0.42, s.width / 2 - 0.08], [fa - 0.95, s.width / 2 - 0.08], [fa - 0.55, 0.45],
  ];
  plate(mb, floorPts, 0.045, 0.02, CARBON, true);
  const diffStart = mb.vertexCount;
  plate(mb, [[0, -0.48], [0, 0.48], [-0.62, 0.5], [-0.62, -0.5]], 0, 0.015, CARBON, true);
  const tilt = 0.4;
  mb.transform(diffStart, ([x, y, z]) => [ra - 0.05 + x * Math.cos(tilt), 0.05 + y - x * Math.sin(tilt), z], ([x, y, z]) => [x * Math.cos(tilt) + y * Math.sin(tilt), y * Math.cos(tilt) - x * Math.sin(tilt), z]);
  if (lod < 2) {
    for (const side of [1, -1]) plate(mb, [[ra - 0.05, 0.05], [ra - 0.67, 0.31], [ra - 0.67, 0.36], [ra - 0.05, 0.12]], side * 0.48, 0.012, CARBON);
  }
  // Front wing: elements rising and steepening towards the back, with endplates.
  const wingLE = tip + 0.06;
  const elements = lod === 2 ? 1 : lod === 1 ? Math.min(2, s.frontWingElements) : s.frontWingElements;
  const span = s.width / 2 - 0.01;
  // Elements stacked up and back over the main plane, each steeper, rising towards the endplates: [behind the front, height, chord, angle].
  const layout: [number, number, number, number][] = [[0, 0.075, 0.28, 0.04], [0.19, 0.112, 0.15, 0.2], [0.29, 0.145, 0.12, 0.36], [0.37, 0.178, 0.1, 0.52]];
  for (let e = 0; e < elements; e++) {
    const [back, y, chord, angle] = layout[e];
    const le = wingLE - back;
    const surf = e === 0 ? CARBON : paint(e === elements - 1 ? ZONE.solidB : ZONE.solidA);
    for (const side of [1, -1]) {
      wing(mb, {
        from: [le, y, side * (e === 0 ? 0 : 0.16)], to: [le - 0.05 * e, y + 0.035 * e, side * span], chord, tipChord: chord * 0.9,
        angle, thickness: 0.09, n: steps(10, lod), spanSteps: lod === 0 ? 3 : 1, surface: surf, u: u(le), caps: true,
      });
    }
  }
  for (const side of [1, -1]) {
    plate(mb, [[wingLE + 0.03, 0.03], [wingLE + 0.03, 0.22], [wingLE - 0.4, 0.33], [wingLE - 0.55, 0.25], [wingLE - 0.55, 0.03]], side * (span + 0.008), 0.016, paint(ZONE.solidA), false, u(wingLE));
  }
  if (lod < 2) for (const side of [1, -1]) plate(mb, [[tip - 0.02, 0.1], [tip - 0.32, 0.1], [tip - 0.36, 0.2], [tip - 0.05, 0.2]], side * 0.07, 0.014, CARBON);
  // Rear wing: main plane and the DRS flap between endplates, the beam wing below, on a central pylon.
  const rwSpan = 0.48;
  const rwLE = tail + 0.5;
  wing(mb, { from: [rwLE, H - 0.17, -rwSpan], to: [rwLE, H - 0.17, rwSpan], chord: 0.3, angle: 0.22, camber: 0.08, n: steps(12, lod), spanSteps: lod === 0 ? 2 : 1, surface: CARBON, u: u(rwLE), caps: false });
  const flapLE = rwLE - 0.2;
  const flapChord = 0.2;
  const flapAngle = 0.55;
  const flapY = H - 0.07;
  mb.flapHinge = [flapLE - flapChord * Math.cos(flapAngle), flapY + flapChord * Math.sin(flapAngle)];
  wing(mb, { from: [flapLE, flapY, -rwSpan], to: [flapLE, flapY, rwSpan], chord: flapChord, angle: flapAngle, camber: 0.07, n: steps(10, lod), spanSteps: 1, surface: paint(ZONE.solidA), u: u(flapLE), caps: false });
  mb.flapHinge = null;
  for (const side of [1, -1]) {
    plate(mb, [[rwLE + 0.08, 0.42], [rwLE + 0.05, H + 0.04], [tail - 0.02, H + 0.06], [tail - 0.04, 0.72], [tail + 0.2, 0.42]], side * (rwSpan + 0.01), 0.02, paint(ZONE.solidA), false, u(rwLE));
    // Team name on the outer face of each endplate.
    if (lod < 2) flatDecal(dm, [rwLE - 0.22, H - 0.22, side * (rwSpan + 0.021)], side > 0 ? SIDE_R.right : SIDE_L.right, UP, 0.5, 0.2, DECAL_TEAM);
  }
  if (lod < 2) {
    wing(mb, { from: [ra - 0.18, 0.42, -0.38], to: [ra - 0.18, 0.42, 0.38], chord: 0.16, angle: 0.15, n: steps(8, lod), surface: CARBON, u: u(ra), caps: true });
    plate(mb, [[ra - 0.1, 0.3], [ra - 0.1, 0.42], [rwLE - 0.1, H - 0.16], [rwLE - 0.25, H - 0.16], [ra - 0.3, 0.3]], 0, 0.03, CARBON);
    // Rain light.
    box(mb, [tail + 0.6, 0.33, -0.05], [tail + 0.63, 0.39, 0.05], { ...trim([0.5, 0.02, 0.02], { emissive: 0.6, roughness: 0.6 }), lamp: LAMP.rain });
  }
  // Shark fin.
  if (lod < 2) plate(mb, [[cockpitRear - 0.5, H - 0.1], [ra + 0.05, 0.62], [ra + 0.05, 0.8], [cockpitRear - 1.0, H - 0.14]], 0, 0.012, paint(ZONE.solidA));
  // The driver's helmet in the cockpit, the visor towards the front.
  const visorSurface = GLASS;
  const helmet = paint(ZONE.solidC);
  ellipsoid(mb, [helmetX, 0.74, 0], [0.16, 0.135, 0.125], steps(24, lod), steps(14, lod), (d) => (d[0] > 0.55 && d[1] > -0.25 && d[1] < 0.35 ? visorSurface : helmet), [-0.5, Math.PI / 2]);
  if (s.screen === 'halo') {
    // Halo: a hoop round the cockpit from mounts behind the driver to a point in front, with the centre pillar.
    const pts: V3[] = [];
    const m = steps(20, lod);
    for (let i = 0; i <= m; i++) {
      const a = -Math.PI * 0.62 + (Math.PI * 1.24 * i) / m;
      const fwd = Math.cos(a);
      pts.push([helmetX + 0.08 + fwd * 0.42, 0.7 + 0.12 * Math.max(0, fwd) ** 0.5, Math.sin(a) * 0.33]);
    }
    pipe(mb, pts, 0.028, steps(8, lod), paint(ZONE.solidB), 0.75);
    if (lod < 2) tube(mb, [helmetX + 0.5, 0.82, 0], [cockpitFront + 0.08, top(cockpitFront + 0.08) - 0.01, 0], 0.024, 0.03, 8, paint(ZONE.solidB), 0.6);
  } else {
    // Aeroscreen: a tinted screen round the front of the cockpit in a frame.
    ellipsoid(mb, [helmetX + 0.02, 0.62, 0], [0.62, 0.36, 0.38], steps(20, lod), steps(6, lod), () => trim([0.05, 0.06, 0.07], { roughness: 0.05, clearcoat: 1 }), [0.15, 0.95], [-1.25, 1.25]);
    const pts: V3[] = [];
    const m = steps(20, lod);
    for (let i = 0; i <= m; i++) {
      const a = -1.25 + (2.5 * i) / m;
      pts.push([helmetX + 0.02 + Math.cos(a) * 0.62 * Math.cos(0.95), 0.62 + 0.36 * Math.sin(0.95), Math.sin(a) * 0.38 * Math.cos(0.95)]);
    }
    pipe(mb, pts, 0.03, steps(8, lod), paint(ZONE.solidB), 0.7);
  }
  if (lod < 2) {
    // Mirrors on stalks, and the onboard camera on top of the airbox.
    for (const side of [1, -1]) {
      const mx = cockpitFront + 0.15;
      tube(mb, [mx, 0.6, side * 0.3], [mx, 0.69, side * 0.43], 0.012, 0.012, 6, CARBON);
      box(mb, [mx - 0.05, 0.66, side > 0 ? 0.42 : -0.56], [mx + 0.03, 0.73, side > 0 ? 0.56 : -0.42], paint(ZONE.solidB));
    }
    box(mb, [cockpitRear - 0.28, H - 0.04, -0.045], [cockpitRear - 0.14, H + 0.005, 0.045], paint(ZONE.solidC));
  }
  // Suspension: wishbones, push or pull rods and track rods, flattened like aero fairings.
  if (lod === 0) {
    const arms = (ax: number, wz: number, wR: number, front: boolean) => {
      const inner = (dx: number, y: number) => [ax + dx, y, Math.max(0.12, half(ax + dx) - 0.02)] as V3;
      const upTop: V3 = [ax, wR + 0.12, wz - 0.12];
      const upBot: V3 = [ax, wR - 0.14, wz - 0.12];
      for (const [a, b] of [
        [inner(0.2, 0.48), upTop], [inner(-0.25, 0.5), upTop],
        [inner(0.25, 0.2), upBot], [inner(-0.3, 0.18), upBot],
        [[ax - 0.04, wR - 0.1, wz - 0.14] as V3, inner(-0.1, front ? 0.55 : 0.15)],
        [inner(front ? 0.1 : -0.12, 0.3), [ax + (front ? 0.08 : -0.08), wR, wz - 0.12] as V3],
      ] as [V3, V3][]) {
        for (const side of [1, -1]) tube(mb, [a[0], a[1], side * a[2]], [b[0], b[1], side * b[2]], 0.022, 0.018, 6, CARBON, 0.4, [1, 0, 0]);
      }
    };
    arms(fa, fz, s.tyreR, true);
    arms(ra, rz, s.tyreR, false);
  }
  // Decals: the car number on the nose, and on each side of the engine cover; the team name on the sidepods.
  const noseX = tip - 0.5;
  decal(dm, chassis, [noseX, top(noseX) + 0.05, 0], TOP.right, TOP.up, 0.38, 0.19, DECAL_NUMBER, steps(6, lod), steps(3, lod));
  const coverX = cockpitRear - 0.35;
  for (const [side, dir] of [[1, SIDE_R], [-1, SIDE_L]] as const) {
    decal(dm, chassis, [coverX, (top(coverX) + airTop(coverX)) / 2, side * 0.3], dir.right, dir.up, 0.3, 0.15, DECAL_NUMBER, steps(6, lod), steps(3, lod));
  }
  void podStart;
  return { body: mb.build(), decals: dm.build() };
}

function singleSeaterModel(s: SingleSeaterSpec): CarModel {
  const fz = s.width / 2 - s.frontW / 2;
  const rz = s.width / 2 - s.rearW / 2;
  const fa = s.wheelbase / 2;
  const lods = [0, 1, 2].map((lod) => ({ ...singleSeater(s, lod), wheel: buildWheel(s.tyreR, s.rearW, s.rimR, lod, !s.wheelCovers) }));
  return {
    id: s.id, kind: 'single-seater', length: s.wheelbase + s.front + s.rear, width: s.width, height: s.height, wheelbase: s.wheelbase,
    wheels: [
      { x: fa, y: s.tyreR, z: fz, radius: s.tyreR, width: s.frontW, front: true },
      { x: fa, y: s.tyreR, z: -fz, radius: s.tyreR, width: s.frontW, front: true },
      { x: -fa, y: s.tyreR, z: rz, radius: s.tyreR, width: s.rearW, front: false },
      { x: -fa, y: s.tyreR, z: -rz, radius: s.tyreR, width: s.rearW, front: false },
    ],
    lods, eye: [fa - 1.55, 0.78, 0], wheelRadius: s.tyreR, wheelWidth: s.rearW, lamps: lampPlaces(lods[0].body),
  };
}

// ---- closed cars: prototypes, GT and touring cars ------------------------------

interface ClosedSpec {
  id: string;
  kind: 'prototype' | 'gt' | 'touring';
  wheelbase: number;
  /** Front and rear overhang from the axles. */
  front: number;
  rear: number;
  width: number;
  tyreR: number;
  frontW: number;
  rearW: number;
  rimR: number;
  /** Underbody height. */
  floor: number;
  /** Side view, [x, y]: the shoulder line along the top of the sides, and the bonnet and deck on the centre line. */
  belt: [number, number][];
  deck: [number, number][];
  /** Plan view, [x, half width]: the body sides below the shoulder. */
  side: [number, number][];
  /** Extra width over the wheels. */
  flare: number;
  /** The greenhouse (or canopy): windscreen base, roof front and rear, rear window base (x); roof height; half widths at its base and at the roof; side windows between x. */
  cabin: { screenBase: number; roofFront: number; roofRear: number; rearBase: number; roof: number; baseHalf: number; roofHalf: number; windowFront: number; windowRear: number; rearWindow: boolean };
  /** Rear wing: leading edge x and height, half span, chord, angle; endplate height. */
  wing: { x: number; y: number; span: number; chord: number; angle: number; plate: number } | null;
  fin: boolean;
  splitter: number;
  lightBar?: boolean;
  spokes: boolean;
}

const HYPERCAR: ClosedSpec = {
  id: 'hypercar', kind: 'prototype', wheelbase: 3.15, front: 1.05, rear: 0.92, width: 2.0, tyreR: 0.355, frontW: 0.31, rearW: 0.34, rimR: 0.23, floor: 0.07,
  belt: [[2.6, 0.25], [2.45, 0.36], [2.2, 0.56], [1.85, 0.74], [1.575, 0.8], [1.15, 0.7], [0.75, 0.57], [-0.4, 0.58], [-1.0, 0.76], [-1.575, 0.84], [-2.1, 0.8], [-2.47, 0.74]],
  deck: [[2.6, 0.24], [2.3, 0.34], [1.4, 0.5], [0.8, 0.56], [-0.6, 0.6], [-1.4, 0.7], [-2.47, 0.72]],
  side: [[2.6, 0.66], [2.4, 0.86], [2.1, 0.96], [1.8, 0.98], [0.9, 0.86], [-0.4, 0.84], [-1.1, 0.96], [-2.2, 0.96], [-2.47, 0.9]],
  flare: 0.02,
  cabin: { screenBase: 1.35, roofFront: 0.35, roofRear: -0.45, rearBase: -1.45, roof: 1.06, baseHalf: 0.42, roofHalf: 0.3, windowFront: 0.3, windowRear: -0.4, rearWindow: false },
  wing: { x: -2.05, y: 1.0, span: 0.82, chord: 0.36, angle: 0.2, plate: 0.38 },
  fin: true, splitter: 0.08, spokes: false,
};

const LMP2: ClosedSpec = {
  ...HYPERCAR, id: 'lmp2', wheelbase: 3.0, front: 1.0, rear: 0.75,
  belt: [[2.5, 0.32], [2.2, 0.5], [1.75, 0.72], [1.5, 0.78], [1.1, 0.68], [0.7, 0.56], [-0.4, 0.57], [-0.95, 0.74], [-1.5, 0.82], [-2.0, 0.78], [-2.25, 0.72]],
  deck: [[2.5, 0.3], [2.0, 0.4], [1.3, 0.52], [0.7, 0.56], [-0.6, 0.58], [-1.4, 0.68], [-2.25, 0.7]],
  side: [[2.5, 0.75], [2.2, 0.92], [1.7, 0.98], [0.9, 0.84], [-0.4, 0.82], [-1.0, 0.96], [-2.0, 0.96], [-2.25, 0.88]],
  cabin: { screenBase: 1.3, roofFront: 0.3, roofRear: -0.45, rearBase: -1.4, roof: 1.04, baseHalf: 0.41, roofHalf: 0.29, windowFront: 0.25, windowRear: -0.4, rearWindow: false },
  wing: { x: -1.85, y: 0.98, span: 0.8, chord: 0.33, angle: 0.18, plate: 0.34 },
};

const GT3: ClosedSpec = {
  id: 'gt3', kind: 'gt', wheelbase: 2.6, front: 1.08, rear: 1.02, width: 2.0, tyreR: 0.345, frontW: 0.3, rearW: 0.33, rimR: 0.23, floor: 0.08,
  belt: [[2.38, 0.4], [2.25, 0.55], [2.0, 0.72], [1.6, 0.83], [1.3, 0.85], [0.9, 0.83], [0.0, 0.86], [-1.0, 0.9], [-1.3, 0.93], [-1.9, 0.92], [-2.32, 0.88]],
  deck: [[2.38, 0.38], [2.2, 0.55], [1.9, 0.68], [1.4, 0.76], [0.85, 0.8], [-1.55, 0.95], [-2.0, 0.94], [-2.32, 0.9]],
  side: [[2.38, 0.6], [2.25, 0.8], [2.0, 0.9], [1.6, 0.92], [0.9, 0.88], [-0.4, 0.86], [-1.0, 0.9], [-1.6, 0.94], [-2.32, 0.86]],
  flare: 0.08,
  cabin: { screenBase: 0.85, roofFront: 0.05, roofRear: -0.75, rearBase: -1.55, roof: 1.25, baseHalf: 0.74, roofHalf: 0.56, windowFront: 0.0, windowRear: -1.05, rearWindow: true },
  wing: { x: -1.88, y: 1.26, span: 0.86, chord: 0.34, angle: 0.2, plate: 0.3 },
  fin: false, splitter: 0.1, spokes: true,
};

const GT4: ClosedSpec = {
  ...GT3, id: 'gt4', tyreR: 0.34, frontW: 0.28, rearW: 0.3, width: 1.96, flare: 0.04,
  wing: { x: -1.95, y: 1.1, span: 0.75, chord: 0.26, angle: 0.15, plate: 0.2 }, splitter: 0.06,
};

const TCR: ClosedSpec = {
  id: 'tcr', kind: 'touring', wheelbase: 2.7, front: 0.95, rear: 0.78, width: 1.95, tyreR: 0.33, frontW: 0.27, rearW: 0.27, rimR: 0.23, floor: 0.09,
  belt: [[2.3, 0.45], [2.18, 0.6], [1.95, 0.78], [1.5, 0.87], [1.0, 0.9], [-1.0, 0.98], [-1.6, 1.0], [-2.13, 0.98]],
  deck: [[2.3, 0.44], [2.1, 0.62], [1.8, 0.76], [1.3, 0.83], [0.95, 0.87], [-1.3, 1.0], [-2.13, 1.0]],
  side: [[2.3, 0.64], [2.15, 0.84], [1.9, 0.93], [1.5, 0.95], [-1.5, 0.95], [-2.13, 0.9]],
  flare: 0.04,
  cabin: { screenBase: 0.95, roofFront: 0.15, roofRear: -1.25, rearBase: -1.85, roof: 1.42, baseHalf: 0.76, roofHalf: 0.6, windowFront: 0.1, windowRear: -1.55, rearWindow: true },
  wing: { x: -1.82, y: 1.45, span: 0.7, chord: 0.26, angle: 0.12, plate: 0.16 },
  fin: false, splitter: 0.06, spokes: true,
};

const SAFETY_CAR: ClosedSpec = { ...GT3, id: 'safety-car', flare: 0.03, wing: { x: -2.0, y: 1.0, span: 0.7, chord: 0.2, angle: 0.08, plate: 0.08 }, splitter: 0.04, lightBar: true };

function closedCar(s: ClosedSpec, lod: number): { body: CarMeshData; decals: CarMeshData } {
  const mb = new CarMeshBuilder();
  const dm = new CarMeshBuilder();
  const fa = s.wheelbase / 2;
  const ra = -s.wheelbase / 2;
  const tip = fa + s.front;
  const tail = ra - s.rear;
  const u = (x: number) => (x - tail) / (tip - tail);
  const n = (v: number) => steps(v, lod);
  const belt = curve(s.belt);
  const deck = curve(s.deck);
  const side = curve(s.side);
  const c = s.cabin;
  const fwz = s.width / 2 - 0.012 - s.frontW / 2;
  const rwz = s.width / 2 - 0.012 - s.rearW / 2;
  const axles = [{ x: fa, z: fwz, w: s.frontW }, { x: ra, z: rwz, w: s.rearW }];
  const R = s.tyreR + 0.035;
  /** The arch over a wheel at x: its top edge, the wheel's inner face, or null clear of the wheels. */
  const arch = (x: number) => {
    for (const a of axles) {
      const dx = x - a.x;
      if (Math.abs(dx) < R) return { y: s.tyreR + Math.sqrt(R * R - dx * dx), inner: a.z - a.w / 2 - 0.025 };
    }
    return null;
  };
  /** Body width at the shoulder: the sides, flared out over the wheels. */
  const outer = (x: number) => {
    let flare = 0;
    for (const a of axles) flare = Math.max(flare, Math.exp(-(((x - a.x) / 0.6) ** 2)));
    const over = Math.max(side(x) + s.flare * flare, ...axles.map((a) => (Math.abs(x - a.x) < R + 0.05 ? a.z + a.w / 2 + 0.01 : 0)));
    return over;
  };
  const roof = (x: number) => {
    const d = deck(x);
    if (x > c.screenBase || x < c.rearBase) return d;
    if (x > c.roofFront) return d + (c.roof - deck(c.screenBase)) * smoothstep(c.screenBase, c.roofFront, x);
    if (x > c.roofRear) return c.roof - 0.025 * Math.cos(((x - (c.roofFront + c.roofRear) / 2) / (c.roofFront - c.roofRear)) * Math.PI) - 0.0;
    return d + (c.roof - deck(c.rearBase)) * smoothstep(c.rearBase, c.roofRear, x);
  };
  const base = stations(tip, tail, n(64), (x) => 1 + 1.6 * Math.exp(-(((x - fa) / 0.4) ** 2)) + 1.6 * Math.exp(-(((x - ra) / 0.4) ** 2)) + 1.2 * Math.exp(-(((x - tip) / 0.25) ** 2)) + 1.2 * Math.exp(-(((x - tail) / 0.25) ** 2)));
  const creases = [c.screenBase, c.roofFront, c.roofRear, c.rearBase, c.windowFront, c.windowRear].filter((x, i, all) => all.indexOf(x) === i);
  const { xs, region } = withCreases(base, creases);
  const body = paint(ZONE.body);
  const glass = GLASS;
  const loft = new Loft(mb, {
    stations: xs,
    u,
    capFront: paint(ZONE.solidA),
    capRear: paint(ZONE.solidA),
    section: (x, i) => {
      const rx = region[i];
      const a = arch(x);
      const fl = s.floor;
      const b = belt(x);
      const d = Math.min(deck(x), b + 0.05);
      const top = Math.max(d, roof(x));
      const sideZ = outer(x);
      const low = a ? Math.min(a.inner, sideZ - 0.02) : sideZ;
      const archY = a ? Math.min(a.y, b - 0.06) : fl + 0.05;
      const shoulderZ = sideZ - Math.min(0.14, sideZ * 0.15);
      const baseZ = Math.min(c.baseHalf, shoulderZ - 0.05);
      const roofZ = Math.min(c.roofHalf, baseZ - 0.04);
      const cabinUp = top - d;
      // Glass down the sides from the windscreen to the end of the side windows (the pillars are the rounded roof edge).
      const windows = rx < c.screenBase && rx > c.windowRear && cabinUp > 0.15;
      const screen = (rx < c.screenBase && rx > c.roofFront) || (c.rearWindow && rx < c.roofRear && rx > c.rearBase);
      const p = new SectionPath(0, fl, SATIN_BLACK);
      p.line(low * 0.8, fl, 1).round(low, fl + 0.04, n(2), 2, 'across')
        // Under the arch: the inner wall up to the arch's edge, then the lip out to the body side.
        .line(low, Math.max(fl + 0.04, archY), 1).line(sideZ, Math.max(fl + 0.05, archY), 1)
        .use(body).line(sideZ, Math.max(archY + 0.02, b - 0.3), n(2))
        // Tumblehome: the side leans in towards the shoulder.
        .round(sideZ - 0.035, Math.max(archY + 0.04, b - 0.12), n(2), 2, 'up').round(shoulderZ, b, n(3), 2.4, 'up')
        .line(baseZ, d, n(3))
        .use(windows ? glass : body).line(roofZ, top - Math.min(0.06, cabinUp * 0.4), n(3))
        .use(screen ? glass : body).round(roofZ * 0.55, top, n(3), 2.2, 'up')
        .use(screen ? glass : body).line(0, top, n(2));
      return p;
    },
  });
  // Splitter, diffuser.
  if (s.splitter > 0) plate(mb, [[tip + s.splitter, -s.width / 2 + 0.2], [tip + s.splitter, s.width / 2 - 0.2], [tip - 0.4, s.width / 2 - 0.08], [tip - 0.4, -s.width / 2 + 0.08]], s.floor - 0.01, 0.02, CARBON, true);
  if (lod < 2) {
    const diffStart = mb.vertexCount;
    plate(mb, [[0, -0.7], [0, 0.7], [-0.45, 0.72], [-0.45, -0.72]], 0, 0.015, CARBON, true);
    const tilt = 0.32;
    mb.transform(diffStart, ([x, y, z]) => [tail + 0.42 + x * Math.cos(tilt), s.floor + y - x * Math.sin(tilt), z], ([x, y, z]) => [x * Math.cos(tilt) + y * Math.sin(tilt), y * Math.cos(tilt) - x * Math.sin(tilt), z]);
  }
  // The grille: a black opening in the nose.
  const gw = (side(tip) * 2) * 0.72;
  const gh = (belt(tip) - s.floor) * 0.55;
  flatDecal(mb, [tip + 0.002, s.floor + (belt(tip) - s.floor) * 0.42, 0], [0, 0, -1], [0, 1, 0], gw, gh, undefined, SATIN_BLACK);
  // Lights: headlights on the front corners, tail lights at the back.
  const head = { ...trim([0.85, 0.88, 0.95], { roughness: 0.05, clearcoat: 1, emissive: 0.35 }), lamp: LAMP.head };
  const tailLight = { ...trim([0.6, 0.02, 0.02], { roughness: 0.1, clearcoat: 1, emissive: 0.5 }), lamp: LAMP.rain };
  const hx = tip - 0.28;
  const hz = Math.min(outer(hx) - 0.2, 0.62);
  for (const sgn of [1, -1]) {
    ellipsoid(mb, [hx, belt(hx) - 0.05, sgn * hz], s.kind === 'prototype' ? [0.2, 0.03, 0.1] : [0.17, 0.05, 0.13], n(12), n(6), () => head, [0, Math.PI / 2]);
    const tx = tail + 0.02;
    box(mb, [tx - 0.03, belt(tx) - (s.kind === 'prototype' ? 0.08 : 0.16), sgn > 0 ? outer(tx) - 0.45 : -outer(tx) + 0.08], [tx + 0.01, belt(tx) - 0.04, sgn > 0 ? outer(tx) - 0.08 : -outer(tx) + 0.45], tailLight);
  }
  // Rear wing on swan necks, with endplates; the fin of a prototype.
  if (s.wing) {
    const w = s.wing;
    wing(mb, { from: [w.x, w.y, -w.span], to: [w.x, w.y, w.span], chord: w.chord, angle: w.angle, camber: 0.08, n: n(12), spanSteps: lod === 0 ? 2 : 1, surface: CARBON, u: u(w.x), caps: false });
    for (const sgn of [1, -1]) {
      plate(mb, [[w.x + 0.04, w.y - w.plate * 0.6], [w.x + 0.04, w.y + 0.06], [w.x - w.chord - 0.06, w.y + 0.12], [w.x - w.chord - 0.06, w.y - w.plate]], sgn * (w.span + 0.008), 0.016, paint(ZONE.solidA), false, u(w.x));
      if (lod < 2) flatDecal(dm, [w.x - w.chord / 2 - 0.01, w.y - w.plate * 0.25, sgn * (w.span + 0.017)], sgn > 0 ? SIDE_R.right : SIDE_L.right, UP, Math.min(0.42, w.chord + 0.08), Math.min(0.16, w.plate * 0.5), DECAL_TEAM);
      // Swan neck: from the deck up and over to the wing.
      const nx = w.x - w.chord * 0.45;
      plate(mb, [[nx + 0.12, deck(nx) - 0.02], [nx + 0.02, w.y + 0.07], [nx - 0.12, w.y + 0.07], [nx - 0.05, deck(nx) - 0.02]], sgn * 0.32, 0.02, CARBON);
    }
  }
  if (s.fin && lod < 2) plate(mb, [[c.roofRear + 0.1, c.roof - 0.04], [s.wing ? s.wing.x - 0.05 : tail, (s.wing?.y ?? 0.9) + 0.02], [s.wing ? s.wing.x - 0.3 : tail, deck(tail + 0.4)], [c.rearBase, deck(c.rearBase)]], 0, 0.012, paint(ZONE.solidA));
  // Mirrors.
  if (lod < 2) {
    const mx = s.kind === 'prototype' ? fa - 0.15 : c.roofFront + 0.15;
    const my = s.kind === 'prototype' ? belt(mx) + 0.08 : deck(mx) + 0.12;
    const mz = s.kind === 'prototype' ? outer(mx) - 0.2 : c.baseHalf + 0.12;
    for (const sgn of [1, -1]) {
      box(mb, [mx - 0.06, my, sgn > 0 ? mz : -mz - 0.16], [mx + 0.05, my + 0.08, sgn > 0 ? mz + 0.16 : -mz], paint(ZONE.solidB));
      tube(mb, [mx, my - 0.05, sgn * (mz - 0.08)], [mx, my + 0.02, sgn * (mz + 0.04)], 0.012, 0.012, 6, CARBON);
    }
  }
  if (s.lightBar) {
    const lx = c.roofFront - 0.25;
    // Orange beacons, flashing in turn while the safety car is out.
    const beacon = trim([0.5, 0.09, 0.005], { emissive: 1.4, roughness: 0.5 });
    box(mb, [lx - 0.12, c.roof - 0.01, -0.5], [lx + 0.12, c.roof + 0.09, -0.04], { ...beacon, lamp: LAMP.beaconA });
    box(mb, [lx - 0.12, c.roof - 0.01, 0.04], [lx + 0.12, c.roof + 0.09, 0.5], { ...beacon, lamp: LAMP.beaconB });
    box(mb, [lx - 0.12, c.roof - 0.01, -0.04], [lx + 0.12, c.roof + 0.07, 0.04], SATIN_BLACK);
  }
  // Decals: the number on each door and on the bonnet; the team name low on each side.
  const doorX = s.kind === 'prototype' ? (fa + ra) / 2 + 0.05 : c.roofFront - 0.55;
  const doorY = s.kind === 'prototype' ? belt(doorX) - 0.24 : belt(doorX) - 0.3;
  const size = s.kind === 'prototype' ? 0.36 : 0.46;
  for (const [sgn, dir] of [[1, SIDE_R], [-1, SIDE_L]] as const) {
    decal(dm, loft, [doorX, doorY, sgn * 2], dir.right, dir.up, size, size, DECAL_NUMBER_SQUARE, n(6), n(6));
    if (lod < 2) decal(dm, loft, [s.kind === 'prototype' ? ra + 0.75 : doorX - 0.25, s.floor + 0.2, sgn * 2], dir.right, dir.up, 0.9, 0.16, DECAL_TEAM, n(8), n(2));
  }
  const bonnetX = s.kind === 'prototype' ? fa + 0.1 : tip - 0.75;
  decal(dm, loft, [bonnetX, deck(bonnetX) + 0.3, 0], TOP.right, TOP.up, 0.5, 0.25, DECAL_NUMBER, n(6), n(3));
  return { body: mb.build(), decals: dm.build() };
}

function closedModel(s: ClosedSpec): CarModel {
  const fa = s.wheelbase / 2;
  const fwz = s.width / 2 - 0.012 - s.frontW / 2;
  const rwz = s.width / 2 - 0.012 - s.rearW / 2;
  const lods = [0, 1, 2].map((lod) => ({ ...closedCar(s, lod), wheel: buildWheel(s.tyreR, s.rearW, s.rimR, lod, s.spokes) }));
  return {
    id: s.id, kind: s.kind, length: s.wheelbase + s.front + s.rear, width: s.width, height: s.cabin.roof, wheelbase: s.wheelbase,
    wheels: [
      { x: fa, y: s.tyreR, z: fwz, radius: s.tyreR, width: s.frontW, front: true },
      { x: fa, y: s.tyreR, z: -fwz, radius: s.tyreR, width: s.frontW, front: true },
      { x: -fa, y: s.tyreR, z: rwz, radius: s.tyreR, width: s.rearW, front: false },
      { x: -fa, y: s.tyreR, z: -rwz, radius: s.tyreR, width: s.rearW, front: false },
    ],
    lods, eye: [s.cabin.roofFront - 0.35, s.cabin.roof - 0.2, -0.32], wheelRadius: s.tyreR, wheelWidth: s.rearW, lamps: lampPlaces(lods[0].body),
  };
}

// ---- bikes ----------------------------------------------------------------------

interface BikeSpec {
  id: string;
  wheelbase: number;
  frontR: number;
  frontW: number;
  rearR: number;
  rearW: number;
  rimR: number;
  winglets: boolean;
}

const MOTOGP: BikeSpec = { id: 'motogp', wheelbase: 1.45, frontR: 0.3, frontW: 0.125, rearR: 0.31, rearW: 0.195, rimR: 0.215, winglets: true };
const SUPERBIKE: BikeSpec = { id: 'superbike', wheelbase: 1.43, frontR: 0.3, frontW: 0.12, rearR: 0.31, rearW: 0.19, rimR: 0.215, winglets: false };

/** A bike wheel: a round-profile tyre on a spoked rim with a brake disc. */
function buildBikeWheel(radius: number, width: number, rimRadius: number, lod: number): CarMeshData {
  const mb = new CarMeshBuilder();
  const w = width / 2;
  const R = radius;
  const r = rimRadius;
  const rim = trim([0.08, 0.08, 0.09], { roughness: 0.3, metalness: 1 });
  const crown = steps(8, lod);
  const profile: { r: number; z: number; surface: Surface; hard?: boolean }[] = [
    { r: 0.001, z: 0.04, surface: DARK_METAL },
    { r: r - 0.02, z: 0.03, surface: rim, hard: true },
    { r, z: w * 0.55, surface: rim, hard: true },
    { r: r + 0.01, z: w * 0.6, surface: RUBBER, hard: true },
    { r: r + 0.03, z: w * 0.75, surface: TINT, hard: true },
  ];
  // The crown: a half round from one shoulder to the other.
  for (let i = 0; i <= crown; i++) {
    const a = Math.PI / 2 - (Math.PI * i) / crown;
    profile.push({ r: R - w + Math.cos(a) * w * 0.98, z: Math.sin(a) * w, surface: RUBBER });
  }
  profile.push({ r: r + 0.01, z: -w * 0.6, surface: RUBBER, hard: true }, { r, z: -w * 0.55, surface: rim }, { r: r - 0.02, z: -0.03, surface: rim }, { r: 0.001, z: -0.04, surface: DARK_METAL });
  revolve(mb, [0, 0, 0], profile, steps(40, lod));
  if (lod < 2) {
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      tube(mb, [Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0], [Math.cos(a + 0.25) * (r - 0.015), Math.sin(a + 0.25) * (r - 0.015), 0], 0.012, 0.009, 5, rim, 0.5);
    }
    // Brake disc: a steel ring inside the rim.
    const steel = trim([0.32, 0.32, 0.33], { roughness: 0.45, metalness: 1 });
    const ri = r * 0.55;
    const ro = r * 0.78;
    revolve(mb, [0, 0, 0], [
      { r: ri, z: 0.063, surface: steel, hard: true }, { r: ro, z: 0.063, surface: steel, hard: true },
      { r: ro, z: 0.056, surface: steel, hard: true }, { r: ri, z: 0.056, surface: steel, hard: true }, { r: ri, z: 0.063, surface: steel },
    ], steps(32, lod));
  }
  return mb.build();
}

function bike(s: BikeSpec, lod: number): { body: CarMeshData; decals: CarMeshData } {
  const mb = new CarMeshBuilder();
  const dm = new CarMeshBuilder();
  const fa = s.wheelbase / 2;
  const ra = -s.wheelbase / 2;
  const tip = fa + 0.17;
  const tail = ra - 0.23;
  const u = (x: number) => (x - tail) / (tip - tail);
  const n = (v: number) => steps(v, lod);
  const shell = (zone: number) => paint(zone);
  /** A smooth closed section: flat-ish bottom, rounded sides and top. */
  const section = (b: number, t: number, w: number, surfaceTop: Surface, surface: Surface) => new SectionPath(0, b, surface)
    .line(w * 0.5, b, n(1)).round(w, b + (t - b) * 0.45, n(3), 2.2, 'across').round(w * 0.35, t, n(4), 2.2, 'up').use(surfaceTop).line(0, t, n(1));
  // Fairing: the nose over the front wheel, down to the belly pan behind it.
  const fb = curve([[tip, 0.7], [0.75, 0.66], [0.56, 0.6], [0.43, 0.43], [0.3, 0.2], [0.05, 0.14], [-0.05, 0.18]]);
  const ft = curve([[tip, 0.75], [0.76, 0.83], [0.5, 0.86], [0.3, 0.8], [0.05, 0.7], [-0.05, 0.64]]);
  const fw = curve([[tip, 0.03], [0.8, 0.13], [0.62, 0.23], [0.45, 0.28], [0.2, 0.26], [0.0, 0.19], [-0.05, 0.15]]);
  const fairing = new Loft(mb, {
    stations: stations(tip, -0.05, n(28), (x) => 1 + 2 * Math.exp(-(((x - tip) / 0.15) ** 2))),
    u,
    capRear: SATIN_BLACK,
    section: (x) => section(fb(x), ft(x), fw(x), shell(ZONE.body), shell(ZONE.body)),
  });
  // Windscreen.
  const wt = curve([[0.82, 0.82], [0.62, 0.93], [0.46, 0.96], [0.42, 0.95]]);
  const ww = curve([[0.82, 0.07], [0.62, 0.14], [0.42, 0.15]]);
  const screen = trim([0.04, 0.05, 0.06], { roughness: 0.04, clearcoat: 1 });
  new Loft(mb, { stations: stations(0.82, 0.42, n(10)), u, section: (x) => section(ft(x) - 0.03, wt(x), ww(x), screen, screen) });
  // Tank, seat and tail.
  const tt = curve([[0.42, 0.8], [0.25, 0.9], [0.05, 0.88], [-0.22, 0.78]]);
  const tw = curve([[0.42, 0.13], [0.2, 0.19], [-0.05, 0.17], [-0.22, 0.12]]);
  new Loft(mb, { stations: stations(0.42, -0.22, n(14)), u, section: (x) => section(0.58, tt(x), tw(x), shell(ZONE.body), shell(ZONE.body)) });
  const seatFront = -0.18;
  const seatRear = -0.5;
  const sb = curve([[seatFront, 0.6], [tail, 0.74]]);
  const st = curve([[seatFront, 0.76], [-0.45, 0.79], [-0.7, 0.88], [tail, 0.9]]);
  const sw = curve([[seatFront, 0.13], [-0.6, 0.12], [tail, 0.05]]);
  const { xs, region } = withCreases(stations(seatFront, tail, n(18)), [seatRear]);
  const tailLoft = new Loft(mb, {
    stations: xs, u, capRear: SATIN_BLACK,
    section: (x, i) => section(sb(x), st(x), sw(x), region[i] > seatRear ? SATIN_BLACK : shell(ZONE.body), shell(ZONE.body)),
  });
  // Swingarm, forks, bars, exhaust.
  for (const side of [1, -1]) {
    tube(mb, [-0.08, 0.42, side * 0.1], [ra, s.rearR, side * 0.12], 0.035, 0.025, n(8), DARK_METAL, 0.45, [0, 1, 0]);
    tube(mb, [0.47, 0.9, side * 0.085], [fa - 0.08, 0.5, side * 0.085], 0.027, 0.027, n(8), trim([0.8, 0.6, 0.15], { roughness: 0.25, metalness: 1 }));
    tube(mb, [fa - 0.08, 0.5, side * 0.085], [fa, s.frontR, side * 0.085], 0.032, 0.03, n(8), SATIN_BLACK);
    tube(mb, [0.45, 0.83, side * 0.09], [0.42, 0.82, side * 0.3], 0.014, 0.014, 6, SATIN_BLACK);
  }
  pipe(mb, [[-0.32, 0.46, 0.13], [-0.55, 0.56, 0.14], [-0.8, 0.67, 0.12]], 0.045, n(10), trim([0.42, 0.4, 0.38], { roughness: 0.35, metalness: 1 }));
  // The rear light, lit in the wet.
  box(mb, [tail - 0.012, 0.78, -0.035], [tail + 0.01, 0.84, 0.035], { ...trim([0.5, 0.02, 0.02], { emissive: 0.6, roughness: 0.6 }), lamp: LAMP.rain });
  if (s.winglets && lod < 2) {
    for (const side of [1, -1]) plate(mb, [[0.74, side * 0.2], [0.72, side * 0.37], [0.6, side * 0.37], [0.56, side * 0.24]], 0.64, 0.012, paint(ZONE.solidB), true);
  }
  // The rider, tucked in behind the screen.
  const leathers = paint(ZONE.side);
  const torsoTop = curve([[-0.44, 0.97], [-0.1, 1.04], [0.05, 1.03], [0.16, 1.0]]);
  const torsoBottom = curve([[-0.44, 0.76], [0.16, 0.86]]);
  const torsoHalf = curve([[-0.44, 0.16], [-0.1, 0.18], [0.16, 0.2]]);
  new Loft(mb, {
    stations: stations(0.16, -0.44, n(12)), u, capFront: leathers, capRear: leathers,
    section: (x) => new SectionPath(0, torsoBottom(x), leathers).line(torsoHalf(x) * 0.6, torsoBottom(x), 1)
      .round(torsoHalf(x), (torsoBottom(x) + torsoTop(x)) / 2, n(3), 2.2, 'across').round(0, torsoTop(x), n(4), 2.2, 'up'),
  });
  const helmet = paint(ZONE.solidC);
  ellipsoid(mb, [0.3, 1.01, 0], [0.145, 0.125, 0.115], n(22), n(12), (d) => (d[0] > 0.5 && d[1] > -0.2 && d[1] < 0.35 ? GLASS : helmet));
  const arm = paint(ZONE.solidA);
  for (const side of [1, -1]) {
    tube(mb, [0.12, 0.95, side * 0.18], [0.22, 0.8, side * 0.27], 0.058, 0.048, n(8), arm);
    tube(mb, [0.22, 0.8, side * 0.27], [0.42, 0.83, side * 0.3], 0.048, 0.04, n(8), arm);
    ellipsoid(mb, [0.43, 0.83, side * 0.3], [0.06, 0.04, 0.045], n(8), n(4), () => SATIN_BLACK);
    tube(mb, [-0.32, 0.82, side * 0.15], [0.05, 0.6, side * 0.29], 0.085, 0.065, n(8), leathers);
    tube(mb, [0.05, 0.6, side * 0.29], [-0.3, 0.38, side * 0.22], 0.062, 0.045, n(8), arm);
    ellipsoid(mb, [0.06, 0.58, side * 0.33], [0.06, 0.05, 0.03], n(8), n(4), () => trim([0.9, 0.9, 0.9], { roughness: 0.4 }));
    ellipsoid(mb, [-0.27, 0.36, side * 0.22], [0.13, 0.06, 0.05], n(8), n(4), () => SATIN_BLACK);
  }
  // Decals: the number on the nose and on both sides of the fairing and the tail; the team name low on the fairing.
  decal(dm, fairing, [0.74, ft(0.74) + 0.05, 0], TOP.right, TOP.up, 0.17, 0.085, DECAL_NUMBER, n(4), n(2));
  for (const [side, dir] of [[1, SIDE_R], [-1, SIDE_L]] as const) {
    decal(dm, fairing, [0.38, 0.62, side], dir.right, dir.up, 0.28, 0.14, DECAL_NUMBER, n(6), n(3));
    decal(dm, tailLoft, [-0.72, 0.8, side], dir.right, dir.up, 0.2, 0.1, DECAL_NUMBER, n(4), n(2));
    if (lod < 2) decal(dm, fairing, [0.22, 0.46, side], dir.right, dir.up, 0.36, 0.07, DECAL_TEAM, n(6), n(2));
  }
  return { body: mb.build(), decals: dm.build() };
}

function bikeModel(s: BikeSpec): CarModel {
  const fa = s.wheelbase / 2;
  const lods = [0, 1, 2].map((lod) => ({ ...bike(s, lod), wheel: buildBikeWheel(s.rearR, s.rearW, s.rimR, lod) }));
  return {
    id: s.id, kind: 'bike', length: s.wheelbase + 0.4, width: 0.66, height: 1.16, wheelbase: s.wheelbase,
    wheels: [
      { x: fa, y: s.frontR, z: 0, radius: s.frontR, width: s.frontW, front: true },
      { x: -fa, y: s.rearR, z: 0, radius: s.rearR, width: s.rearW, front: false },
    ],
    lods, eye: [0.36, 1.03, 0], wheelRadius: s.rearR, wheelWidth: s.rearW, lamps: lampPlaces(lods[0].body),
  };
}

const MODELS: Record<string, () => CarModel> = {
  f1: () => singleSeaterModel(F1),
  f2: () => singleSeaterModel(F2),
  indycar: () => singleSeaterModel(INDYCAR),
  hypercar: () => closedModel(HYPERCAR),
  lmp2: () => closedModel(LMP2),
  gt3: () => closedModel(GT3),
  gt4: () => closedModel(GT4),
  tcr: () => closedModel(TCR),
  'safety-car': () => closedModel(SAFETY_CAR),
  motogp: () => bikeModel(MOTOGP),
  superbike: () => bikeModel(SUPERBIKE),
};

const cache = new Map<string, CarModel>();

/** The car model for a body (see `bodyFor`), built once. */
export function buildCar(body: string): CarModel {
  let m = cache.get(body);
  if (!m) {
    m = (MODELS[body] ?? MODELS.f1)();
    cache.set(body, m);
  }
  return m;
}

export const BODIES = Object.keys(MODELS);

export { steps, withCreases, SIDE_R, SIDE_L, TOP };
