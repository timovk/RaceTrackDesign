/**
 * The track generator: circuits made to order on the ground that is there.
 *
 * A lap is drawn as a polygon with rounded corners, in metres: a loop of a
 * few corners, long and thin or round; a chicane, a run of esses and a
 * hairpin where they are asked for; folds, where the lap turns in and comes
 * back in pairs of legs, from wide lobes to rows of parallel straights
 * joined by turns right round; a long sweeper; and bends until it has the
 * corners it should. Every corner takes a radius from the slow, the medium
 * or the fast range, by the mix asked for. The lap is drawn on a loop of
 * the size that makes it as long as asked, so that what is on it keeps its
 * own size.
 *
 * What is asked is what is drawn, to the ends of the sliders: a lap of
 * corner after corner or of four, one loop or all folds, a kilometre or
 * twenty-five.
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
import { simulateLap } from './lapSim.ts';
import { assessLicence, requiredRunoff } from './licence.ts';
import { analysePerformance } from './performance.ts';
import { computeRacingLine } from './racingLine.ts';
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
  longestStraight: 900, startStraight: 600, brakingPoints: 3, slow: 1, medium: 1.3, fast: 1,
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
    settings: { length: 5400, width: 14, heightDifference: 35, speed: 0.55, vehicleId: 'f1', licence: true, longestStraight: 1050, startStraight: 700, brakingPoints: 4, slow: 1, medium: 1.3, fast: 1, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.5, foldBack: 0.5, direction: 'clockwise' },
  },
  {
    id: 'road-course', name: 'Old road course', summary: 'Public roads closed for the day: narrow, long and fast, across the country and back.',
    settings: { length: 7200, width: 9, heightDifference: 70, speed: 0.8, vehicleId: 'f1-1950', licence: false, longestStraight: 1500, startStraight: 550, brakingPoints: 2, slow: 0.5, medium: 1, fast: 1.6, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.15, foldBack: 0.1, direction: 'clockwise' },
  },
  {
    id: 'street', name: 'Street circuit', summary: 'Short blocks and right angles: slow corners, short straights, a hairpin and a chicane.',
    settings: { length: 3400, width: 10, heightDifference: 15, speed: 0.25, vehicleId: 'f2', licence: false, longestStraight: 650, startStraight: 420, brakingPoints: 4, slow: 2, medium: 1, fast: 0.3, hairpin: true, chicane: true, esses: false, sweeper: false, compact: 0.8, foldBack: 0.7, direction: 'clockwise' },
  },
  {
    id: 'club', name: 'Club circuit', summary: 'A short lap for touring cars and track days, folded onto a small site.',
    settings: { length: 2600, width: 11, heightDifference: 15, speed: 0.45, vehicleId: 'tcr', licence: false, longestStraight: 550, startStraight: 400, brakingPoints: 2, slow: 1.1, medium: 1.4, fast: 0.6, hairpin: true, chicane: false, esses: false, sweeper: false, compact: 0.75, foldBack: 0.55, direction: 'clockwise' },
  },
  {
    id: 'bikes', name: 'Motorcycle circuit', summary: 'Flowing and wide for MotoGP: medium and fast corners, no straight too long.',
    settings: { length: 4600, width: 13, heightDifference: 30, speed: 0.6, vehicleId: 'motogp', licence: true, longestStraight: 900, startStraight: 600, brakingPoints: 3, slow: 0.8, medium: 1.3, fast: 1.2, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.55, foldBack: 0.5, direction: 'clockwise' },
  },
  {
    id: 'speed', name: 'High-speed circuit', summary: 'Long straights broken by chicanes, and fast curves between them.',
    settings: { length: 5800, width: 14, heightDifference: 10, speed: 0.95, vehicleId: 'hypercar', licence: true, longestStraight: 1700, startStraight: 900, brakingPoints: 3, slow: 0.5, medium: 0.8, fast: 1.8, hairpin: false, chicane: true, esses: false, sweeper: true, compact: 0.3, foldBack: 0.15, direction: 'clockwise' },
  },
  {
    id: 'mountain', name: 'Mountain course', summary: 'Up the hill and down again: a big height difference, as far as the map has one.',
    settings: { length: 6000, width: 11, heightDifference: 160, speed: 0.5, vehicleId: 'gt3', licence: false, longestStraight: 800, startStraight: 500, brakingPoints: 3, slow: 1.2, medium: 1.4, fast: 0.8, hairpin: true, chicane: false, esses: true, sweeper: true, compact: 0.35, foldBack: 0.4, direction: 'clockwise' },
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
  /** Room to keep between two parts of the track, centre to centre, for run-off and barriers. */
  gap: number;
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
    return { minLength: 3500, maxLength: 10000, minWidth: 12, gridWidth: 14, startStraight: a ? GRID_LENGTH + BEHIND_GRID + lineToCorner : 200 + lineToCorner, maxStraight: 1000, lineToCorner, cornerFirst: true, gap: 70 };
  }
  const one = v.licence.grade === '1';
  const lineToCorner = 250 + CORNER_CREEP;
  return { minLength: one ? 3500 : 2000, maxLength: 20000, minWidth: 12, gridWidth: 15, startStraight: one ? GRID_LENGTH + BEHIND_GRID + lineToCorner : 450, maxStraight: 2000, lineToCorner, cornerFirst: false, gap: one ? 70 : v.licence.grade === '4' ? 50 : 60 };
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

type Feature = 'loop' | 'detour' | 'hairpin' | 'fold' | 'chicane' | 'esses' | 'sweeper' | 'kink';

interface Vertex {
  x: number;
  y: number;
  /** Corner radius, metres. */
  r: number;
  feature: Feature;
  /** The radius belongs to the feature and is not drawn from the mix. */
  fixed: boolean;
}

/** A lap as a polygon with rounded corners; `start` and `main` name the edges (from that vertex to the next) the start line and the longest straight are on. */
export interface Shape {
  v: Vertex[];
  start: number;
  main: number;
  made: { hairpin: boolean; chicane: boolean; esses: boolean; sweeper: boolean };
}

/** Radius ranges of slow, medium and fast corners, metres. */
export const CORNER_RADII = { slow: [18, 45], medium: [45, 120], fast: [120, 380] } as const;
/** A corner under this radius is slow, and over that one fast. */
const SLOW_BELOW = 45;
const FAST_ABOVE = 120;

const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Per vertex: the turn (radians, positive to the right), the length of straight its corner takes from each side, and the arc's length. */
function turns(v: readonly Vertex[]): { angle: number[]; tangent: number[]; edge: number[] } {
  const n = v.length;
  const angle: number[] = [];
  const tangent: number[] = [];
  const edge: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = v[mod(i - 1, n)];
    const c = v[i];
    const q = v[(i + 1) % n];
    const ax = c.x - p.x, ay = c.y - p.y, bx = q.x - c.x, by = q.y - c.y;
    const a = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    angle.push(a);
    tangent.push(c.r * Math.tan(Math.abs(a) / 2));
    edge.push(Math.hypot(bx, by));
  }
  return { angle, tangent, edge };
}

