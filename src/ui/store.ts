/**
 * Application state. Holds the project (the only thing saved), the
 * generated terrain, and everything derived from the track. Views subscribe
 * and receive the set of topics that changed, batched per microtask.
 */
import { type TrackMetrics, analyseTrack } from '../core/analysis.ts';
import type { Facilities, Overrides } from '../core/facilities.ts';
import type { LapResult } from '../core/lapSim.ts';
import type { Licence } from '../core/licence.ts';
import type { Performance } from '../core/performance.ts';
import { type Project, parseProject, serializeProject } from '../core/project.ts';
import { type StartFinish, placeStartFinish, rotateTrack } from '../core/startFinish.ts';
import type { Analysis } from '../worker/protocol.ts';
import { PRESET_SHAPES, type TerrainPreset, type TerrainSettings } from '../core/terrain.ts';
import { type Track, type TrackDesign, buildTrack, heightmapSampler } from '../core/track.ts';
import { type Issue, validateTrack } from '../core/validate.ts';
import { VEHICLES, type VehicleClass } from '../core/vehicles.ts';
import type { Heightmap } from '../core/heightmap.ts';
import { raceRules } from '../core/race/rules.ts';
import { type RaceSettings, defaultRaceSettings } from '../core/race/setup.ts';
import { randomSeedString } from '../core/rng.ts';
import type { ColorBy } from './colors.ts';
import { PerformanceClient } from './performanceClient.ts';
import { CancelledError, TerrainClient } from './terrainClient.ts';

export type Mode = 'terrain' | 'design' | 'analyse' | 'race';
export type Tool = 'points' | 'freehand';
export type Topic =
  | 'project' | 'terrain' | 'generating' | 'track' | 'performance' | 'vehicle'
  | 'selection' | 'hover' | 'focus' | 'view' | 'mode' | 'history' | 'race';

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
  /** Draw the racing line on the track. */
  line: boolean;
  /** Draw the pit lane, grid, DRS zones, marshal posts and so on. */
  facilities: boolean;
  /** Licence grade whose run-off escape paths are drawn, or null for none. */
  runoffGrade: string | null;
}

/** A station range to highlight, e.g. a corner or warning picked from a list. */
export interface Focus {
  start: number;
  end: number;
  centre: number;
}

const AUTOSAVE_KEY = 'racetrackdesign.project';
const HISTORY_LIMIT = 200;
/** Lap times wait this long after the last edit, so dragging a point stays smooth. */
const PERFORMANCE_DELAY = 150;

export class Store {
  project: Project;
  terrain: TerrainLayer | null = null;
  generating = false;
  progress = 0;
  terrainError: string | null = null;

  /** The track with its start line at station 0. */
  track: Track | null = null;
  startFinish: StartFinish | null = null;
  metrics: TrackMetrics | null = null;
  issues: Issue[] = [];

  readonly vehicles: readonly VehicleClass[] = VEHICLES;
  /** Racing line, laps and sectors; may briefly belong to the previous version of the track while it recalculates. */
  performance: Performance | null = null;
  facilities: Facilities | null = null;
  licence: Licence | null = null;
  performancePending = false;
  /** Class shown on the map, in the speed trace and in the detail card. */
  vehicleId = 'f1';

  mode: Mode = 'terrain';
  tool: Tool = 'points';
  /** Selected control point index. */
  selected: number | null = null;
  /** Hovered station index (from the map, profile or a list). */
  hover: number | null = null;
  focus: Focus | null = null;
  view: ViewOptions = { colorBy: 'plain', contours: true, labels: true, line: false, facilities: true, runoffGrade: null };

  private readonly client = new TerrainClient();
  private readonly performanceClient = new PerformanceClient((a, e) => this.receiveAnalysis(a, e));
  private readonly listeners = new Set<(topics: Set<Topic>) => void>();
  private pending = new Set<Topic>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private editStart: string | null = null;
  private autosaveTimer = 0;
  private performanceTimer = 0;
  /** Seed for the default race until one is saved in the project. */
  private readonly raceSeed = randomSeedString();

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

  /**
   * Recomputes stations, the start line, metrics and warnings from the
   * current design. The track is rotated so the start line is station 0.
   */
  rebuildTrack(): void {
    const hm = this.terrain?.heightmap;
    const raw = hm ? buildTrack(this.design, heightmapSampler(hm)) : null;
    this.startFinish = raw ? placeStartFinish(raw, this.project.overrides.startFinish) : null;
    this.track = raw && this.startFinish ? rotateTrack(raw, this.startFinish.station) : null;
    this.metrics = this.track ? analyseTrack(this.track) : null;
    this.issues = this.track && hm ? validateTrack(this.track, hm, this.design.grading) : [];
    if (this.hover !== null && (!this.track || this.hover >= this.track.n)) this.hover = null;
    if (this.focus && (!this.track || this.focus.centre >= this.track.n)) this.focus = null;
    this.emit('track');
    this.schedulePerformance();
  }

