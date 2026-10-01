/**
 * How the race is shown in 3D, apart from drawing: which car model each
 * class gets, each team's livery, and keeping cars from driving through each
 * other.
 *
 * The race model places a car by its progress along the lap and a small
 * sideways offset (passing, the pit roads, the grid). Its spacing rule keeps
 * cars apart nearly always, but at the start, while passing and when
 * lapping, two cars can share a spot; drawn as dots that does not matter,
 * drawn as cars it would. `spreadCars` moves such cars side by side within
 * the track's width, easing in and out. It only changes the picture, never
 * the race.
 */
import { BODIES } from './carBodies.ts';

export interface BodyVehicle {
  id: string;
  kind: 'car' | 'bike';
  mass: number;
  clA: number | [number, number];
}

/** The car model for a vehicle class: its own when there is one, otherwise the nearest kind of car. */
export function bodyFor(v: BodyVehicle): string {
  if (BODIES.includes(v.id)) return v.id;
  if (v.kind === 'bike') return v.mass < 230 ? 'motogp' : 'superbike';
  const cl = Array.isArray(v.clA) ? v.clA[1] : v.clA;
  if (cl > 3 && v.mass < 900) return 'f1';
  if (cl > 2.5 && v.mass < 800) return 'f2';
  if (cl > 2) return 'hypercar';
  return v.mass < 1250 ? 'gt3' : 'tcr';
}

export interface Livery {
  /** Main, second and accent colours, '#rrggbb'. */
  a: string;
  b: string;
  c: string;
  /** Pattern (0..4) and its variation (0..1), see the car material. */
  pattern: number;
  variation: number;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function hex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** Relative luminance, 0 black to 1 white. */
function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
}

/**
 * A team's livery from its colour: a second colour that stands out against
 * it (white, black, silver or a darker or lighter shade), an accent, and a
 * pattern, all fixed by the team's name so both cars of a team match.
 */
export function liveryFor(team: string, color: string): Livery {
  const h = hash(team);
  const light = luminance(color) > 0.35;
  const seconds = light ? ['#141414', '#1d2a44', mix(color, '#000000', 0.6), '#2b2b2b'] : ['#f2f2f2', '#b9bec4', mix(color, '#ffffff', 0.65), '#141414'];
  let b = seconds[h % seconds.length];
  // A dark second colour on a dark car would vanish: lighten it.
  if (Math.abs(luminance(b) - luminance(color)) < 0.12) b = light ? '#141414' : '#f2f2f2';
  const accents = ['#ffd60a', '#ff2d2d', '#2ad1ff', '#ffffff', '#ff8a00', '#39d353'];
  let c = accents[(h >>> 4) % accents.length];
  if (Math.abs(luminance(c) - luminance(color)) < 0.08) c = accents[((h >>> 4) + 1) % accents.length];
  return { a: color, b, c, pattern: (h >>> 8) % 5, variation: ((h >>> 12) % 100) / 100 };
}

/** The safety car: silver with an orange and white stripe. */
export const SAFETY_LIVERY: Livery = { a: '#c9ced4', b: '#ff7a00', c: '#ffffff', pattern: 1, variation: 0.4 };

export interface SpreadCar {
  id: number;
  /** Progress along the lap in stations (any lap; only the position within the lap counts). */
  u: number;
  /** The race model's sideways offset from the racing line, metres (positive left). */
  lateral: number;
  length: number;
  width: number;
}

export interface SpreadTrack {
  n: number;
  ds: number;
  /** Track width per station. */
  width: ArrayLike<number>;
  /** The racing line's offset from the centre line per station (positive left). */
  lineOffset: ArrayLike<number>;
}

/** Sideways clearance kept between two cars, metres. */
const CLEARANCE = 0.6;
/** How fast a car moves aside, metres per second of race time. */
const ASIDE_RATE = 5;

/**
 * Extra sideways offsets that keep overlapping cars side by side: for cars
 * within a car length of each other along the lap whose drawn positions
 * would touch, each moves half the overlap away from the other (the car
 * behind picks the side with more room when they are level), within the
 * track's edges. Offsets ease towards their targets at a few metres per
 * second of race time (`dt`), from the previous ones in `previous`.
 */
export function spreadCars(cars: readonly SpreadCar[], track: SpreadTrack, previous: ReadonlyMap<number, number>, dt: number): Map<number, number> {
  const n = track.n;
  const pos = (u: number) => ((u % n) + n) % n;
  const order = [...cars].sort((a, b) => pos(a.u) - pos(b.u));
  const target = new Map<number, number>(order.map((c) => [c.id, 0]));
  const room = (c: SpreadCar) => {
    const k = Math.floor(pos(c.u)) % n;
    const half = track.width[k] / 2 - c.width / 2 - 0.25;
    // Limits on the offset from the racing line.
    return { lo: -half - track.lineOffset[k], hi: half - track.lineOffset[k] };
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length + i; j++) {
        const b = order[j % order.length];
        if (b === a) break;
        let along = pos(b.u) - pos(a.u);
        if (along < 0) along += n;
        const reach = (a.length + b.length) / 2 + 1;
        if (along * track.ds > reach) break;
        const la = a.lateral + target.get(a.id)!;
        const lb = b.lateral + target.get(b.id)!;
        const overlap = (a.width + b.width) / 2 + CLEARANCE - Math.abs(la - lb);
        if (overlap <= 0) continue;
        let dir = Math.sign(lb - la);
        if (dir === 0) {
          // Level: the car ahead stays, the one behind goes where there is more room.
          const r = room(a);
          dir = r.hi - la > la - r.lo ? 1 : -1;
        }
        target.set(b.id, target.get(b.id)! + (dir * overlap) / 2);
        target.set(a.id, target.get(a.id)! - (dir * overlap) / 2);
      }
    }
    // Keep inside the track.
    for (const c of order) {
      const r = room(c);
      const l = c.lateral + target.get(c.id)!;
      if (l > r.hi) target.set(c.id, r.hi - c.lateral);
      if (l < r.lo) target.set(c.id, r.lo - c.lateral);
    }
  }
  const out = new Map<number, number>();
  const step = Math.max(0, dt) * ASIDE_RATE;
  for (const c of order) {
    const want = target.get(c.id)!;
    const prev = previous.get(c.id);
    // A jump in time (skipping ahead) or a new car: straight to the target.
    if (prev === undefined || dt > 5) out.set(c.id, want);
    else out.set(c.id, prev + Math.max(-step, Math.min(step, want - prev)));
  }
  return out;
}
