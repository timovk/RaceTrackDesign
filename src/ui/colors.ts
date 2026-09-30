/**
 * Colour scales for painting the track by a station property. Each scale is
 * a short list of buckets so the legend stays readable and the map can draw
 * long runs of equal colour in one stroke.
 */
import type { Track } from '../core/track.ts';

export type ColorBy = 'plain' | 'gradient' | 'radius' | 'elevation' | 'earthworks';

export const COLOR_BY_LABELS: Record<ColorBy, string> = {
  plain: 'Plain',
  gradient: 'Gradient',
  radius: 'Corner radius',
  elevation: 'Elevation',
  earthworks: 'Cut and fill',
};

export interface Bucket {
  color: string;
  label: string;
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

/** Bucket index per station for the chosen scale; -1 means plain asphalt. */
export function stationBuckets(t: Track, by: ColorBy): Int8Array {
  const out = new Int8Array(t.n).fill(-1);
  if (by === 'plain') return out;
  let zMin = Infinity;
  let zMax = -Infinity;
  if (by === 'elevation') {
    for (let k = 0; k < t.n; k++) {
      zMin = Math.min(zMin, t.z[k]);
      zMax = Math.max(zMax, t.z[k]);
    }
  }
  for (let k = 0; k < t.n; k++) {
    switch (by) {
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

export function buckets(by: ColorBy, t: Track | null): Bucket[] {
  switch (by) {
    case 'plain': return [];
    case 'gradient': return GRADIENT_BUCKETS;
    case 'radius': return RADIUS_BUCKETS;
    case 'earthworks': return EARTHWORK_BUCKETS;
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

export function gradientColor(g: number): string {
  return GRADIENT_BUCKETS[bucketOf(g, GRADIENT_EDGES)].color;
}

function bucketOf(v: number, edges: readonly number[]): number {
  let i = 0;
  while (i < edges.length && v >= edges[i]) i++;
  return i;
}
