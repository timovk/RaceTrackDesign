/**
 * Everything a race needs to know about the track for one class, computed
 * once before the start from the lap-time model:
 *
 * - the race lap (no DRS) as a time per station segment, plus how that time
 *   changes with DRS open, in another car's slipstream (less drag) and in its
 *   wake (less downforce) and on a wet track (less grip), each from its own
 *   run of the lap simulation;
 * - fuel burn and tyre wear per lap, scaled from the class's typical figures
 *   by this track's wheel energy and tyre work against the real circuits;
 * - lap-time cost of fuel mass, braking zones where passes happen, the pit
 *   lane as a path with a speed limit, timing loops and grid positions.
 */
import type { Facilities } from '../facilities.ts';
import { AIR_DENSITY, GRAVITY, type LapResult, drsZones, simulateLapAtTrim } from '../lapSim.ts';
import type { Performance } from '../performance.ts';
import type { RacingLine } from '../racingLine.ts';
import type { Track } from '../track.ts';
import type { VehicleClass } from '../vehicles.ts';
import type { RaceRules } from './rules.ts';

export interface PassingZone {
  /** Station where braking starts. */
  station: number;
  /** 0..1: how good a place to pass it is (speed lost under braking and the straight before it). */
  quality: number;
}

export interface DrsRegion {
  /** Detection and activation point. */
  start: number;
  /** Stations from `start` over which an open wing saves time (the zone and the braking after it). */
  length: number;
}

export interface PitModel {
  entry: number;
  exit: number;
  /** Lap stations between entry and exit. */
  span: number;
  x: Float64Array;
  y: Float64Array;
  /** Distance along the lane at each path point. */
  cum: Float64Array;
  length: number;
  /** Speed limit in m/s, applying between limitFrom and limitTo (metres along the lane). */
  limit: number;
  limitFrom: number;
  limitTo: number;
  /** Where the pit boxes run, in metres along the lane. */
  boxFrom: number;
  boxTo: number;
  /** Time lost driving through without stopping, from the facilities analysis. */
  driveThroughLoss: number;
  /** Width of the lane, and the side the garages are on (+1 left of the direction of travel). */
  width: number;
  side: 1 | -1;
}

export interface GridStart {
  /** Race progress in stations: negative, behind the start line. */
  u: number;
  /** Sideways offset from the racing line in metres. */
  lateral: number;
}

export interface RaceModel {
  vehicle: VehicleClass;
  rules: RaceRules;
  track: Track;
  line: RacingLine;
  n: number;
  /** Race lap: seconds per segment k -> k+1, and the lap time. */
  seg: Float64Array;
  lapTime: number;
  /** Speed on the race lap per station, m/s. */
  v: Float64Array;
  /** Segment-time ratios against the race lap: DRS open (null without DRS), full slipstream, full wake. */
  drsRatio: Float64Array | null;
  towRatio: Float64Array;
  wakeRatio: Float64Array;
  drs: DrsRegion[];
  /** Qualifying lap from the analysis (DRS used freely). */
  qualifyingTime: number;
  /** Lap-time fraction per kg of fuel. */
  fuelSensitivity: number;
  fuelPerLap: number;
  /** Tyre wear multiplier for this track, 1 on an average real circuit. */
  tyreSeverity: number;
  zones: PassingZone[];
  sectors: [number, number];
  /** Stations between timing loops, and the number of loops per lap. */
  loopEvery: number;
  loops: number;
  /** Highest speed reachable from a standstill, per metre travelled (index = metres). */
  launch: Float64Array;
  pit: PitModel | null;
  grid: GridStart[];
  /** Number of the corner each station is in, or the next one within 400 m; 0 for none. */
  cornerAt: Int16Array;
  /** Station where the first corner after the start line begins, or -1 when the analysis gave no corners. */
  firstCorner: number;
  /** Aero trim the class runs here (from its qualifying lap), for telemetry. */
  trim: number;
  /** Telemetry: stations between samples and samples per lap. */
  teleEvery: number;
  samples: number;
  /** Station of the speed trap. */
  speedTrap: number;
  /**
   * Segment-time ratios against the race lap with 75% and 50% of the dry
   * grip (a wet track), and the matching lap-time ratios; see gripBlend.
   */
  gripRatio: [Float64Array, Float64Array];
  gripLap: [number, number];
}

/** Grip levels of the two wet laps. */
const GRIP_LEVELS = [0.75, 0.5] as const;

