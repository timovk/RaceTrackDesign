import { describe, expect, it } from 'vitest';
import { raceRules } from '../src/core/race/rules.ts';
import { DT, type RaceSim } from '../src/core/race/sim.ts';
import { driverStints, neutralLaps, positionsByLap } from '../src/core/race/stats.ts';
import { bestTyreType, buildWeather, gripFactor, rainAt, wetnessAt } from '../src/core/race/weather.ts';
import { calm, car, multiClass, race, runToEnd, start } from './raceFixture.ts';

describe('weather', () => {
  it('is the same for the same seed and dry when asked', () => {
    const a = buildWeather('changeable', 'x', 3600);
    const b = buildWeather('changeable', 'x', 3600);
    expect([...a.rain]).toEqual([...b.rain]);
    const dry = buildWeather('dry', 'x', 3600);
    expect(dry.rain.every((r) => r === 0)).toBe(true);
    expect(dry.wetness.every((w) => w === 0)).toBe(true);
  });

  it('brings a shower in a changeable race and a wet track in a wet one', () => {
    for (const seed of ['1', '2', '3', '4', '5']) {
      const w = buildWeather('changeable', seed, 3600);
      let wettest = 0;
      for (let t = 0; t <= 3600; t += 30) wettest = Math.max(wettest, rainAt(w, t));
      expect(wettest).toBeGreaterThan(0.1);
      expect(wetnessAt(buildWeather('wet', seed, 3600), 0)).toBeGreaterThan(0.3);
    }
  });

  it('wets the track within minutes and dries it more slowly', () => {
    const w = buildWeather('changeable', '7', 7200);
    // Find the first rain, then check the track follows with a lag.
    let startT = -1;
    for (let t = 0; t < 7200 && startT < 0; t += 10) if (rainAt(w, t) > 0.1) startT = t;
    expect(startT).toBeGreaterThanOrEqual(0);
    expect(wetnessAt(w, startT)).toBeLessThan(wetnessAt(w, startT + 600));
    let endT = startT;
    while (rainAt(w, endT) > 0.01) endT += 10;
    const atEnd = wetnessAt(w, endT);
    expect(wetnessAt(w, endT + 300)).toBeGreaterThan(atEnd * 0.5);
    expect(wetnessAt(w, endT + 3600)).toBeLessThan(atEnd * 0.1 + 0.01);
  });

  it('makes slicks best when dry, intermediates when damp and full wets when very wet', () => {
    const all = ['slick', 'inter', 'wet'] as const;
    expect(bestTyreType(0, all)).toBe('slick');
    expect(bestTyreType(0.35, all)).toBe('inter');
    expect(bestTyreType(0.9, all)).toBe('wet');
    // Without intermediates, wets take over from slicks.
    expect(bestTyreType(0.35, ['slick', 'wet'])).toBe('wet');
    expect(gripFactor('slick', 0)).toBe(1);
    expect(gripFactor('slick', 0.8)).toBeLessThan(gripFactor('wet', 0.8));
  });
});

describe('multi-class races', () => {
  const sim = runToEnd(multiClass([
    { vehicle: car('hypercar'), cars: 6, rules: calm(car('hypercar')) },
    { vehicle: car('gt3'), cars: 8, rules: calm(car('gt3')) },
  ], { kind: 'time', minutes: 40 }));

  it('puts the faster class in front on the grid, with unique numbers and codes', () => {
    expect(sim.classes.map((c) => c.label)).toEqual(['HYP', 'GT3']);
    const grid = sim.setup.grid.map((i) => sim.cars[i].cls.index);
    expect(grid).toEqual([...grid].sort((a, b) => a - b));
    const numbers = sim.cars.map((c) => c.entrant.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    const codes = sim.cars.flatMap((c) => c.entrant.drivers.map((d) => d.code));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(sim.cars.map((c) => c.entrant.teamIndex)).size).toBe(7);
  });

  it('keeps an order and positions per class', () => {
    for (const cls of sim.classes) {
      expect(cls.order.map((c) => c.classPosition)).toEqual(cls.order.map((_, i) => i + 1));
      expect(cls.order.every((c) => c.cls === cls)).toBe(true);
      expect(cls.fastest).not.toBeNull();
      expect(sim.classGap(cls.order[0]).kind).toBe('leader');
    }
    // The faster class laps the slower one.
    expect(sim.classes[0].order[0].lapsDone).toBeGreaterThan(sim.classes[1].order[0].lapsDone);
    const pos = positionsByLap(sim, true);
    for (const c of sim.cars) expect(pos.get(c.id)![0]).toBe(c.classGrid);
  });

  it('counts overtakes only between cars of the same class', () => {
    for (const e of sim.events.filter((x) => x.kind === 'overtake')) expect(sim.cars[e.car].cls).toBe(sim.cars[e.other!].cls);
    // Both classes run their own race lap: the GT3 laps are slower.
    expect(sim.classes[1].fastest!.time).toBeGreaterThan(sim.classes[0].fastest!.time);
  });
});

