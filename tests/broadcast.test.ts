import { describe, expect, it } from 'vitest';
import { Director, type TvCar, framingFov, heliStart, heliStep, lineOfSight, timeInSight, tvCameras } from '../src/core/broadcast.ts';
import { Earthworks, pitRoad, trackRoad } from '../src/core/scene3d.ts';
import { flatMap } from './helpers.ts';
import { facilities, metrics, track as t } from './raceFixture.ts';

const hm = flatMap(100);
const pit = facilities.pitLane!;
const earth = new Earthworks(hm, [trackRoad(t), pitRoad(pit, t)]);
const height = (x: number, y: number) => earth.height(x, y);
const cams = tvCameras({ track: t, metrics, pit, height });

/** A seeded generator for the director's choices. */
function rng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function car(id: number, u: number, extra: Partial<TvCar> = {}): TvCar {
  return { id, u, speed: 60, position: id + 1, classIndex: 0, classPosition: id + 1, interval: 3, running: true, inPit: false, stopped: false, selected: false, ...extra };
}

describe('trackside cameras', () => {
  it('stand at the corners, the start, the pit lane and beside the straights, and between them see the whole lap', () => {
    const ids = cams.map((c) => c.id);
    for (const c of metrics.corners) expect(ids).toContain(`corner-${c.number}`);
    expect(ids).toContain('start');
    expect(ids).toContain('pit');
    expect(ids.some((id) => id.startsWith('straight-'))).toBe(true);
    const covered = new Uint8Array(t.n);
    for (const c of cams) for (let k = 0; k < t.n; k++) covered[k] |= c.sees[k];
    const seen = covered.reduce((a, b) => a + b, 0);
    expect(seen / t.n).toBeGreaterThan(0.97);
    // Every camera sees a good stretch, and only within reach of its lens.
    for (const c of cams) {
      const count = c.sees.reduce((a, b) => a + b, 0);
      expect(count * t.ds).toBeGreaterThan(100);
      for (let k = 0; k < t.n; k += 7) if (c.sees[k]) expect(Math.hypot(t.x[k] - c.at[0], t.y[k] - c.at[1])).toBeLessThan(760);
    }
  });

  it('do not see through a hill', () => {
    const hill = (x: number) => (Math.abs(x - 100) < 20 ? 30 : 0);
    expect(lineOfSight([0, 0, 10], 200, 0, 1, (x) => hill(x))).toBe(false);
    expect(lineOfSight([0, 0, 10], 200, 0, 1, () => 0)).toBe(true);
    expect(lineOfSight([0, 0, 10], 2000, 0, 1, () => 0)).toBe(false);
  });

  it('know how long a car stays in sight', () => {
    const sees = new Uint8Array(100);
    sees.fill(1, 10, 40);
    expect(timeInSight(sees, { n: 100, ds: 2 }, 10, 6, 100)).toBeCloseTo(10, 6);
    expect(timeInSight(sees, { n: 100, ds: 2 }, 50, 6, 100)).toBe(0);
    expect(timeInSight(sees, { n: 100, ds: 2 }, 30, 6, 2)).toBeLessThanOrEqual(2 + 1e-9);
  });
});

describe('the director', () => {
  const track = { n: t.n, ds: t.ds };

  it('shows a close battle first, from a camera that keeps it in sight, and holds the shot a few seconds', () => {
    const d = new Director(cams, track, rng(3));
    const cars = [car(0, 1500), car(1, 1000, { interval: 4 }), car(2, 995, { interval: 0.3 }), car(3, 500, { interval: 9 })];
    const shot = d.update(0.1, 1, cars)!;
    expect(shot.subject).toEqual({ kind: 'battle', ahead: 1, behind: 2 });
    expect(shot.hold).toBeGreaterThanOrEqual(2.5);
    expect(shot.hold).toBeLessThanOrEqual(12);
    if (shot.camera !== 'heli') expect(d.camera(shot.camera)!.sees[Math.floor(995 % t.n)]).toBe(1);
    // A moment later the same shot.
    expect(d.update(0.5, 1, cars)).toBe(shot);
  });

  it('uses trackside cameras at real speed and the helicopter when the race runs fast', () => {
    const d = new Director(cams, track, rng(7));
    const cars = [car(0, 1500), car(1, 900)];
    const used = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      used.add(d.update(0.1, 1, cars)!.camera === 'heli' ? 'heli' : 'trackside');
    }
    expect(used).toEqual(new Set(['heli', 'trackside']));
    const fast = new Director(cams, track, rng(7));
    for (let i = 0; i < 100; i++) {
      for (const c of cars) c.u += (c.speed * 0.1 * 50) / t.ds;
      expect(fast.update(0.1, 50, cars)!.camera).toBe('heli');
    }
  });

  it('cuts to an incident, and keeps on the car the viewer picked', () => {
    const d = new Director(cams, track, rng(5));
    const cars = [car(0, 1500), car(1, 1000, { interval: 0.4 }), car(2, 300)];
    d.update(0.1, 1, cars);
    d.update(3, 1, cars);
    d.note('incident', 2);
    // Within a few seconds (a shot holds at least two and a half).
    let shown = false;
    for (let i = 0; i < 30 && !shown; i++) {
      const s = d.update(0.1, 1, cars)!;
      shown = s.subject.kind === 'car' && s.subject.id === 2 && s.reason === 'incident';
    }
    expect(shown).toBe(true);
    const picked = new Director(cams, track, rng(5));
    cars[0].selected = true;
    for (let i = 0; i < 300; i++) {
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      const s = picked.update(0.1, 1, cars)!;
      // The car itself, or the battle it is in.
      const ids = s.subject.kind === 'car' ? [s.subject.id] : [s.subject.ahead, s.subject.behind];
      expect(ids).toContain(0);
    }
  });
});

describe('framing', () => {
  it('zooms to keep a car the same size on screen', () => {
    const near = framingFov(50, 5, 0.4, 16 / 9);
    const far = framingFov(400, 5, 0.4, 16 / 9);
    expect(far).toBeLessThan(near);
    // Doubling the distance halves the angle, for long lenses.
    expect(framingFov(100, 5, 0.4, 16 / 9) / framingFov(200, 5, 0.4, 16 / 9)).toBeCloseTo(2, 1);
    expect(framingFov(5000, 5, 0.4, 1)).toBe(1.2);
  });

  it('circles the helicopter slowly, high up off to one side', () => {
    const h = heliStart(0, rng(2));
    expect(h.height).toBeGreaterThan(100);
    expect(Math.abs(Math.cos(h.angle))).toBeLessThan(0.6);
    expect(heliStep(h, 10).angle - h.angle).toBeCloseTo(0.35, 6);
  });
});
