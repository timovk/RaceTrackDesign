/**
 * The lap composer: a lap written from its start line, corner by corner.
 *
 * A lap is a sequence of passages. A passage is a straight and the corners
 * it leads into: one corner to brake for, a hairpin, two corners that turn
 * one into the other, a run of fast ones that swing from side to side, a
 * chicane, a long corner that goes on round, a sweeper, a kink, a winding
 * road. What a lap is to be like (how many
 * corners, which straights, how many places to brake hard, the mix of slow
 * and fast) decides which passages it gets and how long their straights
 * are; the passages are then put in an order.
 *
 * A corner is seldom one radius: it is two or three arcs, wide and tight and
 * wide, or tightening, or opening, as real corners are. And a road is
 * seldom dead straight between its corners: a corner is eased in and out by
 * a wide arc, and a straight may bow. How much of that a lap has is what
 * "flowing" sets, from none of it to more than real circuits have.
 *
 * The lap is laid out on the ground from the start straight, on a plot of
 * land. Each passage may turn either way and is drawn a little differently
 * each time; it goes where it keeps clear of what is there and from where
 * the lap can still come home. Where one has no place, the one before it is
 * laid another way. The last two corners (or three) are worked out, not
 * drawn: they are the ones that bring the lap back onto its start straight.
 *
 * The figures a lap is drawn to are those of real circuits
 * (core/character.ts) in the middle of each slider.
 *
 * Coordinates: x east and y south, so a positive turn is to the right, and
 * a lap that turns right on balance runs clockwise on the map.
 */
import { REAL_CIRCUITS } from './character.ts';
import type { GeneratorSettings } from './generator.ts';
import { type Shape, CORNER_RADII, NO_CORNER, READS_WIDER, STRAIGHT_CREEP, clamp } from './lapShape.ts';
import { type Pace, lineRadius, peakSpeed } from './roughPace.ts';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const mod2pi = (a: number) => ((a % TAU) + TAU) % TAU;

type Rng = () => number;
const between = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
const logBetween = (rng: Rng, a: number, b: number) => a * Math.pow(b / a, rng());
function choose<T>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of items) total += Math.max(0, w);
  let at = rng() * total;
  for (const [item, w] of items) if ((at -= Math.max(0, w)) < 0) return item;
  return items[items.length - 1][0];
}

/**
 * What real circuits are like (core/character.ts): the middle of each slider
 * asks for that. The mix of slow, medium and fast corners the three sliders
 * start from, and the share of the lap the two longest straights take.
 */
const REAL = REAL_CIRCUITS;
export const REAL_MIX = { slow: REAL.slow[1], medium: REAL.medium[1], fast: REAL.fast[1] } as const;
const REAL_STRAIGHTS = REAL.longestStraight[1] + REAL.secondStraight[1];
/**
 * Corners a kilometre at the two ends of "corners or speed", as the track
 * will be read to have them: a town circuit at its tightest, and an oval
 * with a bend in it. The middle of the slider is what real circuits have.
 */
const CORNERS_PER_KM = [8, REAL.cornersPerKm[1], 1.3] as const;
/** For every corner the track is read to have, this many are drawn: one in six reads as part of its neighbour, or as none. */
export const DRAWN_PER_READ = 1.2;
/**
 * Of the corners drawn, more are slow and fewer fast than the mix asks: the
 * kinds of passage and the way home lean the other way (a run of esses is
 * of medium and fast corners, and so are most corners that come out of the
 * way home).
 */
const DRAWN_MIX = { slow: 1.2, medium: 1, fast: 0.75 } as const;

/** The mix of corners asked for, as shares: the sliders on the mix of real circuits, leaning to slow or to fast as the lap is to. */
export function mixWanted(s: GeneratorSettings): { slow: number; medium: number; fast: number } {
  const tilt = Math.pow(5.5, s.speed - 0.5);
  const slow = (s.slow * REAL_MIX.slow) / tilt, medium = s.medium * REAL_MIX.medium, fast = s.fast * REAL_MIX.fast * tilt;
  const all = slow + medium + fast || 1;
  return { slow: slow / all, medium: medium / all, fast: fast / all };
}

/**
 * How much less of a long lap runs beside another part of it than of a lap
 * of 5 km, which is what the real circuits measured are: by the root of its
 * length. A lap comes near itself round its hairpins and its paddock, and a
 * lap four times as long has not four times as much of that; 18 km with a
 * third of it side by side would be two roads a kilometre long in a ditch's
 * width of each other. (No circuit that long was measured: this is a guess.)
 */
const besideAtLength = (s: GeneratorSettings) => clamp(Math.sqrt(5000 / s.length), 0.45, 1.15);

/** Share of the lap that is to have another part of it within 120 m: next to none for one open loop, a third in the middle of the slider as real circuits have, four fifths at its top; less of a long lap. */
export function foldedWanted(s: GeneratorSettings): number {
  return Math.min(0.9, (0.02 + (4 * REAL.folded[1] - 0.86) * s.foldBack + (1.64 - 4 * REAL.folded[1]) * s.foldBack * s.foldBack) * besideAtLength(s));
}

/** Share of the outline round the lap that it is to enclose: all but a little for one open loop, two thirds in the middle of the slider as real circuits have, a third at its top. */
export function hullWanted(s: GeneratorSettings): number {
  return clamp(0.95 - 2 * (0.95 - REAL.hull[1]) * s.foldBack, 0.3, 0.95);
}

/** The curve through three values: at 0, in the middle and at 1 of a slider. */
const through = (low: number, middle: number, high: number, at: number) => low + (4 * middle - 3 * low - high) * at + 2 * (low + high - 2 * middle) * at * at;

/**
 * Share of the lap that is to be gently curved (at 300 m to 2 km of radius):
 * a twentieth for a lap of straights and corners, a fifth in the middle of
 * "flowing" as real circuits have, a third at its top, as the park roads of
 * Montreal and Melbourne are.
 */
export function bowedWanted(s: GeneratorSettings): number {
  return through(0.05, REAL.bowed[1], 0.33, s.flow);
}

/**
 * Share of the lap that is to be long corners (150 m or more of turning one
 * way at under 300 m): next to none for a lap of straights and short
 * corners, as Montreal and the Norisring are; a sixth in the middle of
 * "flowing", as real circuits have; a third at its top, as Zandvoort, Brands
 * Hatch and Sepang are.
 */
export function longBendsWanted(s: GeneratorSettings): number {
  return through(0.02, REAL.longBends[1], 0.33, s.flow);
}

/** The start is on a straight of its own, and not on the longest. */
export const ownStart = (s: GeneratorSettings) => s.startStraight <= s.longestStraight * 0.8;

/**
 * Corners to draw for a lap of this length and character: so many a
 * kilometre as it is to be read to have, 3.25 in the middle of the slider
 * as real circuits have, and a fifth more; over the lap less what its
 * straights take beyond what they take of a real one.
 */
export function cornersWanted(s: GeneratorSettings): number {
  const [most, middle, fewest] = CORNERS_PER_KM;
  const perKm = s.speed < 0.5 ? middle * Math.pow(most / middle, 1 - 2 * s.speed) : middle * Math.pow(fewest / middle, 2 * s.speed - 1);
  const straights = s.longestStraight + (ownStart(s) ? s.startStraight : 0);
  const km = (s.length - Math.max(0, straights - REAL_STRAIGHTS * s.length)) / 1000;
  return clamp(Math.round(perKm * km * DRAWN_PER_READ), 3, 180);
}

// ---- the plan --------------------------------------------------------------------

export type PassageKind = 'stop' | 'hairpin' | 'turn' | 'long' | 'sweeper' | 'kink' | 'ess' | 'triple' | 'double' | 'flow' | 'winding' | 'chicane';

/** One arc of a corner: a share of its turn, at so many times the corner's radius. `ease` marks the wide arc a corner is eased in or out by. */
interface Arc { share: number; ratio: number; ease?: boolean }

interface Bend {
  /** How far it turns, radians. */
  turn: number;
  /** Which way, against the first corner of its passage. */
  side: number;
  /** The radius the middle of its turning is made at: what makes it a slow, a medium or a fast corner. */
  radius: number;
  /** Straight between it and the corner before it in the passage, metres. */
  link: number;
  /** The arcs it is made of, in order: one for a corner of one radius. */
  arcs: Arc[];
}

/** A corner as first drawn, before it is given its arcs. */
type Outline = Omit<Bend, 'arcs'>;

/** No arc of a corner is tighter than this at the middle of the road, metres; nor, on a wide road, than leaves its inside edge a radius of its own when the lap is made smaller to its length. */
const TIGHTEST = 14;
const tightestFor = (s: GeneratorSettings) => Math.max(TIGHTEST, s.width / 2 + 2.5);
/** A corner that turns less than this is one arc, whatever it was drawn as. */
const ONE_ARC = 40 * DEG;

/** How many times the corner's radius the middle half of its turning is made at, for a corner of these arcs. */
function middleRatio(arcs: readonly Arc[]): number {
  let length = 0;
  let before = 0;
  for (const a of arcs) {
    const lo = Math.max(before, 0.25), hi = Math.min(before + a.share, 0.75);
    if (hi > lo) length += (hi - lo) * a.ratio;
    before += a.share;
  }
  return length / 0.5;
}

/** How many times longer than one arc of its radius a corner of these arcs is. */
const stretch = (arcs: readonly Arc[]) => arcs.reduce((a, c) => a + c.share * c.ratio, 0);

/** Makes a corner's arcs more alike, as far as its tightest needs to be no tighter than a car can turn. */
function soften(b: Bend, tightest: number): void {
  const least = Math.min(...b.arcs.map((a) => a.ratio));
  const floor = tightest / b.radius;
  if (least >= floor) return;
  const keep = floor >= 1 ? 0 : (1 - floor) / (1 - least);
  for (const a of b.arcs) a.ratio = 1 + (a.ratio - 1) * keep;
}

/**
 * The arcs of a corner. Real corners are seldom one radius: they are
 * tightest for a third of their turning and wider before and after
 * (their tightest point is 1.4 times tighter than the middle of the corner).
 * So: wide, tight, wide; or wide then tight (a corner that tightens, turned
 * into late); or tight then wide (one that opens, to get on the power
 * early); or, for a corner that turns far, tight, wide and tight again (two
 * apexes); or one radius after all. The first corner of a few that turn
 * one into the other may tighten and the last may open; a chicane's and a
 * kink's are one arc, a sweeper's nearly so, and a turn right round between
 * two legs of a folded lap is half a circle. A long corner has two apexes
 * or three, with arcs between them not so wide that it would be two corners,
 * or opens or tightens all the way round. The ratios are such that the
 * middle of the corner's turning is made at the corner's radius.
 */
