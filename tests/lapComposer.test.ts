import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATOR, type GeneratorSettings, gapFor } from '../src/core/generator.ts';
import { type Plan, REAL_MIX, composeLap, cornersWanted, drawPlan, mixWanted, ownStart } from '../src/core/lapComposer.ts';
import { type Shape, NO_CORNER, READS_WIDER, STRAIGHT_CREEP, cornersOf, lapLength, signedArea, turns } from '../src/core/lapShape.ts';
import { seededRandom } from '../src/core/rng.ts';

const settings = (changes: Partial<GeneratorSettings> = {}): GeneratorSettings => ({ ...DEFAULT_GENERATOR, licence: false, ...changes });
const DEG = Math.PI / 180;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

function plans(s: GeneratorSettings, count: number): Plan[] {
  const rng = seededRandom(`plans:${s.seed}`);
  const out: Plan[] = [];
  for (let i = 0; i < count; i++) {
    const plan = drawPlan(s, rng, gapFor(s));
    if (plan) out.push(plan);
  }
  return out;
}

function laps(s: GeneratorSettings, count: number): Shape[] {
  const rng = seededRandom(`laps:${s.seed}`);
  const out: Shape[] = [];
  for (let i = 0; i < count; i++) {
    const shape = composeLap(s, rng, gapFor(s));
    if (shape) out.push(shape);
  }
  return out;
}

/** How far a passage turns the lap, whichever way it is laid, radians. */
const turning = (p: Plan['passages'][number]) => Math.abs(p.bends.reduce((a, b) => a + b.side * b.turn, 0));

