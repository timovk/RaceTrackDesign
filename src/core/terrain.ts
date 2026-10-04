/**
 * Seeded terrain generation: domain-warped fractal noise, optionally mixed
 * with ridged noise, shaped so valley floors flatten out, then eroded by
 * water droplets. The same settings always produce the same heightmap.
 */
import { DEFAULT_EROSION, erode } from './erosion.ts';
import type { Heightmap } from './heightmap.ts';
import { createNoise2D, fbm, ridged } from './noise.ts';
import { seededRandom } from './rng.ts';

export type TerrainPreset = 'flat' | 'rolling' | 'hilly' | 'mountainous';

export const TERRAIN_PRESETS: readonly TerrainPreset[] = ['flat', 'rolling', 'hilly', 'mountainous'];

/** The settings that shape the landscape; a preset fills them all in. */
export interface TerrainShape {
  /** Metres between the lowest and highest point before erosion. */
  relief: number;
  /** Elevation of the lowest point in metres above sea level. */
  baseElevation: number;
  /** Wavelength of the largest hills in metres. */
  featureSize: number;
  /** How much small-scale detail survives (0..1). */
  roughness: number;
  /** Domain-warp strength: bends ridges and valleys into less regular shapes (0..1). */
  warp: number;
  /** Share of ridged noise, which gives sharp crests (0..1). */
  ridges: number;
  /** How much low ground flattens into valley floors (0..1). */
  valleys: number;
  /** Hydraulic erosion strength (0..1). */
  erosion: number;
  /** Fraction of the map area under water (0..0.6). */
  water: number;
}

export interface TerrainSettings extends TerrainShape {
  seed: string;
  preset: TerrainPreset;
  /** Map width and height in metres. */
  mapSize: number;
  /** Samples per side. */
  resolution: number;
  /** A surveyed terrain (core/survey.ts) used in place of the generated one; the seed and the shape then play no part. */
  survey?: string;
}

export const PRESET_SHAPES: Record<TerrainPreset, TerrainShape> = {
  flat: {
    relief: 18, baseElevation: 20, featureSize: 2400, roughness: 0.45,
    warp: 0.35, ridges: 0, valleys: 0.2, erosion: 0.15, water: 0,
  },
  rolling: {
    relief: 75, baseElevation: 120, featureSize: 2600, roughness: 0.5,
    warp: 0.5, ridges: 0.1, valleys: 0.4, erosion: 0.4, water: 0.03,
  },
  hilly: {
    relief: 220, baseElevation: 250, featureSize: 3000, roughness: 0.5,
    warp: 0.6, ridges: 0.3, valleys: 0.4, erosion: 0.6, water: 0.03,
  },
  mountainous: {
    relief: 750, baseElevation: 500, featureSize: 3600, roughness: 0.52,
    warp: 0.6, ridges: 0.7, valleys: 0.5, erosion: 0.9, water: 0.02,
  },
};

export const MAP_SIZES: readonly number[] = [4096, 8192, 16384];
export const DEFAULT_RESOLUTION = 2048;

export function defaultTerrainSettings(seed: string, preset: TerrainPreset = 'rolling'): TerrainSettings {
  return { seed, preset, mapSize: 8192, resolution: DEFAULT_RESOLUTION, ...PRESET_SHAPES[preset] };
}

/** Octaves shaped by the domain warp; finer octaves add unwarped detail. */
const BROAD_OCTAVES = 3;
/** Grid the erosion runs on; its effect is upsampled onto the full-resolution map. */
const EROSION_GRID = 512;
/** Droplets at full erosion strength, about one per erosion cell. */
const MAX_DROPLETS = 280_000;

