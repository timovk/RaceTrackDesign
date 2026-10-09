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

  it('stays with a battle it picked for forty-five seconds, from camera to camera and through a pass', () => {
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
    while (now < 44.9) expect(pair(step())).toBe(true);
    expect(new Set(shots.map((s) => s.camera)).size).toBeGreaterThan(2);
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
    // A battle that splits up: on with the better placed of the two, and with both again when they are back together.
    const split = new Director(cams, track, rng(13));
    const two = [car(0, 2600), car(1, 2000, { interval: 5 }), car(2, 1995, { interval: 0.5 })];
    split.update(0.1, 1, two);
    split.update(3, 1, two);
    two[2].interval = 2;
    expect(split.update(0.1, 1, two)!.subject).toEqual({ kind: 'car', id: 1 });
    for (let i = 0; i < 100; i++) expect(split.update(0.1, 1, two)!.subject).toEqual({ kind: 'car', id: 1 });
    two[2].interval = 0.4;
    let together = false;
    for (let i = 0; i < 150 && !together; i++) together = split.update(0.1, 1, two)!.subject.kind === 'battle';
    expect(together).toBe(true);
  });

  it('weighs what a battle is for: the lead of the race before a place far down another class, however close', () => {
    // Two classes: a fight for the lead of the race nine tenths apart, and one for fifteenth in the second class nose to tail.
    const second = (id: number, u: number, place: number, extra: Partial<TvCar> = {}) => car(id, u, { classIndex: 1, classPosition: place, position: 20 + place, ...extra });
    const cars = [
      car(0, 3000), car(1, 2990, { interval: 0.9 }), car(2, 2000, { interval: 20 }),
      second(10, 1500, 1), second(11, 800, 15, { interval: 12 }), second(12, 798, 16, { interval: 0.05 }),
    ];
    const d = new Director(cams, track, rng(21));
    const shown = new Set<string>();
    const run = (seconds: number) => {
      shown.clear();
      for (let i = 0; i < seconds * 10; i++) {
        for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
        shown.add(subjectIds(d.update(0.1, 1, cars)!.subject).join());
      }
    };
    expect(d.update(0.1, 1, cars)!.subject).toEqual({ kind: 'battle', ahead: 0, behind: 1 });
    // For as long as the lead is fought over, that is what is on.
    run(240);
    expect([...shown]).toEqual(['0,1']);
    // With the leader away on its own the other battle gets its turn, among the leaders.
    cars[1].interval = 6;
    run(420);
    expect(shown.has('11,12')).toBe(true);
    expect(shown.has('0')).toBe(true);
  });

  it('follows the cars it picked for forty-five seconds, and leaves them only for a major event', () => {
    const d = new Director(cams, track, rng(8));
    const cars = [car(0, 3000), car(1, 2400, { interval: 9 }), car(2, 1800, { interval: 9 }), car(3, 1200, { interval: 9 }), car(4, 600, { interval: 9 })];
    let now = 100;
    const step = () => {
      now += 0.1;
      for (const c of cars) c.u += (c.speed * 0.1) / t.ds;
      return d.update(0.1, 1, cars, now)!;
    };
    // Nobody is fighting: a car on its own, and it stays with it from camera to camera.
    const first = step();
    expect(first.subject.kind).toBe('car');
    const [id] = subjectIds(first.subject);
    const cameras = new Set<string>();
    const until = now + 44.8;
    // A pass elsewhere on the way does not take the screen, live or as a replay.
    const elsewhere = cars.filter((c) => c.id !== id && c.id !== 0).map((c) => c.id);
    while (now < until) {
      if (Math.abs(now - 110) < 0.05) d.note('overtake', elsewhere[0], { other: elsewhere[1], raceTime: now, u: cars[elsewhere[0]].u });
      const s = step();
      expect(subjectIds(s.subject)).toEqual([id]);
      expect(s.reason).not.toBe('replay');
      cameras.add(s.camera);
    }
    expect(cameras.size).toBeGreaterThan(2);
    // Then on to another car.
    let other = -1;
    for (let i = 0; i < 200 && other < 0; i++) {
      const s = step();
      if (!subjectIds(s.subject).includes(id)) other = subjectIds(s.subject)[0];
    }
    expect(other).toBeGreaterThanOrEqual(0);
    // The lead of the race changes hands elsewhere: straight to the new leader, and it stays there.
    const [winner, loser] = cars.filter((c) => c.id !== other).slice(0, 2);
    Object.assign(winner, { position: 1, classPosition: 1 });
    Object.assign(loser, { position: 2, classPosition: 2, interval: 0.3, u: winner.u - 3 });
    for (const c of cars) if (c !== winner && c !== loser && c.position <= 2) Object.assign(c, { position: c.position + 2, classPosition: c.classPosition + 2 });
    d.note('lead', winner.id, { other: loser.id, raceTime: now, u: winner.u });
    let cut = -1;
    for (let i = 0; i < 40 && cut < 0; i++) if (subjectIds(step().subject).includes(winner.id)) cut = i;
    expect(cut).toBeGreaterThanOrEqual(0);
    const from = now;
    while (now < from + 30) {
      const s = step();
      if (s.reason !== 'replay') expect(subjectIds(s.subject)).toContain(winner.id);
    }
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
    // Into a battle it follows too, wherever it happens; then back to the battle, which keeps its forty-five seconds.
    const following = new Director(cams, track, rng(5));
    const field = [car(0, 2000), car(1, 1500, { interval: 5 }), car(2, 1495, { interval: 0.4 }), car(3, 300, { interval: 9 })];
    expect(following.update(0.1, 1, field)!.subject).toEqual({ kind: 'battle', ahead: 1, behind: 2 });
    let onBattle = 0;
    let away = 0;
    for (let i = 0; i < 900 && onBattle < 44.8; i++) {
      if (i === 30) following.note('incident', 3);
      for (const c of field) c.u += (c.speed * 0.1) / t.ds;
      const s = following.update(0.1, 1, field)!;
      if (s.reason === 'incident') {
        expect(s.subject).toEqual({ kind: 'car', id: 3 });
        away += 0.1;
      } else {
        expect(subjectIds(s.subject)).toEqual([1, 2]);
        onBattle += 0.1;
      }
    }
    expect(away).toBeGreaterThan(2);
    expect(onBattle).toBeGreaterThanOrEqual(44.8);
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

  it('makes more of two cars that are side by side, and stays on them longer', () => {
    // A close battle for fifth, and one further down that is side by side.
    const field = (beside: boolean) => [
      car(0, 3000), car(1, 2700, { interval: 5 }), car(2, 2400, { interval: 5 }), car(3, 2100, { interval: 5 }),
      car(4, 1800, { interval: 5 }), car(5, 1795, { interval: 0.5 }),
      car(6, 1200, { interval: 9, ...(beside ? { beside: 7 } : {}) }), car(7, 1199, { interval: 0.5, ...(beside ? { beside: 6 } : {}) }),
    ];
    expect(new Director(cams, track, rng(3)).update(0.1, 1, field(false))!.subject).toEqual({ kind: 'battle', ahead: 4, behind: 5 });
    expect(new Director(cams, track, rng(3)).update(0.1, 1, field(true))!.subject).toEqual({ kind: 'battle', ahead: 6, behind: 7 });
    // How long the first shot lasts, with the race running fast (so no trackside camera loses them).
    const lasts = (beside: boolean) => {
      const d = new Director(cams, track, rng(8));
      const cars = [car(0, 3000), car(1, 2999, { interval: 0.3, ...(beside ? { beside: 0 } : {}) })];
      if (beside) cars[0].beside = 1;
      const first = d.update(0.1, 20, cars)!;
      let time = 0;
      while (time < 60 && d.update(0.1, 20, cars) === first) time += 0.1;
      return { time, hold: first.hold };
    };
    const apart = lasts(false);
    const together = lasts(true);
    expect(apart.time).toBeLessThan(apart.hold + 0.2);
    expect(together.time).toBeGreaterThan(together.hold + 7);
    expect(together.time).toBeLessThan(together.hold + 8.3);
  });

  it('cuts from a car that is on for nothing in particular to two that go side by side', () => {
    const d = new Director(cams, track, rng(5));
    const cars = [car(0, 3000), car(1, 2000, { interval: 12 }), car(2, 1990, { interval: 0.9 }), car(3, 800, { interval: 15 })];
    // (Not a battle yet: it follows the leader or looks round the field.)
    cars[2].interval = 3;
    let s = d.update(0.1, 1, cars)!;
    expect(s.subject.kind).toBe('car');
    for (let i = 0; i < 30; i++) s = d.update(0.1, 1, cars)!;
    cars[2].interval = 0.2;
    cars[1].beside = 2;
    cars[2].beside = 1;
    d.note('fight', 2, undefined, 1);
    let cut = false;
    for (let i = 0; i < 40 && !cut; i++) {
      const now = d.update(0.1, 1, cars)!;
      cut = now.subject.kind === 'battle' && now.subject.ahead === 1 && now.subject.behind === 2;
    }
    expect(cut).toBe(true);
  });

  it('shows a restart on the front of the field, and a start from the grid as the start', () => {
    const d = new Director(cams, track, rng(6));
    const queue = Array.from({ length: 10 }, (_, i) => car(i, 3000 - 20 * i, { speed: 35, interval: 0.6 }));
    d.update(0.1, 1, queue, 500);
    for (let i = 0; i < 40; i++) d.update(0.1, 1, queue, 500 + i / 10);
    d.note('restart', 0);
    let shown: TvShot | null = null;
    for (let i = 0; i < 40 && !shown; i++) {
      const s = d.update(0.1, 1, queue, 505 + i / 10)!;
      if (s.reason === 'start') shown = s;
    }
    expect(shown).not.toBeNull();
    expect(shown!.subject).toEqual({ kind: 'group', ids: [0, 1, 2, 3, 4] });
    expect(shown!.hold).toBeGreaterThanOrEqual(2.5);
    // From the grid again (a standing restart): the camera behind it, at once; not when the race runs fast.
    const grid = Array.from({ length: 12 }, (_, i) => car(i, -10 - 4 * i, { speed: 0 }));
    const again = new Director(cams, track, rng(4));
    again.update(0.1, 1, grid, 900);
    again.update(3, 1, grid, 903);
    again.note('start', 0);
    const s = again.update(0.1, 1, grid, 903.1)!;
    expect(s.camera).toBe('start');
    expect(s.reason).toBe('start');
    expect(again.update(0.1, 1, grid, 903.2)).toBe(s);
    const fast = new Director(cams, track, rng(4));
    fast.update(0.1, 20, grid, 900);
    fast.note('start', 0);
    expect(fast.update(0.1, 20, grid, 902)!.reason).not.toBe('start');
  });

  it('replays a contact with both cars, and again when the stewards give a penalty for it much later', () => {
    const d = new Director(cams, track, rng(9));
    const cars = [car(0, 1500), car(1, 1000, { interval: 6 }), car(2, 990, { interval: 2 }), car(3, 300, { interval: 9 })];
    let now = 100;
    const step = (dt = 0.1) => {
      now += dt;
      for (const c of cars) c.u += (c.speed * dt) / t.ds;
      return d.update(dt, 1, cars, now)!;
    };
    step();
    const at = now;
    const where = cars[2].u;
    d.note('incident', 2, { raceTime: at, u: where, other: 1 });
    let replay: TvShot | null = null;
    for (let i = 0; i < 400 && !replay; i++) {
      const s = step();
      if (s.reason === 'replay') replay = s;
    }
    expect(replay).not.toBeNull();
    expect(replay!.subject).toEqual({ kind: 'battle', ahead: 2, behind: 1 });
    expect(replay!.replay).toEqual({ from: at - 3, to: at + 4, speed: 0.5 });
    // Four minutes on, the penalty: the same stretch once more, though it is long past.
    for (let i = 0; i < 2400; i++) step();
    d.note('penalty', 1, { raceTime: at, u: where, other: 2, since: now });
    let again: TvShot | null = null;
    for (let i = 0; i < 400 && !again; i++) {
      const s = step();
      if (s.reason === 'replay') again = s;
    }
    expect(again).not.toBeNull();
    expect(again!.subject).toEqual({ kind: 'battle', ahead: 1, behind: 2 });
    expect(again!.replay).toEqual({ from: at - 3, to: at + 4, speed: 0.5 });
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
