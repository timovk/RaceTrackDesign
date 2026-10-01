import type { TrackMetrics } from '../core/analysis.ts';
import type { Facilities, Overrides } from '../core/facilities.ts';
import type { Heightmap } from '../core/heightmap.ts';
import type { Licence } from '../core/licence.ts';
import type { PitLane } from '../core/pitLane.ts';
import type { Performance } from '../core/performance.ts';
import type { StartFinish } from '../core/startFinish.ts';
import type { TerrainImages } from '../core/terrainImage.ts';
import type { Track } from '../core/track.ts';
import type { Issue } from '../core/validate.ts';
import type { VehicleClass } from '../core/vehicles.ts';

export type TerrainWorkerResponse =
  | { id: number; type: 'progress'; value: number }
  | { id: number; type: 'done'; heightmap: Heightmap; images: TerrainImages }
  | { id: number; type: 'error'; message: string };

export interface PerformanceRequest {
  id: number;
  track: Track;
  metrics: TrackMetrics;
  issues: Issue[];
  startFinish: StartFinish;
  overrides: Overrides;
  /** A layout's pit lane (the full circuit's), or null for none; absent for the full circuit, whose pit lane is placed. */
  pitLane?: PitLane | null;
  vehicles: readonly VehicleClass[];
  /** The heightmap is sent only when it changed; the worker keeps the last one by id. */
  terrainId: number;
  heightmap?: Heightmap;
}

export interface Analysis {
  performance: Performance;
  facilities: Facilities;
  licence: Licence;
}

export type PerformanceResponse =
  | ({ id: number; type: 'done' } & Analysis)
  | { id: number; type: 'error'; message: string };
