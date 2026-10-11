/**
 * The track generator: circuits made to order on the ground that is there.
 *
 * A lap is written from its start line, corner by corner, as a sequence of
 * passages (core/lapComposer.ts): a straight and the corners it leads into.
 * What is asked decides which passages a lap gets; they are laid out on a
 * plot of land, each where it keeps clear of the rest and from where the
 * lap can still come home. The figures a lap is drawn to (how many corners
 * a kilometre, the mix of slow and fast, how far it is spread and how much
 * it folds back) are those of real circuits in the middle of each slider.
 *
 * Many such laps are drawn from the seed and scored on their shape alone
 * (cheap). The best are then tried all over the map, turned twelve ways, for
 * the place that suits: dry, open, with the height difference asked for and
 * no slope too steep. The best of those are built as real tracks and
 * measured (corners, straights, a lap of the class they are for, the licence
 * check), and the best few are offered.
 *
 * Map coordinates: x east and y south, so a positive turn is to the right.
 */
import { analyseTrack } from './analysis.ts';
import { placeFacilities } from './facilities.ts';
import { type Heightmap, sampleHeight } from './heightmap.ts';
import { type Runoff, composeLap, cornersWanted, foldedWanted, hullWanted, mixWanted, spreadWanted } from './lapComposer.ts';
import { type Shape, FAST_ABOVE, READS_WIDER, SLOW_BELOW, STRAIGHT_CREEP, cells, centroid, clamp, clear, cornerGroups, cornersOf, hasNeighbour, hullShare, lapLength, mod, tracePath, turns } from './lapShape.ts';
import { simulateLap } from './lapSim.ts';
import { assessLicence, requiredRunoff } from './licence.ts';
import { analysePerformance } from './performance.ts';
import { computeRacingLine } from './racingLine.ts';
import { HEAVY_BRAKING, lineRadius, paceOf, peakSpeed } from './roughPace.ts';
import { seededRandom } from './rng.ts';
import { woodsAt } from './scenery.ts';
import { GRID_LENGTH, placeStartFinish, rotateTrack } from './startFinish.ts';
import { type ControlPoint, DEFAULT_GRADING, type TrackDesign, buildTrack } from './track.ts';
import { validateTrack } from './validate.ts';
import type { VehicleClass } from './vehicles.ts';

export interface GeneratorSettings {
  seed: string;
  /** Lap length wanted, metres. */
  length: number;
  /** Track width, metres. */
  width: number;
  /** Height difference wanted between the highest and the lowest point of the lap, metres. */
  heightDifference: number;
  /** From 0, corner after corner, to 1, long straights and fast bends. */
  speed: number;
  /** The class it is for, and whether to build it to that class's circuit licence. */
  vehicleId: string;
  licence: boolean;
  /** The longest straight and the one the start is on (metres), and how many heavy braking points the lap should have. */
  longestStraight: number;
  startStraight: number;
  brakingPoints: number;
  /** The mix of corners: weights of slow, medium and fast ones (on any scale). */
  slow: number;
  medium: number;
  fast: number;
  /** Corners to include whatever the mix. */
  hairpin: boolean;
  chicane: boolean;
  esses: boolean;
  sweeper: boolean;
  direction: 'clockwise' | 'anticlockwise' | 'either';
  /** From 0, spread out, to 1, compact. */
  compact: number;
  /** From 0, one open loop, to 1, folding back on itself with parallel straights. */
  foldBack: number;
  avoidWater: boolean;
  avoidWoods: boolean;
  /** How many tracks to offer. */
  candidates: number;
}

export const DEFAULT_GENERATOR: GeneratorSettings = {
  seed: '1', length: 5000, width: 12, heightDifference: 30, speed: 0.5, vehicleId: 'gt3', licence: true,
  longestStraight: 800, startStraight: 580, brakingPoints: 3, slow: 1, medium: 1, fast: 1,
  hairpin: true, chicane: false, esses: true, sweeper: true, direction: 'clockwise', compact: 0.5, foldBack: 0.5,
  avoidWater: true, avoidWoods: false, candidates: 6,
};

/** A kind of circuit that sets every slider at once, to adjust from. */
export interface GeneratorStyle {
  id: string;
  name: string;
  summary: string;
  settings: Partial<GeneratorSettings>;
}

export const GENERATOR_STYLES: readonly GeneratorStyle[] = [
  {
    id: 'grand-prix', name: 'Grand Prix circuit', summary: 'A modern permanent circuit for Formula 1: wide, a long start straight, every kind of corner.',
    settings: { length: 5400, width: 14, heightDifference: 35, speed: 0.5, vehicleId: 'f1', licence: true, longestStraight: 880, startStraight: 620, brakingPoints: 4, slow: 1, medium: 1, fast: 1, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.5, foldBack: 0.5, direction: 'clockwise' },
  },
  {
    id: 'road-course', name: 'Old road course', summary: 'Public roads closed for the day: narrow, long and fast, across the country and back.',
    settings: { length: 7200, width: 9, heightDifference: 70, speed: 0.8, vehicleId: 'f1-1950', licence: false, longestStraight: 1500, startStraight: 550, brakingPoints: 2, slow: 0.5, medium: 1, fast: 1.6, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.15, foldBack: 0.1, direction: 'clockwise' },
  },
  {
    id: 'street', name: 'Street circuit', summary: 'Short blocks and right angles: slow corners, short straights, a hairpin and a chicane.',
    settings: { length: 3400, width: 10, heightDifference: 15, speed: 0.25, vehicleId: 'f2', licence: false, longestStraight: 650, startStraight: 420, brakingPoints: 4, slow: 2, medium: 1, fast: 0.3, hairpin: true, chicane: true, esses: false, sweeper: false, compact: 0.8, foldBack: 0.6, direction: 'clockwise' },
  },
  {
    id: 'club', name: 'Club circuit', summary: 'A short lap for touring cars and track days, folded onto a small site.',
    settings: { length: 2600, width: 11, heightDifference: 15, speed: 0.45, vehicleId: 'tcr', licence: false, longestStraight: 520, startStraight: 380, brakingPoints: 2, slow: 1.2, medium: 1.1, fast: 0.6, hairpin: true, chicane: false, esses: false, sweeper: false, compact: 0.75, foldBack: 0.55, direction: 'clockwise' },
  },
  {
    id: 'bikes', name: 'Motorcycle circuit', summary: 'Flowing and wide for MotoGP: medium and fast corners, no straight too long.',
    settings: { length: 4600, width: 13, heightDifference: 30, speed: 0.6, vehicleId: 'motogp', licence: true, longestStraight: 850, startStraight: 600, brakingPoints: 3, slow: 0.8, medium: 1.2, fast: 1.3, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.55, foldBack: 0.5, direction: 'clockwise' },
  },
  {
    id: 'speed', name: 'High-speed circuit', summary: 'Long straights broken by chicanes, and fast curves between them.',
    settings: { length: 5800, width: 14, heightDifference: 10, speed: 0.95, vehicleId: 'hypercar', licence: true, longestStraight: 1700, startStraight: 900, brakingPoints: 3, slow: 0.5, medium: 0.8, fast: 1.8, hairpin: false, chicane: true, esses: false, sweeper: true, compact: 0.3, foldBack: 0.15, direction: 'clockwise' },
  },
  {
    id: 'mountain', name: 'Mountain course', summary: 'Up the hill and down again: a big height difference, as far as the map has one.',
    settings: { length: 6000, width: 11, heightDifference: 160, speed: 0.5, vehicleId: 'gt3', licence: false, longestStraight: 800, startStraight: 500, brakingPoints: 3, slow: 1.2, medium: 1.1, fast: 0.8, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.35, foldBack: 0.4, direction: 'clockwise' },
  },
];