/** Shrinks radii until every corner fits on the straights either side of it. False when a corner would come out too tight to drive. */
function fit(v: Vertex[]): boolean {
  const n = v.length;
  const { angle, edge } = turns(v);
  // What a corner takes of the straight either side of it, at the radius it has now.
  const half = angle.map((a) => Math.tan(Math.abs(a) / 2));
  const tangent = (i: number) => v[i].r * half[i];
  for (let pass = 0; pass < 8; pass++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const room = edge[i] * 0.94;
      if (tangent(i) + tangent(j) <= room) continue;
      // The straight between two corners that do not fit on it: a corner that belongs to a feature keeps what it
      // has, as far as it can; of two alike, the smaller keeps its own up to half, and the other takes the rest.
      const first = v[i].fixed !== v[j].fixed ? v[i].fixed : tangent(i) <= tangent(j);
      const [a, b] = first ? [i, j] : [j, i];
      const keep = Math.min(tangent(a), room * (v[a].fixed !== v[b].fixed ? 0.9 : 0.5));
      v[a].r = keep / half[a];
      v[b].r = Math.min(v[b].r, (room - keep) / half[b]);
      ok = false;
    }
    if (ok) break;
  }
  for (let i = 0; i < n; i++) {
    if (tangent(i) + tangent((i + 1) % n) > edge[i] * 0.97) return false;
    // (A slight kink may have any radius; a real corner under 15 m is no corner for a racing car.)
    if (Math.abs(angle[i]) > 0.35 && v[i].r < 15) return false;
  }
  return true;
}

function lapLength(v: readonly Vertex[]): number {
  const { angle, tangent, edge } = turns(v);
  let l = 0;
  for (let i = 0; i < v.length; i++) l += edge[i] - tangent[i] - tangent[(i + 1) % v.length] + v[i].r * Math.abs(angle[i]);
  return l;
}

function centroid(v: readonly { x: number; y: number }[]): { x: number; y: number } {
  let x = 0, y = 0;
  for (const p of v) {
    x += p.x / v.length;
    y += p.y / v.length;
  }
  return { x, y };
}

/** No hairpin is tighter than this at its middle line, metres. */
const TIGHTEST = 17;

/**
 * A radius from the mix: slow, medium or fast by their weights, a sharp turn
 * more often a slow one, and a lap that is to be fast more often a fast one.
 * `low` (0 to 1) keeps it towards the tight end of its range, and makes it
 * a slow one more often: the turn at the end of a fold.
 */
function drawRadius(s: GeneratorSettings, rng: () => number, sharp: number, low = 0): number {
  const bias = 0.4 * Math.pow(5.5, s.speed);
  const w = [((s.slow * (0.5 + sharp)) / bias) * (1 + 8 * low * low), s.medium, s.fast * (1.4 - sharp) * bias];
  let pick = rng() * (w[0] + w[1] + w[2]);
  const kind = pick < w[0] ? 'slow' : (pick -= w[0]) < w[1] ? 'medium' : 'fast';
  const [lo, hi] = CORNER_RADII[kind];
  return lo * Math.pow(hi / lo, rng() * (1 - low));
}

/**
 * The corners of a lap as the analysis will count them: turns the same way
 * with no straight to speak of between them are one corner (the two ends of
 * a U-turn, say), and a turn of under 15 degrees is none.
 */
function cornersOf(v: readonly Vertex[]): { turn: number; radius: number }[] {
  const n = v.length;
  const { angle, tangent, edge } = turns(v);
  const joins = (i: number) => {
    const j = (i + 1) % n;
    return Math.sign(angle[i]) === Math.sign(angle[j]) && Math.abs(angle[i]) > 0.05 && Math.abs(angle[j]) > 0.05 && edge[i] - tangent[i] - tangent[j] < 40;
  };
  let first = 0;
  for (let i = 0; i < n; i++) {
    if (!joins(mod(i - 1, n))) {
      first = i;
      break;
    }
  }
  const out: { turn: number; radius: number }[] = [];
  for (let k = 0; k < n; k++) {
    let i = (first + k) % n;
    let turn = Math.abs(angle[i]);
    let radius = v[i].r;
    while (k < n - 1 && joins(i)) {
      k++;
      i = (first + k) % n;
      turn += Math.abs(angle[i]);
      radius = Math.min(radius, v[i].r);
    }
    if (turn >= 0.26) out.push({ turn, radius });
  }
  return out;
}

/** A lap as first drawn, before it is brought to length. */
interface Sketch {
  v: Vertex[];
  mainFrom: Vertex;
  startFrom: Vertex;
  made: Shape['made'];
  /** Length of the loop the lap was drawn on, before anything was added to it. */
  loop: number;
  /** Vertices whose edge to the next is plain road: no feature on it, and not one of the two straights. */
  plain: Vertex[];
}

/** Distance from a point to the stretch of line from a to b. */
function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}

/** Edge lengths the esses and the chicane are given, metres. */
const ESSES_EDGE = 600;
const CHICANE_EDGE = 390;

/**
 * One lap from its own streams of random numbers, on a loop of a given size:
 *
 * 1. The loop: a few corners round a middle, long and thin when the lap is
 *    to be spread out. Its length is what the folds leave over (`size`
 *    corrects it); one edge is as long as the longest straight needs
 *    (`reach` corrects that), one as long as the start straight (`lead`),
 *    and one each long enough for the esses and the chicane.
 * 2. The chicane and the esses go on their edges, and the hairpin on the
 *    longest that is left, unless the folds are to be hairpins themselves.
 * 3. Folds: from the longest free edge the lap turns in and comes back,
 *    again and again, each leg as far as it can go before it comes near
 *    another part of the lap: wide lobes with corners of their own when the
 *    lap is only to be compact, a comb of parallel legs joined by U-turns as
 *    tight as the gap allows when it is to fold back. The length to be
 *    folded is shared out evenly over the legs; what the inside has no room
 *    for goes on the next edge, or outward.
 * 4. A sweeper, then bends: single ones and runs of them until the lap has
 *    the corners it should, and one in any straight longer than the one
 *    that is to be the longest.
 * 5. Radii from the mix, made smaller where a corner does not fit.
 *
 * Null when a corner comes out too tight to drive.
 */
