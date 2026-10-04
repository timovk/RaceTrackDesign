import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sampleHeight } from '../src/core/heightmap.ts';
import { parseProject, serializeProject } from '../src/core/project.ts';
import { forest } from '../src/core/scenery.ts';
import { SURVEYS, findSurvey, gunzip, loadSurvey, packHeights, unpackHeights } from '../src/core/survey.ts';
import { renderTerrain } from '../src/core/terrainImage.ts';
import { makeHeightmap, readPublic } from './helpers.ts';

describe('surveyed ground', () => {
  it('packs heights to the step and back', () => {
    const n = 48;
    const values = Float32Array.from({ length: n * n }, (_, k) => 500 + 20 * Math.sin((k % n) / 7) + 0.3 * Math.floor(k / n) + ((k * 37) % 11) * 0.013);
    const back = unpackHeights(packHeights(values, n, 470, 0.02), n, 470, 0.02);
    for (let k = 0; k < values.length; k++) expect(Math.abs(back[k] - values[k])).toBeLessThanOrEqual(0.0101);
  });

  it('unpacks gzip, and passes on what a server already unpacked', async () => {
    const plain = Uint8Array.from({ length: 5000 }, (_, i) => (i * i) % 251);
    const zipped = gzipSync(plain);
    expect([...await gunzip(zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer)]).toEqual([...plain]);
    expect([...await gunzip(plain.buffer)]).toEqual([...plain]);
  });

  it('reads every survey shipped with the app', async () => {
    for (const survey of SURVEYS) {
      const hm = await loadSurvey(survey, readPublic);
      expect(hm.size).toBe(survey.resolution);
      expect(hm.extent).toBe(survey.mapSize);
      expect(hm.cellSize * hm.size).toBe(hm.extent);
      expect(hm.data.every((z) => Number.isFinite(z))).toBe(true);
      expect(hm.woods?.data.length).toBe(survey.woodsSize ** 2);
    }
  });

  it('has the Bremgartenwald as it lies: a forest plateau 70 m above the Aare', async () => {
    const hm = await loadSurvey(findSurvey('bremgarten')!, readPublic);
    expect(hm.cellSize).toBe(2);
    // The river runs along the north of the map, the forest plateau fills its middle.
    expect(hm.min).toBeLessThan(hm.waterLevel);
    expect(sampleHeight(hm, 2000, 700)).toBeLessThan(hm.waterLevel);
    const plateau = sampleHeight(hm, 2200, 1900);
    expect(plateau).toBeGreaterThan(545);
    expect(plateau).toBeLessThan(560);
    let wooded = 0;
    for (const v of hm.woods!.data) wooded += v;
    const share = wooded / hm.woods!.data.length;
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.55);
  });

  it('is named in the project file, with its own map size', () => {
    const p = parseProject('{"terrain":{"seed":"x","survey":"bremgarten","mapSize":8192,"resolution":1024}}');
    expect(p.terrain.survey).toBe('bremgarten');
    expect(p.terrain.mapSize).toBe(4096);
    expect(p.terrain.resolution).toBe(2048);
    expect(parseProject(serializeProject(p)).terrain).toEqual(p.terrain);
    // A survey this version does not have falls back to the generated terrain.
    expect(parseProject('{"terrain":{"seed":"x","survey":"atlantis"}}').terrain.survey).toBeUndefined();
  });

  it('grows its trees in the woods, with only the odd one outside', () => {
    const hm = makeHeightmap(() => 100, { size: 128, extent: 2048 });
    const size = 64;
    const data = new Uint8Array(size * size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size / 2; i++) data[j * size + i] = 1;
    hm.woods = { size, data };
    const trees = forest(hm, 'seed');
    let inside = 0;
    let outside = 0;
    for (let i = 0; i < trees.length; i += 5) {
      if (trees[i] < 1024) inside++;
      else outside++;
    }
    expect(inside).toBeGreaterThan(15_000);
    expect(outside).toBeLessThan(inside / 40);
    expect([...forest(hm, 'seed').slice(0, 50)]).toEqual([...trees.slice(0, 50)]);
  });

  it('shows its woods on the map', () => {
    const hm = makeHeightmap(() => 100, { size: 64, extent: 1024 });
    const data = new Uint8Array(16 * 16);
    data[0] = 1;
    hm.woods = { size: 16, data };
    const { base } = renderTerrain(hm);
    const green = (i: number, j: number) => base[(j * 64 + i) * 4 + 1];
    // The woods cell covers the first four pixels each way; open ground is lighter.
    expect(green(1, 1)).toBeLessThan(green(10, 10) - 20);
    expect(green(10, 1)).toBe(green(10, 10));
  });
});