/** What a class's circuit licence asks of a track, as far as the generator can see to it. */
export interface ClassNeeds {
  minLength: number;
  maxLength: number;
  minWidth: number;
  /** Width from the grid to the exit of the first corner. */
  gridWidth: number;
  startStraight: number;
  maxStraight: number;
  /** From the start line to the end of its straight: the distance to the first corner the licence asks, and what a corner begins before its arc. */
  lineToCorner: number;
  /** The line's distance to the first corner comes before room for the whole grid on the straight (the FIM requires the first, the FIA the second). */
  cornerFirst: boolean;
}

/** A straight this much longer than the grid has the whole grid on it, clear of the corner behind. */
const BEHIND_GRID = 40;
/** What a corner begins before its arc, as the analysis reads the built track: the line stands this much further from it. */
const CORNER_CREEP = 70;

/**
 * From the FIA's Appendix O and the FIM's Standards for Circuits, as
 * core/licence.ts checks them. The start straight is what holds the grid
 * behind the line and the distance to the first corner beyond it, where both
 * are required or the class is the top one; the FIM's own least lengths
 * (400 m for Grade A, 250 m otherwise) are shorter than that.
 */
export function classNeeds(v: VehicleClass): ClassNeeds {
  if (v.licence.body === 'FIM') {
    const a = v.licence.grade === 'A';
    const lineToCorner = (a ? 250 : 200) + CORNER_CREEP;
    return { minLength: 3500, maxLength: 10000, minWidth: 12, gridWidth: 14, startStraight: a ? GRID_LENGTH + BEHIND_GRID + lineToCorner : 200 + lineToCorner, maxStraight: 1000, lineToCorner, cornerFirst: true };
  }
  const one = v.licence.grade === '1';
  const lineToCorner = 250 + CORNER_CREEP;
  return { minLength: one ? 3500 : 2000, maxLength: 20000, minWidth: 12, gridWidth: 15, startStraight: one ? GRID_LENGTH + BEHIND_GRID + lineToCorner : 450, maxStraight: 2000, lineToCorner, cornerFirst: false };
}

/** The widest each setting goes. */
export const GENERATOR_RANGE = {
  length: [1000, 25000], width: [6, 30], heightDifference: [0, 600], longestStraight: [100, 5000], startStraight: [100, 3000], brakingPoints: [0, 15],
  /** The longest straight as a share of the lap, at most: two of them and the two ends make an oval. */
  straightShare: 0.42,
} as const;

/**
 * The settings as they are used: each within its range, the longest
 * straight no more than the lap has room for and the start straight no
 * longer than the longest. What is asked stands, whatever the licence: a
 * track built to one keeps room for run-off, gets its grid and its start
 * line, and the notes say which settings stand in the way of passing.
 */
export function resolveSettings(s: GeneratorSettings, vehicle: VehicleClass | null): { settings: GeneratorSettings; needs: ClassNeeds | null; notes: string[] } {
  const R = GENERATOR_RANGE;
  const out: GeneratorSettings = {
    ...s,
    length: clamp(s.length, R.length[0], R.length[1]), width: clamp(s.width, R.width[0], R.width[1]),
    heightDifference: clamp(s.heightDifference, R.heightDifference[0], R.heightDifference[1]),
    speed: clamp(s.speed, 0, 1), compact: clamp(s.compact, 0, 1), foldBack: clamp(s.foldBack, 0, 1),
    brakingPoints: clamp(Math.round(s.brakingPoints), R.brakingPoints[0], R.brakingPoints[1]), candidates: clamp(Math.round(s.candidates), 1, 12),
    slow: Math.max(0, s.slow), medium: Math.max(0, s.medium), fast: Math.max(0, s.fast),
  };
  if (out.slow + out.medium + out.fast <= 0) out.medium = 1;
  out.longestStraight = clamp(s.longestStraight, R.longestStraight[0], Math.min(R.longestStraight[1], out.length * R.straightShare));
  out.startStraight = clamp(s.startStraight, R.startStraight[0], out.longestStraight);
  const notes: string[] = [];
  const needs = vehicle && s.licence ? classNeeds(vehicle) : null;
  if (needs && vehicle) {
    const licence = `${vehicle.name}'s licence`;
    const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
    if (out.length < needs.minLength) notes.push(`A lap of ${km(out.length)} is shorter than the ${km(needs.minLength)} ${licence} asks.`);
    if (out.length > needs.maxLength) notes.push(`A lap of ${km(out.length)} is longer than the ${km(needs.maxLength)} ${licence} allows.`);
    if (out.width < needs.minWidth) notes.push(`A track ${out.width} m wide is narrower than the ${needs.minWidth} m ${licence} asks.`);
    if (out.startStraight < needs.startStraight) notes.push(`A start straight of ${Math.round(out.startStraight)} m is shorter than the ${Math.round(needs.startStraight)} m that holds the grid and the distance to the first corner for ${licence}.`);
    if (out.longestStraight > needs.maxStraight) notes.push(`A straight of ${Math.round(out.longestStraight)} m is longer than the ${needs.maxStraight} m ${licence} allows.`);
  }
  return { settings: out, needs, notes };
}

