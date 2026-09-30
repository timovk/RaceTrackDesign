// Times terrain generation per preset: `node scripts/bench-terrain.ts [seed]`.
import { TERRAIN_PRESETS, defaultTerrainSettings, generateHeightmap } from '../src/core/terrain.ts';

const argv = (globalThis as { process?: { argv: string[] } }).process?.argv ?? [];
const seed = argv[2] ?? '12345';
for (const preset of TERRAIN_PRESETS) {
  const settings = defaultTerrainSettings(seed, preset);
  const start = performance.now();
  let erosionStart = 0;
  const hm = generateHeightmap(settings, (f) => {
    if (f >= 0.7 && !erosionStart) erosionStart = performance.now();
  });
  const end = performance.now();
  const noiseMs = (erosionStart || end) - start;
  console.log(
    `${preset.padEnd(12)} total ${(end - start).toFixed(0).padStart(5)} ms  noise ${noiseMs.toFixed(0).padStart(5)} ms  ` +
      `elevation ${hm.min.toFixed(0)}-${hm.max.toFixed(0)} m  water ${hm.waterLevel.toFixed(1)} m`,
  );
}
