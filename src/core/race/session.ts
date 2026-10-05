/**
 * Practice and qualifying sessions, run on the race simulation's track,
 * pit lane, weather and incidents. Cars start in their garages and go out
 * in runs: an out lap from the pit exit, push laps (and cool-down laps
 * between them), or a long run at race pace on race fuel, then an in lap
 * back to the garage. The order is by each car's best lap; out laps, in
 * laps and a lap cut short by a red flag do not count.
 *
 * Teams plan each run as their car comes back in: practice opens with an
 * installation run, then short runs on low fuel and, in a session meant for
 * it, a race simulation on a race compound; qualifying has a run or a few,
 * the last timed to start its final push lap just before the flag, as the
 * track is quickest then. A car on a slow lap waves a car on a push lap by,
 * which costs the pusher a moment, now and then more (a lap spoilt by
 * traffic).
 *
 * The session clock runs while the session is on and stops under a red
 * flag where the rules say so. When it runs out the chequered flag is
 * shown: a lap begun before it still counts, then every car comes in.
 * A crash or a car stopped on track brings the red flag: everyone returns
 * to the garage, the lap in progress is lost, and the session resumes once
 * the track is clear.
 */
import { formatLapTime } from '../calibration.ts';
import { seededRandom } from '../rng.ts';
import type { RaceSetup, SessionSpec } from './setup.ts';
import { DT, type Gap, type LapKind, type RaceCar, RaceSim, type Service, mod } from './sim.ts';
import { compoundOfType } from './strategy.ts';
import { bestTyreType, wetnessAhead } from './weather.ts';

/** A run from the garage: the tyres and fuel, and the laps after the out lap. */
export interface Run {
  kind: 'install' | 'short' | 'long' | 'quali';
  compound: number;
  fuel: number;
  laps: LapKind[];
}

/** Where a car is in a session. */
export interface CarSession {
  /** The lap the car is on, or 'garage'. */
  phase: LapKind | 'garage';
  run: Run | null;
  /** Index into run.laps of the lap being driven (-1 on the out lap). */
  lap: number;
  /** Runs started so far. */
  runs: number;
  /** Session clock time to leave the garage next, or null when its session is over. */
  leaveAt: number | null;
  /** The lap in progress began at the line on track, so it can be timed. */
  fromLine: boolean;
  /** Session clock time the best lap was set. */
  bestAt: number;
  /** Done for the session: taken the flag, or out of it. */
  done: boolean;
  /** Laps seen per compound at race pace (long runs count fully, other timed laps a quarter), for what the team learns about tyre wear. */
  seen: number[];
}

/** A car's result in a session. */
export interface SessionEntry {
  car: number;
  /** Best lap, or null for no time. */
  time: number | null;
  laps: number;
  /** Out of it: retired in the session. */
  retired: boolean;
}

/** Lap-time factors for the slow laps of a run, and for an out lap in qualifying (tyres brought up to temperature, a gap found). */
const OUT_LAP = 1.15;
const OUT_LAP_QUALI = 1.3;
const COOL_LAP = 1.28;
const IN_LAP = 1.2;
/** Share of race pace given away on a practice push lap (engine modes, a cautious first go). */
const PRACTICE_PUSH = 0.5;
/** Incident risk per kind of lap, against a race lap. */
const RISK: Record<LapKind, number> = { out: 0, push: 1.4, cool: 0.2, long: 1, in: 0.15 };
/** Chance that a crash, or a car stopped on track, brings out the red flag. */
const RED_CRASH = 0.85;
const RED_STOPPED = 0.6;
/** Seconds of session time a red flag lasts: clearing the track. */
const RED_MIN = 240;
const RED_MAX = 720;
/** A car on a slow lap waves a pusher by when it is this close behind (seconds), costing it this much (and now and then a spoilt lap). */
const YIELD_GAP = 0.6;
const YIELD_LOSS = 0.15;
const IMPEDED = 0.08;
/** Seconds to push a car back into its garage, or out of it. */
const GARAGE_TIME = 2.5;

