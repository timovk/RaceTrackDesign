import { describe, expect, it } from 'vitest';
import { type RaceRules, parseRaceRules, raceRules } from '../src/core/race/rules.ts';
import type { ContactRecord, RaceSim } from '../src/core/race/sim.ts';
import { judge, offenceText, penaltyText } from '../src/core/race/stewards.ts';
import { calm, car, start } from './raceFixture.ts';

/** A contact: car 2 behind car 1 and on its inside, half alongside, and car 1 spun; with whatever is different. */
function contact(over: Partial<ContactRecord> = {}): ContactRecord {
  return { t: 100, lap: 5, u: 0, ahead: 1, behind: 2, overlap: 0.5, inside: 2, speed: 40, lunging: -1, squeezed: -1, outcome: 'spin', hurt: [1], ...over };
}

describe('who is to blame for a contact', () => {
  it('is the car that dived in, wherever it got to', () => {
    expect(judge(contact({ lunging: 2, overlap: 0.9 }))).toMatchObject({ blame: 2, offence: 'collision', mitigated: false });
    expect(judge(contact({ lunging: 1, inside: 1 }))).toMatchObject({ blame: 1 });
    // Its own race the only one to suffer: the lesser penalty.
    expect(judge(contact({ lunging: 2, hurt: [2], outcome: 'damage' }))).toMatchObject({ blame: 2, mitigated: true });
  });

  it('is the car on the inside that was not far enough alongside, when that is clear', () => {
    expect(judge(contact({ overlap: 0.3 }))).toMatchObject({ blame: 2, offence: 'collision', mitigated: false });
    // Nearly there: mitigating circumstances. Within a tenth of a length: not clear, so nobody.
    expect(judge(contact({ overlap: 0.55 }))).toMatchObject({ blame: 2, mitigated: true });
    expect(judge(contact({ overlap: 0.65 })).blame).toBe(-1);
  });

  it('is the car ahead that left no room to one far enough alongside on the inside', () => {
    expect(judge(contact({ overlap: 0.8 })).blame).toBe(-1);
    expect(judge(contact({ overlap: 0.8, squeezed: 2, hurt: [2] }))).toMatchObject({ blame: 1, mitigated: false });
  });

  it('owes a car on the outside room only when it is ahead', () => {
    // Behind on the outside, it turns the car on the inside round: its fault. Run out of road itself: nobody's.
    expect(judge(contact({ inside: 1 }))).toMatchObject({ blame: 2 });
    expect(judge(contact({ inside: 1, hurt: [2], outcome: 'forced off' })).blame).toBe(-1);
    // Level, neither can be called ahead.
    expect(judge(contact({ inside: 1, overlap: 0.95 })).blame).toBe(-1);
  });

  it('calls running a car off the road by its name', () => {
    const v = judge(contact({ lunging: 2, overlap: 0.9, outcome: 'forced off' }));
    expect(v).toMatchObject({ blame: 2, offence: 'forcing off' });
    expect(offenceText(v.offence, 'VER')).toBe('forcing VER off the track');
    expect(offenceText('collision', 'VER')).toBe('causing a collision with VER');
  });

  it('judges the first lap leniently where the series does', () => {
    expect(judge(contact({ overlap: 0.45 }), true).blame).toBe(-1);
    expect(judge(contact({ overlap: 0.45 }), false).blame).toBe(2);
    expect(judge(contact({ overlap: 0.3 }), true).blame).toBe(2);
    expect(judge(contact({ overlap: 0.8, squeezed: 2, hurt: [2] }), true).blame).toBe(-1);
    expect(judge(contact({ inside: 1, overlap: 0.7 }), true).blame).toBe(-1);
    expect(judge(contact({ inside: 1, overlap: 0.7 }), false).blame).toBe(2);
    // A car that dived in is to blame on any lap.
    expect(judge(contact({ lunging: 2 }), true).blame).toBe(2);
  });

  it('names the penalties', () => {
    expect(penaltyText({ kind: 'time', seconds: 10 })).toBe('10-second time penalty');
    expect(penaltyText({ kind: 'driveThrough' })).toBe('Drive-through penalty');
    expect(penaltyText({ kind: 'warning' })).toBe('Warning');
  });
});