function drawArcs(kind: PassageKind | 'home', b: Outline, at: number, of: number, s: GeneratorSettings, rng: Rng): Arc[] {
  const one = (): Arc[] => [{ share: 1, ratio: 1 }];
  if (b.turn < ONE_ARC || kind === 'kink' || kind === 'chicane' || (kind === 'hairpin' && s.foldBack > 0.6)) return one();
  type Form = 'even' | 'apex' | 'tightens' | 'opens' | 'twice' | 'thrice';
  const form: Form = kind === 'sweeper' ? choose(rng, [['even', 6], ['tightens', 2], ['opens', 2]] as const)
    // (A long corner has two apexes, or three, or opens or tightens all the way round: seldom one radius.)
    : kind === 'long' ? choose(rng, [['twice', 4], ['thrice', b.turn >= 140 * DEG ? 3.5 : 0], ['opens', 2.5], ['tightens', 2.5], ['apex', 1.5], ['even', 1.5]] as const)
    : kind === 'hairpin' ? choose(rng, [['even', 3], ['tightens', 2.5], ['opens', 2.5], ['apex', 1.5]] as const)
      : of > 1 ? (at === 0 ? choose(rng, [['even', 2.5], ['tightens', 3], ['apex', 3]] as const)
        : at === of - 1 ? choose(rng, [['even', 2.5], ['opens', 3], ['apex', 3]] as const)
          : choose(rng, [['even', 3.5], ['apex', 4]] as const))
        : choose(rng, [['apex', 3.5], ['tightens', 2.5], ['opens', 2.5], ['even', 0.8], ['twice', b.turn >= 110 * DEG ? 3 : 0]] as const);
  // (The wider arcs of a long corner are not so wide that it would be two corners: under 300 m as they will read.)
  const wide = () => (kind === 'long' ? Math.min(between(rng, 1.5, 2.3), Math.max(1.15, 230 / b.radius)) : between(rng, 2.1, 3.1));
  let arcs: Arc[];
  if (form === 'even') return one();
  if (form === 'apex') {
    const tight = between(rng, 0.26, 0.4);
    const before = (1 - tight) * between(rng, 0.4, 0.6);
    arcs = [{ share: before, ratio: wide() }, { share: tight, ratio: 1 }, { share: 1 - tight - before, ratio: wide() }];
  } else if (form === 'tightens' || form === 'opens') {
    const loose = between(rng, 0.35, 0.55);
    arcs = form === 'tightens' ? [{ share: loose, ratio: wide() }, { share: 1 - loose, ratio: 1 }] : [{ share: 1 - loose, ratio: 1 }, { share: loose, ratio: wide() }];
  } else if (form === 'thrice') {
    const gaps = [between(rng, 0.13, 0.19), between(rng, 0.13, 0.19)];
    const rest = 1 - gaps[0] - gaps[1];
    const first = rest * between(rng, 0.28, 0.38), last = rest * between(rng, 0.28, 0.38);
    arcs = [
      { share: first, ratio: between(rng, 0.9, 1.15) }, { share: gaps[0], ratio: wide() }, { share: rest - first - last, ratio: 1 },
      { share: gaps[1], ratio: wide() }, { share: last, ratio: between(rng, 0.9, 1.2) },
    ];
  } else {
    const between2 = between(rng, 0.22, 0.32);
    const first = (1 - between2) * between(rng, 0.42, 0.58);
    arcs = [{ share: first, ratio: 1 }, { share: between2, ratio: wide() }, { share: 1 - between2 - first, ratio: between(rng, 0.9, 1.2) }];
  }
  // (A sweeper is nearly one radius: a long fast corner that changed radius by much would be two corners.)
  if (kind === 'sweeper') for (const a of arcs) a.ratio = 1 + (a.ratio - 1) * 0.4;
  const k = middleRatio(arcs);
  for (const a of arcs) a.ratio /= k;
  return arcs;
}

/**
 * Eases a corner in and out. A road does not go from straight to a corner
 * at once: it bends a little first, and straightens out gently after. So,
 * where a corner has a straight before it (`into`) or after it (`out`), it
 * gets a gentle arc there, of five to nine times its own radius (320 to
 * 800 m) and three to seven degrees. The corner turns that much further
 * for it (`further`), or, where how far it turns is not to change, that
 * much of its turn is made on the gentle arc. It is this, as much as the
 * bow of the straights, that a fifth of a real lap being gently curved comes
 * from. How many corners are eased, and by how much, is what "flowing"
 * sets.
 */
function ease(b: Bend, into: boolean, out: boolean, s: GeneratorSettings, rng: Rng, further: boolean): void {
  if (b.turn < ONE_ARC) return;
  const often = clamp(EASED * 2 * s.flow, 0, 1);
  const [before, after] = [into, out].map((wanted): number => {
    if (!wanted || rng() >= often) return 0;
    const turn = Math.min(between(rng, 3, 7) * DEG * (0.6 + 0.8 * s.flow), 0.15 * b.turn);
    return turn >= 3 * DEG ? turn : 0;
  });
  if (!before && !after) return;
  const whole = further ? b.turn + before + after : b.turn;
  const arc = (turn: number): Arc[] => (turn ? [{ share: turn / whole, ratio: clamp(b.radius * between(rng, 5, 9), EASE_RADII[0], EASE_RADII[1]) / b.radius, ease: true }] : []);
  const [first, last] = [arc(before), arc(after)];
  b.arcs = [...first, ...b.arcs.map((a) => ({ share: (a.share * (whole - before - after)) / whole, ratio: a.ratio })), ...last];
  b.turn = whole;
}

/** Lengths of the arcs a passage's first corner is eased in by and its last eased out by: they take the place of straight before and after it. */
function easedOf(bends: readonly Bend[]): [number, number] {
  const length = (b: Bend, a: Arc) => (a.ease ? a.share * b.turn * a.ratio * b.radius : 0);
  const first = bends[0], last = bends[bends.length - 1];
  return [length(first, first.arcs[0]), length(last, last.arcs[last.arcs.length - 1])];
}
/** Share of the ends of corners that are eased, in the middle of "flowing". */
const EASED = 0.7;
/** The radii of the arcs corners are eased by, metres: wide enough to be gentle, and not so wide that the arc would read as more straight (1 km on the track as built). */
const EASE_RADII = [320, 800] as const;

/** Length of a passage's corners and the straights between them. */
const lengthOf = (bends: readonly Bend[]) => bends.reduce((a, b) => a + b.link + b.turn * b.radius * stretch(b.arcs), 0);

/**
 * A straight that is not straight: after so much of it (a share of its
 * length) it bows, in one gentle arc or in two, one each way, each a share
 * of its length turning by so much; what is left of it runs straight into
 * the corner.
 */
interface Bow {
  from: number;
  arcs: { share: number; side: number; turn: number }[];
}

interface Passage {
  kind: PassageKind;
  /** The straight that leads into it, and whether its length is asked for (the start straight and the longest), chosen, or what is left over. */
  straight: number;
  hold: 'asked' | 'chosen' | 'free';
  /** How that straight bows, where it does. */
  bow: Bow | null;
  bends: Bend[];
  /** Length of its corners and the straights between them. */
  length: number;
  /** Lengths of the arcs its first corner is eased in by and its last eased out by. */
  eased: [number, number];
  /** Asked for: the lap is not whole without it. The others make up the number of corners. */
  must: boolean;
}

/** A corner's radius from the mix: `lean` from -1, a slow one more often, to 1, a fast one. The radius is that of the middle of the corner's turning. */
function drawRadius(s: GeneratorSettings, rng: Rng, lean: number): number {
  const tilt = Math.pow(5.5, s.speed - 0.5) * Math.pow(4, lean);
  const kind = choose(rng, [
    // (More of the corners drawn from the mix are slow ones where the lap has long corners, which never are: so that the mix of the whole lap is what was asked.)
    ['slow', (s.slow * REAL_MIX.slow * DRAWN_MIX.slow * (1 + 0.3 * Math.min(1, longShare(s)))) / tilt], ['medium', s.medium * REAL_MIX.medium * DRAWN_MIX.medium], ['fast', s.fast * REAL_MIX.fast * DRAWN_MIX.fast * tilt],
  ] as const);
  const [lo, hi] = CORNER_RADII[kind];
  // (Drawn tighter than it is to read: see READS_WIDER.)
  return logBetween(rng, lo, hi) / READS_WIDER;
}

/**
 * A long corner that turns by so much: one that goes on for 180 m to 400 m
 * (more of them the shorter, and none more than a thirteenth of a short
 * lap), so at 45 to 190 m. Real laps are a sixth such corners, and those
 * that flow a third: Zandvoort, Brands Hatch, Sepang.
 */
function longCorner(turn: number, s: GeneratorSettings, rng: Rng): Outline {
  const length = logBetween(rng, 180, clamp(0.075 * s.length, 230, 400));
  // (Wide enough to be long whatever its arcs come to; and a fast corner where the mix has no medium ones, a medium one where it has no fast.)
  const mix = mixWanted(s);
  const widest = mix.fast < 0.05 ? 95 : 190;
  return { turn, side: 1, radius: clamp(length / turn, Math.min(widest, Math.max(mix.medium < 0.05 ? 105 : 45, LONG_AT_LEAST / turn)), widest), link: 0 };
}
/** A long corner is at least this long at its radius, metres: over the 150 m from which a corner counts as long, with room for what its arcs take off. */
const LONG_AT_LEAST = 170;

/** How much of a lap that is to flow is long corners: none of it at one end of the slider, and no more than the mix of corners has medium and fast ones. */
function longShare(s: GeneratorSettings): number {
  const mix = mixWanted(s);
  return Math.pow(2 * s.flow, 2) * Math.min(1, (mix.medium + mix.fast) / (REAL_MIX.medium + REAL_MIX.fast));
}