export class SessionSim extends RaceSim {
  readonly spec: SessionSpec;
  /** Session time run, seconds: stops while a red flag stops the clock. */
  clock = 0;
  private readonly state = new Map<number, CarSession>();
  private readonly takingPart: Set<number>;
  private readonly planRng: () => number;
  /** Pairs that met on track already (pusher:slow car), so a car waves another by once per lap. */
  private waved = new Set<string>();
  /**
   * Per class: the qualifying lap from the analysis over the race lap with
   * the wing open in every DRS zone, so a push lap matches the calibrated
   * qualifying lap.
   */
  private readonly pushScale: number[];

  constructor(setup: RaceSetup) {
    super(setup);
    if (!setup.session) throw new Error('A session needs its spec.');
    this.spec = setup.session;
    this.sharedBoxes = false;
    this.takingPart = new Set(this.spec.cars);
    this.pushScale = this.classes.map((c) => {
      const m = c.model;
      let lap = 0;
      for (let k = 0; k < m.n; k++) lap += m.seg[k] * (m.drsRatio && c.rules.drs ? m.drsRatio[k] : 1);
      return m.qualifyingTime / lap;
    });
    this.planRng = seededRandom(`${setup.settings.seed}:${this.spec.name}:plan`);
    const pit = this.model.pit;
    for (const car of this.cars) {
      if (!this.takingPart.has(car.id) || !pit) {
        // Not in this session (or nowhere to start from): off the map.
        car.status = 'finished';
        continue;
      }
      const driver = this.spec.drivers?.[car.id];
      if (driver !== undefined && driver < car.entrant.drivers.length) car.driverIndex = driver;
      const box = this.boxFor(car);
      car.status = 'pit';
      car.garage = car.prevGarage = 1;
      car.pit = {
        p: box, prevP: box, box, uEntry: pit.entry - this.n, stopped: true, stoppedUntil: Infinity, stopStart: -10, done: false,
        service: { compound: null, fuel: 0, time: Infinity, reason: 'garage', driver: null },
        record: { car: car.id, lap: 0, entry: 0, exit: NaN, stationary: NaN, from: car.compound, to: null, fuel: 0, driver: null, reason: 'garage' },
      };
      car.u = car.prevU = pit.entry - this.n + (box / pit.length) * pit.span;
      car.accruedU = car.u;
      car.fuel = car.cls.qualiFuel;
      const s: CarSession = { phase: 'garage', run: null, lap: -1, runs: 0, leaveAt: null, fromLine: false, bestAt: Infinity, done: false, seen: car.rules.tyres.compounds.map(() => 0) };
      this.state.set(car.id, s);
      this.planNext(car, s);
    }
    this.order = this.cars.filter((c) => this.takingPart.has(c.id));
    this.updateOrder();
  }

  /** The car's state in the session (undefined for a car not in it). */
  of(car: RaceCar): CarSession | undefined {
    return this.state.get(car.id);
  }

  /** Cars taking part. */
  get entries(): RaceCar[] {
    return this.cars.filter((c) => this.takingPart.has(c.id));
  }

  /** Session time left, seconds. */
  get timeLeft(): number {
    return Math.max(0, this.spec.duration - this.clock);
  }

  /** The classification: best lap first, then cars without a time. */
  results(): SessionEntry[] {
    return this.order.map((c) => ({ car: c.id, time: c.bestLap, laps: c.history.filter((h) => h.kind === 'push' || h.kind === 'cool' || h.kind === 'long').length, retired: c.status === 'retired' }));
  }

  /** Laps seen per compound by each car (entrant index), for what the team learns. */
  seen(): Map<number, number[]> {
    return new Map([...this.state].map(([id, s]) => [id, s.seen]));
  }

