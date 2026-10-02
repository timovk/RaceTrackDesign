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
 * as long at any playback speed (at high speeds that leaves the helicopter
 * and the onboard cameras).
 *
 * Onboard cameras ride on the cars: above the driver looking ahead, low on
 * the nose, looking back, and a chase camera following behind. The director
 * cuts to them now and then for the car the viewer picked, a battle (from
 * the car behind, or looking back from the car ahead), the leader and the
 * field, never twice running. A car standing in its pit box is shown from a
 * camera in the pit lane in front of it, and the start from behind the grid.
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
  /** Race seconds left of its stop in the box (0 when not stopped). */
  stopLeft?: number;
  selected: boolean;
}

export type Subject = { kind: 'car'; id: number } | { kind: 'battle'; ahead: number; behind: number } | { kind: 'group'; ids: number[] };

export type ShotReason = 'battle' | 'incident' | 'overtake' | 'leader' | 'pit' | 'selected' | 'field' | 'start' | 'replay';

/** Cameras on a car: above the driver looking ahead, on the nose, looking back, and the chase camera behind it. */
export type OnboardView = 'tcam' | 'nose' | 'rear' | 'chase';
export const ONBOARD_VIEWS: readonly OnboardView[] = ['tcam', 'nose', 'rear', 'chase'];

export function isOnboard(camera: string): camera is OnboardView {
  return (ONBOARD_VIEWS as readonly string[]).includes(camera);
}

export interface TvShot {
  subject: Subject;
  /** A trackside camera's id, 'heli', an onboard view, or 'pitbox' (a camera in the pit lane in front of a stopped car). */
  camera: string;
  /** The car an onboard or pit box camera belongs to. */
  carrier?: number;
  reason: ShotReason;
  /** Director time the shot started and how long it may last at most (seconds of screen time). */
  start: number;
  hold: number;
  /** A replay: the stretch of race time it shows, and how fast (race seconds per screen second). */
  replay?: { from: number; to: number; speed: number };
}

/** The cars in a subject, front first. */
export function subjectIds(sub: Subject): number[] {
  return sub.kind === 'car' ? [sub.id] : sub.kind === 'battle' ? [sub.ahead, sub.behind] : sub.ids;
}

/** Something that happened, for the director: a car in trouble or overtaking. */
export interface TvEvent {
  kind: 'incident' | 'overtake';
  car: number;
  /** Director time it happened. */
  at: number;
  /** For a replay: the car passed, the race time it happened and where the car was then (race progress). */
  other?: number;
  raceTime?: number;
  u?: number;
}

/** What a replay needs to know about an event besides the car. */
export interface ReplayDetail {
  other?: number;
  raceTime: number;
  u: number;
}

const MIN_SHOT = 2.5;
const BATTLE_GAP = 1.0;
/** A trackside camera must keep the car in sight at least this long (screen seconds) to be cut to. */
const MIN_IN_SIGHT = 3;
/** Chance of an onboard camera for each kind of shot, when one is due. */
const ONBOARD_CHANCE: Partial<Record<ShotReason, number>> = { selected: 0.35, battle: 0.3, leader: 0.25, field: 0.3 };
/** A pit stop is shown from the pit box only when this many screen seconds of it are left. */
const MIN_PIT_SHOT = 2;
/** The start is shown from behind the grid within this many race seconds of it, for this many race seconds, at up to this playback speed. */
const START_WINDOW = 3;
const START_HOLD = 8;
const START_MAX_RATE = 5;
/** Cars in the start shot. */
const START_GROUP = 4;
/**
 * Replays: race seconds shown before and after an overtake (and an
 * incident), at half speed; offered from this many race seconds after it
 * until this many, at most one per this many screen seconds, and only at up
 * to this playback speed.
 */
