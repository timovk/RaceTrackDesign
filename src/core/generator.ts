/**
 * The track generator: circuits made to order on the ground that is there.
 *
 * A lap is drawn as a polygon with rounded corners, in metres: a loop of a
 * few corners, pulled long or kept compact; detours that fold it back on
 * itself (a narrow one is a hairpin); a chicane, a run of esses and a long
 * sweeper where they are asked for; and kinks until it has the corners it
 * should. Every corner takes a radius from the slow, the medium or the fast
 * range, by the mix asked for. The whole is scaled to the lap length, and
 * stretched along its longest side until that straight is as long as wanted.
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

/** The settings as they are used: within their ranges, and raised to what the class's licence needs when the track is built to it. */
export function resolveSettings(s: GeneratorSettings, vehicle: VehicleClass | null): { settings: GeneratorSettings; needs: ClassNeeds | null; notes: string[] } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const out: GeneratorSettings = {
    ...s,
    length: clamp(s.length, 1200, 14000), width: clamp(s.width, 6, 20), heightDifference: clamp(s.heightDifference, 0, 400),
    speed: clamp(s.speed, 0, 1), compact: clamp(s.compact, 0, 1), foldBack: clamp(s.foldBack, 0, 1),
    brakingPoints: clamp(Math.round(s.brakingPoints), 0, 8), candidates: clamp(Math.round(s.candidates), 1, 12),
    slow: Math.max(0, s.slow), medium: Math.max(0, s.medium), fast: Math.max(0, s.fast),
  };
  if (out.slow + out.medium + out.fast <= 0) out.medium = 1;
  out.longestStraight = clamp(s.longestStraight, 200, Math.min(2500, out.length * 0.4));
  out.startStraight = clamp(s.startStraight, 200, out.longestStraight);
  const notes: string[] = [];
  const needs = vehicle && s.licence ? classNeeds(vehicle) : null;
  if (needs && vehicle) {
    const raise = (key: 'length' | 'width' | 'startStraight', to: number, what: string) => {
      if (out[key] < to) {
        out[key] = to;
        notes.push(`${what} for ${vehicle.name}'s licence`);
      }
    };
    raise('length', needs.minLength, `Lap lengthened to ${(needs.minLength / 1000).toFixed(1)} km`);
    raise('width', needs.minWidth, `Width raised to ${needs.minWidth} m`);
    raise('startStraight', needs.startStraight, `Start straight lengthened to ${needs.startStraight} m`);
    if (out.length > needs.maxLength) {
      out.length = needs.maxLength;
      notes.push(`Lap shortened to ${needs.maxLength / 1000} km for ${vehicle.name}'s licence`);
    }
    if (out.longestStraight > needs.maxStraight) {
      out.longestStraight = needs.maxStraight;
      notes.push(`Longest straight held to ${needs.maxStraight} m for ${vehicle.name}'s licence`);
    }
    out.longestStraight = Math.max(out.longestStraight, out.startStraight);
  }
  return { settings: out, needs, notes };
}

// ---- the shape -------------------------------------------------------------------