/**
 * Weights (a, b) that blend the wet laps for a grip factor g: a segment's
 * ratio is 1 + a (r75 - 1) + b (r50 - r75). Linear between the three laps,
 * and extrapolated below 50% grip.
 */
export function gripBlend(g: number): [number, number] {
  if (g >= 1) return [0, 0];
  if (g >= GRIP_LEVELS[0]) return [(1 - g) / (1 - GRIP_LEVELS[0]), 0];
  return [1, (GRIP_LEVELS[0] - g) / (GRIP_LEVELS[0] - GRIP_LEVELS[1])];
}

/** Lap-time ratio against the race lap at grip factor g. */
export function lapRatioAtGrip(m: RaceModel, g: number): number {
  const [a, b] = gripBlend(g);
  return 1 + a * (m.gripLap[0] - 1) + b * (m.gripLap[1] - m.gripLap[0]);
}

export interface RaceModelInput {
  track: Track;
  performance: Performance;
  facilities: Facilities;
  vehicle: VehicleClass;
  rules: RaceRules;
  gridSize: number;
  /** Numbered corners, to say where things happen. */
  corners?: readonly { number: number; start: number; end: number }[];
}

const LAUNCH_LENGTH = 3000;
/** Share of the tyre's grip usable when launching from a standstill (clutch slip, wheelspin). */
const LAUNCH_GRIP = 0.85;
const LOOP_SPACING = 100;
const TELEMETRY_SPACING = 5;
const PIT_RAMP = 120;
const HEAVY = 50;

export function buildRaceModel(input: RaceModelInput): RaceModel {
  const { track, performance: perf, facilities: f, vehicle: car, rules } = input;
  const line = perf.line;
  const n = line.n;
  const qualifying = perf.laps.find((l) => l.vehicleId === car.id);
  if (!qualifying) throw new Error(`No lap for ${car.name} on this track.`);
  const trim = qualifying.trim;
  const noDrs = { ...car, drs: 0 };

  const base = simulateLapAtTrim(track, line, noDrs, trim);
  const seg = segmentTimes(base);
  const ratio = (lap: LapResult): Float64Array => {
    const s = segmentTimes(lap);
    const r = new Float64Array(n);
    for (let k = 0; k < n; k++) r[k] = s[k] / seg[k];
    return r;
  };
  const cut = rules.air.towDragCut;
  const tow = simulateLapAtTrim(track, line, { ...noDrs, cdA: [car.cdA[0] * (1 - cut), car.cdA[1] * (1 - cut)] }, trim);
  const loss = rules.air.wakeDownforceLoss;
  const wake = loss > 0 ? simulateLapAtTrim(track, line, { ...noDrs, clA: [car.clA[0] * (1 - loss), car.clA[1] * (1 - loss)] }, trim) : base;
  const heavy = simulateLapAtTrim(track, line, { ...noDrs, mass: car.mass + HEAVY }, trim);
  const wet = GRIP_LEVELS.map((g) => simulateLapAtTrim(track, line, { ...noDrs, grip: car.grip * g }, trim));

  let drsRatio: Float64Array | null = null;
  const drs: DrsRegion[] = [];
  if (rules.drs && car.drs > 0) {
    const open = simulateLapAtTrim(track, line, car, trim);
    const full = ratio(open);
    drsRatio = new Float64Array(n).fill(1);
    for (const z of drsZones(line)) {
      // The wing helps through the zone and into the braking zone after it, until both laps' speeds meet again.
      const zoneLen = z.end >= z.start ? z.end - z.start + 1 : n - z.start + z.end + 1;
      let len = zoneLen;
      while (len < n / 2 && open.v[(z.start + len) % n] > base.v[(z.start + len) % n] + 0.05) len++;
      for (let i = 0; i < len; i++) drsRatio[(z.start + i) % n] = full[(z.start + i) % n];
      drs.push({ start: z.start, length: len });
    }
  }

  // Telemetry every 5 m, or coarser on long laps so a lap has at most about 1000 samples.
  const teleEvery = Math.max(1, Math.round(Math.max(TELEMETRY_SPACING, line.length / 1000) / track.ds));
  const energy = lapEnergy(base, line, car) / line.length;
  const work = lapTyreWork(base, line) / line.length;
  const energyScale = rules.reference.energy > 0 ? energy / rules.reference.energy : 1;
  const tyreSeverity = rules.reference.tyreWork > 0 ? clamp(work / rules.reference.tyreWork, 0.5, 2) : 1;

  return {
    vehicle: car,
    rules,
    track,
    line,
    n,
    seg,
    lapTime: base.time,
    v: base.v,
    drsRatio,
    towRatio: ratio(tow),
    wakeRatio: ratio(wake),
    drs,
    qualifyingTime: qualifying.time,
    fuelSensitivity: Math.max(0, (heavy.time - base.time) / base.time / HEAVY),
    fuelPerLap: rules.fuel.perMetre * line.length * clamp(energyScale, 0.4, 2.5),
    tyreSeverity,
    zones: passingZones(base, line),
    sectors: perf.sectors,
    loopEvery: Math.max(1, Math.round(LOOP_SPACING / track.ds)),
    loops: Math.ceil(n / Math.max(1, Math.round(LOOP_SPACING / track.ds))),
    launch: launchCurve(car),
    pit: pitModel(f, car, n),
    grid: gridStarts(track, line, input.gridSize),
    cornerAt: cornerLookup(n, track.ds, input.corners ?? []),
    firstCorner: input.corners?.length ? Math.min(...input.corners.map((c) => c.start)) : -1,
    trim,
    teleEvery,
    samples: Math.ceil(n / teleEvery),
    speedTrap: f.speedTrap.station,
    gripRatio: [ratio(wet[0]), ratio(wet[1])],
    gripLap: [wet[0].time / base.time, wet[1].time / base.time],
  };
}

