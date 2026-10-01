import { describe, expect, it } from 'vitest';
import { buildWeather, rainAt } from '../src/core/race/weather.ts';
import { type Puff, SPRAY_LIFE, SPRAY_SLOTS, cloudCover, lineWetness, sprayPuffs, sprayStrength, standingWater } from '../src/core/weatherFx.ts';

describe('weather in 3D', () => {
  it('keeps the sky clear on a dry day, and clouds it over before the rain comes', () => {
    const dry = buildWeather('dry', 'a', 7200);
    for (let t = 0; t < 7200; t += 300) expect(cloudCover(dry, t)).toBe(0);
    let before = false;
    for (const seed of ['a', 'b', 'c', 'd']) {
      const w = buildWeather('changeable', seed, 7200);
      for (let t = 0; t < 7200; t += 30) {
        // Never clearer than the rain falling says, and overcast before a drop has fallen.
        expect(cloudCover(w, t)).toBeGreaterThanOrEqual(Math.min(1, rainAt(w, t) / 0.3) - 0.5);
        if (rainAt(w, t) < 0.01 && cloudCover(w, t) > 0.5) before = true;
      }
    }
    expect(before).toBe(true);
    // Raining since before the start: overcast from the first lap.
    expect(cloudCover(buildWeather('wet', 'a', 7200), 0)).toBeGreaterThan(0.9);
  });

  it('dries the racing line first once the rain stops', () => {
    expect(lineWetness(0, 0)).toBe(0);
    for (const w of [0.1, 0.4, 0.8]) {
      expect(lineWetness(w, 0.5)).toBeCloseTo(0.85 * w, 9);
      expect(lineWetness(w, 0)).toBeLessThan(lineWetness(w, 0.5));
      expect(lineWetness(w, 0)).toBeLessThanOrEqual(w);
    }
    expect(standingWater(0.5)).toBe(0);
    expect(standingWater(0.95)).toBe(1);
  });

  it('throws up spray on a wet track at speed, most behind a single-seater and least behind a bike', () => {
    expect(sprayStrength(0, 80, 'single-seater')).toBe(0);
    expect(sprayStrength(0.6, 3, 'single-seater')).toBe(0);
    const at = (body: 'single-seater' | 'closed' | 'bike') => sprayStrength(0.5, 70, body);
    expect(at('single-seater')).toBeGreaterThan(at('closed'));
    expect(at('closed')).toBeGreaterThan(at('bike'));
    expect(sprayStrength(0.2, 70, 'closed')).toBeLessThan(sprayStrength(0.4, 70, 'closed'));
  });

  it('leaves the spray hanging in the air behind the car as it runs on, the same every time', () => {
    const car = { length: 5.5, width: 2 };
    const speed = 70;
    const a: Puff[] = [];
    const b: Puff[] = [];
    sprayPuffs(3, 100, speed, 1, car, a);
    sprayPuffs(3, 100, speed, 1, car, b);
    expect(a).toHaveLength(SPRAY_SLOTS);
    expect(b).toEqual(a);
    for (const p of a) {
      expect(p.back).toBeGreaterThanOrEqual(car.length * 0.45);
      expect(p.back).toBeLessThanOrEqual(car.length * 0.45 + speed * SPRAY_LIFE);
      expect(p.up).toBeGreaterThan(0.2);
      expect(p.up).toBeLessThan(3.5);
      expect(p.alpha).toBeGreaterThanOrEqual(0);
      expect(p.alpha).toBeLessThanOrEqual(1);
    }
    // 20 ms on, the car has gone 1.4 m; a puff it threw up has drifted on only a little.
    const later: Puff[] = [];
    const dt = 0.02;
    sprayPuffs(3, 100 + dt, speed, 1, car, later);
    let hanging = 0;
    a.forEach((p, i) => {
      const moved = speed * dt - (later[i].back - p.back);
      if (later[i].back > p.back && Math.abs(moved) < speed * dt * 0.3) hanging++;
    });
    expect(hanging).toBeGreaterThan(SPRAY_SLOTS * 0.8);
    // None on a dry track.
    const none: Puff[] = [];
    sprayPuffs(3, 100, speed, 0, car, none);
    expect(none.every((p) => p.alpha === 0)).toBe(true);
  });
});
