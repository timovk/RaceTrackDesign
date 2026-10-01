/**
 * The race as television shows it: where the trackside cameras stand and
 * which stretches of track each can see, a director who decides what to
 * show and from which camera, and how a camera frames what it shows.
 *
 * Cameras stand where a circuit puts them: a tower beyond the run-off at
 * every corner, one behind the grid, one over the pit lane, one beside every
 * long straight, and more wherever a stretch of track is still out of sight.
 * A camera sees a station when the track there is within reach of its lens
 * and no hill is in the way (positions and heights as drawn, see shots.ts).
 *
 * The director cuts: each shot holds a few seconds on one car or a battle,
 * from the trackside camera that keeps it in view longest (better when the
 * car comes towards it), or from the helicopter, which can follow anything.
 * Close battles come first, then incidents, overtakes, the leader, pit stops
 * and, for variety, the rest of the field; a car the viewer picked is shown
 * most. Its clock runs in screen time while the race plays, so shots last
 * as long at any playback speed (at high speeds that leaves the helicopter).
 */
import type { TrackMetrics } from './analysis.ts';
import type { PitLane } from './pitLane.ts';
import { type Display, type Vec3, trackShots } from './shots.ts';
import type { Track } from './track.ts';

export interface TvCamera {
  id: string;
  label: string;
  /** Position, world coordinates (x east, y south, z up) with heights as drawn. */
  at: Vec3;
  /** Per station: 1 where the camera sees the track. */
  sees: Uint8Array;
}

export interface CameraInput {
  track: Track;
  metrics: TrackMetrics;
  pit: PitLane | null;
  /** Shaped ground height (real). */
  height: (x: number, y: number) => number;
  /** A real height as drawn (default: as it is). */
  display?: Display;
  /** Run-off depth beside station k on a side, for the corner towers. */
  runoff?: (k: number, side: 1 | -1) => number;
}

/** A trackside lens reaches this far (metres), and is no use closer than this. */
export const CAMERA_REACH = 750;
const CAMERA_NEAR = 12;
/** Straights at least this long get a camera of their own. */
const STRAIGHT_CAMERA = 250;
/** A stretch of track out of every camera's sight longer than this gets another camera. */
const BLIND_STRETCH = 120;
const MAX_CAMERAS = 60;

/**
 * Whether a camera at `at` sees the point (x, y) at drawn height z: within
 * reach, and the drawn ground below the line of sight all the way (ignoring
 * the last few metres, where the line meets the track it looks at).
 */
export function lineOfSight(at: Vec3, x: number, y: number, z: number, ground: (x: number, y: number) => number): boolean {
  const d = Math.hypot(x - at[0], y - at[1]);
  if (d < CAMERA_NEAR || d > CAMERA_REACH) return false;
  const steps = Math.max(8, Math.ceil(d / 25));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    if (f * d > d - 6) break;
    const px = at[0] + (x - at[0]) * f;
    const py = at[1] + (y - at[1]) * f;
    const pz = at[2] + (z - at[2]) * f;
    if (ground(px, py) > pz - 0.2) return false;
  }
  return true;
}