/** Seconds from each station to the next on a simulated lap. */
export function segmentTimes(lap: LapResult): Float64Array {
  const n = lap.t.length;
  const s = new Float64Array(n);
  for (let k = 0; k < n - 1; k++) s[k] = lap.t[k + 1] - lap.t[k];
  s[n - 1] = lap.time - lap.t[n - 1];
  return s;
}

/** Energy delivered at the wheels over a lap in joules (throttle is the share of full power used). */
export function lapEnergy(lap: LapResult, line: RacingLine, car: VehicleClass): number {
  const seg = segmentTimes(lap);
  let e = 0;
  for (let k = 0; k < line.n; k++) e += lap.throttle[k] * car.power * seg[k];
  return e;
}

/**
 * Tyre work over a lap: the square of the total acceleration in g, summed
 * over distance. Tyre wear grows with the force the tyres carry and with how
 * much they slide, both of which rise with acceleration.
 */
export function lapTyreWork(lap: LapResult, line: RacingLine): number {
  let w = 0;
  for (let k = 0; k < line.n; k++) w += ((lap.ax[k] * lap.ax[k] + lap.ay[k] * lap.ay[k]) / (GRAVITY * GRAVITY)) * line.ds[k];
  return w;
}

/**
 * Highest speed at each metre from a standing start on flat ground: traction
 * limited at first (with some slip), then power limited, minus drag and
 * rolling resistance. Bikes are also held back by the wheelie limit.
 */
export function launchCurve(car: VehicleClass): Float64Array {
  const out = new Float64Array(LAUNCH_LENGTH + 1);
  const weight = car.mass * GRAVITY;
  const q = 0.5 * AIR_DENSITY;
  const cdA = (car.cdA[0] + car.cdA[1]) / 2;
  const clA = (car.clA[0] + car.clA[1]) / 2;
  let v = 0;
  for (let d = 0; d <= LAUNCH_LENGTH; d++) {
    out[d] = v;
    let traction = car.grip * car.driveShare * (weight + q * clA * v * v) * LAUNCH_GRIP;
    if (car.maxAccelG !== null) traction = Math.min(traction, car.maxAccelG * weight);
    const drive = Math.min(traction, car.power / Math.max(v, 3));
    const a = (drive - q * cdA * v * v - car.rollingResistance * weight) / car.mass;
    v = Math.min(car.topSpeed, Math.sqrt(Math.max(0, v * v + 2 * a)));
  }
  return out;
}

