/**
 * The race as television shows it: where the trackside cameras stand and
 * which stretches of track each can see, a director who decides what to
 * show and from which camera, and how a camera frames what it shows.
 *
 * Cameras stand where a circuit would put them: on towers behind the
 * barriers where cars come towards the lens, on the grandstands and the pit
 * building, on a lift over the first corner (cameraPlan.ts).
 * A camera sees a station when the track there is within reach of its lens
 * and neither the ground nor anything built is in the way (solids.ts).
 *
 * The director cuts: each shot holds a few seconds on one car or a battle,
 * from the trackside camera that keeps it in view longest (better when the
 * car comes towards it), or from the helicopter, which can follow anything.
 * What is at stake decides: a battle for the lead of the race comes before
 * one further down or in a slower class, however close; then the leaders on
 * their own, pit stops and, for variety, the rest of the field; a car the
 * viewer picked is shown most. The cars it picks it stays with for 45
 * seconds, cutting from camera to camera and through a pass; only something
 * major cuts in (an incident anywhere, the lead of the race changing hands)
 * or a replay of their own pass. Its clock runs in screen time while the race plays, so
 * shots last as long at any playback speed (at high speeds that leaves the
 * helicopter and the onboard cameras).
 *
 * Onboard cameras ride on the cars: above the driver looking ahead, low on
 * the nose, looking back, and a chase camera following behind. The director
 * cuts to them now and then for the car the viewer picked, a battle (from
 * the car behind, or looking back from the car ahead), the leader and the
 * field, never twice running. A car standing in its pit box is shown from a
 * camera in the pit lane in front of it, and the start from behind the grid.
 */
import { type CameraInput, type TvCamera, planCameras } from './cameraPlan.ts';

export { CAMERA_REACH, type CameraInput, type TvCamera } from './cameraPlan.ts';

/** The trackside cameras of a circuit, with what each can see (see cameraPlan.ts). */
export function tvCameras(input: CameraInput): TvCamera[] {
  return planCameras(input);
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
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
  /** In practice or qualifying: on a push lap (1), or on one in the closing minutes of qualifying (2). */
  pushing?: number;
  /** A car of its class side by side with it now (bodies overlapping along the road), if any. */
  beside?: number;
}

export type Battle = { kind: 'battle'; ahead: number; behind: number };
export type Subject = { kind: 'car'; id: number } | Battle | { kind: 'group'; ids: number[] };

export type ShotReason = 'battle' | 'incident' | 'overtake' | 'leader' | 'pit' | 'selected' | 'field' | 'start' | 'replay' | 'flying' | 'finish';

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
  /** What a replay is of: a pass, or a contact (also the one a penalty has just been given for). */
  replayOf?: 'overtake' | 'contact';
}

/** The cars in a subject, front first. */
export function subjectIds(sub: Subject): number[] {
  return sub.kind === 'car' ? [sub.id] : sub.kind === 'battle' ? [sub.ahead, sub.behind] : sub.ids;
}

/** Whether two battles are between the same two cars, in either order. */
function samePair(a: Battle, b: Battle): boolean {
  return (a.ahead === b.ahead && a.behind === b.behind) || (a.ahead === b.behind && a.behind === b.ahead);
}

/**
 * Something that happened, for the director: a car in trouble, overtaking,
 * or taking the lead of the race on track; two cars going side by side
 * (`fight`); a restart coming or under way (`restart`: the car leading the
 * field); a start from the grid during the race (`start`); and a penalty
 * for a contact a while ago, which is worth another look at it (`penalty`);
 * and the leader a few seconds from the chequered flag (`finish`).
 */
export interface TvEvent {
  kind: 'incident' | 'overtake' | 'lead' | 'fight' | 'restart' | 'start' | 'penalty' | 'finish';
  car: number;
  /** Director time it happened. */
  at: number;
  /** For a replay: the other car in it (the car passed, or hit), the race time it happened and where the car was then (race progress). */
  other?: number;
  raceTime?: number;
  u?: number;
  /** The race time it was noted, when that is not when it happened (a penalty). */
  since?: number;
  /** A start or a finish that has had its shot. */
  shown?: boolean;
}

/** What a replay needs to know about an event besides the car. */
export interface ReplayDetail {
  other?: number;
  raceTime: number;
  u: number;
  since?: number;
}

const MIN_SHOT = 2.5;
const BATTLE_GAP = 1.0;
/** A battle is over once the car behind drops this far back (seconds), or another car comes between. */
const BATTLE_OVER = BATTLE_GAP * 1.6;
/** Once the director picks cars to show, it stays with them at least this long (screen seconds). */
const FOLLOW = 45;
/** Cars it has just followed score this share less, easing back to full over this many screen seconds. */
const FATIGUE = 0.4;
const FATIGUE_RECOVER = 90;
/**
 * What is at stake: a place is worth PLACE_STEP of the place above it, and
 * the second, third and fourth class on the road CLASS_WEIGHT of the first,
 * so the lead of the race is 1 and fifteenth in the second class 0.04.
 */
