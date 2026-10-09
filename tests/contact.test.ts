import { describe, expect, it } from 'vitest';
import { EDGE_GAP } from '../src/core/race/lanes.ts';
import { type RaceRules, raceRules } from '../src/core/race/rules.ts';
import { DT, type RaceCar, type RaceSim, contactChances, contactResult, mod, troubleChances } from '../src/core/race/sim.ts';
import { calm, car, start, track } from './raceFixture.ts';

/** Rules under which a driver alone gets every corner wrong in one way, and nothing else happens. */
function sure(kind: 'mistake' | 'off' | 'crash'): RaceRules {
  const base = calm(car('f1'));
  return { ...base, incidents: { ...base.incidents, [kind]: 1000 }, pit: { ...base.pit, stops: false, minStops: 0 } };
}

/** How far past the edge of the road a car's body reaches, metres (negative: on the road). */
function pastEdge(sim: RaceSim, c: RaceCar): number {
  const k = mod(Math.floor(c.u), sim.model.n);
  return Math.abs(c.lateral + sim.model.line.offset[k]) - (sim.model.track.width[k] / 2 - c.cls.half - EDGE_GAP);
}

/** How far a point is from the middle of the track, metres. */
function fromCentre(x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k < track.n; k++) best = Math.min(best, Math.hypot(track.x[k] - x, track.y[k] - y));
  return best;
}