type Feature = 'loop' | 'detour' | 'hairpin' | 'chicane' | 'esses' | 'sweeper' | 'kink';

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
  for (let pass = 0; pass < 6; pass++) {
    const { tangent, edge } = turns(v);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const need = tangent[i] + tangent[j];
      if (need > edge[i] * 0.94) {
        const k = (edge[i] * 0.94) / need;
        v[i].r *= k;
        v[j].r *= k;
        ok = false;
      }
    }
    if (ok) break;
  }
  const { angle, tangent, edge } = turns(v);
  for (let i = 0; i < n; i++) {
    if (tangent[i] + tangent[(i + 1) % n] > edge[i] * 0.97) return false;
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

/**
 * Draws one lap from random numbers. Null when the draw does not work out
 * (a corner that does not fit, a lap that crosses itself): the caller draws
 * again.
 */
export function drawShape(s: GeneratorSettings, rng: () => number, gap: number): Shape | null {
  const between = (a: number, b: number) => a + (b - a) * rng();
  const wanted = cornersWanted(s);
  // The loop: a few corners round a middle, pulled long when the lap is to be spread out.
  const base = Math.max(4, Math.min(8, Math.round(wanted * 0.36)));
  const R = s.length / (2 * Math.PI) * 0.82;
  const aspect = 1 + (1 - s.compact) * 1.5;
  const turn0 = rng() * Math.PI * 2;
  let v: Vertex[] = [];
  for (let k = 0; k < base; k++) {
    const a = turn0 + ((k + 0.5 + (rng() - 0.5) * 0.6) / base) * Math.PI * 2;
    const rho = R * (1 + (rng() - 0.5) * 0.5);
    v.push({ x: rho * Math.cos(a) * Math.sqrt(aspect), y: (rho * Math.sin(a)) / Math.sqrt(aspect), r: 60, feature: 'loop', fixed: false });
  }
  const made = { hairpin: false, chicane: false, esses: false, sweeper: false };
  // The two straights that matter are kept clear of everything else: the longest edge, and the start's (the same one unless it is to be much shorter).
  const longest = (skip: readonly Vertex[]) => {
    let best = -1;
    let len = 0;
    for (let i = 0; i < v.length; i++) {
      if (skip.includes(v[i])) continue;
      const e = Math.hypot(v[(i + 1) % v.length].x - v[i].x, v[(i + 1) % v.length].y - v[i].y);
      if (e > len) {
        len = e;
        best = i;
      }
    }
    return best;
  };
  const mainFrom = v[longest([])];
  const startFrom = s.startStraight > s.longestStraight * 0.8 ? mainFrom : v[longest([mainFrom])];
  const kept = [mainFrom, startFrom];
  /** Replaces the edge from vertex `at` to the next by a path through `points` (given along the edge and to its inner side). */
  const along = (at: Vertex, points: { s: number; side: number; r: number; feature: Feature; fixed: boolean }[]) => {
    const i = v.indexOf(at);
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const e = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / e, uy = (b.y - a.y) / e;
    // The inner side: towards the middle of the lap.
    const c = centroid(v);
    const inward = (c.x - a.x) * -uy + (c.y - a.y) * ux > 0 ? 1 : -1;
    const fresh = points.map((p): Vertex => ({ x: a.x + ux * p.s - uy * inward * p.side, y: a.y + uy * p.s + ux * inward * p.side, r: p.r, feature: p.feature, fixed: p.fixed }));
    v.splice(i + 1, 0, ...fresh);
  };
  const edgeLength = (at: Vertex) => {
    const i = v.indexOf(at);
    return Math.hypot(v[(i + 1) % v.length].x - at.x, v[(i + 1) % v.length].y - at.y);
  };
  /** The free edges (no feature on them yet, not one of the two kept straights), longest first. */
  const used = new Set<Vertex>();
  const free = () => v.filter((p) => !kept.includes(p) && !used.has(p) && p.feature === 'loop').sort((p, q) => edgeLength(q) - edgeLength(p));
  // The esses and the chicane need a straight of some length: each has the shortest that will do set aside, before the detours take the long ones.
  const setAside = (least: number): Vertex | undefined => {
    const at = free().filter((p) => edgeLength(p) > least).pop();
    if (at) used.add(at);
    return at;
  };
  const essesAt = s.esses ? setAside(540) : undefined;
  const chicaneAt = s.chicane ? setAside(340) : undefined;
  // Detours fold the lap back on itself: out towards the middle and back. A narrow one is a hairpin.
  const detours = Math.round(s.foldBack * Math.max(1, Math.min(4, s.length / 2200)));
  for (let d = 0; d < detours + (s.hairpin ? 1 : 0); d++) {
    const at = free()[0];
    if (!at) break;
    const e = edgeLength(at);
    const narrow = s.hairpin && !made.hairpin;
    const w = narrow ? between(Math.max(44, gap * 0.82), Math.max(54, gap)) : between(120, 260);
    if (e < w + 220) continue;
    const c = centroid(v);
    const reach = Math.hypot(c.x - at.x, c.y - at.y);
    const depth = Math.max(110, Math.min(e * between(0.3, 0.75), reach * 0.85, s.length * 0.09));
    // (The two legs open out a little from the far end, as the legs of a hairpin do: close at the turn, clear of each other further back.)
    const splay = depth * 0.14;
    const from = between(80 + splay, e - w - 80 - splay);
    const r = narrow ? w / 2 : 0;
    along(at, [
      { s: from - splay, side: 0, r: 40, feature: 'detour', fixed: false },
      { s: from, side: depth, r: r || 40, feature: narrow ? 'hairpin' : 'detour', fixed: narrow },
      { s: from + w, side: depth, r: r || 40, feature: narrow ? 'hairpin' : 'detour', fixed: narrow },
      { s: from + w + splay, side: 0, r: 40, feature: 'detour', fixed: false },
    ]);
    used.add(at);
    if (narrow) made.hairpin = true;
  }
  // A chicane: left and right across the straight and back onto it.
  if (chicaneAt) {
    const at = chicaneAt;
    const e = edgeLength(at);
    const from = between(e * 0.35, e * 0.6);
    const side = between(11, 16) * (rng() < 0.5 ? 1 : -1);
    const run = between(32, 44);
    const flat = between(16, 26);
    along(at, [
      { s: from, side: 0, r: 22, feature: 'chicane', fixed: true },
      { s: from + run, side, r: 18, feature: 'chicane', fixed: true },
      { s: from + run + flat, side, r: 18, feature: 'chicane', fixed: true },
      { s: from + 2 * run + flat, side: 0, r: 22, feature: 'chicane', fixed: true },
    ]);
    made.chicane = true;
  }
  // Esses: the road swings from side to side a few times.
  if (essesAt) {
    const at = essesAt;
    const e = edgeLength(at);
    const swings = Math.min(5, 3 + Math.floor(rng() * 3), Math.floor((e - 200) / 110));
    const pitch = Math.min(135, (e - 180) / (swings + 1));
    const side = between(24, 38) * (rng() < 0.5 ? 1 : -1);
    const from = (e - pitch * (swings + 1)) / 2;
    const pts = [];
    for (let k = 1; k <= swings; k++) pts.push({ s: from + pitch * k, side: side * (k % 2 ? 1 : -1), r: between(70, 150), feature: 'esses' as const, fixed: true });
    along(at, pts);
    made.esses = swings >= 3;
  }
  // A sweeper: one corner of the loop opened right out. It needs the length of both straights it joins, so the kinks keep off them.
  const spared = new Set<Vertex>();
  if (s.sweeper) {
    const { angle, edge } = turns(v);
    const pick = v.map((p, i) => ({ p, i })).filter(({ p, i }) => !p.fixed && Math.abs(angle[i]) > 0.8 && Math.abs(angle[i]) < 2.2 && edge[i] > 380 && edge[mod(i - 1, v.length)] > 380);
    if (pick.length) {
      const { p, i } = pick[Math.floor(rng() * pick.length)];
      p.r = between(220, 380);
      p.feature = 'sweeper';
      p.fixed = true;
      spared.add(p).add(v[mod(i - 1, v.length)]);
      made.sweeper = true;
    }
  }
  // Kinks, until the lap has the corners it should: a point of a free edge pushed to one side.
  for (let guard = 0; guard < 30 && v.length < wanted; guard++) {
    const at = free().find((p) => !spared.has(p)) ?? v.filter((p) => !kept.includes(p) && !spared.has(p) && p.feature !== 'chicane' && p.feature !== 'esses').sort((p, q) => edgeLength(q) - edgeLength(p))[0];
    if (!at || edgeLength(at) < 260) break;
    const e = edgeLength(at);
    along(at, [{ s: between(e * 0.35, e * 0.65), side: e * between(0.1, 0.26) * (rng() < 0.6 ? -1 : 1), r: 60, feature: 'kink', fixed: false }]);
  }
  // Every other corner takes its radius from the mix, a sharp turn more often a slow one.
  const { angle } = turns(v);
  const fastBias = 0.6 + 0.8 * s.speed;
  v.forEach((p, i) => {
    if (p.fixed) return;
    const sharp = Math.min(1, Math.abs(angle[i]) / 2.2);
    const w = [s.slow * (0.5 + sharp) / fastBias, s.medium, s.fast * (1.4 - sharp) * fastBias];
    let pick = rng() * (w[0] + w[1] + w[2]);
    const kind = pick < w[0] ? 'slow' : (pick -= w[0]) < w[1] ? 'medium' : 'fast';
    const [lo, hi] = CORNER_RADII[kind];
    p.r = lo * Math.pow(hi / lo, rng());
  });
  if (!fit(v)) return null;
  // To length, and the longest straight to the length wanted: stretched along it, and the whole scaled back.
  for (let pass = 0; pass < 7; pass++) {
    const k = s.length / lapLength(v);
    for (const p of v) {
      p.x *= k;
      p.y *= k;
    }
    if (!fit(v)) return null;
    if (pass === 6) break;
    const i = v.indexOf(mainFrom);
    const { tangent, edge } = turns(v);
    const j = (i + 1) % v.length;
    const stretch = Math.max(0.6, Math.min(1.7, (s.longestStraight + tangent[i] + tangent[j]) / edge[i]));
    const ux = (v[j].x - v[i].x) / edge[i], uy = (v[j].y - v[i].y) / edge[i];
    for (const p of v) {
      const along2 = p.x * ux + p.y * uy;
      p.x += ux * along2 * (stretch - 1);
      p.y += uy * along2 * (stretch - 1);
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

/** Corners a lap of this length and character should have. */
export function cornersWanted(s: GeneratorSettings): number {
  return Math.max(5, Math.min(34, Math.round((s.length / 1000) * (5.2 - 3.4 * s.speed))));
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

/** Whether no two parts of the lap come within `gap` metres of each other (parts less than 2.5 gaps apart along the lap are neighbours). */
function clear(path: Path, gap: number): boolean {
  const n = path.x.length;
  const near = Math.max(gap * 2.5, 110);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const along2 = path.s[j] - path.s[i];
      if (along2 < near || path.length - along2 < near) continue;
      if (Math.abs(path.x[i] - path.x[j]) < gap && Math.hypot(path.x[i] - path.x[j], path.y[i] - path.y[j]) < gap) return false;
    }
  }
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
  const { angle } = turns(v);
  let slow = 0, medium = 0, fast = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(angle[i]) < 0.26) continue;
    if (v[i].r < SLOW_BELOW) slow++;
    else if (v[i].r > FAST_ABOVE) fast++;
    else medium++;
  }
  // Heavy braking: the speed reached on the straight into a corner, against the speed the corner takes.
  const { corner, into, straights } = shapeSpeeds(shape, vehicle);
  let braking = 0;
  for (let i = 0; i < n; i++) if (into[i] - corner[i] >= HEAVY_BRAKING) braking++;
  const path = tracePath(shape, 30);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < path.x.length; k++) {
    x0 = Math.min(x0, path.x[k]);
    x1 = Math.max(x1, path.x[k]);
    y0 = Math.min(y0, path.y[k]);
    y1 = Math.max(y1, path.y[k]);
  }
  let folded = 0;
  for (let i = 0; i < path.x.length; i++) {
    for (let j = 0; j < path.x.length; j++) {
      const along2 = Math.abs(path.s[j] - path.s[i]);
      if (along2 < 300 || path.length - along2 < 300) continue;
      if (Math.hypot(path.x[i] - path.x[j], path.y[i] - path.y[j]) < 120) {
        folded++;
        break;
      }
    }
  }
  return {
    length: lapLength(v), corners: slow + medium + fast, slow, medium, fast,
    longestStraight: Math.max(...straights), startStraight: straights[shape.start], brakingPoints: braking,
    spread: Math.hypot(x1 - x0, y1 - y0) / path.length, folded: folded / path.x.length,
  };
}

