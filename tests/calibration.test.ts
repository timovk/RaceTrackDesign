import { describe, expect, it } from 'vitest';
import { evaluate, formatLapTime, parseLapTime, rmsError } from '../src/core/calibration.ts';
import { analyseTrack } from '../src/core/analysis.ts';
import { simulateLap } from '../src/core/lapSim.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { loadCircuit, loadCircuits, loadReferenceLaps } from '../scripts/circuitData.ts';

describe('lap time text', () => {
  it('parses and formats lap times', () => {
    expect(parseLapTime('1:18.792')).toBeCloseTo(78.792, 9);
    expect(parseLapTime('48.467')).toBeCloseTo(48.467, 9);
    expect(formatLapTime(78.792)).toBe('1:18.792');
    expect(formatLapTime(48.4671)).toBe('48.467');
    expect(formatLapTime(60.0004)).toBe('1:00.000');
    expect(() => parseLapTime('fast')).toThrow();
  });
});

describe('real circuits', () => {
  it('match their official lengths and directions', () => {
    const monza = loadCircuit('Monza');
    const austin = loadCircuit('Austin');
    expect(monza.track.length).toBeGreaterThan(5793 * 0.995);
    expect(monza.track.length).toBeLessThan(5793 * 1.005);
    expect(austin.track.length).toBeGreaterThan(5513 * 0.995);
    expect(austin.track.length).toBeLessThan(5513 * 1.005);
    expect(analyseTrack(monza.track).direction).toBe('clockwise');
    expect(analyseTrack(austin.track).direction).toBe('anticlockwise');
  });

  it('reaches realistic top speeds at Monza', () => {
    // Qualifying speed traps at Monza, roughly: F1 about 350 km/h with DRS, GT3 about 280, TCR about 250.
    const monza = loadCircuit('Monza');
    const top = (id: string) => simulateLap(monza.track, monza.line, VEHICLES.find((v) => v.id === id)!).topSpeed * 3.6;
    expect(top('f1')).toBeGreaterThan(335);
    expect(top('f1')).toBeLessThan(360);
    expect(top('gt3')).toBeGreaterThan(265);
    expect(top('gt3')).toBeLessThan(295);
    expect(top('tcr')).toBeGreaterThan(235);
    expect(top('tcr')).toBeLessThan(265);
  });
});

describe('calibration against real qualifying laps', () => {
  const refs = loadReferenceLaps();
  const circuits = loadCircuits(new Set(refs.map((r) => r.circuit)));

  for (const car of VEHICLES) {
    it(`${car.name} stays close to real lap times`, () => {
      const rows = evaluate(car, circuits, refs);
      expect(rows.length).toBeGreaterThan(0);
      // Whole-class accuracy, and no single circuit far off (the circuit data itself has errors; Bahrain is the worst).
      expect(rmsError(rows)).toBeLessThan(0.025);
      for (const r of rows.filter((x) => x.ref.fit)) expect(Math.abs(r.error)).toBeLessThan(0.05);
    });
  }
});
