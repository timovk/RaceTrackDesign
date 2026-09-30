/**
 * Droplet-based hydraulic erosion (after Hans Theobald Beyer's thesis and
 * Sebastian Lague's implementation). Each droplet runs downhill, picks up
 * sediment where it speeds up and drops it where it slows down, which carves
 * gullies and fills valley floors.
 *
 * The map is expected to hold normalised heights (roughly 0..1) on a grid of a
 * few hundred cells; the default parameters are tuned for that scale.
 */

export interface ErosionParams {
  droplets: number;
  /** How much a droplet keeps its direction instead of following the slope (0..1). */
  inertia: number;
  /** Sediment a droplet can carry per unit of speed, water and drop. */
  capacity: number;
  minCapacity: number;
  /** Fraction of surplus sediment dropped per step. */
  deposit: number;
  /** Fraction of spare capacity filled by erosion per step. */
  erode: number;
  /** Fraction of water lost per step. */
  evaporate: number;
  gravity: number;
  /** Maximum steps per droplet. */
  lifetime: number;
  /** Radius in cells over which erosion is spread. */
  radius: number;
}

export const DEFAULT_EROSION: Omit<ErosionParams, 'droplets'> = {
  inertia: 0.05,
  capacity: 4,
  minCapacity: 0.01,
  deposit: 0.3,
  erode: 0.3,
  evaporate: 0.01,
  gravity: 4,
  lifetime: 30,
  radius: 3,
};

/** Erodes `map` (n × n, row-major) in place. */
export function erode(
  map: Float32Array,
  n: number,
  random: () => number,
  params: ErosionParams,
  onProgress?: (fraction: number) => void,
): void {
  const { inertia, capacity, minCapacity, deposit, erode: erodeRate, evaporate, gravity, lifetime, radius } = params;

  // Brush: cells within `radius` of the node, weighted by distance and normalised to sum 1.
  const offsets: number[] = [];
  const weights: number[] = [];
  let weightSum = 0;
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < radius) {
        offsets.push(dy * n + dx);
        weights.push(radius - dist);
        weightSum += radius - dist;
      }
    }
  }
  const brushIdx = Int32Array.from(offsets);
  const brushW = Float64Array.from(weights, (w) => w / weightSum);

  const margin = r + 1;
  const span = n - 1 - 2 * margin;
  const reportEvery = Math.max(1, Math.floor(params.droplets / 20));

  for (let d = 0; d < params.droplets; d++) {
    let x = margin + random() * span;
    let y = margin + random() * span;
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let life = 0; life < lifetime; life++) {
      const nx = Math.floor(x);
      const ny = Math.floor(y);
      const fx = x - nx;
      const fy = y - ny;
      const idx = ny * n + nx;
      const hNW = map[idx];
      const hNE = map[idx + 1];
      const hSW = map[idx + n];
      const hSE = map[idx + n + 1];
      const gradX = (hNE - hNW) * (1 - fy) + (hSE - hSW) * fy;
      const gradY = (hSW - hNW) * (1 - fx) + (hSE - hNE) * fx;
      const height = hNW * (1 - fx) * (1 - fy) + hNE * fx * (1 - fy) + hSW * (1 - fx) * fy + hSE * fx * fy;

      dirX = dirX * inertia - gradX * (1 - inertia);
      dirY = dirY * inertia - gradY * (1 - inertia);
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len < 1e-12) break;
      dirX /= len;
      dirY /= len;
      x += dirX;
      y += dirY;
      if (x < margin || y < margin || x >= n - 1 - margin || y >= n - 1 - margin) break;

      const mx = Math.floor(x);
      const my = Math.floor(y);
      const mfx = x - mx;
      const mfy = y - my;
      const m = my * n + mx;
      const newHeight =
        map[m] * (1 - mfx) * (1 - mfy) + map[m + 1] * mfx * (1 - mfy) + map[m + n] * (1 - mfx) * mfy + map[m + n + 1] * mfx * mfy;
      const dh = newHeight - height;

      const cap = Math.max(-dh * speed * water * capacity, minCapacity);
      if (sediment > cap || dh > 0) {
        // Uphill: fill the pit behind the droplet. Otherwise drop a share of the surplus.
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * deposit;
        sediment -= amount;
        map[idx] += amount * (1 - fx) * (1 - fy);
        map[idx + 1] += amount * fx * (1 - fy);
        map[idx + n] += amount * (1 - fx) * fy;
        map[idx + n + 1] += amount * fx * fy;
      } else {
        const amount = Math.min((cap - sediment) * erodeRate, -dh);
        for (let b = 0; b < brushIdx.length; b++) {
          const k = idx + brushIdx[b];
          const w = amount * brushW[b];
          const dz = map[k] < w ? map[k] : w;
          map[k] -= dz;
          sediment += dz;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity));
      water *= 1 - evaporate;
    }

    if (onProgress && d % reportEvery === 0) onProgress(d / params.droplets);
  }
}
