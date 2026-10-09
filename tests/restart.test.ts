import { describe, expect, it } from 'vitest';
import type { RaceRules } from '../src/core/race/rules.ts';
import { type RaceCar, type RaceSim, mod } from '../src/core/race/sim.ts';
import { calm, car, start } from './raceFixture.ts';

/** Calm rules with the series' way of restarting and of dealing with lapped cars. */
function rules(lapped: RaceRules['flags']['lapped'], restart: RaceRules['flags']['restart'] = 'leader'): RaceRules {
  const base = calm(car('f1'));
  return { ...base, flags: { ...base.flags, lapped, restart } };
}

/** What race control is allowed to do in a test: send the safety car out, and stop the race. */
interface Control {
  deploySafetyCar(t: number, clearance: number, reason: string): void;
  redFlag(t: number, reason: string): void;
}

interface Watched {
  sim: RaceSim;
  /** The car that was held up early on, so that it is a lap down when the safety car comes out (null when none was). */
  slow: RaceCar | null;
  /** Race time of the green flag after the safety car, and the cars then: the leader, and the queue behind it front to back. */
  green: number;
  leader: RaceCar;
  queue: RaceCar[];
  /** At the green flag: metres from the leader to the line, its speed, and the speed it had with the safety car still ahead of it. */
  toLine: number;
  leaderV: number;
  queueV: number;
  /** Bodies through each other while cars were being sent round, seconds. */
  overlap: number;
  /** The order in which the queue crossed the line after the green flag. */
  overLine: number[];
  /** Laps the slow car was behind the leader when the safety car came out, and at the green flag. */
  downBefore: number;
  downAfter: number;
  /** The most cars ever between the safety car and the car that led the race, once the safety car was in this lap. */
  between: number;
  /** Largest gap in the queue when the safety car said it was coming in, metres. */
  widest: number;
}

/**
 * A race of 14 cars with a safety car from `at` seconds: watched until 100 s
 * after the green flag. With `slow`, the last car on the grid is held up by
 * that many seconds after a minute, which puts it a lap down.
 */
function watch(seed: string, r: RaceRules, slow: number | null, at = 300): Watched {
  const sim = start(car('f1'), { kind: 'laps', laps: 30, cars: 14, seed }, r);
  const n = sim.model.n;
  const ds = sim.model.track.ds;
  const w: Watched = {
    sim, slow: null, green: NaN, leader: sim.cars[0], queue: [], toLine: NaN, leaderV: NaN, queueV: NaN, overlap: 0, overLine: [], downBefore: NaN, downAfter: NaN, between: 0, widest: NaN,
  };
  let out = false;
  let last = sim.phase;
  while (!sim.finished) {
    sim.step();
    if (slow !== null && !w.slow && sim.t >= 60) {
      w.slow = sim.order[sim.order.length - 1];
      w.slow.delay += slow;
      w.slow.delayShare = 0.9;
    }
    if (!out && sim.t >= at && sim.phase === 'green') {
      out = true;
      if (w.slow) w.downBefore = Math.floor((sim.order[0].u - w.slow.u) / n);
      (sim as unknown as Control).deploySafetyCar(sim.t, 60, 'test');
    }
    const sc = sim.safetyCar;
    if (out && sc && Number.isNaN(w.green)) {
      const running = sim.cars.filter((c) => c.status === 'running');
      const first = running.filter((c) => c.unlapping === 0 && !c.catchingUp).sort((a, b) => mod(sc.u - a.u, n) - mod(sc.u - b.u, n))[0];
      if (first && !sc.in) w.queueV = first.v;
      if (sc.in && Number.isNaN(w.widest)) {
        const behind = running.filter((c) => c.unlapping === 0 && !c.catchingUp).map((c) => mod(sc.u - c.u, n) * ds).sort((a, b) => a - b);
        w.widest = Math.max(...behind.map((d, i) => d - (behind[i - 1] ?? 0)));
      }
      if (sc.in) {
        const lead = sim.order.find((c) => c.status === 'running')!;
        w.between = Math.max(w.between, running.filter((c) => c !== lead && c.unlapping === 0 && mod(sc.u - c.u, n) < mod(sc.u - lead.u, n)).length);
      }
      // Cars sent round, against everyone else: bodies through each other.
      for (const c of running) {
        if (c.unlapping === 0) continue;
        for (const o of running) {
          if (o === c) continue;
          let d = mod(c.u - o.u, n);
          if (d > n / 2) d -= n;
          if (Math.abs(d * ds) < (c.cls.length + o.cls.length) / 2 - 0.5 && Math.abs(c.lateral - o.lateral) < c.cls.half + o.cls.half - 0.3) w.overlap += 0.1;
        }
      }
    }
    if (out && last === 'sc' && sim.phase === 'green' && Number.isNaN(w.green)) {
      w.green = sim.t;
      w.leader = sim.order.find((c) => c.status === 'running')!;
      w.queue = sim.cars.filter((c) => c.status === 'running' && c !== w.leader && mod(w.leader.u - c.u, n) * ds < 400).sort((a, b) => mod(w.leader.u - a.u, n) - mod(w.leader.u - b.u, n));
      w.toLine = mod(-w.leader.u, n) * ds;
      w.leaderV = w.leader.v;
      if (w.slow) w.downAfter = Math.floor((w.leader.u - w.slow.u) / n);
    }
    if (!Number.isNaN(w.green)) {
      for (const c of [w.leader, ...w.queue]) if (!w.overLine.includes(c.id) && c.status === 'running' && mod(c.u, n) * ds < 200 && mod(c.prevU, n) > mod(c.u, n)) w.overLine.push(c.id);
      if (sim.t > w.green + 100) break;
    }
    last = sim.phase;
  }
  return w;
}

