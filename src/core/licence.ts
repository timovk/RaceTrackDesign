/**
 * Circuit licence estimate: an FIA grade (1 to 4, cars) and an FIM grade
 * (A or B, bikes), each with the checklist behind it.
 *
 * Rules come from FIA Appendix O (2026, article 7 and supplement 2), FIA
 * Appendix H (2026, article 2.4.2, marshal posts) and the FIM Standards for
 * Circuits (2024, articles 4.2, 4.5 and 8). Only what can be judged from the
 * layout is checked; a real licence also depends on barriers, buildings,
 * medical facilities and an inspection.
 *
 * Neither body gives a formula for run-off depth; Appendix O 7.8 says run-off
 * areas "may typically have depths from around 30 m to 100 m, according to
 * the approach and cornering speeds". This module turns that range into a
 * requirement that grows with speed, and checks the ground beyond each
 * corner for the required depth.
 */
import { type Corner, type TrackMetrics } from './analysis.ts';
import type { Facilities } from './facilities.ts';
import { SpatialGrid } from './geometry.ts';
import type { Heightmap } from './heightmap.ts';
import { sampleHeight } from './heightmap.ts';
import type { LapResult } from './lapSim.ts';
import type { Performance } from './performance.ts';
import { GRID_LENGTH, GRID_SLOT_SPACING } from './startFinish.ts';
import type { Track } from './track.ts';
import type { Issue } from './validate.ts';
import type { VehicleClass } from './vehicles.ts';

export type Body = 'FIA' | 'FIM';
export type CheckLevel = 'required' | 'recommended' | 'info';

export interface LicenceCheck {
  id: string;
  body: Body;
  label: string;
  level: CheckLevel;
  /** Grades the check applies to; empty means every grade of its body. */
  grades: string[];
  pass: boolean;
  detail: string;
  source: string;
  /** Station to show on the map. */
  focus?: number;
}

export interface RunoffRay {
  corner: number;
  grade: string;
  kind: 'straight-on' | 'apex';
  /** From the track edge to the required depth, or to the obstacle. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  required: number;
  free: number;
  pass: boolean;
  blockedBy: 'track' | 'water' | 'map' | null;
  /** Steepest slope of the ground within the required depth, up and down, as fractions. */
  slopeUp: number;
  slopeDown: number;
}

export interface GradeResult {
  grade: string;
  passes: boolean;
  failures: LicenceCheck[];
}

export interface Licence {
  fia: { grade: string | null; results: GradeResult[] };
  fim: { grade: string | null; results: GradeResult[] };
  checks: LicenceCheck[];
  runoff: RunoffRay[];
  /** Classes and whether the estimated grades allow them. */
  classes: { id: string; needs: string; allowed: boolean }[];
  /** Largest grid for an international race by Appendix O supplement 2, for a one-hour sprint and a six-hour race. */
  maxStarters: { label: string; sprint: number; sixHours: number }[];
}

export interface LicenceInput {
  track: Track;
  metrics: TrackMetrics;
  issues: Issue[];
  performance: Performance;
  facilities: Facilities;
  heightmap: Heightmap;
  vehicles: readonly VehicleClass[];
}

const FIA_GRADES = ['1', '2', '3', '4'];
const FIM_GRADES = ['A', 'B'];
const APPX_O = 'FIA Appendix O 2026';
const FIM = 'FIM Standards for Circuits 2024';

