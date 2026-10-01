/**
 * Application state. Holds the project (the only thing saved), the
 * generated terrain, and everything derived from the track. Views subscribe
 * and receive the set of topics that changed, batched per microtask.
 *
 * The full circuit is what Design mode edits. The project's other layouts
 * are built from it; Analyse and Race show the layout picked (`track` and
 * everything derived from it belong to that layout). A layout shares the
 * full circuit's start line and pit lane, so the full circuit is analysed
 * first; analyses are kept per layout until the design changes.
 */
import { type TrackMetrics, analyseTrack } from '../core/analysis.ts';
import type { Facilities, Overrides } from '../core/facilities.ts';
import type { Vec2 } from '../core/geometry.ts';
import type { PitLane } from '../core/pitLane.ts';
import { type LayoutBuild, type LayoutDesign, type LinkDesign, buildLayout, layoutPitLane, layoutStation } from '../core/layouts.ts';
import type { LapResult } from '../core/lapSim.ts';
import type { Licence } from '../core/licence.ts';
import type { Performance } from '../core/performance.ts';
import { type Project, parseProject, serializeProject } from '../core/project.ts';
import { type StartFinish, placeStartFinish, rotateTrack } from '../core/startFinish.ts';
import type { Analysis } from '../worker/protocol.ts';
import { PRESET_SHAPES, type TerrainPreset, type TerrainSettings } from '../core/terrain.ts';
import { type ControlPoint, type HeightSampler, type Track, type TrackDesign, buildTrack, heightmapSampler } from '../core/track.ts';
import { type Issue, validateTrack } from '../core/validate.ts';
import { VEHICLES, type VehicleClass } from '../core/vehicles.ts';
import type { Heightmap } from '../core/heightmap.ts';
import { raceRules } from '../core/race/rules.ts';
import { MAX_CARS, MAX_CLASSES, type RaceSettings, defaultRaceSettings, totalCars } from '../core/race/setup.ts';
import { randomSeedString } from '../core/rng.ts';
import type { ColorBy } from './colors.ts';
import { PerformanceClient } from './performanceClient.ts';
import { CancelledError, TerrainClient } from './terrainClient.ts';

export type Mode = 'terrain' | 'design' | 'analyse' | 'race';
export type Tool = 'points' | 'freehand' | 'link';
export type Topic =
  | 'project' | 'terrain' | 'generating' | 'track' | 'performance' | 'vehicle'
  | 'selection' | 'hover' | 'focus' | 'view' | 'mode' | 'history' | 'race' | 'layout';

/** A track as built with what is derived from it at once: its start line, metrics and warnings. */
export interface BuiltTrack {
  track: Track;
  startFinish: StartFinish;
  metrics: TrackMetrics;
  issues: Issue[];
}

/** One of the project's layouts as built from the full circuit. */
export interface LayoutState {
  build: LayoutBuild;
  /** Null when the layout cannot be built (see build.errors). */
  built: BuiltTrack | null;
}

/** A link being drawn: where it leaves the track, its points so far, and the layout it is for (null: a new layout). */
export interface LinkDraft {
  from: Vec2;
  points: ControlPoint[];
  layout: number | null;
}

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
  /** The flat map or the 3D view. */
  dimension: '2d' | '3d';
  /** Vertical exaggeration in the 3D view. */
  relief: number;
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

/**
 * A position to the centimetre, as the project file keeps it: a link drawn
 * and the same link loaded from the file give the same track to the bit (the
 * racing line can answer a sub-millimetre change with a different line).
 */