describe("a driver's own trouble", () => {
  it('comes at the braking points, more often under pressure, and adds up to a share of the class figures', () => {
    const rates = raceRules(car('f1')).incidents;
    const alone = troubleChances(rates, 8);
    const pressed = troubleChances(rates, 8, true);
    // The braking points of a lap share the lap's chance; what is left of the class's figure comes from contact.
    expect(alone.mistake * 8).toBeGreaterThan(0.4 * rates.mistake);
    expect(alone.mistake * 8).toBeLessThan(rates.mistake);
    expect(alone.off * 8).toBeLessThan(rates.off);
    expect(alone.crash * 8).toBeLessThan(rates.crash);
    expect(troubleChances(rates, 4).mistake).toBeCloseTo(2 * alone.mistake);
    for (const kind of ['mistake', 'off', 'crash'] as const) expect(pressed[kind]).toBeGreaterThan(2 * alone[kind]);
    expect(troubleChances({ mistake: 0, off: 0, crash: 0 }, 8, true)).toEqual({ mistake: 0, off: 0, crash: 0 });
  });

  it('takes a car wide of its line through the corner on a mistake: on the road, and slower', () => {
    const quiet = start(car('f1'), { kind: 'laps', laps: 3, cars: 1 }, { ...calm(car('f1')), pit: sure('mistake').pit });
    while (!quiet.finished) quiet.step();
    const sim = start(car('f1'), { kind: 'laps', laps: 3, cars: 1 }, sure('mistake'));
    const c = sim.cars[0];
    let widest = 0;
    let past = -Infinity;
    let off = false;
    while (!sim.finished) {
      sim.step();
      if (c.status !== 'running') continue;
      if (c.lapsDone > 0) widest = Math.max(widest, Math.abs(c.lateral));
      past = Math.max(past, pastEdge(sim, c));
      off ||= c.offTrack;
    }
    expect(sim.tally.mistakes).toBeGreaterThan(5);
    expect(widest).toBeGreaterThan(1);
    expect(past).toBeLessThan(0.01);
    expect(off).toBe(false);
    // Not news, and no flags for it; but it costs time.
    expect(sim.events.filter((e) => e.kind === 'off' || e.kind === 'contact')).toHaveLength(0);
    expect(sim.yellows).toHaveLength(0);
    expect(c.finishTime!).toBeGreaterThan(quiet.cars[0].finishTime! + 0.2 * sim.tally.mistakes);
  });

  it('takes a car off the road and back on a trip off, or spins it to a stop, under a yellow flag', () => {
    const sim = start(car('f1'), { kind: 'laps', laps: 8, cars: 1 }, sure('off'));
    const c = sim.cars[0];
    let past = -Infinity;
    let slowest = Infinity;
    let stood = 0;
    let turned = 0;
    let yellow = false;
    let offFor = 0;
    let longest = 0;
    while (!sim.finished) {
      sim.step();
      if (c.status !== 'running') continue;
      if (c.offTrack) {
        offFor += DT;
        past = Math.max(past, pastEdge(sim, c));
        // (While a trip off costs it time: a car that has spun pulls away from a standstill.)
        if (!c.spin && c.delay > 0) slowest = Math.min(slowest, c.v);
        yellow ||= sim.yellows.length > 0;
      } else {
        longest = Math.max(longest, offFor);
        offFor = 0;
      }
      if (c.spin && c.v === 0) stood += DT;
      turned = Math.max(turned, Math.abs(c.yaw));
    }
    // Both kinds happened, and each is in the feed.
    expect(sim.tally.offs).toBeGreaterThan(2);
    expect(sim.tally.spins).toBeGreaterThan(2);
    expect(sim.events.filter((e) => e.kind === 'off')).toHaveLength(sim.tally.offs + sim.tally.spins);
    expect(sim.events.some((e) => /goes off/.test(e.text))).toBe(true);
    expect(sim.events.some((e) => /spins/.test(e.text))).toBe(true);
    expect(yellow).toBe(true);
    // Clear of the road, short of where a barrier may stand (a verge of 3 m is always there).
    expect(past).toBeGreaterThan(2 * c.cls.half);
    expect(past).toBeLessThan(3);
    // On a trip off it keeps moving; a spin stops it and turns it right round.
    expect(slowest).toBeGreaterThan(2);
    expect(stood).toBeGreaterThan(3 * sim.tally.spins);
    expect(turned).toBeGreaterThan(1.9 * Math.PI);
    expect(turned).toBeLessThanOrEqual(2 * Math.PI + 1e-9);
    // It always gets back on, and finishes.
    expect(longest).toBeLessThan(25);
    expect(c.status).toBe('finished');
    expect(c.yaw).toBe(0);
  });

  it('ends the race for a car that crashes, where it comes to rest off the road', () => {
    const sim = start(car('f1'), { kind: 'laps', laps: 3, cars: 1 }, sure('crash'));
    const c = sim.cars[0];
    let spun = false;
    let double = false;
    while (!sim.finished) {
      sim.step();
      spun ||= c.spin !== null && c.status === 'running';
      double ||= sim.yellows.some((z) => z.double);
    }
    expect(sim.tally.crashes).toBe(1);
    expect(spun).toBe(true);
    expect(c.status).toBe('retired');
    expect(c.retired!.reason).toBe('crash');
    expect(c.retired!.heading).toBeDefined();
    expect(sim.events.filter((e) => e.kind === 'retired').map((e) => e.text)).toEqual([expect.stringMatching(/crashes out/)]);
    // Beyond the edge of the road, on the verge.
    const k = mod(Math.floor(c.u), sim.model.n);
    const from = fromCentre(c.retired!.x, c.retired!.y);
    expect(from).toBeGreaterThan(track.width[k] / 2 + c.cls.half);
    expect(from).toBeLessThan(track.width[k] / 2 + 3);
    // A car stopped by the track: double waved yellows there.
    expect(double).toBe(true);
  });
});

