/**
 * Calibration of vehicle classes against real qualifying laps on real
 * circuits: evaluate the model's error, and fit a class's grip (and, with
 * enough references, its aero level) to minimise it.
 */
import { simulateLap } from './lapSim.ts';
import type { RacingLine } from './racingLine.ts';
import type { Track } from './track.ts';
import type { VehicleClass } from './vehicles.ts';

export interface ReferenceLap {
  classId: string;
  circuit: string;
  /** Seconds. */
  time: number;
  event: string;
  driver: string;
  /** Used for fitting; otherwise shown for comparison only. */
  fit: boolean;
  derived: boolean;
  note: string;
  source: string;
}

export interface CircuitModel {
  name: string;
  track: Track;
  line: RacingLine;
}

export interface CalibrationRow {
  ref: ReferenceLap;
  simulated: number;
  /** Relative error, (simulated - real) / real. */
  error: number;
  trim: number;
}

/** "1:18.792" or "48.467" to seconds. */
export function parseLapTime(text: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/.exec(text.trim());
  if (!m) throw new Error(`Not a lap time: "${text}"`);
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

export function formatLapTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const min = Math.floor(seconds / 60);
  const sec = seconds - min * 60;
  const s = sec.toFixed(3).padStart(6, '0');
  return min > 0 ? `${min}:${s}` : sec.toFixed(3);
}

export function parseReferenceFile(file: unknown): ReferenceLap[] {
  const laps = (file as { laps?: unknown[] })?.laps;
  if (!Array.isArray(laps)) throw new Error('Reference file needs a "laps" list.');
  return laps.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      classId: String(r.class),
      circuit: String(r.circuit),
      time: parseLapTime(String(r.time)),
      event: String(r.event ?? ''),
      driver: String(r.driver ?? ''),
      fit: r.fit !== false,
      derived: r.derived === true,
      note: String(r.note ?? ''),
      source: String(r.source ?? ''),
    };
  });
}

export function evaluate(car: VehicleClass, circuits: ReadonlyMap<string, CircuitModel>, refs: readonly ReferenceLap[]): CalibrationRow[] {
  return refs
    .filter((r) => r.classId === car.id && circuits.has(r.circuit))
    .map((ref) => {
      const c = circuits.get(ref.circuit)!;
      const lap = simulateLap(c.track, c.line, car);
      return { ref, simulated: lap.time, error: (lap.time - ref.time) / ref.time, trim: lap.trim };
    });
}

/** Root-mean-square relative error over the fitted rows. */
export function rmsError(rows: readonly CalibrationRow[]): number {
  const fitted = rows.filter((r) => r.ref.fit);
  if (!fitted.length) return 0;
  return Math.sqrt(fitted.reduce((s, r) => s + r.error * r.error, 0) / fitted.length);
}

/**
 * Scales grip and downforce. Drag is left alone: it is set from real top
 * speeds, and fitting it to lap times would let it trade off against grip
 * and give wrong straight-line speeds on circuits unlike the reference ones.
 */
export function scaleCar(car: VehicleClass, gripScale: number, downforceScale: number, loadSensitivity = car.loadSensitivity): VehicleClass {
  return {
    ...car,
    grip: car.grip * gripScale,
    clA: [car.clA[0] * downforceScale, car.clA[1] * downforceScale],
    loadSensitivity,
  };
}

export interface FitResult {
  car: VehicleClass;
  gripScale: number;
  downforceScale: number;
  loadSensitivity: number;
  before: CalibrationRow[];
  after: CalibrationRow[];
}

/** Fitted references a class needs before its aero level, and then its tyre load sensitivity, are fitted too. */
export const DOWNFORCE_MIN_REFS = 3;
export const LOAD_SENSITIVITY_MIN_REFS = 4;

/**
 * Fits grip; with enough references also downforce and the tyre load
 * sensitivity, which together set how grip at high speed compares with grip
 * at low speed. Golden-section search per parameter, alternated a few times,
 * on squared log errors.
 */
export function fitClass(car: VehicleClass, circuits: ReadonlyMap<string, CircuitModel>, refs: readonly ReferenceLap[]): FitResult {
  const own = refs.filter((r) => r.classId === car.id && r.fit && circuits.has(r.circuit));
  const before = evaluate(car, circuits, refs);
  if (!own.length) return { car, gripScale: 1, downforceScale: 1, loadSensitivity: car.loadSensitivity, before, after: before };
  const cost = (g: number, a: number, ls: number) => {
    const rows = evaluate(scaleCar(car, g, a, ls), circuits, own);
    return rows.reduce((s, r) => s + Math.log(r.simulated / r.ref.time) ** 2, 0);
  };
  let g = 1;
  let a = 1;
  let ls = car.loadSensitivity;
  const fitDownforce = own.length >= DOWNFORCE_MIN_REFS && car.clA[1] > 0.5;
  const fitLoad = fitDownforce && own.length >= LOAD_SENSITIVITY_MIN_REFS;
  const rounds = fitDownforce ? 5 : 1;
  for (let round = 0; round < rounds; round++) {
    g = goldenSection((x) => cost(x, a, ls), 0.6, 1.8, 1e-4);
    if (fitDownforce) a = goldenSection((x) => cost(g, x, ls), 0.8, 1.25, 1e-4);
    if (fitLoad) ls = goldenSection((x) => cost(g, a, x), 0.03, 0.15, 1e-4);
  }
  const fitted = scaleCar(car, g, a, ls);
  return { car: fitted, gripScale: g, downforceScale: a, loadSensitivity: ls, before, after: evaluate(fitted, circuits, refs) };
}

function goldenSection(f: (x: number) => number, lo: number, hi: number, tol: number): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > tol) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}
