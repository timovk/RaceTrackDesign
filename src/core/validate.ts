/**
 * Live design warnings: corners too tight, gradients too steep, the track
 * crossing or overlapping itself, running through water or off the map.
 * Consecutive problem stations are grouped into one issue with a range.
 */
import { SpatialGrid, segmentIntersection } from './geometry.ts';
import type { Heightmap } from './heightmap.ts';
import type { GradingSettings, Track } from './track.ts';

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'off-map'
  | 'crossing'
  | 'overlap'
  | 'too-tight'
  | 'very-tight'
  | 'too-steep'
  | 'steep'
  | 'close'
  | 'water'
  | 'earthworks'
  | 'short';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  message: string;
  /** Station range (inclusive), wrapping past station 0 when end < start. */
  start: number;
  end: number;
  /** Station to focus on when the issue is selected. */
  focus: number;
}

export const LIMITS = {
  /** Radius below which even a hairpin is unusually tight. */
  veryTightRadius: 12,
  steepGradient: 0.12,
  tooSteepGradient: 0.18,
  /** Clear space needed between the edges of two parts of the track. */
  minSeparation: 10,
  shortLength: 1000,
} as const;

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function validateTrack(t: Track, hm: Heightmap, grading: GradingSettings): Issue[] {
  const { n, ds } = t;
  const issues: Issue[] = [];
  const pct = (g: number) => `${(Math.abs(g) * 100).toFixed(1)}%`;

  // Per-station checks, grouped into ranges.
  addRanges(issues, n, (k) => t.x[k] < 0 || t.y[k] < 0 || t.x[k] > hm.extent || t.y[k] > hm.extent,
    'off-map', 'error', () => 'Track leaves the map');
  addRanges(issues, n, (k) => Math.abs(t.curvature[k]) * (t.width[k] / 2 + 1) >= 1,
    'too-tight', 'error', (worst) => `Corner radius ${radius(t, worst)} is narrower than the track is wide: the inside edge folds over`,
    (k) => Math.abs(t.curvature[k]));
  addRanges(issues, n,
    (k) => Math.abs(t.curvature[k]) > 1 / LIMITS.veryTightRadius && Math.abs(t.curvature[k]) * (t.width[k] / 2 + 1) < 1,
    'very-tight', 'warning', (worst) => `Very tight corner: radius ${radius(t, worst)}, under ${LIMITS.veryTightRadius} m`,
    (k) => Math.abs(t.curvature[k]));
  addRanges(issues, n, (k) => Math.abs(t.gradient[k]) > LIMITS.tooSteepGradient,
    'too-steep', 'error', (worst) => `Gradient ${pct(t.gradient[worst])} ${t.gradient[worst] > 0 ? 'uphill' : 'downhill'}, above the ${LIMITS.tooSteepGradient * 100}% limit`,
    (k) => Math.abs(t.gradient[k]));
  addRanges(issues, n,
    (k) => Math.abs(t.gradient[k]) > LIMITS.steepGradient && Math.abs(t.gradient[k]) <= LIMITS.tooSteepGradient,
    'steep', 'warning', (worst) => `Steep: ${pct(t.gradient[worst])} ${t.gradient[worst] > 0 ? 'uphill' : 'downhill'}`,
    (k) => Math.abs(t.gradient[k]));
  if (Number.isFinite(hm.waterLevel)) {
    addRanges(issues, n, (k) => t.terrain[k] < hm.waterLevel,
      'water', 'warning', (worst) => t.z[worst] < hm.waterLevel ? 'Track runs through water' : 'Track crosses water on an embankment');
  }
  if (grading.smoothing > 0 && grading.maxCutFill > 0) {
    addRanges(issues, n, (k) => Math.abs(t.z[k] - t.terrain[k]) >= grading.maxCutFill - 0.05,
      'earthworks', 'info', () => `Earthworks limit of ${grading.maxCutFill} m reached; the profile follows the terrain here`,
      undefined, 20 / ds);
  }

  findCrossingsAndOverlaps(t, issues);

  if (t.length < LIMITS.shortLength) {
    issues.push({ code: 'short', severity: 'info', message: `Very short lap: ${Math.round(t.length)} m`, start: 0, end: n - 1, focus: 0 });
  }
  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.start - b.start);
}

function radius(t: Track, k: number): string {
  return `${Math.round(1 / Math.max(1e-9, Math.abs(t.curvature[k])))} m`;
}

/**
 * Groups stations where `test` holds into wrapped ranges and adds one issue
 * per range, focused on the station with the highest `score`. Ranges shorter
 * than `minStations` are ignored.
 */
