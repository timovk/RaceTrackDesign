import { describe, expect, it } from 'vitest';
import { analyseTrack } from '../src/core/analysis.ts';
import { drsStations, gearTopSpeeds, GRAVITY, simulateLap, simulateLapAtTrim } from '../src/core/lapSim.ts';
import { placeSectors, sectorTimes, analysePerformance } from '../src/core/performance.ts';
import { computeRacingLine } from '../src/core/racingLine.ts';
import { buildTrack, type Track } from '../src/core/track.ts';
import { VEHICLES, parseVehicleFile, parseVehicleSpec, type VehicleClass } from '../src/core/vehicles.ts';
import { Turtle, chicaneCircuit, circlePoints, design } from './helpers.ts';

const flat = () => 0;
const track = (pts: ReturnType<typeof circlePoints>): Track => buildTrack(design(pts, { smoothing: 0, maxCutFill: 0 }), flat)!;

/** A simple car: no aero, no load sensitivity, so cornering speed is sqrt(grip * g * R). */
const simpleCar = (overrides: Partial<VehicleClass> = {}): VehicleClass => ({
  id: 'test', name: 'Test', spec: '', kind: 'car', color: '#fff',
  mass: 1000, power: 300_000, cdA: [0.8, 0.8], clA: [0, 0], grip: 1.2, loadSensitivity: 0,
  driveShare: 0.6, rollingResistance: 0, maxAccelG: null, maxBrakeG: null, drs: 0,
  topSpeed: 300 / 3.6, gears: 6, firstGearSpeed: 90 / 3.6, calibration: null,
  ...overrides,
});

describe('racing line', () => {
  it('stays inside the track edges', () => {
    const t = track(chicaneCircuit());
    const line = computeRacingLine(t);
    for (let k = 0; k < t.n; k++) expect(Math.abs(line.offset[k])).toBeLessThanOrEqual(t.width[k] / 2 - 1.2 + 1e-6);
  });

  it('runs round the outside of a circular track, where the curvature is lowest', () => {
    const t = track(circlePoints(4096, 4096, 300, 16, 14));
    const line = computeRacingLine(t);
    // A clockwise circle turns right, so the outside is the left: positive offsets.
    let mean = 0;
    for (let k = 0; k < t.n; k++) mean += line.offset[k] / t.n;
    expect(mean).toBeGreaterThan(14 / 2 - 1.2 - 0.3);
  });

  it('opens up corners: the line is gentler than the centreline', () => {
    const pts = new Turtle(2000, 2000, 0, 5).straight(400).arc(20, 90).straight(400).arc(20, 90)
      .straight(400).arc(20, 90).straight(400).arc(20, 90).close().map((p) => ({ ...p, width: 16 }));
    const t = track(pts);
    const line = computeRacingLine(t);
    let maxCentre = 0;
    let maxLine = 0;
    for (let k = 0; k < t.n; k++) {
      maxCentre = Math.max(maxCentre, Math.abs(t.curvature[k]));
      maxLine = Math.max(maxLine, Math.abs(line.curvature[k]));
    }
    expect(1 / maxLine).toBeGreaterThan(1.4 / maxCentre);
    expect(line.length).toBeLessThan(t.length);
  });
});

