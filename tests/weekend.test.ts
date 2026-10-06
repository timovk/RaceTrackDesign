import { describe, expect, it } from 'vitest';
import { raceRules } from '../src/core/race/rules.ts';
import { SessionSim } from '../src/core/race/session.ts';
import { type RaceSettings, type SessionSpec, createField, createRaceSetup, defaultRaceSettings } from '../src/core/race/setup.ts';
import { RaceSim } from '../src/core/race/sim.ts';
import { RUBBER_START, Weekend } from '../src/core/race/weekend.ts';
import { car, model } from './raceFixture.ts';

function settings(id: string, cars: number, seed = '11'): RaceSettings {
  const m = model(car(id));
  return { ...defaultRaceSettings(car(id), m.rules, m.line.length, m.lapTime, seed), classes: [{ vehicleId: id, cars }] };
}

/** A session of one class on the test circuit. */
function session(id: string, cars: number, spec: Partial<SessionSpec> & { kind: SessionSpec['kind'] }, rubber = 0.8): SessionSim {
  const m = model(car(id));
  const set = settings(id, cars);
  const field = createField(m, set);
  const base = createRaceSetup(m, set, {}, field);
  return new SessionSim({
    ...base, rubber,
    session: { name: spec.kind === 'practice' ? 'FP1' : 'Q', duration: 1800, cars: field.entrants.map((e) => e.index), clockStops: true, ...spec },
  });
}

const timed = (k: string | undefined) => k === 'push' || k === 'cool' || k === 'long';

