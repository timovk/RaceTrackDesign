/**
 * Race statistics and chart series, all read from what the simulation
 * recorded. Rankings take an optional class; without one, a multi-class race
 * is ranked class by class.
 */
import type { PitStopRecord, RaceCar, RaceSim } from './sim.ts';

/** The cars of one class, or all of them. */
export function carsOf(sim: RaceSim, cls: number | null = null): RaceCar[] {
  return cls === null ? sim.cars : sim.cars.filter((c) => c.cls.index === cls);
}

export interface FastestLap {
  car: number;
  lap: number;
  time: number;
  compound: number;
  /** Seconds behind the fastest lap of the class. */
  gap: number;
}

/** Each car's best lap, fastest first (class by class). */
export function fastestLaps(sim: RaceSim, cls: number | null = null): FastestLap[] {
  const out: Omit<FastestLap, 'gap'>[] = [];
  for (const car of carsOf(sim, cls)) {
    let best: (typeof car.history)[number] | null = null;
    for (const h of car.history) if (!best || h.time < best.time) best = h;
    if (best) out.push({ car: car.id, lap: best.lap, time: best.time, compound: best.compound });
  }
  const classOf = (id: number) => sim.cars[id].cls.index;
  out.sort((a, b) => classOf(a.car) - classOf(b.car) || a.time - b.time);
  const top = new Map<number, number>();
  for (const f of out) if (!top.has(classOf(f.car))) top.set(classOf(f.car), f.time);
  return out.map((f) => ({ ...f, gap: f.time - top.get(classOf(f.car))! }));
}

export interface TrapSpeed {
  car: number;
  lap: number;
  /** m/s */
  speed: number;
}

/** Each car's highest speed through the speed trap, fastest first (class by class). */
export function speedTraps(sim: RaceSim, cls: number | null = null): TrapSpeed[] {
  const out: TrapSpeed[] = [];
  for (const car of carsOf(sim, cls)) {
    let best: TrapSpeed | null = null;
    for (const h of car.history) {
      if (Number.isFinite(h.trap) && !h.pit && (!best || h.trap > best.speed)) best = { car: car.id, lap: h.lap, speed: h.trap };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => sim.cars[a.car].cls.index - sim.cars[b.car].cls.index || b.speed - a.speed);
}

export interface OvertakeCount {
  car: number;
  made: number;
  lost: number;
}

/** Overtakes made and suffered per car (lapping and passing slower classes not counted), most made first. */
export function overtakeCounts(sim: RaceSim, cls: number | null = null): OvertakeCount[] {
  const counts = sim.cars.map((c) => ({ car: c.id, made: 0, lost: 0 }));
  for (const e of sim.events) {
    if (e.kind !== 'overtake') continue;
    counts[e.car].made++;
    if (e.other !== undefined) counts[e.other].lost++;
  }
  const keep = new Set(carsOf(sim, cls).map((c) => c.id));
  return counts.filter((c) => keep.has(c.car)).sort((a, b) => b.made - a.made || a.lost - b.lost);
}

/** Completed pit stops, shortest stationary time first. */
export function pitStops(sim: RaceSim, cls: number | null = null): PitStopRecord[] {
  return sim.stops
    .filter((s) => Number.isFinite(s.stationary) && (cls === null || sim.cars[s.car].cls.index === cls))
    .sort((a, b) => a.stationary - b.stationary);
}

/** Position at the end of every lap per car (overall, or in the class); index 0 is the grid slot. */
export function positionsByLap(sim: RaceSim, inClass = false): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const car of sim.cars) {
    out.set(car.id, inClass ? [car.classGrid, ...car.history.map((h) => h.classPosition)] : [car.gridPosition, ...car.history.map((h) => h.position)]);
  }
  return out;
}

/** Seconds behind the first car of the class to complete each lap, per car (index = lap - 1). */
export function gapsByLap(sim: RaceSim): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const car of sim.cars) out.set(car.id, car.history.map((h) => h.gap));
  return out;
}

export interface Stint {
  compound: number;
  /** First and last lap on this set (inclusive). */
  from: number;
  to: number;
}

/** Tyre stints per car from the lap records. */
export function stints(sim: RaceSim): Map<number, Stint[]> {
  const out = new Map<number, Stint[]>();
  for (const car of sim.cars) {
    const list: Stint[] = [];
    for (const h of car.history) {
      const cur = list[list.length - 1];
      // A new set shows as a tyre age that went back to one lap, or a different compound.
      if (!cur || h.compound !== cur.compound || h.tyreLaps <= 1) list.push({ compound: h.compound, from: h.lap, to: h.lap });
      else cur.to = h.lap;
    }
    out.set(car.id, list);
  }
  return out;
}

export interface DriverStint {
  driver: number;
  /** First and last lap (inclusive). */
  from: number;
  to: number;
}

/** Who drove which laps, per car. */
export function driverStints(sim: RaceSim): Map<number, DriverStint[]> {
  const out = new Map<number, DriverStint[]>();
  for (const car of sim.cars) {
    const list: DriverStint[] = [];
    for (const h of car.history) {
      const cur = list[list.length - 1];
      if (!cur || cur.driver !== h.driver) list.push({ driver: h.driver, from: h.lap, to: h.lap });
      else cur.to = h.lap;
    }
    out.set(car.id, list);
  }
  return out;
}

/** The leader's lap count at race time t, fractional (0 at the start), from the times the laps were completed. */
export function lapAtTime(sim: RaceSim, t: number): number {
  const times = sim.lapLeaders;
  if (!times.length) return t / Math.max(1, sim.model.lapTime);
  if (t <= times[0]) return t / times[0];
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) return i + (t - times[i - 1]) / Math.max(1e-9, times[i] - times[i - 1]);
  }
  const last = times.length > 1 ? times[times.length - 1] - times[times.length - 2] : times[0];
  return times.length + (t - times[times.length - 1]) / Math.max(1e-9, last);
}

/** Periods under a safety car, VSC or full course yellow, or stopped by a red flag, as leader laps (fractional). */
export function neutralLaps(sim: RaceSim): { kind: 'sc' | 'vsc' | 'fcy' | 'red'; from: number; to: number }[] {
  return sim.neutral.map((p) => ({ kind: p.kind, from: lapAtTime(sim, p.from), to: lapAtTime(sim, Number.isNaN(p.to) ? sim.t : p.to) }));
}
