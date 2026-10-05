/**
 * TV mode of the 3D view: the race as a broadcast. The director
 * (core/broadcast.ts) decides what to show and from where; this moves the
 * camera and draws the graphics.
 *
 * A trackside camera stands still and pans and zooms with its car through
 * a long lens, a little behind it like an operator would; the helicopter
 * hangs high off to one side and circles slowly. Onboard cameras ride on
 * the car (tilting with it, and leaning with a bike); the chase camera
 * follows the racing line behind the car. A car in its pit box is shown
 * from the pit lane in front of it, with the stop timer running. A new shot
 * is a cut. When the camera picks up a new car or battle, a caption names
 * it (position, driver, team, gap, tyre); overtakes, fastest laps,
 * incidents, retirements, race control's flags and the weather pop up as
 * they happen, and the sector and lap times of the car on screen as it sets
 * them (purple for the best of all, green for its own best). In the rain,
 * drops settle on the lens (a fresh set at every cut), except the
 * helicopter's.
 *
 * Before the start, the camera walks the grid from tenth to pole, a caption
 * for each car, then looks down the grid from behind it while the start
 * lights come on and go out (or the green flag waves for a rolling start);
 * the start itself is shown from there.
 *
 * Every step of the race is kept for the last 40 seconds (core/race/replay.ts),
 * so the director can replay an overtake or an incident a few seconds later:
 * the cars are drawn as they were, at half speed, behind a REPLAY sting. The
 * graphics (tvGraphics.ts) add a map of the circuit, a gap graphic for a
 * battle, the final lap, and the chequered flag and the results.
 */
import * as THREE from 'three';
import { type Heli, type OnboardView, type TvCamera, type TvCar, type TvShot, Director, framingFov, heliStart, heliStep, isOnboard, subjectIds } from '../core/broadcast.ts';
import { formatLapTime } from '../core/calibration.ts';
import { type RaceView, ReplayBuffer } from '../core/race/replay.ts';
import { SessionSim } from '../core/race/session.ts';
import { DT, type RaceCar, type RaceSim } from '../core/race/sim.ts';
import type { Vec3 } from '../core/shots.ts';
import type { Track } from '../core/track.ts';
import { h, setChildren } from './dom.ts';
import type { RaceController } from './raceController.ts';
import { TvGraphics } from './tvGraphics.ts';

export interface TvHost {
  camera: THREE.PerspectiveCamera;
  /** The circuit the race runs on, for the map. */
  track: Track;
  /** Where the graphics go. */
  overlay: HTMLElement;
  /** A car's middle (scene coordinates), heading (world, radians), length and width, or null when it is not drawn. */
  car(id: number): { position: THREE.Vector3; heading: number; length: number; width: number } | null;
  /** An onboard camera of a car as drawn (scene coordinates), or null when it is not drawn. */
  mount(id: number, view: Exclude<OnboardView, 'chase'>): { position: THREE.Vector3; direction: THREE.Vector3; up: THREE.Vector3 } | null;
  /** A point on the racing line `back` metres behind race progress `u`, `side` metres to its left and `up` metres above the track (scene coordinates). */
  pathPoint(u: number, back: number, side: number, up: number): THREE.Vector3 | null;
  /** The side of the track the pit garages are on: 1 left of the direction of travel, -1 right. */
  pitSide: number;
  /** A world point with drawn heights in scene coordinates. */
  fromDrawn(p: Vec3): THREE.Vector3;
  /** The drawn ground's scene height under a scene point, or null off the map. */
  groundY(x: number, z: number): number | null;
  /** The view's size, CSS pixels, and how much of its left side the timing tower covers. */
  size(): { width: number; height: number; covered: number };
}