export function assessLicence(input: LicenceInput): Licence {
  const { track: t, metrics: m, facilities: f, performance: perf } = input;
  const checks: LicenceCheck[] = [];
  const add = (c: LicenceCheck) => checks.push(c);
  const km = (v: number) => `${(v / 1000).toFixed(2)} km`;
  const metres = (v: number) => `${Math.round(v)} m`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  const lineStraight = longestLineStraight(perf.line);
  const gridBehind = straightBehindStart(t);
  const startStraight = straightAroundStart(t);
  const firstCorner = firstFiaCorner(m.corners);
  const gridEnd = firstCorner ? firstCorner.end : Math.round(250 / t.ds);
  let gridWidth = Infinity;
  for (let k = t.n - Math.round(GRID_LENGTH / t.ds); k <= t.n + gridEnd; k++) gridWidth = Math.min(gridWidth, t.width[((k % t.n) + t.n) % t.n]);
  let gridGradient = 0;
  for (let k = t.n - Math.round(GRID_LENGTH / t.ds); k <= t.n; k++) gridGradient = Math.max(gridGradient, Math.abs(t.gradient[k % t.n]));
  let transition = 0;
  let transitionAt = 0;
  for (let k = 0; k < t.n; k++) {
    const r = Math.abs(t.width[(k + 1) % t.n] - t.width[k]) / t.ds;
    if (r > transition) {
      transition = r;
      transitionAt = k;
    }
  }
  const layoutErrors = input.issues.filter((i) => i.severity === 'error' && ['crossing', 'overlap', 'off-map', 'too-tight'].includes(i.code));
  const pit = f.pitLane;
  const marshals = f.marshals;

  // ---- FIA -------------------------------------------------------------------------
  add({ id: 'fia-length-intl', body: 'FIA', label: 'At least 2 km long', level: 'required', grades: [], pass: m.length >= 2000, detail: km(m.length), source: `${APPX_O} supplement 2` });
  add({ id: 'fia-length-f1', body: 'FIA', label: 'At least 3.5 km for Formula One', level: 'required', grades: ['1'], pass: m.length >= 3500, detail: km(m.length), source: `${APPX_O} supplement 2` });
  add({ id: 'fia-length-sports', body: 'FIA', label: 'At least 3.5 km for sports car and GT championships', level: 'recommended', grades: ['2', '3'], pass: m.length >= 3500, detail: km(m.length), source: `${APPX_O} supplement 2` });
  add({ id: 'fia-length-touring', body: 'FIA', label: 'At least 3 km for touring car championships', level: 'recommended', grades: ['4'], pass: m.length >= 3000, detail: km(m.length), source: `${APPX_O} supplement 2` });
  add({ id: 'fia-length-max', body: 'FIA', label: 'No longer than 7 km (new circuits)', level: 'recommended', grades: [], pass: m.length <= 7000, detail: km(m.length), source: `${APPX_O} 7.2` });
  add({ id: 'fia-straight', body: 'FIA', label: 'No straight longer than 2 km on the racing line', level: 'required', grades: [], pass: lineStraight.length <= 2000, detail: metres(lineStraight.length), source: `${APPX_O} 7.2`, focus: lineStraight.start });
  add({ id: 'fia-width', body: 'FIA', label: 'Track at least 12 m wide', level: 'required', grades: [], pass: m.minWidth >= 12 - 1e-6, detail: `narrowest ${m.minWidth.toFixed(1)} m`, source: `${APPX_O} 7.3` });
  add({ id: 'fia-width-change', body: 'FIA', label: 'Width changes no faster than 1 m per 20 m', level: 'recommended', grades: [], pass: transition <= 1 / 20 + 1e-6, detail: `${(transition * 20).toFixed(2)} m per 20 m`, source: `${APPX_O} 7.3`, focus: transitionAt });
  add({ id: 'fia-grid-width', body: 'FIA', label: 'At least 15 m wide from the grid to the exit of the first corner', level: 'required', grades: [], pass: gridWidth >= 15 - 1e-6, detail: `narrowest ${gridWidth.toFixed(1)} m`, source: `${APPX_O} 7.3`, focus: 0 });
  add({ id: 'fia-grid-gradient', body: 'FIA', label: 'Starting grid no steeper than 2%', level: 'required', grades: [], pass: gridGradient <= 0.02 + 1e-9, detail: pct(gridGradient), source: `${APPX_O} 7.4`, focus: t.n - Math.round(GRID_LENGTH / t.ds / 2) });
  const f1Grid = 22 * GRID_SLOT_SPACING;
  add({ id: 'fia-grid-length-f1', body: 'FIA', label: `Grid of 22 cars at 8 m each (${f1Grid} m) on the straight`, level: 'required', grades: ['1'], pass: gridBehind >= f1Grid, detail: `${metres(gridBehind)} of straight behind the line`, source: `${APPX_O} 7.7`, focus: 0 });
  const sportsGrid = maxStarters(m.length, m.minWidth, 1, 0.7) * 6;
  add({ id: 'fia-grid-length', body: 'FIA', label: `Grid at 6 m per car (${metres(sportsGrid)} for the largest permitted field)`, level: 'recommended', grades: ['2', '3', '4'], pass: gridBehind >= sportsGrid, detail: `${metres(gridBehind)} of straight behind the line`, source: `${APPX_O} 7.7`, focus: 0 });
  add({ id: 'fia-first-corner', body: 'FIA', label: 'At least 250 m from the start line to the first corner', level: 'recommended', grades: [], pass: f.startFinish.firstCornerDistance >= 250, detail: metres(f.startFinish.firstCornerDistance), source: `${APPX_O} 7.7`, focus: 0 });
  add({ id: 'fia-layout', body: 'FIA', label: 'No crossings, overlaps or impossible corners', level: 'required', grades: [], pass: layoutErrors.length === 0, detail: layoutErrors.length ? layoutErrors.map((e) => e.message).slice(0, 2).join('; ') : 'none', source: 'layout', focus: layoutErrors[0]?.focus });
  add({ id: 'fia-pit', body: 'FIA', label: 'A pit lane at least 12 m wide', level: 'required', grades: [], pass: !!pit && pit.problems.length === 0 && pit.width >= 12, detail: pit ? (pit.problems[0] ?? `${pit.width} m wide, ${metres(pit.length)} long`) : 'no place found', source: `${APPX_O} 7.9`, focus: pit?.entry });
  add({ id: 'fia-pit-line', body: 'FIA', label: 'Pit entry and exit clear of the racing line', level: 'recommended', grades: [], pass: !!pit && pit.entryClearance >= 3 && pit.exitClearance >= 3 && !pit.exitInBrakingZone, detail: pit ? `line ${pit.entryClearance.toFixed(1)} m from the edge at entry, ${pit.exitClearance.toFixed(1)} m at exit${pit.exitInBrakingZone ? ', exit in a braking zone' : ''}` : 'no pit lane', source: `${APPX_O} 7.9`, focus: pit?.exit });
  add({ id: 'fia-pit-start', body: 'FIA', label: 'Pit lane beside the starting straight', level: 'recommended', grades: [], pass: !!pit && pit.adjacentToStart, detail: pit?.adjacentToStart ? 'yes' : 'elsewhere on the lap', source: `${APPX_O} 7.9`, focus: pit?.entry });
  add({ id: 'fia-marshals', body: 'FIA', label: 'Marshal posts at most 500 m apart, in sight of each other, seeing all the track', level: 'required', grades: [], pass: marshals.maxGap <= 500 + 1e-6 && marshals.allLinked && marshals.unobserved === 0, detail: `${marshals.posts.length} posts, largest gap ${metres(marshals.maxGap)}${marshals.unobserved ? `, ${metres(marshals.unobserved)} unseen` : ''}${marshals.allLinked ? '' : ', some out of sight of the next'}`, source: 'FIA Appendix H 2026 2.4.2' });

  // ---- FIM -------------------------------------------------------------------------
  add({ id: 'fim-length', body: 'FIM', label: 'Between 3.5 km and 10 km long', level: 'required', grades: [], pass: m.length >= 3500 && m.length <= 10000, detail: km(m.length), source: `${FIM} 4.2` });
  add({ id: 'fim-length-ideal', body: 'FIM', label: 'Ideal Grade A layout: 4.2 to 4.5 km with at least 10 turns', level: 'info', grades: ['A'], pass: m.length >= 4200 && m.length <= 4500 && m.corners.length >= 10, detail: `${km(m.length)}, ${m.corners.length} turns`, source: `${FIM} 4.2` });
  add({ id: 'fim-width', body: 'FIM', label: 'Track at least 12 m wide', level: 'required', grades: [], pass: m.minWidth >= 12 - 1e-6, detail: `narrowest ${m.minWidth.toFixed(1)} m`, source: `${FIM} 4.2` });
  add({ id: 'fim-grid-width', body: 'FIM', label: 'Starting grid straight at least 14 m wide', level: 'required', grades: [], pass: gridWidth >= 14 - 1e-6, detail: `narrowest ${gridWidth.toFixed(1)} m`, source: `${FIM} 4.2`, focus: 0 });
  add({ id: 'fim-straight', body: 'FIM', label: 'No straight longer than 1 km', level: 'recommended', grades: [], pass: lineStraight.length <= 1000, detail: metres(lineStraight.length), source: `${FIM} 4.5`, focus: lineStraight.start });
  add({ id: 'fim-start-straight', body: 'FIM', label: 'Start on a straight at least 250 m long', level: 'required', grades: [], pass: startStraight >= 250, detail: metres(startStraight), source: `${FIM} 4.5.1`, focus: 0 });
  add({ id: 'fim-start-straight-a', body: 'FIM', label: 'Grade A: start straight at least 400 m long', level: 'required', grades: ['A'], pass: startStraight >= 400, detail: metres(startStraight), source: `${FIM} 4.5.1`, focus: 0 });
  add({ id: 'fim-first-corner', body: 'FIM', label: 'Start line at least 200 m before the first corner', level: 'required', grades: [], pass: f.startFinish.firstCornerDistance >= 200, detail: metres(f.startFinish.firstCornerDistance), source: `${FIM} 4.5.1`, focus: 0 });
  add({ id: 'fim-first-corner-a', body: 'FIM', label: 'Grade A: start line at least 250 m before the first corner', level: 'required', grades: ['A'], pass: f.startFinish.firstCornerDistance >= 250, detail: metres(f.startFinish.firstCornerDistance), source: `${FIM} 4.5.1`, focus: 0 });
  add({ id: 'fim-pit', body: 'FIM', label: 'Pit lane at least 12 m wide (15 m for new Grade A circuits)', level: 'required', grades: [], pass: !!pit && pit.problems.length === 0 && pit.width >= 15, detail: pit ? (pit.problems[0] ?? `${pit.width} m wide`) : 'no place found', source: `${FIM} 8.1`, focus: pit?.entry });
  add({ id: 'fim-layout', body: 'FIM', label: 'No crossings, overlaps or impossible corners', level: 'required', grades: [], pass: layoutErrors.length === 0, detail: layoutErrors.length ? layoutErrors[0].message : 'none', source: 'layout', focus: layoutErrors[0]?.focus });
  add({ id: 'fim-marshals', body: 'FIM', label: 'Marshal posts in sight of each other, seeing all the track', level: 'required', grades: [], pass: marshals.allLinked && marshals.unobserved === 0, detail: `${marshals.posts.length} posts`, source: `${FIM} (marshal posts)` });

  // ---- run-off and crests, per grade ------------------------------------------------
  const runoff: RunoffRay[] = [];
  const grades: { body: Body; grade: string }[] = [...FIA_GRADES.map((g) => ({ body: 'FIA' as Body, grade: g })), ...FIM_GRADES.map((g) => ({ body: 'FIM' as Body, grade: g }))];
  const context = runoffContext(t, input.heightmap);
  for (const { body, grade } of grades) {
    const laps = lapsForGrade(perf.laps, input.vehicles, body, grade);
    if (!laps.length) continue;
    const rays = cornerRunoff(t, m.corners, laps, grade, body, context);
    runoff.push(...rays);
    const failed = rays.filter((r) => !r.pass);
    const worst = failed.sort((a, b) => b.required - b.free - (a.required - a.free))[0];
    const names = laps.map((l) => input.vehicles.find((v) => v.id === l.vehicleId)?.name ?? l.vehicleId).join(', ');
    add({
      id: `${body.toLowerCase()}-runoff-${grade}`, body, level: 'required', grades: [grade],
      label: `Run-off beyond every corner for ${names}`,
      pass: failed.length === 0,
      detail: failed.length
        ? `${failed.length} of ${rays.length} escape paths short; worst T${worst.corner}: ${Math.round(worst.free)} of ${Math.round(worst.required)} m${worst.blockedBy ? ` (${blockedText(worst.blockedBy)})` : ''}`
        : `all ${rays.length} escape paths clear`,
      source: body === 'FIA' ? `${APPX_O} 7.8 (depth estimated from speed)` : `${FIM} 4.8 (depth estimated from speed)`,
      focus: worst ? cornerStation(m.corners, worst.corner) : undefined,
    });
    const slopeLimit = body === 'FIA' ? 0.25 : 0.1;
    const steep = rays.filter((r) => r.slopeUp > slopeLimit || r.slopeDown > 0.03);
    add({
      id: `${body.toLowerCase()}-runoff-slope-${grade}`, body, level: 'recommended', grades: [grade],
      label: `Run-off ground no steeper than ${slopeLimit * 100}% up or 3% down`,
      pass: steep.length === 0,
      detail: steep.length ? `${steep.length} escape paths need grading, e.g. T${steep[0].corner}` : 'ground is gentle enough',
      source: body === 'FIA' ? `${APPX_O} 7.6` : `${FIM} 4.8`,
      focus: steep.length ? cornerStation(m.corners, steep[0].corner) : undefined,
    });
    const crest = worstCrest(t, laps);
    add({
      id: `${body.toLowerCase()}-crest-${grade}`, body, level: 'recommended', grades: [grade],
      label: 'Crests gentle enough that cars keep half their weight',
      pass: crest.unload <= 0.5,
      detail: crest.unload > 0 ? `worst crest takes ${Math.round(crest.unload * 100)}% of the weight off at ${Math.round(crest.speed * 3.6)} km/h` : 'no crests',
      source: `${APPX_O} 7.4 (vertical radii adequate for the cars; 50% is this tool's threshold)`,
      focus: crest.station,
    });
  }

  const fia = gradeFor(checks, 'FIA', FIA_GRADES);
  const fim = gradeFor(checks, 'FIM', FIM_GRADES);
  const classes = input.vehicles.map((v) => {
    const est = v.licence.body === 'FIA' ? fia.grade : fim.grade;
    const order = v.licence.body === 'FIA' ? FIA_GRADES : ['A', 'B', 'C', 'D', 'E', 'F'];
    const allowed = est !== null && order.indexOf(est) <= order.indexOf(v.licence.grade);
    return { id: v.id, needs: `${v.licence.body} ${v.licence.grade}`, allowed };
  });

  return {
    fia, fim, checks, runoff, classes,
    maxStarters: [
      { label: 'Single-seaters and sports cars, 1–2 kg/hp', sprint: maxStarters(m.length, m.minWidth, 1, 0.7), sixHours: maxStarters(m.length, m.minWidth, 6, 0.7) },
      { label: 'GT and touring cars', sprint: maxStarters(m.length, m.minWidth, 1, 1), sixHours: maxStarters(m.length, m.minWidth, 6, 1) },
    ],
  };
}