describe('the plan of a lap', () => {
  const s = settings({ seed: 'plan' });
  const drawn = plans(s, 40);

  it('is there for every draw, and begins with the start straight', () => {
    expect(drawn.length).toBe(40);
    for (const plan of drawn) {
      const start = plan.passages[0];
      expect(start.hold).toBe('asked');
      // (Drawn a little longer than asked: a straight reads shorter on the track. The arc its corner is eased in by is part of it, where it turns little.)
      expect(start.straight + start.eased[0]).toBeGreaterThan(s.startStraight + STRAIGHT_CREEP);
      expect(start.straight).toBeLessThan(s.startStraight * 1.06 + STRAIGHT_CREEP);
    }
  });

  it('has the longest straight in it, on a passage of its own unless the start is on it', () => {
    expect(ownStart(s)).toBe(true);
    for (const plan of drawn) {
      expect(plan.main).toBeGreaterThan(0);
      const main = plan.passages[plan.main];
      expect(main.hold).toBe('asked');
      for (const p of plan.passages) expect(p.straight).toBeLessThanOrEqual(main.straight + 1e-6);
    }
    const one = settings({ seed: 'plan', startStraight: 780, longestStraight: 800 });
    expect(ownStart(one)).toBe(false);
    for (const plan of plans(one, 10)) {
      expect(plan.main).toBe(0);
      expect(plan.passages[0].straight).toBeGreaterThan(800);
    }
  });

  it('is as long as the lap, all told', () => {
    for (const plan of drawn) {
      const length = plan.passages.reduce((a, p) => a + p.straight + p.length, 0) + plan.reserve;
      expect(Math.abs(length - s.length)).toBeLessThan(0.03 * s.length);
    }
  });

  it('has about as many corners as the lap is to have, the two that bring it home counted', () => {
    const wanted = cornersWanted(s);
    const corners = drawn.map((plan) => plan.passages.reduce((a, p) => a + p.bends.filter((b) => b.turn >= 15 * DEG && b.radius * READS_WIDER < NO_CORNER).length, 0) + 2);
    // (A lap that has not room for them all has fewer: its long corners and the arcs its corners are eased by take more of it.)
    expect(Math.abs(mean(corners) - wanted)).toBeLessThan(2.6);
    for (const c of corners) expect(Math.abs(c - wanted)).toBeLessThanOrEqual(8);
  });

  it('has what is asked for by name, and none of what is not', () => {
    for (const plan of plans(settings({ seed: 'named', hairpin: true, chicane: true, esses: true, sweeper: true }), 20)) {
      const kinds = plan.passages.map((p) => p.kind);
      for (const kind of ['hairpin', 'chicane', 'flow', 'sweeper'] as const) expect(kinds).toContain(kind);
    }
    for (const plan of plans(settings({ seed: 'named', hairpin: false, chicane: false, esses: false, sweeper: false }), 20)) {
      const kinds = plan.passages.map((p) => p.kind);
      for (const kind of ['hairpin', 'chicane', 'flow', 'sweeper'] as const) expect(kinds).not.toContain(kind);
    }
  });

  it('gives each place to brake hard a straight of its own', () => {
    const braking = (plan: Plan) => plan.passages.filter((p) => ['stop', 'hairpin', 'ess', 'triple', 'chicane', 'long'].includes(p.kind) && p.straight >= 250).length;
    expect(mean(plans(settings({ seed: 'brake', brakingPoints: 5 }), 30).map(braking))).toBeGreaterThan(mean(plans(settings({ seed: 'brake', brakingPoints: 1 }), 30).map(braking)) + 1.5);
    for (const plan of plans(settings({ seed: 'brake', brakingPoints: 4, length: 6000 }), 20)) expect(braking(plan)).toBeGreaterThanOrEqual(4);
    // With none asked, the first corner is one that is not braked hard for.
    for (const plan of plans(settings({ seed: 'brake', brakingPoints: 0 }), 20)) expect(['turn', 'long', 'sweeper', 'kink']).toContain(plan.passages[0].kind);
  });

  it('gives a lap that is to fold back turns right round, wide enough for its legs to run side by side', () => {
    const rounds = (plan: Plan) => plan.passages.filter((p) => p.kind === 'hairpin').length / plan.passages.length;
    const plain = { hairpin: false, chicane: false, esses: false, sweeper: false };
    const folded = settings({ seed: 'fold', foldBack: 1, ...plain });
    expect(mean(plans(folded, 30).map(rounds))).toBeGreaterThan(0.5);
    expect(mean(plans(settings({ seed: 'fold', foldBack: 0.5, ...plain }), 30).map(rounds))).toBe(0);
    for (const plan of plans(folded, 10)) {
      for (const p of plan.passages.filter((q) => q.kind === 'hairpin')) {
        expect(p.bends[0].turn / DEG).toBeGreaterThan(170);
        expect(p.bends[0].turn / DEG).toBeLessThan(190);
        expect(2 * p.bends[0].radius).toBeGreaterThan(gapFor(folded));
      }
    }
  });

  it('gives one open loop corners that turn it once round and little more', () => {
    const all = (s2: GeneratorSettings) => mean(plans(s2, 30).map((plan) => plan.passages.reduce((a, p) => a + turning(p), 0) / DEG));
    const open = all(settings({ seed: 'open', foldBack: 0, hairpin: false }));
    expect(open).toBeLessThan(330);
    expect(all(settings({ seed: 'open', foldBack: 0.5, hairpin: false }))).toBeGreaterThan(open + 200);
  });

  it('takes its radii from the mix asked', () => {
    expect(mixWanted(settings())).toEqual(REAL_MIX);
    const mix = mixWanted(settings({ slow: 2, medium: 1, fast: 0 }));
    expect(mix.fast).toBe(0);
    expect(mix.slow + mix.medium).toBeCloseTo(1, 9);
    expect(mix.slow).toBeGreaterThan(REAL_MIX.slow + 0.2);
    // A lap that is to be fast leans to fast corners, and one that is to be all corners to slow ones.
    expect(mixWanted(settings({ speed: 1 })).fast).toBeGreaterThan(REAL_MIX.fast + 0.15);
    expect(mixWanted(settings({ speed: 0 })).slow).toBeGreaterThan(REAL_MIX.slow + 0.15);
  });

  it('makes a corner of arcs: wide, tight and wide, or tightening, or opening, or one radius', () => {
    const bends = drawn.flatMap((plan) => plan.passages.flatMap((p) => p.bends.map((b) => ({ ...b, kind: p.kind }))));
    for (const b of bends) {
      expect(b.arcs.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 9);
      // No arc tighter than a car can turn.
      for (const a of b.arcs) expect(b.radius * a.ratio).toBeGreaterThanOrEqual(14 - 1e-9);
      // A kink, a chicane's corners and a corner that turns little are one arc.
      if (b.kind === 'kink' || b.kind === 'chicane' || b.turn < 40 * DEG) expect(b.arcs.length).toBe(1);
    }
    const made = bends.filter((b) => b.arcs.length > 1);
    // More than half the corners that turn 45 degrees or more are of two or three arcs, and of every form.
    expect(made.length).toBeGreaterThan(0.5 * bends.filter((b) => b.turn >= 45 * DEG && b.kind !== 'chicane').length);
    expect(made.some((b) => b.arcs.length === 3 && b.arcs[1].ratio < b.arcs[0].ratio && b.arcs[1].ratio < b.arcs[2].ratio)).toBe(true);
    expect(made.some((b) => b.arcs.length === 2 && b.arcs[0].ratio > b.arcs[1].ratio)).toBe(true);
    expect(made.some((b) => b.arcs.length === 2 && b.arcs[0].ratio < b.arcs[1].ratio)).toBe(true);
    // The tightest arc of such a corner is a good deal tighter than the corner's radius, which is that of the middle of its turning.
    const tightening = made.map((b) => 1 / Math.min(...b.arcs.map((a) => a.ratio))).sort((a, c) => a - c);
    expect(tightening[Math.floor(tightening.length / 2)]).toBeGreaterThan(1.25);
    expect(tightening[tightening.length - 1]).toBeLessThan(2.6);
  });

  it('has chicanes of more than one kind', () => {
    const chicanes = plans(settings({ seed: 'chicanes', chicane: true }), 80).flatMap((plan) => plan.passages.filter((p) => p.kind === 'chicane'));
    const counts = new Set(chicanes.map((p) => p.bends.length));
    expect(counts).toEqual(new Set([2, 3, 4]));
    // Tight ones of 15 to 24 m, and fast ones of 40 to 70 m.
    expect(chicanes.some((p) => p.bends.every((b) => b.radius < 25))).toBe(true);
    expect(chicanes.some((p) => p.bends.every((b) => b.radius >= 40))).toBe(true);
    // A bus stop comes back onto the line it left: it turns as much one way as the other.
    for (const p of chicanes.filter((q) => q.bends.length === 4)) expect(Math.abs(p.bends.reduce((a, b) => a + b.side * b.turn, 0))).toBeLessThan(1e-9);
  });

  it('says so when what is asked does not go into the lap', () => {
    // A kilometre with the longest straights a kilometre takes, and more named corners than it has room for: fewer passages, or none.
    const tight = plans(settings({ seed: 'tight', length: 1000, longestStraight: 420, startStraight: 330, hairpin: true, chicane: true, esses: true, sweeper: true, brakingPoints: 8 }), 30);
    for (const plan of tight) expect(plan.passages.reduce((a, p) => a + p.straight + p.length, 0) + plan.reserve).toBeLessThan(1000 * 1.03);
  });
});

