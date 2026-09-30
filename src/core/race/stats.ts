/** Race statistics and chart series, all read from what the simulation recorded. */
import type { PitStopRecord, RaceSim } from './sim.ts';

export interface FastestLap {
  car: number;
  lap: number;
  time: number;
  compound: number;
  /** Seconds behind the fastest lap of the race. */
  gap: number;
}

/** Each car's best lap, fastest first. */
export function fastestLaps(sim: RaceSim): FastestLap[] {
  const out: Omit<FastestLap, 'gap'>[] = [];
  for (const car of sim.cars) {
    let best: (typeof car.history)[number] | null = null;
    for (const h of car.history) if (!best || h.time < best.time) best = h;
    if (best) out.push({ car: car.id, lap: best.lap, time: best.time, compound: best.compound });
  }
  out.sort((a, b) => a.time - b.time);
  const top = out[0]?.time ?? 0;
  return out.map((f) => ({ ...f, gap: f.time - top }));
}

export interface TrapSpeed {
  car: number;
  lap: number;
  /** m/s */
  speed: number;
}

/** Each car's highest speed through the speed trap, fastest first. */
export function speedTraps(sim: RaceSim): TrapSpeed[] {
  const out: TrapSpeed[] = [];
  for (const car of sim.cars) {
    let best: TrapSpeed | null = null;
    for (const h of car.history) {
      if (Number.isFinite(h.trap) && !h.pit && (!best || h.trap > best.speed)) best = { car: car.id, lap: h.lap, speed: h.trap };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.speed - a.speed);
}

export interface OvertakeCount {
  car: number;
  made: number;
  lost: number;
}

/** Overtakes made and suffered per car (lapping backmarkers not counted), most made first. */
export function overtakeCounts(sim: RaceSim): OvertakeCount[] {
  const counts = sim.cars.map((c) => ({ car: c.id, made: 0, lost: 0 }));
  for (const e of sim.events) {
    if (e.kind !== 'overtake') continue;
    counts[e.car].made++;
    if (e.other !== undefined) counts[e.other].lost++;
  }
  return counts.sort((a, b) => b.made - a.made || a.lost - b.lost);
}

/** Completed pit stops, shortest stationary time first. */
export function pitStops(sim: RaceSim): PitStopRecord[] {
  return sim.stops.filter((s) => Number.isFinite(s.stationary)).sort((a, b) => a.stationary - b.stationary);
}

/** Position at the end of every lap per car; index 0 is the grid slot. NaN after a car stopped. */
export function positionsByLap(sim: RaceSim): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const car of sim.cars) out.set(car.id, [car.gridPosition, ...car.history.map((h) => h.position)]);
  return out;
}

/** Seconds behind the first car to complete each lap, per car (index = lap - 1). */
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