function gradeFor(checks: LicenceCheck[], body: Body, order: string[]): { grade: string | null; results: GradeResult[] } {
  const results = order.map((grade) => {
    const failures = checks.filter((c) => c.body === body && c.level === 'required' && !c.pass && (c.grades.length === 0 || c.grades.includes(grade)));
    return { grade, passes: failures.length === 0, failures };
  });
  return { grade: results.find((r) => r.passes)?.grade ?? null, results };
}

/** Appendix O supplement 2: N = 0.36 x L x W x T x G, rounded up. */
export function maxStarters(length: number, minWidth: number, hours: number, groupCoefficient: number): number {
  const km = length / 1000;
  const lengthTable: [number, number][] = [[2.6, 10], [3.2, 11], [3.8, 12], [4.4, 13], [4.8, 14], [5.2, 15], [5.6, 16], [6, 17], [8, 18], [10, 20], [12, 22], [14, 26]];
  let L = 28;
  for (const [upTo, c] of lengthTable) {
    if (km <= upTo) {
      L = c;
      break;
    }
  }
  if (km < 2) L = 10; // circuits up to 2 km need a dispensation; use the lowest coefficient
  const w = Math.ceil(minWidth - 1e-9);
  const W = w <= 9 ? 9 : w <= 12 ? 10 : w === 13 ? 11.5 : w === 14 ? 12 : 12.5;
  const T = hours <= 1 ? 1 : hours <= 2 ? 1.15 : hours <= 4 ? 1.25 : hours <= 12 ? 1.4 : 1.5;
  return Math.ceil(0.36 * L * W * T * groupCoefficient);
}