describe('a lap that flows, and one that stops and goes', () => {
  const of = (flow: number, changes: Partial<GeneratorSettings> = {}) => plans(settings({ seed: 'flow', flow, ...changes }), 40);
  const still = of(0), middle = of(0.5), flowing = of(1);
  const share = (list: Plan[], is: (p: Plan['passages'][number]) => boolean) => mean(list.map((plan) => plan.passages.filter(is).length / plan.passages.length));

  it('has straights that are straight and corners that begin at once, at one end of the slider', () => {
    expect(still.length).toBe(40);
    for (const plan of still) {
      for (const p of plan.passages) {
        expect(p.bow).toBeNull();
        expect(p.eased).toEqual([0, 0]);
        expect(['long', 'winding']).not.toContain(p.kind);
      }
    }
  });

  it('bows its straights, more of them the more it flows, but never the one the grid stands on', () => {
    expect(share(middle, (p) => p.bow !== null)).toBeGreaterThan(0.08);
    expect(share(flowing, (p) => p.bow !== null)).toBeGreaterThan(share(middle, (p) => p.bow !== null));
    for (const plan of [...middle, ...flowing]) expect(plan.passages[0].bow).toBeNull();
    // The longest straight bows only above the middle, and then so little that it reads as one straight of the length asked.
    for (const plan of middle) expect(plan.passages[plan.main].bow).toBeNull();
    const longest = flowing.map((plan) => plan.passages[plan.main]).filter((p) => p.bow !== null);
    expect(longest.length).toBeGreaterThan(10);
    for (const p of longest) {
      for (const arc of p.bow!.arcs) {
        expect(arc.turn).toBeLessThanOrEqual(7 * DEG + 1e-9);
        expect((arc.share * p.straight) / arc.turn).toBeGreaterThanOrEqual(2200 - 1e-6);
      }
    }
  });

  it('keeps a bow gentle, and clear of the corners at the ends of its straight', () => {
    let bows = 0;
    for (const plan of [...middle, ...flowing]) {
      for (const p of plan.passages) {
        if (!p.bow) continue;
        bows++;
        const bowed = p.bow.arcs.reduce((a, arc) => a + arc.share, 0);
        expect(p.bow.from * p.straight).toBeGreaterThanOrEqual(40 - 1e-6);
        expect((1 - p.bow.from - bowed) * p.straight).toBeGreaterThanOrEqual(40 - 1e-6);
        for (const arc of p.bow.arcs) {
          expect(arc.turn).toBeGreaterThanOrEqual(5 * DEG - 1e-9);
          expect(arc.turn).toBeLessThanOrEqual(28 * DEG + 1e-9);
          expect((arc.share * p.straight) / arc.turn).toBeGreaterThanOrEqual(450 - 1e-6);
        }
      }
    }
    expect(bows).toBeGreaterThan(100);
  });

  it('eases its corners in and out by a wide arc, more of them the more it flows', () => {
    const eased = (p: Plan['passages'][number]) => p.eased[0] > 0 || p.eased[1] > 0;
    expect(share(middle, eased)).toBeGreaterThan(0.3);
    expect(share(flowing, eased)).toBeGreaterThan(share(middle, eased));
    for (const plan of [...still, ...middle, ...flowing]) {
      for (const p of plan.passages) {
        // (Whatever arcs a corner is made of, they are the whole of its turn.)
        for (const b of p.bends) expect(b.arcs.reduce((a, arc) => a + arc.share, 0)).toBeCloseTo(1, 6);
        const first = p.bends[0];
        if (p.eased[0] > 0 && first.arcs.length > 1) {
          expect(first.arcs[0].ratio * first.radius).toBeGreaterThanOrEqual(320 - 1e-6);
          expect(first.arcs[0].ratio * first.radius).toBeLessThanOrEqual(800 + 1e-6);
          expect(first.arcs[0].share * first.turn).toBeLessThan(11 * DEG);
        }
      }
    }
  });

  it('has long corners, more of them the more it flows: of two or three apexes, or one radius', () => {
    const long = (list: Plan[]) => list.flatMap((plan) => plan.passages.filter((p) => p.kind === 'long'));
    expect(long(middle).length).toBeGreaterThan(10);
    expect(long(flowing).length).toBeGreaterThan(1.5 * long(middle).length);
    const all = [...long(middle), ...long(flowing)];
    for (const p of all) {
      expect(p.bends.length).toBe(1);
      expect(p.bends[0].radius).toBeGreaterThanOrEqual(16);
      expect(p.bends[0].radius).toBeLessThanOrEqual(190 + 1e-6);
    }
    expect(mean(all.map((p) => p.length))).toBeGreaterThan(200);
    expect(mean(all.map((p) => p.bends[0].turn))).toBeGreaterThan(100 * DEG);
    // (The arcs it is eased in and out by not counted.)
    const arcs = new Set(all.map((p) => p.bends[0].arcs.filter((a) => a.ratio * p.bends[0].radius < 300).length));
    for (const count of [1, 2, 3]) expect(arcs, `${count} arcs`).toContain(count);
    expect(Math.max(...arcs)).toBeGreaterThanOrEqual(5);
  });

  it('has no long corner and no winding road where the corners are all to be slow', () => {
    for (const plan of of(1, { slow: 3, medium: 0, fast: 0 })) for (const p of plan.passages) expect(['long', 'winding']).not.toContain(p.kind);
  });

  it('turns no tighter than a wide road can be built', () => {
    for (const [width, least] of [[12, 14], [30, 17.5]] as const) {
      for (const plan of plans(settings({ seed: 'wide', width }), 20)) {
        for (const p of plan.passages) for (const b of p.bends) expect(b.radius * Math.min(...b.arcs.map((a) => a.ratio)), `${width} m`).toBeGreaterThanOrEqual(least - 1e-6);
      }
    }
  });

  it('comes round as a lap at either end', () => {
    for (const flow of [0, 1]) expect(laps(settings({ seed: 'flow', flow }), 30).length, `flow ${flow}`).toBeGreaterThan(10);
  });
});

