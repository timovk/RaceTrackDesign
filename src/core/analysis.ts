/**
 * Geometric analysis of a built track: headline metrics, corners (detected
 * from curvature, numbered and classified) and straights.
 */
import type { Track } from './track.ts';

export type CornerType = 'hairpin' | 'chicane' | 'esses' | 'long' | 'sweeper' | 'kink' | 'slow' | 'medium';

export const CORNER_LABELS: Record<CornerType, string> = {
  hairpin: 'Hairpin',
  chicane: 'Chicane',
  esses: 'Esses',
  long: 'Long corner',
  sweeper: 'Sweeper',
  kink: 'Kink',
  slow: 'Slow corner',
  medium: 'Medium corner',
};

export interface Corner {
  /** Turn number, counted from the first control point. */
  number: number;
  direction: 'left' | 'right';
  type: CornerType;
  /** Station range (inclusive); `end` is smaller than `start` when the corner wraps past station 0. */
  start: number;
  apex: number;
  end: number;
  /** Total change of direction in degrees. */
  angle: number;
  minRadius: number;
  length: number;
}

export interface Straight {
  start: number;
  end: number;
  length: number;
}

export interface TrackMetrics {
  length: number;
  direction: 'clockwise' | 'anticlockwise';
  minZ: number;
  maxZ: number;
  /** Height difference between the highest and lowest point. */
  elevationRange: number;
  /** Total climb over one lap (equal to the total descent on a closed loop). */
  totalClimb: number;
  /** Steepest uphill and downhill in the direction of travel, as fractions (0.1 = 10%), with their stations. */
  maxUphill: number;
  maxUphillAt: number;
  maxDownhill: number;
  maxDownhillAt: number;
  minRadius: number;
  minRadiusAt: number;
  /** Tightest crest and dip, as vertical radii in metres (Infinity when there is none). */
  crestRadius: number;
  dipRadius: number;
  corners: Corner[];
  leftTurns: number;
  rightTurns: number;
  straights: Straight[];
  longestStraight: Straight | null;
  minWidth: number;
  maxWidth: number;
  avgWidth: number;
  maxCut: number;
  maxFill: number;
  /** Earthworks volumes in cubic metres, counting only the track surface itself. */
  cutVolume: number;
  fillVolume: number;
}

/** A station is in a corner once the radius drops below 300 m, and leaves it above 450 m. */
const CORNER_ON = 1 / 300;
const CORNER_OFF = 1 / 450;
/** A corner's entry and exit extend outward while the radius stays under 1 km. */
const CORNER_EDGE = 1 / 1000;
/** Same-direction corners closer than this merge into one (a double apex). */
const MERGE_GAP = 40;
const MIN_CORNER_ANGLE = 10;
const STRAIGHT_MAX_CURVATURE = 1 / 1000;
const STRAIGHT_MAX_TURN = (15 * Math.PI) / 180;
const MIN_STRAIGHT = 100;

export function analyseTrack(t: Track): TrackMetrics {
  const { n, ds } = t;

  let minZ = Infinity;
  let maxZ = -Infinity;
  let totalClimb = 0;
  let maxUphill = 0;
  let maxUphillAt = 0;
  let maxDownhill = 0;
  let maxDownhillAt = 0;
  let maxCurv = 0;
  let minRadiusAt = 0;
  let maxCrest = 0;
  let maxDip = 0;
  let minWidth = Infinity;
  let maxWidth = 0;
  let widthSum = 0;
  let maxCut = 0;
  let maxFill = 0;
  let cutVolume = 0;
  let fillVolume = 0;
  let area2 = 0;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const z = t.z[k];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const dz = t.z[k1] - z;
    if (dz > 0) totalClimb += dz;
    const g = t.gradient[k];
    if (g > maxUphill) { maxUphill = g; maxUphillAt = k; }
    if (g < maxDownhill) { maxDownhill = g; maxDownhillAt = k; }
    const c = Math.abs(t.curvature[k]);
    if (c > maxCurv) { maxCurv = c; minRadiusAt = k; }
    if (-t.vcurv[k] > maxCrest) maxCrest = -t.vcurv[k];
    if (t.vcurv[k] > maxDip) maxDip = t.vcurv[k];
    const w = t.width[k];
    if (w < minWidth) minWidth = w;
    if (w > maxWidth) maxWidth = w;
    widthSum += w;
    const fill = z - t.terrain[k];
    if (fill > maxFill) maxFill = fill;
    if (-fill > maxCut) maxCut = -fill;
    if (fill > 0) fillVolume += fill * w * ds;
    else cutVolume -= fill * w * ds;
    area2 += t.x[k] * t.y[k1] - t.x[k1] * t.y[k];
  }

  const corners = findCorners(t);
  const straights = findStraights(t);
  let longestStraight: Straight | null = null;
  for (const st of straights) if (!longestStraight || st.length > longestStraight.length) longestStraight = st;

  return {
    length: t.length,
    // With y pointing south, a positive shoelace area means clockwise on screen.
    direction: area2 > 0 ? 'clockwise' : 'anticlockwise',
    minZ,
    maxZ,
    elevationRange: maxZ - minZ,
    totalClimb,
    maxUphill,
    maxUphillAt,
    maxDownhill,
    maxDownhillAt,
    minRadius: maxCurv > 0 ? 1 / maxCurv : Infinity,
    minRadiusAt,
    crestRadius: maxCrest > 1e-6 ? 1 / maxCrest : Infinity,
    dipRadius: maxDip > 1e-6 ? 1 / maxDip : Infinity,
    corners,
    leftTurns: corners.filter((c) => c.direction === 'left').length,
    rightTurns: corners.filter((c) => c.direction === 'right').length,
    straights,
    longestStraight,
    minWidth,
    maxWidth,
    avgWidth: widthSum / n,
    maxCut,
    maxFill,
    cutVolume,
    fillVolume,
  };
}

