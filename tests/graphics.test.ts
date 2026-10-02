import { describe, expect, it } from 'vitest';
import { lensBlur } from '../src/ui/postFx.ts';
import { skyTurn, sunDirection } from '../src/ui/sky.ts';

describe('lens blur', () => {
  it('blurs a long lens on a distant car by a few pixels and a wide one not at all', () => {
    const long = lensBlur({ fov: 3, focus: 200 }, 1080);
    expect(long).toBeGreaterThan(3);
    expect(long).toBeLessThan(15);
    expect(lensBlur({ fov: 1.5, focus: 200 }, 1080)).toBeGreaterThan(long * 3.5);
    expect(lensBlur({ fov: 50, focus: 20 }, 1080)).toBeLessThan(0.3);
  });

  it('blurs less the farther the lens focuses, and scales with the picture', () => {
    const near = lensBlur({ fov: 4, focus: 100 }, 1080);
    expect(lensBlur({ fov: 4, focus: 200 }, 1080)).toBeCloseTo(near / 2, 0);
    expect(lensBlur({ fov: 4, focus: 100 }, 2160)).toBeCloseTo(near * 2, 6);
  });

  it('stays finite for a lens focused closer than it can', () => {
    expect(Number.isFinite(lensBlur({ fov: 2, focus: 0 }, 1080))).toBe(true);
  });
});

describe('the sky', () => {
  it("has the sun in the north-west at the photograph's height", () => {
    const sun = sunDirection();
    expect(sun.length()).toBeCloseTo(1, 6);
    expect(sun.x).toBeLessThan(0);
    expect(sun.z).toBeLessThan(0);
    expect(sun.x).toBeCloseTo(sun.z, 6);
    expect((Math.asin(sun.y) * 180) / Math.PI).toBeCloseTo(47.9, 6);
  });

  it("turns the panorama so its sun stands where the scene's does", () => {
    for (const az of [-135, 0, 60, 170]) {
      const sun = sunDirection(az);
      const lon = Math.atan2(sun.z, sun.x) + skyTurn(sun);
      const deg = ((((lon * 180) / Math.PI) % 360) + 360) % 360;
      expect(deg).toBeCloseTo(34.2, 6);
    }
  });
});
