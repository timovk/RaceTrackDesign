/**
 * A survey of the television cameras: what is wrong with where each stands,
 * what of the track it is said to see it does not, and, over a race as the
 * director shows it, how much of the time on air the car shown is hidden.
 *
 * The figures are the yardstick the cameras are held to (they are nought
 * for a circuit's cameras as placed, see tests/tvSurvey.test.ts), and the
 * way to find out what a change to the cameras or the director costs.
 */
import { type Director, type TvCamera, isOnboard, subjectIds } from './broadcast.ts';
import { FRAME_HALF } from './cameraPlan.ts';
import { DT, type RaceSim } from './race/sim.ts';
import { tvCars } from './race/tvFeed.ts';
import type { Display, Vec3 } from './shots.ts';
import type { Blocker, Solids } from './solids.ts';
import type { Track } from './track.ts';

export interface CameraReport {
  id: string;
  label: string;
  /** What it stands in, or null when it stands free. */
  standsIn: Blocker | null;
  /** On the track's side of the barrier. */
  inFront: boolean;
  /** Stations it is said to see, and of those the ones something hides, by what hides them. */
  sees: number;
  hidden: number;
  by: Partial<Record<Blocker, number>>;
}

/** Where a car at a station is looked at: the middle of the road, a car's height up (drawn height). */
export function lookAt(t: Track, k: number, display: Display): Vec3 {
  return [t.x[k], t.y[k], display(t.z[k]) + 1];
}

/**
 * Every camera with what is wrong with it. `insideBarriers` says whether a
 * point is on the track's side of the barriers; the camera on the pit wall
 * stands there on purpose.
 */
export function surveyCameras(
  cams: readonly TvCamera[], t: Track, display: Display, solids: Solids, insideBarriers?: ((x: number, y: number, margin: number) => boolean) | null,
): CameraReport[] {
  return cams.map((cam) => {
    const by: Partial<Record<Blocker, number>> = {};
    let sees = 0;
    let hidden = 0;
    for (let k = 0; k < t.n; k++) {
      if (!cam.sees[k]) continue;
      sees++;
      const what = solids.between(cam.at, lookAt(t, k, display));
      if (!what) continue;
      hidden++;
      by[what] = (by[what] ?? 0) + 1;
    }
    return {
      id: cam.id, label: cam.label,
      standsIn: solids.standing(cam.at[0], cam.at[1], cam.at[2], cam.mount === 'post' ? 0.6 : 1.5, cam.mount === 'roof' || cam.mount === 'post' || cam.mount === 'gantry'),
      // (The camera on the pit wall, and one that hangs over the road from a truss, are there on purpose.)
      inFront: cam.mount !== 'post' && cam.mount !== 'gantry' && !!insideBarriers?.(cam.at[0], cam.at[1], 0.5),
      sees, hidden, by,
    };
  });
}

export interface AirTime {
  /** Race seconds surveyed, and of them on a trackside camera, the helicopter, a camera on a car and the pit box camera. */
  total: number;
  trackside: number;
  helicopter: number;
  onboard: number;
  pitBox: number;
  /** Trackside seconds with a car of the shot hidden, by what hid it; and from a camera that stands in something. */
  hidden: number;
  by: Partial<Record<Blocker, number>>;
  fromFaulty: number;
  /** Cuts, and how many of them went from one trackside camera to another on the other side of the road while staying with the same cars. */
  cuts: number;
  crossed: number;
}

/** As the broadcast does: cars hidden from their camera this long (seconds) are reported to the director, who cuts. */
const HIDDEN_FOR = 0.45;

/**
 * Runs a race for `seconds` (or to its end) as the director shows it at
 * real speed, and looks at every step whether the cars of the shot can be
 * seen from its camera. `faulty` are the cameras that stand in something.
 * Cars are looked at in the middle of the road where they are; a car in the
 * pit lane is not looked at. With `watch`, the director is told when cars
 * stay hidden, as the broadcast tells it (ui/tvBroadcast.ts).
 */
export function surveyRace(
  sim: RaceSim, director: Director, t: Track, display: Display, solids: Solids, seconds: number, faulty: ReadonlySet<string> = new Set(), watch = true,
): AirTime {
  const air: AirTime = { total: 0, trackside: 0, helicopter: 0, onboard: 0, pitBox: 0, hidden: 0, by: {}, fromFaulty: 0, cuts: 0, crossed: 0 };
  let last: { camera: string; cars: string } | null = null;
  let hiddenFor = 0;
  while (!sim.finished && air.total < seconds) {
    sim.step();
    air.total += DT;
    const shot = director.update(DT, 1, tvCars(sim), sim.t);
    if (!shot) continue;
    const key = [...subjectIds(shot.subject)].sort((a, b) => a - b).join('-');
    if (!last || last.camera !== shot.camera || last.cars !== key) {
      if (last) {
        air.cuts++;
        const from = director.camera(last.camera);
        const to = director.camera(shot.camera);
        if (from && to && last.cars === key && from.side && to.side && from.side !== to.side) air.crossed++;
      }
      last = { camera: shot.camera, cars: key };
      hiddenFor = 0;
    }
    if (shot.camera === 'heli') air.helicopter += DT;
    else if (isOnboard(shot.camera)) air.onboard += DT;
    else if (shot.camera === 'pitbox') air.pitBox += DT;
    const cam = director.camera(shot.camera);
    if (!cam) continue;
    air.trackside += DT;
    if (faulty.has(cam.id)) air.fromFaulty += DT;
    let what: Blocker | null = null;
    for (const id of subjectIds(shot.subject)) {
      const car = sim.cars[id];
      if (!car || car.status !== 'running') continue;
      const k = Math.floor((((car.u % t.n) + t.n) % t.n));
      const at = lookAt(t, k, display);
      // (The grid is shown with what stands on either side of it: there only the line to the cars is to be free.)
      what = solids.between(cam.at, at) ?? (shot.reason === 'start' ? null : solids.beside(cam.at, at, FRAME_HALF)) ?? what;
    }
    if (what) {
      air.hidden += DT;
      air.by[what] = (air.by[what] ?? 0) + DT;
    }
    hiddenFor = what ? hiddenFor + DT : 0;
    if (watch && hiddenFor >= HIDDEN_FOR && !(shot.reason === 'start' && shot.camera !== 'start')) {
      hiddenFor = 0;
      director.lostSight(cam.id);
    }
  }
  return air;
}