describe('endurance crews', () => {
  const rules = calm(car('hypercar'));
  const sim = race(car('hypercar'), { kind: 'time', minutes: 240, cars: 6 }, rules);

  it('shares the driving and changes drivers at stops', () => {
    for (const c of sim.cars) {
      expect(c.entrant.drivers).toHaveLength(3);
      expect(c.entrant.code).toBe(`#${c.entrant.number}`);
      const paces = c.entrant.drivers.map((d) => d.pace);
      expect(paces).toEqual([...paces].sort((a, b) => a - b));
      const times = sim.driveTimes(c);
      expect(times.reduce((a, b) => a + b, 0)).toBeCloseTo(c.finishTime ?? c.retired!.t, 0);
      // Out after contact in a failed pass (which calm rules do not switch off): no full race to check.
      if (c.status !== 'finished') continue;
      const stints = driverStints(sim).get(c.id)!;
      expect(stints.length).toBeGreaterThanOrEqual(2);
      // Nobody stays in the car much longer than the class's longest stint.
      for (const s of stints) {
        const from = s.from > 1 ? c.history[s.from - 2].at : 0;
        expect(c.history[s.to - 1].at - from).toBeLessThan(rules.pit.driverStint * 1.25);
      }
    }
    expect(sim.events.some((e) => e.kind === 'pit' && e.text.includes('takes over'))).toBe(true);
    expect(sim.stops.some((s) => s.driver !== null)).toBe(true);
  });

  it('takes a rolling start', () => {
    const c = sim.order[0];
    // No standing start: the first lap is close to the next ones. Accelerating from 100 km/h costs about 3 s here, a standing start about 5.5 s.
    expect(c.history[0].time - c.history[1].time).toBeLessThan(4);
  });
});

/** Runs a race step by step, calling `each` after every step. */
function watch(sim: RaceSim, each: (s: RaceSim) => void): RaceSim {
  while (!sim.finished) {
    sim.step();
    each(sim);
  }
  return sim;
}