function drawBends(kind: PassageKind, s: GeneratorSettings, rng: Rng, gap: number, braked: boolean): Outline[] {
  const deg = (a: number, b: number) => between(rng, a, b) * DEG;
  switch (kind) {
    case 'stop':
      return [{ turn: deg(60, 140), side: 1, radius: drawRadius(s, rng, -0.7), link: 0 }];
    case 'hairpin':
      // (In a lap that is to fold back, a turn right round, wide enough for its two legs to run side by side a gap apart.)
      return s.foldBack > 0.6
        ? [{ turn: deg(174, 186), side: 1, radius: Math.max(logBetween(rng, 16, 26), 0.58 * gap), link: 0 }]
        : [{ turn: deg(150, 205), side: 1, radius: logBetween(rng, 16, 26), link: 0 }];
    case 'turn': {
      // (One that turns far is more often a slow one: the more so in a lap of straights and short corners, the less in one that flows.)
      const turn = deg(40, 130);
      return [{ turn, side: 1, radius: drawRadius(s, rng, clamp((75 * DEG - turn) / (60 * DEG), -1, 1) * (0.9 - 0.6 * s.flow)), link: 0 }];
    }
    case 'long': {
      // (From a quarter of the way round to more than half. One at the end of a straight to brake on turns further and is tighter: a car is to slow for it.)
      if (!braked) return [longCorner(deg(80, 200), s, rng)];
      const b = longCorner(deg(115, 200), s, rng);
      return [{ ...b, radius: Math.min(b.radius, Math.max(between(rng, 60, 85), LONG_AT_LEAST / b.turn)) }];
    }
    case 'sweeper': {
      const turn = deg(45, 160);
      const most = Math.min(0.13 * s.length, 650) / turn;
      return [{ turn, side: 1, radius: Math.min(logBetween(rng, 120, 290), Math.max(110, most)) / READS_WIDER, link: 0 }];
    }
    case 'kink':
      return [{ turn: deg(10, 26), side: 1, radius: between(rng, 150, 380), link: 0 }];
    case 'ess': {
      const r = drawRadius(s, rng, 0);
      return [{ turn: deg(50, 120), side: 1, radius: r, link: 0 }, { turn: deg(40, 110), side: -1, radius: r * between(rng, 0.75, 1.35), link: between(rng, 0, 20) }];
    }
    case 'triple': {
      const r = drawRadius(s, rng, -0.2);
      // One way, the other and back; or, one time in three, two the same way with a short straight between them and one the other.
      const form = rng();
      const sides = form < 0.67 ? [1, -1, 1] : form < 0.84 ? [1, 1, -1] : [1, -1, -1];
      const link = (k: number, most: number) => (sides[k] === sides[k - 1] ? between(rng, 75, 140) : between(rng, 0, most));
      return [
        { turn: deg(70, 150), side: sides[0], radius: r, link: 0 },
        { turn: deg(50, 110), side: sides[1], radius: r * between(rng, 0.8, 1.4), link: link(1, 40) },
        { turn: deg(30, 90), side: sides[2], radius: r * between(rng, 0.9, 1.8), link: link(2, 60) },
      ];
    }
    case 'double': {
      const r = drawRadius(s, rng, 0);
      return [{ turn: deg(45, 100), side: 1, radius: r, link: 0 }, { turn: deg(45, 100), side: 1, radius: r * between(rng, 0.7, 1.4), link: between(rng, 75, 150) }];
    }
    case 'flow': {
      const count = choose(rng, [[3, 4], [4, 3], [5, 2], [6, 1]] as const);
      // (Wider in a lap that flows, tighter in one of straights and short corners.)
      const r = Math.max(48, drawRadius(s, rng, 0.4)) * (0.75 + 0.5 * s.flow);
      const out: Outline[] = [];
      for (let k = 0; k < count; k++) out.push({ turn: deg(35, 100), side: k % 2 ? -1 : 1, radius: r * between(rng, 0.7, 1.4), link: k ? between(rng, 0, 40) : 0 });
      return out;
    }
    case 'winding': {
      // A winding road, as a boulevard along a river is, or a road through a park: two to four sweeping bends of a
      // quarter to two thirds of a right angle at 130 to 420 m, each a hundred metres or two long and up to as far
      // from the next, more often the other way than the same, none like the one before. The wider of them are
      // taken flat and read as no corner at all.
      const count = choose(rng, [[2, 3], [3, 3], [4, 2]] as const);
      const out: Outline[] = [];
      let side = 1;
      for (let k = 0; k < count; k++) {
        if (k && rng() < 0.7) side = -side;
        out.push({ turn: deg(20, 60), side, radius: logBetween(rng, 130, 420), link: k ? between(rng, 30, 180) : 0 });
      }
      return out;
    }
    case 'chicane': {
      const r = () => logBetween(rng, 15, 24);
      const form = rng();
      if (form < 0.45) {
        // One way and back, tight: the lap goes on at an angle to the straight it came down, or on a line beside it.
        const a = between(rng, 60, 100);
        return [{ turn: a * DEG, side: 1, radius: r(), link: 0 }, { turn: (a + between(rng, -15, 20)) * DEG, side: -1, radius: r(), link: between(rng, 0, 8) }];
      }
      if (form < 0.65) {
        // Three, each a little less than a right angle.
        return [
          { turn: deg(45, 70), side: 1, radius: r(), link: 0 },
          { turn: deg(50, 75), side: -1, radius: r(), link: between(rng, 0, 8) },
          { turn: deg(40, 60), side: 1, radius: r(), link: between(rng, 0, 8) },
        ];
      }
      if (form < 0.85) {
        // A bus stop: off the straight to one side, along beside it for a few metres, and back onto its line.
        const a = between(rng, 48, 72), back = between(rng, 48, 72);
        return [
          { turn: a * DEG, side: 1, radius: r(), link: 0 },
          { turn: a * DEG, side: -1, radius: r(), link: between(rng, 0, 8) },
          { turn: back * DEG, side: -1, radius: r(), link: between(rng, 42, 70) },
          { turn: back * DEG, side: 1, radius: r(), link: between(rng, 0, 8) },
        ];
      }
      // A fast one: two corners of 40 to 70 m, each a third of a right angle or so, with a few metres of straight between them.
      const a = between(rng, 28, 48);
      return [
        { turn: a * DEG, side: 1, radius: between(rng, 40, 70), link: 0 },
        { turn: (a + between(rng, -6, 8)) * DEG, side: -1, radius: between(rng, 40, 70), link: between(rng, 12, 40) },
      ];
    }
  }
}

function passage(kind: PassageKind, straight: number, hold: Passage['hold'], s: GeneratorSettings, rng: Rng, gap: number, must = true): Passage {
  const outlines = drawBends(kind, s, rng, gap, hold !== 'free' && s.brakingPoints > 0);
  const tightest = Math.max(CORNER_RADII.slow[0], tightestFor(s));
  for (const b of outlines) b.radius = Math.max(b.radius, tightestFor(s));
  const bends: Bend[] = outlines.map((b, i, all) => ({ ...b, arcs: drawArcs(kind, b, i, all.length, s, rng) }));
  // No corner but a sweeper goes on for more than a twelfth of the lap, or 450 m: a wide one that turns far is made
  // tighter. Nor do the corners of one passage, all told, for more than a tenth of the lap or 600 m (a run of
  // esses a sixth, or a kilometre, as the longest real ones do).
  const longest = clamp(s.length / 12, 150, 450);
  if (kind !== 'sweeper') for (const b of bends) b.radius = Math.min(b.radius, Math.max(tightest, longest / (b.turn * stretch(b.arcs))));
  const arcs = bends.reduce((a, b) => a + b.turn * b.radius * stretch(b.arcs), 0);
  const most = kind === 'flow' || kind === 'winding' ? clamp(s.length / 6, 400, 1000) : clamp(s.length / 10, 250, 600);
  if (bends.length > 1 && arcs > most) for (const b of bends) b.radius = Math.max(tightest, (b.radius * most) / arcs);
  for (const b of bends) soften(b, tightestFor(s));
  // (A chicane's corners and a kink are not eased, nor a turn right round between two legs that are to lie side by side.)
  if (kind !== 'chicane' && kind !== 'kink' && !(kind === 'hairpin' && s.foldBack > 0.6)) {
    bends.forEach((b, i) => ease(b, i === 0 || b.link >= 40, i === bends.length - 1 || bends[i + 1].link >= 40, s, rng, true));
  }
  const eased = easedOf(bends);
  // (A straight that is asked for is that much shorter: the arc its corner is eased in by reads as part of it on the
  // track as built, where it turns little: all of one of 6 degrees or less, none of one of 9 or more.)
  const first = bends[0].arcs[0];
  const reads = first.ease ? clamp((9 * DEG - first.share * bends[0].turn) / (3 * DEG), 0, 1) : 0;
  return { kind, straight: hold === 'asked' ? Math.max(0.6 * straight, straight - reads * eased[0]) : straight, hold, bow: null, bends, length: lengthOf(bends), eased, must };
}

/**
 * How a passage's straight bows, if it does. Real roads are seldom dead
 * straight: a fifth of a real lap is at a radius of 300 m to 2 km, gentle
 * curves a car takes flat, and only a third of it is dead straight. So a
 * straight may bow: one gentle arc over most of its length, or two, one each
 * way. A straight to brake at the end of bows so little that it still reads
 * as one straight (over 1.1 km of radius, 14 degrees at most) and ends
 * straight; any other bows more (from 450 m, up to 28 degrees). How many do
 * is what "flowing" sets: none at one end; in the middle nearly all of them
 * but the two that are asked for, as on real circuits, where little but the
 * two longest straights is dead straight; and above the middle the longest
 * straight too, more and more often, when the grid does not stand on it
 * (at over 2.2 km of radius and by 7 degrees at most: with the arc a corner
 * is eased out by before it, more would read as two straights).
 * The straight the grid stands on never bows.
 */
function drawBow(p: Passage, s: GeneratorSettings, rng: Rng, grid: boolean): Bow | null {
  if (grid || p.straight < 110) return null;
  const braking = p.hold !== 'free';
  if (rng() >= (p.hold === 'asked' ? 1.6 * (s.flow - 0.5) : braking ? 1.9 * s.flow - 0.1 : 2 * s.flow)) return null;
  // (It begins and ends a little way from the corners at its ends: an arc that ran into a corner would read as part of it, and make a slow corner a fast one.)
  const clear = BOW_CLEAR / p.straight;
  const from = Math.max(clear, between(rng, 0.05, 0.25));
  const share = 1 - from - Math.max(clear, braking ? between(rng, 0.15, 0.3) : between(rng, 0, 0.25));
  // (A straight that is asked for bows least of all: it is to read as one straight of the length asked.)
  const [tightest, widest, most] = p.hold === 'asked' ? [2200, 3600, 7 * DEG] : braking ? [1100, 2000, 14 * DEG] : [450, 1300, 28 * DEG];
  const two = p.straight >= 240 && rng() < 0.4;
  const split = two ? between(rng, 0.4, 0.6) : 1;
  const arcs: Bow['arcs'] = [];
  for (const [part, side] of two ? [[share * split, 1], [share * (1 - split), -1]] : [[share, 1]]) {
    const length = part * p.straight;
    // (No bow of under 5 degrees: it would not show.)
    if (length / tightest < 5 * DEG) return null;
    arcs.push({ share: part, side, turn: clamp(length / logBetween(rng, tightest, widest), 5 * DEG, Math.min(most, length / tightest)) });
  }
  return { from, arcs };
}