  override step(): void {
    if (this.finished) return;
    const t = this.t;
    // The session clock, and the flag when it runs out.
    if (!this.red || !this.spec.clockStops) this.clock += DT;
    if (!this.chequered && this.clock >= this.spec.duration) {
      this.chequered = true;
      this.log('chequered', t, `Chequered flag: end of ${this.spec.name}`, -1);
      for (const s of this.state.values()) s.leaveAt = null;
    }
    if (this.red && t >= this.red.resumeAt) this.resume(t);
    for (const car of this.cars) {
      const s = this.state.get(car.id);
      if (!s) continue;
      car.prevGarage = car.garage;
      const ps = car.pit;
      if (car.status === 'pit' && ps?.stopped) {
        // Waiting in the garage: out when the plan says (and the pit exit is open).
        const wait = s.leaveAt === null || this.red ? Infinity : Math.max(0, s.leaveAt - this.clock);
        ps.stoppedUntil = t + wait;
        car.garage = clamp01(Math.min((t - ps.stopStart - 1) / GARAGE_TIME, wait / GARAGE_TIME));
      } else {
        car.garage = 0;
      }
    }
    this.waveBy();
    super.step();
  }

  // ---- hooks into the race simulation --------------------------------------------

  protected override checkFinished(): void {
    if (!this.chequered) return;
    const home = this.entries.every((c) => c.status === 'retired' || (c.status === 'pit' && !!c.pit?.stopped));
    // Safety net: a car that cannot get home ends it too.
    if (home || this.clock > this.spec.duration + 3 * this.model.lapTime + 300) this.finished = true;
  }

  protected override lapKind(car: RaceCar): LapKind | undefined {
    const s = this.state.get(car.id);
    // A lap ending in the pit lane is an in lap, whatever came of it.
    if (!s || s.phase === 'garage' || car.status !== 'running') return 'in';
    // A lap that did not start at the line on track (from the pit lane) or was cut short is not timed.
    if (!s.fromLine && s.phase !== 'out') return 'in';
    return s.phase;
  }

  protected override timedSector(car: RaceCar): boolean {
    const s = this.state.get(car.id);
    return !!s && s.fromLine && (s.phase === 'push' || s.phase === 'long' || s.phase === 'cool');
  }

  protected override fastestLap(car: RaceCar, time: number, lap: number, beaten: boolean, t: number): void {
    void beaten;
    const cls = this.multiClass ? ` in ${car.cls.label}` : '';
    this.log('fastest', t, `${car.entrant.code} goes fastest${cls}: ${formatLapTime(time)}`, car.id, lap);
  }

  protected override afterLap(car: RaceCar, lap: number, t: number): boolean {
    void lap;
    const s = this.state.get(car.id)!;
    const done = s.phase;
    if (s.fromLine && car.lastLap !== null && car.history[car.history.length - 1]?.kind === done) {
      if (done === 'long') s.seen[car.compound] += 1;
      else if (done === 'push') s.seen[car.compound] += 0.25;
      if (car.bestLap === car.lastLap && (done === 'push' || done === 'long' || done === 'cool')) s.bestAt = this.clock;
    }
    // The line crossed in the pit lane (on the way out of the garage or in): the run goes on as it was.
    if (car.status !== 'running') {
      this.startLap(car, t);
      return false;
    }
    s.fromLine = true;
    if (this.chequered) {
      // Past the flag: home.
      s.done = true;
      s.leaveAt = null;
      this.goIn(car, s, 'chequered');
    } else if (s.phase === 'in' || s.phase === 'garage') {
      // Already on the way in.
    } else {
      s.lap++;
      const next = s.run && s.lap < s.run.laps.length ? s.run.laps[s.lap] : null;
      if (next) s.phase = next;
      else this.goIn(car, s, 'end of run');
    }
    this.startLap(car, t);
    return false;
  }

  protected override decide(car: RaceCar, t: number): void {
    void t;
    const s = this.state.get(car.id);
    if (!s || car.pitRequest || s.phase === 'in') return;
    // Caught out by rain on slicks, or the reverse: in for the right tyres.
    const want = bestTyreType(wetnessAhead(this.weather, this.t, this.t + this.model.lapTime), car.cls.types);
    if (want !== car.tyreType && (want !== 'slick' || this.wetness > 0.25)) this.goIn(car, s, 'tyres');
  }

