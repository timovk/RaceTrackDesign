/**
 * Weather as the 3D view shows it, worked out from the race's weather
 * (core/race/weather.ts): how overcast the sky is, how wet the racing line
 * is against the rest of the track, and the spray a car throws up.
 *
 * Spray is drawn as puffs thrown up in turn from the rear wheels. Each puff
 * is placed from the race clock alone (no state from frame to frame): it was
 * thrown up `age` seconds ago where the car was then, so it hangs in the air
 * as the car runs on, rising, spreading and fading. The same race time
 * always gives the same spray.
 */
import { RAIN_THRESHOLD, type Weather, rainAt } from './race/weather.ts';

/** How overcast the sky is, 0 (clear) to 1: clouds gather a quarter of an hour before a shower and clear after it. */
export function cloudCover(w: Weather, t: number): number {
  let c = rainAt(w, t);
  for (const [dt, weight] of CLOUD_REACH) c = Math.max(c, rainAt(w, t + dt) * weight);
  return smoothstep(0, 0.3, c);
}

/** Seconds ahead (positive) or back, and how much rain then counts towards the clouds now. */
const CLOUD_REACH: readonly (readonly [number, number])[] = [[300, 0.9], [600, 0.7], [900, 0.45], [-300, 0.8], [-600, 0.5]];

/**
 * Wetness on the racing line, where the tyres run: while it rains they
 * sweep some of the water away; once it stops, the line dries first.
 */
export function lineWetness(wetness: number, rain: number): number {
  const drying = 1 - smoothstep(RAIN_THRESHOLD, 0.15, rain);
  return 0.85 * wetness * (1 - drying) + wetness * wetness * drying;
}

/** Share of the track with standing water, from a very wet track up. */
export function standingWater(wetness: number): number {
  return smoothstep(0.6, 0.9, wetness);
}

export type SprayBody = 'single-seater' | 'closed' | 'bike';

/** Wide tyres and a diffuser throw up the most spray; a bike's narrow tyres little. */
const SPRAY_BODY: Record<SprayBody, number> = { 'single-seater': 1, closed: 0.85, bike: 0.35 };

/** How much spray a car throws up, 0 to 1: none on a dry track or at walking pace. */
export function sprayStrength(wetness: number, speed: number, body: SprayBody): number {
  return smoothstep(0.03, 0.45, wetness) * smoothstep(8, 50, speed) * SPRAY_BODY[body];
}

/** Seconds a puff of spray hangs in the air, and puffs per car. */
export const SPRAY_LIFE = 0.9;
export const SPRAY_SLOTS = 64;

export interface Puff {
  /** Metres behind the car's middle along its path, metres to its left, and height above the road. */
  back: number;
  side: number;
  up: number;
  /** Width in metres, and opacity 0 to 1. */
  size: number;
  alpha: number;
}

/**
 * The spray behind a car at race time `now` (seconds), into `out`
 * (SPRAY_SLOTS puffs): `seed` tells cars apart, `strength` comes from
 * sprayStrength.
 */
export function sprayPuffs(seed: number, now: number, speed: number, strength: number, car: { length: number; width: number }, out: Puff[]): void {
  for (let i = 0; i < SPRAY_SLOTS; i++) {
    const x = now / SPRAY_LIFE + hash01(seed, i, 0, 0);
    const cycle = Math.floor(x);
    const f = x - cycle;
    const age = f * SPRAY_LIFE;
    const r1 = hash01(seed, i, cycle, 1);
    const r2 = hash01(seed, i, cycle, 2);
    const r3 = hash01(seed, i, cycle, 3);
    const wheel = i % 2 === 0 ? 1 : -1;
    const p = out[i] ?? (out[i] = { back: 0, side: 0, up: 0, size: 0, alpha: 0 });
    // Thrown up behind a rear wheel where the car was `age` ago; the car's wake carries it along a little.
    p.back = car.length * 0.45 + speed * age * 0.85;
    p.side = wheel * car.width * 0.35 * (1 + f * 1.2) + (r1 - 0.5) * f * 2.5;
    p.up = 0.3 + (1 + 1.6 * r2) * (1 - Math.exp(-age * 4)) * (0.5 + 0.5 * strength);
    p.size = (0.8 + 5.5 * f) * (0.8 + 0.4 * r3) * (0.6 + 0.4 * strength) * Math.max(0.5, car.width / 2);
    p.alpha = strength * 0.4 * Math.pow(1 - f, 1.3) * Math.min(1, f * 10);
  }
}

/** A repeatable random number in [0, 1) from four integers. */
function hash01(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d) ^ Math.imul(d | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