/** How long a caption stays up, and a pop-up, in seconds. */
const CAPTION = 4.5;
const POPUP = 5;
/** Vertical field of view of the onboard cameras (degrees), and their near plane (metres). */
const ONBOARD_FOV: Record<Exclude<OnboardView, 'chase'>, number> = { tcam: 42, nose: 40, rear: 38 };
const ONBOARD_NEAR = 0.25;
/** The chase camera: this many car lengths plus metres behind, metres up, and the share of the picture's width the car fills. */
const CHASE_BACK = 1.3;
const CHASE_GAP = 3;
const CHASE_UP = 2.2;
const CHASE_SHARE = 0.32;
/** The pit box camera: metres ahead of the car in its box, across the fast lane from it, and up. */
const PIT_AHEAD = 4.5;
const PIT_ACROSS = 10;
const PIT_UP = 2.4;
/** The grid walk: the cars walked (from the front), seconds per car, the share of it spent walking on to the next, and the cars in the last, wide shot and how long it holds before the start. */
const GRID_WALK = 10;
const GRID_PER_CAR = 3;
const GRID_MOVE = 0.45;
const GRID_WIDE = 6;
/** The start lights: seconds on the wide shot before the first comes on, one more a second, and then out after between these. */
const LIGHTS_FROM = 1.5;
const LIGHTS_OUT_MIN = 0.4;
const LIGHTS_OUT_MAX = 2.4;
/** Race seconds of the race kept for replays. */
const REPLAY_KEEP = 40;
const VIEW_LABEL: Record<OnboardView, string> = { tcam: 'Onboard', nose: 'Nose camera', rear: 'Rear camera', chase: 'Chase camera' };
const UP = new THREE.Vector3(0, 1, 0);

export class TvBroadcast {
  readonly director: Director;
  private readonly host: TvHost;
  private readonly race: RaceController;
  private readonly layer: HTMLElement;
  private readonly lower: HTMLElement;
  private readonly pops: HTMLElement;
  private readonly drops: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly sting: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly graphics: TvGraphics;
  private readonly buffer = new ReplayBuffer(REPLAY_KEEP);
  private readonly stopRecording: () => void;
  /** The race as drawn in a replay, or null when live. */
  private replayed: { view: RaceView; alpha: number } | null = null;
  /** When the start lights went out (screen seconds), to clear them away. */
  private lightsOut = -1;
  private shot: TvShot | null = null;
  private aim = new THREE.Vector3();
  private fov = 30;
  private heli: Heli | null = null;
  private heliPos = new THREE.Vector3();
  /** Where the chase camera is, and the pit box camera stands. */
  private chase: THREE.Vector3 | null = null;
  private box: THREE.Vector3 | null = null;
  /** The grid walk before the start: seconds into it, and the car (or the wide shot, -2) last captioned. */
  private walk: { time: number; shown: number } | null = null;
  private captionUntil = 0;
  /** The two cars of the battle on screen ('' for none), to caption a new pair within a shot. */
  private pair = '';
  private lastTarget: THREE.Vector3 | null = null;
  private time = 0;
  private seenEvents = -1;
  private sim: RaceSim | null = null;
  /** Per car on screen: its laps and sectors done when last looked at. */
  private timing = new Map<number, string>();

  constructor(host: TvHost, race: RaceController, cameras: TvCamera[], n: number, ds: number) {
    this.host = host;
    this.race = race;
    this.director = new Director(cameras, { n, ds });
    this.lower = h('div', { class: 'tv-lower', hidden: true });
    this.pops = h('div', { class: 'tv-pops' });
    this.drops = h('div', { class: 'tv-drops' });
    this.timer = h('div', { class: 'tv-timer', hidden: true });
    this.sting = h('div', { class: 'tv-sting', hidden: true }, h('span', null, 'Replay'));
    this.badge = h('div', { class: 'tv-replay', hidden: true }, 'Replay');
    this.graphics = new TvGraphics(host.track);
    this.layer = h('div', { class: 'tv' }, this.drops, this.graphics.el, this.lower, this.timer, this.pops, this.badge, this.sting);
    host.overlay.append(this.layer);
    this.stopRecording = race.onStep((sim) => this.buffer.record(sim));
  }

  dispose(): void {
    this.stopRecording();
    this.layer.remove();
    this.host.camera.up.copy(UP);
  }

  /** The race as it was, while a replay is on (for drawing the cars), or null. */
  get replay(): { view: RaceView; alpha: number } | null {
    return this.replayed;
  }

  /** What the camera looks at, scene coordinates. */
  get focus(): THREE.Vector3 {
    return this.aim;
  }

  /** Whether the picture comes from a camera on a car (a wide lens, everything sharp). */
  get onboard(): boolean {
    const s = this.shot;
    return !this.walk && !!s && isOnboard(s.camera);
  }

  /** The camera's name, for the player bar. */
  get label(): string {
    if (this.walk) return 'Grid';
    const s = this.shot;
    if (!s) return '';
    const code = s.carrier !== undefined ? this.race.sim?.cars[s.carrier]?.entrant.code ?? '' : '';
    const name = isOnboard(s.camera) ? `${VIEW_LABEL[s.camera]} · ${code}` : s.camera === 'pitbox' ? `Pit box · ${code}` : s.camera === 'heli' ? 'Helicopter' : this.director.camera(s.camera)?.label ?? '';
    return s.replay ? `Replay · ${name}` : name;
  }