  /** In this lap: the rest of it is an in lap. */
  private goIn(car: RaceCar, s: CarSession, reason: string): void {
    s.phase = 'in';
    car.pitRequest = reason;
    car.lapPace = this.lapPaceFor(car);
  }

  protected override boxFor(car: RaceCar): number {
    // A garage per car, in entry order along the boxes.
    const pit = car.model.pit!;
    const i = this.spec.cars.indexOf(car.id);
    return pit.boxFrom + ((i + 0.5) / Math.max(1, this.spec.cars.length)) * (pit.boxTo - pit.boxFrom);
  }

  protected override planService(car: RaceCar, reason: string): Service {
    // Into the garage: the next run (tyres and fuel) is set up while it waits.
    const s = this.state.get(car.id)!;
    s.phase = 'garage';
    s.run = null;
    this.planNext(car, s);
    return { compound: null, fuel: 0, time: Infinity, reason, driver: null };
  }

  protected override enterPit(car: RaceCar, u: number, t: number): void {
    super.enterPit(car, u, t);
    // Garage visits are not pit stops.
    this.stops.pop();
  }

  protected override finishService(car: RaceCar, t: number): void {
    // Out of the garage on the run's tyres and fuel.
    const s = this.state.get(car.id)!;
    const run = s.run!;
    const ps = car.pit!;
    ps.record.stationary = t - ps.stopStart;
    car.pitRequest = null;
    if (run.compound !== car.compound || car.wear > 0.3) {
      car.compound = run.compound;
      car.tyreType = car.rules.tyres.compounds[run.compound].type;
      car.wear = 0;
      car.tyreLaps = 0;
      car.used |= 1 << run.compound;
    }
    car.fuel = run.fuel;
    car.burn = 1;
    s.phase = 'out';
    s.lap = -1;
    s.runs++;
    s.fromLine = false;
    car.lapStart = t;
    car.sectorStart = t;
    car.sectors = [null, null, null];
    this.startLap(car, t);
  }

  protected override paceLoss(car: RaceCar): number {
    const s = this.state.get(car.id);
    if (!s) return 0;
    if (s.phase === 'long') return car.rules.pace.race;
    if (s.phase === 'push') return this.spec.kind === 'qualifying' ? 0 : car.rules.pace.race * PRACTICE_PUSH;
    return 0;
  }

  protected override lapFactor(car: RaceCar): number {
    const s = this.state.get(car.id);
    if (!s) return 1;
    if (s.phase === 'push') return this.pushScale[car.cls.index];
    if (s.phase === 'out') return this.spec.kind === 'qualifying' ? OUT_LAP_QUALI : OUT_LAP;
    if (s.phase === 'cool') return COOL_LAP;
    if (s.phase === 'in' || s.phase === 'garage') return IN_LAP;
    return 1;
  }

  protected override incidentRisk(car: RaceCar): number {
    const s = this.state.get(car.id);
    return !s || s.phase === 'garage' ? 0 : RISK[s.phase];
  }

  protected override drsAllowed(car: RaceCar, gap: number): boolean {
    // Free to use in practice and qualifying (from the out lap on: the zone may run across the line).
    void car;
    void gap;
    return true;
  }

  protected override yields(def: RaceCar, car: RaceCar): boolean {
    // Nobody races for position in a session: a car caught by a quicker one lets it by.
    void def;
    void car;
    return true;
  }

  protected override makesWay(def: RaceCar, car: RaceCar): boolean {
    // A car on a slow lap moves over for one on a push lap as it comes up, before it is held up.
    return slow(this.state.get(def.id)) && !slow(this.state.get(car.id));
  }

  protected override passed(car: RaceCar, def: RaceCar): void {
    // Passing in a session is traffic, not news.
    void car;
    void def;
  }

