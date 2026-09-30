/**
 * Application state. Holds the project (the only thing saved), the
 * generated terrain, and everything derived from the track. Views subscribe
 * and receive the set of topics that changed, batched per microtask.
 */
import { type TrackMetrics, analyseTrack } from '../core/analysis.ts';
import { type Project, parseProject, serializeProject } from '../core/project.ts';
import { PRESET_SHAPES, type TerrainPreset, type TerrainSettings } from '../core/terrain.ts';
import { type Track, type TrackDesign, buildTrack } from '../core/track.ts';
import { type Issue, validateTrack } from '../core/validate.ts';
import type { Heightmap } from '../core/heightmap.ts';
import type { ColorBy } from './colors.ts';
import { CancelledError, TerrainClient } from './terrainClient.ts';

export type Mode = 'terrain' | 'design' | 'analyse';
export type Tool = 'points' | 'freehand';
export type Topic = 'project' | 'terrain' | 'generating' | 'track' | 'selection' | 'hover' | 'focus' | 'view' | 'mode' | 'history';

export interface TerrainLayer {
  heightmap: Heightmap;
  base: ImageBitmap;
  contours: ImageBitmap;
  contourInterval: number;
}

export interface ViewOptions {
  colorBy: ColorBy;
  contours: boolean;
  labels: boolean;
}

/** A station range to highlight, e.g. a corner or warning picked from a list. */
export interface Focus {
  start: number;
  end: number;
  centre: number;
}

const AUTOSAVE_KEY = 'racetrackdesign.project';
const HISTORY_LIMIT = 200;

export class Store {
  project: Project;
  terrain: TerrainLayer | null = null;
  generating = false;
  progress = 0;
  terrainError: string | null = null;

  track: Track | null = null;
  metrics: TrackMetrics | null = null;
  issues: Issue[] = [];

  mode: Mode = 'terrain';
  tool: Tool = 'points';
  /** Selected control point index. */
  selected: number | null = null;
  /** Hovered station index (from the map, profile or a list). */
  hover: number | null = null;
  focus: Focus | null = null;
  view: ViewOptions = { colorBy: 'plain', contours: true, labels: true };

  private readonly client = new TerrainClient();
  private readonly listeners = new Set<(topics: Set<Topic>) => void>();
  private pending = new Set<Topic>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private editStart: string | null = null;
  private autosaveTimer = 0;

  constructor(project: Project) {
    this.project = project;
  }

  subscribe(fn: (topics: Set<Topic>) => void): void {
    this.listeners.add(fn);
  }

  emit(...topics: Topic[]): void {
    if (topics.includes('project')) this.scheduleAutosave();
    const first = this.pending.size === 0;
    for (const t of topics) this.pending.add(t);
    if (!first) return;
    queueMicrotask(() => {
      const batch = this.pending;
      this.pending = new Set();
      for (const fn of this.listeners) fn(batch);
    });
  }

  // ---- terrain -------------------------------------------------------------

  setTerrain(changes: Partial<TerrainSettings>, regenerate = true): void {
    Object.assign(this.project.terrain, changes);
    this.emit('project');
    if (regenerate) void this.generateTerrain();
  }

  applyPreset(preset: TerrainPreset): void {
    this.setTerrain({ preset, ...PRESET_SHAPES[preset] });
  }

  async generateTerrain(): Promise<void> {
    this.generating = true;
    this.progress = 0;
    this.terrainError = null;
    this.emit('generating');
    try {
      const { heightmap, images } = await this.client.generate({ ...this.project.terrain }, (f) => {
        this.progress = f;
        this.emit('generating');
      });
      const n = heightmap.size;
      const [base, contours] = await Promise.all([
        createImageBitmap(new ImageData(images.base as Uint8ClampedArray<ArrayBuffer>, n, n)),
        createImageBitmap(new ImageData(images.contours as Uint8ClampedArray<ArrayBuffer>, n, n)),
      ]);
      this.terrain?.base.close();
      this.terrain?.contours.close();
      this.terrain = { heightmap, base, contours, contourInterval: images.contourInterval };
      this.generating = false;
      this.progress = 1;
      this.rebuildTrack();
      this.emit('terrain', 'generating');
    } catch (err) {
      if (err instanceof CancelledError) return;
      this.generating = false;
      this.terrainError = err instanceof Error ? err.message : String(err);
      this.emit('generating');
    }
  }

