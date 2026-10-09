/**
 * The last stretch of a race, step by step, for action replays: where every
 * car and the safety car were and how each looked (tyres, DRS, in the pits,
 * stopped), so the 3D view can draw the race as it was a few seconds ago.
 * A stretch that will be wanted much later (a contact the stewards may give
 * a penalty for) can be kept beyond that (`keep`).
 *
 * A step is recorded after each simulation step; the view at a past time
 * gives stand-ins for the cars that carry the recorded state over the real
 * car (its entrant, class and rules), between the two steps either side of
 * that time, just as the live race is drawn between its last two steps.
 */
import type { TyreType } from './rules.ts';
import { type CarStatus, DT, type RaceCar, type RaceSim, type DamageKind } from './sim.ts';

/** What the 3D view needs to draw a race at a moment: the cars, the safety car, the time, and where a car stands. */
export interface RaceView {
  /** Race time of the later of the two steps drawn between. */
  t: number;
  cars: readonly RaceCar[];
  safetyCar: RaceSim['safetyCar'];
  pose(car: RaceCar, alpha: number): { x: number; y: number; heading: number } | null;
}

const STATUS: readonly CarStatus[] = ['running', 'pit', 'finished', 'retired'];
const TYRES: readonly TyreType[] = ['slick', 'inter', 'wet'];
/**
 * Per car per step: u, speed, lateral, status, pit progress, stopped in the box, compound, tyre type, DRS until,
 * where it retired (x, y), how far into its garage, how far it is turned round (a spin), whether it is off the road,
 * its damage.
 */
const FIELDS = 15;
const DAMAGE: readonly (DamageKind | null)[] = [null, 'wing', 'puncture', 'body', 'terminal'];

interface Step {
  t: number;
  cars: Float64Array;
  /** Safety car progress, NaN when it is not out, and whether it comes in this lap. */
  scU: number;
  scIn: boolean;
}

/** Stretches kept beyond the ring at most; the oldest goes first. */
const CLIPS = 12;

export class ReplayBuffer {
  /** Race seconds kept. */
  readonly seconds: number;
  private readonly steps: Step[] = [];
  /** Index of the oldest step in the ring, and how many are filled. */
  private head = 0;
  private count = 0;
  private sim: RaceSim | null = null;
  /** Stretches kept beyond the ring, and those asked for whose end is still to come. */
  private clips: Step[][] = [];
  private wanted: { from: number; to: number }[] = [];

  constructor(seconds = 40) {
    this.seconds = seconds;
  }

