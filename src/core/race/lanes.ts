/**
 * Lanes: what room a car takes on the road, and what it costs to be off the
 * racing line.
 *
 * In a race of cars every car has a sideways position (metres left of the
 * racing line) and a width. Two cars fit side by side when their centres are
 * a car's width and SIDE_GAP apart, and a car is only held up by one in its
 * way (see sim.ts).
 *
 * The racing line uses the whole road. A car with another beside it has half
 * of it, so the cost of being off the line is taken from the best line
 * through each half of the track (a "lane line"): the lap is driven on both,
 * and where a lane's lap is slower because the corner holds it (braking for
 * it and turning, not accelerating away afterwards), the ratio of the two
 * times over that corner is the most a car in that lane can do through it:
 * the inside lane is slower but shorter, the outside faster but longer. A
 * car with another beside it is in its lane; a car alone between the racing
 * line and the lane line takes its share of the difference, and one on the
 * racing line is not slowed at all, so lap times stay what they were. What a
 * slow corner costs on the straight after it is not in the ratio: the car
 * accelerates from the speed it had (the launch curve in model.ts).
 */
import type { LapResult } from '../lapSim.ts';
import { type RacingLine, LINE_MARGIN, computeRacingLine } from '../racingLine.ts';
import type { Track } from '../track.ts';

/** Clearance between two cars side by side, metres. */
export const SIDE_GAP = 0.6;
/** Clearance between a car and the edge of the track, metres. */
export const EDGE_GAP = 0.2;

export interface BodySize {
  length: number;
  width: number;
}

/** Sizes of the cars as drawn (carBodies.ts), by class; other classes take their kind's. */
const SIZES: Record<string, BodySize> = {
  f1: { length: 5.65, width: 2 },
  f2: { length: 5.13, width: 1.9 },
  indycar: { length: 5.17, width: 1.97 },
  hypercar: { length: 5.12, width: 2 },
  lmp2: { length: 4.75, width: 2 },
  gt3: { length: 4.7, width: 2 },
  gt4: { length: 4.7, width: 1.96 },
  tcr: { length: 4.43, width: 1.95 },
  'f1-1950': { length: 4.28, width: 1.48 },
  motogp: { length: 1.85, width: 0.66 },
  superbike: { length: 1.83, width: 0.66 },
};

export function bodySize(vehicle: { id: string; kind: 'car' | 'bike' }): BodySize {
  return SIZES[vehicle.id] ?? (vehicle.kind === 'bike' ? SIZES.superbike : SIZES.gt3);
}

/** Lane index of a sideways position: 0 left of the racing line, 1 right of it. */
export const LEFT = 0;
export const RIGHT = 1;

const lines = new WeakMap<Track, [RacingLine, RacingLine]>();

/**
 * The best line for a car kept to the left half and to the right half of the
 * track: its centre between half a car and half the gap from the middle, and
 * the usual margin from the edge. Kept per track, since every class shares them.
 */
export function laneLines(track: Track): [RacingLine, RacingLine] {
  let pair = lines.get(track);
  if (!pair) {
    const n = track.n;
    const inner = new Float64Array(n).fill(1 + SIDE_GAP / 2);
    const outer = Float64Array.from(track.width, (w) => w / 2 - LINE_MARGIN);
    const minus = (a: Float64Array) => Float64Array.from(a, (v) => -v);
    pair = [
      computeRacingLine(track, LINE_MARGIN, { lo: inner, hi: outer }),
      computeRacingLine(track, LINE_MARGIN, { lo: minus(outer), hi: minus(inner) }),
    ];
    lines.set(track, pair);
  }
  return pair;
}

export interface LaneCosts {
  /** Per lane and station: the share of the racing line's pace a car in the lane can do where the corner holds it (its time to the next station over the lane's); 1 elsewhere. */
  cap: [Float32Array, Float32Array];
  /** Per lane and station: how far the lane line lies from the racing line, metres (positive left). */
  shift: [Float32Array, Float32Array];
}

/** A lap counts as accelerating away, not held by the corner, from this share of full throttle. */
const FLAT_OUT = 0.999;

/** The lane costs of one class, from its race lap on the racing line and the same lap on each lane line. */
export function laneCosts(line: RacingLine, lanes: readonly [RacingLine, RacingLine], base: LapResult, laps: readonly [LapResult, LapResult]): LaneCosts {
  const n = line.n;
  const time = (lap: LapResult, k: number) => (k < n - 1 ? lap.t[k + 1] : lap.time) - lap.t[k];
  const side = (i: number) => {
    const cap = new Float32Array(n).fill(1);
    const shift = new Float32Array(n);
    for (let k = 0; k < n; k++) shift[k] = lanes[i].offset[k] - line.offset[k];
    // One figure for each stretch the lane's lap is not flat out (a corner with its braking zone, or several run
    // together): the racing line's time over it against the lane's. Station by station the two differ far more,
    // since at the same station the cars are on arcs of different lengths (round a hairpin the outside car has
    // five times the road to cover), which says who is ahead at each point of the corner but not what the corner costs.
    const held = (k: number) => laps[i].throttle[k] < FLAT_OUT;
    let from = 0;
    while (from < n && held(from)) from++;
    if (from === n) from = 0;
    for (let s = 0; s < n;) {
      const k = (from + s) % n;
      if (!held(k)) {
        s++;
        continue;
      }
      let len = 0;
      let own = 0;
      let lane = 0;
      while (len < n - s && held((k + len) % n)) {
        own += time(base, (k + len) % n);
        lane += time(laps[i], (k + len) % n);
        len++;
      }
      const ratio = Math.min(1, own / Math.max(lane, 1e-9));
      for (let j = 0; j < len; j++) cap[(k + j) % n] = ratio;
      s += len;
    }
    return { cap, shift };
  };
  const left = side(LEFT);
  const right = side(RIGHT);
  return { cap: [left.cap, right.cap], shift: [left.shift, right.shift] };
}