// ---- the shape -------------------------------------------------------------------

export { CORNER_RADII, tracePath } from './lapShape.ts';
export type { Path, Shape } from './lapShape.ts';
export { cornersWanted } from './lapComposer.ts';

/**
 * Draws one lap from random numbers (core/lapComposer.ts). Null when the
 * draw does not work out: the caller draws again.
 */
export function drawShape(s: GeneratorSettings, rng: () => number, gap: number, runoff: Runoff | null = null): Shape | null {
  const shape = composeLap(s, rng, gap, runoff);
  return shape && clear(tracePath(shape, 14), gap) ? shape : null;
}

/** What a shape is like, from its geometry alone. */
export interface ShapeMetrics {
  length: number;
  corners: number;
  slow: number;
  medium: number;
  fast: number;
  longestStraight: number;
  startStraight: number;
  brakingPoints: number;
  /** The lap's greatest extent as a share of its length: small for a compact lap. */
  spread: number;
  /** Share of the lap that has another part of it within 120 m. */
  folded: number;
  /** Share of the smallest outline without a dent round the lap that the lap encloses. */
  hull: number;
  /** Degrees turned, either way, per kilometre. */
  turning: number;
}

/** A part of the lap with another part this near (metres) is folded back on it. */
const NEAR = 120;

/** The rough speeds are taken this much higher for the depth of run-off they ask: the real lap, on its racing line, is quicker than the estimate. */
const RUNOFF_SPEED = 1.2;

/**
 * Each arc's speed, the highest speed on the straight into it, and the straights (the one after each vertex). An
 * arc is taken on the line a car takes through the corner it is part of, on a road of this width.
 */
function shapeSpeeds(shape: Shape, vehicle: VehicleClass | null, width: number): { corner: number[]; into: number[]; straights: number[] } {
  const v = shape.v;
  const n = v.length;
  const { tangent, edge } = turns(v);
  const pace = paceOf(vehicle);
  const straights = v.map((_, i) => edge[i] - tangent[i] - tangent[(i + 1) % n]);
  const turn = new Array<number>(n).fill(0);
  for (const g of cornerGroups(v)) for (let i = g.from; ; i = (i + 1) % n) {
    turn[i] = g.turn;
    if (i === g.to) break;
  }
  const corner = v.map((p, i) => Math.min(pace.top, pace.corner(lineRadius(p.r, turn[i], width))));
  const into = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) into[(i + 1) % n] = peakSpeed(pace, corner[i], corner[(i + 1) % n], Math.max(0, straights[i]));
  return { corner, into, straights };
}

/**
 * Escape paths that would come out short, as the licence check looks at
 * them (core/licence.ts): straight on from where each corner is turned
 * into, and along the lap at its apex, as deep as the speed there asks,
 * until another part of the lap is in the way. Water and the edge of the
 * map are for the place to mind.
 */
export function shortRunoff(shape: Shape, width: number, vehicle: VehicleClass): number {
  const v = shape.v;
  const n = v.length;
  const { angle, tangent } = turns(v);
  const { corner, into } = shapeSpeeds(shape, vehicle, width);
  const path = tracePath(shape, 16);
  const count = path.x.length;
  const firstOf = new Array<number>(n).fill(-1);
  for (let k = 0; k < count; k++) if (path.corner[k] >= 0 && firstOf[path.corner[k]] < 0) firstOf[path.corner[k]] = k;
  const blocked = (ox: number, oy: number, dx: number, dy: number, at: number, need: number): boolean => {
    // From the middle of the track: half its width out, the run-off, and on to the middle of the part in the way.
    const reach = need + width + 4;
    const side = width / 2 + 3 + 8;
    for (let k = 0; k < count; k++) {
      const along = mod(path.s[k] - at, path.length);
      if (along < 300 || path.length - along < 300) continue;
      const rx = path.x[k] - ox, ry = path.y[k] - oy;
      const f = rx * dx + ry * dy;
      if (f > 0 && f < reach && Math.abs(rx * dy - ry * dx) < side) return true;
    }
    return false;
  };
  let short = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(angle[i]) < 0.17 || v[i].r >= 300 || firstOf[i] < 0) continue;
    const p = v[mod(i - 1, n)];
    const c = v[i];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y);
    const dx = (c.x - p.x) / l1, dy = (c.y - p.y) / l1;
    const tx = c.x - dx * tangent[i], ty = c.y - dy * tangent[i];
    const at = path.s[firstOf[i]];
    if (blocked(tx, ty, dx, dy, at, requiredRunoff(into[i] * RUNOFF_SPEED, vehicle.licence.body))) short++;
    const sign = Math.sign(angle[i]) || 1;
    const cx = tx - dy * c.r * sign, cy = ty + dx * c.r * sign;
    const a = Math.atan2(ty - cy, tx - cx) + angle[i] / 2;
    const co = Math.cos(angle[i] / 2), si = Math.sin(angle[i] / 2);
    if (blocked(cx + c.r * Math.cos(a), cy + c.r * Math.sin(a), dx * co - dy * si, dx * si + dy * co, at + (c.r * Math.abs(angle[i])) / 2, requiredRunoff(corner[i] * RUNOFF_SPEED, vehicle.licence.body))) short++;
  }
  return short;
}