export function generateHeightmap(s: TerrainSettings, onProgress?: (fraction: number) => void): Heightmap {
  const n = s.resolution;
  const cell = s.mapSize / n;
  const random = seededRandom(s.seed);
  const base = createNoise2D(random);
  const warpA = createNoise2D(random);
  const warpB = createNoise2D(random);
  const ridge = createNoise2D(random);
  const detail = createNoise2D(random);
  const offsetX = random() * 1000;
  const offsetY = random() * 1000;

  // Enough octaves to add detail down to about two cells, but no finer. Only the
  // large-scale octaves are warped: warping fine detail shears it into parallel
  // bands that look like wood grain.
  const octaves = Math.max(BROAD_OCTAVES + 1, Math.min(9, Math.ceil(Math.log2(s.featureSize / (2 * cell)))));
  const detailOctaves = octaves - BROAD_OCTAVES;
  const persistence = 0.3 + 0.4 * s.roughness;
  // Share of the total amplitude in the broad and the detail octaves (a running product, not pow, to stay deterministic).
  let broadWeight = 0;
  let detailWeight = 0;
  for (let o = 0, amp = 1; o < octaves; o++, amp *= persistence) {
    if (o < BROAD_OCTAVES) broadWeight += amp;
    else detailWeight += amp;
  }
  const detailFreq = 1 << BROAD_OCTAVES;
  const warpAmount = 0.9 * s.warp;

  const v = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  const rowsPerReport = Math.max(1, Math.floor(n / 40));
  for (let j = 0; j < n; j++) {
    const py = ((j + 0.5) * cell) / s.featureSize + offsetY;
    for (let i = 0; i < n; i++) {
      const px = ((i + 0.5) * cell) / s.featureSize + offsetX;
      let qx = px;
      let qy = py;
      if (warpAmount > 0) {
        qx += warpAmount * fbm(warpA, px * 0.7, py * 0.7, 3, 0.5);
        qy += warpAmount * fbm(warpB, px * 0.7 + 5.2, py * 0.7 + 1.3, 3, 0.5);
      }
      const fine = fbm(detail, px * detailFreq, py * detailFreq, detailOctaves, persistence);
      const broad = fbm(base, qx, qy, BROAD_OCTAVES, persistence);
      let h = 0.5 + (0.5 * (broad * broadWeight + fine * detailWeight)) / (broadWeight + detailWeight);
      if (s.ridges > 0) {
        // Sharp crests and spurs, added only on high ground so valleys stay open.
        const r = ridged(ridge, qx * 2, qy * 2, 3, persistence);
        const high = Math.min(1, Math.max(0, (h - 0.4) / 0.4));
        h += s.ridges * 0.35 * (r - 0.3) * high * high * (3 - 2 * high);
      }
      v[j * n + i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (onProgress && j % rowsPerReport === 0) onProgress(0.7 * (j / n));
  }

  // Normalise to 0..1 and flatten the low ground: a blend of linear and cubic keeps peaks sharp.
  const range = hi - lo || 1;
  const a = s.valleys;
  for (let k = 0; k < v.length; k++) {
    const t = (v[k] - lo) / range;
    v[k] = (1 - a) * t + a * t * t * t;
  }

  if (s.erosion > 0) {
    applyErosion(v, n, s, (f) => onProgress?.(0.7 + 0.28 * f));
  }

  // Erosion can dig below the original floor; shift so the lowest point sits at the base elevation.
  let floor = Infinity;
  for (let k = 0; k < v.length; k++) if (v[k] < floor) floor = v[k];
  const data = new Float32Array(n * n);
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < v.length; k++) {
    const z = s.baseElevation + (v[k] - floor) * s.relief;
    data[k] = z;
    if (z < min) min = z;
    if (z > max) max = z;
  }
  const waterLevel = s.water > 0 ? quantile(data, min, max, s.water) : -Infinity;
  onProgress?.(1);
  return { size: n, cellSize: cell, extent: s.mapSize, data, min, max, waterLevel };
}

/** Erodes a downsampled copy and adds the change back onto the full-resolution map. */
function applyErosion(v: Float32Array, n: number, s: TerrainSettings, onProgress: (f: number) => void): void {
  const e = Math.min(EROSION_GRID, n);
  const step = n / e;
  const small = new Float32Array(e * e);
  for (let j = 0; j < e; j++) {
    for (let i = 0; i < e; i++) {
      small[j * e + i] = bilinear(v, n, (i + 0.5) * step - 0.5, (j + 0.5) * step - 0.5);
    }
  }
  const before = small.slice();
  erode(small, e, seededRandom(`${s.seed}:erosion`), { ...DEFAULT_EROSION, droplets: Math.round(s.erosion * MAX_DROPLETS) }, onProgress);
  for (let k = 0; k < small.length; k++) small[k] -= before[k];
  // Droplets never reach the outermost cells; copy the change outward so the edge shows no seam.
  const m = Math.ceil(DEFAULT_EROSION.radius) + 2;
  const delta = small.slice();
  for (let j = 0; j < e; j++) {
    const jj = Math.min(e - 1 - m, Math.max(m, j));
    for (let i = 0; i < e; i++) {
      const ii = Math.min(e - 1 - m, Math.max(m, i));
      small[j * e + i] = delta[jj * e + ii];
    }
  }
  for (let j = 0; j < n; j++) {
    const sy = (j + 0.5) / step - 0.5;
    for (let i = 0; i < n; i++) {
      v[j * n + i] += bilinear(small, e, (i + 0.5) / step - 0.5, sy);
    }
  }
}

function bilinear(grid: Float32Array, n: number, gx: number, gy: number): number {
  if (gx < 0) gx = 0;
  else if (gx > n - 1) gx = n - 1;
  if (gy < 0) gy = 0;
  else if (gy > n - 1) gy = n - 1;
  const i0 = Math.min(Math.floor(gx), n - 2);
  const j0 = Math.min(Math.floor(gy), n - 2);
  const fx = gx - i0;
  const fy = gy - j0;
  const k = j0 * n + i0;
  const top = grid[k] * (1 - fx) + grid[k + 1] * fx;
  const bottom = grid[k + n] * (1 - fx) + grid[k + n + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** The elevation below which `fraction` of the samples lie, from a fine histogram. */
function quantile(data: Float32Array, min: number, max: number, fraction: number): number {
  const bins = 4096;
  const counts = new Uint32Array(bins);
  const scale = (bins - 1) / (max - min || 1);
  for (let k = 0; k < data.length; k++) counts[Math.floor((data[k] - min) * scale)]++;
  const target = fraction * data.length;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += counts[b];
    if (acc >= target) return min + (b + 1) / scale;
  }
  return max;
}