  protected override trackIncident(u: number, kind: 'off' | 'contact' | 'parked' | 'stopped' | 'crash', t: number, car?: RaceCar): void {
    const rnd = this.controlRng;
    if (kind === 'off' || kind === 'contact' || kind === 'parked') {
      this.addYellow(u, false, 20 + 25 * rnd(), t);
      return;
    }
    this.addYellow(u, true, 60 + 120 * rnd(), t);
    if (this.chequered || this.red) return;
    if (rnd() < (kind === 'crash' ? RED_CRASH : RED_STOPPED)) {
      this.stopSession(t, RED_MIN + (RED_MAX - RED_MIN) * rnd(), `${kind === 'crash' ? 'crash' : 'stopped car'}${this.where(u)}`);
      if (car) this.penalise(car, t);
    }
  }

  // ---- order and gaps ------------------------------------------------------------

  protected override updateOrder(): void {
    const time = (c: RaceCar) => c.bestLap ?? Infinity;
    this.order.sort((a, b) => time(a) - time(b) || (this.state.get(a.id)?.bestAt ?? 0) - (this.state.get(b.id)?.bestAt ?? 0)
      || (a.status === 'retired' ? 1 : 0) - (b.status === 'retired' ? 1 : 0) || a.entrant.number - b.entrant.number);
    this.order.forEach((c, i) => { c.position = i + 1; });
    this.updateClassOrder();
  }

  override gap(car: RaceCar): Gap {
    return bestGap(car, this.order[0]);
  }

  override interval(car: RaceCar): Gap {
    return bestGap(car, this.order[this.order.indexOf(car) - 1]);
  }

  override classGap(car: RaceCar): Gap {
    return bestGap(car, car.cls.order[0]);
  }

  override classInterval(car: RaceCar): Gap {
    return bestGap(car, car.cls.order[car.cls.order.indexOf(car) - 1]);
  }

  // ---- red flag ------------------------------------------------------------------

  /** Stops the session with a red flag: everyone back to the garage, the lap in progress lost. */
  stopSession(t: number, duration: number, reason: string): void {
    if (this.red) return;
    this.red = { from: t, resumeAt: t + duration, reason, order: [], rain: false, lap: 0 };
    this.phase = 'red';
    this.phaseSince = t;
    this.log('flag', t, `Red flag: ${reason}`, -1);
    for (const car of this.entries) {
      const s = this.state.get(car.id)!;
      if (car.status === 'running') {
        s.fromLine = false;
        this.goIn(car, s, 'red flag');
      }
    }
  }

  /** Qualifying: the car that brought out the red flag loses lap times, as the series' rules say. */
  private penalise(car: RaceCar, t: number): void {
    const rule = car.rules.weekend.redFlag.qualifyingPenalty;
    if (this.spec.kind !== 'qualifying' || rule === 'none' || car.bestLap === null) return;
    const timed = car.history.filter((h) => h.kind === 'push' || h.kind === 'cool' || h.kind === 'long').map((h) => h.time).sort((a, b) => a - b);
    const drop = rule === 'all' ? timed.length : rule === 'best2' ? 2 : 1;
    const left = timed.slice(drop);
    car.bestLap = left.length ? left[0] : null;
    if (car.bestLap === null) this.state.get(car.id)!.bestAt = Infinity;
    this.log('flag', t, `${car.entrant.code} loses ${rule === 'all' ? 'all its lap times' : rule === 'best2' ? 'its two best laps' : 'its best lap'} for bringing out the red flag`, car.id);
  }

  /** The track is clear: the pit exit opens again, and every team plans its next run in the time left. */
  private resume(t: number): void {
    this.red = null;
    this.phase = 'green';
    this.log('flag', t, `Green light: ${this.spec.name} resumes${this.chequered ? '' : `, ${clockText(this.timeLeft)} left`}`, -1);
    for (const car of this.entries) {
      const s = this.state.get(car.id)!;
      if (car.status === 'pit' && !s.done && !this.chequered) this.planNext(car, s);
    }
  }

  // ---- run plans -----------------------------------------------------------------

  /** The car's next run and when it leaves, or nothing more this session. */
  private planNext(car: RaceCar, s: CarSession): void {
    s.run = null;
    s.leaveAt = null;
    if (s.done || this.chequered || car.status === 'retired') return;
    const plan = this.spec.kind === 'qualifying' ? this.qualifyingRun(car, s) : this.practiceRun(car, s);
    if (!plan) return;
    s.run = plan.run;
    s.leaveAt = plan.leaveAt;
  }

