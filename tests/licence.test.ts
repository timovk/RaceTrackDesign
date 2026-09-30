import { describe, expect, it } from 'vitest';
import { analyseTrack } from '../src/core/analysis.ts';
import { placeFacilities } from '../src/core/facilities.ts';
import { assessLicence, maxStarters, requiredRunoff } from '../src/core/licence.ts';
import { analysePerformance } from '../src/core/performance.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { type ControlPoint, buildTrack } from '../src/core/track.ts';
import { validateTrack } from '../src/core/validate.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { bigRectangle, design, makeHeightmap } from './helpers.ts';

function assess(points: ControlPoint[], heightAt: (x: number, y: number) => number = () => 100, waterLevel = -Infinity) {
  const hm = makeHeightmap(heightAt, { waterLevel });
  const d = design(points, { smoothing: 0, maxCutFill: 0 });
  const raw = buildTrack(d, heightAt)!;
  const sf = placeStartFinish(raw);
  const track = rotateTrack(raw, sf.station);
  const metrics = analyseTrack(track);
  const issues = validateTrack(track, hm, d.grading);
  const performance = analysePerformance(track, VEHICLES);
  const facilities = placeFacilities({ track, startFinish: sf, performance, vehicles: VEHICLES, heightAt, waterLevel, extent: hm.extent, overrides: {} });
  return assessLicence({ track, metrics, issues, performance, facilities, heightmap: hm, vehicles: VEHICLES });
}

describe('Appendix O helpers', () => {
  it('computes the largest permitted grid (supplement 2)', () => {
    // 5.0 km (L = 15), 12 m wide (W = 10), one hour (T = 1), single-seaters below 1 kg/hp (G = 0.6).
    expect(maxStarters(5000, 12, 1, 0.6)).toBe(33);
    // 3.0 km (L = 11), 15 m (W = 12.5), 6 hours (T = 1.4), GT (G = 1).
    expect(maxStarters(3000, 15, 6, 1)).toBe(70);
  });

  it('asks for more run-off at higher speed, and more for bikes', () => {
    expect(requiredRunoff(80 / 3.6, 'FIA')).toBe(30);
    expect(requiredRunoff(300 / 3.6, 'FIA')).toBeCloseTo(100, 6);
    expect(requiredRunoff(200 / 3.6, 'FIA')).toBeCloseTo(65, 6);
    expect(requiredRunoff(200 / 3.6, 'FIM')).toBeGreaterThan(requiredRunoff(200 / 3.6, 'FIA'));
  });
});

describe('licence estimate', () => {
  it('rates a wide, open, well-proportioned circuit at the top grades', () => {
    const lic = assess(bigRectangle(15));
    const failed = lic.checks.filter((c) => c.level === 'required' && !c.pass).map((c) => `${c.id}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(lic.fia.grade).toBe('1');
    expect(lic.fim.grade).toBe('A');
    expect(lic.classes.every((c) => c.allowed)).toBe(true);
  });

  it('fails a narrow circuit on width', () => {
    const lic = assess(bigRectangle(10));
    expect(lic.fia.grade).toBeNull();
    expect(lic.checks.find((c) => c.id === 'fia-width')!.pass).toBe(false);
    expect(lic.checks.find((c) => c.id === 'fim-width')!.pass).toBe(false);
  });

  it('fails run-off where a corner backs onto water', () => {
    // Water 50 m beyond the east end of the rectangle (its outer edge reaches x 4557).
    const lic = assess(bigRectangle(15), (x) => (x > 4600 ? -10 : 100), 0);
    const runoff = lic.checks.find((c) => c.id === 'fia-runoff-1')!;
    expect(runoff.pass).toBe(false);
    expect(runoff.detail).toMatch(/water/);
    expect(lic.runoff.some((r) => r.blockedBy === 'water')).toBe(true);
    expect(lic.fia.grade).not.toBe('1');
  });
});
