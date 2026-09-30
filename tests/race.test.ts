import { describe, expect, it } from 'vitest';
import { generateField } from '../src/core/race/field.ts';
import { launchCurve } from '../src/core/race/model.ts';
import { parseRaceRules, raceRules } from '../src/core/race/rules.ts';
import { createRaceSetup, defaultRaceSettings, parseRaceSettings } from '../src/core/race/setup.ts';
import { RaceSim } from '../src/core/race/sim.ts';
import { planStrategy, popcount, tyreLoss } from '../src/core/race/strategy.ts';
import { seededRandom } from '../src/core/rng.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { calm, car, model, race } from './raceFixture.ts';

/** Finished, or out after contact in a failed pass (which calm rules do not switch off). */
const finishedOrContact = (c: { status: string; retired: { reason: string } | null }) =>
  c.status === 'finished' || c.retired?.reason === 'collision damage';

describe('race rules', () => {
  it('has rules for every built-in class, in SI units and fractions', () => {
    for (const v of VEHICLES) {
      const r = raceRules(v);
      expect(r.tyres.compounds.length).toBeGreaterThan(0);
      expect(r.field.cars).toBeGreaterThan(0);
      expect(r.reference.energy).toBeGreaterThan(0);
    }
    const f1 = raceRules(car('f1'));
    expect(f1.race.distance).toBe(305_000);
    expect(f1.tyres.compounds[1].offset).toBeCloseTo(0.005, 9);
    expect(f1.drs).not.toBeNull();
    expect(raceRules(car('gt3')).drs).toBeNull();
  });

  it('falls back to defaults for an unknown class and rejects bad numbers', () => {
    const r = parseRaceRules(undefined, { id: 'x', kind: 'bike', drs: 0 });
    expect(r.pit.stops).toBe(false);
    expect(r.tyres.compounds).toHaveLength(1);
    expect(() => parseRaceRules({ fuel: { kgPerKm: -1 } }, { id: 'x', kind: 'car', drs: 0 })).toThrow(/kgPerKm/);
  });
});

describe('race model', () => {
  const m = model(car('f1'));

  it('splits the race lap into segment times that add up to the lap', () => {
    const sum = m.seg.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(m.lapTime, 6);
    expect(m.lapTime).toBeGreaterThan(m.qualifyingTime);
  });

  it('makes the slipstream faster on the straights and the wake slower in the corners', () => {
    let tow = 0;
    let wake = 0;
    for (let k = 0; k < m.n; k++) {
      // Faster in the slipstream means braking a little earlier, so a few stations before a corner are slower.
      expect(m.towRatio[k]).toBeLessThan(1.02);
      // Less downforce also means a little less rolling resistance on the straights.
      expect(m.wakeRatio[k]).toBeGreaterThan(0.995);
      tow += m.seg[k] * (1 - m.towRatio[k]);
      wake += m.seg[k] * (m.wakeRatio[k] - 1);
    }
    expect(tow).toBeGreaterThan(0.2);
    expect(wake).toBeGreaterThan(0.2);
    expect(m.drs.length).toBeGreaterThan(0);
  });

  it('finds a braking zone before each of the four corners and a pit lane', () => {
    expect(m.zones).toHaveLength(4);
    for (const z of m.zones) expect(z.quality).toBeGreaterThan(0.3);
    expect(m.pit).not.toBeNull();
    expect(m.pit!.limit).toBeCloseTo(80 / 3.6, 9);
  });

  it('burns fuel and costs time for carrying it', () => {
    expect(m.fuelPerLap).toBeGreaterThan(0.5);
    expect(m.fuelSensitivity).toBeGreaterThan(0);
  });

  it('accelerates from a standstill up to top speed', () => {
    const launch = launchCurve(car('f1'));
    expect(launch[0]).toBe(0);
    for (let i = 1; i < launch.length; i++) expect(launch[i]).toBeGreaterThanOrEqual(launch[i - 1]);
    expect(launch[100]).toBeGreaterThan(30);
    expect(launch[launch.length - 1]).toBeLessThanOrEqual(car('f1').topSpeed + 1e-9);
  });
});