const PLACE_STEP = 0.82;
const CLASS_WEIGHT = [1, 0.6, 0.45, 0.35];
/** A trackside camera must keep the car in sight at least this long (screen seconds) to be cut to. */
const MIN_IN_SIGHT = 3;
/** Chance of an onboard camera for each kind of shot, when one is due. */
const ONBOARD_CHANCE: Partial<Record<ShotReason, number>> = { selected: 0.35, battle: 0.3, leader: 0.25, field: 0.3, flying: 0.3 };
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
/** Two cars side by side for a place: that much more of a battle, and the shot stays on them up to this much longer (screen seconds). */
const SIDE_BY_SIDE = 30;
const FIGHT_HOLD = 8;
/** A restart is shown on this many cars at the front of the field, for about this long (race seconds). */
const RESTART_GROUP = 5;
const RESTART_HOLD = 10;
/**
 * A sequence: a car that comes towards a camera is left this long (screen
 * seconds) after it has passed it, for the next camera has it coming; and
 * the next camera is on the same side of the road where it can be, so that
 * the cars keep going the same way across the screen.
 */
const PAST_CAMERA = 1.3;
const SAME_SIDE = 5;
/** A camera that lost sight of the cars it was on (the broadcast saw them go behind something) is left alone this long, screen seconds. */
const LOST_FOR = 8;
/** How often the helicopter is a shot's camera, when it has not been one for three shots. */
const HELI_CHANCE = 0.15;
/**
 * The start is a sequence: from behind the grid until the leader is in the
 * sight of the first corner's camera and this many race seconds from the
 * corner (or for this long, where it never is), then the first corner from
 * its own camera for this long.
 */
