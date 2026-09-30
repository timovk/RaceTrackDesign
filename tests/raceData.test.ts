import { describe, expect, it } from 'vitest';
import { lapsCsv, resultsCsv, telemetryCsv, toCsv } from '../src/core/race/export.ts';
import { fastestLaps, gapsByLap, overtakeCounts, pitStops, positionsByLap, speedTraps, stints } from '../src/core/race/stats.ts';
import { deltaTime, lapTelemetry, resolveLap } from '../src/core/race/telemetry.ts';
import { calm, car, race } from './raceFixture.ts';

const f1 = race(car('f1'), { laps: 30, cars: 10 });
// One car, no stops (so no lap runs through the pit lane).
const quiet = calm(car('f1'));
const alone = race(car('f1'), { laps: 4, cars: 1 }, { ...quiet, pit: { ...quiet.pit, stops: false }, tyres: { ...quiet.tyres, mustUseTwo: false } });

describe('recording', () => {
  it('keeps a telemetry trace and a lap record for every lap', () => {
    for (const c of f1.cars) {
      expect(c.traces).toHaveLength(c.lapsDone);
      expect(c.history).toHaveLength(c.lapsDone);
    }
    const c = f1.order[0];
    const trace = c.traces[5];
    expect(trace[0]).toBe(0);
    for (let i = 1; i < trace.length; i++) expect(trace[i]).toBeGreaterThan(trace[i - 1]);
    expect(trace[trace.length - 1]).toBeLessThan(c.history[5].time);
  });

  it('times each lap\'s leader and the gaps behind', () => {
    expect(f1.lapLeaders).toHaveLength(f1.order[0].lapsDone);
    for (const c of f1.cars) for (const h of c.history) expect(h.gap).toBeGreaterThanOrEqual(0);
    expect(f1.order[0].history.some((h) => h.gap === 0)).toBe(true);
  });

  it('records pit stops with the time in the box and in the lane', () => {
    const done = f1.stops.filter((s) => Number.isFinite(s.exit));
    expect(done.length).toBeGreaterThan(0);
    for (const s of done) {
      expect(s.stationary).toBeGreaterThan(1.5);
      expect(s.exit - s.entry).toBeGreaterThan(s.stationary + 5);
    }
    expect(f1.stops.length).toBe(f1.cars.reduce((a, c) => a + c.stops + (c.status === 'pit' ? 1 : 0), 0));
  });
});

describe('telemetry', () => {
  const c = alone.cars[0];
  const lap = lapTelemetry(alone, c, 3)!;

  it('turns the trace into speed, pedals, gear and g-forces', () => {
    expect(lap.complete).toBe(true);
    expect(lap.count).toBe(lap.x.length);
    const m = alone.model;
    let top = 0;
    let min = Infinity;
    for (let i = 0; i < lap.count; i++) {
      top = Math.max(top, lap.v[i]);
      min = Math.min(min, lap.v[i]);
      expect(lap.throttle[i] === 0 || lap.brake[i] === 0).toBe(true);
      expect(lap.gear[i]).toBeGreaterThanOrEqual(1);
    }
    // Close to the race lap's own top and minimum speeds.
    let vTop = 0;
    let vMin = Infinity;
    for (let k = 0; k < m.n; k++) {
      vTop = Math.max(vTop, m.v[k]);
      vMin = Math.min(vMin, m.v[k]);
    }
    expect(top / vTop).toBeGreaterThan(0.93);
    expect(top / vTop).toBeLessThan(1.02);
    expect(min / vMin).toBeGreaterThan(0.85);
    expect(min / vMin).toBeLessThan(1.1);
    // Hard braking into a corner and a few g sideways through it.
    let maxBrakeG = 0;
    let maxLatG = 0;
    for (let i = 0; i < lap.count; i++) {
      maxBrakeG = Math.max(maxBrakeG, -lap.lonG[i]);
      maxLatG = Math.max(maxLatG, Math.abs(lap.latG[i]));
    }
    expect(maxBrakeG).toBeGreaterThan(2);
    expect(maxLatG).toBeGreaterThan(1.5);
  });

  it('picks the last, best and current lap', () => {
    expect(resolveLap(c, 'last')).toBe(4);
    expect(resolveLap(c, 'current')).toBeNull();
    const best = resolveLap(c, 'best')!;
    expect(c.history[best - 1].time).toBe(Math.min(...c.history.map((h) => h.time)));
    expect(resolveLap(c, 9)).toBeNull();
  });

  it('shows no delta against itself and the lap-time difference at the line', () => {
    const other = lapTelemetry(alone, c, 2)!;
    expect([...deltaTime(lap, lap)].every((d) => d === 0)).toBe(true);
    const delta = deltaTime(lap, other);
    expect(delta[delta.length - 1]).toBeCloseTo(c.history[1].time - c.history[2].time, 9);
  });
});