describe('strategy', () => {
  const m = model(car('f1'));

  it('uses two compounds when the rules require it', () => {
    const plan = planStrategy({ model: m, tyreFactor: 1, laps: 60, compound: null, wear: 0, used: 0, stopsDone: 0, canStop: true });
    const mask = plan.stints.reduce((acc, s) => acc | (1 << s.compound), 0);
    expect(popcount(mask)).toBeGreaterThanOrEqual(2);
    expect(plan.stints.reduce((a, s) => a + s.laps, 0)).toBe(60);
  });

  it('runs one stint when stops are not allowed', () => {
    const bike = model(car('motogp'));
    const plan = planStrategy({ model: bike, tyreFactor: 1, laps: 25, compound: null, wear: 0, used: 0, stopsDone: 0, canStop: true });
    expect(plan.stints).toHaveLength(1);
    expect(plan.stints[0].laps).toBe(25);
  });

  it('makes worn tyres slow, and very worn tyres very slow', () => {
    const c = m.rules.tyres.compounds[0];
    expect(tyreLoss(c, 0)).toBe(0);
    expect(tyreLoss(c, 1)).toBeCloseTo(c.deg, 12);
    expect(tyreLoss(c, 1.3) - tyreLoss(c, 1)).toBeGreaterThan(tyreLoss(c, 1) - tyreLoss(c, 0.7));
  });
});

describe('field and settings', () => {
  it('draws the same field from the same seed', () => {
    const r = raceRules(car('f1'));
    const a = generateField(r, 20, seededRandom('x'));
    const b = generateField(r, 20, seededRandom('x'));
    expect(a).toEqual(b);
    expect(new Set(a.map((e) => e.code)).size).toBe(20);
    expect(new Set(a.map((e) => e.number)).size).toBe(20);
    expect(a[0].team).toBe(a[1].team);
    expect(a[0].team).not.toBe(a[2].team);
  });

  it('checks saved settings', () => {
    const ids = VEHICLES.map((v) => v.id);
    expect(parseRaceSettings({ vehicleId: 'f1', cars: 99, laps: 5, minutes: 10, kind: 'time', grid: 'reversed', seed: 3 }, ids))
      .toEqual({ vehicleId: 'f1', cars: 40, laps: 5, minutes: 10, kind: 'time', grid: 'reversed', seed: '3' });
    expect(parseRaceSettings({ vehicleId: 'nope', cars: 5, laps: 5, minutes: 10 }, ids)).toBeNull();
    expect(parseRaceSettings(null, ids)).toBeNull();
  });

  it('sets the grid by qualifying, reversed or at random', () => {
    const m = model(car('f1'));
    const base = defaultRaceSettings(car('f1'), m.rules, m.line.length, m.lapTime, '9');
    const q = createRaceSetup(m, base);
    expect(q.grid).toEqual(q.qualifying.map((e) => e.car));
    expect(createRaceSetup(m, { ...base, grid: 'reversed' }).grid).toEqual([...q.grid].reverse());
  });
});

