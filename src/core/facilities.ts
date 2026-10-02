/**
 * Everything placed around the track once lap times are known: the starting
 * grid, the pit lane and what a pit stop costs each class, the speed trap,
 * DRS zones, the main overtaking spots and the marshal posts. The start line
 * itself is placed earlier (startFinish.ts), since the lap is counted from it.
 */
import { type DrsZone, drsZones } from './lapSim.ts';
import type { LapResult } from './lapSim.ts';
import { Earthworks, builtGround, pitRoad, trackRoad } from './earthworks.ts';
import { type MarshalPlan, placeMarshalPosts } from './marshals.ts';
import type { Performance } from './performance.ts';
import { type PitLane, type PitLoss, type PitOverride, pitTimeLoss, placePitLane } from './pitLane.ts';
import { type GridSlot, type StartFinish, gridSlots } from './startFinish.ts';
import { dist } from './geometry.ts';
import type { HeightSampler, Track } from './track.ts';
import type { VehicleClass } from './vehicles.ts';

export interface Overrides {
  /** World position of a start line moved by hand. */
  startFinish?: { x: number; y: number };
  pitLane?: PitOverride;
  speedTrap?: { x: number; y: number };
}

export interface SpeedTrap {
  station: number;
  overridden: boolean;
}

export interface OvertakingZone {
  /** Station where braking starts. */
  station: number;
  /** Speed lost under braking by the fastest class, in m/s. */
  speedDrop: number;
  /** Length of the full-throttle run before it, in metres. */
  runLength: number;
}

export interface Facilities {
  startFinish: StartFinish;
  grid: GridSlot[];
  pitLane: PitLane | null;
  pitLoss: PitLoss[];
  speedTrap: SpeedTrap;
  drsZones: DrsZone[];
  overtaking: OvertakingZone[];
  marshals: MarshalPlan;
}

export interface FacilityInput {
  /** Track rotated so the start line is station 0. */
  track: Track;
  startFinish: StartFinish;
  performance: Performance;
  vehicles: readonly VehicleClass[];
  heightAt: HeightSampler;
  waterLevel: number;
  extent: number;
  overrides: Overrides;
  /**
   * A layout's pit lane: the full circuit's, with its entry and exit as
   * stations of this track, or null when the layout skips it. When absent,
   * the pit lane is placed for this track.
   */
  pitLane?: PitLane | null;
}

const MAX_OVERTAKING_ZONES = 4;
/** Metres just before a braking zone where the driver lifts, passed over when measuring the full-throttle run. */
const LIFT = 10;

export function placeFacilities(input: FacilityInput): Facilities {
  const { track: t, performance: perf } = input;
  const fastest = fastestLap(perf.laps);
  const firstCorner = firstCornerIsRight(t);

  const pitLane = input.pitLane !== undefined ? input.pitLane : fastest
    ? placePitLane({
        track: t, line: perf.line, reference: fastest, heightAt: input.heightAt,
        waterLevel: input.waterLevel, extent: input.extent, override: input.overrides.pitLane ?? null,
      })
    : null;
  const pitLoss = pitLane
    ? perf.laps.map((lap) => pitTimeLoss(pitLane, lap, input.vehicles.find((v) => v.id === lap.vehicleId)?.pitSpeed ?? 60 / 3.6))
    : [];

  return {
    startFinish: input.startFinish,
    grid: gridSlots(t, firstCorner),
    pitLane,
    pitLoss,
    speedTrap: speedTrap(t, fastest, input.overrides.speedTrap),
    drsZones: drsZones(perf.line),
    overtaking: fastest ? overtakingZones(fastest, perf.line.ds) : [],
    // Marshals look over the ground as built: along the cuttings and over the banks the track needs.
    marshals: placeMarshalPosts(t, builtGround(new Earthworks(
      { extent: input.extent, waterLevel: input.waterLevel, cellSize: 4, height: input.heightAt },
      pitLane ? [trackRoad(t), pitRoad(pitLane, t)] : [trackRoad(t)],
    ))),
  };
}

export function fastestLap(laps: readonly LapResult[]): LapResult | null {
  let best: LapResult | null = null;
  for (const l of laps) if (!best || l.time < best.time) best = l;
  return best;
}

/** Whether the first real corner after the start turns right, to put pole position on its inside. */
function firstCornerIsRight(t: Track): boolean {
  for (let k = 0; k < t.n; k++) if (Math.abs(t.curvature[k]) > 1 / 300) return t.curvature[k] > 0;
  return true;
}

/** Where the fastest class is quickest, unless moved by hand. */
function speedTrap(t: Track, lap: LapResult | null, override?: { x: number; y: number }): SpeedTrap {
  if (override) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < t.n; k++) {
      const d = dist(t.x[k], t.y[k], override.x, override.y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return { station: best, overridden: true };
  }
  if (!lap) return { station: 0, overridden: false };
  // Cars on the rev limiter hold their top speed for a long way: use the end of the longest such stretch,
  // just before the braking point, where real speed traps usually sit.
  const n = t.n;
  let vMax = 0;
  for (let k = 0; k < n; k++) vMax = Math.max(vMax, lap.v[k]);
  const fast = (k: number) => lap.v[(k + n) % n] >= vMax - 0.5;
  let origin = 0;
  while (origin < n && fast(origin)) origin++;
  let bestEnd = 0;
  let bestLen = -1;
  let runLen = 0;
  for (let i = 1; i <= n; i++) {
    const k = (origin + i) % n;
    if (fast(k)) runLen++;
    else if (runLen > 0) {
      if (runLen > bestLen) {
        bestLen = runLen;
        bestEnd = (k - 1 + n) % n;
      }
      runLen = 0;
    }
  }
  return { station: bestEnd, overridden: false };
}

/**
 * The braking zones where overtaking is most likely: a big speed drop after a
 * long full-throttle run, scored by drop times run length.
 */
export function overtakingZones(lap: LapResult, ds: Float64Array): OvertakingZone[] {
  const n = lap.v.length;
  const zones: (OvertakingZone & { score: number })[] = [];
  // Start where the car is not braking, so no zone is split by the wrap-around.
  let origin = 0;
  while (origin < n && lap.brake[origin] > 0.3) origin++;
  let i = 0;
  while (i < n) {
    const k = (origin + i) % n;
    if (lap.brake[k] > 0.3) {
      let j = i;
      let vMin = lap.v[k];
      while (j < n && lap.brake[(origin + j) % n] > 0.1) {
        vMin = Math.min(vMin, lap.v[(origin + j) % n]);
        j++;
      }
      let run = 0;
      let lift = 0;
      for (let b = 1; b < n; b++) {
        const q = (k - b + n) % n;
        if (lap.throttle[q] < 0.98) {
          if (run > 0 || lift >= LIFT) break;
          lift += ds[q];
          continue;
        }
        run += ds[q];
      }
      const drop = lap.v[k] - vMin;
      if (drop > 60 / 3.6 && run > 250) zones.push({ station: k, speedDrop: drop, runLength: run, score: drop * Math.min(run, 1000) });
      i = j + 1;
    } else i++;
  }
  return zones
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OVERTAKING_ZONES)
    .map(({ score: _s, ...z }) => z)
    .sort((a, b) => a.station - b.station);
}
