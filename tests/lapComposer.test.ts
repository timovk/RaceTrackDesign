import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATOR, type GeneratorSettings, gapFor } from '../src/core/generator.ts';
import { type Plan, REAL_MIX, composeLap, cornersWanted, drawPlan, mixWanted, ownStart } from '../src/core/lapComposer.ts';
import { type Shape, STRAIGHT_CREEP, cornersOf, lapLength, signedArea, turns } from '../src/core/lapShape.ts';
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
      // (Drawn a little longer than asked: a straight reads shorter on the track.)
      expect(start.straight).toBeGreaterThan(s.startStraight + STRAIGHT_CREEP);
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
    const corners = drawn.map((plan) => plan.passages.reduce((a, p) => a + p.bends.filter((b) => b.turn >= 15 * DEG && b.radius < 300).length, 0) + 2);
    expect(Math.abs(mean(corners) - wanted)).toBeLessThan(1.5);
    for (const c of corners) expect(Math.abs(c - wanted)).toBeLessThanOrEqual(6);
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
    const braking = (plan: Plan) => plan.passages.filter((p) => ['stop', 'hairpin', 'ess', 'triple', 'chicane'].includes(p.kind) && p.straight >= 250).length;
    expect(mean(plans(settings({ seed: 'brake', brakingPoints: 5 }), 30).map(braking))).toBeGreaterThan(mean(plans(settings({ seed: 'brake', brakingPoints: 1 }), 30).map(braking)) + 2);
    for (const plan of plans(settings({ seed: 'brake', brakingPoints: 4, length: 6000 }), 20)) expect(braking(plan)).toBeGreaterThanOrEqual(4);
    // With none asked, the first corner is one that is not braked hard for.
    for (const plan of plans(settings({ seed: 'brake', brakingPoints: 0 }), 20)) expect(['turn', 'sweeper', 'kink']).toContain(plan.passages[0].kind);
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

  it('says so when what is asked does not go into the lap', () => {
    // A kilometre with the longest straights a kilometre takes, and more named corners than it has room for: fewer passages, or none.
    const tight = plans(settings({ seed: 'tight', length: 1000, longestStraight: 420, startStraight: 330, hairpin: true, chicane: true, esses: true, sweeper: true, brakingPoints: 8 }), 30);
    for (const plan of tight) expect(plan.passages.reduce((a, p) => a + p.straight + p.length, 0) + plan.reserve).toBeLessThan(1000 * 1.03);
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
