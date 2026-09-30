/**
 * Pit lane placement. Candidates run beside any stretch of the lap on either
 * side ("parallel"), or cut straight across the inside of the circuit from
 * one part of the lap to another ("chord"). Each is checked and scored:
 *
 * - it must stay on the map, out of the water and clear of every other part
 *   of the track;
 * - the pit boxes need a straight, gently graded stretch of at least 250 m;
 * - entry and exit should leave and join the track away from the racing line
 *   and not in a braking zone (FIA Appendix O 7.9);
 * - a pit lane beside the start/finish straight is preferred (also 7.9), but
 *   any other place can win when the ground there suits it better;
 * - a chord must not be a shortcut: a stop has to cost time.
 *
 * The lane is 15 m wide, the FIM figure for new Grade A circuits, which also
 * satisfies the FIA's 12 m.
 */
import { SpatialGrid, dist } from './geometry.ts';
import type { LapResult } from './lapSim.ts';
import type { RacingLine } from './racingLine.ts';
import type { HeightSampler, Track } from './track.ts';

export interface PitLane {
  kind: 'parallel' | 'chord';
  /** +1 when the pit lane lies to the left of the direction of travel, -1 to the right. */
  side: 1 | -1;
  /** Stations where the pit road leaves and rejoins the track. */
  entry: number;
  exit: number;
  /** Centre line of the pit lane, from entry to exit. */
  x: Float64Array;
  y: Float64Array;
  length: number;
  /** Index range of the path along which the pit boxes run. */
  boxStart: number;
  boxEnd: number;
  boxLength: number;
  width: number;
  adjacentToStart: boolean;
  /** Distance from the racing line to the track edge on the pit side, at entry and at exit. */
  entryClearance: number;
  exitClearance: number;
  /** The exit joins the track where the reference car is braking hard. */
  exitInBrakingZone: boolean;
  /** Largest difference between the ground and the track level along the lane, in metres. */
  maxEarthworks: number;
  /** Problems found (empty for a clean placement); an overridden lane may have some. */
  problems: string[];
  overridden: boolean;
}

export interface PitLoss {
  vehicleId: string;
  /** Extra time for a drive through the pit lane, without the stop itself. */
  loss: number;
  pitTime: number;
  trackTime: number;
}

export interface PitOverride {
  entry: { x: number; y: number };
  exit: { x: number; y: number };
  side: 1 | -1;
}

export interface PitInput {
  track: Track;
  line: RacingLine;
  /** Lap used to find braking zones and to rule out shortcut chords. */
  reference: LapResult;
  heightAt: HeightSampler;
  waterLevel: number;
  extent: number;
  override?: PitOverride | null;
}

export const PIT_WIDTH = 15;
/** Verge, wall and signalling platform between the track edge and the pit lane. */
const PIT_GAP = 4;
const RAMP = 120;
export const MIN_BOX_LENGTH = 250;
const CLEARANCE = 5;
const MAX_EARTHWORKS = 12;
const PARALLEL_SPANS = [500, 580, 660];
const MIN_CHORD_LOSS = 8;

interface Candidate {
  pit: PitLane;
  score: number;
}

export function placePitLane(input: PitInput): PitLane | null {
  const { track: t } = input;
  const grid = new SpatialGrid(20);
  for (let k = 0; k < t.n; k++) grid.insert(t.x[k], t.y[k], k);
  const ctx = { ...input, grid };

  if (input.override) {
    const a = nearestStation(t, input.override.entry);
    const b = nearestStation(t, input.override.exit);
    const span = (b - a + t.n) % t.n;
    const c = buildParallel(ctx, a, span, input.override.side, true);
    return c ? { ...c.pit, overridden: true } : null;
  }

  let best: Candidate | null = null;
  const step = Math.max(1, Math.round(20 / t.ds));
  for (let a = 0; a < t.n; a += step) {
    for (const spanM of PARALLEL_SPANS) {
      const span = Math.round(spanM / t.ds);
      if (span >= t.n / 2) continue;
      for (const side of [1, -1] as const) {
        const c = buildParallel(ctx, a, span, side, false);
        if (c && (!best || c.score > best.score)) best = c;
      }
    }
  }
  for (const c of chordCandidates(ctx)) if (!best || c.score > best.score) best = c;
  return best?.pit ?? null;
}