describe('lap simulation', () => {
  it('drives a circle at the grip-limited speed', () => {
    const t = track(circlePoints(4096, 4096, 200, 24, 12));
    const line = computeRacingLine(t);
    const car = simpleCar();
    const lap = simulateLap(t, line, car);
    let meanR = 0;
    for (let k = 0; k < t.n; k++) meanR += 1 / Math.abs(line.curvature[k]) / t.n;
    const expected = Math.sqrt(car.grip * GRAVITY * meanR);
    expect(lap.minSpeed).toBeGreaterThan(expected * 0.97);
    expect(lap.topSpeed).toBeLessThan(expected * 1.03);
    expect(lap.time).toBeCloseTo(line.length / expected, 0);
  });

  it('reaches the power-limited top speed on a long straight', () => {
    const pts = new Turtle(500, 4000, 0, 20).straight(6000).arc(150, 180).straight(6000).arc(150, 180).close();
    const t = track(pts);
    const line = computeRacingLine(t);
    const car = simpleCar({ topSpeed: 500 / 3.6 });
    const lap = simulateLap(t, line, car);
    // Power = drag at top speed: v = (P / (0.5 rho CdA))^(1/3).
    const vMax = Math.cbrt(car.power / (0.5 * 1.2 * car.cdA[0]));
    expect(lap.topSpeed).toBeGreaterThan(vMax * 0.95);
    expect(lap.topSpeed).toBeLessThan(vMax * 1.001);
  });

  it('keeps channels in range and time increasing', () => {
    const t = track(chicaneCircuit());
    const lap = simulateLap(t, computeRacingLine(t), VEHICLES.find((v) => v.id === 'gt3')!);
    for (let k = 0; k < t.n; k++) {
      expect(lap.throttle[k]).toBeGreaterThanOrEqual(0);
      expect(lap.throttle[k]).toBeLessThanOrEqual(1);
      expect(lap.brake[k]).toBeGreaterThanOrEqual(0);
      expect(lap.brake[k]).toBeLessThanOrEqual(1);
      expect(lap.throttle[k] > 0 && lap.brake[k] > 0).toBe(false);
      expect(lap.gear[k]).toBeGreaterThanOrEqual(1);
      expect(lap.gear[k]).toBeLessThanOrEqual(6);
      if (k > 0) expect(lap.t[k]).toBeGreaterThan(lap.t[k - 1]);
    }
    expect(lap.brakingZones).toBeGreaterThanOrEqual(4);
    expect(lap.fullThrottle).toBeGreaterThan(0.3);
    expect(lap.fullThrottle).toBeLessThan(1);
  });

  it('limits bike braking to the stoppie limit', () => {
    const t = track(chicaneCircuit());
    const bike = VEHICLES.find((v) => v.id === 'motogp')!;
    const lap = simulateLap(t, computeRacingLine(t), bike);
    // Deceleration never exceeds the brake limit plus drag at top speed (about 1 g for a bike).
    for (let k = 0; k < t.n; k++) expect(-lap.ax[k]).toBeLessThan((bike.maxBrakeG! + 1) * GRAVITY);
  });

  it('opens DRS on long straights only', () => {
    const t = track(chicaneCircuit());
    const line = computeRacingLine(t);
    const open = drsStations(line);
    // The 950 m top straight starts at station 0; the first 90-degree corner follows it.
    expect(open[Math.round(400 / t.ds)]).toBe(1);
    const corner = analyseTrack(t).corners[0];
    expect(open[corner.apex]).toBe(0);
  });

  it('picks the fastest aero trim', () => {
    const t = track(chicaneCircuit());
    const line = computeRacingLine(t);
    const f1 = VEHICLES.find((v) => v.id === 'f1')!;
    const best = simulateLap(t, line, f1);
    for (const trim of [0, 0.5, 1]) expect(best.time).toBeLessThanOrEqual(simulateLapAtTrim(t, line, f1, trim).time + 1e-9);
  });

  it('ranks the classes in a sensible order', () => {
    const t = track(chicaneCircuit());
    const perf = analysePerformance(t, VEHICLES);
    const time = (id: string) => perf.laps.find((l) => l.vehicleId === id)!.time;
    expect(time('f1')).toBeLessThan(time('f2'));
    expect(time('f2')).toBeLessThan(time('gt3'));
    expect(time('hypercar')).toBeLessThan(time('gt3'));
    expect(time('gt3')).toBeLessThan(time('gt4'));
    expect(time('superbike')).toBeGreaterThan(time('motogp'));
  });
});

describe('sectors', () => {
  it('splits the lap into three parts of roughly equal time', () => {
    const t = track(chicaneCircuit());
    const perf = analysePerformance(t, VEHICLES);
    const lap = perf.laps.find((l) => l.vehicleId === 'gt3')!;
    const [s1, s2, s3] = sectorTimes(lap, perf.sectors);
    expect(s1 + s2 + s3).toBeCloseTo(lap.time, 9);
    for (const s of [s1, s2, s3]) {
      expect(s).toBeGreaterThan(lap.time * 0.2);
      expect(s).toBeLessThan(lap.time * 0.46);
    }
    expect(placeSectors(lap)).toEqual(perf.sectors);
  });
});

describe('gears', () => {
  it('spaces gears from first up to top speed', () => {
    const car = simpleCar();
    const tops = gearTopSpeeds(car);
    expect(tops).toHaveLength(6);
    expect(tops[0]).toBeCloseTo(car.firstGearSpeed, 6);
    expect(tops[5]).toBeCloseTo(car.topSpeed, 6);
    for (let g = 1; g < 6; g++) expect(tops[g]).toBeGreaterThan(tops[g - 1]);
  });
});

describe('vehicle data', () => {
  it('loads the built-in classes in SI units', () => {
    const f1 = VEHICLES.find((v) => v.id === 'f1')!;
    expect(VEHICLES.length).toBeGreaterThanOrEqual(10);
    expect(f1.power).toBe(700_000);
    expect(f1.topSpeed).toBeCloseTo(355 / 3.6, 6);
    expect(VEHICLES.find((v) => v.id === 'motogp')!.kind).toBe('bike');
  });

  it('rejects bad entries with a clear message', () => {
    expect(() => parseVehicleFile({})).toThrow(/classes/);
    expect(() => parseVehicleSpec({ id: 'x', name: 'X', mass: -5 })).toThrow(/mass/);
    expect(() => parseVehicleFile({ classes: [VEHICLE_JSON, VEHICLE_JSON] })).toThrow(/Duplicate/);
  });
});

const VEHICLE_JSON = {
  id: 'kart', name: 'Kart', spec: '', kind: 'car', color: '#fff', mass: 175, powerKw: 20, cdA: 0.5, clA: 0,
  grip: 1.2, loadSensitivity: 0, driveShare: 0.5, rollingResistance: 0.02, topSpeedKmh: 130, gears: 1, firstGearKmh: 130,
};