interface Run {
  start: number;
  end: number;
  sign: number;
}

/** Corners, numbered in order of their apex along the lap. Station indices are real (unrotated). */
export function findCorners(t: Track): Corner[] {
  const { n, ds } = t;
  // Scan from the straightest station so no corner is split by the wrap-around.
  let origin = 0;
  for (let k = 1; k < n; k++) if (Math.abs(t.curvature[k]) < Math.abs(t.curvature[origin])) origin = k;
  const curv = (k: number) => t.curvature[(origin + k) % n];

  const runs: Run[] = [];
  let current: Run | null = null;
  for (let k = 0; k < n; k++) {
    const c = curv(k);
    if (current && (Math.sign(c) !== current.sign || Math.abs(c) < CORNER_OFF)) {
      current.end = k - 1;
      runs.push(current);
      current = null;
    }
    if (!current && Math.abs(c) > CORNER_ON) current = { start: k, end: k, sign: Math.sign(c) };
  }
  if (current) {
    current.end = n - 1;
    runs.push(current);
  }

  // Extend entries and exits into the gentle part of each corner, without overlapping neighbours.
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const lowLimit = r > 0 ? runs[r - 1].end + 1 : 0;
    while (run.start > lowLimit && Math.sign(curv(run.start - 1)) === run.sign && Math.abs(curv(run.start - 1)) > CORNER_EDGE) run.start--;
    const highLimit = r < runs.length - 1 ? runs[r + 1].start - 1 : n - 1;
    while (run.end < highLimit && Math.sign(curv(run.end + 1)) === run.sign && Math.abs(curv(run.end + 1)) > CORNER_EDGE) run.end++;
  }

  // Merge same-direction runs separated by a short gap: one corner with two apexes.
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.sign === run.sign && (run.start - last.end) * ds < MERGE_GAP) last.end = run.end;
    else merged.push({ ...run });
  }

  type Draft = Omit<Corner, 'number'> & { startK: number; endK: number };
  const drafts: Draft[] = [];
  for (const run of merged) {
    let turn = 0;
    let peak = 0;
    let apexK = run.start;
    for (let k = run.start; k <= run.end; k++) {
      const c = curv(k);
      turn += c * ds;
      if (Math.abs(c) > peak) { peak = Math.abs(c); apexK = k; }
    }
    const angle = Math.abs(turn) * (180 / Math.PI);
    if (angle < MIN_CORNER_ANGLE) continue;
    const minRadius = 1 / peak;
    drafts.push({
      direction: run.sign > 0 ? 'right' : 'left',
      type: classify(angle, minRadius),
      start: (origin + run.start) % n,
      apex: (origin + apexK) % n,
      end: (origin + run.end) % n,
      angle,
      minRadius,
      length: (run.end - run.start + 1) * ds,
      startK: run.start,
      endK: run.end,
    });
  }

  // Pair quick direction changes: tight ones are chicanes, fast ones esses.
  for (let i = 0; i + 1 < drafts.length; i++) {
    const a = drafts[i];
    const b = drafts[i + 1];
    if (a.direction === b.direction) continue;
    if (a.type === 'chicane' || a.type === 'esses') continue;
    const gap = (b.startK - a.endK) * ds;
    const bothModerate = a.angle >= 20 && b.angle >= 20 && a.angle <= 120 && b.angle <= 120;
    if (!bothModerate) continue;
    if (gap < 50 && a.minRadius < 120 && b.minRadius < 120) {
      a.type = 'chicane';
      b.type = 'chicane';
    } else if (gap < 80 && a.minRadius >= 100 && b.minRadius >= 100) {
      a.type = 'esses';
      b.type = 'esses';
    }
  }

  drafts.sort((p, q) => p.apex - q.apex);
  return drafts.map(({ startK: _s, endK: _e, ...c }, i) => ({ ...c, number: i + 1 }));
}

function classify(angle: number, minRadius: number): CornerType {
  if (angle < 30) return 'kink';
  if (angle >= 140 && minRadius < 45) return 'hairpin';
  if (angle >= 200) return 'long';
  if (minRadius >= 120) return 'sweeper';
  if (minRadius < 45) return 'slow';
  return 'medium';
}

/**
 * Straights: stretches of at least 100 m with a radius above 1 km that change
 * direction by no more than 15 degrees in total, so a long gentle arc is not
 * mistaken for one straight.
 */
export function findStraights(t: Track): Straight[] {
  const { n, ds } = t;
  // Scan from the most curved station so no straight is split by the wrap-around.
  let origin = 0;
  for (let k = 1; k < n; k++) if (Math.abs(t.curvature[k]) > Math.abs(t.curvature[origin])) origin = k;
  const out: Straight[] = [];
  const close = (startK: number, endK: number) => {
    const length = (endK - startK + 1) * ds;
    if (length >= MIN_STRAIGHT) out.push({ start: (origin + startK) % n, end: (origin + endK) % n, length });
  };
  let startK = -1;
  let turned = 0;
  for (let k = 0; k <= n; k++) {
    const c = k < n ? t.curvature[(origin + k) % n] : Infinity;
    if (Math.abs(c) >= STRAIGHT_MAX_CURVATURE) {
      if (startK >= 0) close(startK, k - 1);
      startK = -1;
      continue;
    }
    if (startK < 0) {
      startK = k;
      turned = 0;
    }
    turned += c * ds;
    if (Math.abs(turned) > STRAIGHT_MAX_TURN) {
      close(startK, k - 1);
      startK = k;
      turned = c * ds;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