function sketch(s: GeneratorSettings, seed: number, gap: number, size: number, reach: number, lead: number): Sketch | null {
  const stream = (name: string) => seededRandom(`${seed}:${name}`);
  const between = (r: () => number, a: number, b: number) => a + (b - a) * r();
  const wanted = cornersWanted(s);
  const ownStart = s.startStraight <= s.longestStraight * 0.8;
  // An edge is a little longer than the straight on it: the corners at its ends take their share.
  const mainEdge = Math.min((s.longestStraight * 1.1 + 70) * reach, 0.47 * s.length);
  const startEdge = Math.min((s.startStraight * 1.1 + 70) * lead, 0.95 * mainEdge);
  // The share of the lap that turns inward: all of what folding back asks, and most of what compactness does.
  const folding = 0.78 * Math.max(s.foldBack, 0.6 * s.compact);
  // How far apart the legs of a fold stand, in turns of their own radius: side by side when the lap is to fold right back.
  const spacing = 1 + 1.6 * Math.pow(1 - s.foldBack, 1.5);
  const uTurns = folding > 0.05 && spacing < 1.35;
  // What goes on an edge of its own, as far as the lap has the length for it: the two straights first, then the
  // folds, the hairpin (unless the folds are hairpins themselves), the chicane and the esses.
  const outAndBack = 2 * mainEdge + Math.max(2.4 * gap, (0.3 - 0.22 * s.foldBack) * mainEdge);
  let least = mainEdge + (ownStart ? startEdge : 0);
  const fitsOn = (asked: boolean, edge: number) => {
    if (!asked || 1.08 * (least + edge) > 0.9 * s.length) return false;
    least += edge;
    return true;
  };
  const folded = fitsOn(folding > 0.05, 260);
  const ownHairpin = fitsOn(s.hairpin && !(uTurns && folded), 320);
  const chicane = fitsOn(s.chicane, CHICANE_EDGE);
  const esses = fitsOn(s.esses, ESSES_EDGE);
  const edgesNeeded = 1 + (ownStart ? 1 : 0) + (folded ? 1 : 0) + (ownHairpin ? 1 : 0) + (chicane ? 1 : 0) + (esses ? 1 : 0);
  // The loop: what the folds leave of the lap; at least the main edge out and back, close by when the lap is to fold; and room for what goes on its edges.
  const loop = Math.max(outAndBack, Math.max(s.length * (1 - folding), 1.08 * least) * size);

  // 1. The loop.
  const rl = stream('loop');
  const featureCorners = (s.hairpin ? 3 : 0) + (chicane ? 3 : 0) + (esses ? 4 : 0);
  // As long for its width as a lap that is to be spread out asks, or as a main edge that is most of its length makes it.
  const aspect = clamp(Math.max(1 + 5 * Math.pow(1 - s.compact, 2.3), (0.8 * mainEdge) / Math.max(1, loop / 2 - mainEdge)), 1, 14);
  const thin = aspect > 1.8;
  // As many corners as give it edges about as long as the main one (a long thin loop one more, to keep both its long
  // sides in pieces); enough edges for what is to go on them; and no more than the lap is to have corners.
  let count = clamp(
    Math.max(Math.min(Math.round((1.15 * loop) / mainEdge) + (aspect > 2.5 ? 1 : 0), Math.max(3, wanted - featureCorners)), Math.min(edgesNeeded, 7)),
    3, 10,
  );
  // A thin loop has two corners at each end, not one: a point there would be a turn right round on the spot.
  if (thin) count = Math.max(4, count + (count % 2));
  const v: Vertex[] = [];
  if (aspect > 2.6) {
    // Long and thin: two long sides, in pieces, and an end across each. (Corners round a middle, pulled this long, would leave ends that lie along the sides.)
    const a = Math.sqrt(aspect), b = 1 / Math.sqrt(aspect);
    const pieces = (count - 4) / 2 + 1;
    // Where the long sides are in pieces the whole loop bends, both sides together, by enough to make each piece a
    // straight of its own: 12 to 18 degrees, now one way and now the other.
    const first = rl() < 0.5 ? 1 : -1;
    const bend: number[] = [0];
    for (let m = 1; m < pieces; m++) bend.push(bend[m - 1] + (m % 2 ? first : -first) * ((2 * a) / pieces) * (0.21 + 0.11 * rl()));
    bend.push(bend[pieces - 1] + (pieces % 2 ? first : -first) * ((2 * a) / pieces) * 0.1 * (pieces > 1 ? 1 : 0));
    for (const side of [1, -1]) {
      for (let j = 0; j <= pieces; j++) {
        const inner = j > 0 && j < pieces;
        const at = side > 0 ? j : pieces - j;
        const x = (-a + (2 * a * j) / pieces + (rl() - 0.5) * (inner ? 0.2 : 0.1) * ((2 * a) / pieces)) * side;
        v.push({ x, y: bend[at] + side * b * (1 + (rl() - 0.5) * 0.3), r: 60, feature: 'loop', fixed: false });
      }
    }
  } else {
    const turn0 = thin ? (rl() - 0.5) * (Math.PI / count) * 0.5 : rl() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const a = turn0 + ((k + 0.5 + (rl() - 0.5) * (thin ? 0.3 : 0.6)) / count) * Math.PI * 2;
      const rho = 1 + (rl() - 0.5) * (thin ? 0.3 : 0.5);
      v.push({ x: rho * Math.cos(a) * Math.sqrt(aspect), y: (rho * Math.sin(a)) / Math.sqrt(aspect), r: 60, feature: 'loop', fixed: false });
    }
  }
  const edgeLength = (at: Vertex) => {
    const i = v.indexOf(at);
    return Math.hypot(v[(i + 1) % v.length].x - at.x, v[(i + 1) % v.length].y - at.y);
  };
  const scaleTo = (length: number) => {
    const k = length / v.reduce((a, p) => a + edgeLength(p), 0);
    for (const p of v) {
      p.x *= k;
      p.y *= k;
    }
  };
  scaleTo(loop);
  // Each thing that needs an edge of some length takes the one nearest to it.
  const taken: Vertex[] = [];
  const nearest = (length: number): Vertex | undefined => {
    let best: Vertex | undefined;
    for (const p of v) if (!taken.includes(p) && (!best || Math.abs(Math.log(edgeLength(p) / length)) < Math.abs(Math.log(edgeLength(best) / length)))) best = p;
    if (best) taken.push(best);
    return best;
  };
  const mainFrom = nearest(mainEdge)!;
  const startFrom = ownStart ? nearest(startEdge)! : mainFrom;
  const essesAt = esses ? nearest(ESSES_EDGE) : undefined;
  const chicaneAt = chicane ? nearest(CHICANE_EDGE) : undefined;
  // The edges to their lengths: each end moved along its own edge (pulling the whole loop out along one would leave
  // a sliver), and the loop brought back to size.
  const setEdge = (at: Vertex, length: number) => {
    const next = v[(v.indexOf(at) + 1) % count];
    const e = edgeLength(at);
    const d = (clamp(length, e * 0.6, e * 1.6) - e) / 2;
    const ux = (next.x - at.x) / e, uy = (next.y - at.y) / e;
    at.x -= ux * d;
    at.y -= uy * d;
    next.x += ux * d;
    next.y += uy * d;
  };
  for (let pass = 0; pass < 6; pass++) {
    if (essesAt && edgeLength(essesAt) < ESSES_EDGE) setEdge(essesAt, ESSES_EDGE);
    if (chicaneAt && edgeLength(chicaneAt) < CHICANE_EDGE) setEdge(chicaneAt, CHICANE_EDGE);
    if (ownStart) setEdge(startFrom, startEdge);
    setEdge(mainFrom, mainEdge);
    scaleTo(loop);
  }
  const kept = [mainFrom, startFrom];
  // Which side of an edge is the inside of the lap.
  const orient = Math.sign(signedArea(v)) || 1;
  // A corner of the loop so slight that the two edges it joins would be one straight is pushed out until it is a corner.
  for (let pass = 0; pass < 3; pass++) {
    const { angle, edge } = turns(v);
    for (let i = 0; i < count; i++) {
      if (Math.abs(angle[i]) >= 0.3) continue;
      const before = v[mod(i - 1, count)], after = v[(i + 1) % count];
      const cx = after.x - before.x, cy = after.y - before.y;
      const chord = Math.hypot(cx, cy) || 1;
      const push = 0.12 * Math.min(edge[mod(i - 1, count)], edge[i]);
      // (Outward: to the right of the way round for a lap whose inside is on the left.)
      v[i].x += (cy / chord) * orient * push;
      v[i].y -= (cx / chord) * orient * push;
    }
  }

  /**
   * How far the lap may run from a place on the edge after `at`, at right
   * angles to it, to the inside or the outside, before it comes within a
   * gap and a quarter of another part of the lap as it stands.
   */
  const room = (at: Vertex, along2: number, inside: boolean, most: number): number => {
    const i = v.indexOf(at);
    const a = v[i], b = v[(i + 1) % v.length];
    const e = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / e, uy = (b.y - a.y) / e;
    const side = inside ? orient : -orient;
    const wx = -uy * side, wy = ux * side;
    const px = a.x + ux * along2, py = a.y + uy * along2;
    const keep = 1.25 * gap;
    const step = 0.7 * gap;
    for (let t = step; t <= most; t += step) {
      const x = px + wx * t, y = py + wy * t;
      for (let j = 0; j < v.length; j++) {
        if (j === i) continue;
        const c = v[j], d = v[(j + 1) % v.length];
        if (distanceToSegment(x, y, c.x, c.y, d.x, d.y) < keep) return t - step;
      }
    }
    return most;
  };

  interface Point { s: number; side: number; r: number; feature: Feature; fixed: boolean }
  /** Replaces the edge from vertex `at` to the next by a path through `points`, given along the edge and to the inside of the lap. */
  const along = (at: Vertex, points: Point[]): Vertex[] => {
    const i = v.indexOf(at);
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const e = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / e, uy = (b.y - a.y) / e;
    const fresh = points.map((p): Vertex => ({ x: a.x + ux * p.s - uy * orient * p.side, y: a.y + uy * p.s + ux * orient * p.side, r: p.r, feature: p.feature, fixed: p.fixed }));
    v.splice(i + 1, 0, ...fresh);
    return fresh;
  };
  const made = { hairpin: false, chicane: false, esses: false, sweeper: false };
  /** Edges of the loop with a feature on them, and vertices whose edge to the next takes no bend. */
  const used = new Set<Vertex>();
  const closed = new Set<Vertex>();
  const free = () => v.filter((p) => p.feature === 'loop' && !kept.includes(p) && !used.has(p)).sort((p, q) => edgeLength(q) - edgeLength(p));

  // 2. A chicane: left and right across the straight and back onto it.
  if (chicaneAt) {
    const r = stream('chicane');
    const e = edgeLength(chicaneAt);
    if (e > 330) {
      used.add(chicaneAt);
      const from = between(r, e * 0.35, e * 0.6);
      const side = between(r, 11, 16) * (r() < 0.5 ? 1 : -1);
      const run = between(r, 32, 44);
      const flat = between(r, 16, 26);
      along(chicaneAt, [
        { s: from, side: 0, r: 22, feature: 'chicane', fixed: true },
        { s: from + run, side, r: 18, feature: 'chicane', fixed: true },
        { s: from + run + flat, side, r: 18, feature: 'chicane', fixed: true },
        { s: from + 2 * run + flat, side: 0, r: 22, feature: 'chicane', fixed: true },
      ]).forEach((p) => closed.add(p));
      made.chicane = true;
    }
  }
  // Esses: the road swings from side to side a few times.
  if (essesAt) {
    const r = stream('esses');
    const e = edgeLength(essesAt);
    const swings = Math.min(5, 3 + Math.floor(r() * 3), Math.floor((e - 200) / 110));
    if (swings >= 3) {
      used.add(essesAt);
      const pitch = Math.min(135, (e - 180) / (swings + 1));
      const side = between(r, 24, 38) * (r() < 0.5 ? 1 : -1);
      const from = (e - pitch * (swings + 1)) / 2;
      const points: Point[] = [];
      for (let k = 1; k <= swings; k++) points.push({ s: from + pitch * k, side: side * (k % 2 ? 1 : -1), r: between(r, 70, 150), feature: 'esses', fixed: true });
      along(essesAt, points).forEach((p) => closed.add(p));
      made.esses = true;
    }
  }
  let added = 0;
  // The hairpin: out to one side and back, the two legs opening out a little from the turn, as the legs of a hairpin
  // do. To the inside where there is room, else to the outside.
  if (ownHairpin) {
    const r = stream('hairpin');
    const narrow = Math.max(2 * TIGHTEST, 0.82 * gap, s.width + 12);
    const w = between(r, narrow, Math.max(narrow + 10, gap));
    for (const at of free()) {
      const e = edgeLength(at);
      if (e < w + 220) continue;
      const wish = Math.min(e * between(r, 0.3, 0.75), s.length * 0.12, 0.9 * s.longestStraight);
      const from = between(r, 80 + wish * 0.14, e - w - 80 - wish * 0.14);
      const depthOn = (inside: boolean) => Math.min(wish, room(at, from, inside, wish), room(at, from + w, inside, wish));
      let depth = depthOn(true);
      let side = 1;
      if (depth < 110) {
        depth = depthOn(false);
        side = -1;
      }
      if (depth < 110) continue;
      const splay = depth * 0.14;
      const fresh = along(at, [
        { s: from - splay, side: 0, r: 40, feature: 'detour', fixed: false },
        { s: from, side: side * depth, r: w / 2, feature: 'hairpin', fixed: true },
        { s: from + w, side: side * depth, r: w / 2, feature: 'hairpin', fixed: true },
        { s: from + w + splay, side: 0, r: 40, feature: 'detour', fixed: false },
      ]);
      fresh.slice(0, -1).forEach((p) => closed.add(p));
      used.add(at);
      made.hairpin = true;
      added += 2 * depth;
      break;
    }
  }

  // 3. Folds, until the lap has its length: what the loop and the hairpin leave over.
  let budget = folded ? Math.min(s.length - 0.93 * loop - added, 1.4 * folding * s.length) : 0;
  const tight = Math.max(1.06 * gap, 2 * TIGHTEST);
  const deep = 0.6 + 0.4 * Math.max(s.compact, s.foldBack);
  let folds = 0;
  for (const at of free()) {
    if (budget < 2 * (tight + 60)) break;
    const r = stream(`fold${folds++}`);
    const e = edgeLength(at);
    // The turn at the end of a pair of legs comes from the mix, the tighter the more the lap is to fold; the legs stand as far apart as it needs.
    const pitch = Math.max(tight, 2.15 * drawRadius(s, r, 1, s.foldBack)) * spacing;
    const uTurn = spacing < 1.35;
    const margin = Math.max(55, 1.35 * gap, e * 0.08);
    const usable = e - 2 * margin;
    const most = Math.floor((usable + pitch) / (2 * pitch));
    if (most < 1) continue;
    const s0 = margin + (usable - (2 * most - 1) * pitch) * r();
    const shallowest = pitch + 60;
    // (No leg with more straight in it than the straight that is to be the longest.)
    const cap = Math.min(0.3 * s.length, budget / 2, 0.9 * s.longestStraight + (spacing < 1.35 ? pitch / 2 : 40));
    if (cap < shallowest) break;
    const measure = (inside: boolean) => {
      const out: number[] = [];
      for (let k = 0; k < most; k++) {
        const s1 = s0 + 2 * k * pitch;
        const d = Math.min(room(at, s1, inside, cap), room(at, s1 + pitch, inside, cap)) * (inside ? deep : 1) * between(r, 0.9, 1);
        out.push(d >= shallowest ? d : 0);
      }
      return out;
    };
    const sum = (list: number[]) => list.reduce((a, d) => a + d, 0);
    let rooms = measure(true);
    let side = 1;
    // A lap that is to fold back and has no room left inside folds outward.
    if (s.foldBack > 0.5 && sum(rooms) < 0.5 * Math.min(budget / 2, most * cap)) {
      const outside = measure(false);
      if (sum(outside) > 1.5 * sum(rooms)) {
        rooms = outside;
        side = -1;
      }
    }
    // The length to fold, shared out evenly: every leg as deep as the others, or as deep as it has room.
    const all = rooms.map((d, k) => ({ k, d })).filter((t) => t.d > 0);
    if (!all.length) continue;
    const share = budget / 2;
    // As many pairs of legs as the lap is to have corners (each turn at an end is one), and more only where fewer
    // have no room for the length: side by side where that is, at the deepest place there is.
    let teeth = all;
    const fewest = clamp(Math.round((wanted - cornersOf(v).length - 1) / 2), 1, all.length);
    const most2 = Math.max(1, Math.min(all.length, Math.floor(share / shallowest)));
    for (let n = Math.min(fewest, most2); n <= most2; n++) {
      let best: typeof all = [];
      for (let from = 0; from + n <= all.length; from++) {
        const run = all.slice(from, from + n);
        if (run[n - 1].k - run[0].k === n - 1 && sum(run.map((t) => t.d)) > sum(best.map((t) => t.d))) best = run;
      }
      if (!best.length) best = [...all].sort((p, q) => q.d - p.d).slice(0, n).sort((p, q) => p.k - q.k);
      teeth = best;
      if (sum(best.map((t) => t.d)) >= share) break;
    }
    let level = Infinity;
    if (sum(teeth.map((t) => t.d)) > share) {
      const sorted = teeth.map((t) => t.d).sort((p, q) => p - q);
      let left = share;
      for (let n = 0; n < sorted.length; n++) {
        const each = left / (sorted.length - n);
        if (sorted[n] >= each) {
          level = each;
          break;
        }
        left -= sorted[n];
      }
    }
    const has = new Set(teeth.map((t) => t.k));
    // Where the lap is short of corners the legs swing from side to side on their way, all of them together, so
    // that they stay as far apart as they were (less by the slope of the swing, which the gap sets a limit to).
    const lacking = wanted - cornersOf(v).length - (uTurn ? 2 : 4) * teeth.length - 1;
    const swing = clamp((0.6 * s.length) / wanted, 60, 160);
    const slope = Math.min(0.5, Math.sqrt(Math.max(0, (pitch / (1.03 * gap)) ** 2 - 1)));
    const swings = lacking > 0 && slope > 0.2 ? Math.ceil(lacking / (2 * teeth.length)) : 0;
    const sway = 0.45 * swing * slope * (r() < 0.5 ? 1 : -1);
    // (A leg comes to a turn right round nearly square on: the last swing is four times its width short of it.)
    const square = Math.max(30, (uTurn ? 4 : 2.2) * Math.abs(sway));
    const ends = [10 + square, (uTurn ? pitch / 2 : 40) + square];
    const points: Point[] = [];
    for (const t of teeth) {
      const far = Math.max(shallowest, Math.min(t.d, level));
      const depth = far * side;
      const s1 = s0 + 2 * t.k * pitch;
      const turn = uTurn ? pitch / 2 : 40;
      const n = Math.max(0, Math.min(swings, Math.floor((far - ends[0] - ends[1]) / swing)));
      const leg = (from: number, back: boolean): Point[] => {
        const out: Point[] = [];
        for (let j = 0; j < n; j++) out.push({ s: from + sway * (j % 2 ? -1 : 1), side: (ends[0] + (j + 0.5) * swing) * side, r: 60, feature: 'fold', fixed: false });
        return back ? out.reverse() : out;
      };
      points.push(
        { s: s1, side: 0, r: turn, feature: 'fold', fixed: uTurn && has.has(t.k - 1) },
        ...leg(s1, false),
        { s: s1, side: depth, r: turn, feature: 'fold', fixed: uTurn },
        { s: s1 + pitch, side: depth, r: turn, feature: 'fold', fixed: uTurn },
        ...leg(s1 + pitch, true),
        { s: s1 + pitch, side: 0, r: turn, feature: 'fold', fixed: uTurn && has.has(t.k + 1) },
      );
      budget -= 2 * far;
    }
    const fresh = along(at, points);
    fresh.slice(0, -1).forEach((p) => closed.add(p));
    used.add(at);
    if (uTurn && s.hairpin) made.hairpin = true;
  }

  // 4. A sweeper: one corner opened right out. It needs the length of both straights it joins, so the bends keep off them.
  const spared = new Set<Vertex>();
  if (s.sweeper) {
    const r = stream('sweeper');
    const { angle, edge } = turns(v);
    const pick = v.map((p, i) => ({ p, i })).filter(({ p, i }) => !p.fixed && Math.abs(angle[i]) > 0.8 && Math.abs(angle[i]) < 2.2 && edge[i] > 380 && edge[mod(i - 1, v.length)] > 380);
    if (pick.length) {
      const { p, i } = pick[Math.floor(r() * pick.length)];
      p.r = between(r, 220, 380);
      p.feature = 'sweeper';
      p.fixed = true;
      spared.add(p).add(v[mod(i - 1, v.length)]);
      made.sweeper = true;
    }
  }
  // Bends, until the lap has the corners it should; and one in any straight longer than the one that is to be the
  // longest. Outward where the inside has folds in it.
  const rk = stream('bends');
  const longest = edgeLength(mainFrom);
  const pitch = clamp((0.5 * s.length) / wanted, 55, 150);
  const shortest = clamp(2.4 * pitch, 130, 280);
  // (A bend pushed out takes some of the turn from the corners either side of it. Where that would leave an end of
  // one of the two straights with hardly a corner, the straight would run on round it: the bend goes the other
  // way, or not on that edge at all.)
  const runsOn = () => {
    const { angle } = turns(v);
    return kept.some((k) => Math.abs(angle[v.indexOf(k)]) < 0.3 || Math.abs(angle[(v.indexOf(k) + 1) % v.length]) < 0.3);
  };
  const bendOn = (at: Vertex, make: (way: number) => Point[], ways: number[], failed: Set<Vertex>): Vertex[] | null => {
    for (const way of ways) {
      const fresh = along(at, make(way));
      if (!runsOn()) return fresh;
      v.splice(v.indexOf(fresh[0]), fresh.length);
    }
    failed.add(at);
    return null;
  };
  /** Edges that took no bend for a corner, and those that took none to shorten them either. */
  const bare = new Set<Vertex>();
  const stuck = new Set<Vertex>();
  const out = folds || thin;
  // No straight but the main one may be longer than this: a little under the main edge, or the straight asked and a corner's share.
  const limit = Math.min(0.92 * longest, s.longestStraight + 30);
  for (let round = 0; round < 3; round++) {
    if (round) {
      // A corner of plain road so slight that the straights either side of it are one straight (under 12 degrees) is
      // taken out: what it joined is then one edge, and takes a bend that is a corner if it is too long.
      const { angle } = turns(v);
      const slight = v.filter((p, i) => !p.fixed && (p.feature === 'loop' || p.feature === 'kink') && Math.abs(angle[i]) < 0.21
        && !kept.includes(p) && !kept.includes(v[mod(i - 1, v.length)]) && !closed.has(p) && !closed.has(v[mod(i - 1, v.length)]));
      if (!slight.length) break;
      for (const p of slight) v.splice(v.indexOf(p), 1);
    }
    for (let guard = 0; guard < 160; guard++) {
      const open = v.filter((p) => !kept.includes(p) && !closed.has(p)).sort((p, q) => edgeLength(q) - edgeLength(p));
      const at = open.find((p) => !spared.has(p) && !bare.has(p));
      const need = wanted - cornersOf(v).length;
      if (at && need > 0 && edgeLength(at) >= shortest) {
        const e = edgeLength(at);
        const fits = Math.floor(e / pitch) - 1;
        if (need >= 3 && fits >= 3) {
          // A run of them, from side to side (to one side and back, where the other is taken).
          const n = Math.min(fits, need, 16);
          const step = e / (n + 1);
          const wide = step * (out ? between(rk, 0.28, 0.42) : between(rk, 0.18, 0.36));
          const sizes = Array.from({ length: n }, () => between(rk, 0.8, 1));
          const fresh = bendOn(at, (way) => sizes.map((size2, k): Point => ({ s: step * (k + 1), side: way * wide * (k % 2 ? (out ? 0.1 : -1) : 1) * size2, r: 60, feature: 'kink', fixed: false })), out ? [-1] : rk() < 0.5 ? [-1, 1] : [1, -1], bare);
          if (fresh) {
            fresh.forEach((p) => closed.add(p));
            closed.add(at);
          }
        } else {
          const where = between(rk, e * 0.35, e * 0.65);
          const wide = Math.max(0.09 * e, Math.min(160, e * between(rk, 0.1, 0.26)));
          bendOn(at, (way) => [{ s: where, side: way * wide, r: 60, feature: 'kink', fixed: false }], out ? [-1] : rk() < 0.6 ? [-1, 1] : [1, -1], bare);
        }
        continue;
      }
      // A fast bend, to keep a straight under the longest: beside a sweeper at the far end of the straight from it.
      const long = open.find((p) => !stuck.has(p));
      if (!long || edgeLength(long) <= limit || edgeLength(long) < 240) break;
      const e = edgeLength(long);
      const fromSweeper = long.feature === 'sweeper';
      const toSweeper = v[(v.indexOf(long) + 1) % v.length].feature === 'sweeper';
      const where = e * (fromSweeper ? between(rk, 0.58, 0.72) : toSweeper ? between(rk, 0.28, 0.42) : between(rk, 0.4, 0.6));
      const wide = e * between(rk, 0.08, 0.13);
      const radius = between(rk, 150, 350);
      const fresh = bendOn(long, (way) => [{ s: where, side: way * wide, r: radius, feature: 'kink', fixed: true }], out ? [-1, 1] : rk() < 0.5 ? [-1, 1] : [1, -1], stuck);
      if (fresh && toSweeper) {
        spared.delete(long);
        spared.add(fresh[0]);
      }
    }
  }
  // (And where one of them runs on all the same, by a feature beside it: another draw.)
  if (runsOn()) return null;

  // 5. Every other corner takes its radius from the mix.
  const rr = stream('radii');
  const { angle } = turns(v);
  v.forEach((p, i) => {
    if (!p.fixed) p.r = drawRadius(s, rr, Math.min(1, Math.abs(angle[i]) / 2.2));
  });
  if (!fit(v)) return null;
  return { v, mainFrom, startFrom, made, loop, plain: v.filter((p) => !kept.includes(p) && !closed.has(p)) };
}

