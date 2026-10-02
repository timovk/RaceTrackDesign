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

  it('stays with a battle it picked for twenty seconds, from camera to camera and through a pass', () => {
    const d = new Director(cams, track, rng(13));
    const cars = [car(0, 2600), car(1, 2000, { interval: 5 }), car(2, 1995, { interval: 0.5 }), car(3, 1000, { interval: 8 }), car(4, 997, { interval: 3 })];
    const pair = (s: TvShot) => s.subject.kind === 'battle' && [s.subject.ahead, s.subject.behind].sort().join() === '1,2';
    const shots: TvShot[] = [];
    let now = 0;
    const step = () => {
      now += 0.1;
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      const s = d.update(0.1, 1, cars)!;
      if (s !== shots[shots.length - 1]) shots.push(s);
      return s;
    };
    expect(pair(step())).toBe(true);
    // A closer battle further back does not take the screen.
    cars[4].interval = 0.05;
    for (let i = 0; i < 90; i++) expect(pair(step())).toBe(true);
    // Car 2 passes car 1: the shot on screen goes on, with the cars in their new order.
    Object.assign(cars[2], { u: cars[1].u + 1, position: 2, classPosition: 2, interval: 5 });
    Object.assign(cars[1], { position: 3, classPosition: 3, interval: 0.2 });
    const onScreen = shots[shots.length - 1];
    expect(step()).toBe(onScreen);
    expect(onScreen.subject).toEqual({ kind: 'battle', ahead: 2, behind: 1 });
    while (now < 19.9) expect(pair(step())).toBe(true);
    expect(new Set(shots.map((s) => s.camera)).size).toBeGreaterThan(1);
    // Then on to something else.
    let moved = false;
    for (let i = 0; i < 200 && !moved; i++) moved = !pair(step());
    expect(moved).toBe(true);
    // A third car comes between them: on with the battle they are in now.
    const train = new Director(cams, track, rng(13));
    const three = [car(0, 2600), car(1, 2000, { interval: 5 }), car(2, 1995, { interval: 0.5 }), car(3, 1990, { interval: 1.5 })];
    const first = train.update(0.1, 1, three)!;
    expect(first.subject).toEqual({ kind: 'battle', ahead: 1, behind: 2 });
    Object.assign(three[3], { u: 1996, position: 3, classPosition: 3, interval: 0.1 });
    Object.assign(three[2], { position: 4, classPosition: 4, interval: 0.05 });
    expect(train.update(0.1, 1, three)).toBe(first);
    expect(first.subject).toEqual({ kind: 'battle', ahead: 3, behind: 2 });
    for (let i = 0; i < 150; i++) expect(subjectIds(train.update(0.1, 1, three)!.subject).every((id) => id > 0)).toBe(true);
    // A battle that splits up is left at once.
    const split = new Director(cams, track, rng(13));
    const two = [car(0, 2600), car(1, 2000, { interval: 5 }), car(2, 1995, { interval: 0.5 })];
    split.update(0.1, 1, two);
    split.update(3, 1, two);
    two[2].interval = 2;
    expect(split.update(0.1, 1, two)!.subject.kind).not.toBe('battle');
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

  it('replays an overtake a few seconds later, slowed down, from another camera, and plays it to the end', () => {
    const d = new Director(cams, track, rng(9));
    const cars = [car(0, 1500), car(1, 1000, { interval: 0.5 }), car(2, 300, { interval: 9 })];
    let now = 100;
    const step = (dt = 0.1) => {
      now += dt;
      for (const c of cars) c.u += (c.speed * dt) / t.ds;
      return d.update(dt, 1, cars, now)!;
    };
    step();
    // Car 1 passes car 0.
    const at = now;
    d.note('overtake', 1, { other: 0, raceTime: at, u: cars[1].u });
    let replay: TvShot | null = null;
    for (let i = 0; i < 400 && !replay; i++) {
      const s = step();
      if (s.reason === 'replay') replay = s;
    }
    expect(replay).not.toBeNull();
    // Not before the overtake is a couple of seconds old.
    expect(now - at).toBeGreaterThan(2.4);
    expect(replay!.subject).toEqual({ kind: 'battle', ahead: 1, behind: 0 });
    expect(replay!.replay).toEqual({ from: at - 4, to: at + 2, speed: 0.5 });
    expect(replay!.hold).toBeCloseTo(12, 9);
    // An incident does not cut it short.
    d.note('incident', 2);
    for (let i = 0; i < 100; i++) expect(step()).toBe(replay);
    const fast = new Director(cams, track, rng(9));
    fast.note('overtake', 1, { other: 0, raceTime: 100, u: 1000 });
    for (let i = 0; i < 100; i++) expect(fast.update(0.1, 20, cars, 104 + i)!.reason).not.toBe('replay');
  });

  it('opens on the start from behind the grid, holding on the front of the field', () => {
    const grid = Array.from({ length: 12 }, (_, i) => car(i, -10 - 4 * i, { speed: 0, position: i + 1, classPosition: i + 1 }));
    const d = new Director(cams, track, rng(4));
    const s = d.update(0.1, 1, grid, 0.1)!;
    expect(s.camera).toBe('start');
    expect(s.reason).toBe('start');
    expect(s.subject).toEqual({ kind: 'group', ids: [0, 1, 2, 3] });
    // It holds while the field gets away.
    for (const c of grid) c.u += 30;
    expect(d.update(5, 1, grid, 5)).toBe(s);
    // Not after the start, nor when the race runs fast.
    expect(new Director(cams, track, rng(4)).update(0.1, 1, grid, 60)!.reason).not.toBe('start');
    expect(new Director(cams, track, rng(4)).update(0.1, 20, grid, 0.1)!.reason).not.toBe('start');
  });

  it('cuts to an incident, and keeps on the car the viewer picked', () => {
    const d = new Director(cams, track, rng(5));
    const spread = [car(0, 1500), car(1, 1000), car(2, 300)];
    d.update(0.1, 1, spread);
    d.update(3, 1, spread);
    d.note('incident', 2);
    // Within a few seconds (a shot holds at least two and a half).
    let shown = false;
    for (let i = 0; i < 30 && !shown; i++) {
      const s = d.update(0.1, 1, spread)!;
      shown = s.subject.kind === 'car' && s.subject.id === 2 && s.reason === 'incident';
    }
    expect(shown).toBe(true);
    // Into a battle it follows, only an incident ahead of it (or to its cars).
    const following = new Director(cams, track, rng(5));
    const field = [car(0, 2000), car(1, 1500, { interval: 5 }), car(2, 1495, { interval: 0.4 }), car(3, 300, { interval: 9 })];
    expect(following.update(0.1, 1, field)!.subject).toEqual({ kind: 'battle', ahead: 1, behind: 2 });
    following.update(3, 1, field);
    following.note('incident', 3);
    for (let i = 0; i < 50; i++) expect(subjectIds(following.update(0.1, 1, field)!.subject)).toEqual([1, 2]);
    following.note('incident', 0);
    let ahead = false;
    for (let i = 0; i < 30 && !ahead; i++) ahead = following.update(0.1, 1, field)!.reason === 'incident';
    expect(ahead).toBe(true);
    const cars = [car(0, 1500), car(1, 1000, { interval: 0.4 }), car(2, 300)];
    const picked = new Director(cams, track, rng(5));
    cars[0].selected = true;
    for (let i = 0; i < 300; i++) {
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      const s = picked.update(0.1, 1, cars)!;
      // The car itself, or the battle it is in.
      expect(subjectIds(s.subject)).toContain(0);
    }
  });

  it('follows cars on a push lap in practice and qualifying, the closing minutes of qualifying most', () => {
    // Shots of each kind, with car 3 (P12) pushing as given.
    const shots = (late: number) => {
      const d = new Director(cams, track, rng(6));
      const cars = [car(0, 1500), car(1, 1000, { pushing: 1 }), car(2, 600), car(3, 300, { pushing: late, position: 12, classPosition: 12 })];
      const reasons: string[] = [];
      let last: TvShot | null = null;
      for (let i = 0; i < 3000; i++) {
        for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
        const s = d.update(0.1, 1, cars)!;
        if (s !== last) reasons.push(`${s.reason}:${subjectIds(s.subject).join()}`);
        last = s;
      }
      return reasons;
    };
    const normal = shots(1);
    expect(normal.filter((r) => r.startsWith('flying')).length).toBeGreaterThan(normal.length / 2);
    // In the closing minutes of qualifying the same car gets more of the screen.
    const count = (r: string[]) => r.filter((x) => x === 'flying:3').length;
    expect(count(shots(2))).toBeGreaterThan(count(normal));
  });

  it('shows the head of the queue in the pit lane while a red flag stops the race', () => {
    const d = new Director(cams, track, rng(6));
    const queue = [0, 1, 2].map((i) => car(i, 4000 - i * 2, { running: false, inPit: true, stopped: false }));
    const s = d.update(0.1, 1, queue)!;
    expect(s.subject).toEqual({ kind: 'car', id: 0 });
    expect(s.reason).toBe('leader');
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