/** A bow keeps this far from the corners at the ends of its straight, metres. */
const BOW_CLEAR = 40;

/** The stretches of a passage laid one way round: its straight, bowed to one side where it bows, and its corners, each turned by what `turnOf` makes of it. */
function passageLegs(p: Passage, way: number, bowWay: number, straight: number, turnOf: (b: Bend) => number): Leg[] {
  const legs: Leg[] = [];
  let lead = straight;
  if (p.bow) {
    let before = p.bow.from * straight;
    lead -= before;
    for (const arc of p.bow.arcs) {
      const length = arc.share * straight;
      legs.push({ straight: before, angle: bowWay * arc.side * arc.turn, radius: length / arc.turn, kind: p.kind });
      lead -= length;
      before = 0;
    }
  }
  p.bends.forEach((b, i) => legs.push(...legsOf(b, way * b.side * turnOf(b), i ? b.link : Math.max(0, lead), p.kind)));
  return legs;
}

/** How often a passage that makes up the number of corners is a long corner, in the middle of "flowing" (against 14 for a turn and 20 for an S). */
const LONG_CORNERS = 24;
/** What a long corner comes to, one with another, metres. */
const LONG_CORNER = 260;

/** The passages whose corners are made tighter where a lap has not room for all of it, and the least radius each keeps, metres. */
const ROOMY: Partial<Record<PassageKind, number>> = { flow: 34, sweeper: 100, winding: 130 };

/** A passage a car brakes hard for, when it comes off a straight long enough. */
const BRAKING: readonly PassageKind[] = ['stop', 'hairpin', 'ess', 'triple', 'chicane', 'long'];
/** A straight needs this length before a car comes to brake hard at its end, metres. */
const BRAKING_STRAIGHT = 260;

export interface Plan {
  passages: Passage[];
  /** Length kept for the two corners that bring the lap home, and the straights to them. */
  reserve: number;
  /** Index of the passage the longest straight leads into (0 when the start is on it). */
  main: number;
}

/**
 * The passages of one lap, in order, the first led into by the start
 * straight. Null when what is asked does not go into a lap of this length.
 */
export function drawPlan(s: GeneratorSettings, rng: Rng, gap: number): Plan | null {
  const wanted = cornersWanted(s);
  const tilt = Math.pow(5.5, s.speed - 0.5);
  const own = ownStart(s);
  // (The two straights asked for are drawn a little longer than asked: a straight reads shorter on the track, and a lap that comes out long is brought to length.)
  const drawn = (asked: number) => 1.04 * asked + STRAIGHT_CREEP;
  const longest = drawn(s.longestStraight);
  const hard = s.brakingPoints > 0;
  const list: Passage[] = [];
  // The start straight and the first corner; the longest straight and what it ends in.
  // (No more long corners than make up the share of the lap they are to be, a sweeper and a run of esses counted for a twentieth of it.)
  const mostLong = Math.round((Math.max(0, longBendsWanted(s) - 0.05) * s.length) / LONG_CORNER);
  const long = (weight: number) => (list.filter((p) => p.kind === 'long').length < mostLong ? weight * longShare(s) : 0);
  const first = hard
    ? choose(rng, [['stop', 4], ['ess', 3], ['triple', 2], ['hairpin', s.hairpin ? 0.7 : 0], ['chicane', s.chicane ? 1.5 : 0], ['turn', 1], ['long', long(1.5)]] as const)
    : choose(rng, [['turn', 3], ['long', long(2)], ['sweeper', s.sweeper ? 2 : 0], ['kink', 1]] as const);
  const start = passage(first, own ? drawn(s.startStraight) : longest, 'asked', s, rng, gap);
  list.push(start);
  let main: Passage = start;
  if (own) {
    const end = hard && s.brakingPoints > 1
      ? choose(rng, [['stop', 4], ['hairpin', s.hairpin ? 2.5 : 0], ['chicane', s.chicane ? 2 : 0], ['ess', 2], ['triple', 1], ['long', long(1.2)]] as const)
      : choose(rng, [['turn', 3], ['long', long(2)], ['sweeper', s.sweeper ? 2 : 0], ['ess', 1]] as const);
    main = passage(end, longest, 'asked', s, rng, gap);
    list.push(main);
  }
  // What is asked for by name.
  const has = (kind: PassageKind) => list.some((p) => p.kind === kind);
  if (s.hairpin && !has('hairpin')) list.push(passage('hairpin', between(rng, 0.25, 0.7) * longest, 'chosen', s, rng, gap));
  if (s.chicane && !has('chicane')) list.push(passage('chicane', between(rng, 0.35, 0.8) * longest, 'chosen', s, rng, gap));
  if (s.esses) list.push(passage('flow', 0, 'free', s, rng, gap));
  if (s.sweeper && !has('sweeper')) list.push(passage('sweeper', 0, 'free', s, rng, gap));
  // More places to brake hard, each at the end of a straight of its own.
  const braking = () => list.filter((p) => BRAKING.includes(p.kind) && p.straight >= Math.min(BRAKING_STRAIGHT, 0.85 * longest)).length;
  for (let guard = 0; guard < 16 && braking() < s.brakingPoints; guard++) {
    // (In a lap that is to flow, more and more of them are long corners a car brakes into: half of them at the top of the slider.)
    const kind = choose(rng, [['stop', 4], ['ess', 2], ['triple', 1], ['hairpin', s.hairpin ? 0.6 : 0], ['chicane', s.chicane ? 1 : 0], ['long', long(1.5)]] as const);
    list.push(passage(kind, Math.max(Math.min(BRAKING_STRAIGHT, 0.85 * longest), between(rng, 0.4, 0.85) * longest), 'chosen', s, rng, gap));
  }
  // And passages of every kind until the lap has its corners (the two that bring it home are counted).
  // In a lap that is to fold back, above the middle of the slider, more and more of them are turns right round: at the top, four in five.
  const round2 = 0.8 * Math.pow(clamp((s.foldBack - 0.5) / 0.5, 0, 1), 1.5);
  // And in one that is to be an open loop, fewer are corners that turn the lap: what turns one way and then back takes their place.
  const lone = clamp(0.25 + 1.5 * s.foldBack, 0.25, 1);
  // A lap that is to flow gets long corners and winding roads, and fewer short corners that stand alone at the end of a straight.
  // (No more winding road than the mix has fast corners, which its bends are.)
  const windy = Math.pow(2 * s.flow, 1.5) * Math.min(1, mixWanted(s).fast / REAL_MIX.fast);
  // (Not in one open loop, which has few corners that turn it as it is.)
  const alone = lone * (1 + (0.35 - 0.7 * s.flow) * Math.min(1, 2 * s.foldBack));
  const fill = (): Passage => rng() < round2 ? passage('hairpin', 0, 'free', s, rng, gap, false) : passage(choose(rng, [
    ['turn', 14 * alone], ['stop', (5 / tilt) * alone], ['long', long(LONG_CORNERS) * lone], ['sweeper', s.sweeper ? 4 * tilt * lone : 0], ['kink', 3 * tilt], ['hairpin', s.hairpin ? (3 / tilt) * lone : 0],
    ['ess', 20], ['double', 13 * lone], ['triple', 12], ['flow', s.esses ? 11 * Math.sqrt(tilt) : 0], ['winding', 8 * windy * Math.sqrt(tilt)], ['chicane', s.chicane ? 3 / tilt : 0],
  ] as const), 0, 'free', s, rng, gap, false);
  // (Counted as the analysis will count them on the track: a bend of a few degrees or of a great radius is none.)
  const corners = () => list.reduce((a, p) => a + p.bends.filter((b) => b.turn >= 15 * DEG && b.radius * READS_WIDER < NO_CORNER).length, 0) + 2;
  const mandatory = list.length;
  for (let guard = 0; guard < 400 && corners() < wanted; guard++) {
    const p = fill();
    if (corners() + p.bends.length <= wanted + 1) list.push(p);
  }
  // How much the passages turn the lap, all told. One open loop turns once round and little more, so the corners that
  // turn it are made gentler until it does; a lap that folds back may turn as it likes.
  const turning = (p: Passage) => Math.abs(p.bends.reduce((a, b) => a + b.side * b.turn, 0));
  const allowed = (400 + 2400 * Math.pow(s.foldBack, 1.5)) * DEG - 170 * DEG;
  // (A long corner is to go on round: it is not made gentler, and counts for no more than another corner would. But in one open loop it is as any other.)
  const spared = (p: Passage) => p.kind === 'long' && s.foldBack >= 0.3;
  const gentler = list.filter((p) => p.kind !== 'hairpin' && p.kind !== 'chicane' && p.kind !== 'kink' && !spared(p));
  const fixed = list.reduce((a, p) => a + (spared(p) ? Math.min(turning(p), 80 * DEG) : turning(p)), 0) - gentler.reduce((a, p) => a + turning(p), 0);
  for (let pass = 0; pass < 4; pass++) {
    const now = gentler.reduce((a, p) => a + turning(p), 0);
    if (fixed + now <= allowed || now <= 0) break;
    const k = Math.max(0.5, (allowed - fixed) / now);
    for (const p of gentler) {
      // (The corners of a passage that turns one way and then back are brought nearer each other; the others turn less.)
      const net = p.bends.reduce((a, b) => a + b.side * b.turn, 0);
      for (const b of p.bends) {
        b.turn = Math.max(20 * DEG, p.bends.length > 1 && Math.sign(b.side) !== Math.sign(net) ? b.turn : b.turn * k);
        // (A corner that now turns little is one arc.)
        if (b.turn < ONE_ARC) b.arcs = [{ share: 1, ratio: 1 }];
      }
      p.length = lengthOf(p.bends);
      p.eased = easedOf(p.bends);
    }
  }
  // Lengths: what the straights that are asked for and chosen, the corners and the way home leave is shared out over the other straights.
  // (No more than two straights and two corners can be long: the way home is no passage of its own.)
  const reserve = clamp(0.11 * s.length, Math.min(320, 0.2 * s.length), Math.max(320, 1.1 * longest + 250));
  // (The shortest straight between two passages: shorter in a lap that is to be corner after corner. The arcs the
  // corners either side of it are eased by take its place, as far as they go: so the arc before it is counted as
  // the lap's eased corners come to, one with another, which passage will come before it not being known yet.)
  const apart = 30 + 30 * s.speed;
  const out = () => list.reduce((a, p) => a + p.eased[1], 0) / Math.max(1, list.length);
  const shortest = (p: Passage, before = out()) => Math.max(6, apart - p.eased[0] - before);
  const floors = () => {
    const before = out();
    return list.reduce((a, p) => a + (p.hold === 'free' ? shortest(p, before) : 0), 0);
  };
  const most = 0.85 * longest;
  const left = () => s.length - reserve - list.reduce((a, p) => a + p.length + (p.hold === 'free' ? 0 : p.straight), 0);
  const free = () => list.filter((p) => p.hold === 'free');
  // Too full: the chosen straights give way first, as far as leaves them long enough to brake hard at the end of;
  // then the passages that make up the number of corners go; then the chosen straights give way further, and
  // at last what was asked for by name goes too. Each time the corners that take most room are made tighter first.
  const giveWay = (least: (p: Passage) => number) => {
    const chosen = list.filter((p) => p.hold === 'chosen');
    const spare = chosen.reduce((a, p) => a + Math.max(0, p.straight - least(p)), 0);
    const need = floors() - left();
    if (need <= 0 || spare <= 0) return;
    const k = Math.min(1, need / spare);
    for (const p of chosen) p.straight -= k * Math.max(0, p.straight - least(p));
  };
  // (In a lap that is to flow, its long corners and winding roads are the last of them to go.)
  const kept = 1 / (1 + 6 * Math.max(0, s.flow - 0.5));
  const drop = () => {
    const weights = list.slice(mandatory).map((p) => (p.kind === 'long' || p.kind === 'winding' ? kept : 1));
    let at = rng() * weights.reduce((a, w) => a + w, 0);
    let i = 0;
    while (i < weights.length - 1 && (at -= weights[i]) > 0) i++;
    list.splice(mandatory + i, 1);
  };
  // (And before a passage goes, the corners that take most room are made tighter, by up to a fifth each time: a run of esses, a sweeper, a winding road. Not a long corner, which would be one no longer.)
  const tighten = () => {
    for (let pass = 0; pass < 2 && left() < floors(); pass++) {
      for (const p of list) {
        const least = ROOMY[p.kind];
        if (least === undefined) continue;
        for (const b of p.bends) {
          const was = b.radius;
          b.radius = Math.min(was, Math.max(0.9 * was, least, tightestFor(s) / Math.min(...b.arcs.map((a) => a.ratio))));
          // (The arcs it is eased by stay as wide as they were.)
          for (const a of b.arcs) if (a.ease) a.ratio *= was / b.radius;
        }
        p.length = lengthOf(p.bends);
        p.eased = easedOf(p.bends);
      }
    }
  };
  giveWay((p) => Math.min(p.straight, BRAKING_STRAIGHT));
  tighten();
  for (let guard = 0; guard < 200 && list.length > mandatory && left() < floors(); guard++) drop();
  giveWay((p) => 0.5 * Math.min(p.straight, BRAKING_STRAIGHT));
  tighten();
  for (let guard = 0; guard < 200 && left() < floors(); guard++) {
    if (list.length > mandatory) drop();
    else if (list.length > (own ? 2 : 1)) list.splice(list.length - 1, 1);
    else return null;
  }
  // Too empty: more passages, of the kinds that break a straight without slowing the lap much.
  for (let guard = 0; guard < 60 && (free().length ? left() > free().length * most : left() > 150); guard++) {
    list.push(passage(choose(rng, [['kink', 3], ['turn', 3], ['sweeper', s.sweeper ? 2 : 0], ['double', 1]] as const), 0, 'free', s, rng, gap, false));
  }
  const open = free();
  if (open.length) {
    // (The legs of a lap that folds back are long: the straights into its turns right round get more of the length.)
    const weights = open.map((p) => Math.exp(between(rng, -0.9, 0.9)) * (p.kind === 'hairpin' && s.foldBack > 0.6 ? 2.5 : 1));
    let share = left();
    let pool = weights.reduce((a, w) => a + w, 0);
    // (Twice over: what one straight cannot take, being as long or as short as a straight may be, goes to the others.)
    const fixed = new Set<number>();
    const before = out();
    for (let pass = 0; pass < 3; pass++) {
      open.forEach((p, i) => {
        if (fixed.has(i)) return;
        const want = (share * weights[i]) / pool;
        // (No longer than a straight may be, the arcs at its ends counted: where they are wide they read as part of it.)
        p.straight = clamp(want, shortest(p, before), Math.max(shortest(p, before), most - p.eased[0] - before));
        if (p.straight !== want) {
          fixed.add(i);
          share -= p.straight;
          pool -= weights[i];
        }
      });
      if (pool <= 1e-9) break;
    }
  }
  for (const p of list) p.bow = drawBow(p, s, rng, p === start);
  // The order: the start first; the longest straight not straight after it, and no two long straights one after the other, where that can be helped.
  const rest = list.slice(1);
  let order = rest;
  let lowest = Infinity;
  for (let attempt = 0; attempt < 14; attempt++) {
    const shuffled = [...rest];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let cost = own && shuffled[0] === main && shuffled.length > 2 ? 2 : 0;
    const seq = [start, ...shuffled];
    for (let i = 0; i < seq.length; i++) if (seq[i].straight >= 0.5 * longest && seq[(i + 1) % seq.length].straight >= 0.5 * longest && seq.length > 2) cost++;
    if (cost < lowest) {
      lowest = cost;
      order = shuffled;
    }
  }
  const passages = [start, ...order];
  return { passages, reserve, main: passages.indexOf(main) };
}

