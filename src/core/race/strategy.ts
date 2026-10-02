/**
 * Tyre and pit-stop strategy. A car's lap slows with its tyres' wear (a
 * linear loss up to the end of the tyre's life, then a steep "cliff") and
 * each stop costs the drive through the pit lane plus the stationary time.
 *
 * Classes without refuelling plan their stints ahead: a dynamic programme
 * over (laps covered, compounds used) finds the fastest split of the race
 * into tyre stints, honouring the two-compound rule and mandatory stops.
 * Classes with refuelling stop when the fuel runs low and change tyres at a
 * stop when the set would not last another stint. Plans cover the dry
 * compounds only; wet-weather tyres are fitted when the conditions call for
 * them, and using them lifts the two-compound rule.
 */
import type { RaceModel } from './model.ts';
import type { Compound, RaceRules, TyreType } from './rules.ts';

export interface StintPlan {
  compound: number;
  laps: number;
}

export interface Strategy {
  stints: StintPlan[];
  /** Estimated time lost to tyres, compound choice and stops, in seconds. */
  cost: number;
}

export interface StrategyInput {
  model: RaceModel;
  /** The driver's tyre wear multiplier. */
  tyreFactor: number;
  /** Laps still to race, the current one included. */
  laps: number;
  /** Current set and its wear, or null to pick a fresh set for the first stint. */
  compound: number | null;
  wear: number;
  /** Bit mask of compounds used so far. */
  used: number;
  stopsDone: number;
  canStop: boolean;
  /** The wear the team believes in, per compound, as a share of the real wear (1 when missing): see practice long runs. */
  wearGuess?: readonly number[];
}

/** Lap-time fraction lost on a set with this much wear (1 = the end of its life). */
export function tyreLoss(c: Compound, wear: number): number {
  if (wear <= 1) return c.deg * wear;
  const over = wear - 1;
  // Past the end of its life the tyre falls off a cliff.
  return c.deg + c.deg * (6 * over + 20 * over * over);
}

export function wearPerLap(model: RaceModel, compound: number, tyreFactor: number): number {
  const c = model.rules.tyres.compounds[compound];
  return (model.line.length / c.life) * model.tyreSeverity * tyreFactor;
}

/** Seconds a stop costs beyond staying on track: the pit lane, the stationary time and a slower out-lap on cold tyres. */
export function stopCost(model: RaceModel, fuelKg = 0): number {
  const p = model.rules.pit;
  const fuelTime = model.rules.fuel.refuelRate > 0 ? fuelKg / model.rules.fuel.refuelRate : 0;
  const service = Math.max(p.minStationary, p.concurrent ? Math.max(p.tyreChange, fuelTime) : p.tyreChange + fuelTime);
  return (model.pit?.driveThroughLoss ?? 20) + service + COLD_TYRES * model.lapTime * 0.5 + BOX_LOSS;
}

/** Out-lap slowdown on a fresh set, as a lap-time fraction. */
export const COLD_TYRES = 0.01;
/** Braking into and pulling away from the box, beyond the drive-through. */
const BOX_LOSS = 3;
const MAX_DP_LAPS = 500;
const MAX_STINTS = 5;
/** Longest stint considered, in tyre lives. */
const MAX_WEAR = 1.6;

/**
 * Best stint plan for the rest of the race, for classes without refuelling
 * (and any class that cannot stop, which gets a single stint). With `rng`,
 * the choice is made among plans within `margin` seconds of the best, so the
 * field does not all run the same strategy.
 */