const said = (sim: RaceSim, text: RegExp) => sim.events.filter((e) => e.kind === 'flag' && text.test(e.text));

describe('a rolling restart', () => {
  const seeds = ['1', '2', '3'];
  const runs = seeds.map((seed) => watch(seed, rules(null), null));

  it('has the leader hold the field up and go before the line, when it chooses', () => {
    const goes = new Set<number>();
    for (const w of runs) {
      expect(said(w.sim, /^Safety car in this lap/)).toHaveLength(1);
      expect(said(w.sim, /^Green flag/)).toHaveLength(1);
      // Somewhere over the last few hundred metres, not at the line.
      expect(w.toLine).toBeGreaterThan(30);
      expect(w.toLine).toBeLessThan(400);
      goes.add(Math.round(w.toLine / 10));
      // Well below the speed it followed the safety car at.
      expect(w.leaderV).toBeLessThan(38);
      expect(w.leaderV).toBeLessThan(0.8 * w.queueV);
      // The field has closed up on it.
      expect(w.queue.length).toBeGreaterThan(8);
    }
    expect(goes.size).toBeGreaterThan(1);
  });

  it('has every driver behind follow a moment later, and nobody pass before the line', () => {
    for (const w of runs) {
      const delays = w.queue.map((c) => c.reactUntil - w.green);
      for (const d of delays) {
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThan(1.2);
      }
      expect(new Set(delays.map((d) => d.toFixed(3))).size).toBeGreaterThan(5);
      // Over the line in the order they were in when the leader went.
      expect(w.overLine).toEqual([w.leader, ...w.queue].map((c) => c.id));
      const neutral = w.sim.neutral.find((p) => p.kind === 'sc')!;
      expect(neutral.to).toBeCloseTo(w.green, 0);
      expect(w.sim.events.filter((e) => e.kind === 'overtake' && e.t > neutral.from + 5 && e.t < w.green + 1)).toHaveLength(0);
    }
    // Then they race: places change hands in the laps after it.
    expect(runs.reduce((s, w) => s + w.sim.events.filter((e) => e.kind === 'overtake' && e.t > w.green).length, 0)).toBeGreaterThan(3);
  });

  it('has the leader keep its pace up to a restart zone where the series restarts that way', () => {
    const zone = watch('1', rules(null, 'zone'), null);
    expect(zone.toLine).toBeGreaterThan(100);
    expect(zone.toLine).toBeLessThan(310);
    expect(zone.leaderV).toBeGreaterThan(0.9 * zone.queueV);
    expect(zone.leaderV).toBeGreaterThan(runs[0].leaderV + 5);
  });

  it('waits for the field to close up behind the safety car before it comes in', () => {
    for (const w of runs) expect(w.widest).toBeLessThan(125);
  });
});

