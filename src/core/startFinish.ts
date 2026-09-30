/**
 * Start/finish placement. Every station on the lap is scored as a start line
 * against FIA Appendix O (2026) article 7: a grid of 8 m per car on a
 * straight (7.7), a grid gradient of at most 2% (7.4), a grid at least 15 m
 * wide (7.3), and preferably 250 m from the start line to the first corner,
 * where a corner is a change of direction of at least 45 degrees with a
 * radius under 300 m (7.7). Long main straights are preferred.
 *
 * Once chosen, the track is rotated so the start line is station 0: corners,
 * sectors, distances and lap timing then all count from the line.
 */
import { findCorners } from './analysis.ts';
import { dist } from './geometry.ts';
import type { Track } from './track.ts';

export interface StartFinish {
  /** Station of the start line on the track as built (before rotation). */
  station: number;
  /** Distance from the start line to the first corner in the FIA sense, in metres. */
  firstCornerDistance: number;
  /** Largest gradient over the grid, as a fraction. */
  gridMaxGradient: number;
  /** Narrowest track width over the grid, in metres. */
  gridMinWidth: number;
  /** Share of the grid that lies on a straight (radius above 700 m). */
  gridStraightness: number;
  overridden: boolean;
}

/** Grid positions and spacing: 8 m per car is the Formula One figure in Appendix O 7.7. */
export const GRID_SIZE = 24;
export const GRID_SLOT_SPACING = 8;
export const GRID_LENGTH = GRID_SIZE * GRID_SLOT_SPACING + 10;
/** FIA corner definition for the start (Appendix O 7.7). */
export const FIA_CORNER_ANGLE = 45;
export const FIA_CORNER_RADIUS = 300;
export const FIRST_CORNER_DISTANCE = 250;
export const GRID_MAX_GRADIENT = 0.02;
export const GRID_MIN_WIDTH = 15;
const GRID_STRAIGHT_CURVATURE = 1 / 700;

/** Scores every few metres of the lap and returns the best start line, or the one nearest the override. */
export function placeStartFinish(t: Track, override?: { x: number; y: number } | null): StartFinish {
  const { n, ds } = t;
  const corners = findCorners(t).filter((c) => c.angle >= FIA_CORNER_ANGLE && c.minRadius < FIA_CORNER_RADIUS);
  const gridStations = Math.round(GRID_LENGTH / ds);

  // Distance from each station forward to the start of the next FIA corner.
  const toCorner = new Float64Array(n).fill(t.length);
  if (corners.length) {
    const starts = corners.map((c) => c.start).sort((a, b) => a - b);
    for (let k = 0; k < n; k++) {
      let best = Infinity;
      for (const s of starts) best = Math.min(best, ((s - k + n) % n) * ds);
      toCorner[k] = best;
    }
  }

  const evaluate = (k: number): StartFinish & { score: number } => {
    let straight = 0;
    let maxGrad = 0;
    let minWidth = Infinity;
    for (let i = 0; i <= gridStations; i++) {
      const j = (k - i + n) % n;
      if (Math.abs(t.curvature[j]) < GRID_STRAIGHT_CURVATURE) straight++;
      maxGrad = Math.max(maxGrad, Math.abs(t.gradient[j]));
      minWidth = Math.min(minWidth, t.width[j]);
    }
    const straightness = straight / (gridStations + 1);
    const d1 = toCorner[k];
    const gradScore = maxGrad <= GRID_MAX_GRADIENT ? 1 : Math.max(0, 1 - (maxGrad - GRID_MAX_GRADIENT) / 0.04);
    const score =
      3 * straightness +
      3 * Math.min(1, d1 / FIRST_CORNER_DISTANCE) +
      0.5 * Math.min(1, Math.max(0, d1 - FIRST_CORNER_DISTANCE) / FIRST_CORNER_DISTANCE) +
      2 * gradScore +
      Math.min(1, minWidth / GRID_MIN_WIDTH) +
      Math.min(1, straightRunLength(t, k) / 1000);
    return {
      station: k, score, firstCornerDistance: d1, gridMaxGradient: maxGrad, gridMinWidth: minWidth,
      gridStraightness: straightness, overridden: false,
    };
  };

  if (override) {
    let nearest = 0;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const d = dist(t.x[k], t.y[k], override.x, override.y);
      if (d < bestD) {
        bestD = d;
        nearest = k;
      }
    }
    const { score: _s, ...placed } = evaluate(nearest);
    return { ...placed, overridden: true };
  }

  const step = Math.max(1, Math.round(5 / ds));
  let best = evaluate(0);
  for (let k = step; k < n; k += step) {
    const c = evaluate(k);
    if (c.score > best.score + 1e-9) best = c;
  }
  const { score: _s, ...placed } = best;
  return placed;
}

/** Length of the run of nearly straight stations (radius above 1 km) around station k. */
function straightRunLength(t: Track, k: number): number {
  const { n, ds } = t;
  const straight = (j: number) => Math.abs(t.curvature[(j + n) % n]) < 1 / 1000;
  if (!straight(k)) return 0;
  let a = 0;
  while (a < n && straight(k - a - 1)) a++;
  let b = 0;
  while (b < n && straight(k + b + 1)) b++;
  return Math.min(n, a + b + 1) * ds;
}

/** The same track with station `shift` as the new station 0. */
export function rotateTrack(t: Track, shift: number): Track {
  const n = t.n;
  const s = ((shift % n) + n) % n;
  if (s === 0) return t;
  const rot = <A extends Float64Array | Int32Array>(src: A): A => {
    const out = new (src.constructor as { new (len: number): A })(n);
    for (let k = 0; k < n; k++) out[k] = src[(k + s) % n];
    return out;
  };
  const along = new Float64Array(n);
  for (let k = 0; k < n; k++) along[k] = k * t.ds;
  const pointStations = Int32Array.from(t.pointStations, (p) => (p - s + n) % n);
  return {
    n, ds: t.ds, length: t.length,
    x: rot(t.x), y: rot(t.y), s: along, heading: rot(t.heading), curvature: rot(t.curvature),
    width: rot(t.width), terrain: rot(t.terrain), z: rot(t.z), gradient: rot(t.gradient), vcurv: rot(t.vcurv),
    leftX: rot(t.leftX), leftY: rot(t.leftY), rightX: rot(t.rightX), rightY: rot(t.rightY),
    seg: rot(t.seg), pointStations,
  };
}

export interface GridSlot {
  x: number;
  y: number;
  heading: number;
  /** Grid position, 1 = pole. */
  position: number;
}

/**
 * Staggered grid slots behind the start line of a rotated track (start at
 * station 0): alternating sides, GRID_SLOT_SPACING metres apart, pole on the
 * side of the first corner's inside.
 */
export function gridSlots(t: Track, firstCornerRight: boolean, count = GRID_SIZE): GridSlot[] {
  const { n, ds } = t;
  const slots: GridSlot[] = [];
  for (let p = 0; p < count; p++) {
    const back = 6 + p * GRID_SLOT_SPACING;
    const k = (n - Math.round(back / ds)) % n;
    const poleSide = firstCornerRight ? -1 : 1; // left normal is +1; pole on the inside of the first corner
    const side = p % 2 === 0 ? poleSide : -poleSide;
    const off = side * t.width[k] * 0.25;
    const nx = Math.sin(t.heading[k]);
    const ny = -Math.cos(t.heading[k]);
    slots.push({ x: t.x[k] + nx * off, y: t.y[k] + ny * off, heading: t.heading[k], position: p + 1 });
  }
  return slots;
}
