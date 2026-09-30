/**
 * Colour scales for painting the track by a station property. Each scale is
 * a short list of buckets so the legend stays readable and the map can draw
 * long runs of equal colour in one stroke.
 */
import type { LapResult } from '../core/lapSim.ts';
import type { Track } from '../core/track.ts';

export type ColorBy = 'plain' | 'speed' | 'gear' | 'pedals' | 'gradient' | 'radius' | 'elevation' | 'earthworks';

export const COLOR_BY_LABELS: Record<ColorBy, string> = {
  plain: 'Plain',
  speed: 'Speed',
  gear: 'Gear',
  pedals: 'Throttle and brake',
  gradient: 'Gradient',
  radius: 'Corner radius',
  elevation: 'Elevation',
  earthworks: 'Cut and fill',
};

/** Scales that need a lap from the selected class. */
export const LAP_SCALES: ReadonlySet<ColorBy> = new Set(['speed', 'gear', 'pedals']);

export interface Bucket {
  color: string;
  label: string;
}

/** What a scale may read besides the track: the selected lap and how stations map onto it. */
export interface LapSource {
  lap: LapResult | null;
  index: (station: number) => number;
}

export const ASPHALT = '#3b3f46';

const GRADIENT_BUCKETS: Bucket[] = [
  { color: '#2f6fd6', label: '< -8%' },
  { color: '#5a9be8', label: '-8 to -4%' },
  { color: '#a7c8ef', label: '-4 to -1%' },
  { color: '#c9ccd1', label: '±1%' },
  { color: '#f3b39a', label: '1 to 4%' },
  { color: '#ea7a55', label: '4 to 8%' },
  { color: '#d23c2c', label: '> 8%' },
];
const GRADIENT_EDGES = [-0.08, -0.04, -0.01, 0.01, 0.04, 0.08];

const RADIUS_BUCKETS: Bucket[] = [
  { color: '#e5484d', label: '< 30 m' },
  { color: '#f28c3a', label: '30–60 m' },
  { color: '#f2c94e', label: '60–120 m' },
  { color: '#b6d45a', label: '120–250 m' },
  { color: '#5fbf7a', label: '250–500 m' },
  { color: '#aab3bd', label: 'straight' },
];
const RADIUS_EDGES = [30, 60, 120, 250, 500];

const ELEVATION_COLORS = ['#3b1f5c', '#46337e', '#365c8d', '#277f8e', '#1fa187', '#4ac16d', '#a0da39', '#fde725'];

const EARTHWORK_BUCKETS: Bucket[] = [
  { color: '#8a5a2b', label: 'cut > 6 m' },
  { color: '#c28a55', label: 'cut 2–6 m' },
  { color: '#c9ccd1', label: 'within 2 m' },
  { color: '#6fa8dc', label: 'fill 2–6 m' },
  { color: '#2f6fb0', label: 'fill > 6 m' },
];

/** Slow to fast, blue to red. */
const SPEED_COLORS = ['#3b4cc0', '#5f84ee', '#93b6fb', '#c9d7ef', '#f2c9b3', '#f09a7a', '#dc5d4a', '#b40426'];

const GEAR_COLORS = ['#e5484d', '#f28c3a', '#f2c94e', '#8bd35a', '#34c3a0', '#3fb6ff', '#6f7dfb', '#b48cf7', '#e879c9', '#ffffff', '#aab3bd', '#777777'];

const PEDAL_BUCKETS: Bucket[] = [
  { color: '#22c55e', label: 'full throttle' },
  { color: '#9fe3b4', label: 'part throttle' },
  { color: '#9aa3ad', label: 'coasting' },
  { color: '#fca5a5', label: 'light braking' },
  { color: '#ef4444', label: 'heavy braking' },
];

/** Bucket index per station for the chosen scale; -1 means plain asphalt. */
export function stationBuckets(t: Track, by: ColorBy, source: LapSource): Int8Array {
  const out = new Int8Array(t.n).fill(-1);
  if (by === 'plain') return out;
  const lap = source.lap;
  if (LAP_SCALES.has(by) && !lap) return out;
  let zMin = Infinity;
  let zMax = -Infinity;
  if (by === 'elevation') {
    for (let k = 0; k < t.n; k++) {
      zMin = Math.min(zMin, t.z[k]);
      zMax = Math.max(zMax, t.z[k]);
    }
  }
  for (let k = 0; k < t.n; k++) {
    const i = source.index(k);
    switch (by) {
      case 'speed': out[k] = speedBucket(lap!, lap!.v[i]); break;
      case 'gear': out[k] = Math.min(GEAR_COLORS.length, lap!.gear[i]) - 1; break;
      case 'pedals': {
        const th = lap!.throttle[i];
        const br = lap!.brake[i];
        out[k] = th >= 0.98 ? 0 : th > 0.05 ? 1 : br > 0.5 ? 4 : br > 0 ? 3 : 2;
        break;
      }
      case 'gradient': out[k] = bucketOf(t.gradient[k], GRADIENT_EDGES); break;
      case 'radius': out[k] = bucketOf(1 / Math.max(1e-9, Math.abs(t.curvature[k])), RADIUS_EDGES); break;
      case 'elevation': out[k] = Math.min(ELEVATION_COLORS.length - 1, Math.floor(((t.z[k] - zMin) / Math.max(zMax - zMin, 1e-6)) * ELEVATION_COLORS.length)); break;
      case 'earthworks': {
        const d = t.z[k] - t.terrain[k];
        out[k] = d < -6 ? 0 : d < -2 ? 1 : d <= 2 ? 2 : d <= 6 ? 3 : 4;
        break;
      }
    }
  }
  return out;
}

export function buckets(by: ColorBy, t: Track | null, lap: LapResult | null, gears = 8): Bucket[] {
  switch (by) {
    case 'plain': return [];
    case 'gradient': return GRADIENT_BUCKETS;
    case 'radius': return RADIUS_BUCKETS;
    case 'earthworks': return EARTHWORK_BUCKETS;
    case 'pedals': return lap ? PEDAL_BUCKETS : [];
    case 'gear': return lap ? GEAR_COLORS.slice(0, gears).map((color, i) => ({ color, label: `gear ${i + 1}` })) : [];
    case 'speed': {
      if (!lap) return [];
      const step = (lap.topSpeed - lap.minSpeed) / SPEED_COLORS.length;
      return SPEED_COLORS.map((color, i) => ({ color, label: `${Math.round((lap.minSpeed + i * step) * 3.6)} km/h` }));
    }
    case 'elevation': {
      if (!t) return [];
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < t.n; k++) {
        lo = Math.min(lo, t.z[k]);
        hi = Math.max(hi, t.z[k]);
      }
      const step = (hi - lo) / ELEVATION_COLORS.length;
      return ELEVATION_COLORS.map((color, i) => ({ color, label: `${Math.round(lo + i * step)} m` }));
    }
  }
}

function speedBucket(lap: LapResult, v: number): number {
  const f = (v - lap.minSpeed) / Math.max(1e-6, lap.topSpeed - lap.minSpeed);
  return Math.max(0, Math.min(SPEED_COLORS.length - 1, Math.floor(f * SPEED_COLORS.length)));
}

export function gradientColor(g: number): string {
  return GRADIENT_BUCKETS[bucketOf(g, GRADIENT_EDGES)].color;
}

function bucketOf(v: number, edges: readonly number[]): number {
  let i = 0;
  while (i < edges.length && v >= edges[i]) i++;
  return i;
}