export function planStrategy(input: StrategyInput, rng?: () => number, margin = 0): Strategy {
  const { model } = input;
  const compounds = model.rules.tyres.compounds;
  const C = compounds.length;
  const dry = compounds.map((_, c) => c).filter((c) => compounds[c].type === 'slick');
  const N = Math.max(1, Math.min(MAX_DP_LAPS, Math.round(input.laps)));
  const lap = model.lapTime;

  // Cost of a stint of L laps (index L) on compound c from wear w0.
  const stintCosts = (c: number, w0: number): Float64Array => {
    const out = new Float64Array(N + 1);
    const wpl = wearPerLap(model, c, input.tyreFactor) * (input.wearGuess?.[c] ?? 1);
    for (let L = 1; L <= N; L++) out[L] = out[L - 1] + (compounds[c].offset + tyreLoss(compounds[c], w0 + (L - 0.5) * wpl)) * lap;
    return out;
  };
  const fresh = compounds.map((_, c) => stintCosts(c, 0));
  const pitsAllowed = input.canStop && !!model.pit && model.rules.pit.stops;
  // Stints far past the end of a tyre's life are never worth it; skipping them keeps the programme small.
  const maxLen = (c: number, w0: number) =>
    pitsAllowed ? Math.max(1, Math.min(N, Math.floor((MAX_WEAR - w0) / Math.max(1e-6, wearPerLap(model, c, input.tyreFactor) * (input.wearGuess?.[c] ?? 1))))) : N;
  const freshMax = compounds.map((_, c) => maxLen(c, 0));
  const needTwo = pitsAllowed && needsSecondCompound(model.rules, input.used, true);
  const minStops = pitsAllowed ? Math.max(0, model.rules.pit.minStops - input.stopsDone) : 0;
  const stop = stopCost(model);

  const options: Strategy[] = [];
  const firstChoices = input.compound === null || compounds[input.compound].type !== 'slick' ? dry : [input.compound];
  const onSet = input.compound !== null && firstChoices[0] === input.compound;
  for (const c0 of firstChoices) {
    const first = onSet ? stintCosts(c0, input.wear) : fresh[c0];
    const plans = bestPlans(first, c0, onSet);
    options.push(...plans);
  }
  options.sort((a, b) => a.cost - b.cost);
  if (!options.length) {
    // Nothing satisfies the rules (e.g. no pit lane but two compounds required): run the whole race on one set.
    const c0 = onSet ? input.compound! : dry[0];
    return { stints: [{ compound: c0, laps: N }], cost: stintCosts(c0, onSet ? input.wear : 0)[N] };
  }
  if (!rng || margin <= 0) return options[0];
  const near = options.filter((o) => o.cost <= options[0].cost + margin);
  return near[Math.min(near.length - 1, Math.floor(rng() * near.length))];

  /** The best plan for each number of stops, starting on compound c0. */
  function bestPlans(first: Float64Array, c0: number, onSet: boolean): Strategy[] {
    const M = 1 << C;
    const size = (N + 1) * M;
    const out: Strategy[] = [];
    const levels: { cost: Float64Array; prev: Int32Array; comp: Int8Array; len: Int16Array }[] = [];
    const startMask = input.used | (1 << c0);
    const maxStints = pitsAllowed ? MAX_STINTS : 1;
    for (let s = 0; s < maxStints; s++) {
      const cost = new Float64Array(size).fill(Infinity);
      const prev = new Int32Array(size).fill(-1);
      const comp = new Int8Array(size);
      const len = new Int16Array(size);
      if (s === 0) {
        const firstMax = onSet ? maxLen(c0, input.wear) : freshMax[c0];
        for (let L = pitsAllowed ? 1 : N; L <= firstMax; L++) {
          const i = L * M + startMask;
          cost[i] = first[L];
          comp[i] = c0;
          len[i] = L;
        }
      } else {
        const last = levels[s - 1];
        for (let j = 1; j < N; j++) {
          for (let mask = 0; mask < M; mask++) {
            const base = last.cost[j * M + mask];
            if (base === Infinity) continue;
            for (const c of dry) {
              const nm = mask | (1 << c);
              const costs = fresh[c];
              const top = Math.min(N - j, freshMax[c]);
              for (let L = 1; L <= top; L++) {
                const i = (j + L) * M + nm;
                const v = base + stop + costs[L];
                if (v < cost[i]) {
                  cost[i] = v;
                  prev[i] = j * M + mask;
                  comp[i] = c;
                  len[i] = L;
                }
              }
            }
          }
        }
      }
      levels.push({ cost, prev, comp, len });
      if (s < minStops) continue;
      // Complete plans at this number of stints.
      let bestI = -1;
      for (let mask = 0; mask < M; mask++) {
        if (needTwo && popcount(mask & dryMask(model.rules)) < 2) continue;
        const i = N * M + mask;
        if (cost[i] < Infinity && (bestI < 0 || cost[i] < cost[bestI])) bestI = i;
      }
      if (bestI < 0) continue;
      const stints: StintPlan[] = [];
      let i = bestI;
      for (let lv = s; lv >= 0; lv--) {
        const L = levels[lv];
        stints.unshift({ compound: L.comp[i], laps: L.len[i] });
        i = L.prev[i];
      }
      out.push({ stints, cost: cost[bestI] });
    }
    return out;
  }
}