/**
 * Draws one lap from random numbers. Null when the draw does not work out
 * (a corner that does not fit, a lap that crosses itself): the caller draws
 * again.
 *
 * The lap is sketched a few times over from the same random numbers, each
 * time on a loop of the size that makes it as long as asked: folds, U-turns
 * and chicanes are drawn at their real size, and scaling a finished lap by
 * much would squash them.
 */
export function drawShape(s: GeneratorSettings, rng: () => number, gap: number): Shape | null {
  const seed = Math.floor(rng() * 0x7fffffff);
  let size = 1;
  let reach = 1;
  let lead = 1;
  let lap: Sketch | null = null;
  for (let round = 0; round < 4; round++) {
    lap = sketch(s, seed, gap, size, reach, lead);
    if (!lap) return null;
    const length = lapLength(lap.v);
    const { tangent, edge } = turns(lap.v);
    const on = (from: Vertex) => {
      const i = lap!.v.indexOf(from);
      return edge[i] - tangent[i] - tangent[(i + 1) % lap!.v.length];
    };
    const straight = on(lap.mainFrom);
    const start = on(lap.startFrom);
    const short = lap.startFrom !== lap.mainFrom && start < 0.93 * s.startStraight;
    if (round === 3 || (Math.abs(length / s.length - 1) < 0.02 && Math.abs(straight / s.longestStraight - 1) < 0.05 && !short)) break;
    // The loop takes up what the lap is short (what was added keeps its size), and the two edges what their straights are short.
    size *= clamp(1 + (0.85 * (s.length - length)) / lap.loop, 0.6, 1.6);
    reach *= clamp(s.longestStraight / Math.max(40, straight), 0.7, 1.4);
    if (short) lead *= clamp(s.startStraight / Math.max(40, start), 1, 1.4);
  }
  if (!lap) return null;
  let v = lap.v;
  const { mainFrom, startFrom, made } = lap;
  // To length exactly, and the longest straight to its own: one side of the lap is slid along it, which changes
  // that straight and one plain edge across from it and nothing else (stretching the whole lap would pull the
  // folds apart).
  for (let pass = 0; pass < 5; pass++) {
    const k = s.length / lapLength(v);
    for (const p of v) {
      p.x *= k;
      p.y *= k;
    }
    if (!fit(v)) return null;
    if (pass === 4) break;
    const n = v.length;
    const i = v.indexOf(mainFrom);
    const { tangent, edge } = turns(v);
    const next = (i + 1) % n;
    const straight = edge[i] - tangent[i] - tangent[next];
    const slide = clamp(s.longestStraight - straight, -0.4 * edge[i], 0.6 * edge[i]);
    if (Math.abs(slide) < 0.015 * s.longestStraight) continue;
    const ux = (v[next].x - v[i].x) / edge[i], uy = (v[next].y - v[i].y) / edge[i];
    // The edge that gives or takes the length: plain road, running back the other way, and long enough for it.
    let across = -1;
    let best = 0.2;
    for (const p of lap.plain) {
      const j = v.indexOf(p);
      const q = v[(j + 1) % n];
      const back = -((q.x - p.x) * ux + (q.y - p.y) * uy) / edge[j];
      const after = edge[j] + slide * back;
      if (after < 90 || after < tangent[j] + tangent[(j + 1) % n] + 30 || after > 0.92 * (edge[i] + slide)) continue;
      const worth = back * Math.min(1, edge[j] / 300);
      if (worth > best) {
        best = worth;
        across = j;
      }
    }
    if (across < 0) continue;
    for (let m = next; ; m = (m + 1) % n) {
      v[m].x += ux * slide;
      v[m].y += uy * slide;
      if (m === across) break;
    }
  }
  // The way round.
  const clockwise = signedArea(v) > 0;
  const want = s.direction === 'either' ? (rng() < 0.5 ? 'clockwise' : 'anticlockwise') : s.direction;
  let start = v.indexOf(startFrom);
  let main = v.indexOf(mainFrom);
  if ((want === 'clockwise') !== clockwise) {
    v = v.reverse();
    // The edge from old vertex i to i + 1 now runs from new vertex n - 2 - i.
    start = mod(v.length - 2 - start, v.length);
    main = mod(v.length - 2 - main, v.length);
  }
  if (!fit(v)) return null;
  const shape: Shape = { v, start, main, made };
  return clear(tracePath(shape, 14), gap) ? shape : null;
}