  /** An out lap and a push lap or two for qualifying, timed to finish just before the flag. */
  private qualifyingRun(car: RaceCar, s: CarSession): { run: Run; leaveAt: number } | null {
    const rnd = this.planRng;
    const S = this.spec.duration;
    const lap = this.lapEstimate(car);
    const outLap = lap * OUT_LAP_QUALI + 20;
    const runs = S >= 25 * 60 ? 3 : S >= 12 * 60 ? 2 : 1;
    const left = S - this.clock;
    // Too late to start a push lap before the flag.
    if (left < outLap * 0.8) return null;
    // Comfortably through to the next stage already: save a set of tyres.
    const advance = this.spec.advance;
    if (advance !== undefined && s.runs >= 1 && car.bestLap !== null && car.classPosition <= advance - 3 && rnd() < 0.6) return null;
    const final = s.runs >= runs - 1 || left < outLap + lap * 2.5;
    const pushes = runs === 1 ? 3 : rnd() < 0.35 ? 2 : 1;
    const laps: LapKind[] = pushes === 3 ? ['push', 'push', 'push'] : pushes === 2 ? ['push', 'cool', 'push'] : ['push'];
    const runTime = outLap + laps.length * lap;
    let leaveAt: number;
    if (final) {
      // The last run: out so that the last push lap begins with a little time in hand.
      leaveAt = S - runTime + lap * (laps.length > 1 ? 0.6 : 0.2) - (10 + 50 * rnd());
    } else {
      // An early banker, spread over the first part of the session.
      const slot = s.runs / runs;
      leaveAt = this.clock + 30 + (S * slot * 0.6 + 60) * rnd();
    }
    leaveAt = Math.max(this.clock + (s.runs ? 120 : 0), Math.min(leaveAt, S - outLap * 0.85));
    // Fuel for the out lap, the push laps and the in lap: the light car the qualifying lap assumes.
    return { run: { kind: 'quali', compound: this.quickest(car), fuel: car.cls.qualiFuel + car.model.fuelPerLap * (laps.length - 1), laps }, leaveAt };
  }

  /** Practice: an installation run, short runs on low fuel, and a race simulation where the session is meant for it. */
  private practiceRun(car: RaceCar, s: CarSession): { run: Run; leaveAt: number } | null {
    const rnd = this.planRng;
    const S = this.spec.duration;
    const lap = this.lapEstimate(car);
    const left = S - this.clock;
    if (left < lap * 1.6) return null;
    const m = car.model;
    const wet = wetnessAhead(this.weather, this.t, this.t + 600) > 0.3;
    // A while in the garage between runs (longer when it is wet: nobody hurries out in the rain).
    const wait = s.runs === 0 ? 30 + 300 * rnd() : (180 + 420 * rnd()) * (wet ? 2 : 1);
    const leaveAt = this.clock + wait;
    if (leaveAt > S - lap * 1.5) return null;
    const tyres = this.forConditions(car);
    if (s.runs === 0) return { run: { kind: 'install', compound: tyres ?? this.raceCompound(car, s), fuel: car.cls.qualiFuel + m.fuelPerLap * 4, laps: ['push'] }, leaveAt };
    const roomLaps = Math.floor((S - leaveAt) / lap) - 2;
    const longDone = s.seen.some((x) => x >= 6);
    if (this.spec.longRuns && !longDone && !tyres && roomLaps >= 8 && (this.clock > S * 0.4 || rnd() < 0.25)) {
      const laps = Math.min(roomLaps, 8 + Math.floor(rnd() * 8));
      const fuel = Math.min(car.rules.fuel.capacity, car.cls.qualiFuel + (laps + 1) * m.fuelPerLap + 0.3 * car.rules.fuel.capacity);
      return { run: { kind: 'long', compound: this.raceCompound(car, s), fuel, laps: Array<LapKind>(laps).fill('long') }, leaveAt };
    }
    const pushes = Math.max(1, Math.min(roomLaps, 2 + Math.floor(rnd() * 3)));
    const laps: LapKind[] = [];
    for (let i = 0; i < pushes; i++) laps.push(...(i ? ['cool', 'push'] as LapKind[] : ['push'] as LapKind[]));
    const compound = tyres ?? (rnd() < 0.5 ? this.quickest(car) : this.raceCompound(car, s));
    return { run: { kind: 'short', compound, fuel: car.cls.qualiFuel + m.fuelPerLap * (laps.length + 2), laps }, leaveAt };
  }

