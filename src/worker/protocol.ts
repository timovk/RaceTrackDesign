import type { Heightmap } from '../core/heightmap.ts';
import type { TerrainImages } from '../core/terrainImage.ts';

export type TerrainWorkerResponse =
  | { id: number; type: 'progress'; value: number }
  | { id: number; type: 'done'; heightmap: Heightmap; images: TerrainImages }
  | { id: number; type: 'error'; message: string };