/** With y pointing south, a positive area is a lap that runs clockwise on the map. */
function signedArea(v: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) a += v[i].x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * v[i].y;
  return a / 2;
}

/**
 * Corners per kilometre at the two ends of "corners or speed", counted over
 * the lap without its longest straight and its start straight: 9 is a kart
 * track or a town circuit at its tightest (Monaco has 5.7 over the whole
 * lap), 1.3 an oval with a bend in it (Monza has 1.9).
 */
const CORNERS_PER_KM = [9, 1.3] as const;

/** Corners a lap of this length and character should have: two for the ends of its straights, and so many a kilometre of the rest. */
export function cornersWanted(s: GeneratorSettings): number {
  const straights = s.longestStraight + (s.startStraight <= s.longestStraight * 0.8 ? s.startStraight : 0);
  const rest = Math.max(0.3 * s.length, s.length - straights);
  return clamp(Math.round(2 + (rest / 1000) * CORNERS_PER_KM[0] * Math.pow(CORNERS_PER_KM[1] / CORNERS_PER_KM[0], s.speed)), 3, 120);
}

/** The lap as points every `step` metres or closer, each with the distance from the first, and whether it lies on the start straight. */
export interface Path {
  x: number[];
  y: number[];
  s: number[];
  /** Index of the vertex whose corner the point is in, or -1 on a straight. */
  corner: number[];
  /** Edge index of the straight the point is on, or -1 in a corner. */
  straight: number[];
  length: number;
}