  /** Moves on by `dt` screen seconds: the director decides, the camera follows. */
  update(dt: number): void {
    const r = this.race;
    const sim = r.sim;
    if (!sim) return;
    this.time += dt;
    if (sim !== this.sim) {
      // A new race: the director starts afresh.
      if (this.sim) this.director.reset();
      this.sim = sim;
      this.seenEvents = sim.events.length;
      this.walk = null;
      this.shot = null;
      this.replayed = null;
      this.buffer.clear();
    }
    this.readEvents(sim);
    if (sim.t === 0 && !r.playing && !sim.setup.session) {
      // Before the start: the grid.
      this.gridWalk(sim, dt);
    } else {
      if (this.walk) {
        this.walk = null;
        this.lower.hidden = true;
      }
      if (this.lightsOut >= 0 && this.time - this.lightsOut > 1.2) {
        this.graphics.setLights(null);
        this.lightsOut = -1;
      }
      // Once the race is over, no more replays.
      if (sim.finished && this.director.shot?.replay) this.director.endShot();
      const cars = sim.cars.map((c) => tvCar(sim, c, r.alpha, r.selected));
      let shot = this.director.update(r.playing ? dt : 0, Math.max(0.05, r.speed), cars, sim.t);
      // A replay draws the race as it was; one that is no longer kept ends at once.
      this.replayed = shot?.replay ? this.buffer.view(sim, Math.min(shot.replay.to, shot.replay.from + (this.director.clock - shot.start) * shot.replay.speed)) : null;
      if (shot?.replay && !this.replayed) {
        this.director.endShot();
        shot = this.director.update(0, Math.max(0.05, r.speed), cars, sim.t);
      }
      const cut = shot !== this.shot;
      if (cut) this.onReplayCut(this.shot, shot);
      if (cut && shot) this.onCut(shot, sim);
      // The battle on screen went on with a car that came between: a caption for the new pair (not for a pass between the two).
      const pair = shot?.subject.kind === 'battle' && !shot.replay ? [shot.subject.ahead, shot.subject.behind].sort((a, b) => a - b).join('-') : '';
      if (!cut && shot && pair && this.pair && pair !== this.pair) {
        const caption = this.caption(shot, sim);
        if (caption) this.showCaption(caption, CAPTION);
      }
      this.pair = pair;
      this.shot = shot;
      if (shot) {
        this.point(shot, dt, cut);
        if (!shot.replay) this.showTiming(shot, sim, cut);
      }
      this.showStop(shot?.replay ? null : shot, sim);
    }
    if (this.time > this.captionUntil) this.lower.hidden = true;
    this.updateGraphics(sim);
  }

  /** The map, lap counter, gap graphic and the finish, for this frame. */
  private updateGraphics(sim: RaceSim): void {
    const shot = this.walk ? null : this.shot;
    const live = !shot?.replay;
    const battle = shot && live && shot.subject.kind === 'battle' && this.lower.hidden ? { ahead: shot.subject.ahead, behind: shot.subject.behind } : null;
    this.graphics.update({
      sim,
      view: this.replayed?.view ?? sim,
      alpha: this.replayed?.alpha ?? this.race.alpha,
      onScreen: shot ? subjectIds(shot.subject) : [],
      battle,
      selected: this.race.selected,
      time: this.time,
    });
  }

  /** Into or out of a replay: the sting, and the badge while it runs. */
  private onReplayCut(from: TvShot | null, to: TvShot | null): void {
    const into = !!to?.replay;
    const out = !!from?.replay && !into;
    this.badge.hidden = !into;
    if (!into && !out) return;
    this.sting.hidden = false;
    this.sting.classList.remove('run');
    void this.sting.offsetWidth;
    this.sting.classList.add('run');
  }

  /** Centres the picture in what the timing tower leaves free; returns the free part's aspect ratio. */
  private frameView(): number {
    const cam = this.host.camera;
    const view = this.host.size();
    if (view.covered > 0) cam.setViewOffset(view.width, view.height, -view.covered / 2, 0, view.width, view.height);
    else cam.clearViewOffset();
    this.layer.style.setProperty('--tv-centre', `${view.covered + (view.width - view.covered) / 2}px`);
    return (view.width - view.covered) / Math.max(1, view.height);
  }