// ---- the ground ------------------------------------------------------------------

interface Pose { x: number; y: number; h: number }

const ahead = (p: Pose, d: number): Pose => ({ x: p.x + Math.cos(p.h) * d, y: p.y + Math.sin(p.h) * d, h: p.h });
/** Where an arc of `angle` (to the right when positive) at `radius` ends. */
function round(p: Pose, angle: number, radius: number): Pose {
  const k = Math.sign(angle) / radius;
  const h = p.h + angle;
  return { x: p.x + (Math.sin(h) - Math.sin(p.h)) / k, y: p.y - (Math.cos(h) - Math.cos(p.h)) / k, h };
}

/**
 * Points of the lap as it is laid so far, by the square each lies on, to see
 * what a new stretch would come too near. The squares cover the ground out
 * to some distance from where the lap starts; a point further out is on no
 * square, and is near nothing.
 */
class Ground {
  private x: number[] = [];
  private y: number[] = [];
  /** Distance along the lap, or NaN for ground that is only kept free. */
  private s: number[] = [];
  /** The square each point is on, and the point that was the last on that square before it. */
  private square: number[] = [];
  private next: number[] = [];
  private head = new Int32Array(0);
  private cell = 1;
  private side = 0;
  private half = 0;
  private near = 0;

  /** Empties it, for squares of `cell` metres out to `reach` metres. A neighbour along the lap is one within `near` metres. */
  clear(cell: number, near: number, reach: number): void {
    this.back(0);
    this.cell = cell;
    this.near = near;
    this.half = reach;
    this.side = Math.ceil((2 * reach) / cell) + 1;
    if (this.head.length < this.side * this.side) this.head = new Int32Array(this.side * this.side).fill(-1);
  }

  get count(): number { return this.x.length; }

  add(x: number, y: number, s: number): void {
    const gx = Math.floor((x + this.half) / this.cell), gy = Math.floor((y + this.half) / this.cell);
    const square = gx < 0 || gy < 0 || gx >= this.side || gy >= this.side ? -1 : gx * this.side + gy;
    this.next.push(square < 0 ? -1 : this.head[square]);
    if (square >= 0) this.head[square] = this.x.length;
    this.x.push(x);
    this.y.push(y);
    this.s.push(s);
    this.square.push(square);
  }

  /** Takes back everything added after there were `count` points. */
  back(count: number): void {
    for (let i = this.x.length - 1; i >= count; i--) if (this.square[i] >= 0) this.head[this.square[i]] = this.next[i];
    this.x.length = this.y.length = this.s.length = this.square.length = this.next.length = count;
  }

  /**
   * Whether a point at distance `s` along the lap has, within `within`
   * metres, a part of the lap that is not its neighbour along it. `lap` is
   * the length of the whole lap, once that is known: the start is then the
   * neighbour of the end. Ground kept free counts unless `home`. `near` is
   * how far along the lap a neighbour is.
   */
  has(x: number, y: number, s: number, within: number, lap = Infinity, home = false, near = this.near): boolean {
    const reach = Math.ceil(within / this.cell);
    const cx = Math.floor((x + this.half) / this.cell), cy = Math.floor((y + this.half) / this.cell);
    const x0 = Math.max(0, cx - reach), x1 = Math.min(this.side - 1, cx + reach);
    const y0 = Math.max(0, cy - reach), y1 = Math.min(this.side - 1, cy + reach);
    const limit = within * within;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        for (let j = this.head[gx * this.side + gy]; j >= 0; j = this.next[j]) {
          const at = this.s[j];
          if (at !== at) {
            if (home) continue;
          } else {
            const along = Math.abs(s - at);
            if (along < near || lap - along < near) continue;
          }
          const dx = x - this.x[j], dy = y - this.y[j];
          if (dx * dx + dy * dy < limit) return true;
        }
      }
    }
    return false;
  }
}

/** The ground the lap is laid on, and the escape paths kept free on it: used again for every lap, not made anew. */
const GROUND = new Ground();
const ZONES = new Ground();

/** How much further from home than the way home has length for a lap may end, as a share of its length: it may come out a little long. */
const FAR = 0.05;
/** What it is worth, among the ways a passage can go, that its first corner turns the way the last corner did. */
const SAME_WAY = 0.45;
/** Points along the lap are this far apart, metres. */
const STEP = 12;
/** A lap keeps to its plot where it can, and never goes further out than this many times its size: less, the more compact it is to be. */
const edgeOf = (s: GeneratorSettings) => 1.5 - 0.3 * s.compact;

