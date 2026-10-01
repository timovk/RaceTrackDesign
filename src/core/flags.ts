/**
 * The flags round the circuit during a race: what each marshal post waves or
 * holds up, and the flag at the line, following FIA Appendix H (2026),
 * article 2.5, and the safety car procedures.
 *
 * - Yellow (2.5.5 b): waved at the post before an incident and through the
 *   stretch race control puts under yellow; two flags (a double waved
 *   yellow) where the track is blocked. Green is waved at the first post
 *   after the incident.
 * - Safety car: waved yellow flags and an "SC" board at every post, until
 *   the safety car goes into the pit lane; then waved green flags.
 * - Virtual safety car and full course yellow: a single waved yellow and a
 *   "VSC" or "FCY" board at every post, with the double yellow kept at the
 *   post before the incident; waved green when it ends.
 * - Blue (2.5.5 d): waved at the post a car is coming to when a car a lap
 *   ahead of it (or from a faster class) is about to pass.
 * - Chequered at the line from the moment the winner finishes; green at the
 *   line for a rolling start.
 *
 * Green flags stay out for a lap after the race is released.
 */
import type { FlagPhase, Neutralisation, RaceSim, YellowZone } from './race/sim.ts';

export type FlagColour = 'yellow' | 'green' | 'blue' | 'chequered';
export type Board = 'SC' | 'VSC' | 'FCY';

export interface PostSignal {
  /** The flags waved, one per marshal: two yellows are a double waved yellow. */
  flags: FlagColour[];
  /** The board held up beside them. */
  board: Board | null;
}

export interface FlagCar {
  /** Race progress in stations, counted across laps. */
  u: number;
  running: boolean;
  /** The class's race lap, seconds: a faster class is let by. */
  pace: number;
  classIndex: number;
}

/** What the flags depend on: race control's state and where the cars are. */
export interface FlagState {
  t: number;
  /** Stations per lap and metres between them. */
  n: number;
  ds: number;
  phase: FlagPhase;
  /** The safety car while it is on track (it leaves the track in the pit lane). */
  safetyCar: { in: boolean } | null;
  yellows: readonly YellowZone[];
  neutral: readonly Neutralisation[];
  /** The fastest class's lap, seconds: green flags stay out this long after a neutralisation. */
  lapTime: number;
  chequered: boolean;
  rollingStart: boolean;
  cars: readonly FlagCar[];
}

/** A car this close behind another (metres) that is a lap up, or in a faster class, brings out the blue flag. */
export const BLUE_REACH = 120;
/** The blue flag is waved at the next post within this distance ahead of the car being caught (metres). */
const BLUE_POST_AHEAD = 400;
/** A rolling start's green flag is waved at the line for this long (seconds). */
const START_GREEN = 10;

export function flagState(sim: RaceSim, alpha = 1): FlagState {
  return {
    t: sim.t,
    n: sim.model.n,
    ds: sim.model.track.ds,
    phase: sim.phase,
    safetyCar: sim.safetyCar ? { in: sim.safetyCar.in } : null,
    yellows: sim.yellows,
    neutral: sim.neutral,
    lapTime: sim.model.lapTime,
    chequered: sim.chequered,
    rollingStart: sim.model.rules.race.start === 'rolling',
    cars: sim.cars.map((c) => ({ u: c.prevU + (c.u - c.prevU) * alpha, running: c.status === 'running', pace: c.cls.model.lapTime, classIndex: c.cls.index })),
  };
}

/** Whether the race was just released: green flags for a lap after a neutralisation ends, or once the safety car is in. */
export function greenPeriod(s: FlagState): boolean {
  if (s.phase === 'sc') return !s.safetyCar;
  if (s.phase !== 'green') return false;
  const last = s.neutral[s.neutral.length - 1];
  return !!last && Number.isFinite(last.to) && s.t - last.to < s.lapTime;
}

/** The signals at each post (given by its station), in the same order. */
export function postSignals(s: FlagState, posts: readonly { station: number }[]): PostSignal[] {
  const n = s.n;
  const out: PostSignal[] = posts.map(() => ({ flags: [], board: null }));
  if (!posts.length) return out;
  const ahead = (from: number, to: number) => mod(to - from, n);
  /** The post at or before station k, and the first one after it. */
  const before = (k: number) => {
    let best = 0;
    for (let i = 1; i < posts.length; i++) if (ahead(posts[i].station, k) < ahead(posts[best].station, k)) best = i;
    return best;
  };
  const after = (k: number) => {
    let best = -1;
    for (let i = 0; i < posts.length; i++) {
      const d = ahead(k, posts[i].station);
      if (d > 0 && (best < 0 || d < ahead(k, posts[best].station))) best = i;
    }
    return best < 0 ? before(k) : best;
  };

  // Local yellows: through the zone up to the incident, and at the post before it; two flags where the track is blocked.
  const yellow = new Array<number>(posts.length).fill(0);
  const green = new Array<boolean>(posts.length).fill(false);
  for (const z of s.yellows) {
    const level = z.double ? 2 : 1;
    const reach = ahead(z.from, z.at);
    posts.forEach((p, i) => {
      if (ahead(z.from, p.station) <= reach) yellow[i] = Math.max(yellow[i], level);
    });
    const b = before(z.at);
    yellow[b] = Math.max(yellow[b], level);
    green[after(z.at)] = true;
  }

  const neutral = (s.phase === 'sc' && !!s.safetyCar) || s.phase === 'vsc' || s.phase === 'fcy';
  const released = greenPeriod(s);
  const board: Board | null = !neutral ? null : s.phase === 'sc' ? 'SC' : s.phase === 'vsc' ? 'VSC' : 'FCY';
  for (let i = 0; i < posts.length; i++) {
    const o = out[i];
    if (neutral) {
      // Every post: a waved yellow and the board; the double yellow stays before the incident.
      o.flags = yellow[i] === 2 ? ['yellow', 'yellow'] : ['yellow'];
      o.board = board;
    } else if (yellow[i]) {
      o.flags = yellow[i] === 2 ? ['yellow', 'yellow'] : ['yellow'];
    } else if (released || green[i]) {
      o.flags = ['green'];
    }
  }

  // Blue flags while racing: at the post ahead of a car about to be lapped, or caught by a faster class.
  if (s.phase === 'green') {
    const reach = BLUE_REACH / s.ds;
    const postAhead = BLUE_POST_AHEAD / s.ds;
    const running = s.cars.filter((c) => c.running);
    for (const slow of running) {
      const caught = running.some((fast) => {
        if (fast === slow) return false;
        const gap = mod(slow.u - fast.u, n);
        if (gap <= 0 || gap > reach) return false;
        const lapping = fast.u - slow.u > n / 2;
        const faster = fast.classIndex !== slow.classIndex && fast.pace < slow.pace * 0.97;
        return lapping || faster;
      });
      if (!caught) continue;
      const k = mod(Math.floor(slow.u), n);
      const i = after(k);
      if (ahead(k, posts[i].station) <= postAhead && out[i].flags.length === 0) out[i].flags = ['blue'];
    }
  }
  return out;
}

/** The flag at the line: chequered once the winner has finished, green as a rolling start or a restart is given. */
export function lineFlag(s: FlagState): FlagColour | null {
  if (s.chequered) return 'chequered';
  if (s.rollingStart && s.t < START_GREEN) return 'green';
  if (greenPeriod(s)) return 'green';
  return null;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