/**
 * The compound to fit at a stop for a stint of about `laps` laps: the fastest
 * over that stint that does not go far past the end of its life, or an
 * unused one when the two-compound rule still needs it.
 */
export function pickCompound(model: RaceModel, laps: number, tyreFactor: number, used: number, lastSet: boolean, guess?: readonly number[]): number {
  const compounds = model.rules.tyres.compounds;
  const dry = compounds.map((_, c) => c).filter((c) => compounds[c].type === 'slick');
  if (needsSecondCompound(model.rules, used) && lastSet) {
    let best = -1;
    for (const c of dry) {
      if (used & (1 << c)) continue;
      if (best < 0 || stintAverage(model, c, laps, tyreFactor, guess) < stintAverage(model, best, laps, tyreFactor, guess)) best = c;
    }
    if (best >= 0) return best;
  }
  let best = dry[0];
  for (const c of dry) if (stintAverage(model, c, laps, tyreFactor, guess) < stintAverage(model, best, laps, tyreFactor, guess)) best = c;
  return best;
}

/** Bit mask of the dry (slick) compounds. */
export function dryMask(rules: RaceRules): number {
  return rules.tyres.compounds.reduce((m, c, i) => (c.type === 'slick' ? m | (1 << i) : m), 0);
}

/**
 * Whether the two-compound rule still needs another dry compound: not once
 * two have been used, nor after wet-weather tyres (with `ignoreUsed`, only
 * whether the rule applies at all given the wet tyres used).
 */
export function needsSecondCompound(rules: RaceRules, used: number, ignoreUsed = false): boolean {
  if (!rules.tyres.mustUseTwo) return false;
  const dry = dryMask(rules);
  if (used & ~dry) return false;
  return ignoreUsed || popcount(used & dry) < 2;
}

/** The first compound of a type, or null when the class has none. */
export function compoundOfType(rules: RaceRules, type: TyreType): number | null {
  const i = rules.tyres.compounds.findIndex((c) => c.type === type);
  return i < 0 ? null : i;
}

/** The tyre types a class can fit. */
export function tyreTypes(rules: RaceRules): TyreType[] {
  return [...new Set(rules.tyres.compounds.map((c) => c.type))];
}

function stintAverage(model: RaceModel, c: number, laps: number, tyreFactor: number, guess?: readonly number[]): number {
  const comp = model.rules.tyres.compounds[c];
  const wpl = wearPerLap(model, c, tyreFactor) * (guess?.[c] ?? 1);
  const L = Math.max(1, Math.round(laps));
  let sum = 0;
  for (let i = 0; i < L; i++) sum += comp.offset + tyreLoss(comp, (i + 0.5) * wpl);
  return sum / L;
}

export function popcount(mask: number): number {
  let c = 0;
  for (let m = mask; m; m &= m - 1) c++;
  return c;
}