describe('lapped cars behind the safety car', () => {
  it('are sent past the queue and the safety car to get their lap back, where the series does that', () => {
    for (const seed of ['1', '2', '3']) {
      const w = watch(seed, rules('overtake'), 75);
      expect(w.downBefore).toBe(1);
      const told = said(w.sim, /^Lapped cars may now overtake/);
      expect(told).toHaveLength(1);
      expect(told[0].text).toContain(w.slow!.entrant.code);
      // The safety car stays out a lap for it.
      const coming = said(w.sim, /^Safety car in this lap/)[0];
      expect(coming.t - told[0].t).toBeGreaterThan(0.7 * w.sim.model.lapTime);
      // Back on the lead lap, behind the field, without driving through anybody.
      expect(w.downAfter).toBe(0);
      expect(w.leader).not.toBe(w.slow);
      if (w.queue.includes(w.slow!)) expect(w.queue[w.queue.length - 1]).toBe(w.slow);
      expect(w.overlap).toBeLessThan(0.35);
      expect(w.slow!.unlapping).toBe(0);
      expect(w.slow!.catchingUp).toBe(false);
    }
  });

  it('stay a lap down where it does not', () => {
    const w = watch('1', rules(null), 75);
    expect(w.downBefore).toBe(1);
    expect(w.downAfter).toBe(1);
    expect(said(w.sim, /Lapped cars|Pass-around/)).toHaveLength(0);
  });

  it('are never left between the safety car and the leader for the restart', () => {
    // The last car is held up until the leader is right behind it on the road, then the safety car comes out ahead of both.
    for (const how of [null, 'overtake'] as const) {
      // (No stops, so the car stays where the safety car found it.)
      const base = rules(how);
      const noStops: RaceRules = { ...base, pit: { ...base.pit, stops: false, minStops: 0 }, tyres: { ...base.tyres, mustUseTwo: false } };
      const sim = start(car('f1'), { kind: 'laps', laps: 30, cars: 14, seed: '1' }, noStops);
      const n = sim.model.n;
      const ds = sim.model.track.ds;
      let slow: RaceCar | null = null;
      let out = false;
      let wasBetween = false;
      let between = 0;
      let green = NaN;
      let last = sim.phase;
      while (!sim.finished) {
        sim.step();
        const lead = sim.order.find((c) => c.status === 'running');
        if (!lead) break;
        if (!slow && sim.t >= 30) slow = sim.order[sim.order.length - 1];
        if (slow && !out) {
          const gap = mod(slow.u - lead.u, n) * ds;
          if (gap > 100 || lead.u - slow.u < n / 2) {
            slow.delay = 2;
            slow.delayShare = 0.9;
          } else {
            slow.delay = 0;
            out = true;
            (sim as unknown as Control).deploySafetyCar(sim.t, 60, 'test');
          }
        }
        const sc = sim.safetyCar;
        const cut = sc && slow ? mod(sc.u - slow.u, n) < mod(sc.u - lead.u, n) && slow.unlapping === 0 && slow.status === 'running' : false;
        if (sc && !sc.in) wasBetween ||= cut;
        if (sc?.in && cut) between++;
        if (out && last === 'sc' && sim.phase === 'green') {
          green = sim.t;
          break;
        }
        last = sim.phase;
      }
      expect(out).toBe(true);
      expect(Number.isNaN(green)).toBe(false);
      expect(wasBetween).toBe(true);
      expect(between).toBe(0);
      const waved = said(sim, /^Waved past the safety car/);
      expect(waved).toHaveLength(1);
      expect(waved[0].text).toContain(slow!.entrant.code);
    }
  });
});