/** The fastest classes that need exactly this grade (they set the speeds a grade must be safe for). */
function lapsForGrade(laps: readonly LapResult[], vehicles: readonly VehicleClass[], body: Body, grade: string): LapResult[] {
  return laps.filter((l) => {
    const v = vehicles.find((x) => x.id === l.vehicleId);
    return v && v.licence.body === body && v.licence.grade === grade;
  });
}

function firstFiaCorner(corners: Corner[]): Corner | undefined {
  return corners.find((c) => c.angle >= 45 && c.minRadius < 300);
}

function cornerStation(corners: Corner[], number: number): number | undefined {
  return corners.find((c) => c.number === number)?.start;
}

function blockedText(b: 'track' | 'water' | 'map'): string {
  return b === 'track' ? 'another part of the track' : b === 'water' ? 'water' : 'edge of the map';
}

/** Straight run behind the start line (radius above 700 m), in metres. */
function straightBehindStart(t: Track): number {
  let k = 0;
  while (k < t.n && Math.abs(t.curvature[(t.n - k) % t.n]) < 1 / 700) k++;
  return k * t.ds;
}

/** Length of the straight the start line is on (radius above 1 km), in metres. */
function straightAroundStart(t: Track): number {
  const s = (k: number) => Math.abs(t.curvature[((k % t.n) + t.n) % t.n]) < 1 / 1000;
  if (!s(0)) return 0;
  let a = 0;
  while (a < t.n && s(-a - 1)) a++;
  let b = 0;
  while (b < t.n && s(b + 1)) b++;
  return Math.min(t.n, a + b + 1) * t.ds;
}

