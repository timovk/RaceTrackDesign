/**
 * The stewards: who is to blame for a contact between two cars, and what a
 * penalty is called. (What each series gives, and how it is served, is in
 * its rules: StewardRules; the race keeps the cases: RaceSim.cases.)
 *
 * Blame follows the FIA's driving standards guidelines, by which every
 * series here is judged alike:
 *
 * - A car coming up the inside is entitled to room once its front axle is
 *   beside the other car's mirror (ALONGSIDE of a car's length here) and it
 *   has not dived in.
 * - A car on the outside is entitled to room only when it is ahead.
 * - A car that hits one that was entitled to its place, or runs it off the
 *   road, is to blame. Where both were entitled to theirs, the one that
 *   left the other no room is.
 * - Where that is not clear, nobody is: "unless it is clear to the stewards
 *   that a driver was wholly or predominantly to blame for an incident no
 *   penalty will be imposed".
 *
 * The lesser penalty goes to a driver who was nearly far enough alongside,
 * or whose own race was the only one to suffer.
 */
import type { Penalty } from './rules.ts';
import type { ContactRecord } from './sim.ts';

/** How far alongside (0 nose to tail, 1 level) the car behind has to be on the inside to be entitled to room: its front axle beside the other's mirror. */
export const ALONGSIDE = 0.7;
/** From here two cars are level: neither can be called ahead. */
export const LEVEL = 0.9;
/** Short of ALONGSIDE by less than this, it is not clear who is to blame; by less than NEARLY, the circumstances are mitigating. */
export const CLEAR = 0.1;
export const NEARLY = 0.2;
/** Where the first lap is judged leniently, only a car short by this much is to blame. */
export const FIRST_LAP = 0.3;

export type Offence = 'collision' | 'forcing off';

export interface Verdict {
  /** The car wholly or predominantly to blame, or -1: nobody. */
  blame: number;
  offence: Offence;
  /** Mitigating circumstances: the series' lesser penalty. */
  mitigated: boolean;
  /** Why: what the car to blame did, or what the stewards call it when nobody is. */
  reason: string;
}

/** One contact before the stewards, from the moment it happens to what became of the penalty. */
export interface StewardCase {
  /** The contact: its index in the race's `contacts`. */
  contact: number;
  /** Race time and lap of the contact, and where (" at T4", or nothing). */
  t: number;
  lap: number;
  where: string;
  /** The car behind and the car ahead. */
  cars: [number, number];
  /** Race time at which the stewards say they are looking at it, and at which they decide (Infinity: after the race). */
  noteAt: number;
  decideAt: number;
  state: 'noted' | 'investigating' | 'decided';
  /** Once decided: when, the verdict, and the penalty (null: no further action). */
  decidedAt: number;
  verdict: Verdict | null;
  penalty: Penalty | null;
  /**
   * What became of a penalty: still to be served, served, added to the car's
   * race time (`seconds`), or nothing (a warning, or the car is out of the
   * race).
   */
  status: 'open' | 'served' | 'added' | 'none';
  seconds: number;
}

/**
 * The stewards' verdict on a contact. `lenient`: on the first lap, where
 * the series judges that leniently (only a car that dived in, or was far
 * from alongside, is to blame).
 */
export function judge(c: ContactRecord, lenient = false): Verdict {
  const { ahead, behind, overlap } = c;
  const other = (car: number) => (car === ahead ? behind : ahead);
  const suffered = (car: number) => c.hurt.includes(car);
  const nobody = (reason: string): Verdict => ({ blame: -1, offence: 'collision', mitigated: false, reason });
  const blame = (car: number, reason: string, mitigated = false): Verdict => ({
    blame: car,
    offence: c.outcome === 'forced off' && suffered(other(car)) ? 'forcing off' : 'collision',
    // Its own race the only one to suffer: no immediate and obvious sporting consequence for anyone else.
    mitigated: mitigated || !suffered(other(car)),
    reason,
  });
  const incident = lenient ? 'a first-lap incident' : 'a racing incident';
  // A car that dived in is entitled to nothing, wherever it got to.
  if (c.lunging >= 0) return blame(c.lunging, 'braked too late for the corner');
  if (c.inside === behind) {
    if (overlap >= ALONGSIDE) {
      // Far enough alongside on the inside: the car ahead owed it room.
      if (c.squeezed === behind && !lenient) return blame(ahead, 'left a car alongside no room');
      return nobody(incident);
    }
    const short = ALONGSIDE - overlap;
    if (short < (lenient ? FIRST_LAP : CLEAR)) return nobody(lenient ? incident : 'neither driver predominantly to blame');
    return blame(behind, 'was not far enough alongside on the inside', short < NEARLY);
  }
  // On the outside a car is owed room only when it is ahead.
  if (overlap >= LEVEL) return nobody(incident);
  if (!suffered(ahead)) return nobody('the car on the outside was not ahead and was owed no room');
  if (lenient && LEVEL - overlap < FIRST_LAP) return nobody(incident);
  return blame(behind, 'turned in on the car ahead from the outside', LEVEL - overlap < NEARLY);
}

/** A penalty in words: "10-second time penalty", "Drive-through penalty", "Warning". */
export function penaltyText(p: Penalty): string {
  return p.kind === 'time' ? `${formatSeconds(p.seconds)}-second time penalty` : p.kind === 'driveThrough' ? 'Drive-through penalty' : 'Warning';
}

/** An offence in words, with the other car's name: "causing a collision with VER", "forcing VER off the track". */
export function offenceText(offence: Offence, other: string): string {
  return offence === 'forcing off' ? `forcing ${other} off the track` : `causing a collision with ${other}`;
}

/** Seconds without a needless decimal: 5, 12.5. */
export function formatSeconds(seconds: number): string {
  return String(Math.round(seconds * 10) / 10);
}
