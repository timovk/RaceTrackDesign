/**
 * Weather for a race: a seeded rain timeline and the track's wetness, which
 * follows the rain with a lag (it gets wet within minutes and dries over
 * about twenty). Wetness runs from 0 (dry) through damp and wet to 1
 * (standing water) and sets, per tyre type, the grip left, how fast the
 * tyres wear and how likely drivers are to make mistakes.
 */
import { seededRandom } from '../rng.ts';
import type { TyreType } from './rules.ts';

export type WeatherKind = 'dry' | 'changeable' | 'wet';

export interface Weather {
  kind: WeatherKind;
  /** Seconds between samples, and the race time of the first sample (before the start, so the track has a history). */
  step: number;
  start: number;
  /** Rain intensity, 0 (none) to 1 (heavy), and track wetness, 0 to 1, per sample. */
  rain: Float32Array;
  wetness: Float32Array;
}

export const WEATHER_KINDS: readonly WeatherKind[] = ['dry', 'changeable', 'wet'];

const STEP = 10;
const LEAD_IN = 3600;
/** Time constants (s) for the track getting wet and drying out. */
const WETTING = 300;
const DRYING = 960;
/** Rain intensity above which it counts as raining. */
export const RAIN_THRESHOLD = 0.05;

/**
 * The rain and wetness over `duration` seconds of racing (with margin for a
 * race that runs long). Changeable brings one or more showers during the
 * race; wet starts with rain that may stop and let the track dry.
 */
export function buildWeather(kind: WeatherKind, seed: string, duration: number): Weather {
  const rng = seededRandom(`${seed}:weather`);
  const span = Math.max(3600, duration * 1.6 + 1800);
  const count = Math.ceil((LEAD_IN + span) / STEP) + 1;
  const rain = new Float32Array(count);
  const at = (i: number) => -LEAD_IN + i * STEP;

  const shower = (from: number, length: number, peak: number) => {
    // Builds up over a fifth of its length, eases off over the last third, with a slow wobble.
    const phase = rng() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const t = at(i);
      if (t < from || t > from + length) continue;
      const x = (t - from) / length;
      const envelope = Math.min(1, x / 0.2, (1 - x) / 0.33);
      const wobble = 0.8 + 0.2 * Math.sin(phase + (t / 600) * Math.PI * 2);
      rain[i] = Math.max(rain[i], Math.min(1, peak * envelope * wobble));
    }
  };

  if (kind === 'changeable') {
    // At least one shower during the race, more in a long one.
    const showers = 1 + Math.floor(rng() * (1 + duration / 5400));
    for (let s = 0; s < showers; s++) {
      const length = 300 + rng() * rng() * 2700;
      const from = (0.08 + 0.72 * rng()) * duration - length * 0.2;
      shower(from, length, 0.25 + 0.75 * rng());
    }
  } else if (kind === 'wet') {
    // Raining since well before the start; it may stop during the race and dry out.
    const stops = rng() < 0.6 ? (0.3 + 0.8 * rng()) * duration : span;
    shower(-LEAD_IN * 0.8, stops + LEAD_IN * 0.8, 0.45 + 0.5 * rng());
    if (rng() < 0.4) shower((0.4 + 0.5 * rng()) * duration, 600 + 1800 * rng(), 0.3 + 0.6 * rng());
  }

  const wetness = new Float32Array(count);
  let w = 0;
  for (let i = 0; i < count; i++) {
    const target = Math.min(1, Math.pow(rain[i], 0.6));
    const tau = target > w ? WETTING : DRYING;
    w += (target - w) * (1 - Math.exp(-STEP / tau));
    wetness[i] = w < 1e-4 ? 0 : w;
  }
  return { kind, step: STEP, start: -LEAD_IN, rain, wetness };
}

function sample(w: Weather, values: Float32Array, t: number): number {
  const x = (t - w.start) / w.step;
  if (x <= 0) return values[0];
  const i = Math.floor(x);
  if (i >= values.length - 1) return values[values.length - 1];
  return values[i] + (values[i + 1] - values[i]) * (x - i);
}

export function rainAt(w: Weather, t: number): number {
  return sample(w, w.rain, t);
}

export function wetnessAt(w: Weather, t: number): number {
  return sample(w, w.wetness, t);
}

/** Average wetness from `from` to `to` seconds (what the team expects from the radar). */
export function wetnessAhead(w: Weather, from: number, to: number): number {
  let sum = 0;
  const steps = 6;
  for (let i = 0; i <= steps; i++) sum += wetnessAt(w, from + ((to - from) * i) / steps);
  return sum / (steps + 1);
}

/** Grip as a share of a slick's on a dry track. Slicks lose it fast in the wet; wet tyres are slower in the dry. */
export function gripFactor(type: TyreType, wetness: number): number {
  const w = Math.max(0, Math.min(1, wetness));
  if (type === 'slick') return 1 - 0.48 * Math.pow(w, 0.7);
  if (type === 'inter') return 0.9 - 0.25 * Math.pow(w, 1.6);
  return 0.82 - 0.08 * Math.pow(w, 1.5);
}

/**
 * Lap-time fraction lost on top of the grip: slicks (and, in standing water,
 * intermediates) aquaplane, so drivers lift on the straights too.
 */
export function aquaplaning(type: TyreType, wetness: number): number {
  const w = Math.max(0, Math.min(1, wetness));
  if (type === 'slick') return 0.3 * Math.max(0, w - 0.2);
  if (type === 'inter') return 0.08 * Math.max(0, w - 0.7);
  return 0;
}

/** Tyre wear multiplier: intermediates and wets overheat and wear out fast on a drying track. */
export function wearFactor(type: TyreType, wetness: number): number {
  const w = Math.max(0, Math.min(1, wetness));
  if (type === 'slick') return 1 - 0.5 * w;
  if (type === 'inter') return 1 + 5 * Math.max(0, 0.25 - w) / 0.25;
  return 1 + 9 * Math.max(0, 0.45 - w) / 0.45;
}

/** Multiplier on mistakes, trips off and crashes: high on slicks in the wet, and higher in the rain on any tyre. */
export function riskFactor(type: TyreType, wetness: number): number {
  const w = Math.max(0, Math.min(1, wetness));
  if (type === 'slick') return 1 + 25 * Math.max(0, w - 0.1);
  if (type === 'inter') return 1 + 1.2 * w + 6 * Math.max(0, w - 0.7);
  return 1 + 0.8 * w;
}

/** The tyre type with the most grip at this wetness, among those available. */
export function bestTyreType(wetness: number, available: readonly TyreType[]): TyreType {
  let best: TyreType = available[0] ?? 'slick';
  for (const t of available) if (gripFactor(t, wetness) > gripFactor(best, wetness)) best = t;
  return best;
}

/** "Dry", "Damp", "Wet" or "Very wet". */
export function conditionName(wetness: number): string {
  if (wetness < 0.08) return 'Dry';
  if (wetness < 0.3) return 'Damp';
  if (wetness < 0.65) return 'Wet';
  return 'Very wet';
}
