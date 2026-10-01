/**
 * TV mode of the 3D view: the race as a broadcast. The director
 * (core/broadcast.ts) decides what to show and from where; this moves the
 * camera and draws the graphics.
 *
 * A trackside camera stands still and pans and zooms with its car through
 * a long lens, a little behind it like an operator would; the helicopter
 * hangs high off to one side and circles slowly. A new shot is a cut. When
 * the camera picks up a new car or battle, a caption names it (position,
 * driver, team, gap, tyre); overtakes, fastest laps, incidents,
 * retirements, race control's flags and the weather pop up as they happen,
 * and the sector and lap times of the
 * car on screen as it sets them (purple for the best of all, green for its
 * own best). In the rain, drops settle on the lens of the trackside
 * cameras (a fresh set at every cut).
 */
import * as THREE from 'three';
import { type Heli, type TvCamera, type TvCar, type TvShot, Director, framingFov, heliStart, heliStep } from '../core/broadcast.ts';
import { formatLapTime } from '../core/calibration.ts';
import type { RaceCar, RaceSim } from '../core/race/sim.ts';
import type { Vec3 } from '../core/shots.ts';
import { h, setChildren } from './dom.ts';
import type { RaceController } from './raceController.ts';

export interface TvHost {
  camera: THREE.PerspectiveCamera;
  /** Where the graphics go. */
  overlay: HTMLElement;
  /** A car's middle (scene coordinates), heading (world, radians) and length, or null when it is not drawn. */
  car(id: number): { position: THREE.Vector3; heading: number; length: number } | null;
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

export class TvBroadcast {
  readonly director: Director;
  private readonly host: TvHost;
  private readonly race: RaceController;
  private readonly layer: HTMLElement;
  private readonly lower: HTMLElement;
  private readonly pops: HTMLElement;
  private readonly drops: HTMLElement;
  private shot: TvShot | null = null;
  private aim = new THREE.Vector3();
  private fov = 30;
  private heli: Heli | null = null;
  private heliPos = new THREE.Vector3();
  private captionUntil = 0;
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
    this.layer = h('div', { class: 'tv' }, this.drops, this.lower, this.pops);
    host.overlay.append(this.layer);
  }

  dispose(): void {
    this.layer.remove();
  }

  /** What the camera looks at, scene coordinates. */
  get focus(): THREE.Vector3 {
    return this.aim;
  }

  /** The camera's name, for the player bar. */
  get label(): string {
    const s = this.shot;
    if (!s) return '';
    return s.camera === 'heli' ? 'Helicopter' : this.director.camera(s.camera)?.label ?? '';
  }

  /** Moves on by `dt` screen seconds: the director decides, the camera follows. */
  update(dt: number): void {
    const r = this.race;
    const sim = r.sim;
    if (!sim) return;
    this.time += dt;
    if (sim !== this.sim) {
      this.sim = sim;
      this.seenEvents = sim.events.length;
    }
    this.readEvents(sim);
    const cars = sim.cars.map((c) => tvCar(sim, c, r.alpha, r.selected));
    const shot = this.director.update(r.playing ? dt : 0, Math.max(0.05, r.speed), cars);
    const cut = shot !== this.shot;
    if (cut && shot) this.onCut(shot, sim);
    this.shot = shot;
    if (shot) {
      this.point(shot, dt, cut);
      this.showTiming(shot, sim, cut);
    }
    if (this.time > this.captionUntil) this.lower.hidden = true;
  }

  private subject(shot: TvShot): { centre: THREE.Vector3; heading: number; size: number; speed: number } | null {
    const ids = shot.subject.kind === 'car' ? [shot.subject.id] : [shot.subject.ahead, shot.subject.behind];
    const poses = ids.map((id) => this.host.car(id)).filter((p): p is NonNullable<typeof p> => !!p);
    if (poses.length === 0) return null;
    const centre = new THREE.Vector3();
    for (const p of poses) centre.add(p.position);
    centre.divideScalar(poses.length);
    const spread = poses.length > 1 ? poses[0].position.distanceTo(poses[1].position) : 0;
    const car = this.race.sim?.cars[ids[ids.length - 1]];
    return { centre, heading: poses[poses.length - 1].heading, size: spread + poses[0].length * 1.3, speed: car?.v ?? 0 };
  }