  /** Puts the camera at `position` looking at `target`, with `up`, at `fov`, and a near plane to suit (or `near`). */
  private place(position: THREE.Vector3, target: THREE.Vector3, fov: number, up = UP, near?: number): void {
    const cam = this.host.camera;
    cam.position.copy(position);
    cam.up.copy(up);
    cam.lookAt(target);
    cam.fov = fov;
    cam.near = near ?? Math.max(0.3, Math.min(20, position.distanceTo(target) / 600));
    cam.updateProjectionMatrix();
  }

  private subject(shot: TvShot): { centre: THREE.Vector3; heading: number; size: number; speed: number } | null {
    const ids = subjectIds(shot.subject);
    const poses = ids.map((id) => this.host.car(id)).filter((p): p is NonNullable<typeof p> => !!p);
    if (poses.length === 0) return null;
    const centre = new THREE.Vector3();
    for (const p of poses) centre.add(p.position);
    centre.divideScalar(poses.length);
    let spread = 0;
    for (const p of poses) spread = Math.max(spread, 2 * p.position.distanceTo(centre));
    const car = this.race.sim?.cars[ids[ids.length - 1]];
    return { centre, heading: poses[poses.length - 1].heading, size: spread + poses[0].length * 1.3, speed: car?.v ?? 0 };
  }

  /** Points the camera at the shot's subject: snapped on a cut, then with an operator's (or a helicopter's) lag; onboard, with the car. */
  private point(shot: TvShot, dt: number, cut: boolean): void {
    const aspect = this.frameView();
    const follow = (tc: number) => (cut ? 1 : 1 - Math.exp(-dt / tc));
    if (shot.camera === 'tcam' || shot.camera === 'nose' || shot.camera === 'rear') {
      const m = this.host.mount(shot.carrier!, shot.camera);
      if (!m) return;
      this.heli = null;
      this.lastTarget = null;
      this.aim.copy(m.position).addScaledVector(m.direction, 30);
      this.fov = ONBOARD_FOV[shot.camera];
      this.place(m.position, this.aim, this.fov, m.up, ONBOARD_NEAR);
      return;
    }
    const sub = this.subject(shot);
    if (!sub) return;
    // A little ahead of the car, as a camera operator leads it.
    const forward = new THREE.Vector3(Math.cos(sub.heading), 0, Math.sin(sub.heading));
    const target = sub.centre.clone().addScaledVector(forward, Math.min(4, sub.speed * 0.04));
    let position: THREE.Vector3;
    let wantFov: number;
    let lag = 0.25;
    if (shot.camera === 'chase') {
      const car = this.race.sim?.cars[shot.carrier!];
      const pose = this.host.car(shot.carrier!);
      if (!car || !pose) return;
      this.heli = null;
      const u = car.prevU + (car.u - car.prevU) * this.race.alpha;
      const want = this.host.pathPoint(u, CHASE_BACK * pose.length + CHASE_GAP, car.lateral, CHASE_UP);
      if (!want) return;
      const ground = this.host.groundY(want.x, want.z);
      if (ground !== null) want.y = Math.max(want.y, ground + 1.5);
      if (cut || !this.chase) this.chase = want.clone();
      else this.chase.lerp(want, follow(0.15));
      position = this.chase;
      // Just ahead of the car, seen from behind across its width.
      target.copy(pose.position).addScaledVector(forward, pose.length * 0.6);
      wantFov = framingFov(position.distanceTo(pose.position), pose.width * 1.2, CHASE_SHARE, aspect, 8, 55);
      lag = 0.08;
    } else if (shot.camera === 'pitbox') {
      const pose = this.host.car(shot.carrier!);
      if (!pose) return;
      this.heli = null;
      if (cut || !this.box) {
        // On the pit wall across the fast lane, a little ahead of the box, above head height.
        const hd = pose.heading;
        const left = new THREE.Vector3(Math.sin(hd), 0, -Math.cos(hd));
        const at = pose.position.clone().addScaledVector(forward, PIT_AHEAD).addScaledVector(left, -this.host.pitSide * PIT_ACROSS);
        at.y = (this.host.groundY(at.x, at.z) ?? pose.position.y) + PIT_UP;
        this.box = at;
      }
      position = this.box;
      wantFov = framingFov(position.distanceTo(target), sub.size, 0.55, aspect, 8, 60);
    } else if (shot.camera === 'heli') {
      if (cut || !this.heli) this.heli = this.clearHeli(heliStart(sub.heading), sub.centre);
      this.heli = heliStep(this.heli, dt);
      const hp = this.heli;
      const want = this.heliSpot(hp, sub.centre);
      // A hill coming between: climb.
      if (!this.clear(this.heliPos, sub.centre)) hp.height += dt * 40;
      if (cut) this.heliPos.copy(want);
      else this.heliPos.lerp(want, follow(1.4));
      position = this.heliPos;
      const share = shot.subject.kind === 'car' ? 0.2 : shot.subject.kind === 'battle' ? 0.32 : 0.45;
      wantFov = framingFov(position.distanceTo(target), Math.max(sub.size, 6), share, aspect, 4, 40);
      lag = 0.5;
    } else {
      const tc = this.director.camera(shot.camera);
      if (!tc) return;
      this.heli = null;
      position = this.host.fromDrawn(tc.at);
      const share = shot.subject.kind === 'car' ? 0.5 : shot.subject.kind === 'battle' ? 0.75 : 0.85;
      wantFov = framingFov(position.distanceTo(target), sub.size, share, aspect, 1.2, 45);
    }
    // Panning with the car (its speed across the view), and closing what is left with a little lag.
    if (cut || !this.lastTarget || dt <= 0) {
      if (cut) this.aim.copy(target);
    } else {
      this.aim.add(target.clone().sub(this.lastTarget));
      this.aim.lerp(target, follow(lag));
    }
    this.lastTarget = target.clone();
    this.fov = cut ? wantFov : this.fov + (wantFov - this.fov) * follow(0.6);
    this.place(position, this.aim, this.fov);
  }