export function measureShape(shape: Shape, vehicle: VehicleClass | null = null, width = 12): ShapeMetrics {
  const v = shape.v;
  const n = v.length;
  let slow = 0, medium = 0, fast = 0;
  // (By the radius the middle of a corner's turning is made at, as the mix of real circuits is counted, and as the track will read it.)
  for (const c of cornersOf(v)) {
    const read = c.middle * READS_WIDER;
    if (read < SLOW_BELOW) slow++;
    else if (read > FAST_ABOVE) fast++;
    else medium++;
  }
  // Heavy braking: the speed reached on the straight into a corner, against the speed the corner takes.
  const { corner, into, straights } = shapeSpeeds(shape, vehicle, width);
  let braking = 0;
  for (let i = 0; i < n; i++) if (into[i] - corner[i] >= HEAVY_BRAKING) braking++;
  // A straight runs on through a corner too slight to be one (under 12 degrees), as the analysis will read it.
  const { angle } = turns(v);
  const slight = (i: number) => Math.abs(angle[i]) < 0.21;
  const run = (i: number) => {
    let length = straights[i];
    for (let k = i, guard = 0; slight(k) && guard < n; k = mod(k - 1, n), guard++) length += straights[mod(k - 1, n)];
    for (let k = (i + 1) % n, guard = 0; slight(k) && guard < n; k = (k + 1) % n, guard++) length += straights[k];
    return length;
  };
  const runs = v.map((_, i) => run(i));
  const path = tracePath(shape, 25);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < path.x.length; k++) {
    x0 = Math.min(x0, path.x[k]);
    x1 = Math.max(x1, path.x[k]);
    y0 = Math.min(y0, path.y[k]);
    y1 = Math.max(y1, path.y[k]);
  }
  const grid = cells(path, NEAR);
  let folded = 0;
  for (let i = 0; i < path.x.length; i++) if (hasNeighbour(path, grid, NEAR, i, NEAR, 2.5 * NEAR)) folded++;
  return {
    length: lapLength(v), corners: slow + medium + fast, slow, medium, fast,
    // (The straights as the track will read them.)
    longestStraight: Math.max(0, Math.max(...runs) - STRAIGHT_CREEP), startStraight: Math.max(0, runs[shape.start] - STRAIGHT_CREEP), brakingPoints: braking,
    spread: Math.hypot(x1 - x0, y1 - y0) / path.length, folded: folded / path.x.length, hull: hullShare(path),
    turning: (angle.reduce((a, x) => a + Math.abs(x), 0) * 180) / Math.PI / (path.length / 1000),
  };
}

/**
 * How far a shape is from what was asked, on its geometry alone: 0 is all of
 * it met. What a slider asks in its middle is what real circuits have
 * (core/lapComposer.ts).
 */
export function scoreShape(m: ShapeMetrics, shape: Shape, s: GeneratorSettings): number {
  const wanted = cornersWanted(s);
  const mix = mixWanted(s);
  const count = Math.max(1, m.corners);
  let score = 4 * ((m.corners - wanted) / wanted) ** 2;
  score += 2 * ((m.slow / count - mix.slow) ** 2 + (m.medium / count - mix.medium) ** 2 + (m.fast / count - mix.fast) ** 2);
  score += 2 * ((m.longestStraight - s.longestStraight) / s.longestStraight) ** 2;
  // (A straight well over the longest asked is not what was asked at all.)
  if (m.longestStraight > 1.2 * s.longestStraight) score += 4 * (m.longestStraight / s.longestStraight - 1.2);
  if (m.startStraight < s.startStraight) score += 3 * ((s.startStraight - m.startStraight) / s.startStraight) ** 2;
  score += ((m.brakingPoints - s.brakingPoints) / Math.max(1, s.brakingPoints)) ** 2;
  score += 0.5 * ((m.spread - spreadWanted(s)) / 0.1) ** 2;
  // (How a lap lies on the ground counts for less than what it has in it: real circuits differ in it more than in
  // anything, and six that were all the middle one would be six of a kind.)
  score += 0.8 * ((m.folded - foldedWanted(s)) / 0.2) ** 2;
  score += 0.5 * ((m.hull - hullWanted(s)) / 0.2) ** 2;
  for (const f of ['hairpin', 'chicane', 'esses', 'sweeper'] as const) if (s[f] && !shape.made[f]) score += 1.5;
  return score;
}

// ---- the place -------------------------------------------------------------------

export interface Site {
  x: number;
  y: number;
  /** Radians the shape is turned by. */
  turn: number;
  /** How far the place is from what was asked: 0 is all of it met. */
  cost: number;
  /** Height difference of the ground under the lap there, and its steepest slope along the lap. */
  range: number;
  steepest: number;
  wet: number;
  wooded: number;
}

/**
 * Room between the middles of two parts of the lap where no licence asks
 * for run-off: the width and 16 m (the checks want 10 m of ground between
 * two edges), and up to 32 m more for a lap that does not fold back.
 */
export function gapFor(s: GeneratorSettings): number {
  return s.width + 16 + 32 * (1 - s.foldBack);
}

/** A track keeps this far from the edge of the map. */
const MAP_MARGIN = 130;

/**
 * The steepest slope a place may have along the lap before it counts
 * against it: 6%, and more for a lap that is to climb a lot (it goes up
 * the height asked and down again, and not evenly), up to 16%. The checks
 * warn from 12% and refuse a track over 18%.
 */
function steepLimit(s: GeneratorSettings): number {
  return clamp((4.4 * s.heightDifference) / s.length, 0.06, 0.16);
}

/**
 * The best place on the map for a shape: every centre on a grid, turned
 * twelve ways. Null when the lap is too big for the map, or there is no dry
 * place for it.
 */