describe('race control', () => {
  // Crash-prone rules, so neutralisations happen in a short race.
  const risky = (id: string) => {
    const r = raceRules(car(id));
    return { ...r, incidents: { ...r.incidents, crash: 0.03, off: 0, mistake: 0, dnfPerMetre: 0 } };
  };

  it('bunches the field behind the safety car, with no passing until racing resumes', () => {
    let queues = 0;
    const sim = watch(start(car('f1'), { laps: 25, cars: 16, seed: '5' }, risky('f1')), (s) => {
      const sc = s.safetyCar;
      if (!sc?.in) return;
      // When the safety car is about to come in, the cars behind it form a queue a few car lengths apart.
      const n = s.model.n;
      const ds = s.model.track.ds;
      const behind = s.cars.filter((c) => c.status === 'running').map((c) => ((sc.u - c.u) % n + n) % n).sort((a, b) => a - b);
      const gaps = behind.slice(1, 6).map((d, i) => (d - behind[i]) * ds);
      if (behind.length < 6 || behind[0] * ds > 80) return;
      gaps.sort((a, b) => a - b);
      expect(gaps[2]).toBeLessThan(60);
      queues++;
    });
    expect(sim.neutral.some((p) => p.kind === 'sc')).toBe(true);
    expect(queues).toBeGreaterThan(0);
    for (const p of sim.neutral) {
      const end = Number.isNaN(p.to) ? sim.t : p.to;
      const passes = sim.events.filter((e) => e.kind === 'overtake' && e.t > p.from + 5 && e.t < end);
      expect(passes).toHaveLength(0);
    }
    expect(sim.events.some((e) => e.kind === 'flag' && e.text.startsWith('Green flag'))).toBe(true);
    // The charts can shade the neutralised laps.
    for (const l of neutralLaps(sim)) expect(l.to).toBeGreaterThan(l.from);
  });

  it('holds everyone to the speed limit under a full course yellow', () => {
    const r = risky('gt3');
    let checked = 0;
    const inPit = new Set<number>();
    watch(start(car('gt3'), { kind: 'time', minutes: 30, cars: 14, seed: '3' }, { ...r, flags: { ...r.flags, safetyCar: false } }), (s) => {
      // A car leaving the pit lane moved partly along the lane in this step: skip that step.
      const leaving = new Set([...inPit].filter((id) => s.cars[id].status === 'running'));
      inPit.clear();
      for (const c of s.cars) if (c.status === 'pit') inPit.add(c.id);
      if (s.phase !== 'fcy') return;
      const since = s.neutral[s.neutral.length - 1].from;
      if (s.t - since < 8) return;
      // Distance along the racing line at a race progress.
      const line = s.model.line;
      const n = s.model.n;
      const along = (u: number) => {
        const k = Math.floor(u);
        const i = ((k % n) + n) % n;
        return Math.floor(k / n) * line.length + line.s[i] + (u - k) * line.ds[i];
      };
      for (const c of s.cars) {
        if (c.status !== 'running' || c.prevU === c.u || leaving.has(c.id)) continue;
        expect((along(c.u) - along(c.prevU)) / DT).toBeLessThan(r.flags.fcySpeed * 1.02);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(100);
  });

  it('shows yellows where cars go off, and none of it without incidents', () => {
    const quiet = race(car('gt4'), { kind: 'time', minutes: 20, cars: 10 }, calm(car('gt4')));
    expect(quiet.neutral).toHaveLength(0);
    expect(quiet.events.some((e) => e.kind === 'flag')).toBe(false);
  });
});

describe('racing in the rain', () => {
  it('starts a wet race on wet-weather tyres and laps slower than in the dry', () => {
    const rules = calm(car('f1'));
    const wet = race(car('f1'), { laps: 6, cars: 6, weather: 'wet', seed: '2' }, rules);
    const dry = race(car('f1'), { laps: 6, cars: 6, weather: 'dry', seed: '2' }, rules);
    for (const c of wet.cars) expect(c.rules.tyres.compounds[c.history[0].compound].type).not.toBe('slick');
    expect(wet.order[0].history[2].wet).toBeGreaterThan(0.3);
    expect(wet.fastest!.time).toBeGreaterThan(dry.fastest!.time * 1.05);
  });

  it('changes tyres when the rain comes and goes', () => {
    // Search a few seeds for a shower in a 40-minute race.
    let tested = 0;
    for (const seed of ['1', '2', '3', '4', '5', '6']) {
      const sim = race(car('gt3'), { kind: 'time', minutes: 40, cars: 8, weather: 'changeable', seed }, calm(car('gt3')));
      const wettest = Math.max(...sim.timeline.map((p) => p.wet));
      if (wettest < 0.5) continue;
      tested++;
      // Nobody stays long on slicks on a properly wet track.
      const soaked = sim.timeline.filter((p) => p.wet > 0.5);
      const onSlicks = soaked.reduce((a, p) => a + p.tyres[0], 0) / soaked.reduce((a, p) => a + p.tyres.reduce((x, y) => x + y, 0), 0);
      expect(onSlicks).toBeLessThan(0.25);
      expect(sim.stops.some((s) => s.to !== null && sim.cars[s.car].rules.tyres.compounds[s.to].type === 'wet')).toBe(true);
    }
    expect(tested).toBeGreaterThan(0);
  });
});