  /**
   * Before the start: from tenth on the grid to pole, a little ahead of each
   * car and to the side away from the pits, then down the grid from behind
   * it; then the race starts.
   */
  private gridWalk(sim: RaceSim, dt: number): void {
    const aspect = this.frameView();
    if (!this.walk) {
      this.walk = { time: 0, shown: -1 };
      this.shot = null;
      setChildren(this.drops);
      this.timer.hidden = true;
    }
    const w = this.walk;
    w.time += dt;
    const order = sim.cars.filter((c) => c.status === 'running').sort((a, b) => a.gridPosition - b.gridPosition).slice(0, GRID_WALK).reverse();
    if (order.length === 0) return;
    const last = order.length - 1;
    const step = w.time / GRID_PER_CAR;
    if (step >= last + 1) {
      this.gridWide(order.slice(-GRID_WIDE), aspect);
      this.startLights(sim, w.time - (last + 1) * GRID_PER_CAR);
      return;
    }
    const i = Math.min(last, Math.floor(step));
    const a = this.host.car(order[i].id);
    const b = this.host.car(order[Math.min(last, i + 1)].id);
    if (!a || !b) return;
    // Hold on each car, then walk on to the next.
    const e = i < last ? smooth((step - i - (1 - GRID_MOVE)) / GRID_MOVE) : 0;
    const centre = a.position.clone().lerp(b.position, e);
    const hd = a.heading;
    const forward = new THREE.Vector3(Math.cos(hd), 0, Math.sin(hd));
    const left = new THREE.Vector3(Math.sin(hd), 0, -Math.cos(hd));
    const at = centre.clone().addScaledVector(forward, 5.5).addScaledVector(left, -this.host.pitSide * 4.5);
    at.y = (this.host.groundY(at.x, at.z) ?? centre.y) + 1.7;
    this.aim.copy(centre);
    this.fov = framingFov(at.distanceTo(centre), a.length * 1.25, 0.62, aspect, 12, 55);
    this.place(at, centre, this.fov);
    if (i !== w.shown) {
      w.shown = i;
      this.gridCaption(sim, order[i]);
    }
  }

  /**
   * The start lights over the wide shot, `t` seconds into it: one more a
   * second up to five, then all out after a moment (the same for the same
   * race), and the race starts. A rolling start gets the green flag.
   */
  private startLights(sim: RaceSim, t: number): void {
    const from = t - LIGHTS_FROM;
    if (from < 0) return;
    if (sim.classes[0].rules.race.start === 'rolling') {
      this.graphics.setLights('green');
      if (from > 1.5) this.go();
      return;
    }
    const hold = LIGHTS_OUT_MIN + (LIGHTS_OUT_MAX - LIGHTS_OUT_MIN) * hash01(sim.setup.settings.seed);
    if (from < 5 + hold) {
      this.graphics.setLights({ lit: Math.min(5, Math.floor(from) + 1) });
      return;
    }
    this.graphics.setLights('out');
    this.go();
  }

  /** Lights out: the race starts. */
  private go(): void {
    if (this.lightsOut < 0) this.lightsOut = this.time;
    this.race.play();
  }

