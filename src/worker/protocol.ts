import type { Heightmap } from '../core/heightmap.ts';
import type { Performance } from '../core/performance.ts';
import type { TerrainImages } from '../core/terrainImage.ts';
import type { Track } from '../core/track.ts';
import type { VehicleClass } from '../core/vehicles.ts';

export type TerrainWorkerResponse =
  | { id: number; type: 'progress'; value: number }
  | { id: number; type: 'done'; heightmap: Heightmap; images: TerrainImages }
  | { id: number; type: 'error'; message: string };

export interface PerformanceRequest {
  id: number;
  track: Track;
  vehicles: readonly VehicleClass[];
}

export type PerformanceResponse =
  | { id: number; type: 'done'; performance: Performance }
  | { id: number; type: 'error'; message: string };