/** How far a shape is from what was asked, on its geometry alone: 0 is all of it met. */
export function scoreShape(m: ShapeMetrics, shape: Shape, s: GeneratorSettings): number {
  const wanted = cornersWanted(s);
  const total = s.slow + s.medium + s.fast;
  const count = Math.max(1, m.corners);
  let score = 2 * ((m.corners - wanted) / wanted) ** 2;
  score += 2 * ((m.slow / count - s.slow / total) ** 2 + (m.medium / count - s.medium / total) ** 2 + (m.fast / count - s.fast / total) ** 2);
  score += 2 * ((m.longestStraight - s.longestStraight) / s.longestStraight) ** 2;
  if (m.startStraight < s.startStraight) score += 3 * ((s.startStraight - m.startStraight) / s.startStraight) ** 2;
  score += 0.6 * ((m.brakingPoints - s.brakingPoints) / Math.max(1, s.brakingPoints)) ** 2;
  score += 0.5 * ((m.spread - (0.42 - 0.2 * s.compact)) / 0.1) ** 2;
  score += 0.5 * ((m.folded - (0.05 + 0.45 * s.foldBack)) / 0.2) ** 2;
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

/** A track keeps this far from the edge of the map. */
const MAP_MARGIN = 130;

/**
 * The steepest slope a place may have along the lap before it counts
 * against it: 6%, and more for a lap that is to climb a lot (it goes up
 * the height asked and down again, and not evenly), up to 11%. The checks
 * warn from 12%.
 */
function steepLimit(s: GeneratorSettings): number {
  return Math.max(0.06, Math.min(0.11, (4.4 * s.heightDifference) / s.length));
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
  const gap = needs ? needs.gap : 30 + s.width + 18 * (1 - s.foldBack * s.compact);
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
