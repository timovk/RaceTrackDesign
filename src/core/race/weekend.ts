/**
 * A race weekend: the practice sessions and qualifying stages before the
 * race, run in order on one field, each series to its own format (see the
 * weekend group in data/racing.json).
 *
 * Practice is shared by every class, to the schedule of the fastest;
 * qualifying runs class by class, the slowest first, stage after stage, each
 * stage taking its cars from the results so far. The grid comes from the
 * last stage a car ran in, later stages in front (groups that ran side by
 * side take their places in turn), or from the mean of its best laps where
 * the series averages its drivers' times.
 *
 * The weekend carries over what the track and the teams learn: rubber laid
 * down lap by lap, a little of it lost between sessions and more overnight
 * or to rain, and each team's knowledge of tyre wear, which starts as a
 * guess and comes close to the truth with laps on race fuel in practice.
 * A weekend that skips practice brings a green track and rough strategies.
 */
import { gauss } from './field.ts';
import type { RaceModel } from './model.ts';
import { type RaceField, type RaceSettings, type RaceSetup, type QualifyingEntry, type SessionSpec, type WeekendOutcome, createField, createRaceSetup, runQualifying } from './setup.ts';
import { type SessionEntry, SessionSim } from './session.ts';
import type { QualifyingStage, StageSource } from './rules.ts';
import { seededRandom } from '../rng.ts';
import { buildWeather } from './weather.ts';

export interface WeekendSession {
  /** "p1", "q:hypercar:Hyperpole", "race": also seeds the session. */
  id: string;
  kind: 'practice' | 'qualifying' | 'race';
  /** "FP2", "Q3", "HYP Hyperpole" (a class label in a multi-class weekend). */
  name: string;
  day: number;
  minutes: number;
  /** Qualifying: the class (index into the field's classes) and the stage of its format. */
  stage?: { cls: number; index: number };
  longRuns?: boolean;
}

/** Rubber on a track no one has driven on this weekend (what support races leave). */
export const RUBBER_START = 0.25;
/** Share of the rubber kept from one session to the next on the same day, and overnight. */
const KEEP_SAME_DAY = 0.92;
const KEEP_OVERNIGHT = 0.7;
/** How far off a team's guess of tyre wear is with no laps to go on (standard deviation), and the laps at race pace over which it shrinks (by the square root of 1 + laps / GUESS_LAPS). */
const GUESS_ERROR = 0.2;
const GUESS_LAPS = 3;

export class Weekend {
  readonly settings: RaceSettings;
  readonly field: RaceField;
  readonly models: RaceModel[];
  readonly sessions: WeekendSession[];
  /** Sessions not run, by id ('qualifying' skips every stage). */
  readonly skip: Set<string>;
  /** Results of the sessions run, by id. */
  readonly results = new Map<string, SessionEntry[]>();
  /** Rubber on the racing line now. */
  rubber = RUBBER_START;
  /** Laps each team has seen per compound at race pace, by team index. */
  private readonly seen = new Map<number, number[]>();
  /** The session the rubber was last carried from. */
  private last: WeekendSession | null = null;

  constructor(models: RaceModel | readonly RaceModel[], settings: RaceSettings, skip: readonly string[] = []) {
    this.settings = settings;
    this.field = createField(models, settings);
    this.models = this.field.classes.map((c) => c.model);
    this.skip = new Set(skip);
    const lead = this.models[0].rules.weekend;
    const multi = this.models.length > 1;
    const sessions: WeekendSession[] = lead.practice.map((p, i) => ({
      id: `p${i + 1}`, kind: 'practice', name: p.name, day: p.day, minutes: p.minutes, longRuns: p.longRuns,
    }));
    // Qualifying class by class, the slowest first.
    for (let ci = this.models.length - 1; ci >= 0; ci--) {
      const m = this.models[ci];
      m.rules.weekend.qualifying.forEach((stage, index) => sessions.push({
        id: `q:${m.vehicle.id}:${stage.name}`, kind: 'qualifying', name: multi ? `${m.rules.label} ${stage.name}` : stage.name,
        day: lead.qualifyingDay, minutes: stage.minutes, stage: { cls: ci, index },
      }));
    }
    sessions.push({ id: 'race', kind: 'race', name: 'Race', day: lead.qualifyingDay + 1, minutes: 0 });
    this.sessions = sessions;
  }

  /** Whether a session is skipped. */
  skipped(s: WeekendSession): boolean {
    return s.kind === 'practice' ? this.skip.has(s.id) : s.kind === 'qualifying' ? this.skip.has('qualifying') : false;
  }

  /** The sessions to run before the race, in order. */
  get toRun(): WeekendSession[] {
    return this.sessions.filter((s) => s.kind !== 'race' && !this.skipped(s));
  }

  /**
   * The simulation of a practice or qualifying session, from the weekend so
   * far; null for a qualifying stage no car takes part in.
   */
  sessionSim(s: WeekendSession): SessionSim | null {
    const setup = this.sessionSetup(s);
    return setup ? new SessionSim(setup) : null;
  }

