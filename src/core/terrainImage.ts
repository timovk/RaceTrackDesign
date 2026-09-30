/**
 * Turns a heightmap into two RGBA images of the same size: a base layer
 * (elevation colours, hillshade, water) and a transparent contour layer that
 * the map view can switch on and off without re-rendering the base.
 */
import type { Heightmap } from './heightmap.ts';

export interface TerrainImages {
  base: Uint8ClampedArray;
  contours: Uint8ClampedArray;
  /** Metres between contour lines; every fifth line is drawn darker. */
  contourInterval: number;
}

// Land colour ramp by height above the lowest land, as a fraction of max(land range, RAMP_MIN_RANGE); the 3D view uses it too.
export const RAMP: readonly [number, number, number, number][] = [
  [0.0, 106, 154, 79],
  [0.3, 155, 178, 101],
  [0.55, 201, 189, 132],
  [0.75, 176, 143, 102],
  [0.9, 143, 133, 121],
  [1.0, 217, 214, 208],
];
/** Below this range the ramp is not stretched, so flat maps stay green instead of turning to rock. */
export const RAMP_MIN_RANGE = 120;
export const ROCK = [138, 128, 116];
const WATER_SHALLOW = [86, 140, 186];
const WATER_DEEP = [29, 79, 128];
const CONTOUR_STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200];

export function contourInterval(range: number): number {
  const target = range / 18;
  for (const step of CONTOUR_STEPS) if (step >= target) return step;
  return CONTOUR_STEPS[CONTOUR_STEPS.length - 1];
}

export function renderTerrain(hm: Heightmap): TerrainImages {
  const n = hm.size;
  const d = hm.data;
  const hasWater = Number.isFinite(hm.waterLevel);
  const landMin = hasWater ? Math.max(hm.min, hm.waterLevel) : hm.min;
  const landRange = Math.max(hm.max - landMin, 1e-6);
  const rampRange = Math.max(landRange, RAMP_MIN_RANGE);
  const depthRange = Math.max(3, 0.15 * landRange);
  const inv2c = 1 / (2 * hm.cellSize);

  // Vertical exaggeration so gentle terrain still reads: scale the average slope to a fixed shade strength.
  let slopeSum = 0;
  let slopeCount = 0;
  for (let j = 1; j < n - 1; j += 4) {
    for (let i = 1; i < n - 1; i += 4) {
      const k = j * n + i;
      const sx = (d[k + 1] - d[k - 1]) * inv2c;
      const sy = (d[k + n] - d[k - n]) * inv2c;
      slopeSum += Math.sqrt(sx * sx + sy * sy);
      slopeCount++;
    }
  }
  const meanSlope = slopeSum / Math.max(1, slopeCount);
  const exaggeration = Math.min(5, Math.max(1, 0.18 / Math.max(meanSlope, 1e-6)));

  const interval = contourInterval(landRange);
  const base = new Uint8ClampedArray(n * n * 4);
  const contours = new Uint8ClampedArray(n * n * 4);

  for (let j = 0; j < n; j++) {
    const jm = j > 0 ? -n : 0;
    const jp = j < n - 1 ? n : 0;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const z = d[k];
      const o = k * 4;
      if (z < hm.waterLevel) {
        const t = Math.min(1, (hm.waterLevel - z) / depthRange);
        base[o] = WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * t;
        base[o + 1] = WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * t;
        base[o + 2] = WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * t;
        base[o + 3] = 255;
        continue;
      }

      const im = i > 0 ? -1 : 0;
      const ip = i < n - 1 ? 1 : 0;
      const sx = ((d[k + ip] - d[k + im]) * inv2c * exaggeration);
      const sy = ((d[k + jp] - d[k + jm]) * inv2c * exaggeration);
      // Light from the north-west, 45 degrees up; a flat cell gets factor 1.
      const shade = (0.5 * sx + 0.5 * sy + Math.SQRT1_2) / Math.sqrt(sx * sx + sy * sy + 1);
      const light = Math.min(1.2, Math.max(0.35, 0.25 + 0.75 * shade * Math.SQRT2));

      const t = (z - landMin) / rampRange;
      let r = RAMP[RAMP.length - 1][1];
      let g = RAMP[RAMP.length - 1][2];
      let b = RAMP[RAMP.length - 1][3];
      for (let s = 1; s < RAMP.length; s++) {
        if (t <= RAMP[s][0]) {
          const a = RAMP[s - 1];
          const c = RAMP[s];
          const f = (t - a[0]) / (c[0] - a[0]);
          r = a[1] + (c[1] - a[1]) * f;
          g = a[2] + (c[2] - a[2]) * f;
          b = a[3] + (c[3] - a[3]) * f;
          break;
        }
      }
      // Steep ground shows bare rock whatever its height.
      const slope = Math.sqrt(sx * sx + sy * sy) / exaggeration;
      const rock = Math.min(0.75, Math.max(0, (slope - 0.35) / 0.4));
      r += (ROCK[0] - r) * rock;
      g += (ROCK[1] - g) * rock;
      b += (ROCK[2] - b) * rock;
      base[o] = r * light;
      base[o + 1] = g * light;
      base[o + 2] = b * light;
      base[o + 3] = 255;

      // A contour runs between this cell and its right or lower neighbour when they sit in different bands.
      const band = Math.floor(z / interval);
      const right = i < n - 1 ? d[k + 1] : z;
      const below = j < n - 1 ? d[k + n] : z;
      const bandR = Math.floor(right / interval);
      const bandB = Math.floor(below / interval);
      if ((bandR !== band && right >= hm.waterLevel) || (bandB !== band && below >= hm.waterLevel)) {
        const top = Math.max(band, bandR, bandB);
        contours[o] = 58;
        contours[o + 1] = 40;
        contours[o + 2] = 24;
        contours[o + 3] = top % 5 === 0 ? 150 : 85;
      }
    }
  }
  return { base, contours, contourInterval: interval };
}