describe('a standing restart', () => {
  const standing = (): RaceRules => {
    const base = rules(null);
    return { ...base, weekend: { ...base.weekend, redFlag: { ...base.weekend.redFlag, restart: 'standing', rollingWhenWet: false, clear: [60, 60] } } };
  };
  const sim = start(car('f1'), { kind: 'laps', laps: 30, cars: 14, seed: '2' }, standing());
  const n = sim.model.n;
  const ds = sim.model.track.ds;
  let slow: RaceCar | null = null;
  let stopped = false;
  let forming = NaN;
  let lights = NaN;
  let lapsWhenForming = -1;
  let lapsToGrid = NaN;
  let downOnGrid = NaN;
  let firstCorner = NaN;
  let spread = 0;
  let down = NaN;
  while (!sim.finished) {
    sim.step();
    if (!slow && sim.t >= 60) {
      slow = sim.order[sim.order.length - 1];
      slow.delay += 75;
      slow.delayShare = 0.9;
    }
    if (!stopped && sim.t >= 300 && sim.phase === 'green') {
      stopped = true;
      down = Math.floor((sim.order[0].u - slow!.u) / n);
      (sim as unknown as Control).redFlag(sim.t, 'test');
    }
    if (stopped && sim.regrid && Number.isNaN(sim.regrid.lights) && Number.isNaN(forming)) {
      forming = sim.t;
      lapsWhenForming = slow!.lapsDone;
    }
    if (!Number.isNaN(forming) && Number.isNaN(lights) && !sim.regrid) {
      lights = sim.t;
      lapsToGrid = slow!.lapsDone - lapsWhenForming;
      downOnGrid = Math.floor((sim.order.find((c) => c.status === 'running')!.u - slow!.u) / n);
    }
    if (!Number.isNaN(lights)) {
      const lead = sim.order.find((c) => c.status === 'running')!;
      if (Number.isNaN(firstCorner) && lead.u >= lead.gridUntilU) firstCorner = sim.t;
      // On the way to the first corner: how far across the road the field is spread, beyond the two files of the grid.
      if (Number.isNaN(firstCorner)) {
        const lat = sim.cars.filter((c) => c.status === 'running').map((c) => c.lateral + sim.model.line.offset[mod(Math.floor(c.u), n)]);
        spread = Math.max(spread, Math.max(...lat) - Math.min(...lat));
      }
      if (sim.t > lights + 90) break;
    }
  }

  it('takes its cars to the grid in race order, a lapped car to its own slot a lap down', () => {
    expect(down).toBe(1);
    expect(Number.isNaN(lights)).toBe(false);
    // It does not drive a lap through the cars standing on the grid to get there.
    expect(lapsToGrid).toBe(0);
    expect(downOnGrid).toBe(1);
    expect(lights - forming).toBeLessThan(100);
    expect(sim.events.some((e) => e.kind === 'start' && e.text.startsWith('Lights out: the race restarts'))).toBe(true);
  });

  it('gets away as at the start: the field fans out, and places before the first corner go as the starts do', () => {
    expect(Number.isNaN(firstCorner)).toBe(false);
    expect(spread).toBeGreaterThan(5);
    // No overtake is counted on the run from the grid to the first corner; after it they are.
    expect(sim.events.filter((e) => e.kind === 'overtake' && e.t >= lights && e.t < firstCorner)).toHaveLength(0);
    expect(sim.events.filter((e) => e.kind === 'overtake' && e.t >= firstCorner).length).toBeGreaterThan(0);
    for (const c of sim.cars) if (c.status === 'running') expect(c.gridUntilU).toBeGreaterThan(n);
    void ds;
  });
});

describe('the pit lane under a safety car', () => {
  it('is entered one car behind the other, and for a cheap stop once', () => {
    const base = rules(null);
    const sim = start(car('f1'), { kind: 'laps', laps: 30, cars: 14, seed: '3' }, base);
    const n = sim.model.n;
    const ds = sim.model.track.ds;
    let out = false;
    let overlap = 0;
    while (!sim.finished) {
      sim.step();
      if (!out && sim.t >= 500 && sim.phase === 'green') {
        out = true;
        (sim as unknown as Control).deploySafetyCar(sim.t, 200, 'test');
      }
      const pitting = sim.cars.filter((c) => c.status === 'running' && c.pitRequest !== null);
      for (let i = 0; i < pitting.length; i++) {
        for (let j = i + 1; j < pitting.length; j++) {
          let d = mod(pitting[i].u - pitting[j].u, n);
          if (d > n / 2) d -= n;
          if (Math.abs(d * ds) < 4 && Math.abs(pitting[i].lateral - pitting[j].lateral) < 1.5) overlap += 0.1;
        }
      }
    }
    expect(out).toBe(true);
    const sc = sim.neutral.find((p) => p.kind === 'sc')!;
    const during = sim.stops.filter((s) => s.entry >= sc.from && s.entry <= sc.to);
    expect(during.length).toBeGreaterThan(2);
    for (const c of sim.cars) expect(during.filter((s) => s.car === c.id).length).toBeLessThanOrEqual(1);
    expect(overlap).toBeLessThan(1);
  });
});