  /** The front of the grid from the camera behind it, waiting for the start. */
  private gridWide(front: RaceCar[], aspect: number): void {
    const tc = this.director.camera('start');
    const poses = front.map((c) => this.host.car(c.id)).filter((p): p is NonNullable<typeof p> => !!p);
    if (!tc || poses.length === 0) return;
    const centre = new THREE.Vector3();
    for (const p of poses) centre.add(p.position);
    centre.divideScalar(poses.length);
    let spread = 0;
    for (const p of poses) spread = Math.max(spread, 2 * p.position.distanceTo(centre));
    const position = this.host.fromDrawn(tc.at);
    this.aim.copy(centre);
    this.fov = framingFov(position.distanceTo(centre), spread + poses[0].length * 2, 0.85, aspect, 1.2, 45);
    this.place(position, centre, this.fov);
    if (this.walk && this.walk.shown !== -2) {
      this.walk.shown = -2;
      this.lower.hidden = true;
    }
  }

  private gridCaption(sim: RaceSim, car: RaceCar): void {
    const slot = sim.multiClass ? car.classGrid : car.gridPosition;
    const head = slot === 1 ? `Pole position${sim.multiClass ? ` · ${car.cls.label}` : ''}` : `Grid · P${slot}${sim.multiClass ? ` ${car.cls.label}` : ''}`;
    this.showCaption(h('div', { class: 'tv-card' }, h('div', { class: 'tv-card-head' }, head), carRow(sim, car, '', true, slot)), GRID_PER_CAR - 0.4);
  }

  /** Where the helicopter hangs for a subject at `centre`: off to the side and up, at least 50 m over the ground below it. */
  private heliSpot(hp: Heli, centre: THREE.Vector3): THREE.Vector3 {
    const at = centre.clone().add(new THREE.Vector3(Math.cos(hp.angle) * hp.radius, hp.height, Math.sin(hp.angle) * hp.radius));
    const ground = this.host.groundY(at.x, at.z);
    if (ground !== null) at.y = Math.max(at.y, ground + 50);
    return at;
  }