describe('the lap as laid', () => {
  const s = settings({ seed: 'laid' });
  const drawn = laps(s, 30);

  it('comes round most of the time', () => {
    expect(drawn.length).toBeGreaterThan(12);
  });

  it('is a closed line of straights and arcs, each arc fitting on the straights either side of it', () => {
    for (const shape of drawn) {
      const { angle, tangent, edge } = turns(shape.v);
      const n = shape.v.length;
      for (let i = 0; i < n; i++) expect(edge[i] - tangent[i] - tangent[(i + 1) % n]).toBeGreaterThan(-1e-6);
      // Once round, to the right.
      expect(angle.reduce((a, x) => a + x, 0)).toBeCloseTo(2 * Math.PI, 6);
      expect(signedArea(shape.v)).toBeGreaterThan(0);
      expect(lapLength(shape.v)).toBeCloseTo(s.length, 3);
    }
  });

  it('knows its start straight and its longest', () => {
    for (const shape of drawn) {
      const { tangent, edge } = turns(shape.v);
      const n = shape.v.length;
      const straight = (i: number) => edge[i] - tangent[i] - tangent[(i + 1) % n];
      const longest = Math.max(...shape.v.map((_, i) => straight(i)));
      expect(straight(shape.main)).toBeCloseTo(longest, 6);
      expect(shape.start).toBe(n - 1);
      // The start straight as asked, give or take what bringing the lap to length and home takes.
      expect(straight(shape.start)).toBeGreaterThan(0.93 * s.startStraight);
      expect(straight(shape.start)).toBeLessThan(1.45 * s.startStraight);
      // And no straight much longer than the longest asked.
      expect(longest).toBeLessThan(1.15 * s.longestStraight + STRAIGHT_CREEP);
    }
  });

  it('has corners that tighten to their apex', () => {
    const all = drawn.flatMap((shape) => cornersOf(shape.v));
    const ratio = all.map((c) => c.middle / c.radius).sort((a, b) => a - b);
    // Half of them or more are tighter at their tightest than in the middle of their turning; some by half as much again.
    expect(ratio[Math.floor(ratio.length * 0.6)]).toBeGreaterThan(1.05);
    expect(ratio[ratio.length - 1]).toBeGreaterThan(1.5);
    expect(ratio[0]).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('has corners of every kind and both ways', () => {
    const all = drawn.flatMap((shape) => cornersOf(shape.v));
    expect(all.some((c) => c.radius < 45)).toBe(true);
    expect(all.some((c) => c.radius > 120)).toBe(true);
    expect(all.some((c) => c.turn > 150 * DEG)).toBe(true);
    expect(all.some((c) => c.turn < 40 * DEG)).toBe(true);
    for (const shape of drawn) {
      const { angle } = turns(shape.v);
      expect(angle.some((a) => a < -0.3)).toBe(true);
      expect(angle.some((a) => a > 0.3)).toBe(true);
    }
  });

  it('is the same lap for the same random numbers', () => {
    const again = laps(s, 30);
    expect(again.map((shape) => shape.v)).toEqual(drawn.map((shape) => shape.v));
  });

  it('lays a lap of four corners and one of sixty', () => {
    const short = laps(settings({ seed: 'few', length: 1000, longestStraight: 300, startStraight: 250 }), 30);
    expect(short.length).toBeGreaterThan(8);
    expect(mean(short.map((shape) => cornersOf(shape.v).length))).toBeLessThan(6.5);
    const long = laps(settings({ seed: 'many', length: 18000 }), 12);
    expect(long.length).toBeGreaterThan(2);
    for (const shape of long) expect(cornersOf(shape.v).length).toBeGreaterThan(45);
  });
});