  private sessionSetup(s: WeekendSession): RaceSetup | null {
    const cars = s.kind === 'practice' ? this.field.entrants.map((e) => e.index) : this.stageCars(s);
    if (!cars.length) return null;
    const lead = this.models[0];
    const red = (s.stage ? this.models[s.stage.cls] : lead).rules.weekend.redFlag;
    const spec: SessionSpec = {
      kind: s.kind === 'practice' ? 'practice' : 'qualifying',
      name: s.name,
      duration: s.minutes * 60,
      cars,
      clockStops: s.kind === 'practice' ? red.sessionClockStops.practice : red.sessionClockStops.qualifying,
      longRuns: s.longRuns,
      advance: s.stage ? this.advancing(s) : undefined,
    };
    const stage = s.stage ? this.stageOf(s) : null;
    if (stage?.driver !== undefined) {
      spec.drivers = {};
      for (const id of cars) spec.drivers[id] = Math.min(stage.driver, this.field.entrants[id].drivers.length - 1);
    }
    return {
      models: this.models, model: lead, settings: this.settings, entrants: this.field.entrants, qualifying: [], grid: [],
      laps: null, duration: spec.duration, timeLimit: null,
      weather: buildWeather(this.settings.weather, `${this.settings.seed}:${s.id}`, spec.duration * 1.3),
      session: spec,
      rubber: this.carried(s),
    };
  }

  /** The rubber at the start of a session: what is left from the one before (less overnight; all of it between the stages of qualifying, minutes apart). */
  private carried(s: WeekendSession): number {
    const last = this.last;
    if (!last) return this.rubber;
    if (s.day > last.day) return this.rubber * KEEP_OVERNIGHT;
    return last.kind === 'qualifying' && s.kind === 'qualifying' ? this.rubber : this.rubber * KEEP_SAME_DAY;
  }

  /** Records a finished session: its result, the rubber it left, and the laps each team saw on each compound. */
  complete(s: WeekendSession, sim: SessionSim | null): void {
    if (!sim) {
      this.results.set(s.id, []);
      return;
    }
    this.results.set(s.id, sim.results());
    this.rubber = sim.rubber;
    this.last = s;
    for (const [id, laps] of sim.seen()) {
      const team = this.field.entrants[id].teamIndex;
      const sum = this.seen.get(team) ?? laps.map(() => 0);
      laps.forEach((n, c) => { sum[c] += n; });
      this.seen.set(team, sum);
    }
  }

  /** Runs a session to the end at once. */
  runSession(s: WeekendSession): SessionSim | null {
    const sim = this.sessionSim(s);
    if (sim) while (!sim.finished) sim.step();
    this.complete(s, sim);
    return sim;
  }

  /** Everything the weekend brings to the race. */
  outcome(): WeekendOutcome {
    const qualifying = this.skip.has('qualifying') ? undefined : this.models.map((_, ci) => this.grid(ci));
    return { qualifying, rubber: this.carried(this.sessions[this.sessions.length - 1]), wearGuess: this.wearGuess() };
  }

  /** The race, set up from the weekend. */
  raceSetup(): RaceSetup {
    return createRaceSetup(this.models, this.settings, this.outcome(), this.field);
  }

  // ---- qualifying formats ----------------------------------------------------------

  private stageOf(s: WeekendSession): QualifyingStage {
    return this.models[s.stage!.cls].rules.weekend.qualifying[s.stage!.index];
  }

  private stageSession(cls: number, name: string): WeekendSession | undefined {
    return this.sessions.find((x) => x.stage?.cls === cls && this.stageOf(x).name === name);
  }