  /** The helicopter turned round its subject (or raised) until no hill blocks the view. */
  private clearHeli(start: Heli, centre: THREE.Vector3): Heli {
    for (const lift of [1, 1.5, 2.2]) {
      for (let i = 0; i < 12; i++) {
        // Try either side of the preferred angle, nearest first.
        const turn = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 6);
        const hp = { ...start, angle: start.angle + turn, height: start.height * lift };
        if (this.clear(this.heliSpot(hp, centre), centre)) return hp;
      }
    }
    return { ...start, height: start.height * 3 };
  }

  /** Whether the drawn ground stays below the line between two scene points (the last few metres aside). */
  private clear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const d = from.distanceTo(to);
    const steps = Math.max(8, Math.ceil(d / 20));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if ((1 - f) * d < 8) break;
      const x = from.x + (to.x - from.x) * f;
      const z = from.z + (to.z - from.z) * f;
      const g = this.host.groundY(x, z);
      if (g !== null && g > from.y + (to.y - from.y) * f - 1) return false;
    }
    return true;
  }

  /** A new shot: a caption when it shows someone new. */
  private onCut(shot: TvShot, sim: RaceSim): void {
    this.wetLens(shot, sim);
    this.chase = null;
    this.box = null;
    const prev = this.shot;
    const sameSubject = prev && JSON.stringify(prev.subject) === JSON.stringify(shot.subject);
    if (sameSubject) return;
    const caption = this.caption(shot, sim);
    if (caption) this.showCaption(caption, CAPTION);
  }

  private showCaption(caption: HTMLElement, seconds: number): void {
    setChildren(this.lower, caption);
    this.lower.hidden = false;
    // Restart the slide-in.
    this.lower.classList.remove('in');
    void this.lower.offsetWidth;
    this.lower.classList.add('in');
    this.captionUntil = this.time + seconds;
  }

  /** Raindrops on the lens, more in heavier rain; the helicopter's camera stays clear. */
  private wetLens(shot: TvShot, sim: RaceSim): void {
    const count = shot.camera === 'heli' || sim.rain < 0.12 ? 0 : Math.round(4 + 20 * Math.min(1, sim.rain));
    const drops: HTMLElement[] = [];
    let seed = Math.floor(sim.t * 10) + 1;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const size = 5 + 20 * rnd() * rnd();
      drops.push(h('div', {
        class: 'tv-drop',
        style: `left:${(rnd() * 100).toFixed(1)}%;top:${(rnd() * 100).toFixed(1)}%;width:${size.toFixed(1)}px;height:${(size * (0.85 + 0.3 * rnd())).toFixed(1)}px`,
      }));
    }
    setChildren(this.drops, ...drops);
  }

  private caption(shot: TvShot, sim: RaceSim): HTMLElement | null {
    const head = { battle: 'Battle', incident: 'Incident', overtake: 'Overtake', leader: '', pit: 'Pit stop', selected: '', field: '', start: '', replay: 'Replay', flying: 'Flying lap' }[shot.reason];
    if (shot.subject.kind === 'group') return null;
    if (shot.subject.kind === 'battle') {
      const a = sim.cars[shot.subject.ahead];
      const b = sim.cars[shot.subject.behind];
      if (!a || !b) return null;
      const gap = sim.classInterval(b);
      return h('div', { class: 'tv-card' },
        h('div', { class: 'tv-card-head' }, `Battle for ${placeText(sim, a)}`),
        carRow(sim, a, ''),
        carRow(sim, b, gap.kind === 'time' ? `+${gap.value.toFixed(3)}` : ''));
    }
    const car = sim.cars[shot.subject.id];
    if (!car) return null;
    const gap = sim.classGap(car);
    const gapText = car.status === 'retired' ? 'Out' : gap.kind === 'leader' ? 'Leader' : gap.kind === 'time' ? `+${gap.value.toFixed(3)}` : gap.kind === 'laps' ? `+${gap.value} lap${gap.value > 1 ? 's' : ''}` : '';
    return h('div', { class: 'tv-card' }, head ? h('div', { class: 'tv-card-head' }, head) : null, carRow(sim, car, gapText, true));
  }

  /** The stop timer while the pit box camera is on: the time standing in the box, and the work done. */
  private showStop(shot: TvShot | null, sim: RaceSim): void {
    const car = shot && shot.camera === 'pitbox' && shot.carrier !== undefined ? sim.cars[shot.carrier] : null;
    const pit = car?.pit;
    // Queued at the pit exit under a red flag: no stop to time.
    if (!car || !pit || pit.service.reason === 'red flag') {
      this.timer.hidden = true;
      return;
    }
    const now = sim.t - DT * (1 - this.race.alpha);
    const time = pit.stopped ? Math.max(0, now - pit.stopStart) : Number.isFinite(pit.record.stationary) ? pit.record.stationary : Math.max(0, pit.stoppedUntil - pit.stopStart);
    const work: string[] = [];
    const service = pit.service;
    if (service.compound !== null) work.push(`${car.rules.tyres.compounds[service.compound]?.name ?? 'New'} tyres`);
    if (service.fuel > 0) work.push('Fuel');
    if (service.driver !== null) work.push(`${car.entrant.drivers[service.driver]?.name ?? 'Driver'} in`);
    setChildren(this.timer,
      h('div', { class: 'tv-timer-head' }, `Pit stop · ${car.entrant.code}`),
      h('div', { class: `tv-timer-time${pit.stopped ? '' : ' done'}` }, time.toFixed(1)),
      work.length ? h('div', { class: 'tv-timer-work' }, work.join(' · ')) : null);
    this.timer.hidden = false;
  }

  /** New race events: the director hears of incidents and overtakes; notable ones pop up. */
  private readEvents(sim: RaceSim): void {
    const events = sim.events;
    for (let i = Math.max(0, this.seenEvents); i < events.length; i++) {
      const e = events[i];
      // Where a car was when it happened, for a replay: from the replay buffer if it is kept.
      const at = (id: number) => this.buffer.view(sim, e.t)?.view.cars[id]?.u ?? sim.cars[id]?.u ?? 0;
      // A pass for the lead of the race is a major event; any other pass is not.
      if (e.kind === 'overtake') this.director.note(sim.cars[e.car]?.position === 1 ? 'lead' : 'overtake', e.car, sim.cars[e.car]?.position <= 10 ? { other: e.other, raceTime: e.t, u: at(e.car) } : undefined);
      if (e.kind === 'off' || e.kind === 'contact') this.director.note('incident', e.car, { raceTime: e.t, u: at(e.car) });
      if (e.kind === 'retired') this.director.note('incident', e.car);
      if (['overtake', 'fastest', 'off', 'contact', 'retired', 'pit', 'flag', 'weather'].includes(e.kind)) {
        const car = sim.cars[e.car];
        // Only the front of the field's passes and stops, to keep the screen clear.
        if ((e.kind === 'overtake' || e.kind === 'pit') && car && car.position > 10) continue;
        this.pop(e.kind, e.text);
      }
    }
    this.seenEvents = events.length;
    for (const el of [...this.pops.children] as HTMLElement[]) if (Number(el.dataset.until) < this.time) el.remove();
  }

  /** Sector and lap times of the cars on screen, as they set them. */
  private showTiming(shot: TvShot, sim: RaceSim, cut: boolean): void {
    // Only racing laps: not behind a safety car or on the way in under a red flag.
    if (shot.subject.kind === 'group' || sim.phase !== 'green') return;
    const ids = subjectIds(shot.subject);
    for (const id of ids) {
      const car = sim.cars[id];
      if (!car) continue;
      const done = car.sectors.filter((s) => s !== null).length;
      const key = `${car.lapsDone}:${done}`;
      const before = this.timing.get(id);
      this.timing.set(id, key);
      // Only what they set while on screen.
      if (cut || before === undefined || before === key || car.status !== 'running') continue;
      const i = done - 1;
      const time = i >= 0 ? car.sectors[i] : null;
      if (time === null || time === undefined) continue;
      const mark = car.sectorMarks[i];
      const cls = mark === 'best' ? 'best' : mark === 'personal' ? 'personal' : 'sector';
      if (i === 2 && car.lastLap !== null) this.pop(cls, `${car.entrant.code} · Lap ${car.lapsDone} · ${formatLapTime(car.lastLap)}`);
      else this.pop(cls, `${car.entrant.code} · Sector ${i + 1} · ${time.toFixed(3)}`);
    }
    if (this.timing.size > 8) for (const id of [...this.timing.keys()]) if (!ids.includes(id)) this.timing.delete(id);
  }

  private pop(kind: string, text: string): void {
    const el = h('div', { class: `tv-pop ${kind}` }, text);
    el.dataset.until = String(this.time + POPUP);
    this.pops.prepend(el);
    while (this.pops.children.length > 3) this.pops.lastElementChild?.remove();
  }
}