export function tracePath(shape: Shape, step: number): Path {
  const v = shape.v;
  const n = v.length;
  const { angle, tangent } = turns(v);
  const out: Path = { x: [], y: [], s: [], corner: [], straight: [], length: 0 };
  let dist = 0;
  const push = (x: number, y: number, corner: number, straight: number) => {
    const k = out.x.length;
    if (k) dist += Math.hypot(x - out.x[k - 1], y - out.y[k - 1]);
    out.x.push(x);
    out.y.push(y);
    out.s.push(dist);
    out.corner.push(corner);
    out.straight.push(straight);
  };
  for (let i = 0; i < n; i++) {
    const p = v[mod(i - 1, n)];
    const c = v[i];
    const q = v[(i + 1) % n];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(q.x - c.x, q.y - c.y);
    const d1x = (c.x - p.x) / l1, d1y = (c.y - p.y) / l1;
    const d2x = (q.x - c.x) / l2, d2y = (q.y - c.y) / l2;
    const t = tangent[i];
    const t1x = c.x - d1x * t, t1y = c.y - d1y * t;
    // The corner at vertex i: an arc from the end of the straight before it to the start of the one after.
    const sign = Math.sign(angle[i]) || 1;
    const cx = t1x - d1y * c.r * sign, cy = t1y + d1x * c.r * sign;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    const arc = c.r * Math.abs(angle[i]);
    const parts = Math.max(1, Math.ceil(arc / step));
    for (let k = 0; k <= parts; k++) {
      const a = a0 + (angle[i] * k) / parts;
      push(cx + c.r * Math.cos(a), cy + c.r * Math.sin(a), i, -1);
    }
    // The straight on to the next corner.
    const t2x = c.x + d2x * t, t2y = c.y + d2y * t;
    const len = l2 - t - tangent[(i + 1) % n];
    const bits = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k < bits; k++) push(t2x + d2x * (len * k) / bits, t2y + d2y * (len * k) / bits, -1, i);
  }
  out.length = dist + Math.hypot(out.x[0] - out.x[out.x.length - 1], out.y[0] - out.y[out.y.length - 1]);
  return out;
}

