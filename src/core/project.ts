/**
 * The project file: everything needed to reproduce a design exactly. The
 * heightmap itself is never stored; it is regenerated from the seed.
 */
import {
  MAP_SIZES, PRESET_SHAPES, TERRAIN_PRESETS, defaultTerrainSettings,
  type TerrainPreset, type TerrainSettings,
} from './terrain.ts';
import { type ControlPoint, type TrackDesign, DEFAULT_GRADING, DEFAULT_WIDTH, emptyDesign } from './track.ts';

export const PROJECT_VERSION = 1;

export interface Project {
  version: number;
  name: string;
  terrain: TerrainSettings;
  track: TrackDesign;
  /** Manual placements that override the automatic ones (start/finish, pit lane); filled from milestone 3. */
  overrides: Record<string, unknown>;
  /** Race setup, including its own seed; filled from milestone 4. */
  race: Record<string, unknown> | null;
}

export function newProject(seed: string, preset: TerrainPreset = 'rolling'): Project {
  return {
    version: PROJECT_VERSION,
    name: 'Untitled circuit',
    terrain: defaultTerrainSettings(seed, preset),
    track: emptyDesign(),
    overrides: {},
    race: null,
  };
}

export function serializeProject(p: Project): string {
  const rounded: Project = {
    ...p,
    track: {
      ...p.track,
      points: p.track.points.map((pt) => ({ x: round(pt.x, 2), y: round(pt.y, 2), width: round(pt.width, 2) })),
    },
  };
  return JSON.stringify(rounded, null, 2);
}

/** Parses and checks a project file, filling in defaults for anything missing. Throws on invalid input. */
export function parseProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid project file (JSON could not be read).');
  }
  if (!isObject(raw)) throw new Error('Not a valid project file.');
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > PROJECT_VERSION) throw new Error(`This project was saved by a newer version (file version ${version}).`);

  const t = isObject(raw.terrain) ? raw.terrain : {};
  const preset: TerrainPreset = TERRAIN_PRESETS.includes(t.preset as TerrainPreset) ? (t.preset as TerrainPreset) : 'rolling';
  const seed = typeof t.seed === 'string' || typeof t.seed === 'number' ? String(t.seed) : '1';
  const defaults = defaultTerrainSettings(seed, preset);
  const shape = PRESET_SHAPES[preset];
  const terrain: TerrainSettings = {
    ...defaults,
    mapSize: MAP_SIZES.includes(t.mapSize as number) ? (t.mapSize as number) : defaults.mapSize,
    resolution: t.resolution === 1024 || t.resolution === 2048 ? t.resolution : defaults.resolution,
  };
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    const v = t[key];
    if (typeof v === 'number' && Number.isFinite(v)) terrain[key] = v;
  }

  const tr = isObject(raw.track) ? raw.track : {};
  const points: ControlPoint[] = [];
  if (Array.isArray(tr.points)) {
    for (const p of tr.points) {
      if (!isObject(p) || !isNum(p.x) || !isNum(p.y)) throw new Error('A track point is missing its coordinates.');
      points.push({ x: p.x, y: p.y, width: isNum(p.width) && p.width > 0 ? p.width : DEFAULT_WIDTH });
    }
  }
  const g = isObject(tr.grading) ? tr.grading : {};
  const track: TrackDesign = {
    points,
    defaultWidth: isNum(tr.defaultWidth) && tr.defaultWidth > 0 ? tr.defaultWidth : DEFAULT_WIDTH,
    grading: {
      smoothing: isNum(g.smoothing) && g.smoothing >= 0 ? g.smoothing : DEFAULT_GRADING.smoothing,
      maxCutFill: isNum(g.maxCutFill) && g.maxCutFill >= 0 ? g.maxCutFill : DEFAULT_GRADING.maxCutFill,
    },
  };

  return {
    version: PROJECT_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled circuit',
    terrain,
    track,
    overrides: isObject(raw.overrides) ? raw.overrides : {},
    race: isObject(raw.race) ? raw.race : null,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
