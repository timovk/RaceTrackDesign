/**
 * The race as the television director is told of it: each car as a `TvCar`
 * (where it is, its place, the gap to the car ahead in its class, whether it
 * is in the pits or on a push lap), and which cars are side by side.
 */
import type { TvCar } from '../broadcast.ts';
import { SessionSim } from './session.ts';
import type { RaceCar, RaceSim } from './sim.ts';

/**
 * The cars of a class that are side by side now, each with the other: both
 * on the road, their bodies overlapping along it and clear of each other
 * across it. Only in a race of cars under green.
 */
export function sideBySide(sim: RaceSim): Map<number, number> {
  const out = new Map<number, number>();
  if (!sim.lanes || sim.setup.session || sim.phase !== 'green') return out;
  const n = sim.model.n;
  const ds = sim.model.track.ds;
  const cars = sim.cars.filter((c) => c.status === 'running' && !c.offTrack);
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      if (a.cls !== b.cls) continue;
      let d = (((a.u - b.u) % n) + n) % n;
      if (d > n / 2) d -= n;
      if (Math.abs(d * ds) < (a.cls.length + b.cls.length) / 2 && Math.abs(a.lateral - b.lateral) >= a.cls.half + b.cls.half) {
        out.set(a.id, b.id);
        out.set(b.id, a.id);
      }
    }
  }
  return out;
}

export function tvCar(sim: RaceSim, c: RaceCar, alpha: number, selected: number | null, beside?: number): TvCar {
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
    // (Before the first step of a race the cars have no place yet: they stand in the order of the grid.)
    position: c.position > 0 ? c.position : c.gridPosition,
    classIndex: c.cls.index,
    classPosition: c.classPosition > 0 ? c.classPosition : c.classGrid,
    interval: gap?.kind === 'time' ? gap.value : Infinity,
    running: c.status === 'running',
    inPit: c.status === 'pit',
    stopped,
    stopLeft: stopped ? Math.max(0, c.pit!.stoppedUntil - sim.t) : 0,
    selected: c.id === selected,
    pushing: s && c.status === 'running' && s.phase === 'push' && s.fromLine ? (closing ? 2 : 1) : 0,
    ...(beside === undefined ? {} : { beside }),
  };
}

/** Every car of a race for the director, `alpha` of the way from the step before to this one. */
export function tvCars(sim: RaceSim, alpha = 1, selected: number | null = null): TvCar[] {
  const beside = sideBySide(sim);
  return sim.cars.map((c) => tvCar(sim, c, alpha, selected, beside.get(c.id)));
}