/** Longest straight of the racing line (radius above 1 km, at most 15 degrees of turning). */
export function longestLineStraight(line: { n: number; curvature: Float64Array; ds: Float64Array }): { start: number; length: number } {
  const n = line.n;
  let origin = 0;
  for (let k = 1; k < n; k++) if (Math.abs(line.curvature[k]) > Math.abs(line.curvature[origin])) origin = k;
  let best = { start: 0, length: 0 };
  let start = -1;
  let len = 0;
  let turned = 0;
  for (let i = 0; i <= n; i++) {
    const k = (origin + i) % n;
    const c = i < n ? line.curvature[k] : Infinity;
    if (Math.abs(c) >= 1 / 1000 || Math.abs(turned + c * line.ds[k]) > (15 * Math.PI) / 180) {
      if (start >= 0 && len > best.length) best = { start, length: len };
      start = -1;
      len = 0;
      turned = 0;
      if (Math.abs(c) >= 1 / 1000) continue;
    }
    if (start < 0) start = k;
    len += line.ds[k];
    turned += c * line.ds[k];
  }
  return best;
}

interface RunoffContext {
  grid: SpatialGrid;
  hm: Heightmap;
  maxWidth: number;
}

function runoffContext(t: Track, hm: Heightmap): RunoffContext {
  const grid = new SpatialGrid(25);
  let maxWidth = 0;
  for (let k = 0; k < t.n; k++) {
    grid.insert(t.x[k], t.y[k], k);
    maxWidth = Math.max(maxWidth, t.width[k]);
  }
  return { grid, hm, maxWidth };
}