type Ctx = PitInput & { grid: SpatialGrid };

function nearestStation(t: Track, p: { x: number; y: number }): number {
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < t.n; k++) {
    const d = dist(t.x[k], t.y[k], p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** A lane beside the track from station a for `span` stations, offset to `side`. */
function buildParallel(ctx: Ctx, a: number, span: number, side: 1 | -1, keepInvalid: boolean): Candidate | null {
  const t = ctx.track;
  const { n, ds } = t;
  if (span < Math.round((2 * RAMP + MIN_BOX_LENGTH) / ds) && !keepInvalid) return null;
  const rampStations = Math.min(Math.round(RAMP / ds), Math.floor(span / 2));
  const x = new Float64Array(span + 1);
  const y = new Float64Array(span + 1);
  const problems: string[] = [];
  let boxStraight = true;
  for (let i = 0; i <= span; i++) {
    const k = (a + i) % n;
    const edge = t.width[k] / 2;
    const full = edge + PIT_GAP + PIT_WIDTH / 2;
    const r = Math.min(1, Math.min(i, span - i) / Math.max(1, rampStations));
    const off = edge + (full - edge) * r * r * (3 - 2 * r);
    const nx = Math.sin(t.heading[k]) * side;
    const ny = -Math.cos(t.heading[k]) * side;
    x[i] = t.x[k] + nx * off;
    y[i] = t.y[k] + ny * off;
    // Offset curves tighten on the inside of a bend: the boxes need a near-straight lane.
    const c = t.curvature[k];
    const insideRadius = 1 / Math.max(1e-9, Math.abs(c)) - (Math.sign(c) === -side ? off : -off);
    if (r >= 1 && (Math.abs(c) > 1 / 300 || insideRadius < 150)) boxStraight = false;
    if (r < 1 && insideRadius < 30) problems.push('The pit road bends too tightly');
  }
  if (!boxStraight) problems.push('The pit boxes would sit on a bend');
  return finish(ctx, { kind: 'parallel', side, entry: a, exit: (a + span) % n, x, y, boxFrom: rampStations, boxTo: span - rampStations }, problems, keepInvalid);
}

/** Straight lanes across the inside of the circuit that join the track at shallow angles. */
function chordCandidates(ctx: Ctx): Candidate[] {
  const t = ctx.track;
  const { n, ds } = t;
  const out: Candidate[] = [];
  const step = Math.max(1, Math.round(40 / ds));
  for (let a = 0; a < n; a += step) {
    for (let spanM = 600; spanM <= 2000; spanM += 40) {
      const span = Math.round(spanM / ds);
      if (span >= n * 0.6) break;
      const b = (a + span) % n;
      const ax = t.x[a];
      const ay = t.y[a];
      const bx = t.x[b];
      const by = t.y[b];
      const len = dist(ax, ay, bx, by);
      if (len < 350 || len > 900) continue;
      const dir = Math.atan2(by - ay, bx - ax);
      const angleA = Math.abs(wrap(dir - t.heading[a]));
      const angleB = Math.abs(wrap(t.heading[b] - dir));
      if (angleA > (25 * Math.PI) / 180 || angleB > (25 * Math.PI) / 180) continue;
      // The chord must head to the inside: the side the lap turns towards between a and b.
      const side: 1 | -1 = wrap(dir - t.heading[a]) < 0 ? 1 : -1;
      const m = Math.ceil(len / ds);
      const x = new Float64Array(m + 1);
      const y = new Float64Array(m + 1);
      for (let i = 0; i <= m; i++) {
        x[i] = ax + ((bx - ax) * i) / m;
        y[i] = ay + ((by - ay) * i) / m;
      }
      const ramp = Math.round(100 / ds);
      const c = finish(ctx, { kind: 'chord', side, entry: a, exit: b, x, y, boxFrom: ramp, boxTo: m - ramp }, [], false);
      if (c) out.push(c);
    }
  }
  return out;
}

interface Shape {
  kind: 'parallel' | 'chord';
  side: 1 | -1;
  entry: number;
  exit: number;
  x: Float64Array;
  y: Float64Array;
  boxFrom: number;
  boxTo: number;
}

/** Checks a lane shape against the ground, the water and the rest of the track, and scores it. */
function finish(ctx: Ctx, s: Shape, problems: string[], keepInvalid: boolean): Candidate | null {
  const t = ctx.track;
  const { n, ds } = t;
  const m = s.x.length;
  const span = (s.exit - s.entry + n) % n;
  const localWindow = Math.round(150 / ds);
  const isLocal = (k: number) => {
    // Stations between entry and exit, plus a margin, belong to the stretch the lane runs beside.
    const rel = (k - s.entry + n) % n;
    return rel <= span + localWindow || rel >= n - localWindow;
  };

  let length = 0;
  let maxEarth = 0;
  let blocked = false;
  let water = false;
  let offMap = false;
  const sample = Math.max(1, Math.round(10 / ds));
  for (let i = 0; i < m; i += sample) {
    const px = s.x[i];
    const py = s.y[i];
    if (px < 0 || py < 0 || px > ctx.extent || py > ctx.extent) offMap = true;
    const ground = ctx.heightAt(px, py);
    if (ground < ctx.waterLevel) water = true;
    // Track level along the lane: the station it runs beside (parallel) or a blend of the ends (chord).
    const f = i / Math.max(1, m - 1);
    const k = s.kind === 'parallel' ? (s.entry + i) % n : -1;
    const level = k >= 0 ? t.z[k] : t.z[s.entry] * (1 - f) + t.z[s.exit] * f;
    maxEarth = Math.max(maxEarth, Math.abs(ground - level));
    const edgeClear = PIT_WIDTH / 2 + CLEARANCE;
    ctx.grid.query(px, py, 22, (j) => {
      if (blocked) return;
      const near = dist(px, py, t.x[j], t.y[j]) < t.width[j] / 2 + edgeClear;
      if (!near) return;
      // A chord may only touch the track close to its ends.
      const nearEnds = s.kind === 'chord' && (i < RAMP / ds || i > m - RAMP / ds);
      if (s.kind === 'parallel' ? !isLocal(j) : !nearEnds) blocked = true;
    });
  }
  for (let i = 1; i < m; i++) length += dist(s.x[i - 1], s.y[i - 1], s.x[i], s.y[i]);
  if (offMap) problems.push('The pit lane leaves the map');
  if (water) problems.push('The pit lane runs into water');
  if (blocked) problems.push('The pit lane runs into another part of the track');
  if (maxEarth > MAX_EARTHWORKS) problems.push(`The ground is up to ${Math.round(maxEarth)} m off track level`);

  let boxLength = 0;
  for (let i = s.boxFrom + 1; i <= s.boxTo && i < m; i++) boxLength += dist(s.x[i - 1], s.y[i - 1], s.x[i], s.y[i]);
  if (boxLength < MIN_BOX_LENGTH) problems.push(`Only ${Math.round(boxLength)} m for the pit boxes (${MIN_BOX_LENGTH} m needed)`);

  const line = ctx.line;
  const clearance = (k: number) => t.width[k] / 2 - s.side * line.offset[k];
  const entryClearance = clearance(s.entry);
  const exitClearance = clearance(s.exit);
  const ref = ctx.reference;
  let exitBraking = false;
  for (let i = 0; i <= Math.round(150 / ds); i++) if (ref.brake[(s.exit + i) % n] > 0.3) exitBraking = true;
  let startInside = false;
  if (s.kind === 'parallel') {
    for (let i = s.boxFrom; i <= s.boxTo; i++) if ((s.entry + i) % n === 0) startInside = true;
  } else {
    startInside = false;
  }

  let loss = 0;
  if (s.kind === 'chord') {
    const pit = s.x.length > 1 ? length / (60 / 3.6) : 0;
    let track = ref.t[s.exit] - ref.t[s.entry];
    if (track < 0) track += ref.time;
    loss = pit - track;
    if (loss < MIN_CHORD_LOSS) problems.push('The pit lane would be a shortcut');
  }

  if (problems.length && !keepInvalid) return null;

  let gradient = 0;
  if (s.kind === 'parallel') for (let i = s.boxFrom; i <= s.boxTo; i++) gradient = Math.max(gradient, Math.abs(t.gradient[(s.entry + i) % n]));
  else gradient = Math.abs(t.z[s.exit] - t.z[s.entry]) / Math.max(1, length);

  const score =
    (startInside ? 2 : 0) +
    1.5 * Math.min(1, entryClearance / Math.max(1, t.width[s.entry] / 2)) +
    1.5 * Math.min(1, exitClearance / Math.max(1, t.width[s.exit] / 2)) +
    (exitBraking ? -1.5 : 0) +
    2 * (1 - Math.min(1, maxEarth / MAX_EARTHWORKS)) +
    (gradient <= 0.02 ? 1 : Math.max(0, 1 - (gradient - 0.02) / 0.04)) +
    // Room for the boxes is good up to about 400 m; beyond that the lane only costs time.
    0.5 * Math.min(1, boxLength / 300) - 0.5 * Math.max(0, (boxLength - 450) / 300) +
    (s.kind === 'chord' ? -0.5 : 0);

  return {
    score,
    pit: {
      kind: s.kind, side: s.side, entry: s.entry, exit: s.exit, x: s.x, y: s.y, length,
      boxStart: s.boxFrom, boxEnd: Math.min(s.boxTo, m - 1), boxLength, width: PIT_WIDTH,
      adjacentToStart: startInside, entryClearance, exitClearance, exitInBrakingZone: exitBraking,
      maxEarthworks: maxEarth, problems, overridden: false,
    },
  };
}

/**
 * Time lost by a drive through the pit lane compared with staying on track.
 * The car brakes from track speed to the limit, drives the lane at the limit
 * (its entry and exit roads are driven a little faster, so the limited part
 * counts as the lane minus one ramp length) and accelerates back to track
 * speed. Braking and acceleration spill onto the track before the entry and
 * after the exit, so the comparison uses the lap's own time over that same
 * widened stretch.
 */
export function pitTimeLoss(pit: PitLane, lap: LapResult, speedLimit: number): PitLoss {
  const n = lap.v.length;
  const vIn = lap.v[pit.entry];
  const vOut = lap.v[pit.exit];
  const brake = 9;
  const accel = 5;
  const dBrake = vIn > speedLimit ? (vIn * vIn - speedLimit * speedLimit) / (2 * brake) : 0;
  const dAccel = vOut > speedLimit ? (vOut * vOut - speedLimit * speedLimit) / (2 * accel) : 0;
  const tBrake = vIn > speedLimit ? (vIn - speedLimit) / brake : 0;
  const tAccel = vOut > speedLimit ? (vOut - speedLimit) / accel : 0;
  const pitTime = tBrake + Math.max(0, pit.length - RAMP) / speedLimit + tAccel;
  // The same stretch on track, widened by the braking and acceleration done outside the lane.
  const ds = lapLength(lap) / n;
  const from = (pit.entry - Math.round(Math.max(0, dBrake - RAMP / 2) / ds) + n * 2) % n;
  const to = (pit.exit + Math.round(Math.max(0, dAccel - RAMP / 2) / ds)) % n;
  let trackTime = lap.t[to] - lap.t[from];
  if (trackTime < 0) trackTime += lap.time;
  return { vehicleId: lap.vehicleId, loss: pitTime - trackTime, pitTime, trackTime };
}

function lapLength(lap: LapResult): number {
  return lap.avgSpeed * lap.time;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
