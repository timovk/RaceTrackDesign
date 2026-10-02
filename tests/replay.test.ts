import { describe, expect, it } from 'vitest';
import { ReplayBuffer } from '../src/core/race/replay.ts';
import { DT } from '../src/core/race/sim.ts';
import { car, start } from './raceFixture.ts';

describe('replays', () => {
  it('draw the race as it was a few seconds ago, between two steps, from the last stretch only', () => {
    const sim = start(car('f1'), { laps: 3, cars: 6 });
    const buffer = new ReplayBuffer(10);
    const past = new Map<number, number[]>();
    for (let i = 0; i < 300; i++) {
      sim.step();
      buffer.record(sim);
      past.set(Math.round(sim.t / DT), sim.cars.map((c) => c.u));
    }
    expect(buffer.to).toBeCloseTo(sim.t, 9);
    expect(buffer.to - buffer.from).toBeLessThanOrEqual(10 + 2 * DT);
    expect(buffer.view(sim, sim.t - 15)).toBeNull();
    // Halfway between two steps five seconds ago.
    const t0 = buffer.to - 5;
    const r = buffer.view(sim, t0 + DT / 2)!;
    expect(r.alpha).toBeCloseTo(0.5, 6);
    const before = past.get(Math.round(t0 / DT))!;
    const after = past.get(Math.round(t0 / DT) + 1)!;
    r.view.cars.forEach((c, i) => {
      expect(c.prevU).toBe(before[i]);
      expect(c.u).toBe(after[i]);
      // The real car behind it, its live state untouched.
      expect(c.entrant).toBe(sim.cars[i].entrant);
      expect(c.id).toBe(i);
      expect(sim.cars[i].u).toBeGreaterThan(c.u);
      const pose = r.view.pose(c, r.alpha)!;
      expect(Number.isFinite(pose.x) && Number.isFinite(pose.y)).toBe(true);
    });
  });

  it('remember a car standing in its pit box', () => {
    const sim = start(car('f1'), { laps: 12, cars: 4 });
    const buffer = new ReplayBuffer(30);
    let stop: { id: number; t: number } | null = null;
    for (let i = 0; i < 60000 && !stop; i++) {
      sim.step();
      buffer.record(sim);
      const c = sim.cars.find((x) => x.pit?.stopped);
      if (c) stop = { id: c.id, t: sim.t };
    }
    expect(stop).not.toBeNull();
    // Drive on until the car has gone, then look back.
    for (let i = 0; i < 200; i++) {
      sim.step();
      buffer.record(sim);
    }
    const r = buffer.view(sim, stop!.t)!;
    const was = r.view.cars[stop!.id];
    expect(was.status).toBe('pit');
    expect(was.pit?.stopped).toBe(true);
    expect(sim.cars[stop!.id].pit?.stopped ?? false).toBe(false);
  });
});