describe("each series' penalties", () => {
  it('come from the data', () => {
    const of = (id: string) => raceRules(car(id)).stewards;
    expect(of('f1')).toMatchObject({ collision: { kind: 'time', seconds: 10 }, lesser: { kind: 'time', seconds: 5 }, timeAtStop: true, serveLaps: 2, lateLaps: 3, driveThroughTime: 20, firstLapLenient: true, afterRace: false });
    expect(of('f2')).toEqual(of('f1'));
    expect(of('indycar')).toMatchObject({ collision: { kind: 'driveThrough' }, lesser: { kind: 'warning' }, serveLaps: 1, afterLine: true, driveThroughTime: 30 });
    expect(of('hypercar')).toMatchObject({ collision: { kind: 'driveThrough' }, serveLaps: 4, lateLaps: 0, lateTime: 900, driveThroughTime: 0 });
    expect(of('lmp2')).toEqual(of('hypercar'));
    expect(of('gt3')).toMatchObject({ collision: { kind: 'driveThrough' }, serveLaps: 2, lateTime: 600, driveThroughTime: 0 });
    expect(of('gt4')).toMatchObject({ collision: { kind: 'driveThrough' }, driveThroughTime: 30 });
    expect(of('tcr')).toMatchObject({ collision: { kind: 'time', seconds: 5 }, lesser: { kind: 'warning' }, timeAtStop: false, serveLaps: 3, afterRace: true });
  });

  it('have defaults, and refuse what is not a penalty', () => {
    const f1 = car('f1');
    expect(parseRaceRules({}, f1).stewards).toMatchObject({ collision: { kind: 'time', seconds: 10 }, lesser: { kind: 'time', seconds: 5 }, timeAtStop: true, afterLine: false });
    expect(parseRaceRules({ stewards: { collision: 'driveThrough', lesser: 'warning' } }, f1).stewards).toMatchObject({ collision: { kind: 'driveThrough' }, lesser: { kind: 'warning' } });
    expect(() => parseRaceRules({ stewards: { collision: 'prison' } }, f1)).toThrow(/collision/);
    expect(() => parseRaceRules({ stewards: { lesser: -5 } }, f1)).toThrow(/lesser/);
  });
});

// Trips off and crashes ten times as likely as the class has them: enough contact in short races to look at.
const base = raceRules(car('f1'));
const rough: RaceRules = { ...base, incidents: { mistake: base.incidents.mistake * 4, off: base.incidents.off * 10, crash: base.incidents.crash * 10, dnfPerMetre: 0 } };

interface Run {
  sim: RaceSim;
  /** Drive-throughs: the car, and whether the race was green as it came in, whether it stood still, and its stops before and after. */
  throughs: { car: number; green: boolean; stopped: boolean; stopsBefore: number; stopsAfter: number }[];
  /** The most investigations any car was named in at once, and whether any car was shown as under investigation. */
  named: number;
}

function run(rules: RaceRules, seed: string): Run {
  const sim = start(car('f1'), { kind: 'laps', laps: 15, cars: 20, seed }, rules);
  const throughs: Run['throughs'] = [];
  const on = new Map<number, Run['throughs'][number]>();
  let named = 0;
  while (!sim.finished) {
    sim.step();
    for (const c of sim.cars) {
      named = Math.max(named, c.investigations);
      const now = c.pit?.through === true;
      const entry = on.get(c.id);
      if (now && !entry) {
        const e = { car: c.id, green: sim.phase === 'green', stopped: false, stopsBefore: c.stops, stopsAfter: c.stops };
        on.set(c.id, e);
        throughs.push(e);
      } else if (now && entry) entry.stopped ||= c.pit!.stopped;
      else if (!now && entry) {
        entry.stopsAfter = c.stops;
        on.delete(c.id);
      }
    }
  }
  return { sim, throughs, named };
}

const SEEDS = ['1', '5', '6'];