describe('sessions', () => {
  it('sends cars out in runs from their garages, and orders them by their best timed lap', () => {
    const sim = session('f1', 10, { kind: 'practice', duration: 40 * 60, longRuns: true });
    for (const c of sim.entries) expect(c.status === 'pit' && c.garage === 1).toBe(true);
    while (!sim.finished) sim.step();
    for (const c of sim.entries) {
      const kinds = c.history.map((h) => h.kind);
      expect(sim.of(c)!.runs).toBeGreaterThanOrEqual(2);
      expect(kinds).toContain('out');
      expect(kinds).toContain('push');
      // The best lap is the quickest timed lap: never an out lap or an in lap.
      const best = Math.min(...c.history.filter((h) => timed(h.kind)).map((h) => h.time));
      expect(c.bestLap).toBeCloseTo(best, 9);
      // Home in the garage at the end.
      expect(c.status === 'retired' || (c.status === 'pit' && c.pit!.stopped)).toBe(true);
    }
    const order = sim.results().filter((r) => r.time !== null).map((r) => r.time!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Someone ran a race simulation, and practice taught the teams something about their tyres.
    expect(sim.entries.some((c) => c.history.filter((h) => h.kind === 'long').length >= 8)).toBe(true);
    expect([...sim.seen().values()].some((s) => s.some((x) => x >= 8))).toBe(true);
    expect(sim.events.some((e) => e.kind === 'chequered')).toBe(true);
    // Nobody races anybody in a session: a driver's own trouble at most, no contact.
    expect(sim.contacts).toHaveLength(0);
    expect(sim.tally.touches + sim.tally.tapped + sim.tally.forcedOff + sim.tally.damaged + sim.tally.collisions).toBe(0);
  });

  it('runs a qualifying push lap at the calibrated qualifying pace on a rubbered track', () => {
    const sim = session('f1', 1, { kind: 'qualifying', duration: 12 * 60 }, 1);
    while (!sim.finished) sim.step();
    const c = sim.entries[0];
    const expected = c.model.qualifyingTime * (1 + c.entrant.carPace + c.driver.pace);
    expect(c.bestLap! / expected).toBeGreaterThan(0.99);
    expect(c.bestLap! / expected).toBeLessThan(1.01);
  });

  it('times the last runs for the end, and counts a lap begun before the flag', () => {
    const sim = session('f1', 12, { kind: 'qualifying', duration: 15 * 60 });
    while (!sim.finished) sim.step();
    const flag = sim.events.find((e) => e.kind === 'chequered')!.t;
    // Laps finished after the flag that started before it still count.
    const late = sim.entries.flatMap((c) => c.history.filter((h) => timed(h.kind) && h.at > flag && h.at - h.time < flag));
    expect(late.length).toBeGreaterThan(0);
    // Most cars leave for their last run in the closing minutes.
    const lastOut = sim.entries.map((c) => Math.max(...c.history.filter((h) => h.kind === 'out').map((h) => h.at - h.time)));
    expect(lastOut.filter((t) => t > flag - 300).length).toBeGreaterThan(sim.entries.length / 2);
  });

  it('stops the clock under a red flag in qualifying, sends everyone in, and does not count the lap cut short', () => {
    const sim = session('f1', 12, { kind: 'qualifying', duration: 15 * 60 });
    while (sim.clock < 300 || !sim.entries.some((c) => sim.of(c)!.phase === 'push')) sim.step();
    const pushing = sim.entries.filter((c) => sim.of(c)!.phase === 'push');
    const before = new Map(pushing.map((c) => [c.id, c.history.length]));
    const clock = sim.clock;
    sim.stopSession(sim.t, 240, 'test');
    for (let i = 0; i < 4000 && sim.red; i++) {
      sim.step();
      expect(sim.clock).toBeCloseTo(clock, 6);
    }
    expect(sim.red).toBeNull();
    for (const c of pushing) {
      // The lap it was on ended as an in lap; it is back in the garage.
      expect(c.history.slice(before.get(c.id)!).every((h) => !timed(h.kind))).toBe(true);
    }
    expect(sim.events.some((e) => e.text.startsWith('Green light'))).toBe(true);
    while (!sim.finished) sim.step();
  });
});

describe('the race weekend', () => {
  it('runs Formula 1 qualifying as a knockout, 5 out at each step with 20 cars and 6 with 22', () => {
    for (const [cars, q2, q3] of [[20, 15, 10], [22, 16, 10]]) {
      const w = new Weekend(model(car('f1')), settings('f1', cars), ['p1', 'p2', 'p3']);
      for (const s of w.toRun) w.runSession(s);
      const [q1r, q2r, q3r] = ['Q1', 'Q2', 'Q3'].map((n) => w.results.get(`q:f1:${n}`)!);
      expect([q1r.length, q2r.length, q3r.length]).toEqual([cars, q2, q3]);
      // Q2 takes the best of Q1, Q3 the best of Q2.
      expect(new Set(q2r.map((r) => r.car))).toEqual(new Set(q1r.slice(0, q2).map((r) => r.car)));
      expect(new Set(q3r.map((r) => r.car))).toEqual(new Set(q2r.slice(0, q3).map((r) => r.car)));
      // The grid: Q3 in front in its order, then the rest of Q2, then the rest of Q1.
      const grid = w.grid(0)!.map((g) => g.car);
      expect(grid).toEqual([...q3r.map((r) => r.car), ...q2r.slice(q3).map((r) => r.car), ...q1r.slice(q2).map((r) => r.car)]);
    }
  });

  it('seeds MotoGP\'s Q2 from practice and lets the best two of Q1 join it', () => {
    const w = new Weekend(model(car('motogp')), settings('motogp', 22), ['p3']);
    for (const s of w.toRun) w.runSession(s);
    const q1 = w.results.get('q:motogp:Q1')!;
    const q2 = w.results.get('q:motogp:Q2')!;
    expect(q1).toHaveLength(12);
    expect(q2).toHaveLength(12);
    for (const r of q1.slice(0, 2)) expect(q2.some((x) => x.car === r.car)).toBe(true);
    const grid = w.grid(0)!.map((g) => g.car);
    expect(grid.slice(0, 12)).toEqual(q2.map((r) => r.car));
    expect(grid.slice(12)).toEqual(q1.slice(2).map((r) => r.car));
  });

  it('splits IndyCar into two groups and fills the back of the grid from them in turn', () => {
    const w = new Weekend(model(car('indycar')), settings('indycar', 20), ['p1', 'p2']);
    for (const s of w.toRun) w.runSession(s);
    const g1 = w.results.get('q:indycar:Group 1')!;
    const g2 = w.results.get('q:indycar:Group 2')!;
    expect(g1.length + g2.length).toBe(20);
    expect(w.results.get('q:indycar:Fast 12')).toHaveLength(12);
    expect(w.results.get('q:indycar:Fast Six')).toHaveLength(6);
    const grid = w.grid(0)!.map((g) => g.car);
    expect(grid.slice(0, 6)).toEqual(w.results.get('q:indycar:Fast Six')!.map((r) => r.car));
    expect(grid[12]).toBe(g1[6].car);
    expect(grid[13]).toBe(g2[6].car);
  });

  it('averages the three drivers\' times for a GT World Challenge grid', () => {
    const w = new Weekend(model(car('gt3')), settings('gt3', 10), ['p1', 'p2']);
    const sims = w.toRun.map((s) => w.runSession(s)!);
    // Each stage has its own driver in the car.
    sims.forEach((sim, i) => {
      for (const c of sim.entries) expect(c.driverIndex).toBe(Math.min(i, c.entrant.drivers.length - 1));
    });
    const grid = w.grid(0)!;
    const times = grid.map((g) => g.time).filter((t) => !Number.isNaN(t));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('carries the weekend into the race: its grid, the rubber laid down and what teams learnt of their tyres', () => {
    const full = new Weekend(model(car('f1')), settings('f1', 12));
    for (const s of full.toRun) full.runSession(s);
    const race = full.raceSetup();
    expect(race.grid.slice(0, 3)).toEqual(full.grid(0)!.slice(0, 3).map((g) => g.car));
    const bare = new Weekend(model(car('f1')), settings('f1', 12), ['p1', 'p2', 'p3', 'qualifying']);
    const skipped = bare.raceSetup();
    // No practice: a greener track, and teams further off about tyre wear.
    expect(race.rubber!).toBeGreaterThan(skipped.rubber!);
    expect(skipped.rubber).toBe(RUBBER_START);
    const spread = (g: number[][]) => g.flatMap((x) => x.slice(0, 3)).reduce((a, v) => a + Math.abs(v - 1), 0);
    expect(spread(race.wearGuess!)).toBeLessThan(spread(skipped.wearGuess!));
    // Without qualifying the grid comes from the lap-time model, as before.
    expect(skipped.grid).toEqual(createRaceSetup(model(car('f1')), settings('f1', 12)).grid);
    // The same seed, the same weekend.
    const again = new Weekend(model(car('f1')), settings('f1', 12));
    for (const s of again.toRun) again.runSession(s);
    expect(again.raceSetup().grid).toEqual(race.grid);
  });

  it('builds the track up lap by lap and loses some of it overnight', () => {
    const w = new Weekend(model(car('f1')), settings('f1', 10), ['qualifying']);
    const p1 = w.runSession(w.sessions[0])!;
    expect(p1.rubber).toBeGreaterThan(RUBBER_START + 0.2);
    const fp3 = w.sessions.find((s) => s.id === 'p3')!;
    w.runSession(w.sessions[1]);
    const before = w.rubber;
    expect(w.sessionSim(fp3)!.rubber).toBeLessThan(before * 0.8);
  });
});

describe('red flags in the race', () => {
  const calm = (id: string) => {
    const r = raceRules(car(id));
    return { ...r, incidents: { ...r.incidents, crash: 0, off: 0, mistake: 0, dnfPerMetre: 0 } };
  };
  const race = (id: string, changes: Partial<RaceSettings> = {}) => {
    const set = { ...settings(id, 12), ...changes };
    return new RaceSim(createRaceSetup(model(car(id), calm(id)), set));
  };

  it('stops a Formula 1 race in the pit lane, adds the stoppage to its time limit, and restarts it from the grid behind the safety car', () => {
    const sim = race('f1');
    while (sim.t < 600) sim.step();
    const order = sim.order.map((c) => c.id);
    sim.redFlag(sim.t, 'test');
    let queued = false;
    while (sim.red) {
      sim.step();
      if (sim.red && sim.cars.every((c) => c.status === 'pit' && c.pit!.stopped)) {
        queued = true;
        // A queue at the pit exit, nobody in the boxes.
        const ps = sim.cars.map((c) => c.pit!.p).sort((a, b) => b - a);
        for (let i = 1; i < ps.length; i++) expect(ps[i - 1] - ps[i]).toBeGreaterThan(2);
      }
    }
    expect(queued).toBe(true);
    expect(sim.limit).toBeCloseTo(sim.setup.timeLimit! + sim.suspended, 6);
    while (!sim.events.some((e) => e.text.startsWith('Lights out: the race restarts'))) sim.step();
    expect(sim.events.some((e) => e.text.includes('forms up on the grid'))).toBe(true);
    // The order holds through the stoppage.
    expect(sim.order.map((c) => c.id)).toEqual(order);
    expect(sim.phase).toBe('green');
  });

  it('stops a WEC race on track in single file, with the clock running on, and restarts it behind the safety car', () => {
    const sim = race('hypercar');
    while (sim.t < 900) sim.step();
    sim.redFlag(sim.t, 'test');
    let stopped = false;
    while (sim.red) {
      sim.step();
      if (sim.red && sim.cars.every((c) => c.status !== 'running' || c.v < 0.5)) stopped = true;
    }
    expect(stopped).toBe(true);
    expect(sim.limit).toBe(sim.setup.duration);
    while (sim.phase !== 'green') sim.step();
    expect(sim.events.some((e) => e.text.startsWith('Green flag'))).toBe(true);
  });

  it('ends a MotoGP race stopped after three quarters of it, and restarts one stopped earlier from the grid', () => {
    const late = race('motogp', { laps: 12 });
    while (late.order[0].lapsDone < 10) late.step();
    late.redFlag(late.t, 'test');
    expect(late.finished).toBe(true);
    const early = race('motogp', { laps: 12 });
    while (early.order[0].lapsDone < 4) early.step();
    early.redFlag(early.t, 'test');
    while (!early.events.some((e) => e.text.startsWith('Lights out: the race restarts')) && !early.finished) early.step();
    expect(early.events.some((e) => e.text.includes('sighting lap'))).toBe(true);
  });

  it('classifies a race that cannot resume as it stood two laps before the red flag', () => {
    const sim = race('gt4', { kind: 'time', minutes: 20 });
    while (sim.t < 1000) sim.step();
    const lap = sim.lapLeaders.length + 1;
    sim.redFlag(sim.t, 'test');
    while (!sim.finished) sim.step();
    const end = sim.events.find((e) => e.kind === 'chequered')!;
    expect(end.text).toContain(`after lap ${lap - 2}`);
    // In the order they crossed the line at the end of that lap.
    const at = sim.lapLeaders[lap - 3];
    const crossed = sim.order.filter((c) => c.status !== 'retired').map((c) => c.history.filter((h) => h.at <= at + 1e-6).pop()!);
    for (let i = 1; i < crossed.length; i++) expect(crossed[i].lap < crossed[i - 1].lap || crossed[i].at >= crossed[i - 1].at).toBe(true);
  });
});