export function findSite(shape: Shape, hm: Heightmap, s: GeneratorSettings, woods: (x: number, y: number) => number): Site | null {
  const path = tracePath(shape, 45);
  const n = path.x.length;
  const c = centroid(path.x.map((x, i) => ({ x, y: path.y[i] })));
  const px = path.x.map((x) => x - c.x);
  const py = path.y.map((y) => y - c.y);
  let reach = 0;
  for (let i = 0; i < n; i++) reach = Math.max(reach, Math.hypot(px[i], py[i]));
  const lo = reach + MAP_MARGIN;
  const hi = hm.extent - reach - MAP_MARGIN;
  if (hi < lo) return null;
  const stepXY = Math.max(110, (hi - lo) / 22);
  const hasWater = Number.isFinite(hm.waterLevel);
  const steep = steepLimit(s);
  const h = new Float64Array(n);
  // Where the grid stands: the 250 m of the start straight that end where the line is, 320 m short of its end.
  const onStart = path.straight.map((e) => e === shape.start);
  let startEnd = 0;
  for (let i = 0; i < n; i++) if (onStart[i]) startEnd = Math.max(startEnd, path.s[i]);
  const onGrid = onStart.map((on, i) => on && startEnd - path.s[i] > 250 && startEnd - path.s[i] < 600);
  const gridKnown = onGrid.filter(Boolean).length >= 3;
  // Built to a licence: the ground straight on from where each corner is turned into, 60 and 105 m on, which is to be dry too.
  const beyond: number[] = [];
  if (s.licence && hasWater) {
    const { angle, tangent } = turns(shape.v);
    const m = shape.v.length;
    for (let i = 0; i < m; i++) {
      if (Math.abs(angle[i]) < 0.17 || shape.v[i].r >= 300) continue;
      const p = shape.v[mod(i - 1, m)], q = shape.v[i];
      const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const dx = (q.x - p.x) / l, dy = (q.y - p.y) / l;
      for (const far of [60, 105]) beyond.push(q.x - dx * tangent[i] + dx * far - c.x, q.y - dy * tangent[i] + dy * far - c.y);
    }
  }
  const evaluate = (cx: number, cy: number, turn: number): Site | null => {
    const co = Math.cos(turn), si = Math.sin(turn);
    let min = Infinity, max = -Infinity, wet = 0, wooded = 0;
    for (let i = 0; i < n; i++) {
      const x = cx + px[i] * co - py[i] * si;
      const y = cy + px[i] * si + py[i] * co;
      const z = sampleHeight(hm, x, y);
      h[i] = z;
      if (z < min) min = z;
      if (z > max) max = z;
      if (hasWater && z < hm.waterLevel + 0.6) wet++;
      if (s.avoidWoods && woods(x, y) > 0.5) wooded++;
    }
    if (s.avoidWater && wet) return null;
    // Slopes along the lap, over two steps so that one bump does not count; and the steepest where the grid stands.
    let steepest = 0, grid = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 2) % n;
      const run = mod(path.s[j] - path.s[i], path.length) || 1;
      const g = Math.abs(h[j] - h[i]) / run;
      if (g > steepest) steepest = g;
      const next = (i + 1) % n;
      if (gridKnown ? onGrid[i] && onGrid[next] : onStart[i] && onStart[next]) grid = Math.max(grid, Math.abs(h[next] - h[i]) / (mod(path.s[next] - path.s[i], path.length) || 1));
    }
    const range = max - min;
    let cost = ((range - s.heightDifference) / Math.max(12, 0.35 * s.heightDifference + 8)) ** 2;
    cost += Math.max(0, (steepest - steep) / 0.03) ** 2;
    // (A licence takes a grid of 2% at most: a place that has more is nearly as bad as none.)
    cost += s.licence ? 8 * Math.max(0, (grid - 0.015) / 0.008) ** 2 : 0.5 * Math.max(0, (grid - 0.02) / 0.01) ** 2;
    cost += 3 * (wet / n) + 4 * (wooded / n);
    // (Water where a car that misses a corner would end up: each such place fails the licence.)
    for (let i = 0; i < beyond.length; i += 2) {
      if (sampleHeight(hm, cx + beyond[i] * co - beyond[i + 1] * si, cy + beyond[i] * si + beyond[i + 1] * co) < hm.waterLevel + 0.6) cost += 0.4;
    }
    return { x: cx, y: cy, turn, cost, range, steepest, wet: wet / n, wooded: wooded / n };
  };
  let best: Site | null = null;
  for (let t = 0; t < 12; t++) {
    const turn = (t / 12) * Math.PI * 2;
    for (let cy = lo; cy <= hi + 1e-6; cy += stepXY) {
      for (let cx = lo; cx <= hi + 1e-6; cx += stepXY) {
        const site = evaluate(cx, cy, turn);
        if (site && (!best || site.cost < best.cost)) best = site;
      }
    }
  }
  if (!best) return null;
  // A closer look round the best: half a grid step either way, and a little turned.
  for (let pass = 0; pass < 2; pass++) {
    const d = stepXY / (pass ? 6 : 2.5);
    const from: Site = best;
    for (const dt of [-0.12, 0, 0.12]) {
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const x = Math.max(lo, Math.min(hi, from.x + i * d));
          const y = Math.max(lo, Math.min(hi, from.y + j * d));
          const site = evaluate(x, y, from.turn + dt / (pass + 1));
          if (site && site.cost < best.cost) best = site;
        }
      }
    }
  }
  return best;
}

// ---- the track -------------------------------------------------------------------

/** What a generated track turned out as, measured on the track as built. */
export interface TrackFigures {
  length: number;
  corners: number;
  left: number;
  right: number;
  heightDifference: number;
  steepest: number;
  longestStraight: number;
  startStraight: number;
  brakingPoints: number;
  /** Lap time (seconds) and top speed (m/s) of the class it is for. */
  lapTime: number;
  topSpeed: number;
  warnings: number;
  direction: 'clockwise' | 'anticlockwise';
  /** The licence the class needs, whether the track would get it, and what it fails on (when it was built to a licence). */
  licence: { needs: string; passes: boolean; failures: string[] } | null;
}

export interface GeneratedTrack {
  /** The seed of this one track within the set. */
  seed: string;
  design: TrackDesign;
  /** Where the start line goes. */
  startFinish: { x: number; y: number };
  figures: TrackFigures;
  /** The lap's centre line on the map, for drawing it small: x, y, x, y... */
  outline: number[];
  /** What could not be met, in words. */
  notes: string[];
  /** How far it is from what was asked: the lower the better. */
  score: number;
}