/** A number in [0, 1) from a string, the same every time. */
function hash01(text: string): number {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619) >>> 0;
  return x / 4294967296;
}

function smooth(x: number): number {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
}

function tvCar(sim: RaceSim, c: RaceCar, alpha: number, selected: number | null): TvCar {
  const session = sim instanceof SessionSim ? sim : null;
  // In a session gaps are between best laps, not on track: no battles; and a car in its garage is no pit stop.
  const gap = session ? null : sim.classInterval(c);
  // Nor is a car queued at the pit exit under a red flag.
  const stopped = c.status === 'pit' && !!c.pit?.stopped && !session && c.pit.service.reason !== 'red flag';
  const s = session?.of(c);
  const closing = !!session && session.spec.kind === 'qualifying' && session.timeLeft < Math.min(240, session.spec.duration * 0.25);
  return {
    id: c.id,
    u: c.prevU + (c.u - c.prevU) * alpha,
    speed: c.v,
    position: c.position,
    classIndex: c.cls.index,
    classPosition: c.classPosition,
    interval: gap?.kind === 'time' ? gap.value : Infinity,
    running: c.status === 'running',
    inPit: c.status === 'pit',
    stopped,
    stopLeft: stopped ? Math.max(0, c.pit!.stoppedUntil - sim.t) : 0,
    selected: c.id === selected,
    pushing: s && c.status === 'running' && s.phase === 'push' && s.fromLine ? (closing ? 2 : 1) : 0,
  };
}

function placeText(sim: RaceSim, car: RaceCar): string {
  return sim.multiClass ? `P${car.classPosition} ${car.cls.label}` : `P${car.position}`;
}

/** One car's line in a caption: position, team colour, number and driver, team, gap and tyre. */
function carRow(sim: RaceSim, car: RaceCar, gap: string, full = false, place?: number): HTMLElement {
  const compound = car.rules.tyres.compounds[car.compound];
  const pos = place ?? (sim.multiClass ? car.classPosition : car.position);
  return h('div', { class: 'tv-row' },
    h('span', { class: 'tv-pos' }, String(pos)),
    h('span', { class: 'tv-team', style: `background:${car.entrant.color}` }),
    h('span', { class: 'tv-name' },
      h('span', { class: 'tv-driver' }, full ? car.driver.name.toUpperCase() : car.entrant.code),
      full ? h('span', { class: 'tv-sub' }, `#${car.entrant.number} · ${car.entrant.team}${sim.multiClass ? ` · ${car.cls.label}` : ''}`) : null),
    gap ? h('span', { class: 'tv-gap' }, gap) : null,
    compound ? h('span', { class: 'tv-tyre', style: `border-color:${compound.color}`, title: compound.name }, compound.code) : null);
}