/**
 * Required run-off depth for a car leaving the track at speed v (m/s):
 * 30 m at 100 km/h or less, rising to 100 m at 300 km/h and above, spanning
 * the range Appendix O 7.8 gives. Bikes need more room (a rider sliding
 * stops more slowly and is less protected): 1.3 times, between 40 and 130 m.
 */
export function requiredRunoff(v: number, body: Body): number {
  const kmh = v * 3.6;
  const car = Math.min(100, Math.max(30, 30 + (70 * (kmh - 100)) / 200));
  return body === 'FIA' ? car : Math.min(130, Math.max(40, 1.3 * car));
}

/**
 * Two escape paths per corner: straight on from the turn-in point (a missed
 * braking point), using the fastest speed in the 100 m before it, and along
 * the tangent at the apex (running wide), using the apex speed. Each path is
 * followed across the ground beyond the track edge until it reaches another
 * part of the track, water or the map edge.
 */
function cornerRunoff(t: Track, corners: Corner[], laps: LapResult[], grade: string, body: Body, ctx: RunoffContext): RunoffRay[] {
  const { n, ds } = t;
  const rays: RunoffRay[] = [];
  const back = Math.round(100 / ds);
  for (const c of corners) {
    let vIn = 0;
    let vApex = 0;
    for (const lap of laps) {
      for (let i = 0; i <= back; i++) vIn = Math.max(vIn, lap.v[(c.start - i + n) % n]);
      vApex = Math.max(vApex, lap.v[c.apex]);
    }
    for (const [kind, k, v] of [['straight-on', c.start, vIn], ['apex', c.apex, vApex]] as const) {
      rays.push(traceRunoff(t, ctx, c.number, grade, body, kind, k, v));
    }
  }
  return rays;
}