/** The shortest way from one pose to another for something that turns no tighter than `rho` (a Dubins path), metres: how far the lap is from home. */
function wayHome(from: Pose, to: Pose, rho: number): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.hypot(dx, dy) / rho;
  const th = Math.atan2(dy, dx);
  const a = mod2pi(from.h - th), b = mod2pi(to.h - th);
  const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b), cab = Math.cos(a - b);
  let best = Infinity;
  let p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
  if (p2 >= 0) {
    const t = Math.atan2(cb - ca, d + sa - sb);
    best = Math.min(best, mod2pi(-a + t) + Math.sqrt(p2) + mod2pi(b - t));
  }
  p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
  if (p2 >= 0) {
    const t = Math.atan2(ca - cb, d - sa + sb);
    best = Math.min(best, mod2pi(a - t) + Math.sqrt(p2) + mod2pi(-b + t));
  }
  p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
  if (p2 >= 0) {
    const p = Math.sqrt(p2);
    const t = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
    best = Math.min(best, mod2pi(-a + t) + p + mod2pi(-b + t));
  }
  p2 = d * d - 2 + 2 * cab - 2 * d * (sa + sb);
  if (p2 >= 0) {
    const p = Math.sqrt(p2);
    const t = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
    best = Math.min(best, mod2pi(a - t) + p + mod2pi(b - t));
  }
  return Number.isFinite(best) ? best * rho : (d + TAU) * rho;
}

/** One stretch of the lap as laid: a straight, then an arc (to the right when positive). */
interface Leg { straight: number; angle: number; radius: number; kind: PassageKind | 'home' }

/** The arcs of a corner turned by `angle` (to the right when positive), as stretches of the lap, the first after `straight` metres of straight. */
function legsOf(b: Bend, angle: number, straight: number, kind: Leg['kind']): Leg[] {
  if (Math.abs(angle) < ONE_ARC || b.arcs.length === 1) return [{ straight, angle, radius: b.radius, kind }];
  return b.arcs.map((a, j) => ({ straight: j ? 0 : straight, angle: angle * a.share, radius: b.radius * a.ratio, kind }));
}

/** Where a pose comes to along some stretches of the lap, and how long they are. */
function along(from: Pose, legs: readonly Leg[]): { pose: Pose; length: number } {
  let p = from;
  let length = 0;
  for (const leg of legs) {
    p = round(ahead(p, leg.straight), leg.angle, leg.radius);
    length += leg.straight + Math.abs(leg.angle) * leg.radius;
  }
  return { pose: p, length };
}

/**
 * What draws came to, for looking into how often laps come round and why
 * not: plans made, laps that reached their last passage, laps that came
 * home (and how many of those before their last passage), ways tried, and
 * ways that were dropped for the heading, for crowding the lap or leaving
 * the plot, for being out of reach of home and for want of room ahead; and
 * draws that ran out of tries.
 */
export interface ComposeTrace { plan: number; laid: number; closed: number; early: number; tries: number; band: number; crowd: number; leash: number; blocked: number; spent: number }

/**
 * Run-off, for a lap built to a licence: the ground a car that misses a
 * corner needs is kept free. `depth` is how far beyond the edge of the track
 * that is at a speed (m/s); the speeds are those of `pace`.
 */
export interface Runoff { width: number; pace: Pace; depth(speed: number): number }
/**
 * An escape path is kept for a corner that turns this much (radians) at under this radius. The licence check looks
 * at corners of 10 degrees that are tighter than 300 m somewhere; a bend drawn a little short of that may read as one
 * on the track, so the lap keeps the ground beyond those too.
 */
const RUNOFF_TURN = 0.14;
const RUNOFF_RADIUS = 400;
/**
 * Another part of the lap is in the way of an escape path when it is more than this far from it along the lap. The
 * licence check has 300 m, on the track as built: a little less here, since the lap is laid before it is brought
 * to length.
 */
const RUNOFF_APART = 270;

/**
 * The lap's greatest extent as a share of its length, as asked: half for a
 * lap spread out, a fifth for a compact one; real circuits have 0.35. One
 * open loop cannot be compact: it is as far across as a loop of its length
 * is.
 */
export function spreadWanted(s: GeneratorSettings): number {
  return Math.max(REAL.spread[1] + 0.3 * (0.5 - s.compact), 0.44 - 0.5 * s.foldBack);
}

/** The plot of land a lap is laid out on: an ellipse, by its middle, half its length and width, and how it is turned. */
interface Plot { x: number; y: number; a: number; b: number; cos: number; sin: number }

/**
 * A plot for a lap: as far across as the lap is to be spread, longer than
 * wide by a little or (for a lap that is to be spread out) by a lot, turned
 * any way, and lying so that the start straight is on it with the middle of
 * the plot to its right, where a lap that runs clockwise goes. No smaller
 * than a lap of this length needs with a gap between its parts, nor than the
 * longest straight is long.
 */
function drawPlot(s: GeneratorSettings, plan: Plan, rng: Rng, gap: number): Plot {
  const start = plan.passages[0].straight;
  const aspect = between(rng, 1, 1.5 + 1.8 * (1 - s.compact) ** 2);
  let a = (0.6 * spreadWanted(s) * s.length) / Math.sqrt(1 + 1 / (aspect * aspect));
  a = Math.max(a, Math.sqrt((3.2 * s.length * gap * aspect) / Math.PI), 0.62 * s.longestStraight + 80);
  for (let grow = 0; grow < 8; grow++) {
    const b = a / aspect;
    for (let attempt = 0; attempt < 40; attempt++) {
      const turn = rng() * Math.PI;
      const cos = Math.cos(turn), sin = Math.sin(turn);
      // Somewhere in the plot, as seen from the middle of the start straight.
      const r = 0.85 * Math.sqrt(rng()), at = rng() * TAU;
      const u = r * Math.cos(at) * a, v = r * Math.sin(at) * b;
      const plot: Plot = { x: start / 2 + u * cos - v * sin, y: u * sin + v * cos, a, b, cos, sin };
      if (plot.y > 0.15 * b && on(plot, -90, 0, 0.94) && on(plot, start + 90, 0, 0.94)) return plot;
    }
    a *= 1.12;
  }
  return { x: start / 2, y: a / aspect / 2, a: a * 1.3, b: (a * 1.3) / aspect, cos: 1, sin: 0 };
}

function on(plot: Plot, x: number, y: number, part = 1): boolean {
  const dx = x - plot.x, dy = y - plot.y;
  const u = (dx * plot.cos + dy * plot.sin) / (plot.a * part), v = (-dx * plot.sin + dy * plot.cos) / (plot.b * part);
  return u * u + v * v <= 1;
}

/**
 * Lays a plan out on the ground. Null when no way was found.
 *
 * The lap is laid as one that runs clockwise, on a plot of land it may not
 * leave. Its heading is kept near a steady turn once round (real circuits
 * stray up to two thirds of a turn from that, and so may this one), and it
 * is kept within reach of home: the shortest way back never longer than
 * most of what the passages still to come are long. Of the ways a passage
 * can go, a lap that is to fold back takes one that runs beside what is
 * there, and a lap that is not takes one that keeps away.
 */
