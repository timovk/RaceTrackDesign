/**
 * Seeded 2D simplex noise (after Stefan Gustavson's reference implementation).
 * Only arithmetic and Math.floor/Math.sqrt are used, so results are
 * bit-identical across JavaScript engines.
 */

export type Noise2D = (x: number, y: number) => number;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// Twelve gradient directions (the 2D projections of the 3D simplex gradients).
const GRAD_X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GRAD_Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];

/** Builds a simplex noise function from a random source. Output is roughly in [-1, 1]. */
export function createNoise2D(random: () => number): Noise2D {
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  const gx = new Float64Array(512);
  const gy = new Float64Array(512);
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    p[i] = perm[i & 255];
    const g = p[i] % 12;
    gx[i] = GRAD_X[g];
    gy[i] = GRAD_Y[g];
  }

  return (x: number, y: number): number => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = ii + p[jj];
      t0 *= t0;
      n += t0 * t0 * (gx[g] * x0 + gy[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = ii + i1 + p[jj + j1];
      t1 *= t1;
      n += t1 * t1 * (gx[g] * x1 + gy[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = ii + 1 + p[jj + 1];
      t2 *= t2;
      n += t2 * t2 * (gx[g] * x2 + gy[g] * y2);
    }
    return 70 * n;
  };
}

/** Fractal Brownian motion: `octaves` layers of noise, each at double frequency. Roughly in [-1, 1]. */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, persistence: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(fx, fy);
    norm += amp;
    amp *= persistence;
    // Rotate each octave slightly so grid artefacts do not line up.
    const rx = 1.6 * fx - 1.2 * fy;
    const ry = 1.2 * fx + 1.6 * fy;
    fx = rx + 17.13;
    fy = ry - 9.71;
  }
  return sum / norm;
}

/** Ridged multifractal noise in [0, 1]: sharp crests and smooth valleys, for mountain ranges. */
export function ridged(noise: Noise2D, x: number, y: number, octaves: number, persistence: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    let v = 1 - Math.abs(noise(fx, fy));
    v *= v;
    v *= weight;
    weight = Math.min(1, v * 2);
    sum += amp * v;
    norm += amp;
    amp *= persistence;
    const rx = 1.6 * fx - 1.2 * fy;
    const ry = 1.2 * fx + 1.6 * fy;
    fx = rx + 31.7;
    fy = ry + 5.3;
  }
  return sum / norm;
}
