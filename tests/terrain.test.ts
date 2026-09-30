import { describe, expect, it } from 'vitest';
import { sampleHeight } from '../src/core/heightmap.ts';
import { createNoise2D } from '../src/core/noise.ts';
import { hashSeed, seededRandom } from '../src/core/rng.ts';
import { defaultTerrainSettings, generateHeightmap, type TerrainSettings } from '../src/core/terrain.ts';
import { contourInterval, renderTerrain } from '../src/core/terrainImage.ts';
import { makeHeightmap } from './helpers.ts';

const small = (seed: string, overrides: Partial<TerrainSettings> = {}): TerrainSettings => ({
  ...defaultTerrainSettings(seed, 'hilly'),
  resolution: 256,
  ...overrides,
});

describe('seeded randomness', () => {
  it('hashes seeds stably and spreads them', () => {
    expect(hashSeed('482913')).toBe(hashSeed('482913'));
    expect(hashSeed('482913')).not.toBe(hashSeed('482914'));
  });

  it('produces the same stream for the same seed', () => {
    const a = seededRandom('abc');
    const b = seededRandom('abc');
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('stays inside [0, 1)', () => {
    const r = seededRandom('range');
    for (let i = 0; i < 10000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('simplex noise', () => {
  it('is deterministic per seed and roughly within [-1, 1]', () => {
    const a = createNoise2D(seededRandom('n'));
    const b = createNoise2D(seededRandom('n'));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.137;
      const y = i * 0.071;
      const v = a(x, y);
      expect(v).toBe(b(x, y));
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(-1.01);
    expect(hi).toBeLessThan(1.01);
    expect(hi - lo).toBeGreaterThan(1);
  });
});

describe('terrain generation', () => {
  it('gives identical maps for identical settings', () => {
    const a = generateHeightmap(small('777'));
    const b = generateHeightmap(small('777'));
    expect(a.data).toEqual(b.data);
    expect(a.waterLevel).toBe(b.waterLevel);
  });

  it('gives different maps for different seeds', () => {
    const a = generateHeightmap(small('777'));
    const b = generateHeightmap(small('778'));
    let diff = 0;
    for (let k = 0; k < a.data.length; k++) diff += Math.abs(a.data[k] - b.data[k]);
    expect(diff / a.data.length).toBeGreaterThan(5);
  });

  it('spans roughly the requested relief above the base elevation', () => {
    const s = small('relief', { relief: 300, baseElevation: 200 });
    const hm = generateHeightmap(s);
    expect(hm.min).toBeGreaterThanOrEqual(199);
    expect(hm.max - hm.min).toBeGreaterThan(0.6 * 300);
    expect(hm.max - hm.min).toBeLessThan(1.15 * 300);
    expect(hm.extent).toBe(s.mapSize);
    expect(hm.cellSize).toBeCloseTo(s.mapSize / 256);
  });

  it('floods about the requested share of the map', () => {
    const hm = generateHeightmap(small('wet', { water: 0.2 }));
    let under = 0;
    for (let k = 0; k < hm.data.length; k++) if (hm.data[k] < hm.waterLevel) under++;
    expect(under / hm.data.length).toBeGreaterThan(0.17);
    expect(under / hm.data.length).toBeLessThan(0.23);
  });

  it('has no water when the water share is zero', () => {
    const hm = generateHeightmap(small('dry', { water: 0 }));
    expect(hm.waterLevel).toBe(-Infinity);
  });

  it('reports progress up to completion', () => {
    const seen: number[] = [];
    generateHeightmap(small('p'), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(5);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe('heightmap sampling', () => {
  it('interpolates a tilted plane exactly', () => {
    const hm = makeHeightmap((x, y) => 0.01 * x + 0.02 * y, { size: 64, extent: 6400 });
    expect(sampleHeight(hm, 1234, 2345)).toBeCloseTo(0.01 * 1234 + 0.02 * 2345, 3);
  });

  it('clamps outside the map', () => {
    const hm = makeHeightmap((x) => x, { size: 64, extent: 6400 });
    expect(sampleHeight(hm, -500, 100)).toBeCloseTo(50, 3);
  });
});

describe('terrain rendering', () => {
  it('picks readable contour intervals', () => {
    expect(contourInterval(18)).toBe(1);
    expect(contourInterval(75)).toBe(5);
    expect(contourInterval(700)).toBe(50);
  });

  it('draws opaque base pixels and water in blue', () => {
    const hm = makeHeightmap((x) => x / 10, { size: 64, extent: 6400, waterLevel: 100 });
    const img = renderTerrain(hm);
    expect(img.base.length).toBe(64 * 64 * 4);
    // Left edge is below the water level: blue dominates.
    expect(img.base[2]).toBeGreaterThan(img.base[0]);
    for (let k = 3; k < img.base.length; k += 4) expect(img.base[k]).toBe(255);
    // Contours exist on the land part and never on water.
    let contourPixels = 0;
    for (let k = 0; k < 64 * 64; k++) {
      if (img.contours[k * 4 + 3] > 0) {
        contourPixels++;
        expect(hm.data[k]).toBeGreaterThanOrEqual(100);
      }
    }
    expect(contourPixels).toBeGreaterThan(0);
  });
});