  /** Recomputes lap times, facilities and the licence in a worker shortly after the track stops changing. */
  private schedulePerformance(): void {
    clearTimeout(this.performanceTimer);
    if (!this.track) {
      this.performanceClient.cancel();
      this.performance = null;
      this.facilities = null;
      this.licence = null;
      this.performancePending = false;
      this.emit('performance');
      return;
    }
    this.performancePending = true;
    this.emit('performance');
    this.performanceTimer = window.setTimeout(() => {
      const hm = this.terrain?.heightmap;
      if (!this.track || !this.metrics || !this.startFinish || !hm) return;
      this.performanceClient.request({
        track: this.track, metrics: this.metrics, issues: this.issues, startFinish: this.startFinish,
        overrides: this.project.overrides, vehicles: this.vehicles,
      }, hm);
    }, PERFORMANCE_DELAY);
  }

  private receiveAnalysis(analysis: Analysis | null, error: string | null): void {
    if (error) console.error('Lap-time analysis failed:', error);
    this.performance = analysis?.performance ?? null;
    this.facilities = analysis?.facilities ?? null;
    this.licence = analysis?.licence ?? null;
    this.performancePending = false;
    this.emit('performance');
  }

  /** Moves a facility by hand (undoable), or back to automatic placement with `null`. */
  setOverride<K extends keyof Overrides>(key: K, value: Overrides[K] | null): void {
    this.beginEdit();
    if (value === null) delete this.project.overrides[key];
    else this.project.overrides[key] = value;
    this.rebuildTrack();
    this.emit('project');
    this.commitEdit();
  }

  get vehicle(): VehicleClass {
    return this.vehicles.find((v) => v.id === this.vehicleId) ?? this.vehicles[0];
  }

  /** The selected class's lap, if lap times are available. */
  get lap(): LapResult | null {
    return this.performance?.laps.find((l) => l.vehicleId === this.vehicleId) ?? null;
  }

  /**
   * Index into the lap arrays for a track station. While the lap still belongs
   * to the previous version of the track, stations map by their share of the lap.
   */
  lapIndex(station: number): number {
    const perf = this.performance;
    const t = this.track;
    if (!perf || !t || perf.line.n === t.n) return station;
    return Math.min(perf.line.n - 1, Math.round((station * perf.line.n) / t.n));
  }

  /** True when the lap arrays line up with the current track's stations. */
  get performanceCurrent(): boolean {
    return !!this.performance && !!this.track && this.performance.line.n === this.track.n && !this.performancePending;
  }

  selectVehicle(id: string): void {
    if (this.vehicleId === id) return;
    this.vehicleId = id;
    this.emit('vehicle');
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

  /** What undo restores: the design and the hand-placed facilities. */
  private snapshot(): string {
    return JSON.stringify({ track: this.design, overrides: this.project.overrides });
  }

  /** Marks the start of an undoable edit; repeated calls before commit keep the first snapshot. */
  beginEdit(): void {
    if (this.editStart === null) this.editStart = this.snapshot();
  }

  commitEdit(): void {
    if (this.editStart === null) return;
    if (this.editStart !== this.snapshot()) {
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
    to.push(this.snapshot());
    const state = JSON.parse(snapshot) as { track: TrackDesign; overrides: Overrides };
    this.project.track = state.track;
    this.project.overrides = state.overrides;
    this.selected = null;
    this.rebuildTrack();
    this.emit('project', 'selection', 'history');
  }

  // ---- race setup ------------------------------------------------------------

  /** The saved race settings, or the default race for Formula 1 on this track. */
  get raceSettings(): RaceSettings {
    return this.project.race ?? this.defaultRace(this.vehicles[0].id, this.raceSeed);
  }

  /** The class's usual race on the current track (length from its lap time here, when known). */
  defaultRace(vehicleId: string, seed: string): RaceSettings {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId) ?? this.vehicles[0];
    const lap = this.performance?.laps.find((l) => l.vehicleId === vehicle.id);
    const length = this.performance?.line.length ?? this.track?.length ?? 5000;
    return defaultRaceSettings(vehicle, raceRules(vehicle), length, lap?.time ?? length / 45, seed);
  }

  setRaceSettings(changes: Partial<RaceSettings>): void {
    this.project.race = { ...this.raceSettings, ...changes };
    this.emit('project', 'race');
  }

  /** Switches the race to another class with that class's usual grid and length, keeping the seed and grid order. */
  setRaceClass(vehicleId: string): void {
    const cur = this.raceSettings;
    this.project.race = { ...this.defaultRace(vehicleId, cur.seed), grid: cur.grid };
    this.emit('project', 'race');
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
    this.startFinish = null;
    this.metrics = null;
    this.issues = [];
    clearTimeout(this.performanceTimer);
    this.performanceClient.cancel();
    this.performance = null;
    this.facilities = null;
    this.licence = null;
    this.performancePending = false;
    this.emit('project', 'track', 'performance', 'selection', 'history', 'focus', 'hover');
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