describe('statistics', () => {
  it('ranks fastest laps and speed-trap speeds', () => {
    const fl = fastestLaps(f1);
    expect(fl[0].time).toBe(f1.fastest!.time);
    for (let i = 1; i < fl.length; i++) expect(fl[i].time).toBeGreaterThanOrEqual(fl[i - 1].time);
    const traps = speedTraps(f1);
    expect(traps.length).toBeGreaterThan(0);
    expect(traps[0].speed * 3.6).toBeGreaterThan(250);
    // A car with DRS open in another's slipstream goes a few percent past its own top speed.
    expect(traps[0].speed).toBeLessThanOrEqual(car('f1').topSpeed * 1.07);
  });

  it('counts overtakes both ways', () => {
    const counts = overtakeCounts(f1);
    const made = counts.reduce((a, c) => a + c.made, 0);
    const lost = counts.reduce((a, c) => a + c.lost, 0);
    expect(made).toBe(f1.events.filter((e) => e.kind === 'overtake').length);
    expect(lost).toBe(made);
  });

  it('builds the chart series', () => {
    const pos = positionsByLap(f1);
    const gaps = gapsByLap(f1);
    const tyres = stints(f1);
    for (const c of f1.cars) {
      expect(pos.get(c.id)![0]).toBe(c.gridPosition);
      expect(pos.get(c.id)).toHaveLength(c.lapsDone + 1);
      expect(gaps.get(c.id)).toHaveLength(c.lapsDone);
      const s = tyres.get(c.id)!;
      if (c.lapsDone > 0) {
        expect(s[0].from).toBe(1);
        expect(s[s.length - 1].to).toBe(c.lapsDone);
        // One stint more than stops that changed tyres, give or take a stop on the last lap.
        const changes = f1.stops.filter((x) => x.car === c.id && x.to !== null && Number.isFinite(x.exit)).length;
        expect(s.length).toBeGreaterThanOrEqual(Math.min(changes, 1));
        expect(s.length).toBeLessThanOrEqual(changes + 1);
      }
    }
    expect(pitStops(f1).every((s, i, a) => i === 0 || s.stationary >= a[i - 1].stationary)).toBe(true);
  });
});

describe('export', () => {
  it('writes CSV with quoting where needed', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', 1.5, null, NaN]])).toBe('a,"b,c","say ""hi""",1.5,,\r\n');
  });

  it('exports the classification and every lap', () => {
    const results = resultsCsv(f1).trim().split('\r\n');
    expect(results).toHaveLength(f1.cars.length + 1);
    expect(results[0]).toMatch(/^Position,Number,Driver/);
    expect(results[1].split(',')[0]).toBe('1');
    const laps = lapsCsv(f1).trim().split('\r\n');
    expect(laps).toHaveLength(1 + f1.cars.reduce((a, c) => a + c.history.length, 0));
  });

  it('exports telemetry with a comparison and the delta', () => {
    const c = alone.cars[0];
    const a = lapTelemetry(alone, c, 3)!;
    const b = lapTelemetry(alone, c, 2)!;
    const text = telemetryCsv(a, b, deltaTime(a, b), 'L3', 'L2').trim().split('\r\n');
    expect(text[0].split(',')).toHaveLength(1 + 7 + 7 + 1);
    expect(text).toHaveLength(a.x.length + 1);
  });
});