function centimetres(p: Vec2): Vec2 {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

export class Store {
  project: Project;
  terrain: TerrainLayer | null = null;
  generating = false;
  progress = 0;
  terrainError: string | null = null;

  /** The track shown, with its start line at station 0: the full circuit, or the layout picked in Analyse and Race. */
  track: Track | null = null;
  /** The full circuit, start line at station 0: what Design edits and every layout is built from. */
  fullTrack: Track | null = null;
  /** The project's layouts as built (index i is layout i + 1). */
  layoutStates: LayoutState[] = [];
  /** The layout picked: 0 the full circuit, i the project's layout i - 1. */
  layout = 0;
  /** A link being drawn with the Link tool. */
  linkDraft: LinkDraft | null = null;
  /** The layout the Link tool adds a link to (null: a new layout). */
  linkTarget: number | null = null;
  /** Selected link point: the layout (1-based), the link and the point. */
  linkSelected: { layout: number; link: number; point: number } | null = null;
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
  view: ViewOptions = { colorBy: 'plain', contours: true, labels: true, line: false, facilities: true, runoffGrade: null, dimension: '2d', relief: 3 };

  private readonly client = new TerrainClient();
  private readonly performanceClient = new PerformanceClient((a, e, tag) => this.receiveAnalysis(a, e, tag));
  private fullBuilt: BuiltTrack | null = null;
  /** Analyses per layout (0 the full circuit) for the current design; null where one failed. */
  private analyses = new Map<number, Analysis | null>();
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
   * current design, for the full circuit and every layout. Tracks are
   * rotated so the start line is station 0.
   */
  rebuildTrack(): void {
    const hm = this.terrain?.heightmap;
    const heightAt = hm ? heightmapSampler(hm) : null;
    const raw = heightAt ? buildTrack(this.design, heightAt) : null;
    const startFinish = raw ? placeStartFinish(raw, this.project.overrides.startFinish) : null;
    const full = raw && startFinish ? rotateTrack(raw, startFinish.station) : null;
    this.fullTrack = full;
    this.fullBuilt = full && startFinish && hm
      ? { track: full, startFinish, metrics: analyseTrack(full), issues: validateTrack(full, hm, this.design.grading) }
      : null;
    this.layoutStates = this.project.layouts.map((l) => this.buildLayoutState(l, full, heightAt));
    if (this.layout > this.project.layouts.length) this.layout = 0;
    this.analyses.clear();
    this.showLayout();
  }

  private buildLayoutState(layout: LayoutDesign, full: Track | null, heightAt: HeightSampler | null): LayoutState {
    const hm = this.terrain?.heightmap;
    if (!full || !heightAt || !hm) {
      return { build: { track: null, shared: new Int32Array(0), links: [], errors: ['The full circuit is not a closed loop yet.'], warnings: [] }, built: null };
    }
    const build = buildLayout(full, layout, heightAt, this.design.grading);
    if (!build.track) return { build, built: null };
    // The layout starts at the full circuit's start line, already station 0.
    const startFinish = placeStartFinish(build.track, { x: full.x[0], y: full.y[0] });
    const track = rotateTrack(build.track, startFinish.station);
    const issues = validateTrack(track, hm, this.design.grading);
    for (const w of build.warnings) {
      const l = build.links[w.link];
      const start = layoutStation(build, l.from);
      const end = layoutStation(build, l.to);
      issues.push({ code: 'crossing', severity: 'warning', message: w.message, start, end, focus: Math.round((start + (end < start ? end + track.n : end)) / 2) % track.n });
    }
    return { build, built: { track, startFinish, metrics: analyseTrack(track), issues } };
  }

  /** The layout on show: the full circuit in Design mode, or when the one picked cannot be built. */
  get shownLayout(): number {
    if (this.mode === 'design' || this.layout === 0) return 0;
    return this.layoutStates[this.layout - 1]?.built ? this.layout : 0;
  }

  /** A layout's track as built now (0 the full circuit), or null. */
  trackOf(i: number): Track | null {
    return (i === 0 ? this.fullBuilt : this.layoutStates[i - 1]?.built)?.track ?? null;
  }

  /** The name of a layout (0 the full circuit). */
  layoutName(i: number): string {
    return i === 0 ? 'Full circuit' : this.project.layouts[i - 1]?.name ?? '';
  }

  /** Shows the layout on show: its track and what is derived from it, and its analysis once there is one. */
  private showLayout(): void {
    const i = this.shownLayout;
    const built = i === 0 ? this.fullBuilt : this.layoutStates[i - 1]?.built ?? null;
    this.track = built?.track ?? null;
    this.startFinish = built?.startFinish ?? null;
    this.metrics = built?.metrics ?? null;
    this.issues = built?.issues ?? [];
    if (this.hover !== null && (!this.track || this.hover >= this.track.n)) this.hover = null;
    if (this.focus && (!this.track || this.focus.centre >= this.track.n)) this.focus = null;
    this.emit('track', 'layout');
    const done = this.analyses.get(i);
    if (done) {
      clearTimeout(this.performanceTimer);
      this.performanceClient.cancel();
      this.applyAnalysis(done);
    } else {
      this.schedulePerformance();
    }
  }

  /** Picks the layout Analyse and Race show (0 the full circuit). */
  selectLayout(i: number): void {
    const layout = Math.max(0, Math.min(this.project.layouts.length, i));
    if (layout === this.layout) return;
    this.layout = layout;
    this.showLayout();
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
    this.performanceTimer = window.setTimeout(() => this.requestAnalysis(), PERFORMANCE_DELAY);
  }

  /** Asks the worker for the layout on show; for a layout, first for the full circuit, whose pit lane it shares. */
  private requestAnalysis(): void {
    const hm = this.terrain?.heightmap;
    const shown = this.shownLayout;
    const target = shown !== 0 && !this.analyses.has(0) ? 0 : shown;
    const built = target === 0 ? this.fullBuilt : this.layoutStates[target - 1]?.built;
    if (!built || !hm) return;
    let overrides = this.project.overrides;
    let pitLane: PitLane | null | undefined;
    if (target !== 0) {
      const fullPit = this.analyses.get(0)?.facilities.pitLane ?? null;
      pitLane = fullPit && this.fullTrack ? layoutPitLane(this.layoutStates[target - 1].build, fullPit, this.fullTrack.n) : null;
      // Its start line and pit lane come from the full circuit; the speed trap is placed for the layout.
      overrides = {};
    }
    this.performanceClient.request({
      track: built.track, metrics: built.metrics, issues: built.issues, startFinish: built.startFinish,
      overrides, pitLane, vehicles: this.vehicles,
    }, hm, target);
  }

  private receiveAnalysis(analysis: Analysis | null, error: string | null, tag: number): void {
    if (error) console.error('Lap-time analysis failed:', error);
    this.analyses.set(tag, analysis);
    const shown = this.shownLayout;
    if (tag === shown) this.applyAnalysis(analysis);
    else if (tag === 0 && shown !== 0) this.requestAnalysis();
  }

  private applyAnalysis(analysis: Analysis | null): void {
    this.performance = analysis?.performance ?? null;
    this.facilities = analysis?.facilities ?? null;
    this.licence = analysis?.licence ?? null;
    this.performancePending = false;
    this.emit('performance');
  }

  /** The full circuit's analysis and each layout's, where done: lap times and licence per layout for the Layouts list. */
  analysisOf(i: number): Analysis | null {
    return this.analyses.get(i) ?? null;
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

  /** What undo restores: the design, its layouts' links and the hand-placed facilities. */
  private snapshot(): string {
    return JSON.stringify({ track: this.design, overrides: this.project.overrides, layouts: this.project.layouts.map((l) => ({ name: l.name, links: l.links })) });
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
    const state = JSON.parse(snapshot) as { track: TrackDesign; overrides: Overrides; layouts?: { name: string; links: LinkDesign[] }[] };
    this.project.track = state.track;
    this.project.overrides = state.overrides;
    // Layouts keep their race setup; one that comes back gets a fresh one.
    const races = new Map(this.project.layouts.map((l) => [l.name, l.race]));
    this.project.layouts = (state.layouts ?? []).map((l) => ({ ...l, race: races.get(l.name) ?? null }));
    this.selected = null;
    this.linkSelected = null;
    this.rebuildTrack();
    this.emit('project', 'selection', 'history');
  }

  // ---- layouts -----------------------------------------------------------------

  /** Applies a change to the layouts; wrap user actions in beginEdit/commitEdit for undo. */
  updateLayouts(fn: (layouts: LayoutDesign[]) => void): void {
    fn(this.project.layouts);
    this.rebuildTrack();
    this.emit('project');
  }

  /** Starts drawing a link with the Link tool: for the layout `layout` (1-based), or a new one. */
  beginLink(layout: number | null): void {
    this.linkTarget = layout;
    this.linkDraft = null;
    this.setTool('link');
    if (layout !== null) this.selectLayout(layout);
    this.emit('layout');
  }

  /** The link drawn so far: leaving the track at `from`. */
  startLink(from: Vec2): void {
    this.linkDraft = { from: centimetres(from), points: [], layout: this.linkTarget };
    this.emit('layout');
  }

  addLinkPoint(p: Vec2): void {
    if (!this.linkDraft) return;
    this.linkDraft.points.push({ ...centimetres(p), width: this.design.defaultWidth });
    this.emit('layout');
  }

  /** Ends the link drawn where it joins the track at `to`: a new layout, or one more link for the layout it is for. */
  finishLink(to: Vec2): void {
    const draft = this.linkDraft;
    if (!draft) return;
    const link: LinkDesign = { from: draft.from, to: centimetres(to), points: draft.points };
    this.linkDraft = null;
    this.beginEdit();
    let layout = draft.layout;
    this.updateLayouts((ls) => {
      if (layout !== null && ls[layout - 1]) ls[layout - 1].links.push(link);
      else {
        ls.push({ name: this.nextLayoutName(), links: [link], race: null });
        layout = ls.length;
      }
    });
    this.commitEdit();
    this.setTool('points');
    this.selectLayout(layout ?? 0);
    this.emit('layout');
  }

  cancelLink(): void {
    if (!this.linkDraft && this.tool !== 'link') return;
    this.linkDraft = null;
    if (this.tool === 'link') this.setTool('points');
    this.emit('layout');
  }

  renameLayout(i: number, name: string): void {
    const l = this.project.layouts[i - 1];
    if (!l || !name.trim()) return;
    l.name = name.trim();
    this.emit('project', 'layout');
  }

  deleteLayout(i: number): void {
    if (!this.project.layouts[i - 1]) return;
    if (this.layout === i) this.layout = 0;
    else if (this.layout > i) this.layout--;
    this.linkSelected = null;
    this.beginEdit();
    this.updateLayouts((ls) => ls.splice(i - 1, 1));
    this.commitEdit();
  }

  /** Removes a link; a layout left without links goes too. */
  deleteLink(i: number, link: number): void {
    const l = this.project.layouts[i - 1];
    if (!l) return;
    if (l.links.length <= 1) {
      this.deleteLayout(i);
      return;
    }
    this.linkSelected = null;
    this.beginEdit();
    this.updateLayouts(() => l.links.splice(link, 1));
    this.commitEdit();
  }

  /** Moves a link's point (`point` -1 and -2 are where it leaves and joins the track). */
  moveLinkPoint(layout: number, link: number, point: number, to: Vec2): void {
    const l = this.project.layouts[layout - 1]?.links[link];
    if (!l) return;
    const at = centimetres(to);
    this.updateLayouts(() => {
      if (point === -1) l.from = at;
      else if (point === -2) l.to = at;
      else if (l.points[point]) Object.assign(l.points[point], at);
    });
  }

  /** Removes a point from a link (not its ends). */
  deleteLinkPoint(sel: { layout: number; link: number; point: number }): void {
    const link = this.project.layouts[sel.layout - 1]?.links[sel.link];
    if (!link || sel.point < 0 || sel.point >= link.points.length) return;
    this.linkSelected = null;
    this.beginEdit();
    this.updateLayouts(() => link.points.splice(sel.point, 1));
    this.commitEdit();
  }

  selectLinkPoint(sel: { layout: number; link: number; point: number } | null): void {
    this.linkSelected = sel;
    if (sel) this.select(null);
    this.emit('selection');
  }

  private nextLayoutName(): string {
    const taken = new Set(this.project.layouts.map((l) => l.name));
    for (let i = 2; ; i++) if (!taken.has(`Layout ${i}`)) return `Layout ${i}`;
  }

  // ---- race setup ------------------------------------------------------------

  /** The saved race settings of the layout on show, or the default race for Formula 1 on it. */
  get raceSettings(): RaceSettings {
    return this.savedRace ?? this.defaultRace(this.vehicles[0].id, this.raceSeed);
  }

  /** Whether the layout on show has race settings saved in the project. */
  get raceSettingsSaved(): boolean {
    return this.savedRace !== null;
  }

  private get savedRace(): RaceSettings | null {
    const i = this.shownLayout;
    return i === 0 ? this.project.race : this.project.layouts[i - 1]?.race ?? null;
  }

  private saveRace(race: RaceSettings): void {
    const i = this.shownLayout;
    if (i === 0) this.project.race = race;
    else this.project.layouts[i - 1].race = race;
  }

  /** The class's usual race on the current track (length from its lap time here, when known). */
  defaultRace(vehicleId: string, seed: string): RaceSettings {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId) ?? this.vehicles[0];
    const lap = this.performance?.laps.find((l) => l.vehicleId === vehicle.id);
    const length = this.performance?.line.length ?? this.track?.length ?? 5000;
    return defaultRaceSettings(vehicle, raceRules(vehicle), length, lap?.time ?? length / 45, seed);
  }

  setRaceSettings(changes: Partial<RaceSettings>): void {
    this.saveRace({ ...this.raceSettings, ...changes });
    this.emit('project', 'race');
  }

  /**
   * Changes the class at `index`. With a single class, the race switches to
   * that class's usual grid and length (keeping the seed, grid order and
   * weather); in a multi-class race only that class changes.
   */
  setRaceClass(index: number, vehicleId: string): void {
    const cur = this.raceSettings;
    if (cur.classes.length === 1) {
      this.saveRace({ ...this.defaultRace(vehicleId, cur.seed), grid: cur.grid, weather: cur.weather });
    } else {
      if (cur.classes.some((c, i) => i !== index && c.vehicleId === vehicleId)) return;
      const classes = cur.classes.map((c) => ({ ...c }));
      const room = MAX_CARS - totalCars(cur) + classes[index].cars;
      classes[index] = { vehicleId, cars: Math.max(1, Math.min(room, this.classCars(vehicleId))) };
      this.saveRace({ ...cur, classes });
    }
    this.emit('project', 'race');
  }

  /** Adds a class not yet racing, with its usual grid as far as there is room. */
  addRaceClass(): void {
    const cur = this.raceSettings;
    const room = MAX_CARS - totalCars(cur);
    // The next slower class of the same kind (cars or bikes), else any class not yet racing.
    const last = this.vehicles.findIndex((v) => v.id === cur.classes[cur.classes.length - 1].vehicleId);
    const free = this.vehicles.filter((v) => !cur.classes.some((c) => c.vehicleId === v.id));
    const next = free.find((v) => this.vehicles.indexOf(v) > last && v.kind === this.vehicles[last]?.kind) ?? free[0];
    if (!next || room < 1 || cur.classes.length >= MAX_CLASSES) return;
    this.setRaceSettings({ classes: [...cur.classes, { vehicleId: next.id, cars: Math.min(room, this.classCars(next.id)) }] });
  }

  removeRaceClass(index: number): void {
    const cur = this.raceSettings;
    if (cur.classes.length < 2) return;
    this.setRaceSettings({ classes: cur.classes.filter((_, i) => i !== index) });
  }

  setRaceCars(index: number, cars: number): void {
    const cur = this.raceSettings;
    const classes = cur.classes.map((c) => ({ ...c }));
    const room = MAX_CARS - totalCars(cur) + classes[index].cars;
    classes[index].cars = Math.max(1, Math.min(room, Math.round(cars)));
    this.setRaceSettings({ classes });
  }

  /** A WEC-style endurance event: Hypercars, LMP2 and GT3 together for six hours. */
  setEnduranceEvent(): void {
    const cur = this.raceSettings;
    const lead = this.defaultRace('hypercar', cur.seed);
    this.saveRace({
      ...lead,
      grid: cur.grid,
      weather: cur.weather,
      classes: [{ vehicleId: 'hypercar', cars: 18 }, { vehicleId: 'lmp2', cars: 14 }, { vehicleId: 'gt3', cars: 22 }],
    });
    this.emit('project', 'race');
  }

  /** A class's usual number of cars. */
  private classCars(vehicleId: string): number {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId) ?? this.vehicles[0];
    return raceRules(vehicle).field.cars;
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
    const before = this.shownLayout;
    this.mode = mode;
    if (mode !== 'design') {
      this.select(null);
      this.linkSelected = null;
      this.cancelLink();
    }
    this.emit('mode');
    // Design edits the full circuit; Analyse and Race show the layout picked.
    if (this.shownLayout !== before) this.showLayout();
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
    this.layout = 0;
    this.linkDraft = null;
    this.linkSelected = null;
    this.layoutStates = [];
    this.fullTrack = null;
    this.fullBuilt = null;
    this.analyses.clear();
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
    this.emit('project', 'track', 'performance', 'selection', 'history', 'focus', 'hover', 'layout');
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
