import { describe, expect, it } from 'vitest';
import { ReplayBuffer } from '../src/core/race/replay.ts';
import { DT } from '../src/core/race/sim.ts';
import { calm, car, start } from './raceFixture.ts';

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

  it('keep a stretch that was asked for long after the rest is gone', () => {
    const sim = start(car('f1'), { laps: 6, cars: 6 });
    const buffer = new ReplayBuffer(10);
    const past = new Map<number, number[]>();
    let at = NaN;
    for (let i = 0; i < 1500; i++) {
      sim.step();
      buffer.record(sim);
      past.set(Math.round(sim.t / DT), sim.cars.map((c) => c.u));
      // Asked for a moment after it happened, with its end still to come.
      if (i === 300) {
        at = sim.t;
        buffer.keep(at - 4, at + 5);
      }
    }
    expect(buffer.from).toBeGreaterThan(at + 60);
    // The stretch itself is still there, step for step; what was around it is not.
    // (Halfway between two steps each time: the step before, and the one after.)
    for (const [t, step] of [[at - 4 + DT / 2, at - 4], [at + DT / 2, at], [at + 4.8 + DT / 2, at + 4.8]]) {
      const r = buffer.view(sim, t)!;
      expect(r).not.toBeNull();
      const k = Math.round(step / DT);
      r.view.cars.forEach((c, i) => {
        expect(c.prevU).toBe(past.get(k)![i]);
        expect(c.u).toBe(past.get(k + 1)![i]);
      });
    }
    expect(buffer.view(sim, at - 6)).toBeNull();
    expect(buffer.view(sim, at + 8)).toBeNull();
    // And the last ten seconds as ever.
    expect(buffer.view(sim, sim.t - 3)).not.toBeNull();
    // A new race forgets it.
    buffer.clear();
    expect(buffer.view(sim, at)).toBeNull();
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

  it('remember a car spinning off the road', () => {
    // A driver alone who gets every corner wrong: sooner or later a spin.
    const base = calm(car('f1'));
    const rules = { ...base, incidents: { ...base.incidents, off: 1000 }, pit: { ...base.pit, stops: false, minStops: 0 } };
    const sim = start(car('f1'), { kind: 'laps', laps: 8, cars: 1 }, rules);
    const c = sim.cars[0];
    const buffer = new ReplayBuffer(30);
    let spun: { t: number; yaw: number; lateral: number } | null = null;
    for (let i = 0; i < 6000 && !spun; i++) {
      sim.step();
      buffer.record(sim);
      if (c.spin && Math.abs(c.yaw) > 2 && c.v === 0) spun = { t: sim.t, yaw: c.yaw, lateral: c.lateral };
    }
    expect(spun).not.toBeNull();
    // On until it is back on the road and facing ahead, then look back.
    for (let i = 0; i < 280 && (c.offTrack || c.yaw !== 0); i++) {
      sim.step();
      buffer.record(sim);
    }
    expect(c.offTrack).toBe(false);
    expect(c.yaw).toBe(0);
    const r = buffer.view(sim, spun!.t)!;
    const was = r.view.cars[0];
    expect(was.yaw).toBe(spun!.yaw);
    expect(was.offTrack).toBe(true);
    expect(was.lateral).toBe(spun!.lateral);
    // Drawn turned round where it stood, not pointing along the track.
    const pose = r.view.pose(was, r.alpha)!;
    const along = r.view.pose(Object.assign(Object.create(was), { yaw: 0, prevYaw: 0 }), r.alpha)!;
    expect(Math.abs(pose.heading - along.heading)).toBeCloseTo(Math.abs(spun!.yaw), 6);
    expect(pose.x).toBe(along.x);
  });
});