  // ---- track ---------------------------------------------------------------

  get design(): TrackDesign {
    return this.project.track;
  }

  /** Recomputes stations, metrics and warnings from the current design. */
  rebuildTrack(): void {
    const hm = this.terrain?.heightmap;
    this.track = hm ? buildTrack(this.design, hm) : null;
    this.metrics = this.track ? analyseTrack(this.track) : null;
    this.issues = this.track && hm ? validateTrack(this.track, hm, this.design.grading) : [];
    if (this.hover !== null && (!this.track || this.hover >= this.track.n)) this.hover = null;
    if (this.focus && (!this.track || this.focus.centre >= this.track.n)) this.focus = null;
    this.emit('track');
  }

  /** Applies a change to the design; wrap user actions in beginEdit/commitEdit for undo. */
  updateDesign(fn: (d: TrackDesign) => void): void {
    fn(this.design);
    if (this.selected !== null && this.selected >= this.design.points.length) {
      this.selected = this.design.points.length ? this.design.points.length - 1 : null;
      this.emit('selection');
    }
    this.rebuildTrack();
    this.emit('project');
  }

  /** Marks the start of an undoable edit; repeated calls before commit keep the first snapshot. */
  beginEdit(): void {
    if (this.editStart === null) this.editStart = JSON.stringify(this.design);
  }

  commitEdit(): void {
    if (this.editStart === null) return;
    if (this.editStart !== JSON.stringify(this.design)) {
      this.undoStack.push(this.editStart);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.emit('history');
    }
    this.editStart = null;
  }

  /** A complete undoable edit in one call. */
  edit(fn: (d: TrackDesign) => void): void {
    this.beginEdit();
    this.updateDesign(fn);
    this.commitEdit();
  }

  /** Removes a control point and selects the one before it. */
  deletePoint(index: number): void {
    this.edit((d) => d.points.splice(index, 1));
    this.select(this.design.points.length ? Math.max(0, index - 1) : null);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    this.restore(this.undoStack, this.redoStack);
  }

  redo(): void {
    this.restore(this.redoStack, this.undoStack);
  }

  private restore(from: string[], to: string[]): void {
    const snapshot = from.pop();
    if (snapshot === undefined) return;
    this.editStart = null;
    to.push(JSON.stringify(this.design));
    this.project.track = JSON.parse(snapshot) as TrackDesign;
    this.selected = null;
    this.rebuildTrack();
    this.emit('project', 'selection', 'history');
  }

  // ---- selection and view --------------------------------------------------

  select(index: number | null): void {
    if (this.selected === index) return;
    this.selected = index;
    this.emit('selection');
  }

  setHover(station: number | null): void {
    if (this.hover === station) return;
    this.hover = station;
    this.emit('hover');
  }

  setFocus(focus: Focus | null): void {
    this.focus = focus;
    this.emit('focus');
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode !== 'design') this.select(null);
    this.emit('mode');
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit('mode');
  }

  setView(changes: Partial<ViewOptions>): void {
    Object.assign(this.view, changes);
    this.emit('view');
  }

  // ---- project files -------------------------------------------------------

  loadProject(project: Project): void {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.editStart = null;
    this.selected = null;
    this.hover = null;
    this.focus = null;
    this.track = null;
    this.metrics = null;
    this.issues = [];
    this.emit('project', 'track', 'selection', 'history', 'focus', 'hover');
    void this.generateTerrain();
  }

  serialize(): string {
    return serializeProject(this.project);
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, this.serialize());
      } catch {
        // Storage can be unavailable (private window, quota); autosave is only a convenience.
      }
    }, 400);
  }

  static restoreAutosave(): Project | null {
    try {
      const text = localStorage.getItem(AUTOSAVE_KEY);
      return text ? parseProject(text) : null;
    } catch {
      return null;
    }
  }
}