/** Speed reachable `metres` after pulling away from `from` m/s, on the launch curve. */
export function launchSpeed(launch: Float64Array, from: number, metres: number): number {
  let d0 = 0;
  if (from > 0) {
    // First metre at which the launch curve reaches the starting speed.
    let lo = 0;
    let hi = launch.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (launch[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    d0 = lo;
  }
  const d = d0 + metres;
  if (d >= launch.length - 1) return Infinity;
  const i = Math.floor(d);
  return launch[i] + (launch[i + 1] - launch[i]) * (d - i);
}

/** Braking zones after a straight, scored by the speed lost and the length of the run before. */
export function passingZones(lap: LapResult, line: RacingLine): PassingZone[] {
  const n = line.n;
  const zones: PassingZone[] = [];
  let origin = 0;
  while (origin < n && lap.brake[origin] > 0.3) origin++;
  let lastStart = -Infinity;
  let along = 0;
  for (let i = 0; i < n; i++) {
    const k = (origin + i) % n;
    const p = (k - 1 + n) % n;
    along += line.ds[p];
    if (!(lap.brake[k] > 0.3 && lap.brake[p] <= 0.3)) continue;
    // A braking zone that eases off and bites again is one zone.
    if (along - lastStart < MERGE_ZONES) continue;
    lastStart = along;
    // Lowest speed before the car is back on full throttle.
    let vMin = lap.v[k];
    let d = 0;
    for (let j = 1; j < n && d < 600; j++) {
      const q = (k + j) % n;
      vMin = Math.min(vMin, lap.v[q]);
      d += line.ds[q];
      if (d > 20 && lap.throttle[q] >= 0.95) break;
    }
    // Length of the flat-out run before it, past any lift or light braking just before the zone.
    let q = k;
    let skipped = 0;
    while (skipped < 100 && (lap.brake[(q - 1 + n) % n] > 0 || lap.throttle[(q - 1 + n) % n] < 0.9)) {
      q = (q - 1 + n) % n;
      skipped += line.ds[q];
    }
    let run = 0;
    for (let b = 1; b < n; b++) {
      const r = (q - b + n) % n;
      if (lap.throttle[r] < 0.9) break;
      run += line.ds[r];
    }
    const dropKmh = (lap.v[k] - vMin) * 3.6;
    if (dropKmh > 25) zones.push({ station: k, quality: clamp((dropKmh - 25) / 100, 0, 1) * clamp(run / 600, 0.15, 1) });
  }
  return zones.sort((a, b) => a.station - b.station);
}

/** Braking onsets closer than this (metres) belong to one zone. */
const MERGE_ZONES = 200;

function pitModel(f: Facilities, car: VehicleClass, n: number): PitModel | null {
  const pit = f.pitLane;
  if (!pit) return null;
  const m = pit.x.length;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(pit.x[i] - pit.x[i - 1], pit.y[i] - pit.y[i - 1]);
  const length = cum[m - 1];
  const half = Math.min(PIT_RAMP / 2, length / 4);
  return {
    entry: pit.entry,
    exit: pit.exit,
    span: (pit.exit - pit.entry + n) % n,
    x: pit.x,
    y: pit.y,
    cum,
    length,
    limit: car.pitSpeed,
    limitFrom: half,
    limitTo: length - half,
    boxFrom: cum[Math.min(m - 1, pit.boxStart)],
    boxTo: cum[Math.min(m - 1, pit.boxEnd)],
    driveThroughLoss: f.pitLoss.find((p) => p.vehicleId === car.id)?.loss ?? 20,
    width: pit.width,
    side: pit.side,
  };
}

/** Grid positions behind the line, staggered as in startFinish.gridSlots, for any number of cars. */
function gridStarts(t: Track, line: RacingLine, count: number): GridStart[] {
  let right = true;
  for (let k = 0; k < t.n; k++) {
    if (Math.abs(t.curvature[k]) > 1 / 300) {
      right = t.curvature[k] > 0;
      break;
    }
  }
  const poleSide = right ? -1 : 1;
  const out: GridStart[] = [];
  for (let p = 0; p < count; p++) {
    const back = 6 + p * 8;
    const k = ((t.n - Math.round(back / t.ds)) % t.n + t.n) % t.n;
    const side = p % 2 === 0 ? poleSide : -poleSide;
    out.push({ u: -back / t.ds, lateral: side * t.width[k] * 0.25 - line.offset[k] });
  }
  return out;
}

function cornerLookup(n: number, ds: number, corners: readonly { number: number; start: number; end: number }[]): Int16Array {
  const out = new Int16Array(n);
  for (const c of corners) {
    const len = c.end >= c.start ? c.end - c.start : n - c.start + c.end;
    for (let i = 0; i <= len; i++) out[(c.start + i) % n] = c.number;
  }
  // Stations before a corner take its number, looking up to 400 m ahead.
  const reach = Math.round(400 / ds);
  let next = 0;
  let dist = Infinity;
  for (let i = 2 * n - 1; i >= 0; i--) {
    const k = i % n;
    if (out[k] && corners.some((c) => c.start === k)) {
      next = out[k];
      dist = 0;
    } else dist++;
    if (i < n && !out[k] && dist <= reach) out[k] = next;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