describe('contact', () => {
  const rates = raceRules(car('f1')).incidents;

  it('needs the cars alongside each other, is likelier with no room left or a late braker, and rarer in traffic', () => {
    const level = contactChances(rates, 40, 1);
    expect(contactChances(rates, 40, 0)).toEqual({ touch: 0, off: 0, crash: 0 });
    expect(contactChances(rates, 40, 0.1).touch).toBeLessThan(level.touch);
    expect(contactChances(rates, 40, 0.5)).toEqual(level);
    // A touch is the likeliest and a car out the least likely, by the class's own figures.
    expect(level.touch).toBeGreaterThan(level.off);
    expect(level.off).toBeGreaterThan(level.crash);
    expect(level.crash).toBeGreaterThan(0);
    expect(contactChances({ mistake: 0, off: 0, crash: 0 }, 40, 1)).toEqual({ touch: 0, off: 0, crash: 0 });
    expect(contactChances({ ...rates, off: 2 * rates.off }, 40, 1).off).toBeCloseTo(2 * level.off);
    expect(contactChances(rates, 40, 1, { noRoom: true }).touch).toBeGreaterThan(2 * level.touch);
    expect(contactChances(rates, 40, 1, { brakingLate: true }).touch).toBeGreaterThan(1.5 * level.touch);
    // Cars that are not racing each other (one lapping the other, or of two classes) leave each other room.
    const traffic = contactChances(rates, 40, 1, { traffic: true });
    for (const kind of ['touch', 'off', 'crash'] as const) expect(traffic[kind]).toBeLessThan(0.5 * level[kind]);
  });

  it('puts a car out far more often in a fast corner than in a slow one', () => {
    const slow = contactChances(rates, 15, 1);
    const fast = contactChances(rates, 80, 1);
    expect(fast.crash).toBeGreaterThan(5 * slow.crash);
    expect(contactChances(rates, 45, 1).crash).toBeGreaterThan(slow.crash);
    expect(contactChances(rates, 45, 1).crash).toBeLessThan(fast.crash);
    // A touch or a spin is as likely in either.
    expect(fast.touch).toBe(slow.touch);
    expect(fast.off).toBe(slow.off);
  });

  it('decides what comes of it by the overlap and the speed', () => {
    const draws = Array.from({ length: 400 }, (_, i) => (i + 0.5) / 400);
    const share = (speed: number, overlap: number, is: (r: ReturnType<typeof contactResult>) => boolean) => draws.filter((r) => is(contactResult(false, speed, overlap, r))).length / draws.length;
    // The nose of the car behind against the other's rear wheel: the car ahead is turned round or has a puncture,
    // or the car behind breaks its front wing.
    for (const r of draws) {
      const x = contactResult(false, 30, 0.3, r);
      if (x.outcome === 'spin') expect(x.who).toBe('ahead');
      else expect([x.outcome, x.who, x.damage]).toEqual(x.who === 'behind' ? ['damage', 'behind', 'wing'] : ['damage', 'ahead', 'puncture']);
    }
    expect(share(30, 0.3, (x) => x.outcome === 'spin')).toBeGreaterThan(0.3);
    expect(share(30, 0.3, (x) => x.damage === 'wing')).toBeGreaterThan(0.2);
    expect(share(30, 0.3, (x) => x.damage === 'puncture')).toBeGreaterThan(0.1);
    // A tap turns a car round more easily in a slow corner.
    expect(share(15, 0.3, (x) => x.outcome === 'spin')).toBeGreaterThan(share(75, 0.3, (x) => x.outcome === 'spin') + 0.2);
    // Wheel to wheel: the car on the outside is forced off or spins, or one of the two is damaged.
    for (const r of draws) {
      const x = contactResult(false, 30, 0.9, r);
      if (x.outcome === 'damage') expect(['puncture', 'body']).toContain(x.damage);
      else expect(x.who).toBe('outside');
    }
    expect(share(30, 0.9, (x) => x.outcome === 'forced off')).toBeGreaterThan(0.3);
    expect(share(30, 0.9, (x) => x.outcome === 'spin')).toBeGreaterThan(0.05);
    expect(share(30, 0.9, (x) => x.outcome === 'damage' && x.who === 'ahead')).toBeGreaterThan(0.1);
    expect(share(30, 0.9, (x) => x.outcome === 'damage' && x.who === 'behind')).toBeGreaterThan(0.1);
    expect(share(30, 0.9, (x) => x.damage === 'body')).toBeGreaterThan(0.1);
    // A car out: the one ahead (turned into the barrier) or the one on the outside, now and then both.
    expect(contactResult(true, 60, 0.3, 0.9)).toEqual({ outcome: 'out', who: 'ahead', both: false });
    expect(contactResult(true, 60, 0.9, 0.1)).toEqual({ outcome: 'out', who: 'outside', both: true });
  });

  // Trips off and crashes ten times as likely as the class has them: enough contact in short races to look at.
  const base = raceRules(car('f1'));
  const rough: RaceRules = { ...base, incidents: { mistake: base.incidents.mistake * 4, off: base.incidents.off * 10, crash: base.incidents.crash * 10, dnfPerMetre: 0 } };
  const races = ['1', '5', '6'].map((seed) => {
    const sim = start(car('f1'), { kind: 'laps', laps: 15, cars: 20, seed }, rough);
    /** Every damage a car picked up, with the race time and the stops it had made by then. */
    const damage: { car: RaceCar; kind: string; t: number; stops: number; left: number }[] = [];
    const had = new Map<number, string>();
    let overlap = 0;
    let limping = Infinity;
    while (!sim.finished) {
      sim.step();
      const running = sim.cars.filter((c) => c.status === 'running');
      for (const c of sim.cars) {
        const kind = c.damage?.kind ?? '';
        if (kind && had.get(c.id) !== kind) damage.push({ car: c, kind, t: sim.t, stops: c.stops, left: sim.setup.laps! - c.lapsDone });
        had.set(c.id, kind);
        if (c.status === 'running' && c.damage?.kind === 'puncture' && c.delay <= 0 && !c.offTrack) limping = Math.min(limping, c.lapPace);
      }
      // Bodies through each other, both on the road.
      for (let i = 0; i < running.length; i++) {
        for (let j = i + 1; j < running.length; j++) {
          const a = running[i];
          const b = running[j];
          if (a.offTrack || b.offTrack || a.exitUntilU > a.u || b.exitUntilU > b.u) continue;
          let d = mod(a.u - b.u, sim.model.n);
          if (d > sim.model.n / 2) d -= sim.model.n;
          if (Math.abs(d * sim.model.track.ds) < (a.cls.length + b.cls.length) / 2 - 0.5 && Math.abs(a.lateral - b.lateral) < a.cls.half + b.cls.half - 0.3) overlap += DT;
        }
      }
    }
    return { sim, damage, overlap, limping };
  });

  it('happens between cars side by side, and is kept as a record of who was where', () => {
    for (const { sim, overlap } of races) {
      expect(sim.contacts.length).toBeGreaterThan(5);
      for (const c of sim.contacts) {
        expect(c.ahead).not.toBe(c.behind);
        expect(c.overlap).toBeGreaterThan(0);
        expect(c.overlap).toBeLessThanOrEqual(1);
        expect(c.speed).toBeGreaterThan(0);
        expect([c.ahead, c.behind]).toContain(c.inside);
        for (const id of [c.lunging, c.squeezed]) expect([-1, c.ahead, c.behind]).toContain(id);
        for (const id of c.hurt) expect([c.ahead, c.behind]).toContain(id);
        expect(c.hurt.length).toBe(c.outcome === 'touch' ? 0 : c.outcome === 'out' ? c.hurt.length || 1 : 1);
        // The same two cars are left alone for a few seconds afterwards.
        expect(sim.contacts.filter((o) => o !== c && o.t > c.t && o.t < c.t + 4 && [o.ahead, o.behind].some((id) => id === c.ahead || id === c.behind))).toHaveLength(0);
      }
      // One line in the feed for each; a touch is marked as nothing much.
      const feed = sim.events.filter((e) => e.kind === 'contact');
      expect(feed).toHaveLength(sim.contacts.length);
      expect(feed.filter((e) => e.minor)).toHaveLength(sim.contacts.filter((c) => c.outcome === 'touch').length);
      expect(sim.tally.touches + sim.tally.tapped + sim.tally.forcedOff + sim.tally.damaged + sim.tally.collisions).toBe(sim.contacts.length);
      // Cars do not drive through each other any more than without contact.
      expect(overlap).toBeLessThan(3);
    }
    const outcomes = new Set(races.flatMap((r) => r.sim.contacts.map((c) => c.outcome)));
    expect([...outcomes].sort()).toEqual(['damage', 'forced off', 'out', 'spin', 'touch']);
  });

  it('puts cars out where they stop, or lets them limp back to retire in the pits', () => {
    const out = races.flatMap(({ sim }) => sim.contacts.filter((c) => c.outcome === 'out').flatMap((c) => c.hurt.map((id) => sim.cars[id])));
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.status).toBe('retired');
      expect(c.retired!.reason).toMatch(/^collision/);
    }
    // A car out on track stays as it came to rest; one that limped home retires in the pit lane, and the feed says so.
    expect(out.some((c) => c.retired!.reason === 'collision' && c.retired!.heading !== undefined)).toBe(true);
    const home = out.filter((c) => c.retired!.reason === 'collision damage');
    for (const { sim } of races) {
      for (const c of home.filter((x) => sim.cars[x.id] === x)) {
        expect(c.retired!.heading).toBeUndefined();
        expect(sim.events.some((e) => e.car === c.id && /retires in the pits/.test(e.text))).toBe(true);
      }
      // A car out on track brings out the flags.
      if (sim.contacts.some((c) => c.outcome === 'out' && c.hurt.some((id) => sim.cars[id].retired?.reason === 'collision'))) {
        expect(sim.events.some((e) => e.kind === 'flag')).toBe(true);
      }
    }
  });

  it('sends a damaged car to the pits for repairs, slower until then; bodywork it has to live with', () => {
    const all = races.flatMap((r) => r.damage.map((d) => ({ ...d, sim: r.sim })));
    // (Which kinds turn up goes by the seeds; a broken wing and a puncture are the common ones.)
    const kinds = new Set(all.map((d) => d.kind));
    expect(kinds.has('wing')).toBe(true);
    expect(kinds.has('puncture')).toBe(true);
    for (const d of all) {
      const { sim, car: c } = d;
      const stop = sim.stops.find((p) => p.car === c.id && p.entry > d.t);
      if (d.kind === 'body') {
        // No stop for it, and it stays with the car.
        if (c.status === 'finished' && !all.some((o) => o.car === c && o.t > d.t)) expect(c.damage?.kind).toBe('body');
        continue;
      }
      if (c.status === 'retired' && !stop) continue;
      if (d.kind === 'wing' && d.left <= 2) continue;
      expect(stop).toBeDefined();
      expect(stop!.reason).toBe('damage');
      if (d.kind === 'puncture') expect(stop!.to).not.toBeNull();
      if (!Number.isFinite(stop!.exit)) continue;
      if (d.kind === 'wing') expect(stop!.stationary).toBeGreaterThan(0.8 * c.rules.pit.repair);
      expect(sim.events.some((e) => e.kind === 'pit' && e.car === c.id && e.t > d.t && /repairs/.test(e.text))).toBe(true);
      // Repaired, it races on without it.
      if (!all.some((o) => o.car === c && o.t > stop!.entry)) expect(['body', undefined]).toContain(c.damage?.kind);
    }
    // With a puncture a car crawls: well over half as slow again.
    expect(Math.min(...races.map((r) => r.limping))).toBeGreaterThan(1.5);
  });

  it('does nothing where the rules have no incidents', () => {
    const sim = start(car('f1'), { kind: 'laps', laps: 6, cars: 20 }, calm(car('f1')));
    while (!sim.finished) sim.step();
    expect(sim.contacts).toHaveLength(0);
    expect(Object.values(sim.tally).every((v) => v === 0)).toBe(true);
    expect(sim.cars.every((c) => c.status === 'finished' && c.damage === null)).toBe(true);
  });
});