  /** The cars of a qualifying stage, from the results it draws on. */
  private stageCars(s: WeekendSession): number[] {
    const stage = this.stageOf(s);
    const cls = s.stage!.cls;
    if (!stage.entry.length) return [...this.field.byClass[cls]];
    const out: number[] = [];
    for (const src of stage.entry) {
      const order = this.sourceOrder(cls, src);
      const count = this.count(cls, src, order.length);
      const pick = src.take === 'top' ? order.slice(0, count)
        : src.take === 'rest' ? order.slice(count)
          : order.filter((_, i) => (src.take === 'odd' ? i % 2 === 0 : i % 2 === 1));
      for (const id of pick) if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * How many cars a source takes: as written, or, in a knockout format,
   * scaled so that as many cars go out at each step whatever the field size
   * (the last stage keeping its size).
   */
  private count(cls: number, src: StageSource, available: number): number {
    const format = this.models[cls].rules.weekend;
    if (!format.knockout || src.take !== 'top') return Math.min(src.count, available);
    const stages = format.qualifying;
    const last = stages[stages.length - 1].entry.find((e) => e.take === 'top')?.count ?? src.count;
    const steps = stages.length - 1;
    const step = stages.findIndex((x) => x.entry.includes(src));
    const cars = this.field.byClass[cls].length;
    const out = Math.max(0, cars - last) / Math.max(1, steps);
    return Math.min(available, last + Math.round(out * (steps - step)));
  }

  /** How many cars of a stage go through to a later one (for the knockout zone), or undefined. */
  private advancing(s: WeekendSession): number | undefined {
    const cls = s.stage!.cls;
    const name = this.stageOf(s).name;
    let total = 0;
    let any = false;
    for (const later of this.models[cls].rules.weekend.qualifying) {
      for (const src of later.entry) {
        if (src.from !== name || src.take !== 'top') continue;
        any = true;
        total += this.count(cls, src, Infinity);
      }
    }
    return any ? total : undefined;
  }

  /** A result to draw cars from, best first: an earlier stage, or practice (or, with no practice run, the lap-time model). */
  private sourceOrder(cls: number, src: StageSource): number[] {
    if (src.from !== 'practice') {
      const s = this.stageSession(cls, src.from);
      return s ? (this.results.get(s.id) ?? []).map((r) => r.car) : [];
    }
    const ids = this.field.byClass[cls];
    const best = new Map<number, number>();
    let ran = false;
    this.sessions.forEach((s, i) => {
      if (s.kind !== 'practice' || (src.practice && !src.practice.includes(i + 1))) return;
      const res = this.results.get(s.id);
      if (!res) return;
      ran = true;
      for (const r of res) if (r.time !== null && ids.includes(r.car)) best.set(r.car, Math.min(best.get(r.car) ?? Infinity, r.time));
    });
    if (!ran) {
      const model = this.models[cls];
      return runQualifying(model, ids.map((i) => this.field.entrants[i]), seededRandom(`${this.settings.seed}:practice:${model.vehicle.id}`)).map((q) => q.car);
    }
    return [...ids].sort((a, b) => (best.get(a) ?? Infinity) - (best.get(b) ?? Infinity) || this.field.entrants[a].number - this.field.entrants[b].number);
  }

  /**
   * The grid of a class from its qualifying, pole first, with the time that
   * set each place (NaN for none); undefined when its qualifying did not run.
   */
  grid(cls: number): QualifyingEntry[] | undefined {
    const format = this.models[cls].rules.weekend;
    const stages = this.sessions.filter((s) => s.stage?.cls === cls);
    if (!stages.some((s) => this.results.has(s.id))) return undefined;
    const ids = this.field.byClass[cls];
    if (format.average) {
      const times = new Map<number, number[]>(ids.map((id) => [id, []]));
      for (const s of stages) for (const r of this.results.get(s.id) ?? []) if (r.time !== null) times.get(r.car)?.push(r.time);
      const avg = (id: number) => {
        const t = times.get(id)!;
        return t.length ? t.reduce((a, b) => a + b, 0) / t.length : NaN;
      };
      return [...ids]
        .sort((a, b) => times.get(b)!.length - times.get(a)!.length || (avg(a) || Infinity) - (avg(b) || Infinity) || this.field.entrants[a].number - this.field.entrants[b].number)
        .map((car) => ({ car, time: avg(car) }));
    }
    // Rounds: a stage drawing on another runs after it; stages of one round ran side by side.
    const round = new Map<string, number>();
    for (const s of stages) {
      const st = this.stageOf(s);
      const from = st.entry.map((e) => (e.from === 'practice' ? 0 : round.get(e.from) ?? 0));
      round.set(st.name, 1 + Math.max(0, ...from));
    }
    const place = new Map<number, { round: number; pos: number; group: number; time: number }>();
    for (const s of stages) {
      const res = this.results.get(s.id);
      if (!res) continue;
      const st = this.stageOf(s);
      const r = round.get(st.name)!;
      const group = stages.filter((x) => round.get(this.stageOf(x).name) === r).indexOf(s);
      res.forEach((e, pos) => {
        const prev = place.get(e.car);
        if (!prev || r >= prev.round) place.set(e.car, { round: r, pos, group, time: e.time ?? NaN });
      });
    }
    const groups = (r: number) => stages.filter((x) => round.get(this.stageOf(x).name) === r).length;
    const key = (id: number) => {
      const p = place.get(id);
      return p ? [-p.round, p.pos * groups(p.round) + p.group] : [1, this.field.entrants[id].number];
    };
    return [...ids].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    }).map((car) => ({ car, time: place.get(car)?.time ?? NaN }));
  }

  // ---- what the teams learn -------------------------------------------------------

  /**
   * Each car's believed tyre wear per compound: off by a share drawn once
   * per team and compound, shrinking with the laps the team saw on it.
   */
  private wearGuess(): number[][] {
    return this.field.entrants.map((e) => {
      const rules = this.models[e.classIndex].rules;
      const seen = this.seen.get(e.teamIndex);
      return rules.tyres.compounds.map((c, ci) => {
        if (c.type !== 'slick') return 1;
        const rng = seededRandom(`${this.settings.seed}:wear:${e.teamIndex}:${ci}`);
        const error = gauss(rng) * GUESS_ERROR / Math.sqrt(1 + (seen?.[ci] ?? 0) / GUESS_LAPS);
        return Math.max(0.5, 1 + error);
      });
    });
  }
}
