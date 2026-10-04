/**
 * Surveyed ground: real elevations and woods shipped with the app, for
 * circuits rebuilt from maps. A project names one in `terrain.survey`; its
 * heightmap then comes from the files under public/surveys instead of the
 * seed. The list is in data/surveys.json.
 *
 * Heights are kept as whole steps above a base, each written as its
 * difference from a plane through its left, upper and upper-left neighbours:
 * real ground is smooth, so the differences are small and gzip packs them to
 * about a third. The woods are one byte per cell.
 */
import data from '../../data/surveys.json' with { type: 'json' };
import type { Heightmap } from './heightmap.ts';

export interface Survey {
  id: string;
  name: string;
  /** Map width and height in metres. */
  mapSize: number;
  /** Height samples per side. */
  resolution: number;
  /** Metres above sea level of a stored 0, and metres per stored step. */
  base: number;
  step: number;
  /** Elevation of the water surface, or null for a map without water. */
  waterLevel: number | null;
  /** Cells per side of the woods grid. */
  woodsSize: number;
  /** Where the data comes from, as the Terrain panel shows it. */
  source: string;
}

export const SURVEYS: readonly Survey[] = data.surveys;

export function findSurvey(id: unknown): Survey | null {
  return SURVEYS.find((s) => s.id === id) ?? null;
}

/** Reads a file of a survey, e.g. "surveys/bremgarten/height.bin": a fetch in the app, the disk in tests. */
export type ReadFile = (path: string) => Promise<ArrayBuffer>;

export async function loadSurvey(survey: Survey, read: ReadFile, onProgress?: (fraction: number) => void): Promise<Heightmap> {
  const dir = `surveys/${survey.id}`;
  const [height, woods] = await Promise.all([read(`${dir}/height.bin`).then(gunzip), read(`${dir}/woods.bin`).then(gunzip)]);
  onProgress?.(0.6);
  const n = survey.resolution;
  if (height.length !== n * n * 2) throw new Error(`The heights of "${survey.name}" are damaged.`);
  if (woods.length !== survey.woodsSize ** 2) throw new Error(`The woods of "${survey.name}" are damaged.`);
  const values = unpackHeights(height, n, survey.base, survey.step);
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < values.length; k++) {
    const z = values[k];
    if (z < min) min = z;
    if (z > max) max = z;
  }
  onProgress?.(1);
  return {
    size: n, cellSize: survey.mapSize / n, extent: survey.mapSize, data: values, min, max,
    waterLevel: survey.waterLevel ?? -Infinity,
    woods: { size: survey.woodsSize, data: woods },
  };
}

/** Heights as stored: 16-bit little-endian differences from the plane through the three neighbours already written. */
export function packHeights(values: ArrayLike<number>, n: number, base: number, step: number): Uint8Array {
  const q = new Int32Array(n * n);
  for (let k = 0; k < q.length; k++) q[k] = Math.min(65535, Math.max(0, Math.round((values[k] - base) / step)));
  const out = new Uint8Array(n * n * 2);
  for (let j = 0, k = 0; j < n; j++) {
    for (let i = 0; i < n; i++, k++) {
      const d = (q[k] - predict(q, n, i, j, k)) & 0xffff;
      out[2 * k] = d & 255;
      out[2 * k + 1] = d >> 8;
    }
  }
  return out;
}

export function unpackHeights(bytes: Uint8Array, n: number, base: number, step: number): Float32Array {
  const q = new Int32Array(n * n);
  const out = new Float32Array(n * n);
  for (let j = 0, k = 0; j < n; j++) {
    for (let i = 0; i < n; i++, k++) {
      q[k] = (predict(q, n, i, j, k) + (bytes[2 * k] | (bytes[2 * k + 1] << 8))) & 0xffff;
      out[k] = base + q[k] * step;
    }
  }
  return out;
}

function predict(q: Int32Array, n: number, i: number, j: number, k: number): number {
  if (i > 0 && j > 0) return q[k - 1] + q[k - n] - q[k - n - 1];
  if (i > 0) return q[k - 1];
  return j > 0 ? q[k - n] : 0;
}

/** Unpacks gzip data; data a server has already unpacked passes through. */
export async function gunzip(buffer: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
