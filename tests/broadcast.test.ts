import { describe, expect, it } from 'vitest';
import { Director, type TvCar, type TvShot, framingFov, heliStart, heliStep, isOnboard, lineOfSight, subjectIds, timeInSight, tvCameras } from '../src/core/broadcast.ts';
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

  it('uses trackside cameras at real speed, and the helicopter and onboard cameras when the race runs fast', () => {
    const kind = (camera: string) => (camera === 'heli' ? 'heli' : isOnboard(camera) ? 'onboard' : 'trackside');
    const d = new Director(cams, track, rng(7));
    const cars = [car(0, 1500), car(1, 900)];
    const used = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      used.add(kind(d.update(0.1, 1, cars)!.camera));
    }
    expect(used.has('heli') && used.has('trackside')).toBe(true);
    const fast = new Director(cams, track, rng(7));
    const fastUsed = new Set<string>();
    for (let i = 0; i < 600; i++) {
      for (const c of cars) c.u += (c.speed * 0.1 * 50) / t.ds;
      fastUsed.add(kind(fast.update(0.1, 50, cars)!.camera));
    }
    // The cars go by a trackside camera too fast to hold.
    expect(fastUsed).toEqual(new Set(['heli', 'onboard']));
  });

  it('cuts to onboard cameras now and then, never twice running, on the right car', () => {
    const d = new Director(cams, track, rng(11));
    const cars = [car(0, 1500, { selected: true }), car(1, 1000, { interval: 4 }), car(2, 995, { interval: 0.3 }), car(3, 500, { interval: 9 })];
    const shots: TvShot[] = [];
    for (let i = 0; i < 3000; i++) {
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      const s = d.update(0.1, 1, cars)!;
      if (s !== shots[shots.length - 1]) shots.push(s);
    }
    const onboard = shots.filter((s) => isOnboard(s.camera));
    expect(onboard.length).toBeGreaterThan(shots.length * 0.1);
    expect(onboard.length).toBeLessThan(shots.length * 0.5);
    expect(new Set(onboard.map((s) => s.camera)).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < shots.length; i++) expect(isOnboard(shots[i].camera) && isOnboard(shots[i - 1].camera)).toBe(false);
    for (const s of onboard) {
      if (s.subject.kind === 'battle') expect(s.carrier).toBe(s.camera === 'rear' ? s.subject.ahead : s.subject.behind);
      else expect(subjectIds(s.subject)).toContain(s.carrier);
      expect(s.hold).toBeGreaterThanOrEqual(6);
    }
    // Never for an incident.
    const crash = new Director(cams, track, rng(11));
    for (let i = 0; i < 50; i++) {
      crash.note('incident', 3);
      const s = crash.update(4, 1, cars)!;
      if (s.reason === 'incident') expect(isOnboard(s.camera)).toBe(false);
    }
  });

  it('shows a car standing in its box from the pit lane while enough of the stop is left', () => {
    const cars = [car(0, 1500), car(1, 700, { running: false, inPit: true, stopped: true, stopLeft: 8 })];
    const d = new Director(cams, track, rng(3));
    const s = d.update(0.1, 1, cars)!;
    expect(s.camera).toBe('pitbox');
    expect(s.carrier).toBe(1);
    expect(s.hold).toBeLessThanOrEqual(8 + 2.5);
    // Until the car leaves the pit lane.
    expect(d.update(2, 1, cars)).toBe(s);
    cars[1] = { ...cars[1], inPit: false, running: true, stopped: false, stopLeft: 0 };
    expect(d.update(0.1, 1, cars)).not.toBe(s);
    // At twenty times real speed the stop is over in a moment: not from the pit box.
    const fast = new Director(cams, track, rng(3));
    expect(fast.update(0.1, 20, [car(0, 1500), car(1, 700, { running: false, inPit: true, stopped: true, stopLeft: 8 })])!.camera).not.toBe('pitbox');
  });

  it('opens on the start from behind the grid, holding on the front of the field', () => {
    const grid = Array.from({ length: 12 }, (_, i) => car(i, -10 - 4 * i, { speed: 0, position: i + 1, classPosition: i + 1 }));
    const d = new Director(cams, track, rng(4));
    const s = d.update(0.1, 1, grid, 0.1)!;
    expect(s.camera).toBe('start');
    expect(s.reason).toBe('start');
    expect(s.subject).toEqual({ kind: 'group', ids: [0, 1, 2, 3, 4, 5, 6, 7] });
    // It holds while the field gets away.
    for (const c of grid) c.u += 30;
    expect(d.update(5, 1, grid, 5)).toBe(s);
    // Not after the start, nor when the race runs fast.
    expect(new Director(cams, track, rng(4)).update(0.1, 1, grid, 60)!.reason).not.toBe('start');
    expect(new Director(cams, track, rng(4)).update(0.1, 20, grid, 0.1)!.reason).not.toBe('start');
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
      expect(subjectIds(s.subject)).toContain(0);
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