/** The points of a path by the square of side `cell` each lies in. */
function cells(path: Path, cell: number): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  for (let i = 0; i < path.x.length; i++) {
    const key = Math.floor(path.x[i] / cell) * 65536 + Math.floor(path.y[i] / cell);
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }
  return grid;
}

/** Whether point i of a path has another part of the lap within `within` metres: one at least `apart` metres from it along the lap. */
function hasNeighbour(path: Path, grid: Map<number, number[]>, cell: number, i: number, within: number, apart: number): boolean {
  const cx = Math.floor(path.x[i] / cell), cy = Math.floor(path.y[i] / cell);
  const reach = Math.ceil(within / cell);
  for (let gx = cx - reach; gx <= cx + reach; gx++) {
    for (let gy = cy - reach; gy <= cy + reach; gy++) {
      const list = grid.get(gx * 65536 + gy);
      if (!list) continue;
      for (const j of list) {
        const along2 = Math.abs(path.s[j] - path.s[i]);
        if (along2 < apart || path.length - along2 < apart) continue;
        if (Math.hypot(path.x[i] - path.x[j], path.y[i] - path.y[j]) < within) return true;
      }
    }
  }
  return false;
}

/** Whether no two parts of the lap come within `gap` metres of each other (parts less than 2.5 gaps apart along the lap are neighbours). */
function clear(path: Path, gap: number): boolean {
  const grid = cells(path, gap);
  const near = Math.max(gap * 2.5, 110);
  for (let i = 0; i < path.x.length; i++) if (hasNeighbour(path, grid, gap, i, gap, near)) return false;
  return true;
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
}

/** A part of the lap with another part this near (metres) is folded back on it. */
const NEAR = 120;

/**
 * A class's pace, roughly: what a corner of a given radius takes, and how
 * hard it pulls away and brakes at a speed (m/s, m/s2). It sorts shapes
 * before any is built; the lap times come from the real lap simulation.
 * Without a class: cornering and braking at 14 m/s2, pulling away at 6, no
 * faster than 85 m/s.
 */
interface Pace {
  top: number;
  corner(r: number): number;
  drive(v: number): number;
  brake(v: number): number;
}

const AIR = 1.2;
const G = 9.81;
/** The rough speeds are taken this much higher for the depth of run-off they ask: the real lap may be quicker than the estimate. */
const RUNOFF_SPEED = 1.1;
/** A fall in speed of this much (m/s) into a corner is heavy braking: 90 km/h. */
const HEAVY_BRAKING = 25;

function paceOf(vehicle: VehicleClass | null): Pace {
  if (!vehicle) return { top: 85, corner: (r) => Math.min(85, Math.sqrt(14 * r)), drive: () => 6, brake: () => 14 };
  const m = vehicle.mass;
  const down = (0.5 * AIR * (vehicle.clA[0] + vehicle.clA[1])) / 2 / m;
  const drag = (0.5 * AIR * (vehicle.cdA[0] + vehicle.cdA[1])) / 2 / m;
  // A little under the tyre's grip: it loses some under load, and no lap uses all of it.
  const mu = vehicle.grip * 0.92;
  const top = vehicle.topSpeed;
  return {
    top,
    corner: (r) => {
      const left = 1 - mu * down * r;
      return left <= 0.05 ? top : Math.min(top, Math.sqrt((mu * G * r) / left));
    },
    drive: (v) => Math.min(mu * (G + down * v * v) * vehicle.driveShare, (vehicle.maxAccelG ?? 9) * G, vehicle.power / (m * Math.max(v, 8))) - drag * v * v,
    brake: (v) => Math.min(mu * (G + down * v * v), (vehicle.maxBrakeG ?? 9) * G) + drag * v * v,
  };
}