  /** Forgets everything (a new race). */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.sim = null;
    this.clips = [];
    this.wanted = [];
  }

  /**
   * Keeps the stretch of race time `from`..`to` for as long as the race
   * lasts, once all of it is recorded (it has to begin within what the ring
   * still holds, and may end in the future).
   */
  keep(from: number, to: number): void {
    this.wanted.push({ from, to });
  }

  /** Copies the stretches asked for that are complete out of the ring. */
  private keepWanted(): void {
    const now = this.to;
    const due = this.wanted.filter((w) => w.to <= now);
    if (!due.length) return;
    this.wanted = this.wanted.filter((w) => w.to > now);
    for (const w of due) {
      const clip: Step[] = [];
      for (let i = 0; i < this.count; i++) {
        const s = this.at(i);
        if (s.t >= w.from - 1e-9 && s.t <= w.to + 1e-9) clip.push({ t: s.t, cars: s.cars.slice(), scU: s.scU, scIn: s.scIn });
      }
      if (clip.length < 2) continue;
      this.clips.push(clip);
      if (this.clips.length > CLIPS) this.clips.shift();
    }
  }

  /** Earliest and latest race times recorded (NaN when empty). */
  get from(): number {
    return this.count ? this.at(0).t : NaN;
  }

  get to(): number {
    return this.count ? this.at(this.count - 1).t : NaN;
  }

  private at(i: number): Step {
    return this.steps[(this.head + i) % this.steps.length];
  }

  /** Records the race as it is now, after a step. */
  record(sim: RaceSim): void {
    if (sim !== this.sim) {
      this.clear();
      this.sim = sim;
    }
    // Time going backwards (the same race object started again) starts afresh.
    if (this.count && sim.t <= this.to) {
      this.clear();
      this.sim = sim;
    }
    // A ring of steps, allocated once for the field.
    const capacity = Math.ceil(this.seconds / DT) + 2;
    const size = sim.cars.length * FIELDS;
    if (this.steps.length !== capacity || this.steps[0].cars.length !== size) {
      this.steps.length = 0;
      for (let i = 0; i < capacity; i++) this.steps.push({ t: 0, cars: new Float64Array(size), scU: NaN, scIn: false });
      this.head = 0;
      this.count = 0;
    }
    let step: Step;
    if (this.count < capacity) {
      step = this.steps[(this.head + this.count) % capacity];
      this.count++;
    } else {
      step = this.steps[this.head];
      this.head = (this.head + 1) % capacity;
    }
    step.t = sim.t;
    for (const car of sim.cars) {
      const o = car.id * FIELDS;
      const d = step.cars;
      d[o] = car.u;
      d[o + 1] = car.v;
      d[o + 2] = car.lateral;
      d[o + 3] = STATUS.indexOf(car.status);
      d[o + 4] = car.pit ? car.pit.p : NaN;
      d[o + 5] = car.pit?.stopped ? 1 : 0;
      d[o + 6] = car.compound;
      d[o + 7] = TYRES.indexOf(car.tyreType);
      d[o + 8] = car.drsUntilU;
      d[o + 9] = car.retired ? car.retired.x : NaN;
      d[o + 10] = car.retired ? car.retired.y : NaN;
      d[o + 11] = car.garage;
      d[o + 12] = car.yaw;
      d[o + 13] = car.offTrack ? 1 : 0;
      d[o + 14] = DAMAGE.indexOf(car.damage?.kind ?? null);
    }
    const sc = sim.safetyCar;
    step.scU = sc ? sc.u : NaN;
    step.scIn = !!sc?.in;
    if (this.wanted.length) this.keepWanted();
  }

  /**
   * The race as it was at race time `t` (within what is recorded), to be
   * drawn at `alpha` between two steps; null when `t` is not recorded.
   */
  view(sim: RaceSim, t: number): { view: RaceView; alpha: number } | null {
    if (sim !== this.sim) return null;
    // From the ring, or from a stretch kept beyond it.
    const inRing = this.count >= 2 && t >= this.from && t <= this.to;
    const clip = inRing ? null : this.clips.find((c) => t >= c[0].t && t <= c[c.length - 1].t);
    if (!inRing && !clip) return null;
    const count = clip ? clip.length : this.count;
    const at = (k: number): Step => (clip ? clip[k] : this.at(k));
    // The last step at or before t (steps are DT apart).
    let i = Math.min(count - 2, Math.max(0, Math.floor((t - at(0).t) / DT + 1e-9)));
    while (i > 0 && at(i).t > t) i--;
    while (i < count - 2 && at(i + 1).t <= t) i++;
    const a = at(i);
    const b = at(i + 1);
    const alpha = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-9, b.t - a.t)));
    const cars = sim.cars.map((car) => {
      const o = car.id * FIELDS;
      const before = a.cars;
      const now = b.cars;
      const status = STATUS[now[o + 3]] ?? 'running';
      const inPit = status === 'pit' && Number.isFinite(now[o + 4]);
      const stand = Object.create(car) as RaceCar;
      Object.assign(stand, {
        prevU: before[o],
        u: now[o],
        v: now[o + 1],
        prevLateral: before[o + 2],
        lateral: now[o + 2],
        status,
        pit: inPit ? { ...(car.pit ?? {}), prevP: Number.isFinite(before[o + 4]) ? before[o + 4] : now[o + 4], p: now[o + 4], stopped: now[o + 5] === 1 } : null,
        compound: now[o + 6],
        tyreType: TYRES[now[o + 7]] ?? 'slick',
        drsUntilU: now[o + 8],
        retired: status === 'retired' ? { ...(car.retired ?? { reason: '', lap: 0, t: b.t }), x: now[o + 9], y: now[o + 10] } : null,
        prevGarage: before[o + 11],
        garage: now[o + 11],
        // (A spin ends a full turn round, which is facing ahead again: no turning back through it.)
        prevYaw: Math.abs(now[o + 12] - before[o + 12]) > Math.PI ? now[o + 12] : before[o + 12],
        yaw: now[o + 12],
        offTrack: now[o + 13] === 1,
        damage: DAMAGE[now[o + 14]] ? { kind: DAMAGE[now[o + 14]]!, pace: car.damage?.pace ?? 0 } : null,
      });
      return stand;
    });
    const safetyCar = Number.isFinite(b.scU)
      ? { u: b.scU, prevU: Number.isFinite(a.scU) ? a.scU : b.scU, startU: b.scU, clearAt: Infinity, in: b.scIn }
      : null;
    return { view: { t: b.t, cars, safetyCar, pose: (car, al) => sim.pose(car, al) }, alpha };
  }
}