function layOut(plan: Plan, s: GeneratorSettings, rng: Rng, gap: number, runoff: Runoff | null, trace?: ComposeTrace): { legs: Leg[]; main: number } | null {
  const near = Math.max(2.5 * gap, 110);
  const plot = drawPlot(s, plan, rng, gap);
  // The lap does not go further from its start than the far side of its plot, nor its escape paths much further.
  const EDGE = edgeOf(s);
  const reach = Math.hypot(plot.x, plot.y) + EDGE * plot.a + 250;
  const ground = GROUND;
  ground.clear(gap, near, reach);
  // Escape paths: the ground straight on from where each corner is turned into, and along the lap at its apex.
  const zones = ZONES;
  zones.clear(40, RUNOFF_APART, reach);
  const side = runoff ? runoff.width / 2 + 11 : 0;
  const pace = runoff?.pace ?? null;
  const walk = s.length - plan.reserve;
  // The lap ends with half a turn or so still to make: the two corners home.
  const windEnd = TAU - 170 * DEG;
  // How far the heading may stray from that. Ahead of it: little for one open loop (but enough for the passage that
  // turns most to go in at all), three quarters of a turn for a lap that is all folds. Behind it, which is turning
  // back against the way round: hardly at all for one open loop, and as far for a lap that is all folds.
  const most = Math.max(...plan.passages.map((p) => Math.abs(p.bends.reduce((a, b) => a + b.side * b.turn, 0))));
  const ahead0 = Math.max((70 + 220 * s.foldBack) * DEG, 0.56 * most + 20 * DEG);
  const behind0 = (45 + 245 * s.foldBack) * DEG;
  const strayEnd = 105 * DEG;
  const home: Pose = { x: 0, y: 0, h: 0 };
  // (How far the lap is from home is reckoned to a place a little behind the start, for something that turns as a slow corner does: both smaller on a short lap.)
  const approach = ahead(home, -Math.min(60, s.length / 40));
  const tightly = Math.min(45, s.length / 60);
  // Ground behind the start is kept free for the way home.
  const keep = Math.min(0.35 * plan.reserve, 260);
  for (let t = gap; t <= Math.max(keep, 2 * gap); t += STEP) ground.add(-t, 0, NaN);
  const legs: Leg[] = [];
  /** The passages in the order they were laid, each with the first of its stretches. */
  const order: { index: number; from: number }[] = [];
  let budget = 150 + 40 * plan.passages.length;
  // How far from home the lap may end: what the way home has length for, and its two straights can span.
  const farthest = Math.min(plan.reserve + FAR * s.length, 1.2 * s.longestStraight + 250);
  // A lap of few passages has few ways to come round: each of them is tried more ways, and turned more or less than it was drawn by more.
  const variants = clamp(Math.round(48 / plan.passages.length / 2) * 2, 4, 16);
  const loose = clamp(1.5 / plan.passages.length, 0.12, 0.45);
  const beside = 1.9 * gap;
  const liking = 3 * (s.foldBack - 0.3) * (s.foldBack > 0.3 ? besideAtLength(s) : 1);
  // A lap that is to be spread out heads away from home for the first half of its length, and a compact one stays near.
  const roaming = 1.6 * (0.5 - s.compact);

  /**
   * Goes along a stretch from a pose, a point every few metres, and puts it
   * on the ground, entered at `speed`. Null (with nothing left behind) when
   * a point is off the plot or crowds the lap, or (with run-off to keep)
   * lies in an escape path or has one of its own blocked; else where it
   * ends, how long it is, what share of it runs beside another part of the
   * lap, and the speed it is left at.
   */
  const lay = (from: Pose, at: number, parts: Leg[], speed: number, lap = Infinity): { pose: Pose; length: number; beside: number; off: number; speed: number } | null => {
    const mark = ground.count, zoned = zones.count;
    const closing = lap < Infinity;
    let px = from.x, py = from.y, h = from.h;
    let d = at;
    let count = 0, looked = 0, close2 = 0, off = 0;
    const fail = () => {
      ground.back(mark);
      zones.back(zoned);
      return null;
    };
    const point = (x: number, y: number, dist: number): boolean => {
      if (!on(plot, x, y, EDGE) || ground.has(x, y, dist, gap, lap, closing)) return false;
      if (runoff && zones.has(x, y, dist, side, lap)) return false;
      // (Every third point is looked at for what it runs beside, and for whether it is off the plot.)
      if (count++ % 3 === 0) {
        looked++;
        if (!on(plot, x, y)) off++;
        if (!closing && ground.has(x, y, dist, beside)) close2++;
      }
      ground.add(x, y, dist);
      return true;
    };
    /** An escape path of some depth from a place on the lap: free of the lap as it stands, and kept free from now on. */
    const escape = (x: number, y: number, heading: number, dist: number, depth: number): boolean => {
      // (From the middle of the road: half its width, the run-off, half the width of what would be in the way, and
      // what the lap may lose of it when it is made smaller to its length and built.)
      const reach = depth + runoff!.width + 14;
      const co = Math.cos(heading), si = Math.sin(heading);
      for (let t = STEP; t <= reach; t += STEP) if (ground.has(x + co * t, y + si * t, dist, side, lap, true, RUNOFF_APART)) return false;
      for (let t = STEP; t <= reach; t += STEP) zones.add(x + co * t, y + si * t, dist);
      return true;
    };
    // The corners among the stretches: each run of arcs the same way with no straight between them. How far each
    // turns, all told (that is what sets the line a car takes through it, and so its speed), and which stretch is
    // where a corner the licence check will read as one is turned into, however wide that first arc is.
    const turned = new Array<number>(parts.length).fill(0);
    const enters = new Array<boolean>(parts.length).fill(false);
    for (let i = 0; i < parts.length;) {
      let j = i, turn = 0, tightest = Infinity;
      do {
        turn += Math.abs(parts[j].angle);
        tightest = Math.min(tightest, parts[j].radius);
        j++;
      } while (j < parts.length && parts[j].straight < 1 && Math.sign(parts[j].angle) === Math.sign(parts[i].angle));
      enters[i] = turn >= RUNOFF_TURN && tightest < RUNOFF_RADIUS;
      for (let k = i; k < j; k++) turned[k] = turn;
      i = j;
    }
    let v = speed;
    for (let i = 0; i < parts.length; i++) {
      const leg = parts[i];
      const co = Math.cos(h), si = Math.sin(h);
      const n1 = Math.max(1, Math.ceil(leg.straight / STEP));
      for (let k = 1; k <= n1; k++) {
        const t = (leg.straight * k) / n1;
        if (!point(px + co * t, py + si * t, d + t)) return fail();
      }
      px += co * leg.straight;
      py += si * leg.straight;
      d += leg.straight;
      // The arc, round its middle point (to the right of the way it is going when it turns right).
      const r = leg.radius * Math.sign(leg.angle);
      const cx = px - r * si, cy = py + r * co;
      const arc = Math.abs(leg.angle) * leg.radius;
      // The speeds: what the corner takes, and the highest on the straight into it.
      const taken = pace && runoff ? Math.min(pace.top, pace.corner(lineRadius(leg.radius, turned[i], runoff.width))) : 0;
      const into = pace ? peakSpeed(pace, v, taken, leg.straight) : 0;
      if (runoff) {
        const corner = Math.abs(leg.angle) >= RUNOFF_TURN && leg.radius < RUNOFF_RADIUS;
        // Straight on from where it is turned into, at the highest speed of the 100 m before (which, with hardly a
        // straight before it, is the speed the corner before was left at); and along the lap at its apex.
        if ((corner || enters[i]) && !escape(px, py, h, d, runoff.depth(leg.straight < 100 ? Math.max(into, v) : into))) return fail();
        // (An arc of one radius has its apex wherever the track as built happens to be tightest: one that turns far is looked at in three places.)
        for (const at of corner ? (Math.abs(leg.angle) >= 0.9 ? [0.5, 0.2, 0.8] : [0.5]) : []) {
          const apex = h + leg.angle * at;
          if (!escape(cx + r * Math.sin(apex), cy - r * Math.cos(apex), apex, d + arc * at, runoff.depth(taken))) return fail();
        }
      }
      // (It is left at what it takes, or at what a car comes to by its end, when that is less: a wide arc a corner is eased in by is not come out of at the speed it could be taken at.)
      const entered = Math.min(taken, Math.max(into, v));
      v = pace ? Math.min(taken, Math.sqrt(entered * entered + 2 * Math.max(0, pace.drive(entered)) * arc)) : 0;
      const n2 = Math.max(1, Math.ceil(arc / STEP));
      for (let k = 1; k <= n2; k++) {
        const a = h + (leg.angle * k) / n2;
        if (!point(cx + r * Math.sin(a), cy - r * Math.cos(a), d + (arc * k) / n2)) return fail();
      }
      h += leg.angle;
      px = cx + r * Math.sin(h);
      py = cy - r * Math.cos(h);
      d += arc;
    }
    return { pose: { x: px, y: py, h }, length: d - at, beside: close2 / Math.max(1, looked), off: off / Math.max(1, looked), speed: v };
  };
  /** Takes back what was laid after a mark. */
  const marks = (): [number, number] => [ground.count, zones.count];
  const back = (mark: [number, number]) => {
    ground.back(mark[0]);
    zones.back(mark[1]);
  };

  /**
   * A corner on the way home that turns by `angle`: its radius from the mix, a sharp turn more often a slow one, its
   * arcs as any corner's, and no longer than a tenth of the lap. In a lap that flows, one that turns far is
   * a long corner more often than not.
   */
  const cornerFor = (angle: number, straight: number): Leg[] => {
    const turn = Math.abs(angle);
    const long = turn >= 80 * DEG && rng() < (0.15 + 1.2 * (s.flow - 0.5)) * Math.min(1, longShare(s));
    const outline: Outline = long ? longCorner(turn, s, rng) : { turn, side: 1, radius: drawRadius(s, rng, clamp((80 * DEG - turn) / (70 * DEG), -1, 1) * (1 - s.flow)), link: 0 };
    const b: Bend = { ...outline, arcs: drawArcs(long ? 'long' : 'home', outline, 0, 1, s, rng) };
    b.radius = Math.max(tightestFor(s), Math.min(b.radius, Math.max(20, (0.1 * s.length) / (turn * stretch(b.arcs)))));
    soften(b, tightestFor(s));
    ease(b, true, true, s, rng, false);
    return legsOf(b, angle, straight, 'home');
  };

  /**
   * The way home from where the last passage ends: two corners (or one)
   * that bring the lap onto its start straight, worked out and not drawn.
   * Where no two do it, a third first, turned and placed every way.
   */
  const close = (from: Pose, used: number, wound: number, speed: number): boolean => {
    if (closeWith(from, used, wound, speed, [])) return true;
    const first = rng() < 0.5 ? 1 : -1;
    for (const lead of [40, 130, 250]) {
      for (const turn of [35, 60, 85, 110, 140, 170]) {
        for (const way of [first, -first]) {
          const angle = way * turn * DEG;
          const third = cornerFor(angle, lead * between(rng, 0.8, 1.2));
          const mark = marks();
          const laid = lay(from, used, third, speed);
          if (!laid) continue;
          const done = closeWith(laid.pose, used + laid.length, wound + angle, laid.speed, third);
          back(mark);
          if (done) return true;
        }
      }
    }
    return false;
  };

  /** The two corners home (or the one) from a pose, after the corners `before` that are part of the way home too. */
  const closeWith = (from: Pose, used: number, wound: number, speed: number, before: Leg[]): boolean => {
    const turn = TAU - wound;
    const start = plan.passages[0].straight;
    const own = ownStart(s);
    const cLo = -0.03 * start, cHi = (own ? 0.12 : 0.06) * start;
    const longest = 0.85 * s.longestStraight;
    const target = s.length - used;
    // The lap may come out a little long or short: it is brought to length afterwards. Less long than short, since
    // making a lap smaller brings its parts nearer each other.
    const tolerance = 0.07 * s.length;
    const fits = (length: number) => length - target <= LONG * s.length && target - length <= tolerance;
    const ux = Math.cos(from.h), uy = Math.sin(from.h);
    const options: { legs: Leg[]; shift: number; cost: number }[] = [];
    const phase = rng() * 8 * DEG;
    for (let a1 = -170 * DEG + phase; a1 <= 205 * DEG; a1 += 8 * DEG) {
      const a2 = turn - a1;
      if (Math.abs(a1) < 14 * DEG || Math.abs(a2) < 14 * DEG || Math.abs(a2) > 205 * DEG) continue;
      const one = cornerFor(a1, 0), two = cornerFor(a2, 0);
      const first = along({ x: 0, y: 0, h: from.h }, one);
      const second = along(first.pose, two);
      const mid = first.pose, end = second.pose;
      // from + a u + (the two arcs) + b u1 = home - c u0, with u0 = (1, 0): a u + b u1 + c u0 = q.
      const qx = home.x - from.x - end.x, qy = home.y - from.y - end.y;
      const vx = Math.cos(mid.h), vy = Math.sin(mid.h);
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < 0.08) continue;
      // The answer with c = 0, and what a, b and c change by together along the line of answers.
      const a0 = (qx * vy - qy * vx) / det, b0 = (ux * qy - uy * qx) / det;
      const na = vy / det, nb = -uy / det, nc = -1;
      let lo = -Infinity, hi = Infinity;
      const bound = (v0: number, n: number, least: number, most: number) => {
        if (Math.abs(n) < 1e-9) {
          if (v0 < least || v0 > most) lo = Infinity;
          return;
        }
        const t1 = (least - v0) / n, t2 = (most - v0) / n;
        lo = Math.max(lo, Math.min(t1, t2));
        hi = Math.min(hi, Math.max(t1, t2));
      };
      bound(a0, na, 25, longest);
      bound(b0, nb, 20, longest);
      bound(0, nc, cLo, cHi);
      if (lo > hi) continue;
      const arcs = first.length + second.length;
      const rate = na + nb + nc;
      const t = clamp(Math.abs(rate) < 1e-9 ? (lo + hi) / 2 : (target - a0 - b0 - arcs) / rate, lo, hi);
      const a = a0 + t * na, b = b0 + t * nb, c = t * nc;
      const off = Math.abs(a + b + c + arcs - target);
      if (!fits(a + b + c + arcs)) continue;
      const odd = (x: number) => (Math.abs(x) < 30 * DEG || Math.abs(x) > 160 * DEG ? 0.3 : 0);
      one[0].straight = a;
      two[0].straight = b;
      options.push({ legs: [...one, ...two], shift: c, cost: off / tolerance + 0.3 * Math.abs(c / start) + odd(a1) + odd(a2) + 0.2 * rng() });
    }
    // One corner home.
    if (Math.abs(turn) >= 20 * DEG && Math.abs(turn) <= 200 * DEG && Math.abs(uy) > 0.08) {
      const one = cornerFor(turn, 0);
      const { pose: end, length: arc } = along({ x: 0, y: 0, h: from.h }, one);
      const qx = home.x - from.x - end.x, qy = home.y - from.y - end.y;
      // a u + c u0 = q.
      const a = qy / uy, c = qx - a * ux;
      const off = Math.abs(a + c + arc - target);
      if (a >= 25 && a <= longest && c >= cLo && c <= cHi && fits(a + c + arc)) {
        one[0].straight = a;
        options.push({ legs: one, shift: c, cost: off / tolerance + 0.3 * Math.abs(c / start) + 0.3 + 0.2 * rng() });
      }
    }
    options.sort((p, q) => p.cost - q.cost);
    for (const option of options.slice(0, before.length ? 3 : 8)) {
      // Clear of the lap, the start straight its neighbour now.
      const lap = used + option.legs.reduce((a, l) => a + l.straight + Math.abs(l.angle) * l.radius, 0) + option.shift;
      const mark = marks();
      if (!lay(from, used, option.legs, speed, lap)) continue;
      back(mark);
      legs.push(...before, ...option.legs);
      legs[0].straight += option.shift;
      return true;
    }
    return false;
  };

  /** How far the ground straight on from a pose is free, up to `most` metres. */
  const roomAhead = (from: Pose, at: number, most: number): number => {
    for (let t = STEP; t <= most; t += STEP) {
      const q = ahead(from, t);
      if (!on(plot, q.x, q.y, EDGE) || ground.has(q.x, q.y, at + t, gap) || (runoff && zones.has(q.x, q.y, at + t, side))) return t - STEP;
    }
    return most;
  };
  const isLong = (p: Passage) => p.straight >= 0.5 * s.longestStraight;

  /**
   * Lays the passages still to come, from a pose. Which comes next is the
   * plan's to say where it fits; where the straight it needs has no room, or
   * there is room for a long straight that has to go somewhere, another
   * goes first.
   */
  const place = (remaining: number[], from: Pose, used: number, wound: number, afterLong: boolean, speed: number): boolean => {
    if (!remaining.length) {
      if (trace) trace.laid++;
      return close(from, used, wound, speed);
    }
    // With only passages left that make up the number, and the lap nearly as long as asked: home from here, if there is a way.
    if (s.length - used <= Math.max(1.5 * plan.reserve, plan.reserve + 0.05 * s.length) && !remaining.some((i) => plan.passages[i].must) && close(from, used, wound, speed)) {
      if (trace) trace.early++;
      return true;
    }
    const first = remaining[0] === 0;
    const room = first ? Infinity : roomAhead(from, used, 1.2 * Math.max(...remaining.map((i) => plan.passages[i].straight)));
    const able = first ? [0] : remaining.filter((i) => 0.9 * plan.passages[i].straight <= room);
    if (!able.length) {
      if (trace) trace.blocked++;
      return false;
    }
    // Up to three of them, by how much each is wanted here.
    const weights = able.map((i) => {
      const p = plan.passages[i];
      const order = remaining.indexOf(i);
      return (order === 0 ? 3 : order === 1 ? 1.5 : 1) * (p.must ? 2 : 1) * (isLong(p) ? (afterLong ? 0.2 : 1 + 6 * (p.straight / room) ** 2) : 1);
    });
    const picks: number[] = [];
    for (let k = 0; k < 3 && picks.length < able.length; k++) {
      let at = rng() * weights.reduce((a, w) => a + w, 0);
      const j = Math.max(0, weights.findIndex((w) => (at -= w) < 0));
      picks.push(able[j]);
      weights[j] = 0;
    }
    const ways: { index: number; parts: Leg[]; net: number; score: number }[] = [];
    for (const index of picks) {
      const p = plan.passages[index];
      const rest = remaining.filter((i) => i !== index);
      const least = rest.length ? 0.9 * Math.min(...rest.map((i) => plan.passages[i].straight)) : 60;
      const side = rng() < 0.5 ? 1 : -1;
      for (let variant = 0; variant < variants; variant++) {
        if (--budget < 0) return false;
        if (trace) trace.tries++;
        const way = variant % 2 ? -side : side;
        const more = between(rng, 1 - loose, 1 + loose);
        const straight = Math.min(p.straight * (p.hold === 'asked' ? between(rng, 0.98, 1.02) : between(rng, 0.9, 1.14)), room);
        const parts = passageLegs(p, way, rng() < 0.5 ? 1 : -1, straight, (b) => clamp(b.turn * more * between(rng, 0.94, 1.06), 8 * DEG, 208 * DEG));
        const net = parts.reduce((a, l) => a + l.angle, 0);
        const length = parts.reduce((a, l) => a + l.straight + Math.abs(l.angle) * l.radius, 0);
        // The heading, against a steady turn once round.
        const part = Math.min(1, (used + length) / walk);
        const narrow = part * part * part;
        const off = wound + net - windEnd * part;
        if (off > ahead0 + (Math.min(strayEnd, ahead0) - ahead0) * narrow || -off > behind0 + (Math.min(strayEnd, behind0) - behind0) * narrow) {
          if (trace) trace.band++;
          continue;
        }
        const mark = marks();
        const laid = lay(from, used, parts, speed);
        if (!laid) {
          if (trace) trace.crowd++;
          continue;
        }
        // Within reach of home, and room ahead for a straight that is still to come.
        const togo = Math.max(0, walk - used - laid.length);
        const reach = wayHome(laid.pose, approach, tightly) <= 0.75 * togo + farthest;
        const open = reach && roomAhead(laid.pose, used + laid.length, least) >= least;
        back(mark);
        if (!reach || !open) {
          if (trace) trace[reach ? 'blocked' : 'leash']++;
          continue;
        }
        const away = used + laid.length < 0.45 * walk ? (Math.hypot(laid.pose.x, laid.pose.y) - Math.hypot(from.x, from.y)) / laid.length : 0;
        // (A lap that keeps clear of itself turns the other way more often than not. On real circuits a corner at the
        // end of a straight turns the way the last one did about as often as not: so that way is a little preferred.)
        const same = legs.length && Math.sign(parts[0].angle) === Math.sign(legs[legs.length - 1].angle) ? SAME_WAY : 0;
        ways.push({ index, parts, net, score: liking * laid.beside - 1.5 * laid.off + roaming * away + same + 0.25 * rng() });
      }
    }
    ways.sort((a, b) => b.score - a.score);
    for (const way of ways.slice(0, 3)) {
      const mark = marks();
      const laid = lay(from, used, way.parts, speed);
      if (!laid) continue;
      const before = legs.length;
      legs.push(...way.parts);
      order.push({ index: way.index, from: before });
      if (place(remaining.filter((i) => i !== way.index), laid.pose, used + laid.length, wound + way.net, isLong(plan.passages[way.index]), laid.speed)) return true;
      order.pop();
      legs.length = before;
      back(mark);
      if (budget < 0) return false;
    }
    return false;
  };

  const done = place(plan.passages.map((_, i) => i), home, 0, 0, true, pace ? pace.corner(60) : 0);
  if (trace && budget < 0) trace.spent++;
  // (The stretch the longest straight is the straight of.)
  return done ? { legs, main: order.find((o) => o.index === plan.main)?.from ?? 0 } : null;
}