describe('race', () => {
  it('gives the same race for the same seed, and another for another seed', () => {
    const a = race(car('f1'), { laps: 8, cars: 10 });
    const b = race(car('f1'), { laps: 8, cars: 10 });
    const c = race(car('f1'), { laps: 8, cars: 10, seed: '12' });
    const result = (s: RaceSim) => s.order.map((x) => `${x.id}:${x.finishTime?.toFixed(6)}`).join(',');
    expect(result(a)).toBe(result(b));
    expect(result(a)).not.toBe(result(c));
  });

  it('ends a race by laps when the leader has done them all', () => {
    const sim = race(car('gt3'), { kind: 'laps', laps: 6, cars: 12 }, calm(car('gt3')));
    const winner = sim.order[0];
    expect(winner.lapsDone).toBe(6);
    expect(sim.chequered).toBe(true);
    for (const c of sim.cars) {
      expect(finishedOrContact(c)).toBe(true);
      if (c.status === 'finished') expect(c.lapsDone).toBeGreaterThanOrEqual(5);
    }
    // Finishing order follows race distance.
    for (let i = 1; i < sim.order.length; i++) expect(sim.order[i].u).toBeLessThanOrEqual(sim.order[i - 1].u + 1e-9);
  });

  it('ends a race by time at the leader\'s first crossing after the time is up', () => {
    const sim = race(car('tcr'), { kind: 'time', minutes: 10, cars: 8 }, calm(car('tcr')));
    const winner = sim.order[0];
    expect(winner.finishTime!).toBeGreaterThanOrEqual(600);
    expect(winner.finishTime! - 600).toBeLessThan(winner.bestLap! * 1.2);
  });

  it('runs laps close to the model on an empty track', () => {
    const sim = race(car('f1'), { laps: 6, cars: 1 }, calm(car('f1')));
    const c = sim.cars[0];
    const m = sim.model;
    // Formula 1 must stop once for a second compound: leave out the laps into and out of the pits.
    const clean = c.history.slice(1).filter((h) => !h.pit && !c.history[h.lap - 2]?.pit);
    expect(clean.length).toBeGreaterThanOrEqual(2);
    for (const h of clean) {
      // Race pace, fuel, compound and wear add a little; the lap-to-lap scatter goes either way.
      expect(h.time / (m.lapTime * c.entrant.pace)).toBeGreaterThan(0.985);
      expect(h.time / (m.lapTime * c.entrant.pace)).toBeLessThan(1.06);
    }
    // The standing start costs a few seconds on lap 1.
    expect(c.history[0].time - Math.max(...clean.map((h) => h.time))).toBeGreaterThan(1);
  });

  it('never changes the order without a pass: with overtaking off, the order after the first lap holds', () => {
    const base = calm(car('gt4'));
    const rules = { ...base, pace: { ...base.pace, overtaking: 0 }, pit: { ...base.pit, stops: false, minStops: 0 } };
    const m = model(car('gt4'), rules);
    const settings = { ...defaultRaceSettings(car('gt4'), rules, m.line.length, m.lapTime, '4'), kind: 'laps' as const, laps: 10, cars: 12 };
    const sim = new RaceSim(createRaceSetup(m, settings));
    while (sim.order[0].lapsDone < 2) sim.step();
    const after = sim.order.map((c) => c.id).join(',');
    while (!sim.finished) sim.step();
    expect(sim.order.map((c) => c.id).join(',')).toBe(after);
    expect(sim.events.filter((e) => e.kind === 'overtake')).toHaveLength(0);
  });

  it('stops for tyres in the pit lane and uses two compounds in Formula 1', () => {
    const sim = race(car('f1'), { laps: 40, cars: 10 }, calm(car('f1')));
    for (const c of sim.cars) {
      if (c.status !== 'finished') continue;
      expect(c.stops).toBeGreaterThanOrEqual(1);
      expect(popcount(c.used)).toBeGreaterThanOrEqual(2);
    }
    expect(sim.events.some((e) => e.kind === 'pit')).toBe(true);
    // A pit lap is slower by about the drive-through loss plus the stop.
    const c = sim.cars.find((x) => x.status === 'finished')!;
    const pitLap = c.history.find((h) => h.pit)!;
    const normal = c.history.filter((h) => !h.pit && h.lap > 1 && h.lap !== pitLap.lap + 1);
    const avg = normal.reduce((a, h) => a + h.time, 0) / normal.length;
    const out = c.history[pitLap.lap];
    const loss = pitLap.time + (out?.time ?? avg) - 2 * avg;
    expect(loss).toBeGreaterThan(sim.model.pit!.driveThroughLoss);
    expect(loss).toBeLessThan(sim.model.pit!.driveThroughLoss + 15);
  });

  it('refuels endurance cars before they run dry', () => {
    const sim = race(car('lmp2'), { kind: 'time', minutes: 90, cars: 8 }, calm(car('lmp2')));
    for (const c of sim.cars) {
      expect(finishedOrContact(c)).toBe(true);
      if (c.status !== 'finished') continue;
      expect(c.stops).toBeGreaterThanOrEqual(1);
      expect(c.fuel).toBeGreaterThan(0);
    }
  });

  it('times the gaps: the leader first, then growing gaps down the order', () => {
    const sim = race(car('f2'), { laps: 5, cars: 10 }, calm(car('f2')));
    expect(sim.gap(sim.order[0]).kind).toBe('leader');
    let last = 0;
    for (const c of sim.order.slice(1)) {
      const g = sim.gap(c);
      if (g.kind !== 'time') continue;
      expect(g.value).toBeGreaterThanOrEqual(last - 1e-9);
      last = g.value;
    }
    expect(sim.fastest).not.toBeNull();
  });
});