function addRanges(
  issues: Issue[],
  n: number,
  test: (k: number) => boolean,
  code: IssueCode,
  severity: Severity,
  message: (worst: number) => string,
  score: (k: number) => number = () => 0,
  minStations = 1,
): void {
  for (const [start, end] of ranges(n, test)) {
    const len = end >= start ? end - start + 1 : n - start + end + 1;
    if (len < minStations) continue;
    let worst = start;
    let best = -Infinity;
    for (let i = 0; i < len; i++) {
      const k = (start + i) % n;
      const sc = score(k);
      if (sc > best) { best = sc; worst = k; }
    }
    if (best === 0) worst = (start + Math.floor(len / 2)) % n;
    issues.push({ code, severity, message: message(worst), start, end, focus: worst });
  }
}

/** Maximal runs of stations satisfying `test`, joined across the wrap from the last station to the first. */
export function ranges(n: number, test: (k: number) => boolean): [number, number][] {
  const flags = new Uint8Array(n);
  let any = false;
  let all = true;
  for (let k = 0; k < n; k++) {
    flags[k] = test(k) ? 1 : 0;
    if (flags[k]) any = true;
    else all = false;
  }
  if (!any) return [];
  if (all) return [[0, n - 1]];
  // Start scanning just after a clear station so wrapped runs stay whole.
  let origin = 0;
  while (flags[origin]) origin++;
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 1; i <= n; i++) {
    const k = (origin + i) % n;
    if (flags[k] && start < 0) start = k;
    if (!flags[k] && start >= 0) {
      out.push([start, (k - 1 + n) % n]);
      start = -1;
    }
  }
  return out;
}

/**
 * Crossings: centreline segments that intersect (bridges come later).
 * Overlaps: parts of the track that are far apart along the lap but whose
 * surfaces touch, or leave less than the minimum separation between edges.
 */
function findCrossingsAndOverlaps(t: Track, issues: Issue[]): void {
  const { n, ds } = t;
  let maxWidth = 0;
  for (let k = 0; k < n; k++) maxWidth = Math.max(maxWidth, t.width[k]);
  const reach = maxWidth + LIMITS.minSeparation;
  const grid = new SpatialGrid(Math.max(20, reach));
  for (let k = 0; k < n; k++) grid.insert(t.x[k], t.y[k], k);

  // Stations closer than this along the lap are neighbours, not a separate part of the track.
  const neighbourhood = Math.max(Math.ceil((3 * reach) / ds), Math.ceil(60 / ds));
  const lapGap = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, n - d);
  };

  const crossing = new Uint8Array(n);
  const overlap = new Uint8Array(n);
  const close = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    grid.query(t.x[k], t.y[k], reach, (j) => {
      if (lapGap(j, k) <= neighbourhood) return;
      const dx = t.x[j] - t.x[k];
      const dy = t.y[j] - t.y[k];
      const d = Math.sqrt(dx * dx + dy * dy);
      const surfaces = (t.width[j] + t.width[k]) / 2;
      if (d < surfaces) overlap[k] = 1;
      else if (d < surfaces + LIMITS.minSeparation) close[k] = 1;
      const j1 = (j + 1) % n;
      if (segmentIntersection(t.x[k], t.y[k], t.x[k1], t.y[k1], t.x[j], t.y[j], t.x[j1], t.y[j1]) >= 0) crossing[k] = 1;
    });
  }
  // One issue per stretch, named after the worst thing in it: a crossing is always flanked by overlap and closeness.
  for (const [start, end] of ranges(n, (k) => crossing[k] + overlap[k] + close[k] > 0)) {
    const len = end >= start ? end - start + 1 : n - start + end + 1;
    let firstCrossing = -1;
    let firstOverlap = -1;
    for (let i = 0; i < len; i++) {
      const k = (start + i) % n;
      if (crossing[k] && firstCrossing < 0) firstCrossing = k;
      if (overlap[k] && firstOverlap < 0) firstOverlap = k;
    }
    const mid = (start + Math.floor(len / 2)) % n;
    if (firstCrossing >= 0) {
      issues.push({ code: 'crossing', severity: 'error', message: 'Track crosses itself (bridges arrive in a later milestone)', start, end, focus: firstCrossing });
    } else if (firstOverlap >= 0) {
      issues.push({ code: 'overlap', severity: 'error', message: 'Two parts of the track overlap', start, end, focus: firstOverlap });
    } else {
      issues.push({
        code: 'close', severity: 'warning', start, end, focus: mid,
        message: `Less than ${LIMITS.minSeparation} m between two parts of the track: no room for barriers`,
      });
    }
  }
}