describe('the stewards in a race', () => {
  const races = SEEDS.map((seed) => run(rough, seed));

  it('look at every contact that cost a car something, and decide each one', () => {
    for (const { sim, named } of races) {
      const serious = sim.contacts.map((c, i) => ({ c, i })).filter(({ c }) => c.hurt.length > 0);
      expect(sim.cases.map((c) => c.contact)).toEqual(serious.map(({ i }) => i));
      expect(sim.cases.length).toBeGreaterThan(3);
      expect(named).toBeGreaterThan(0);
      for (const c of sim.cases) {
        const rec = sim.contacts[c.contact];
        expect(c.cars).toEqual([rec.behind, rec.ahead]);
        expect(c.state).toBe('decided');
        // After a few minutes, or when the race is over.
        expect(c.decidedAt).toBeGreaterThanOrEqual(Math.min(c.t + 120, sim.t));
        expect(c.verdict).toEqual(judge(rec, rec.lap === 1));
        // The penalty is the series': ten seconds, or five in mitigating circumstances; none where nobody is to blame.
        if (c.verdict!.blame < 0) expect(c.penalty).toBeNull();
        else expect(c.penalty).toEqual({ kind: 'time', seconds: c.verdict!.mitigated ? 5 : 10 });
        expect(c.status).not.toBe('open');
      }
      // Nothing is left over at the end.
      for (const car of sim.cars) {
        expect(car.investigations).toBe(0);
        expect(car.toServe).toHaveLength(0);
      }
      // The feed says what they decided: one line a case.
      const decisions = sim.events.filter((e) => e.kind === 'steward' && /^(No further action|\d+-second time penalty)/.test(e.text));
      expect(decisions).toHaveLength(sim.cases.length);
    }
    const reasons = new Set(races.flatMap((r) => r.sim.cases.map((c) => c.verdict!.reason)));
    expect(reasons.has('a first-lap incident')).toBe(true);
    expect(reasons.has('a racing incident')).toBe(true);
    expect(races.some((r) => r.sim.cases.some((c) => c.verdict!.blame >= 0 && c.verdict!.mitigated))).toBe(true);
  });

  it('have a time penalty stood still at the next pit stop, or added to the race time', () => {
    const cases = races.flatMap((r) => r.sim.cases.filter((c) => c.penalty));
    expect(cases.some((c) => c.status === 'served')).toBe(true);
    expect(cases.some((c) => c.status === 'added')).toBe(true);
    for (const { sim } of races) {
      const of = (car: number, status: string) => sim.cases.filter((c) => c.verdict?.blame === car && c.status === status).reduce((s, c) => s + (c.penalty?.kind === 'time' ? c.penalty.seconds : 0), 0);
      for (const car of sim.cars) {
        // Served: the stop was that much longer. (A stop takes two to three seconds.)
        const stops = sim.stops.filter((s) => s.car === car.id && s.penalty);
        expect(stops.reduce((s, x) => s + x.penalty!, 0)).toBe(of(car.id, 'served'));
        for (const s of stops) {
          expect(s.stationary).toBeGreaterThan(s.penalty! + 1.5);
          expect(sim.events.some((e) => e.kind === 'pit' && e.car === car.id && e.text.includes(`${s.penalty} s penalty served`))).toBe(true);
        }
        // Not served: on the race time. A car that is out has nothing added.
        expect(car.addedTime).toBe(of(car.id, 'added'));
        if (car.status === 'retired') expect(car.addedTime).toBe(0);
      }
      for (const c of sim.cases) expect(c.seconds).toBe(c.status === 'added' ? (c.penalty as { seconds: number }).seconds : 0);
    }
  });

  it('classify by the race time with what they added, and say who lost places to it', () => {
    let moved = 0;
    for (const { sim } of races) {
      const home = sim.order.filter((c) => c.status === 'finished');
      for (let i = 1; i < home.length; i++) {
        const a = home[i - 1];
        const b = home[i];
        if (a.lapsDone === b.lapsDone) expect(b.finishTime! + b.addedTime).toBeGreaterThanOrEqual(a.finishTime! + a.addedTime);
        else expect(b.lapsDone).toBeLessThan(a.lapsDone);
        // The gaps are the classification's.
        const ga = sim.gap(a);
        const gb = sim.gap(b);
        if (ga.kind === 'time' && gb.kind === 'time') expect(gb.value).toBeGreaterThanOrEqual(ga.value);
      }
      for (const car of home.filter((c) => c.addedTime > 0)) {
        const road = home.filter((c) => c.lapsDone > car.lapsDone || (c.lapsDone === car.lapsDone && c.finishTime! < car.finishTime!)).length + 1;
        const said = sim.events.find((e) => e.kind === 'finish' && e.car === car.id && e.text.includes('is classified'));
        if (car.position > road) {
          moved++;
          expect(said?.text).toContain(`classified P${car.position} (P${road} on the road) with ${car.addedTime} s added`);
        } else expect(said).toBeUndefined();
      }
    }
    expect(moved).toBeGreaterThan(1);
  });

  it('have a drive-through driven without stopping, under green, or add its time where that cannot be', () => {
    const rules: RaceRules = { ...rough, stewards: { ...rough.stewards, collision: { kind: 'driveThrough' }, lesser: { kind: 'driveThrough' }, lateLaps: 0, lateTime: 0 } };
    const runs = SEEDS.map((seed) => run(rules, seed));
    const throughs = runs.flatMap((r) => r.throughs);
    expect(throughs.length).toBeGreaterThan(2);
    for (const x of throughs) {
      expect(x.green).toBe(true);
      expect(x.stopped).toBe(false);
      expect(x.stopsAfter).toBe(x.stopsBefore);
    }
    for (const { sim, throughs: mine } of runs) {
      const served = sim.cases.filter((c) => c.status === 'served');
      expect(served).toHaveLength(mine.length);
      expect(sim.events.filter((e) => /has served its drive-through/.test(e.text))).toHaveLength(mine.length);
      // Not a pit stop: it is not in the list of them.
      expect(sim.stops.some((s) => s.reason === 'drive-through')).toBe(false);
      for (const c of served) {
        // It costs about what the pit lane costs: the lap it is on is that much slower than the car's best.
        const car = sim.cars[c.verdict!.blame];
        expect(Math.max(...car.history.map((h) => h.time)) - car.bestLap!).toBeGreaterThan(8);
      }
      // After the race, or not served by the flag: Formula 1's twenty seconds.
      for (const c of sim.cases.filter((x) => x.status === 'added')) expect(c.seconds).toBe(20);
      for (const car of sim.cars) expect(car.toServe).toHaveLength(0);
    }
    expect(runs.some((r) => r.sim.cases.some((c) => c.status === 'added'))).toBe(true);
  });

  it('are not driven in the last laps where the series says so', () => {
    const late: RaceRules = { ...rough, stewards: { ...rough.stewards, collision: { kind: 'driveThrough' }, lesser: { kind: 'driveThrough' }, lateLaps: 15, lateTime: 0 } };
    for (const seed of SEEDS) {
      const { sim, throughs } = run(late, seed);
      expect(throughs).toHaveLength(0);
      const given = sim.cases.filter((c) => c.penalty && sim.cars[c.verdict!.blame].status !== 'retired');
      for (const c of given) expect([c.status, c.seconds]).toEqual(['added', 20]);
      if (given.length) expect(sim.events.some((e) => e.text.includes('20 s added to its race time instead'))).toBe(true);
    }
  });

  it('decide after the race where the series looks at incidents then, and add the time', () => {
    const rules: RaceRules = { ...rough, stewards: { ...rough.stewards, timeAtStop: false, afterRace: true } };
    let after = 0;
    for (const seed of SEEDS) {
      const { sim } = run(rules, seed);
      for (const c of sim.cases) {
        const rec = sim.contacts[c.contact];
        // Only what is completely clear is decided during the race: a car that dived in.
        if (rec.lunging < 0) {
          expect(c.decidedAt).toBe(sim.t);
          after++;
        } else expect(c.decidedAt).toBeLessThan(c.t + 400);
        if (c.penalty) expect(['added', 'none']).toContain(c.status);
      }
      expect(sim.stops.some((s) => s.penalty)).toBe(false);
    }
    expect(after).toBeGreaterThan(5);
  });

  it('have nothing to do where nothing happens', () => {
    const sim = start(car('f1'), { kind: 'laps', laps: 6, cars: 20 }, calm(car('f1')));
    while (!sim.finished) sim.step();
    expect(sim.cases).toHaveLength(0);
    expect(sim.events.some((e) => e.kind === 'steward')).toBe(false);
    for (const c of sim.cars) expect(c.addedTime).toBe(0);
  });
});