export interface GeneratorResult {
  tracks: GeneratedTrack[];
  /** What was changed in the request, and what the map could not give. */
  notes: string[];
}

export interface GeneratorContext {
  heightmap: Heightmap;
  /** The terrain's seed, for where its woods are. */
  terrainSeed: string;
  vehicles: readonly VehicleClass[];
}

/** Shapes drawn, shapes tried on the map, and tracks built, per track offered. */
const DRAWN = 24;
/** Laps to choose from, per track offered, before the drawing stops. */
const ENOUGH = 8;
const PLACED = 2.4;
const BUILT = 1.6;
/** What an escape path that would be too short costs a shape built to a licence. */
const SHORT_RUNOFF = 0.5;
/** What a required point of the licence check that fails costs a built track: more than the shapes differ by, so that those that pass come first. */
const FAILED_CHECK = 1.5;

/** The grid's width is reached this many metres before the back of the grid, held this far past the first corner, and eased in and out over this length per metre of width. */
const WIDE_BEFORE = 45;
const WIDE_AFTER = 110;
/** A corner that turns this much (radians: 55 degrees) is one the licence check takes for a corner, whatever the building does to it. */
const FIRST_CORNER_TURN = 0.96;
const EASE_PER_METRE = 25;

/** The control points of a shape at its place: its corners as arcs of points, its straights held straight by a point near each end; wider where the grid stands. */
function toDesign(shape: Shape, site: Site, s: GeneratorSettings, needs: ClassNeeds | null): { design: TrackDesign; startFinish: { x: number; y: number }; outline: number[] } {
  const gridWidth = needs ? Math.max(s.width, needs.gridWidth) : s.width;
  const lineToCorner = needs?.lineToCorner ?? 250 + CORNER_CREEP;
  const v = shape.v;
  const n = v.length;
  const { angle, tangent, edge } = turns(v);
  const path = tracePath(shape, 45);
  const c = centroid(path.x.map((x, i) => ({ x, y: path.y[i] })));
  const co = Math.cos(site.turn), si = Math.sin(site.turn);
  const place = (x: number, y: number) => ({ x: site.x + (x - c.x) * co - (y - c.y) * si, y: site.y + (x - c.x) * si + (y - c.y) * co });
  // The first corner, as the licence check has it: the first to turn 45 degrees at under 300 m of radius. The wide
  // stretch runs past the first that surely does, kinks before it included, and on through any corner the same way
  // that follows at once (the analysis reads those as one).
  const between = (i: number) => edge[i] - tangent[i] - tangent[(i + 1) % n];
  // (A corner may be several arcs: it is the corner that turns 55 degrees, not any one of them.)
  const corners = cornerGroups(v).sort((p, q) => mod(p.from - shape.start - 1, n) - mod(q.from - shape.start - 1, n));
  let first = (corners.find((g) => g.turn >= FIRST_CORNER_TURN && g.radius < 250) ?? corners[0]).to;
  for (let k = 0; k < n; k++) {
    const next = (first + 1) % n;
    if (next === shape.start || Math.sign(angle[next]) !== Math.sign(angle[first]) || between(first) > 80) break;
    first = next;
  }
  // Every point with its distance round the lap, from the corner at vertex 0.
  const pts: { x: number; y: number; d: number }[] = [];
  let dist = 0;
  let line = 0;
  let wideEnd = 0;
  let startFinish = { x: 0, y: 0 };
  /** Places on straights where the width starts or stops changing, to be given a point of their own: [distance, x, y]. */
  const straights: { from: number; len: number; x: number; y: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = v[mod(i - 1, n)];
    const cv = v[i];
    const q = v[(i + 1) % n];
    const l1 = Math.hypot(cv.x - p.x, cv.y - p.y), l2 = Math.hypot(q.x - cv.x, q.y - cv.y);
    const d1x = (cv.x - p.x) / l1, d1y = (cv.y - p.y) / l1;
    const d2x = (q.x - cv.x) / l2, d2y = (q.y - cv.y) / l2;
    const t = tangent[i];
    const t1x = cv.x - d1x * t, t1y = cv.y - d1y * t;
    const sign = Math.sign(angle[i]) || 1;
    const cx = t1x - d1y * cv.r * sign, cy = t1y + d1x * cv.r * sign;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    // A point every 18 degrees or so round the arc, its ends included, and no two nearer than 5 m; a slight kink is one
    // point at its middle. (The tight arc at the apex of a slow corner is short: it keeps its two ends, or the line
    // through the points would cut it.)
    const arc = cv.r * Math.abs(angle[i]);
    // (Where one arc runs straight into the next, its last point is the next one's first: put down once.)
    const put = (a: number, d: number) => {
      const x = cx + cv.r * Math.cos(a), y = cy + cv.r * Math.sin(a);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(x - last.x, y - last.y) > 4) pts.push({ x, y, d });
    };
    if (arc < 14 && Math.abs(angle[i]) < 0.3) {
      put(a0 + angle[i] / 2, dist + arc / 2);
    } else {
      const parts = Math.max(1, Math.min(Math.ceil(Math.abs(angle[i]) / 0.32), Math.floor(arc / 5)));
      for (let k = 0; k <= parts; k++) put(a0 + (angle[i] * k) / parts, dist + (arc * k) / parts);
    }
    dist += arc;
    if (i === first) wideEnd = dist + WIDE_AFTER;
    // The straight after it: a point near each end keeps it straight.
    const len = l2 - t - tangent[(i + 1) % n];
    const t2x = cv.x + d2x * t, t2y = cv.y + d2y * t;
    const inset = Math.min(35, len * 0.3);
    if (len > 50) {
      pts.push({ x: t2x + d2x * inset, y: t2y + d2y * inset, d: dist + inset });
      pts.push({ x: t2x + d2x * (len - inset), y: t2y + d2y * (len - inset), d: dist + len - inset });
    }
    straights.push({ from: dist, len, x: t2x, y: t2y, dx: d2x, dy: d2y });
    if (i === shape.start) {
      // The line: the grid behind it on the straight and the first corner far enough ahead; where the straight has no room for both, whichever the licence requires, and else the grid.
      const behind = GRID_LENGTH + BEHIND_GRID;
      const at = len >= behind + lineToCorner ? len - lineToCorner
        : needs?.cornerFirst ? Math.max(Math.min(60, len / 2), len - lineToCorner)
          : Math.max(len * 0.5, Math.min(len - 60, behind));
      line = dist + at;
      const on = place(t2x + d2x * at, t2y + d2y * at);
      startFinish = { x: Math.round(on.x * 10) / 10, y: Math.round(on.y * 10) / 10 };
    }
    dist += len;
  }
  const lap = dist;
  // Where the grid stands the track is as wide as the grid needs, from behind the last row to past the first corner, eased in and out.
  const extra = gridWidth - s.width;
  const ease = extra * EASE_PER_METRE;
  const wideFrom = line - GRID_LENGTH - WIDE_BEFORE;
  if (wideEnd < line) wideEnd += lap;
  const widthAt = (d: number): number => {
    if (extra <= 0) return s.width;
    // Distance from the wide stretch: inside it, before it or after it, the short way round.
    let before = mod(wideFrom - d, lap);
    let after = mod(d - wideEnd, lap);
    if (mod(d - wideFrom, lap) <= mod(wideEnd - wideFrom, lap)) return gridWidth;
    if (before > lap / 2) before = Infinity;
    if (after > lap / 2) after = Infinity;
    const out = Math.min(before, after);
    return out >= ease ? s.width : gridWidth - (extra * out) / ease;
  };
  if (extra > 0) {
    // A point where the width starts and stops changing, when that is on a straight and no point is near.
    for (const at of [wideFrom - ease, wideFrom, wideEnd, wideEnd + ease]) {
      const d = mod(at, lap);
      const on = straights.find((x) => d > x.from + 25 && d < x.from + x.len - 25);
      if (on && !pts.some((q) => Math.abs(q.d - d) < 25)) pts.push({ x: on.x + on.dx * (d - on.from), y: on.y + on.dy * (d - on.from), d });
    }
    pts.sort((a, b) => a.d - b.d);
  }
  const points = pts.map((q): ControlPoint => {
    const on = place(q.x, q.y);
    return { x: Math.round(on.x * 10) / 10, y: Math.round(on.y * 10) / 10, width: Math.round(widthAt(q.d) * 10) / 10 };
  });
  const fine = tracePath(shape, 25);
  const outline: number[] = [];
  for (let k = 0; k < fine.x.length; k++) {
    const q = place(fine.x[k], fine.y[k]);
    outline.push(Math.round(q.x), Math.round(q.y));
  }
  return { design: { points, defaultWidth: s.width, grading: { ...DEFAULT_GRADING } }, startFinish, outline };
}