const BEFORE_CORNER = 3;
const START_LONGEST = 14;
const FIRST_CORNER_HOLD = 7;
/** A car is shown leaving its pit box this long (screen seconds) after it has pulled away, then from the camera over the lane. */
const PIT_AWAY = 1.5;
/** The finish: the leader from this many race seconds before the flag (see the broadcast), until this many screen seconds after the line. */
const AFTER_FLAG = 3;

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
  /** The cars being followed (one, or the two of a battle), since when (director time, less the time away from them), and the viewer's car then. */
  private following: { ids: number[]; since: number; selected: number | null } | null = null;
  /** The cars followed before, and when it left them. */
  private followedBefore: { ids: number[]; until: number }[] = [];
  /** Cameras that lost sight of what they were on, and until when each is left alone (director time). */
  private lost = new Map<string, number>();
  /** The next shot of a sequence, waiting for the one on screen to end. */
  private queue: TvShot[] = [];
  /** When the car in the pit box shot pulled away (director time), or -1. */
  private pitAway = -1;

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
    this.following = null;
    this.followedBefore = [];
    this.lost.clear();
    this.queue = [];
    this.pitAway = -1;
  }

  /** Ends the current shot now (a replay that cannot be shown after all). */
  endShot(): void {
    if (this.shot) this.shot = { ...this.shot, hold: 0 };
  }

  /**
   * The broadcast saw the cars of the shot go behind something from this
   * camera: the shot ends now, and the camera is left alone for a while.
   */
  lostSight(camera: string): void {
    this.lost.set(camera, this.clock + LOST_FOR);
    if (this.shot?.camera === camera) this.endShot();
  }

  private barred(camera: string): boolean {
    return (this.lost.get(camera) ?? -Infinity) > this.clock;
  }

  /** Something worth showing happened (at the current clock); with `replay`, worth a replay too; `other`: the second car in it. */
  note(kind: TvEvent['kind'], car: number, replay?: ReplayDetail, other?: number): void {
    const e: TvEvent = { kind, car, at: this.clock, ...(other === undefined ? {} : { other }), ...replay };
    this.events.push(e);
    if (replay) this.replays.push(e);
  }

  /**
   * Advances the clock by `dt` screen seconds (0 while paused), with the
   * race running `rate` race seconds per screen second, and cuts when the
   * shot has run its time, its car has left the camera's sight, or something
   * major happened. The first shot within a few seconds of the start
   * (`raceTime`, race seconds) is the start from behind the grid; an
   * overtake or incident noted for a replay is replayed a few seconds later.
   * The cars it picks it follows for a while, from one camera after another
   * (see `followed`). Returns the shot to show.
   */
  update(dt: number, rate: number, cars: readonly TvCar[], raceTime = Infinity): TvShot | null {
    this.clock += Math.max(0, dt);
    this.events = this.events.filter((e) => this.clock - e.at < 12);
    this.replays = this.replays.filter((e) => !(raceTime - (e.since ?? e.raceTime!) > REPLAY_WITHIN));
    const byId = new Map(cars.map((c) => [c.id, c]));
    const s = this.shot;
    // Time away from the cars followed (a replay, an incident elsewhere) does not count against their time.
    if (this.following && s && (s.replay || !this.shows(s.subject, this.following.ids))) this.following.since += Math.max(0, dt);
    const was = this.following ? [...this.following.ids] : null;
    const follows = this.followed(byId, cars.find((c) => c.selected)?.id ?? null);
    // A battle on screen keeps up with its cars: the one followed as it is now, any other in its order now (one may have passed the other).
    if (s && s.subject.kind === 'battle' && !s.replay) {
      const mine = follows?.kind === 'battle' && was?.length === 2 && samePair(s.subject, { kind: 'battle', ahead: was[0], behind: was[1] });
      const now = mine ? follows : this.battleNow(s.subject.ahead, s.subject.behind, byId);
      if (now && (now.ahead !== s.subject.ahead || now.behind !== s.subject.behind)) s.subject = now;
    }
    // A start from the grid during the race (a standing restart) is shown as the start was.
    const again = rate <= START_MAX_RATE ? this.events.find((e) => e.kind === 'start' && !e.shown) : undefined;
    if (again) again.shown = true;
    if (s && !again && !this.mustCut(s, byId, rate, raceTime, follows)) return s;
    const opening = !!again || (!s && this.recent.length === 0 && raceTime < START_WINDOW && rate <= START_MAX_RATE);
    // The next shot of a sequence, unless something major came between.
    const major = !!s && this.events.some((e) => e.at > s.start && (e.kind === 'incident' || e.kind === 'restart'));
    const queued = opening || major ? null : this.queued(cars, byId, rate);
    if (opening || major) this.queue = [];
    this.pitAway = -1;
    this.shot = (opening ? this.startShot(cars, rate) : null) ?? queued ?? this.choose(cars, byId, rate, raceTime, follows);
    if (this.shot) {
      this.recent.push(this.shot);
      if (this.recent.length > 6) this.recent.shift();
    }
    return this.shot;
  }

  /** Whether a replay is due: one is waiting long enough (and may cut into the cars followed), and none was shown lately. */
  private replayReady(rate: number, raceTime: number, follows: Subject | null, byId: Map<number, TvCar>): boolean {
    return rate <= REPLAY_MAX_RATE && this.clock - this.lastReplay >= REPLAY_GAP
      && this.replays.some((e) => raceTime - e.raceTime! >= REPLAY_FROM && this.cutsIn(e, follows, byId));
  }

  /** Whether the two cars of a battle are side by side now. */
  private sideBySide(b: Battle, byId: Map<number, TvCar>): boolean {
    return byId.get(b.ahead)?.beside === b.behind || byId.get(b.behind)?.beside === b.ahead;
  }

  /** Whether a subject has any of these cars in it. */
  private shows(sub: Subject, ids: number[]): boolean {
    return subjectIds(sub).some((id) => ids.includes(id));
  }

  /**
   * The cars being followed, as they are now. The director stays with the
   * cars it picked for FOLLOW seconds, not counting the time it was away
   * from them (a replay, a major event elsewhere), as the battle they are in
   * now: the same two in their order now; when a third car comes between
   * them, or one drops back from a car still close to the other, the battle
   * that is left; a car that was alone and has caught another, the two. With
   * no battle, the better placed of them alone. It lets go when the time is
   * up, none of them is out there any more or the viewer picks another car;
   * null when it follows none.
   */
  private followed(byId: Map<number, TvCar>, selected: number | null): Subject | null {
    const f = this.following;
    if (!f) return null;
    const picked = selected !== null && selected !== f.selected && !f.ids.includes(selected);
    let subject: Subject | null = null;
    if (!picked && this.clock - f.since < FOLLOW) {
      const battle = (f.ids.length === 2 ? this.battleNow(f.ids[0], f.ids[1], byId) : null) ?? this.battleWith(f.ids, byId);
      if (battle) {
        f.ids = [battle.ahead, battle.behind];
        subject = battle;
      } else {
        const alone = f.ids.map((id) => byId.get(id)).filter((c): c is TvCar => !!c && (c.running || c.inPit)).sort((a, b) => a.position - b.position)[0];
        if (alone) subject = { kind: 'car', id: alone.id };
      }
    }
    if (!subject) this.endFollow();
    return subject;
  }

  /** Lets go of the cars followed, remembering them so the next choice goes elsewhere when it can. */
  private endFollow(): void {
    if (!this.following) return;
    this.followedBefore.push({ ids: this.following.ids, until: this.clock });
    if (this.followedBefore.length > 8) this.followedBefore.shift();
    this.following = null;
  }

  /** Why a car followed on its own is on screen now. */
  private reasonFor(c: TvCar): ShotReason {
    return c.selected ? 'selected' : c.stopped ? 'pit' : c.pushing ? 'flying' : c.classPosition === 1 ? 'leader' : 'field';
  }

  /** The closest battle any of these cars is in with the car ahead of it or behind it (null when none is). */
  private battleWith(ids: number[], byId: Map<number, TvCar>): Battle | null {
    const at = new Map([...byId.values()].map((c) => [`${c.classIndex}:${c.classPosition}`, c]));
    let best: Battle | null = null;
    let gap = Infinity;
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      for (const other of [at.get(`${c.classIndex}:${c.classPosition - 1}`), at.get(`${c.classIndex}:${c.classPosition + 1}`)]) {
        const b = other && this.battleNow(c.id, other.id, byId);
        const rear = b && byId.get(b.behind)!;
        if (b && rear && rear.interval < gap) {
          best = b;
          gap = rear.interval;
        }
      }
    }
    return best;
  }

  /** Two cars as a battle, front first, while both run, next to each other in their class and close (null otherwise). */
  private battleNow(a: number, b: number, byId: Map<number, TvCar>): Battle | null {
    const x = byId.get(a);
    const y = byId.get(b);
    if (!x || !y || !x.running || !y.running || x.classIndex !== y.classIndex) return null;
    const [front, rear] = x.classPosition < y.classPosition ? [x, y] : [y, x];
    if (rear.classPosition !== front.classPosition + 1 || !(rear.interval <= BATTLE_OVER)) return null;
    return { kind: 'battle', ahead: front.id, behind: rear.id };
  }

  /**
   * Whether an event may take the screen from the cars followed: one of
   * their own, or a major one (an incident, a change of the race lead). A
   * pass elsewhere may not, and the car the viewer picked is left for
   * nothing but its own.
   */
  private cutsIn(e: TvEvent, follows: Subject | null, byId: Map<number, TvCar>): boolean {
    if (!follows) return true;
    const ids = subjectIds(follows);
    if (ids.includes(e.car) || (e.other !== undefined && ids.includes(e.other))) return true;
    if (ids.some((id) => byId.get(id)?.selected)) return false;
    // (Two cars going side by side take it from a car on its own, not from another battle.)
    if (e.kind === 'fight') return follows.kind === 'car';
    return e.kind !== 'overtake';
  }

  /**
   * The start, from the camera behind the grid, on the front of the field;
   * and, where the first corner has a camera of its own, that one next, from
   * a few seconds before the leaders get there.
   */
  private startShot(cars: readonly TvCar[], rate: number): TvShot | null {
    if (!this.byId.has('start')) return null;
    const front = cars.filter((c) => c.running).sort((a, b) => a.position - b.position).slice(0, START_GROUP);
    const ids = front.map((c) => c.id);
    if (!ids.length) return null;
    let hold = START_HOLD;
    if (this.byId.get('t1')?.station !== undefined) {
      // (Until the leader comes to the first corner: see `mustCut`.)
      hold = START_LONGEST;
      this.queue = [{ subject: { kind: 'group', ids }, camera: 't1', reason: 'start', start: 0, hold: FIRST_CORNER_HOLD }];
    }
    return { subject: { kind: 'group', ids }, camera: 'start', reason: 'start', start: this.clock, hold: Math.max(MIN_SHOT, hold / rate) };
  }

  /** Whether a car is in a camera's sight and within `seconds` (race time) of the station the camera was placed for. */
  private comesTo(cam: TvCamera, c: TvCar, seconds: number): boolean {
    if (cam.station === undefined || !cam.sees[Math.floor(mod(c.u, this.track.n))]) return false;
    return (mod(cam.station - c.u, this.track.n) * this.track.ds) / Math.max(20, c.speed) <= seconds;
  }

  /**
   * The next shot of a sequence, if it can still be shown: its cars as they
   * stand now, from now, and only with the first of them in its camera's
   * sight.
   */
  private queued(cars: readonly TvCar[], byId: Map<number, TvCar>, rate: number): TvShot | null {
    const next = this.queue.shift();
    const cam = next ? this.byId.get(next.camera) : undefined;
    if (!next || !cam || this.barred(next.camera)) return null;
    const subject: Subject = next.subject.kind === 'group'
      ? { kind: 'group', ids: cars.filter((c) => c.running).sort((a, b) => a.position - b.position).slice(0, next.subject.ids.length).map((c) => c.id) }
      : next.subject;
    const first = this.subjectCars(subject, byId).find((c) => c.running);
    if (!first || !cam.sees[Math.floor(mod(first.u, this.track.n))]) return null;
    return { ...next, subject, start: this.clock, hold: Math.max(MIN_SHOT, next.hold / rate) };
  }

  private subjectCars(sub: Subject, byId: Map<number, TvCar>): TvCar[] {
    return subjectIds(sub).map((id) => byId.get(id)).filter((c): c is TvCar => !!c);
  }

  private mustCut(s: TvShot, byId: Map<number, TvCar>, rate: number, raceTime: number, follows: Subject | null): boolean {
    const elapsed = this.clock - s.start;
    // Two cars side by side for a place keep the screen a while longer, and no replay cuts in on them.
    const fighting = s.subject.kind === 'battle' && !s.replay && this.sideBySide(s.subject, byId);
    if (elapsed >= s.hold + (fighting ? FIGHT_HOLD : 0)) return true;
    // A replay plays to its end.
    if (s.reason === 'replay') return false;
    // A replay that is ready comes as soon as the shot has had its moment (not an incident, the start or a stop).
    if (elapsed > MIN_SHOT && !fighting && s.reason !== 'incident' && s.reason !== 'start' && s.reason !== 'pit' && this.replayReady(rate, raceTime, follows, byId)) return true;
    const cars = this.subjectCars(s.subject, byId);
    if (cars.length === 0) return true;
    // Something major: an incident, the lead of the race changing hands off screen, or a restart; and, from a car
    // that is on screen for nothing in particular, two cars going side by side for a place.
    const idle = s.reason === 'field' || s.reason === 'leader';
    const incident = elapsed > MIN_SHOT && s.reason !== 'incident' && this.events.some((e) => e.at > s.start && this.cutsIn(e, follows, byId)
      && (e.kind === 'incident' || (e.kind === 'lead' && !this.shows(s.subject, [e.car])) || (e.kind === 'restart' && s.reason !== 'start') || (e.kind === 'finish' && !e.shown)
        || (e.kind === 'fight' && idle && !this.shows(s.subject, [e.car]))));
    // The start holds on the field as it gets away, until the leader comes to the first corner in its camera's
    // sight (or the back of the field leaves this camera's); the first corner after it, and the finish, for their time.
    if (s.reason === 'finish' || (s.reason === 'start' && s.camera === 't1')) return false;
    const corner = s.reason === 'start' && s.camera === 'start' && this.queue.length ? this.byId.get(this.queue[0].camera) : undefined;
    if (corner && elapsed > MIN_SHOT && this.comesTo(corner, cars[0], BEFORE_CORNER)) return true;
    if (s.reason !== 'start') {
      // An onboard camera goes with its car, the pit box camera until the car has pulled away (the camera over the
      // lane has it from there) or left the pit lane.
      const carrier = s.carrier === undefined ? null : byId.get(s.carrier);
      if (s.carrier !== undefined && !carrier) return true;
      if (carrier && isOnboard(s.camera) && !carrier.running) return true;
      if (carrier && s.camera === 'pitbox' && !carrier.inPit) return true;
      if (carrier && s.camera === 'pitbox' && !carrier.stopped && this.byId.has('pit')) {
        if (this.pitAway < 0) this.pitAway = this.clock;
        if (this.clock - this.pitAway >= PIT_AWAY) return true;
      }
      // A battle that has broken up, a car that has stopped running (an incident shot may linger on it).
      if (s.subject.kind === 'battle' && elapsed > MIN_SHOT && !this.battleNow(s.subject.ahead, s.subject.behind, byId)) return true;
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

  /**
   * What each place is worth to the viewer, as a function of the car that
   * holds it: 1 for the lead of the race, less for every place down its
   * class, and less for a class further down the road (the classes ranked by
   * where their best car is overall).
   */
  private stakes(cars: readonly TvCar[]): (c: TvCar) => number {
    const best = new Map<number, number>();
    for (const c of cars) best.set(c.classIndex, Math.min(best.get(c.classIndex) ?? Infinity, c.position));
    const order = [...best].sort((a, b) => a[1] - b[1]).map(([index]) => index);
    return (c) => PLACE_STEP ** Math.max(0, c.classPosition - 1) * CLASS_WEIGHT[Math.min(Math.max(0, order.indexOf(c.classIndex)), CLASS_WEIGHT.length - 1)];
  }

  private choose(cars: readonly TvCar[], byId: Map<number, TvCar>, rate: number, raceTime: number, follows: Subject | null): TvShot | null {
    const running = cars.filter((c) => c.running);
    if (running.length === 0 && cars.length === 0) return null;
    type Candidate = { subject: Subject; reason: ShotReason; score: number; event?: TvEvent; mark?: TvEvent };
    let cand: Candidate[] = [];
    const selected = cars.find((c) => c.selected);
    const stake = this.stakes(cars);
    // Battles: a car within a second of the one ahead in its class. What they fight for counts most, how close they are a little.
    const battles: Candidate[] = [];
    const byClassPos = new Map<string, TvCar>(running.map((c) => [`${c.classIndex}:${c.classPosition}`, c]));
    for (const c of running) {
      if (c.interval > BATTLE_GAP || c.classPosition <= 1) continue;
      const ahead = byClassPos.get(`${c.classIndex}:${c.classPosition - 1}`);
      if (!ahead) continue;
      // Side by side they are worth more than merely close.
      const side = c.beside === ahead.id || ahead.beside === c.id ? SIDE_BY_SIDE : 0;
      battles.push({ subject: { kind: 'battle', ahead: ahead.id, behind: c.id }, reason: 'battle', score: 20 + 80 * stake(ahead) + 10 * (1 - c.interval / BATTLE_GAP) + side });
    }
    if (selected) {
      // The viewer's car, in a battle when it is in one.
      const own = battles.find((b) => b.subject.kind === 'battle' && (b.subject.ahead === selected.id || b.subject.behind === selected.id));
      cand.push(own ? { ...own, score: 120 } : { subject: { kind: 'car', id: selected.id }, reason: 'selected', score: 110 });
    }
    cand.push(...battles);
    for (const e of this.events) {
      const c = byId.get(e.car);
      if (!c || !this.cutsIn(e, follows, byId)) continue;
      // A director cuts straight to trouble, and to a new leader of the race (with the car it passed while they are together).
      if (e.kind === 'incident') cand.push({ subject: { kind: 'car', id: e.car }, reason: 'incident', score: 100 });
      else if (e.kind === 'lead') cand.push({ subject: (e.other !== undefined ? this.battleNow(e.car, e.other, byId) : null) ?? { kind: 'car', id: e.car }, reason: 'overtake', score: 115 });
      else if (e.kind === 'restart') {
        // A restart: the front of the field, from the car that leads it.
        const front = running.filter((x) => x.position >= c.position).sort((a, b) => a.position - b.position).slice(0, RESTART_GROUP).map((x) => x.id);
        if (front.length > 1) cand.push({ subject: { kind: 'group', ids: front }, reason: 'start', score: 118 });
      } else if (e.kind === 'overtake') cand.push({ subject: { kind: 'car', id: e.car }, reason: 'overtake', score: 20 + 45 * stake(c) });
      // The leader to the flag, once.
      else if (e.kind === 'finish' && !e.shown && c.running) cand.push({ subject: { kind: 'car', id: e.car }, reason: 'finish', score: 130, mark: e });
      // (Two cars side by side are a battle, scored as one above; a penalty and a start have a replay and a shot of their own.)
    }
    // A replay of an overtake or incident a few seconds ago, one at a time.
    if (running.length && this.replayReady(rate, raceTime, follows, byId)) {
      for (const e of this.replays) {
        const age = raceTime - e.raceTime!;
        if (!(age >= REPLAY_FROM) || !this.cutsIn(e, follows, byId)) continue;
        const mine = !!selected && (e.car === selected.id || e.other === selected.id);
        // Both cars of a pass, of a contact and of the contact a penalty was given for.
        const subject: Subject = e.other !== undefined ? { kind: 'battle', ahead: e.car, behind: e.other } : { kind: 'car', id: e.car };
        cand.push({ subject, reason: 'replay', score: mine ? 125 : e.kind === 'lead' ? 112 : e.kind === 'incident' ? 108 : e.kind === 'penalty' ? 104 : 100, event: e });
      }
    }
    // Practice and qualifying: cars on a push lap, the quicker ones and the closing minutes most.
    for (const c of running) {
      if (c.pushing) cand.push({ subject: { kind: 'car', id: c.id }, reason: 'flying', score: 50 + Math.max(0, 12 - c.classPosition) * 2 + (c.pushing > 1 ? 25 : 0) });
    }
    // The leader (under a red flag, at the head of the queue in the pit lane).
    const leader = running.find((c) => c.position === 1) ?? running[0] ?? [...cars].filter((c) => c.inPit).sort((a, b) => a.position - b.position)[0];
    if (leader) cand.push({ subject: { kind: 'car', id: leader.id }, reason: 'leader', score: 42 });
    for (const c of running) if (c.classPosition === 1 && c !== leader) cand.push({ subject: { kind: 'car', id: c.id }, reason: 'leader', score: 32 });
    for (const c of cars) {
      if (!c.stopped) continue;
      const key = `${c.id}`;
      if (this.shownStops.has(key)) continue;
      cand.push({ subject: { kind: 'car', id: c.id }, reason: 'pit', score: 15 + 45 * stake(c) });
    }
    // Variety: anyone running, the front of the field rather than the back.
    for (let i = 0; i < 3 && running.length; i++) {
      const c = running[Math.floor(this.rng() * running.length)];
      cand.push({ subject: { kind: 'car', id: c.id }, reason: 'field', score: 14 + 14 * stake(c) + this.rng() * 10 });
    }
    // Less of the cars it has just been with, for a while (never less of the viewer's car, an incident or a replay).
    for (const c of cand) {
      if (c.reason !== 'selected' && c.reason !== 'incident' && c.reason !== 'replay' && !(selected && this.shows(c.subject, [selected.id]))) {
        let fresh = 1;
        for (const before of this.followedBefore) {
          if (this.shows(c.subject, before.ids)) fresh = Math.min(fresh, 1 - FATIGUE * Math.max(0, 1 - (this.clock - before.until) / FATIGUE_RECOVER));
        }
        c.score *= fresh;
      }
      c.score += this.rng() * 6;
    }
    // Following cars: them again (from another camera), unless something that may cut in is more important.
    if (follows) {
      const lead = this.events.filter((e) => e.kind === 'lead');
      const fights = this.events.filter((e) => e.kind === 'fight' && this.cutsIn(e, follows, byId));
      cand = cand.filter((c) => c.reason === 'incident' || c.reason === 'replay' || c.reason === 'start' || c.reason === 'finish' || (c.reason === 'overtake' && lead.some((e) => this.shows(c.subject, [e.car])))
        || (c.reason === 'battle' && fights.some((e) => this.shows(c.subject, [e.car]) && this.shows(c.subject, [e.other ?? e.car]))));
      const own = this.subjectCars(follows, byId);
      const reason = follows.kind === 'battle' || !own.length ? 'battle' : this.reasonFor(own[0]);
      cand.push({ subject: follows, reason, score: own.some((c) => c.selected) ? 120 : 90 });
    }
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand) {
      const shot = c.event ? this.replayShot(c.event, c.subject, byId) : this.frame(c.subject, c.reason, byId, rate);
      if (shot) {
        if (c.mark) c.mark.shown = true;
        if (c.reason === 'pit' && c.subject.kind === 'car') this.shownStops.add(`${c.subject.id}`);
        this.shownStops = new Set([...this.shownStops].filter((id) => byId.get(Number(id))?.inPit));
        this.follow(shot, cars, c.event);
        return shot;
      }
    }
    return null;
  }

  /**
   * After a cut: cars newly picked are followed from now. A replay, an
   * incident and the start are not: with cars being followed they are an
   * interruption (the time away from them does not count, see `update`),
   * and afterwards it goes back to them. A change of the race lead moves it
   * to the new leader for good, whether it is shown live or as its replay
   * (`event`).
   */
  private follow(shot: TvShot, cars: readonly TvCar[], event?: TvEvent): void {
    if (shot.subject.kind === 'group' || shot.reason === 'incident' || shot.reason === 'start' || shot.reason === 'finish' || (shot.reason === 'replay' && event?.kind !== 'lead')) return;
    const ids = subjectIds(shot.subject);
    if (this.following && this.shows(shot.subject, this.following.ids)) return;
    this.endFollow();
    this.following = { ids, since: this.clock, selected: cars.find((c) => c.selected)?.id ?? null };
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
    const incident = e.kind === 'incident' || e.kind === 'penalty';
    const before = incident ? REPLAY_BEFORE_INCIDENT : REPLAY_BEFORE;
    const after = incident ? REPLAY_AFTER_INCIDENT : REPLAY_AFTER;
    const replay = { from: e.raceTime! - before, to: e.raceTime! + after, speed: REPLAY_SPEED };
    const replayOf = incident ? 'contact' : 'overtake';
    const shot = (camera: string, carrier?: number): TvShot => ({ subject, camera, carrier, reason: 'replay', start: this.clock, hold: (before + after) / REPLAY_SPEED, replay, replayOf });
    const r = this.rng();
    if (!incident && e.other !== undefined && r < 0.35) return r < 0.2 ? shot('tcam', e.car) : shot('rear', e.other);
    // The stretch the cars covered during the replay, at about their speed now.
    const n = this.track.n;
    const speed = Math.max(20, byId.get(e.car)?.speed ?? 50);
    const k0 = Math.floor(mod(e.u! - (before * speed) / this.track.ds, n));
    const span = Math.ceil(((before + after) * speed) / this.track.ds);
    const last = this.recent[this.recent.length - 1]?.camera;
    // (From the other side of the road than it was last seen from, where a camera there sees about as much: the reverse angle.)
    const side = [...this.recent].reverse().map((r) => this.byId.get(r.camera)?.side).find((x) => x !== undefined);
    let best: { cam: TvCamera; seen: number; value: number } | null = null;
    for (const cam of this.cameras) {
      if (cam.id === last || !cam.sees[Math.floor(mod(e.u!, n))]) continue;
      let seen = 0;
      for (let i = 0; i < span; i++) seen += cam.sees[(k0 + i) % n];
      const value = seen + this.rng() * 3 + (side && cam.side && cam.side !== side ? span * 0.2 : 0);
      if (!best || value > best.value) best = { cam, seen, value };
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
    // A car in the pit lane and not in its box, from the camera over the lane.
    if (lead.inPit && !lead.stopped && reason !== 'incident' && this.byId.has('pit') && !this.barred('pit')) return { subject, camera: 'pit', reason, start: this.clock, hold: 5 };
    // The finish: until a few seconds after the line.
    const toLine = (mod(-lead.u, this.track.n) * this.track.ds) / Math.max(20, lead.speed) / Math.max(1e-6, rate);
    const hold = reason === 'start' ? Math.max(5, RESTART_HOLD / Math.max(1e-6, rate)) : reason === 'finish' ? Math.max(4, Math.min(14, toLine + AFTER_FLAG)) : 5 + this.rng() * 7;
    const last = this.recent[this.recent.length - 1];
    // The same cars as the shot before, from a trackside camera: a sequence.
    const before = last ? this.byId.get(last.camera) : undefined;
    const sequence = !!last && !!before && this.shows(subject, subjectIds(last.subject));
    // Now and then onboard, but never twice running and at most two in four shots.
    const chance = ONBOARD_CHANCE[reason] ?? 0;
    const onboardDue = chance > 0 && cars.every((c) => c.running) && !(last && isOnboard(last.camera))
      && this.recent.slice(-3).filter((r) => isOnboard(r.camera)).length < 2;
    // Now and then the helicopter, as a choice: not twice running, nor for the finish.
    const heliDue = !!last && last.camera !== 'heli' && reason !== 'finish' && this.recent.slice(-3).every((r) => r.camera !== 'heli') && this.rng() < HELI_CHANCE;
    let best: { cam: TvCamera; score: number; sight: number } | null = null;
    if (lead.running || lead.inPit) {
      for (const cam of this.cameras) {
        if (this.barred(cam.id)) continue;
        const sight = timeInSight(cam.sees, this.track, lead.u, lead.speed, 20) / Math.max(1e-6, rate);
        if (sight < MIN_IN_SIGHT) continue;
        // How long it keeps the car, and how good its picture of it is on the way.
        let score = Math.min(sight, 12) * 2 + 8 * this.picture(cam, lead.u, lead.speed, Math.min(sight * rate, 8));
        // The car comes towards the camera: its nearest station is still ahead.
        if (this.ahead(cam, lead.u)) score += 6;
        // In a sequence, from the same side of the road as the shot before.
        if (sequence && cam.side && before!.side) score += cam.side === before!.side ? SAME_SIDE : -SAME_SIDE;
        if (last && last.camera === cam.id) score -= 12;
        // (The finish, from one that sees the line.)
        if (reason === 'finish') score += cam.sees[0] ? 12 : -12;
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
    // (Where it is on because no camera beside the track can hold the car, for a shorter while: one soon can.)
    if (useHeli) return { subject, camera: 'heli', reason, start: this.clock, hold: best ? 6 + this.rng() * 5 : 4 + this.rng() * 2.5 };
    let time = Math.max(MIN_SHOT, Math.min(hold, best!.sight - 0.5));
    // A car that comes towards the camera is left a moment after it has passed: the next camera has it coming.
    const pass = this.passIn(best!.cam, lead.u, lead.speed) / Math.max(1e-6, rate);
    if (reason !== 'finish' && reason !== 'start' && pass >= 2 && pass + PAST_CAMERA < time) time = pass + PAST_CAMERA;
    return { subject, camera: best!.cam.id, reason, start: this.clock, hold: time };
  }

  /** How good a camera's picture of a car is over the next `seconds` of its way (0 to 1). */
  private picture(cam: TvCamera, u: number, speed: number, seconds: number): number {
    if (!cam.quality) return 0.5;
    const n = this.track.n;
    const k0 = Math.floor(mod(u, n));
    const count = Math.max(1, Math.min(n, Math.ceil((seconds * Math.max(1, speed)) / this.track.ds)));
    let sum = 0;
    for (let i = 0; i < count; i += 4) sum += cam.quality[(k0 + i) % n];
    return sum / (255 * Math.ceil(count / 4));
  }

  /** Race seconds until a car at u passes a camera (the station it sees nearest to it), while it has it in sight all the way; Infinity when it has passed or will be out of sight first. */
  private passIn(cam: TvCamera, u: number, speed: number): number {
    if (cam.closest === undefined) return Infinity;
    const n = this.track.n;
    const k0 = Math.floor(mod(u, n));
    const d = mod(cam.closest - k0, n);
    if (d > n / 2) return Infinity;
    for (let i = 0; i <= d; i += 3) if (!cam.sees[(k0 + i) % n]) return Infinity;
    return (d * this.track.ds) / Math.max(1, speed);
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