  /** Wet-weather tyres when the track calls for them, else null. */
  private forConditions(car: RaceCar): number | null {
    const type = bestTyreType(wetnessAhead(this.weather, this.t, this.t + 2 * this.model.lapTime), car.cls.types);
    return type === 'slick' ? null : compoundOfType(car.rules, type);
  }

  /** The quickest tyre for the conditions: the softest slick in the dry. */
  private quickest(car: RaceCar): number {
    const wet = this.forConditions(car);
    if (wet !== null) return wet;
    const c = car.rules.tyres.compounds;
    let best = -1;
    for (let i = 0; i < c.length; i++) if (c[i].type === 'slick' && (best < 0 || c[i].offset < c[best].offset)) best = i;
    return best;
  }

  /** A compound to learn about for the race: the slicks in turn, team-mates on different ones. */
  private raceCompound(car: RaceCar, s: CarSession): number {
    const c = car.rules.tyres.compounds;
    const slicks = c.map((_, i) => i).filter((i) => c[i].type === 'slick');
    return slicks[(car.entrant.index + s.runs) % slicks.length];
  }

  /** A lap at the car's push pace on the track now, for planning. */
  private lapEstimate(car: RaceCar): number {
    const m = car.model;
    return m.lapTime * (1 + car.entrant.carPace + car.driver.pace) * (1 + car.rules.weekend.evolution * (1 - this.rubber));
  }

  /**
   * A car on a slow lap waves a pushing car by once it is close behind: the
   * pusher goes by (losing a moment, now and then more), the slow car lifts.
   */
  private waveBy(): void {
    // In lanes the slow car moves over and the pusher drives by (makesWay).
    if (this.lanes) return;
    const n = this.n;
    const running = this.cars.filter((c) => c.status === 'running');
    for (const car of running) {
      const s = this.state.get(car.id);
      if (!s || slow(s) || car.passing) continue;
      for (const def of running) {
        if (def === car || def.passing) continue;
        const d = slow(this.state.get(def.id)) ? mod(def.u - car.u, n) * this.ds : Infinity;
        if (!(d < Math.max(car.v, 20) * YIELD_GAP)) continue;
        const key = `${car.id}:${def.id}:${car.lapsDone}`;
        if (this.waved.has(key)) continue;
        this.waved.add(key);
        car.passing = { target: def, untilU: car.u + 250 / this.ds };
        def.delay += 0.4;
        def.delayShare = Math.max(def.delayShare, 0.5);
        car.delay += YIELD_LOSS + (car.rng() < IMPEDED ? 0.4 + 1.2 * car.rng() : 0);
        car.delayShare = Math.max(car.delayShare, 0.3);
      }
    }
    if (this.waved.size > 2000) this.waved.clear();
  }
}

/** A car on an out lap, a cool-down lap or an in lap (or in the garage). */
function slow(s: CarSession | undefined): boolean {
  return !s || s.phase === 'out' || s.phase === 'cool' || s.phase === 'in' || s.phase === 'garage';
}

/** Gap between two cars' best laps. */
function bestGap(car: RaceCar, ref: RaceCar | undefined): Gap {
  if (!ref || ref === car) return { kind: 'leader', value: 0 };
  if (car.bestLap === null || ref.bestLap === null) return { kind: 'none', value: 0 };
  return { kind: 'time', value: Math.max(0, car.bestLap - ref.bestLap) };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** "12:03" */
function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
