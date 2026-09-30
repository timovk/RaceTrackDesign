/**
 * A square grid of elevations in metres. Sample (i, j) sits at the centre of
 * its cell, at world position ((i + 0.5) * cellSize, (j + 0.5) * cellSize).
 * World coordinates are metres from the top-left corner, x east, y south.
 */
export interface Heightmap {
  /** Samples per side. */
  size: number;
  /** Metres per cell. */
  cellSize: number;
  /** Map width and height in metres (size * cellSize). */
  extent: number;
  /** Elevation in metres above sea level, row-major (index = j * size + i). */
  data: Float32Array;
  min: number;
  max: number;
  /** Elevation of the water surface; -Infinity when the map has no water. */
  waterLevel: number;
}

/** Bilinearly interpolated elevation at a world position; positions off the map clamp to the edge. */
export function sampleHeight(hm: Heightmap, x: number, y: number): number {
  const n = hm.size;
  let gx = x / hm.cellSize - 0.5;
  let gy = y / hm.cellSize - 0.5;
  if (gx < 0) gx = 0;
  else if (gx > n - 1) gx = n - 1;
  if (gy < 0) gy = 0;
  else if (gy > n - 1) gy = n - 1;
  const i0 = Math.min(Math.floor(gx), n - 2);
  const j0 = Math.min(Math.floor(gy), n - 2);
  const fx = gx - i0;
  const fy = gy - j0;
  const k = j0 * n + i0;
  const d = hm.data;
  const top = d[k] * (1 - fx) + d[k + 1] * fx;
  const bottom = d[k + n] * (1 - fx) + d[k + n + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}