// ---- the shape -------------------------------------------------------------------

/** An arc of more than this is drawn as two or more, each a corner of the polygon. */
const MOST_ARC = 115 * DEG;

/**
 * One lap, drawn from random numbers. Null when the draw does not work out
 * (the passages do not go into the length, no way round was found, the lap
 * came out too long or too short): the caller draws again.
 */
export function composeLap(s: GeneratorSettings, rng: Rng, gap: number, runoff: Runoff | null = null, trace?: ComposeTrace): Shape | null {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const shape = composeOnce(s, rng, gap, runoff, trace);
    if (shape) return shape;
  }
  return null;
}

/** A lap is laid with its parts this much further apart than they are to be, and may come out this much too long: made smaller to its length, its parts are still a gap apart. */
const APART = 1.05;
const LONG = 0.04;
/** A draw is this many plans at most, each laid out once: the first that comes round is the lap. */
const ATTEMPTS = 3;

function composeOnce(s: GeneratorSettings, rng: Rng, gap: number, runoff: Runoff | null, trace?: ComposeTrace): Shape | null {
  const plan = drawPlan(s, rng, gap * APART);
  if (!plan) return null;
  if (trace) trace.plan++;
  const laid = layOut(plan, s, rng, gap * APART, runoff, trace);
  if (!laid) return null;
  const { legs } = laid;
  if (trace) trace.closed++;
  // The polygon: each arc's corner is where the straights either side of it would meet.
  const v: Shape['v'] = [];
  let p: Pose = { x: 0, y: 0, h: 0 };
  let length = 0;
  let longest = -1;
  let main = 0;
  const firstOf: number[] = [];
  legs.forEach((leg, i) => {
    p = ahead(p, leg.straight);
    length += leg.straight + Math.abs(leg.angle) * leg.radius;
    if (i > 0 && leg.straight > longest) {
      longest = leg.straight;
      main = v.length - 1;
    }
    firstOf.push(v.length);
    const parts = Math.max(1, Math.ceil(Math.abs(leg.angle) / MOST_ARC));
    for (let k = 0; k < parts; k++) {
      const a = leg.angle / parts;
      const corner = ahead(p, leg.radius * Math.tan(Math.abs(a) / 2));
      v.push({ x: corner.x, y: corner.y, r: leg.radius });
      p = round(p, a, leg.radius);
    }
  });
  const n = v.length;
  // The start straight runs from the last corner to the first; the longest is that one, or the one the plan gave its length.
  const start = n - 1;
  if (legs[0].straight >= longest) main = start;
  else if (laid.main > 0) main = firstOf[laid.main] - 1;
  // To length, and the way round asked.
  const k = s.length / length;
  const want = s.direction === 'either' ? (rng() < 0.5 ? 'clockwise' : 'anticlockwise') : s.direction;
  const flip = want === 'clockwise' ? 1 : -1;
  for (const q of v) {
    q.x *= k;
    q.y *= k * flip;
    q.r *= k;
  }
  const kinds = new Set(legs.map((l) => l.kind));
  return { v, start, main: (main + n) % n, made: { hairpin: kinds.has('hairpin'), chicane: kinds.has('chicane'), esses: kinds.has('flow'), sweeper: kinds.has('sweeper') } };
}