  /** Points the camera at the shot's subject: snapped on a cut, then with an operator's (or a helicopter's) lag. */
  private point(shot: TvShot, dt: number, cut: boolean): void {
    const cam = this.host.camera;
    const sub = this.subject(shot);
    if (!sub) return;
    // A little ahead of the car, as a camera operator leads it.
    const forward = new THREE.Vector3(Math.cos(sub.heading), 0, Math.sin(sub.heading));
    const target = sub.centre.clone().addScaledVector(forward, Math.min(4, sub.speed * 0.04));
    // The picture's middle is the middle of what the timing tower leaves free.
    const view = this.host.size();
    const aspect = (view.width - view.covered) / Math.max(1, view.height);
    if (view.covered > 0) cam.setViewOffset(view.width, view.height, -view.covered / 2, 0, view.width, view.height);
    else cam.clearViewOffset();
    this.layer.style.setProperty('--tv-centre', `${view.covered + (view.width - view.covered) / 2}px`);
    const follow = (tc: number) => (cut ? 1 : 1 - Math.exp(-dt / tc));
    let position: THREE.Vector3;
    let wantFov: number;
    if (shot.camera === 'heli') {
      if (cut || !this.heli) this.heli = this.clearHeli(heliStart(sub.heading), sub.centre);
      this.heli = heliStep(this.heli, dt);
      const hp = this.heli;
      const want = this.heliSpot(hp, sub.centre);
      // A hill coming between: climb.
      if (!this.clear(this.heliPos, sub.centre)) hp.height += dt * 40;
      if (cut) this.heliPos.copy(want);
      else this.heliPos.lerp(want, follow(1.4));
      position = this.heliPos;
      wantFov = framingFov(position.distanceTo(target), Math.max(sub.size, 6), shot.subject.kind === 'battle' ? 0.32 : 0.2, aspect, 4, 40);
    } else {
      const tc = this.director.camera(shot.camera);
      if (!tc) return;
      this.heli = null;
      position = this.host.fromDrawn(tc.at);
      wantFov = framingFov(position.distanceTo(target), sub.size, shot.subject.kind === 'battle' ? 0.75 : 0.5, aspect, 1.2, 45);
    }
    // Panning with the car (its speed across the view), and closing what is left with a little lag.
    if (cut || !this.lastTarget || dt <= 0) {
      if (cut) this.aim.copy(target);
    } else {
      this.aim.add(target.clone().sub(this.lastTarget));
      this.aim.lerp(target, follow(shot.camera === 'heli' ? 0.5 : 0.25));
    }
    this.lastTarget = target.clone();
    this.fov = cut ? wantFov : this.fov + (wantFov - this.fov) * follow(0.6);
    cam.position.copy(position);
    cam.lookAt(this.aim);
    cam.fov = this.fov;
    const d = position.distanceTo(this.aim);
    cam.near = Math.max(0.3, Math.min(20, d / 600));
    cam.updateProjectionMatrix();
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
    const prev = this.shot;
    const sameSubject = prev && JSON.stringify(prev.subject) === JSON.stringify(shot.subject);
    if (sameSubject) return;
    const caption = this.caption(shot, sim);
    if (!caption) return;
    setChildren(this.lower, caption);
    this.lower.hidden = false;
    // Restart the slide-in.
    this.lower.classList.remove('in');
    void this.lower.offsetWidth;
    this.lower.classList.add('in');
    this.captionUntil = this.time + CAPTION;
  }

  /** Raindrops on a trackside camera's lens, more in heavier rain; the helicopter's camera stays clear. */
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
    const head = { battle: 'Battle', incident: 'Incident', overtake: 'Overtake', leader: '', pit: 'Pit stop', selected: '', field: '' }[shot.reason];
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

  /** New race events: the director hears of incidents and overtakes; notable ones pop up. */
  private readEvents(sim: RaceSim): void {
    const events = sim.events;
    for (let i = Math.max(0, this.seenEvents); i < events.length; i++) {
      const e = events[i];
      if (e.kind === 'overtake') this.director.note('overtake', e.car);
      if (e.kind === 'off' || e.kind === 'contact' || e.kind === 'retired') this.director.note('incident', e.car);
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
    const ids = shot.subject.kind === 'car' ? [shot.subject.id] : [shot.subject.ahead, shot.subject.behind];
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

function tvCar(sim: RaceSim, c: RaceCar, alpha: number, selected: number | null): TvCar {
  const gap = sim.classInterval(c);
  return {
    id: c.id,
    u: c.prevU + (c.u - c.prevU) * alpha,
    speed: c.v,
    position: c.position,
    classIndex: c.cls.index,
    classPosition: c.classPosition,
    interval: gap.kind === 'time' ? gap.value : Infinity,
    running: c.status === 'running',
    inPit: c.status === 'pit',
    stopped: c.status === 'pit' && !!c.pit?.stopped,
    selected: c.id === selected,
  };
}

function placeText(sim: RaceSim, car: RaceCar): string {
  return sim.multiClass ? `P${car.classPosition} ${car.cls.label}` : `P${car.position}`;
}

/** One car's line in a caption: position, team colour, number and driver, team, gap and tyre. */
function carRow(sim: RaceSim, car: RaceCar, gap: string, full = false): HTMLElement {
  const compound = car.rules.tyres.compounds[car.compound];
  const pos = sim.multiClass ? car.classPosition : car.position;
  return h('div', { class: 'tv-row' },
    h('span', { class: 'tv-pos' }, String(pos)),
    h('span', { class: 'tv-team', style: `background:${car.entrant.color}` }),
    h('span', { class: 'tv-name' },
      h('span', { class: 'tv-driver' }, full ? car.driver.name.toUpperCase() : car.entrant.code),
      full ? h('span', { class: 'tv-sub' }, `#${car.entrant.number} · ${car.entrant.team}${sim.multiClass ? ` · ${car.cls.label}` : ''}`) : null),
    gap ? h('span', { class: 'tv-gap' }, gap) : null,
    compound ? h('span', { class: 'tv-tyre', style: `border-color:${compound.color}`, title: compound.name }, compound.code) : null);
}