function traceRunoff(
  t: Track, ctx: RunoffContext, corner: number, grade: string, body: Body,
  kind: 'straight-on' | 'apex', k: number, v: number,
): RunoffRay {
  const { n, ds } = t;
  const required = requiredRunoff(v, body);
  const hx = Math.cos(t.heading[k]);
  const hy = Math.sin(t.heading[k]);
  const localReach = Math.round(300 / ds);
  const isLocal = (j: number) => {
    const d = Math.abs(j - k);
    return Math.min(d, n - d) <= localReach;
  };
  // Distance to the nearest station, split by whether it belongs to this corner.
  const nearest = (x: number, y: number, local: boolean) => {
    let best = Infinity;
    let at = -1;
    ctx.grid.query(x, y, ctx.maxWidth / 2 + 10, (j) => {
      if (isLocal(j) !== local) return;
      const d = Math.hypot(t.x[j] - x, t.y[j] - y);
      if (d < best) {
        best = d;
        at = j;
      }
    });
    return { d: best, at };
  };

  // Walk out of the track surface along the escape direction.
  let s = 0;
  const step = 2;
  let x = t.x[k];
  let y = t.y[k];
  for (let guard = 0; guard < 200; guard++) {
    const near = nearest(x, y, true);
    if (near.at < 0 || near.d > t.width[near.at] / 2 + 1) break;
    s += step;
    x = t.x[k] + hx * s;
    y = t.y[k] + hy * s;
  }
  const x0 = x;
  const y0 = y;
  const z0 = t.z[k];
  let free = 0;
  let blockedBy: RunoffRay['blockedBy'] = null;
  let slopeUp = 0;
  let slopeDown = 0;
  while (free < required) {
    const nx = x0 + hx * (free + step);
    const ny = y0 + hy * (free + step);
    if (nx < 0 || ny < 0 || nx > ctx.hm.extent || ny > ctx.hm.extent) {
      blockedBy = 'map';
      break;
    }
    const ground = sampleHeight(ctx.hm, nx, ny);
    if (ground < ctx.hm.waterLevel) {
      blockedBy = 'water';
      break;
    }
    const other = nearest(nx, ny, false);
    if (other.at >= 0 && other.d < t.width[other.at] / 2 + 3) {
      blockedBy = 'track';
      break;
    }
    free += step;
    const rise = (ground - z0) / free;
    if (free >= 10) {
      slopeUp = Math.max(slopeUp, rise);
      slopeDown = Math.max(slopeDown, -rise);
    }
  }
  const reach = Math.min(free, required);
  return {
    corner, grade, kind, x0, y0, x1: x0 + hx * reach, y1: y0 + hy * reach,
    required, free, pass: free >= required, blockedBy, slopeUp, slopeDown,
  };
}

/** The crest where the fastest of the laps loses the largest share of its weight. */
function worstCrest(t: Track, laps: LapResult[]): { unload: number; speed: number; station: number } {
  let worst = { unload: 0, speed: 0, station: 0 };
  for (let k = 0; k < t.n; k++) {
    if (t.vcurv[k] >= 0) continue;
    for (const lap of laps) {
      const v = lap.v[k];
      const unload = (v * v * -t.vcurv[k]) / 9.81;
      if (unload > worst.unload) worst = { unload, speed: v, station: k };
    }
  }
  return worst;
}
