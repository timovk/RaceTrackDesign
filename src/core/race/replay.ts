/**
 * The last stretch of a race, step by step, for action replays: where every
 * car and the safety car were and how each looked (tyres, DRS, in the pits,
 * stopped), so the 3D view can draw the race as it was a few seconds ago.
 *
 * A step is recorded after each simulation step; the view at a past time
 * gives stand-ins for the cars that carry the recorded state over the real
 * car (its entrant, class and rules), between the two steps either side of
 * that time, just as the live race is drawn between its last two steps.
 */
import type { TyreType } from './rules.ts';
import { type CarStatus, DT, type RaceCar, type RaceSim } from './sim.ts';

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
/** Per car per step: u, speed, lateral, status, pit progress, stopped in the box, compound, tyre type, DRS until, where it retired (x, y), how far into its garage. */
const FIELDS = 12;

interface Step {
  t: number;
  cars: Float64Array;
  /** Safety car progress, NaN when it is not out, and whether it comes in this lap. */
  scU: number;
  scIn: boolean;
}

export class ReplayBuffer {
  /** Race seconds kept. */
  readonly seconds: number;
  private readonly steps: Step[] = [];
  /** Index of the oldest step in the ring, and how many are filled. */
  private head = 0;
  private count = 0;
  private sim: RaceSim | null = null;

  constructor(seconds = 40) {
    this.seconds = seconds;
  }

  /** Forgets everything (a new race). */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.sim = null;
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
    }
    const sc = sim.safetyCar;
    step.scU = sc ? sc.u : NaN;
    step.scIn = !!sc?.in;
  }

  /**
   * The race as it was at race time `t` (within what is recorded), to be
   * drawn at `alpha` between two steps; null when `t` is not recorded.
   */
  view(sim: RaceSim, t: number): { view: RaceView; alpha: number } | null {
    if (sim !== this.sim || this.count < 2 || !(t >= this.from) || t > this.to) return null;
    // The last step at or before t (steps are DT apart).
    let i = Math.min(this.count - 2, Math.max(0, Math.floor((t - this.from) / DT + 1e-9)));
    while (i > 0 && this.at(i).t > t) i--;
    while (i < this.count - 2 && this.at(i + 1).t <= t) i++;
    const a = this.at(i);
    const b = this.at(i + 1);
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
        lateral: now[o + 2],
        status,
        pit: inPit ? { ...(car.pit ?? {}), prevP: Number.isFinite(before[o + 4]) ? before[o + 4] : now[o + 4], p: now[o + 4], stopped: now[o + 5] === 1 } : null,
        compound: now[o + 6],
        tyreType: TYRES[now[o + 7]] ?? 'slick',
        drsUntilU: now[o + 8],
        retired: status === 'retired' ? { ...(car.retired ?? { reason: '', lap: 0, t: b.t }), x: now[o + 9], y: now[o + 10] } : null,
        prevGarage: before[o + 11],
        garage: now[o + 11],
      });
      return stand;
    });
    const safetyCar = Number.isFinite(b.scU)
      ? { u: b.scU, prevU: Number.isFinite(a.scU) ? a.scU : b.scU, startU: b.scU, clearAt: Infinity, in: b.scIn }
      : null;
    return { view: { t: b.t, cars, safetyCar, pose: (car, al) => sim.pose(car, al) }, alpha };
  }
}
