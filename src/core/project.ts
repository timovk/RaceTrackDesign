/**
 * The project file: everything needed to reproduce a design exactly. The
 * heightmap itself is never stored; it is regenerated from the seed.
 */
import {
  MAP_SIZES, PRESET_SHAPES, TERRAIN_PRESETS, defaultTerrainSettings,
  type TerrainPreset, type TerrainSettings,
} from './terrain.ts';
import { type ControlPoint, type TrackDesign, DEFAULT_GRADING, DEFAULT_WIDTH, emptyDesign } from './track.ts';
import type { Overrides } from './facilities.ts';
import type { LayoutDesign, LinkDesign } from './layouts.ts';
import { type RaceSettings, parseRaceSettings } from './race/setup.ts';
import { VEHICLES } from './vehicles.ts';

export const PROJECT_VERSION = 1;

export interface Project {
  version: number;
  name: string;
  terrain: TerrainSettings;
  track: TrackDesign;
  /** Start/finish, pit lane and speed trap moved by hand (world positions); anything absent is placed automatically. */
  overrides: Overrides;
  /** Race setup with its own seed, so a saved project reproduces the race; null until a race is set up. */
  race: RaceSettings | null;
  /** Other layouts of the circuit, each the full circuit with links taken, with its own race setup. */
  layouts: LayoutDesign[];
}

export function newProject(seed: string, preset: TerrainPreset = 'rolling'): Project {
  return {
    version: PROJECT_VERSION,
    name: 'Untitled circuit',
    terrain: defaultTerrainSettings(seed, preset),
    track: emptyDesign(),
    overrides: {},
    race: null,
    layouts: [],
  };
}

export function serializeProject(p: Project): string {
  const rounded: Project = {
    ...p,
    track: {
      ...p.track,
      points: p.track.points.map(roundPoint),
    },
    layouts: p.layouts.map((l) => ({
      ...l,
      links: l.links.map((k) => ({ from: roundXY(k.from), to: roundXY(k.to), points: k.points.map(roundPoint) })),
    })),
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
    overrides: parseOverrides(raw.overrides),
    race: parseRaceSettings(raw.race, VEHICLES.map((v) => v.id)),
    layouts: parseLayouts(raw.layouts),
  };
}

/** Layouts with their links; a link without both ends is dropped, a layout without links too. */
function parseLayouts(raw: unknown): LayoutDesign[] {
  if (!Array.isArray(raw)) return [];
  const xy = (v: unknown) => (isObject(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);
  const out: LayoutDesign[] = [];
  raw.forEach((l, i) => {
    if (!isObject(l) || !Array.isArray(l.links)) return;
    const links: LinkDesign[] = [];
    for (const k of l.links) {
      if (!isObject(k)) continue;
      const from = xy(k.from);
      const to = xy(k.to);
      if (!from || !to) continue;
      const points = Array.isArray(k.points)
        ? k.points.filter((p) => isObject(p) && isNum(p.x) && isNum(p.y)).map((p) => ({ x: p.x as number, y: p.y as number, width: isNum(p.width) && p.width > 0 ? p.width : DEFAULT_WIDTH }))
        : [];
      links.push({ from, to, points });
    }
    if (!links.length) return;
    const name = typeof l.name === 'string' && l.name.trim() ? l.name : `Layout ${i + 2}`;
    out.push({ name, links, race: parseRaceSettings(l.race, VEHICLES.map((v) => v.id)) });
  });
  return out;
}

/** Keeps only well-formed overrides; anything else falls back to automatic placement. */
function parseOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!isObject(raw)) return out;
  const point = (v: unknown) => (isObject(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);
  const sf = point(raw.startFinish);
  if (sf) out.startFinish = sf;
  const trap = point(raw.speedTrap);
  if (trap) out.speedTrap = trap;
  if (isObject(raw.pitLane)) {
    const entry = point(raw.pitLane.entry);
    const exit = point(raw.pitLane.exit);
    const side = raw.pitLane.side === -1 ? -1 : raw.pitLane.side === 1 ? 1 : null;
    if (entry && exit && side) out.pitLane = { entry, exit, side };
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundPoint(pt: ControlPoint): ControlPoint {
  return { x: round(pt.x, 2), y: round(pt.y, 2), width: round(pt.width, 2) };
}

function roundXY(p: { x: number; y: number }): { x: number; y: number } {
  return { x: round(p.x, 2), y: round(p.y, 2) };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