/** Which stations a camera sees: every third tested, the ones between taking the verdict of both neighbours. */
function coverage(at: Vec3, t: Track, display: Display, ground: (x: number, y: number) => number): Uint8Array {
  const n = t.n;
  const sees = new Uint8Array(n);
  const step = 3;
  const test = (k: number) => lineOfSight(at, t.x[k], t.y[k], display(t.z[k]) + 1, ground);
  let prev = -1;
  let prevSeen = false;
  for (let k = 0; k <= n; k += step) {
    const kk = Math.min(k, n - 1);
    const dx = t.x[kk] - at[0];
    const dy = t.y[kk] - at[1];
    const seen = dx * dx + dy * dy <= CAMERA_REACH * CAMERA_REACH && test(kk);
    if (seen) sees[kk] = 1;
    if (prev >= 0 && seen && prevSeen) for (let j = prev + 1; j < kk; j++) sees[j] = 1;
    prev = kk;
    prevSeen = seen;
  }
  // A glimpse lost for a few metres (a post, a bump) does not end the shot: close short gaps.
  const gap = 10;
  for (let k = 0; k < n; k++) {
    if (sees[k] || !sees[(k - 1 + n) % n]) continue;
    let j = 0;
    while (j < gap && !sees[(k + j) % n]) j++;
    if (j < gap) for (let i = 0; i < j; i++) sees[(k + i) % n] = 1;
  }
  return sees;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** A point beside station k, `side` metres to the left, `up` metres above the drawn ground there. */
function beside(t: Track, k: number, side: number, up: number, display: Display, height: (x: number, y: number) => number): Vec3 {
  const h = t.heading[k];
  const x = t.x[k] + Math.sin(h) * side;
  const y = t.y[k] - Math.cos(h) * side;
  return [x, y, Math.max(display(height(x, y)), display(t.z[k])) + up];
}

/** The trackside cameras of a circuit, with what each can see. */
export function tvCameras(input: CameraInput): TvCamera[] {
  const t = input.track;
  const n = t.n;
  const display = input.display ?? ((z: number) => z);
  const ground = (x: number, y: number) => display(input.height(x, y));
  const cams: TvCamera[] = [];
  const add = (id: string, label: string, at: Vec3) => cams.push({ id, label, at, sees: coverage(at, t, display, ground) });
  // The shots' camera positions: corner towers, behind the grid, over the pit lane.
  const shots = trackShots({ track: t, metrics: input.metrics, pit: input.pit, height: input.height, display, runoff: input.runoff });
  for (const s of shots) {
    if (s.id.startsWith('corner-')) add(s.id, s.label.split(' ')[0], s.camera);
    else if (s.id === 'start') add('start', 'Start', s.camera);
    else if (s.id === 'pit') add('pit', 'Pit lane', s.camera);
  }
  // Beside every long straight, two thirds of the way along, on the lower side, raised on a stand.
  input.metrics.straights.forEach((st, i) => {
    if (st.length < STRAIGHT_CAMERA) return;
    const k = mod(st.start + Math.round(mod(st.end - st.start, n) * 0.65), n);
    const reach = t.width[k] / 2 + 3 + 22;
    const l = beside(t, k, reach, 0, display, input.height);
    const r = beside(t, k, -reach, 0, display, input.height);
    const side = l[2] <= r[2] ? reach : -reach;
    add(`straight-${i + 1}`, 'Straight', beside(t, k, side, 8, display, input.height));
  });
  // Wherever the track is still out of sight, another camera beside the middle of that stretch.
  const covered = new Uint8Array(n);
  for (const c of cams) for (let k = 0; k < n; k++) covered[k] |= c.sees[k];
  let fill = 0;
  for (let guard = 0; guard < MAX_CAMERAS && cams.length < MAX_CAMERAS; guard++) {
    const run = longestGap(covered);
    if (!run || run.length * t.ds < BLIND_STRETCH) break;
    const k = mod(run.start + Math.floor(run.length / 2), n);
    const reach = t.width[k] / 2 + 3 + 18;
    const l = beside(t, k, reach, 0, display, input.height);
    const r = beside(t, k, -reach, 0, display, input.height);
    const side = l[2] <= r[2] ? reach : -reach;
    let placed = false;
    for (const up of [6, 12, 25]) {
      const at = beside(t, k, side, up, display, input.height);
      const sees = coverage(at, t, display, ground);
      if (!sees[k]) continue;
      cams.push({ id: `fill-${++fill}`, label: 'Trackside', at, sees });
      for (let j = 0; j < n; j++) covered[j] |= sees[j];
      placed = true;
      break;
    }
    // A stretch no camera can see from beside it: give up on it.
    if (!placed) for (let j = 0; j < run.length; j++) covered[mod(run.start + j, n)] = 1;
  }
  return cams;
}

/** The longest run of zeros round the lap, or null when there is none. */
function longestGap(covered: Uint8Array): { start: number; length: number } | null {
  const n = covered.length;
  let first = covered.indexOf(1);
  if (first < 0) return { start: 0, length: n };
  let best: { start: number; length: number } | null = null;
  let start = -1;
  for (let i = 1; i <= n; i++) {
    const k = (first + i) % n;
    if (!covered[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      const length = mod(k - start, n);
      if (!best || length > best.length) best = { start, length };
      start = -1;
    }
  }
  return best;
}

// ---- the director ---------------------------------------------------------------

export interface TvCar {
  id: number;
  /** Race progress in stations. */
  u: number;
  /** m/s. */
  speed: number;
  position: number;
  classIndex: number;
  classPosition: number;
  /** Seconds behind the car one place ahead in the class (Infinity when there is none or it is a lap or more). */
  interval: number;
  /** On track (not in the pits, retired or finished). */
  running: boolean;
  inPit: boolean;
  /** Stationary in its pit box. */
  stopped: boolean;
  selected: boolean;
}

export type Subject = { kind: 'car'; id: number } | { kind: 'battle'; ahead: number; behind: number };

export type ShotReason = 'battle' | 'incident' | 'overtake' | 'leader' | 'pit' | 'selected' | 'field';

export interface TvShot {
  subject: Subject;
  /** A trackside camera's id, or 'heli'. */
  camera: string;
  reason: ShotReason;
  /** Director time the shot started and how long it may last at most (seconds of screen time). */
  start: number;
  hold: number;
}

/** Something that happened, for the director: a car in trouble or overtaking. */
export interface TvEvent {
  kind: 'incident' | 'overtake';
  car: number;
  /** Director time it happened. */
  at: number;
}

const MIN_SHOT = 2.5;
const BATTLE_GAP = 1.0;
/** A trackside camera must keep the car in sight at least this long (screen seconds) to be cut to. */
const MIN_IN_SIGHT = 3;

export interface DirectorTrack {
  n: number;
  ds: number;
}

/** Seconds of race time a car at u (moving at `speed`) stays in a camera's sight from now, up to `max`. */
export function timeInSight(sees: Uint8Array, track: DirectorTrack, u: number, speed: number, max: number): number {
  const n = track.n;
  const k0 = Math.floor(mod(u, n));
  if (!sees[k0]) return 0;
  const perSecond = Math.max(1, speed) / track.ds;
  const limit = Math.min(n, Math.ceil(max * perSecond));
  let k = 0;
  while (k < limit && sees[(k0 + k) % n]) k++;
  return k / perSecond;
}

export class Director {
  readonly cameras: TvCamera[];
  private readonly byId = new Map<string, TvCamera>();
  private readonly track: DirectorTrack;
  private readonly rng: () => number;
  /** Screen seconds while the race plays. */
  clock = 0;
  shot: TvShot | null = null;
  private recent: TvShot[] = [];
  private events: TvEvent[] = [];
  private shownStops = new Set<string>();

  constructor(cameras: TvCamera[], track: DirectorTrack, rng: () => number = Math.random) {
    this.cameras = cameras;
    for (const c of cameras) this.byId.set(c.id, c);
    this.track = track;
    this.rng = rng;
  }

  camera(id: string): TvCamera | undefined {
    return this.byId.get(id);
  }

  /** Something worth showing happened (at the current clock). */
  note(kind: TvEvent['kind'], car: number): void {
    this.events.push({ kind, car, at: this.clock });
  }

  /**
   * Advances the clock by `dt` screen seconds (0 while paused), with the
   * race running `rate` race seconds per screen second, and cuts when the
   * shot has run its time, its car has left the camera's sight, or something
   * more important happened. Returns the shot to show.
   */
  update(dt: number, rate: number, cars: readonly TvCar[]): TvShot | null {
    this.clock += Math.max(0, dt);
    this.events = this.events.filter((e) => this.clock - e.at < 12);
    const byId = new Map(cars.map((c) => [c.id, c]));
    const s = this.shot;
    if (s && !this.mustCut(s, byId, rate)) return s;
    this.shot = this.choose(cars, byId, rate);
    if (this.shot) {
      this.recent.push(this.shot);
      if (this.recent.length > 6) this.recent.shift();
    }
    return this.shot;
  }

  private subjectCars(sub: Subject, byId: Map<number, TvCar>): TvCar[] {
    const ids = sub.kind === 'car' ? [sub.id] : [sub.ahead, sub.behind];
    return ids.map((id) => byId.get(id)).filter((c): c is TvCar => !!c);
  }

  private mustCut(s: TvShot, byId: Map<number, TvCar>, rate: number): boolean {
    const elapsed = this.clock - s.start;
    if (elapsed >= s.hold) return true;
    const cars = this.subjectCars(s.subject, byId);
    if (cars.length === 0) return true;
    // A battle that has broken up, a car that has stopped running (an incident shot may linger on it).
    if (s.subject.kind === 'battle' && elapsed > MIN_SHOT && cars.some((c) => !c.running || c.interval > BATTLE_GAP * 1.6)) return true;
    if (s.reason !== 'incident' && s.reason !== 'pit' && cars.some((c) => !c.running && !c.inPit)) return true;
    // About to leave the camera's sight (the car at the back of a battle).
    if (s.camera !== 'heli' && elapsed > 1) {
      const cam = this.byId.get(s.camera);
      const rear = cars[cars.length - 1];
      if (!cam || (rear.running && timeInSight(cam.sees, this.track, rear.u, rear.speed, rate + 1) / rate < 0.3)) return true;
    }
    // Something more important.
    if (elapsed > MIN_SHOT && s.reason !== 'incident' && this.events.some((e) => e.kind === 'incident' && e.at > s.start)) return true;
    return false;
  }

  private choose(cars: readonly TvCar[], byId: Map<number, TvCar>, rate: number): TvShot | null {
    const running = cars.filter((c) => c.running);
    if (running.length === 0 && cars.length === 0) return null;
    type Candidate = { subject: Subject; reason: ShotReason; score: number };
    const cand: Candidate[] = [];
    const selected = cars.find((c) => c.selected);
    // Battles: a car within a second of the one ahead in its class.
    const battles: Candidate[] = [];
    const byClassPos = new Map<string, TvCar>(running.map((c) => [`${c.classIndex}:${c.classPosition}`, c]));
    for (const c of running) {
      if (c.interval > BATTLE_GAP || c.classPosition <= 1) continue;
      const ahead = byClassPos.get(`${c.classIndex}:${c.classPosition - 1}`);
      if (!ahead) continue;
      battles.push({ subject: { kind: 'battle', ahead: ahead.id, behind: c.id }, reason: 'battle', score: 60 + 30 * (1 - c.interval / BATTLE_GAP) + Math.max(0, 12 - c.classPosition) * 2 });
    }
    if (selected) {
      // The viewer's car, in a battle when it is in one.
      const own = battles.find((b) => b.subject.kind === 'battle' && (b.subject.ahead === selected.id || b.subject.behind === selected.id));
      cand.push(own ? { ...own, score: 120 } : { subject: { kind: 'car', id: selected.id }, reason: 'selected', score: 110 });
    }
    cand.push(...battles);
    for (const e of this.events) {
      const c = byId.get(e.car);
      if (!c) continue;
      // A director cuts straight to trouble.
      cand.push({ subject: { kind: 'car', id: e.car }, reason: e.kind, score: e.kind === 'incident' ? 100 : 62 });
    }
    const leader = running.find((c) => c.position === 1) ?? running[0];
    if (leader) cand.push({ subject: { kind: 'car', id: leader.id }, reason: 'leader', score: 42 });
    for (const c of running) if (c.classPosition === 1 && c !== leader) cand.push({ subject: { kind: 'car', id: c.id }, reason: 'leader', score: 32 });
    for (const c of cars) {
      if (!c.stopped) continue;
      const key = `${c.id}`;
      if (this.shownStops.has(key)) continue;
      cand.push({ subject: { kind: 'car', id: c.id }, reason: 'pit', score: 48 - c.position * 0.5 });
    }
    // Variety: anyone running.
    for (let i = 0; i < 3 && running.length; i++) {
      const c = running[Math.floor(this.rng() * running.length)];
      cand.push({ subject: { kind: 'car', id: c.id }, reason: 'field', score: 18 + this.rng() * 10 });
    }
    // Less of what was just shown.
    const same = (a: Subject, b: Subject) => (a.kind === 'car' && b.kind === 'car' && a.id === b.id) || (a.kind === 'battle' && b.kind === 'battle' && a.ahead === b.ahead && a.behind === b.behind);
    for (const c of cand) {
      const repeats = this.recent.filter((r) => same(r.subject, c.subject)).length;
      if (c.reason !== 'selected' && c.reason !== 'incident') c.score -= repeats * (c.reason === 'battle' ? 8 : 18);
      c.score += this.rng() * 6;
    }
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand) {
      const shot = this.frame(c.subject, c.reason, byId, rate);
      if (shot) {
        if (c.reason === 'pit' && c.subject.kind === 'car') this.shownStops.add(`${c.subject.id}`);
        this.shownStops = new Set([...this.shownStops].filter((id) => byId.get(Number(id))?.inPit));
        return shot;
      }
    }
    return null;
  }

  /** The camera for a subject: the trackside camera that keeps it in sight longest (preferring one it drives towards), or the helicopter. */
  private frame(subject: Subject, reason: ShotReason, byId: Map<number, TvCar>, rate: number): TvShot | null {
    const cars = this.subjectCars(subject, byId);
    if (cars.length === 0) return null;
    const lead = cars[cars.length - 1];
    const hold = 5 + this.rng() * 7;
    const last = this.recent[this.recent.length - 1];
    // Now and then the helicopter, but not twice running.
    const heliDue = !!last && last.camera !== 'heli' && this.recent.slice(-3).every((r) => r.camera !== 'heli') && this.rng() < 0.4;
    let best: { cam: TvCamera; score: number; sight: number } | null = null;
    if (lead.running || lead.inPit) {
      for (const cam of this.cameras) {
        const sight = timeInSight(cam.sees, this.track, lead.u, lead.speed, 20) / Math.max(1e-6, rate);
        if (sight < MIN_IN_SIGHT) continue;
        let score = Math.min(sight, 12) * 2;
        // The car comes towards the camera: its nearest station is still ahead.
        if (this.ahead(cam, lead.u)) score += 6;
        if (last && last.camera === cam.id) score -= 12;
        if (!best || score > best.score) best = { cam, score, sight };
      }
    } else {
      // A car stopped on track or retired: any camera that sees it.
      for (const cam of this.cameras) {
        if (cam.sees[Math.floor(mod(lead.u, this.track.n))]) {
          best = { cam, score: 1, sight: hold };
          break;
        }
      }
    }
    const useHeli = !best || (heliDue && reason !== 'pit' && reason !== 'incident');
    if (useHeli) return { subject, camera: 'heli', reason, start: this.clock, hold: 6 + this.rng() * 5 };
    return { subject, camera: best!.cam.id, reason, start: this.clock, hold: Math.max(MIN_SHOT, Math.min(hold, best!.sight - 0.5)) };
  }

  /** Whether the camera's closest seen station lies ahead of progress u (the car is still approaching it). */
  private ahead(cam: TvCamera, u: number): boolean {
    const n = this.track.n;
    const k0 = Math.floor(mod(u, n));
    let firstGap = 0;
    while (firstGap < n && cam.sees[(k0 + firstGap) % n]) firstGap++;
    // The camera's view of this stretch: from k0 to k0 + firstGap; the car approaches when more of it lies ahead than it has covered.
    let behind = 0;
    while (behind < n && cam.sees[mod(k0 - behind, n)]) behind++;
    return firstGap > behind;
  }
}

// ---- framing ------------------------------------------------------------------

/**
 * The vertical field of view (degrees) that makes `size` metres at `distance`
 * fill `fraction` of a frame `aspect` wide, within what a broadcast lens can do.
 */
export function framingFov(distance: number, size: number, fraction: number, aspect: number, min = 1.2, max = 50): number {
  const halfWidth = size / fraction / 2;
  const hfov = 2 * Math.atan(halfWidth / Math.max(1, distance));
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / Math.max(0.2, aspect));
  return Math.max(min, Math.min(max, (vfov * 180) / Math.PI));
}

export interface Heli {
  /** Angle round the subject (radians, 0 east), height above it and distance from it, metres. */
  angle: number;
  height: number;
  radius: number;
}

/** The helicopter for a new shot: off to one side of where the car is heading, high up, circling slowly. */
export function heliStart(heading: number, rng: () => number = Math.random): Heli {
  const side = rng() < 0.5 ? 1 : -1;
  return { angle: heading + side * (Math.PI / 2 + (rng() - 0.5) * 1.2), height: 110 + rng() * 80, radius: 170 + rng() * 90 };
}

/** The helicopter after `dt` seconds: circling at about two degrees a second. */
export function heliStep(h: Heli, dt: number): Heli {
  return { ...h, angle: h.angle + dt * 0.035 };
}