/** The highest speed on a straight of `length` metres left at `from` and ended at `to`. */
function peakSpeed(pace: Pace, from: number, to: number, length: number): number {
  if (length <= 1) return Math.min(from, to);
  const steps = Math.max(1, Math.ceil(length / 25));
  const ds = length / steps;
  const up = new Float64Array(steps + 1);
  up[0] = from;
  for (let k = 0; k < steps; k++) up[k + 1] = Math.min(pace.top, Math.sqrt(Math.max(1, up[k] * up[k] + 2 * pace.drive(up[k]) * ds)));
  let down = to;
  let peak = Math.min(up[steps], down);
  for (let k = steps - 1; k >= 0; k--) {
    down = Math.sqrt(down * down + 2 * pace.brake(down) * ds);
    peak = Math.max(peak, Math.min(up[k], down));
  }
  return peak;
}

/** Each corner's speed, the highest speed on the straight into it, and the straights (the one after each vertex). */
function shapeSpeeds(shape: Shape, vehicle: VehicleClass | null): { corner: number[]; into: number[]; straights: number[] } {
  const v = shape.v;
  const n = v.length;
  const { angle, tangent, edge } = turns(v);
  const pace = paceOf(vehicle);
  const straights = v.map((_, i) => edge[i] - tangent[i] - tangent[(i + 1) % n]);
  const corner = v.map((p, i) => (Math.abs(angle[i]) < 0.2 ? pace.top : pace.corner(p.r)));
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
  const { corner, into } = shapeSpeeds(shape, vehicle);
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

export function measureShape(shape: Shape, vehicle: VehicleClass | null = null): ShapeMetrics {
  const v = shape.v;
  const n = v.length;
  let slow = 0, medium = 0, fast = 0;
  for (const c of cornersOf(v)) {
    if (c.radius < SLOW_BELOW) slow++;
    else if (c.radius > FAST_ABOVE) fast++;
    else medium++;
  }
  // Heavy braking: the speed reached on the straight into a corner, against the speed the corner takes.
  const { corner, into, straights } = shapeSpeeds(shape, vehicle);
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
    longestStraight: Math.max(...runs), startStraight: runs[shape.start], brakingPoints: braking,
    spread: Math.hypot(x1 - x0, y1 - y0) / path.length, folded: folded / path.x.length,
  };
}

/** How far a shape is from what was asked, on its geometry alone: 0 is all of it met. */
export function scoreShape(m: ShapeMetrics, shape: Shape, s: GeneratorSettings): number {
  const wanted = cornersWanted(s);
  const total = s.slow + s.medium + s.fast;
  const count = Math.max(1, m.corners);
  let score = 4 * ((m.corners - wanted) / wanted) ** 2;
  score += 2 * ((m.slow / count - s.slow / total) ** 2 + (m.medium / count - s.medium / total) ** 2 + (m.fast / count - s.fast / total) ** 2);
  score += 2 * ((m.longestStraight - s.longestStraight) / s.longestStraight) ** 2;
  if (m.startStraight < s.startStraight) score += 3 * ((s.startStraight - m.startStraight) / s.startStraight) ** 2;
  score += 0.6 * ((m.brakingPoints - s.brakingPoints) / Math.max(1, s.brakingPoints)) ** 2;
  // A plain loop is nearly half its length across; a lap folded tight a seventh of it.
  score += 0.5 * ((m.spread - (0.5 - 0.36 * s.compact)) / 0.1) ** 2;
  score += 1.2 * ((m.folded - (0.05 + 0.85 * s.foldBack)) / 0.2) ** 2;
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
  const onStart = path.straight.map((e) => e === shape.start);
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
    // Slopes along the lap, over two steps so that one bump does not count; and the slope of the start straight, where the grid stands.
    let steepest = 0, grid = 0, gridCount = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 2) % n;
      const run = mod(path.s[j] - path.s[i], path.length) || 1;
      const g = Math.abs(h[j] - h[i]) / run;
      if (g > steepest) steepest = g;
      if (onStart[i] && onStart[j]) {
        grid += g;
        gridCount++;
      }
    }
    const range = max - min;
    let cost = ((range - s.heightDifference) / Math.max(12, 0.35 * s.heightDifference + 8)) ** 2;
    cost += Math.max(0, (steepest - steep) / 0.03) ** 2;
    if (gridCount) cost += 0.5 * Math.max(0, (grid / gridCount - 0.015) / 0.01) ** 2;
    cost += 3 * (wet / n) + 4 * (wooded / n);
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
const DRAWN = 70;
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
  let first = (shape.start + 1) % n;
  for (let k = 0; k < n; k++) {
    const j = (shape.start + 1 + k) % n;
    if (Math.abs(angle[j]) >= FIRST_CORNER_TURN && v[j].r < 250) {
      first = j;
      break;
    }
  }
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
    // A point every 18 degrees or so round the corner, its ends included; a short kink is one point at its middle.
    const arc = cv.r * Math.abs(angle[i]);
    if (arc < 14) {
      pts.push({ x: cx + cv.r * Math.cos(a0 + angle[i] / 2), y: cy + cv.r * Math.sin(a0 + angle[i] / 2), d: dist + arc / 2 });
    } else {
      const parts = Math.max(1, Math.min(Math.ceil(Math.abs(angle[i]) / 0.32), Math.floor(arc / 9)));
      for (let k = 0; k <= parts; k++) {
        const a = a0 + (angle[i] * k) / parts;
        pts.push({ x: cx + cv.r * Math.cos(a), y: cy + cv.r * Math.sin(a), d: dist + (arc * k) / parts });
      }
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
  const gap = needs ? needs.gap : gapFor(s);
  const steps = 2 + Math.ceil(s.candidates * BUILT);
  let done = 0;
  const tick = async (doing: string) => {
    hooks.progress?.(Math.min(done++, steps - 1), steps, doing);
    await hooks.pause?.();
  };
  // Draw, and keep the best on shape.
  await tick('Drawing laps');
  const rng = seededRandom(`generator:${s.seed}`);
  const drawn: { shape: Shape; score: number; seed: string }[] = [];
  for (let i = 0; i < DRAWN * s.candidates; i++) {
    const shape = drawShape(s, rng, gap);
    if (!shape) continue;
    let score = scoreShape(measureShape(shape, vehicle), shape, s);
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
    if (tracks.length >= Math.ceil(s.candidates * BUILT) && (!needs || passing >= s.candidates)) break;
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
      // Built to a licence: the whole of the analysis, as the app will do it, for the verdict.
      const performance = analysePerformance(t, ctx.vehicles);
      const facilities = placeFacilities({
        track: t, startFinish: start, performance, vehicles: ctx.vehicles, heightAt: (x, y) => sampleHeight(hm, x, y), waterLevel: hm.waterLevel, extent: hm.extent,
        overrides: { startFinish },
      });
      const verdict = assessLicence({ track: t, metrics, issues, performance, facilities, heightmap: hm, vehicles: ctx.vehicles });
      const own = verdict.classes.find((x) => x.id === vehicle.id);
      const body = vehicle.licence.body === 'FIM' ? verdict.fim : verdict.fia;
      const failures = body.results.find((r) => r.grade === vehicle.licence.grade)?.failures.filter((f) => f.level === 'required').map((f) => `${f.label}: ${f.detail}`) ?? [];
      licence = { needs: `${vehicle.licence.body} ${vehicle.licence.grade}`, passes: own?.allowed ?? failures.length === 0, failures };
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
    if (Math.abs(off) > Math.max(10, 0.35 * s.heightDifference)) {
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