const REPLAY_BEFORE = 4;
const REPLAY_AFTER = 2;
const REPLAY_BEFORE_INCIDENT = 3;
const REPLAY_AFTER_INCIDENT = 4;
const REPLAY_SPEED = 0.5;
const REPLAY_FROM = 2.5;
const REPLAY_WITHIN = 25;
const REPLAY_GAP = 25;
const REPLAY_MAX_RATE = 5;

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
  /** Events worth a replay, not yet replayed, and when the last replay started. */
  private replays: TvEvent[] = [];
  private lastReplay = -Infinity;

  constructor(cameras: TvCamera[], track: DirectorTrack, rng: () => number = Math.random) {
    this.cameras = cameras;
    for (const c of cameras) this.byId.set(c.id, c);
    this.track = track;
    this.rng = rng;
  }

  camera(id: string): TvCamera | undefined {
    return this.byId.get(id);
  }

  /** Starts afresh, for a new race on the same circuit. */
  reset(): void {
    this.shot = null;
    this.recent = [];
    this.events = [];
    this.shownStops.clear();
    this.replays = [];
    this.lastReplay = -Infinity;
  }

  /** Ends the current shot now (a replay that cannot be shown after all). */
  endShot(): void {
    if (this.shot) this.shot = { ...this.shot, hold: 0 };
  }

  /** Something worth showing happened (at the current clock); with `replay`, worth a replay too. */
  note(kind: TvEvent['kind'], car: number, replay?: ReplayDetail): void {
    const e: TvEvent = { kind, car, at: this.clock, ...replay };
    this.events.push(e);
    if (replay) this.replays.push(e);
  }

  /**
   * Advances the clock by `dt` screen seconds (0 while paused), with the
   * race running `rate` race seconds per screen second, and cuts when the
   * shot has run its time, its car has left the camera's sight, or something
   * more important happened. The first shot within a few seconds of the
   * start (`raceTime`, race seconds) is the start from behind the grid;
   * an overtake or incident noted for a replay is replayed a few seconds
   * later. Returns the shot to show.
   */
  update(dt: number, rate: number, cars: readonly TvCar[], raceTime = Infinity): TvShot | null {
    this.clock += Math.max(0, dt);
    this.events = this.events.filter((e) => this.clock - e.at < 12);
    this.replays = this.replays.filter((e) => !(raceTime - e.raceTime! > REPLAY_WITHIN));
    const byId = new Map(cars.map((c) => [c.id, c]));
    const s = this.shot;
    if (s && !this.mustCut(s, byId, rate, raceTime)) return s;
    const opening = !s && this.recent.length === 0 && raceTime < START_WINDOW && rate <= START_MAX_RATE;
    this.shot = (opening ? this.startShot(cars, rate) : null) ?? this.choose(cars, byId, rate, raceTime);
    if (this.shot) {
      this.recent.push(this.shot);
      if (this.recent.length > 6) this.recent.shift();
    }
    return this.shot;
  }

  /** Whether a replay is due: one is waiting long enough, and none was shown lately. */
  private replayReady(rate: number, raceTime: number): boolean {
    return rate <= REPLAY_MAX_RATE && this.clock - this.lastReplay >= REPLAY_GAP && this.replays.some((e) => raceTime - e.raceTime! >= REPLAY_FROM);
  }

  /** The start, from the camera behind the grid, on the front of the field. */
  private startShot(cars: readonly TvCar[], rate: number): TvShot | null {
    if (!this.byId.has('start')) return null;
    const ids = cars.filter((c) => c.running).sort((a, b) => a.position - b.position).slice(0, START_GROUP).map((c) => c.id);
    if (!ids.length) return null;
    return { subject: { kind: 'group', ids }, camera: 'start', reason: 'start', start: this.clock, hold: Math.max(MIN_SHOT, START_HOLD / rate) };
  }

  private subjectCars(sub: Subject, byId: Map<number, TvCar>): TvCar[] {
    return subjectIds(sub).map((id) => byId.get(id)).filter((c): c is TvCar => !!c);
  }

  private mustCut(s: TvShot, byId: Map<number, TvCar>, rate: number, raceTime: number): boolean {
    const elapsed = this.clock - s.start;
    if (elapsed >= s.hold) return true;
    // A replay plays to its end.
    if (s.reason === 'replay') return false;
    // A replay that is ready comes as soon as the shot has had its moment (not an incident, the start or a stop).
    if (elapsed > MIN_SHOT && s.reason !== 'incident' && s.reason !== 'start' && s.reason !== 'pit' && this.replayReady(rate, raceTime)) return true;
    const cars = this.subjectCars(s.subject, byId);
    if (cars.length === 0) return true;
    // Something more important.
    const incident = elapsed > MIN_SHOT && s.reason !== 'incident' && this.events.some((e) => e.kind === 'incident' && e.at > s.start);
    // The start holds on the field as it gets away, until the back of it leaves the camera's sight.
    if (s.reason !== 'start') {
      // An onboard camera goes with its car, the pit box camera until the car has left the pit lane.
      const carrier = s.carrier === undefined ? null : byId.get(s.carrier);
      if (s.carrier !== undefined && !carrier) return true;
      if (carrier && isOnboard(s.camera) && !carrier.running) return true;
      if (carrier && s.camera === 'pitbox' && !carrier.inPit) return true;
      // A battle that has broken up, a car that has stopped running (an incident shot may linger on it).
      if (s.subject.kind === 'battle' && elapsed > MIN_SHOT && cars.some((c) => !c.running || c.interval > BATTLE_GAP * 1.6)) return true;
      if (s.reason !== 'incident' && s.reason !== 'pit' && cars.some((c) => !c.running && !c.inPit)) return true;
    }
    // About to leave a trackside camera's sight (the car at the back of a battle).
    if (this.byId.has(s.camera) && elapsed > 1) {
      const cam = this.byId.get(s.camera);
      const rear = cars[cars.length - 1];
      if (!cam || (rear.running && timeInSight(cam.sees, this.track, rear.u, rear.speed, rate + 1) / rate < 0.3)) return true;
    }
    return incident;
  }

  private choose(cars: readonly TvCar[], byId: Map<number, TvCar>, rate: number, raceTime: number): TvShot | null {
    const running = cars.filter((c) => c.running);
    if (running.length === 0 && cars.length === 0) return null;
    type Candidate = { subject: Subject; reason: ShotReason; score: number; event?: TvEvent };
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
    // A replay of an overtake or incident a few seconds ago, one at a time.
    if (running.length && this.replayReady(rate, raceTime)) {
      for (const e of this.replays) {
        const age = raceTime - e.raceTime!;
        if (!(age >= REPLAY_FROM)) continue;
        const mine = !!selected && (e.car === selected.id || e.other === selected.id);
        const subject: Subject = e.kind === 'overtake' && e.other !== undefined ? { kind: 'battle', ahead: e.car, behind: e.other } : { kind: 'car', id: e.car };
        cand.push({ subject, reason: 'replay', score: mine ? 125 : e.kind === 'incident' ? 108 : 100, event: e });
      }
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
      if (c.reason !== 'selected' && c.reason !== 'incident' && c.reason !== 'replay') c.score -= repeats * (c.reason === 'battle' ? 8 : 18);
      c.score += this.rng() * 6;
    }
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand) {
      const shot = c.event ? this.replayShot(c.event, c.subject, byId) : this.frame(c.subject, c.reason, byId, rate);
      if (shot) {
        if (c.reason === 'pit' && c.subject.kind === 'car') this.shownStops.add(`${c.subject.id}`);
        this.shownStops = new Set([...this.shownStops].filter((id) => byId.get(Number(id))?.inPit));
        return shot;
      }
    }
    return null;
  }

  /**
   * A replay of an event: from a trackside camera that sees most of the
   * stretch it happened on (not the one just used), now and then from on
   * board (an overtake from the car that passed, or looking back from the
   * car passed), or from the helicopter.
   */
  private replayShot(e: TvEvent, subject: Subject, byId: Map<number, TvCar>): TvShot {
    this.replays = this.replays.filter((r) => r !== e);
    this.lastReplay = this.clock;
    const incident = e.kind === 'incident';
    const before = incident ? REPLAY_BEFORE_INCIDENT : REPLAY_BEFORE;
    const after = incident ? REPLAY_AFTER_INCIDENT : REPLAY_AFTER;
    const replay = { from: e.raceTime! - before, to: e.raceTime! + after, speed: REPLAY_SPEED };
    const shot = (camera: string, carrier?: number): TvShot => ({ subject, camera, carrier, reason: 'replay', start: this.clock, hold: (before + after) / REPLAY_SPEED, replay });
    const r = this.rng();
    if (!incident && e.other !== undefined && r < 0.35) return r < 0.2 ? shot('tcam', e.car) : shot('rear', e.other);
    // The stretch the cars covered during the replay, at about their speed now.
    const n = this.track.n;
    const speed = Math.max(20, byId.get(e.car)?.speed ?? 50);
    const k0 = Math.floor(mod(e.u! - (before * speed) / this.track.ds, n));
    const span = Math.ceil(((before + after) * speed) / this.track.ds);
    const last = this.recent[this.recent.length - 1]?.camera;
    let best: { cam: TvCamera; seen: number } | null = null;
    for (const cam of this.cameras) {
      if (cam.id === last || !cam.sees[Math.floor(mod(e.u!, n))]) continue;
      let seen = 0;
      for (let i = 0; i < span; i++) seen += cam.sees[(k0 + i) % n];
      if (!best || seen + this.rng() * 3 > best.seen) best = { cam, seen };
    }
    return best && best.seen > span * 0.3 ? shot(best.cam.id) : shot('heli');
  }

  /**
   * The camera for a subject: the pit box camera for a car standing in its
   * box, now and then an onboard camera, otherwise the trackside camera that
   * keeps it in sight longest (preferring one it drives towards), or the
   * helicopter.
   */
  private frame(subject: Subject, reason: ShotReason, byId: Map<number, TvCar>, rate: number): TvShot | null {
    const cars = this.subjectCars(subject, byId);
    if (cars.length === 0) return null;
    const lead = cars[cars.length - 1];
    // A stop in the box, while enough of it is left to see at this speed.
    if (reason === 'pit' && lead.stopped) {
      const left = (lead.stopLeft ?? 0) / Math.max(1e-6, rate);
      if (left >= MIN_PIT_SHOT) return { subject, camera: 'pitbox', carrier: lead.id, reason, start: this.clock, hold: Math.min(12, left + 2.5) };
    }
    const hold = 5 + this.rng() * 7;
    const last = this.recent[this.recent.length - 1];
    // Now and then onboard, but never twice running and at most two in four shots.
    const chance = ONBOARD_CHANCE[reason] ?? 0;
    const onboardDue = chance > 0 && cars.every((c) => c.running) && !(last && isOnboard(last.camera))
      && this.recent.slice(-3).filter((r) => isOnboard(r.camera)).length < 2;
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
    // With no trackside camera to hold it (a fast playback), onboard as often as the helicopter.
    if (onboardDue && this.rng() < (best ? chance : 0.5)) return this.onboard(subject, reason);
    const useHeli = !best || (heliDue && reason !== 'pit' && reason !== 'incident');
    if (useHeli) return { subject, camera: 'heli', reason, start: this.clock, hold: 6 + this.rng() * 5 };
    return { subject, camera: best!.cam.id, reason, start: this.clock, hold: Math.max(MIN_SHOT, Math.min(hold, best!.sight - 0.5)) };
  }

  /**
   * An onboard shot: a battle from the car behind (above the driver, or on
   * the nose) or looking back from the car ahead; a single car from above
   * the driver, the nose or the chase camera.
   */
  private onboard(subject: Subject, reason: ShotReason): TvShot {
    const r = this.rng();
    let carrier: number;
    let camera: OnboardView;
    if (subject.kind === 'battle') {
      if (r < 0.25) {
        carrier = subject.ahead;
        camera = 'rear';
      } else {
        carrier = subject.behind;
        camera = r < 0.85 ? 'tcam' : 'nose';
      }
    } else {
      carrier = subjectIds(subject)[0];
      camera = r < 0.45 ? 'tcam' : r < 0.65 ? 'nose' : 'chase';
    }
    return { subject, camera, carrier, reason, start: this.clock, hold: 6 + this.rng() * 4 };
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