/** Heavy braking points of a lap: where the speed falls by 25 m/s (90 km/h) or more in one go. */
function brakingPoints(v: Float64Array): number {
  const n = v.length;
  let low = 0;
  for (let k = 1; k < n; k++) if (v[k] < v[low]) low = k;
  let count = 0;
  let peak = v[low];
  let falling = false;
  for (let i = 1; i <= n; i++) {
    const k = (low + i) % n;
    const prev = v[(low + i - 1) % n];
    if (v[k] < prev - 1e-9) {
      if (!falling) {
        falling = true;
        peak = prev;
      }
    } else if (falling && v[k] > prev + 1e-9) {
      if (peak - prev >= 25) count++;
      falling = false;
    }
  }
  return count;
}

/**
 * Generates tracks to order on a terrain. The same settings on the same
 * terrain give the same tracks. `pause` is awaited between the stages, so
 * that a page can draw; `progress` says how far it is.
 */
export async function generateTracks(
  request: GeneratorSettings, ctx: GeneratorContext, hooks: { pause?: () => Promise<void>; progress?: (done: number, of: number, doing: string) => void } = {},
): Promise<GeneratorResult> {
  const vehicle = ctx.vehicles.find((x) => x.id === request.vehicleId) ?? ctx.vehicles[0] ?? null;
  const { settings: s, needs, notes } = resolveSettings(request, vehicle);
  const hm = ctx.heightmap;
  const gap = gapFor(s);
  // Built to a licence: the ground a car that misses a corner needs is kept free as the lap is drawn.
  const runoff: Runoff | null = needs && vehicle ? { width: s.width, pace: paceOf(vehicle), depth: (v) => requiredRunoff(v * RUNOFF_SPEED, vehicle.licence.body) } : null;
  // (A lap asked at the least length the licence takes is drawn a hair longer, not to fall short by a metre.)
  const drawn2 = needs && s.length >= needs.minLength && s.length < needs.minLength * 1.004 ? { ...s, length: needs.minLength * 1.004 } : s;
  // How many are built to choose from: fewer to spare on a long lap, where building one takes several times as long.
  const toBuild = s.candidates + Math.ceil(s.candidates * (BUILT - 1) * clamp(6000 / s.length, 0.3, 1));
  const steps = 2 + toBuild;
  let done = 0;
  const tick = async (doing: string) => {
    hooks.progress?.(Math.min(done++, steps - 1), steps, doing);
    await hooks.pause?.();
  };
  // Draw, and keep the best on shape.
  await tick('Drawing laps');
  const rng = seededRandom(`generator:${s.seed}`);
  const drawn: { shape: Shape; score: number; seed: string }[] = [];
  // (Fewer of a long lap, which takes several times as long to draw.)
  const fewer = clamp(8000 / s.length, 0.35, 1);
  const draws = Math.round(DRAWN * fewer) * s.candidates;
  // (Where few draws work out, as at the ends of the sliders, more are made: up to four times as many, until there are enough to choose from.)
  for (let i = 0; i < 4 * draws && (i < draws || drawn.length < ENOUGH * fewer * s.candidates); i++) {
    const shape = drawShape(drawn2, rng, gap, runoff);
    if (!shape) continue;
    let score = scoreShape(measureShape(shape, vehicle, s.width), shape, s);
    if (needs && vehicle) score += SHORT_RUNOFF * shortRunoff(shape, s.width, vehicle);
    drawn.push({ shape, score, seed: `${s.seed}-${i + 1}` });
  }
  drawn.sort((a, b) => a.score - b.score);
  if (!drawn.length) return { tracks: [], notes: [...notes, 'No lap could be drawn to these settings: try a longer lap, fewer features or less folding back.'] };
  // Find each a place.
  await tick('Looking over the map');
  const woods = woodsAt(hm, ctx.terrainSeed);
  const placed: { shape: Shape; site: Site; score: number; seed: string }[] = [];
  let fits = false;
  for (const d of drawn.slice(0, Math.ceil(s.candidates * PLACED))) {
    const site = findSite(d.shape, hm, s, woods);
    if (site) {
      fits = true;
      placed.push({ shape: d.shape, site, score: d.score + site.cost, seed: d.seed });
    }
  }
  if (!placed.length) {
    return { tracks: [], notes: [...notes, fits ? 'No place was found.' : s.avoidWater ? 'There is no dry place on this map big enough for a lap of this length: try a shorter lap, a more compact one, or allow water.' : 'This map is too small for a lap of this length.'] };
  }
  placed.sort((a, b) => a.score - b.score);
  // Build the best and measure them.
  const tracks: GeneratedTrack[] = [];
  let passing = 0;
  for (const p of placed) {
    // Enough built to choose from; built to a licence, on until there are enough that pass, as far as the places found go.
    if (tracks.length >= toBuild && (!needs || passing >= s.candidates)) break;
    await tick(`Building track ${tracks.length + 1}`);
    const { design, startFinish, outline } = toDesign(p.shape, p.site, s, needs);
    const raw = buildTrack(design, (x, y) => sampleHeight(hm, x, y));
    if (!raw) continue;
    const issues = validateTrack(raw, hm, design.grading);
    if (issues.some((i) => i.severity === 'error')) continue;
    const start = placeStartFinish(raw, startFinish);
    const t = rotateTrack(raw, start.station);
    const metrics = analyseTrack(t);
    let lapTime = NaN, topSpeed = NaN, braking = 0;
    let licence: TrackFigures['licence'] = null;
    if (vehicle && needs) {
      // Built to a licence: the analysis as the app will do it, for the verdict, with the classes that need this
      // licence (the others' laps have no part in it, and a lap of each is most of the work).
      const classes = ctx.vehicles.filter((x) => x.licence.body === vehicle.licence.body && x.licence.grade === vehicle.licence.grade);
      const performance = analysePerformance(t, classes);
      const facilities = placeFacilities({
        track: t, startFinish: start, performance, vehicles: classes, heightAt: (x, y) => sampleHeight(hm, x, y), waterLevel: hm.waterLevel, extent: hm.extent,
        overrides: { startFinish },
      });
      const verdict = assessLicence({ track: t, metrics, issues, performance, facilities, heightmap: hm, vehicles: classes });
      const body = vehicle.licence.body === 'FIM' ? verdict.fim : verdict.fia;
      const failures = body.results.find((r) => r.grade === vehicle.licence.grade)?.failures.filter((f) => f.level === 'required').map((f) => `${f.label}: ${f.detail}`) ?? [];
      licence = { needs: `${vehicle.licence.body} ${vehicle.licence.grade}`, passes: failures.length === 0, failures };
      const lap = performance.laps.find((l) => l.vehicleId === vehicle.id);
      if (lap) {
        lapTime = lap.time;
        topSpeed = Math.max(...lap.v);
        braking = brakingPoints(lap.v);
      }
    } else if (vehicle) {
      const lap = simulateLap(t, computeRacingLine(t), vehicle);
      lapTime = lap.time;
      topSpeed = Math.max(...lap.v);
      braking = brakingPoints(lap.v);
    }
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const own: string[] = [];
    const off = metrics.elevationRange - s.heightDifference;
    if (Math.abs(off) > Math.max(15, 0.4 * s.heightDifference)) {
      own.push(off > 0
        ? `The map has no ground this flat for a lap this size: ${Math.round(metrics.elevationRange)} m of height, where ${Math.round(s.heightDifference)} m was asked.`
        : `The map gives a lap this size no more height than this without slopes too steep: ${Math.round(metrics.elevationRange)} m, where ${Math.round(s.heightDifference)} m was asked.`);
    }
    if (p.site.wet > 0) own.push('Part of the lap runs through water.');
    if (s.avoidWoods && p.site.wooded > 0.15) own.push(`About ${Math.round(p.site.wooded * 100)}% of the lap runs through woods.`);
    for (const f of ['hairpin', 'chicane', 'esses', 'sweeper'] as const) if (s[f] && !p.shape.made[f]) own.push(`No room was found for ${f === 'esses' ? 'the esses' : `the ${f}`}.`);
    // The straight the line is on, as the analysis has it (the line is station 0).
    const onLine = metrics.straights.find((st) => st.end < st.start || st.start === 0);
    const figures: TrackFigures = {
      length: metrics.length, corners: metrics.corners.length, left: metrics.leftTurns, right: metrics.rightTurns,
      heightDifference: metrics.elevationRange, steepest: Math.max(metrics.maxUphill, Math.abs(metrics.maxDownhill)),
      longestStraight: metrics.longestStraight?.length ?? 0, startStraight: onLine?.length ?? measureShape(p.shape).startStraight, brakingPoints: braking,
      lapTime, topSpeed, warnings, direction: metrics.direction, licence,
    };
    if (licence?.passes) passing++;
    const score = p.score + 0.25 * warnings + (licence ? FAILED_CHECK * licence.failures.length : 0);
    tracks.push({ seed: p.seed, design, startFinish, figures, outline, notes: own, score });
  }
  tracks.sort((a, b) => a.score - b.score);
  hooks.progress?.(steps, steps, 'Done');
  if (!tracks.length) notes.push('None of the laps drawn could be built here without an error: try another seed, or ask for less.');
  return { tracks: tracks.slice(0, s.candidates), notes };
}
