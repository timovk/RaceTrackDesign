/**
 * Everything the lap-time model says about a track: the racing line, a lap
 * for every vehicle class, and three timed sectors of roughly equal length
 * in time.
 */
import { type LapResult, simulateLap } from './lapSim.ts';
import { type RacingLine, computeRacingLine } from './racingLine.ts';
import type { Track } from './track.ts';
import type { VehicleClass } from './vehicles.ts';

export interface Performance {
  line: RacingLine;
  laps: LapResult[];
  /** Stations where sectors 2 and 3 begin; sector 1 begins at station 0. */
  sectors: [number, number];
  /** Class whose lap placed the sector lines. */
  sectorReference: string;
}

/** Sector lines go on the reference class's lap, which suits every class reasonably. */
export const SECTOR_REFERENCE = 'gt3';
/** Sector lines may move this share of the lap time to find a full-throttle spot. */
const SECTOR_WINDOW = 0.06;

export function analysePerformance(track: Track, vehicles: readonly VehicleClass[], line = computeRacingLine(track)): Performance {
  const laps = vehicles.map((car) => simulateLap(track, line, car));
  const reference = laps.find((l) => l.vehicleId === SECTOR_REFERENCE) ?? laps[0];
  return {
    line,
    laps,
    sectors: reference ? placeSectors(reference) : [Math.floor(track.n / 3), Math.floor((2 * track.n) / 3)],
    sectorReference: reference?.vehicleId ?? '',
  };
}

/**
 * Sector lines near one and two thirds of the lap time, moved to the nearest
 * full-throttle station within a small window so they sit on straights, as
 * real timing lines usually do.
 */
export function placeSectors(lap: LapResult): [number, number] {
  const n = lap.t.length;
  const pick = (fraction: number): number => {
    const target = fraction * lap.time;
    const window = SECTOR_WINDOW * lap.time;
    let nearest = 0;
    let bestFull = -1;
    for (let k = 0; k < n; k++) {
      const d = Math.abs(lap.t[k] - target);
      if (d < Math.abs(lap.t[nearest] - target)) nearest = k;
      if (d <= window && lap.throttle[k] >= 0.98 && (bestFull < 0 || d < Math.abs(lap.t[bestFull] - target))) bestFull = k;
    }
    return bestFull >= 0 ? bestFull : nearest;
  };
  const a = pick(1 / 3);
  const b = pick(2 / 3);
  return a < b ? [a, b] : [b, a];
}

export function sectorTimes(lap: LapResult, sectors: [number, number]): [number, number, number] {
  const [a, b] = sectors;
  return [lap.t[a], lap.t[b] - lap.t[a], lap.time - lap.t[b]];
}
