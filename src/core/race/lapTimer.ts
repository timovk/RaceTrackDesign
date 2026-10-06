/**
 * The lap timer of a qualifying broadcast: a car's time at the end of the
 * sector it has just completed, against the same point of the lap to beat
 * (the fastest lap of its class so far).
 */
import type { RaceCar, RaceClass } from './sim.ts';

/** The fastest lap of a class so far: who set it, and the time at the end of each sector (the last is the lap time). */
export interface LapToBeat {
  car: number;
  time: number;
  splits: [number, number, number];
}

/** A car's time at the end of a sector of its lap, and how far that is from the lap to beat at the same point (null without one). */
export interface Split {
  /** 1, 2, or 3 for the whole lap. */
  sector: 1 | 2 | 3;
  time: number;
  delta: number | null;
}

/** The lap to beat in a class, or null while nobody has set a time. */
export function lapToBeat(cls: RaceClass): LapToBeat | null {
  const f = cls.fastest;
  if (!f) return null;
  const lap = cls.cars.find((c) => c.id === f.car)?.history.find((h) => h.lap === f.lap && h.time === f.time);
  if (!lap) return null;
  return { car: f.car, time: f.time, splits: [lap.sectors[0], lap.sectors[0] + lap.sectors[1], f.time] };
}

/**
 * The split of a car that has `done` sectors of its lap behind it (3: it has
 * just completed the lap), against `target`: the lap to beat as it stood
 * while the car was on that lap. Null when the car has no time there.
 */
export function splitTime(car: RaceCar, done: number, target: LapToBeat | null): Split | null {
  if (done < 1 || done > 3) return null;
  const [s1, s2] = car.sectors;
  const time = done === 3 ? car.lastLap : done === 2 ? (s1 !== null && s2 !== null ? s1 + s2 : null) : s1;
  if (time === null || time === undefined) return null;
  return { sector: done as 1 | 2 | 3, time, delta: target ? time - target.splits[done - 1] : null };
}

/** A name as a broadcast caption has it: the initial and the surname in capitals ("N HULKENBERG" for "N. Hulkenberg"). */
export function captionName(name: string): string {
  return name.replace(/\./g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
