import { describe, expect, it } from 'vitest';
import {
  CORNER_RADII, DEFAULT_GENERATOR, GENERATOR_RANGE, GENERATOR_STYLES, type GeneratorSettings, type Shape,
  classNeeds, cornersWanted, drawShape, findSite, gapFor, generateTracks, measureShape, resolveSettings, scoreShape, shortRunoff, tracePath,
} from '../src/core/generator.ts';
import { sampleHeight } from '../src/core/heightmap.ts';
import { seededRandom } from '../src/core/rng.ts';
import { woodsAt } from '../src/core/scenery.ts';
import { GRID_LENGTH } from '../src/core/startFinish.ts';
import { defaultTerrainSettings, generateHeightmap } from '../src/core/terrain.ts';
import { buildTrack } from '../src/core/track.ts';
import { validateTrack } from '../src/core/validate.ts';
import { VEHICLES } from '../src/core/vehicles.ts';

const vehicle = (id: string) => VEHICLES.find((v) => v.id === id)!;
const style = (id: string) => GENERATOR_STYLES.find((s) => s.id === id)!;
const settings = (changes: Partial<GeneratorSettings> = {}): GeneratorSettings => ({ ...DEFAULT_GENERATOR, licence: false, ...changes });

/** Shapes drawn to settings, as many as come out of `tries` attempts. */
function shapes(s: GeneratorSettings, tries: number, gap = 60): Shape[] {
  const rng = seededRandom(`test:${s.seed}`);
  const out: Shape[] = [];
  for (let i = 0; i < tries; i++) {
    const shape = drawShape(s, rng, gap);
    if (shape) out.push(shape);
  }
  return out;
}

/** Twice the area of a closed line, positive when it runs clockwise on the map (y to the south). */
function turning(x: number[], y: number[]): number {
  let a = 0;
  for (let i = 0; i < x.length; i++) {
    const j = (i + 1) % x.length;
    a += x[i] * y[j] - x[j] * y[i];
  }
  return a;
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

const terrainSettings = { ...defaultTerrainSettings('alpha', 'rolling'), resolution: 512 };
const hm = generateHeightmap(terrainSettings);
const ctx = { heightmap: hm, terrainSeed: terrainSettings.seed, vehicles: VEHICLES };

describe('what is asked', () => {
  it('holds every setting within its range', () => {
    const { settings: s, needs, notes } = resolveSettings(settings({ length: 90000, width: 2, heightDifference: 5000, speed: 3, compact: -1, brakingPoints: 40, slow: 0, medium: 0, fast: 0, longestStraight: 90000, startStraight: 90000, candidates: 99 }), vehicle('gt3'));
    expect(s.length).toBe(GENERATOR_RANGE.length[1]);
    expect(s.width).toBe(GENERATOR_RANGE.width[0]);
    expect(s.heightDifference).toBe(GENERATOR_RANGE.heightDifference[1]);
    expect(s.speed).toBe(1);
    expect(s.compact).toBe(0);
    expect(s.brakingPoints).toBe(GENERATOR_RANGE.brakingPoints[1]);
    expect(s.slow + s.medium + s.fast).toBeGreaterThan(0);
    expect(s.longestStraight).toBe(GENERATOR_RANGE.longestStraight[1]);
    expect(s.startStraight).toBeLessThanOrEqual(s.longestStraight);
    expect(s.candidates).toBe(12);
    expect(needs).toBeNull();
    expect(notes).toEqual([]);
    // A straight is at most the share of the lap that leaves room to come back.
    const short = resolveSettings(settings({ length: 2000, longestStraight: 1900, startStraight: 1900 }), null).settings;
    expect(short.longestStraight).toBeCloseTo(2000 * GENERATOR_RANGE.straightShare, 6);
    expect(short.startStraight).toBe(short.longestStraight);
  });

  it('lets the settings go a long way', () => {
    expect(GENERATOR_RANGE.length[0]).toBeLessThanOrEqual(1000);
    expect(GENERATOR_RANGE.length[1]).toBeGreaterThanOrEqual(20000);
    expect(GENERATOR_RANGE.width[1]).toBeGreaterThanOrEqual(30);
    expect(GENERATOR_RANGE.heightDifference[1]).toBeGreaterThanOrEqual(500);
    expect(GENERATOR_RANGE.longestStraight[1]).toBeGreaterThanOrEqual(4000);
    const asked = settings({ length: 20000, width: 30, heightDifference: 500, longestStraight: 4000, startStraight: 2500, brakingPoints: 12 });
    expect(resolveSettings(asked, null).settings).toEqual(asked);
  });

  it('keeps what is asked of a track built to a licence, and says what stands in the way', () => {
    const asked = settings({ licence: true, vehicleId: 'f1', length: 2500, width: 9, startStraight: 300, longestStraight: 400 });
    const { settings: s, needs, notes } = resolveSettings(asked, vehicle('f1'));
    expect(needs).not.toBeNull();
    expect(s).toEqual(asked);
    expect(notes.length).toBe(3);
    expect(notes.every((n) => n.includes('Formula 1'))).toBe(true);
    expect(notes.some((n) => n.includes('9 m wide') && n.includes('12 m'))).toBe(true);
    expect(notes.some((n) => n.includes('2.5 km') && n.includes('3.5 km'))).toBe(true);
    expect(notes.some((n) => n.includes('300 m'))).toBe(true);
    // Nothing to say when nothing stands in the way.
    expect(resolveSettings({ ...DEFAULT_GENERATOR, ...style('grand-prix').settings }, vehicle('f1')).notes).toEqual([]);
  });

  it('says so when a straight is longer than the FIM allows, and leaves it', () => {
    const { settings: s, notes } = resolveSettings(settings({ licence: true, vehicleId: 'motogp', length: 6000, longestStraight: 1800 }), vehicle('motogp'));
    expect(s.longestStraight).toBe(1800);
    expect(notes.some((n) => n.includes('1800 m') && n.includes('1000 m'))).toBe(true);
  });

  it('knows what each body asks', () => {
    const car = classNeeds(vehicle('f1'));
    const bike = classNeeds(vehicle('motogp'));
    expect(car.gridWidth).toBe(15);
    expect(bike.gridWidth).toBe(14);
    expect(car.maxStraight).toBe(2000);
    expect(bike.maxStraight).toBe(1000);
    expect(car.minLength).toBe(3500);
    expect(classNeeds(vehicle('tcr')).minLength).toBe(2000);
    // The FIM requires the distance to the first corner; the FIA the grid on the straight.
    expect(bike.cornerFirst).toBe(true);
    expect(car.cornerFirst).toBe(false);
    expect(car.startStraight).toBeGreaterThanOrEqual(GRID_LENGTH + 250);
  });

  it('wants more corners of a twisty lap than of a fast one, and more of a long lap', () => {
    expect(cornersWanted(settings({ speed: 0.1 }))).toBeGreaterThan(cornersWanted(settings({ speed: 0.9 })) + 5);
    expect(cornersWanted(settings({ length: 7000 }))).toBeGreaterThan(cornersWanted(settings({ length: 3000 })));
    // From a kart track to an oval with a bend in it: some nine corners a kilometre of what is not straight, to little more than one.
    expect(cornersWanted(settings({ speed: 0 }))).toBeGreaterThan(30);
    expect(cornersWanted(settings({ speed: 1 }))).toBeLessThan(8);
    // The two straights carry none: shorter ones leave more lap for corners.
    expect(cornersWanted(settings({ speed: 0, longestStraight: 400, startStraight: 300 }))).toBeGreaterThan(cornersWanted(settings({ speed: 0 })) + 5);
  });

  it('keeps the parts of a lap as far apart as the track is wide and a strip of ground, and further for a lap that does not fold', () => {
    expect(gapFor(settings({ width: 12, foldBack: 1 }))).toBe(28);
    expect(gapFor(settings({ width: 12, foldBack: 0 }))).toBe(60);
    expect(gapFor(settings({ width: 30, foldBack: 1 }))).toBe(46);
  });

  it('has styles that name a class there is, each its own', () => {
    expect(GENERATOR_STYLES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(GENERATOR_STYLES.map((s) => s.id)).size).toBe(GENERATOR_STYLES.length);
    for (const s of GENERATOR_STYLES) {
      expect(VEHICLES.some((v) => v.id === s.settings.vehicleId), s.id).toBe(true);
      expect(s.summary.length, s.id).toBeGreaterThan(20);
    }
  });
});

describe('the lap as drawn', () => {
  const s = settings({ seed: 'shapes' });
  const drawn = shapes(s, 60);

  it('draws a good share of what it tries', () => {
    // (The others had parts too close to each other, or corners that would not fit.)
    expect(drawn.length).toBeGreaterThan(24);
  });

  it('is as long as asked', () => {
    for (const shape of drawn) expect(Math.abs(measureShape(shape).length - s.length)).toBeLessThan(s.length * 0.01);
    const short = shapes(settings({ seed: 'short', length: 2400, longestStraight: 500, startStraight: 350 }), 30);
    expect(short.length).toBeGreaterThan(10);
    for (const shape of short) expect(Math.abs(measureShape(shape).length - 2400)).toBeLessThan(24);
  });

  it('runs the way asked', () => {
    for (const shape of drawn) {
      const p = tracePath(shape, 30);
      expect(turning(p.x, p.y)).toBeGreaterThan(0);
    }
    for (const shape of shapes(settings({ seed: 'shapes', direction: 'anticlockwise' }), 30)) {
      const p = tracePath(shape, 30);
      expect(turning(p.x, p.y)).toBeLessThan(0);
    }
    const either = shapes(settings({ seed: 'either', direction: 'either' }), 60).map((shape) => Math.sign(turning(tracePath(shape, 30).x, tracePath(shape, 30).y)));
    expect(either).toContain(1);
    expect(either).toContain(-1);
  });

  it('keeps its parts apart', () => {
    for (const shape of drawn) {
      const p = tracePath(shape, 20);
      let nearest = Infinity;
      for (let i = 0; i < p.x.length; i++) {
        for (let j = i + 1; j < p.x.length; j++) {
          const along = p.s[j] - p.s[i];
          if (along < 200 || p.length - along < 200) continue;
          nearest = Math.min(nearest, Math.hypot(p.x[i] - p.x[j], p.y[i] - p.y[j]));
        }
      }
      // Asked to keep 60 m; the points are up to 20 m apart.
      expect(nearest).toBeGreaterThan(45);
    }
  });

  it('gives every corner a radius that can be built', () => {
    for (const shape of drawn) {
      for (const v of shape.v) {
        expect(v.r).toBeGreaterThanOrEqual(12);
        expect(v.r).toBeLessThanOrEqual(CORNER_RADII.fast[1] * 2);
      }
      const p = tracePath(shape, 30);
      expect(p.x.every(Number.isFinite) && p.y.every(Number.isFinite)).toBe(true);
    }
  });

  it('has a longest straight about as long as asked', () => {
    for (const shape of drawn) {
      const m = measureShape(shape);
      expect(m.longestStraight).toBeGreaterThanOrEqual(m.startStraight - 1e-6);
    }
    expect(mean(drawn.map((shape) => measureShape(shape).longestStraight))).toBeGreaterThan(s.longestStraight * 0.8);
    expect(mean(drawn.map((shape) => measureShape(shape).longestStraight))).toBeLessThan(s.longestStraight * 1.25);
  });

  it('scores a lap by how far it is from what was asked', () => {
    const shape = drawn[0];
    const wanted = cornersWanted(s);
    // A lap that is all that was asked, and the same lap off in one thing at a time.
    const asked = { ...measureShape(shape), corners: wanted, slow: wanted * (1 / 3.3), medium: wanted * (1.3 / 3.3), fast: wanted * (1 / 3.3), longestStraight: s.longestStraight, startStraight: s.startStraight, brakingPoints: s.brakingPoints, spread: 0.5 - 0.36 * s.compact, folded: 0.05 + 0.85 * s.foldBack };
    const all = { ...shape, made: { hairpin: true, chicane: true, esses: true, sweeper: true } };
    const best = scoreShape(asked, all, s);
    expect(best).toBeLessThan(0.01);
    expect(scoreShape({ ...asked, corners: wanted * 1.6 }, all, s)).toBeGreaterThan(best + 1);
    expect(scoreShape({ ...asked, corners: wanted * 0.5 }, all, s)).toBeGreaterThan(best + 0.5);
    expect(scoreShape({ ...asked, longestStraight: s.longestStraight * 1.6 }, all, s)).toBeGreaterThan(best + 1);
    expect(scoreShape({ ...asked, longestStraight: s.longestStraight * 0.5 }, all, s)).toBeGreaterThan(best + 0.3);
    expect(scoreShape({ ...asked, startStraight: s.startStraight * 0.5 }, all, s)).toBeGreaterThan(best + 0.5);
    // (A start straight longer than asked is no fault.)
    expect(scoreShape({ ...asked, startStraight: s.startStraight * 1.2 }, all, s)).toBeCloseTo(best, 6);
    expect(scoreShape({ ...asked, folded: 0.9 }, all, s)).toBeGreaterThan(best + 1);
    expect(scoreShape({ ...asked, spread: 0.15 }, all, s)).toBeGreaterThan(best + 1);
    expect(scoreShape({ ...asked, slow: wanted, medium: 0, fast: 0 }, all, s)).toBeGreaterThan(best + 0.5);
    // A feature asked for and not made costs.
    expect(scoreShape(asked, { ...shape, made: { hairpin: true, chicane: true, esses: true, sweeper: false } }, s)).toBeCloseTo(best + 1.5, 6);
  });

  it('makes the features asked for, most of the time', () => {
    const all = shapes(settings({ seed: 'features', hairpin: true, chicane: true, esses: true, sweeper: true }), 60);
    for (const f of ['hairpin', 'chicane', 'esses'] as const) {
      expect(all.filter((shape) => shape.made[f]).length, f).toBeGreaterThan(all.length * 0.8);
    }
    // A sweeper needs two long straights to stand between: with everything else on the lap there is less often room.
    expect(all.filter((shape) => shape.made.sweeper).length).toBeGreaterThan(all.length * 0.15);
    const sweeper = shapes(settings({ seed: 'features', hairpin: false, chicane: false, esses: false, sweeper: true }), 60);
    expect(sweeper.filter((shape) => shape.made.sweeper).length).toBeGreaterThan(sweeper.length * 0.5);
    const none = shapes(settings({ seed: 'features', hairpin: false, chicane: false, esses: false, sweeper: false }), 30);
    for (const shape of none) expect(Object.values(shape.made).some(Boolean)).toBe(false);
  });

  it('follows the mix of corners', () => {
    const plain = { hairpin: false, chicane: false, esses: false, sweeper: false };
    const slow = shapes(settings({ seed: 'mix', ...plain, slow: 3, medium: 0.5, fast: 0 }), 40).map((shape) => measureShape(shape));
    const fast = shapes(settings({ seed: 'mix', ...plain, slow: 0, medium: 0.5, fast: 3 }), 40).map((shape) => measureShape(shape));
    // (A fast corner needs room: where two stand close, the lap makes them tighter, so fewer come out fast than were drawn.)
    expect(mean(slow.map((m) => m.slow / m.corners))).toBeGreaterThan(0.5);
    expect(mean(fast.map((m) => m.fast / m.corners))).toBeGreaterThan(0.35);
    expect(mean(slow.map((m) => m.fast / m.corners))).toBeLessThan(0.1);
    expect(mean(fast.map((m) => m.slow / m.corners))).toBeLessThan(0.2);
  });

  it('has more corners when asked for corners than when asked for speed', () => {
    const twisty = shapes(settings({ seed: 'speed', speed: 0.1 }), 40).map((shape) => measureShape(shape).corners);
    const quick = shapes(settings({ seed: 'speed', speed: 0.9 }), 40).map((shape) => measureShape(shape).corners);
    expect(mean(twisty)).toBeGreaterThan(mean(quick) + 4);
  });

  it('is more spread out when asked, and folds back when asked', () => {
    const open = shapes(settings({ seed: 'form', compact: 0, foldBack: 0 }), 40).map((shape) => measureShape(shape));
    const tight = shapes(settings({ seed: 'form', compact: 1, foldBack: 1 }), 40).map((shape) => measureShape(shape));
    expect(mean(open.map((m) => m.spread))).toBeGreaterThan(mean(tight.map((m) => m.spread)));
    expect(mean(tight.map((m) => m.folded))).toBeGreaterThan(mean(open.map((m) => m.folded)));
  });

  it('counts heavy braking by the class it is for', () => {
    // The same lap: a Formula 1 car comes to its slow corners much faster than a touring car.
    const f1 = mean(drawn.map((shape) => measureShape(shape, vehicle('f1')).brakingPoints));
    const tcr = mean(drawn.map((shape) => measureShape(shape, vehicle('tcr')).brakingPoints));
    expect(f1).toBeGreaterThan(tcr);
  });
});

describe('the ends of the sliders', () => {
  const plain = { hairpin: false, chicane: false, esses: false, sweeper: false };
  const drawn = (changes: Partial<GeneratorSettings>, tries = 50) => {
    const s = resolveSettings(settings({ seed: 'ends', ...changes }), null).settings;
    return { s, list: shapes(s, tries, gapFor(s)) };
  };

  it('draws most of what it tries, whatever is asked', () => {
    for (const changes of [{}, { speed: 0 }, { speed: 1 }, { foldBack: 1, compact: 1 }, { foldBack: 0, compact: 0 }, { length: 1000, longestStraight: 300, startStraight: 250 }, { length: 20000 }, { longestStraight: 2000, startStraight: 1500 }, { width: 30 }] as Partial<GeneratorSettings>[]) {
      expect(drawn(changes).list.length, JSON.stringify(changes)).toBeGreaterThan(20);
    }
  });

  it('gives a lap of corner after corner when asked, and one of a few when not', () => {
    const twisty = drawn({ speed: 0, longestStraight: 400, startStraight: 300 });
    const fast = drawn({ speed: 1, foldBack: 0, compact: 0, ...plain });
    const corners = (x: { list: Shape[] }) => mean(x.list.map((shape) => measureShape(shape).corners));
    // Five kilometres: over thirty corners at one end, under nine at the other.
    expect(corners(twisty)).toBeGreaterThan(30);
    expect(corners(fast)).toBeLessThan(9);
  });

  it('folds a lap right back when asked: rows of legs side by side, turning right round at their ends', () => {
    const folded = drawn({ foldBack: 1, compact: 1, ...plain, longestStraight: 500, startStraight: 400 });
    const open = drawn({ foldBack: 0, compact: 0, ...plain, longestStraight: 500, startStraight: 400 });
    const share = (x: { list: Shape[] }) => mean(x.list.map((shape) => measureShape(shape).folded));
    expect(share(folded)).toBeGreaterThan(0.5);
    expect(share(open)).toBeLessThan(0.12);
    // The best of them: two thirds of the lap or more has another part of it within 120 m.
    const best = folded.list.map((shape) => measureShape(shape).folded).sort((a, b) => b - a).slice(0, 5);
    expect(Math.min(...best)).toBeGreaterThan(0.66);
    for (const shape of folded.list) {
      // Turns right round are two corners of the same radius, a leg's width apart.
      const turns = shape.v.filter((p) => p.feature === 'fold' && p.fixed);
      expect(turns.length).toBeGreaterThanOrEqual(4);
      for (const p of turns) expect(p.r).toBeGreaterThanOrEqual(15);
    }
    for (const shape of open.list) expect(shape.v.some((p) => p.feature === 'fold')).toBe(false);
  });

  it('keeps the legs of a fold a gap apart', () => {
    const { s, list } = drawn({ foldBack: 1, compact: 1 });
    const gap = gapFor(s);
    for (const shape of list) {
      const p = tracePath(shape, 10);
      let nearest = Infinity;
      for (let i = 0; i < p.x.length; i++) {
        for (let j = i + 1; j < p.x.length; j++) {
          const along = p.s[j] - p.s[i];
          if (along < 110 || p.length - along < 110) continue;
          nearest = Math.min(nearest, Math.hypot(p.x[i] - p.x[j], p.y[i] - p.y[j]));
        }
      }
      // (The points are up to 10 m apart, so two may stand a little nearer than the lines they are on.)
      expect(nearest).toBeGreaterThan(gap - 3);
    }
  });

  it('is small across when compact and folded, and long when spread out', () => {
    const across = (x: { list: Shape[] }) => mean(x.list.map((shape) => measureShape(shape).spread));
    const compact = across(drawn({ foldBack: 1, compact: 1 }));
    const spread = across(drawn({ foldBack: 0, compact: 0 }));
    expect(compact).toBeLessThan(0.3);
    expect(spread).toBeGreaterThan(0.4);
  });

  it('gives the longest straight asked, and none longer', () => {
    for (const [length, longest, start] of [[5000, 2000, 1500], [5000, 300, 250], [5000, 900, 600], [12000, 900, 600]] as const) {
      const { list } = drawn({ length, longestStraight: longest, startStraight: start });
      const got = list.map((shape) => measureShape(shape).longestStraight).sort((a, b) => a - b);
      const middle = got[Math.floor(got.length / 2)];
      expect(Math.abs(middle - longest), `${longest} m of ${length}`).toBeLessThan(0.08 * longest + 20);
      // Nine in ten within a sixth of it.
      expect(got[Math.floor(got.length * 0.9)], `${longest} m of ${length}`).toBeLessThan(longest * 1.17 + 20);
    }
  });

  it('draws the shortest lap and a very long one to their length', () => {
    for (const changes of [{ length: 1000, longestStraight: 300, startStraight: 250 }, { length: 20000 }] as Partial<GeneratorSettings>[]) {
      const { s, list } = drawn(changes, 30);
      for (const shape of list) expect(Math.abs(measureShape(shape).length - s.length)).toBeLessThan(s.length * 0.01);
    }
  });

  it('follows the mix to the end: nothing but slow corners, nothing but fast ones', () => {
    const slow = drawn({ slow: 3, medium: 0, fast: 0, ...plain }).list.map((shape) => measureShape(shape));
    const fast = drawn({ slow: 0, medium: 0, fast: 3, speed: 0.9, foldBack: 0, ...plain }).list.map((shape) => measureShape(shape));
    expect(mean(slow.map((m) => m.slow / m.corners))).toBeGreaterThan(0.9);
    expect(mean(fast.map((m) => m.fast / m.corners))).toBeGreaterThan(0.75);
  });
});

describe('room to run off', () => {
  /** A rectangle with a notch cut into its far side, reaching to `depth` metres from the near straight. */
  const notched = (depth: number): Shape => ({
    v: [[0, 0], [1000, 0], [1000, 400], [600, 400], [600, depth], [400, depth], [400, 400], [0, 400]].map(([x, y]) => ({ x, y, r: 25, feature: 'loop' as const, fixed: true })),
    start: 0, main: 0, made: { hairpin: false, chicane: false, esses: false, sweeper: false },
  });

  it('finds no fault with a lap whose corners look out over open ground', () => {
    expect(shortRunoff(notched(250), 12, vehicle('gt3'))).toBe(0);
  });

  it('counts the corner that looks straight at another part of the lap', () => {
    expect(shortRunoff(notched(40), 12, vehicle('gt3'))).toBeGreaterThanOrEqual(1);
  });

  it('asks more room of a faster class', () => {
    // 150 m from the straight ahead: enough for a touring car, not for a Formula 1 car at the end of a 250 m run.
    expect(shortRunoff(notched(65), 12, vehicle('f1'))).toBeGreaterThanOrEqual(shortRunoff(notched(65), 12, vehicle('tcr')));
  });
});

describe('the place', () => {
  const s = settings({ seed: 'site', length: 4200, longestStraight: 800 });
  const shape = shapes(s, 20)[0];
  const woods = woodsAt(hm, terrainSettings.seed);

  it('is on the map, with room to the edge', () => {
    const site = findSite(shape, hm, s, woods)!;
    expect(site).not.toBeNull();
    expect(site.x).toBeGreaterThan(130);
    expect(site.x).toBeLessThan(hm.extent - 130);
    expect(site.y).toBeGreaterThan(130);
    expect(site.y).toBeLessThan(hm.extent - 130);
  });

  it('is dry when water is to be kept clear of', () => {
    const site = findSite(shape, hm, s, woods)!;
    expect(site.wet).toBe(0);
  });

  it('has more height when more is asked', () => {
    const low = findSite(shape, hm, { ...s, heightDifference: 5 }, woods)!;
    const high = findSite(shape, hm, { ...s, heightDifference: 60 }, woods)!;
    expect(low.range).toBeLessThan(15);
    expect(high.range).toBeGreaterThan(low.range + 15);
  });

  it('is nowhere when the lap is bigger than the map', () => {
    const small = generateHeightmap({ ...defaultTerrainSettings('alpha', 'flat'), mapSize: 2048, resolution: 128 });
    const big = shapes(settings({ seed: 'big', length: 9000, longestStraight: 2000, compact: 0 }), 200)[0];
    expect(big).toBeDefined();
    expect(findSite(big, small, settings({ length: 9000 }), woodsAt(small, 'alpha'))).toBeNull();
  });
});

describe('the tracks it offers', async () => {
  const asked = settings({ seed: 'offer', candidates: 4 });
  const result = await generateTracks(asked, ctx);

  it('offers as many as asked, the nearest to what was asked first', () => {
    expect(result.tracks.length).toBe(4);
    for (let i = 1; i < result.tracks.length; i++) expect(result.tracks[i].score).toBeGreaterThanOrEqual(result.tracks[i - 1].score);
  });

  it('gives tracks that build without an error, at the length asked', () => {
    for (const t of result.tracks) {
      const built = buildTrack(t.design, (x, y) => sampleHeight(hm, x, y))!;
      expect(built).not.toBeNull();
      expect(validateTrack(built, hm, t.design.grading).filter((i) => i.severity === 'error')).toEqual([]);
      expect(Math.abs(t.figures.length - asked.length)).toBeLessThan(asked.length * 0.02);
      expect(t.design.defaultWidth).toBe(asked.width);
    }
  });

  it('says what each turned out as', () => {
    for (const t of result.tracks) {
      const f = t.figures;
      expect(f.corners).toBeGreaterThanOrEqual(5);
      expect(f.left + f.right).toBe(f.corners);
      expect(f.direction).toBe('clockwise');
      expect(f.longestStraight).toBeGreaterThan(300);
      expect(f.lapTime).toBeGreaterThan(60);
      expect(f.lapTime).toBeLessThan(200);
      expect(f.topSpeed * 3.6).toBeGreaterThan(200);
      expect(f.licence).toBeNull();
      expect(t.outline.length).toBeGreaterThan(100);
    }
  });

  it('keeps them dry and on the map', () => {
    for (const t of result.tracks) {
      for (let i = 0; i < t.outline.length; i += 2) {
        const x = t.outline[i], y = t.outline[i + 1];
        expect(x > 100 && y > 100 && x < hm.extent - 100 && y < hm.extent - 100).toBe(true);
        expect(sampleHeight(hm, x, y)).toBeGreaterThan(hm.waterLevel);
      }
    }
  });

  it('puts the start line on the track', () => {
    for (const t of result.tracks) {
      let nearest = Infinity;
      for (let i = 0; i < t.outline.length; i += 2) nearest = Math.min(nearest, Math.hypot(t.outline[i] - t.startFinish.x, t.outline[i + 1] - t.startFinish.y));
      expect(nearest).toBeLessThan(20);
    }
  });

  it('gives the same tracks for the same seed, and others for another', async () => {
    const again = await generateTracks(asked, ctx);
    expect(again.tracks.map((t) => t.design.points)).toEqual(result.tracks.map((t) => t.design.points));
    const other = await generateTracks({ ...asked, seed: 'another' }, ctx);
    expect(other.tracks[0].design.points).not.toEqual(result.tracks[0].design.points);
  });

  it('reports how far it is, and lets the page draw in between', async () => {
    const seen: string[] = [];
    let pauses = 0;
    await generateTracks({ ...asked, candidates: 2 }, ctx, { progress: (done, of, doing) => { seen.push(doing); expect(done).toBeLessThanOrEqual(of); }, pause: async () => { pauses++; } });
    expect(seen[0]).toBe('Drawing laps');
    expect(seen[seen.length - 1]).toBe('Done');
    expect(pauses).toBeGreaterThanOrEqual(3);
  });

  it('says so when the map has not the height asked for', async () => {
    const steep = await generateTracks({ ...asked, candidates: 2, heightDifference: 300 }, ctx);
    expect(steep.tracks.length).toBeGreaterThan(0);
    expect(steep.tracks[0].notes.some((n) => n.includes('no more height'))).toBe(true);
  });

  it('says so when no lap fits the map', async () => {
    const small = generateHeightmap({ ...defaultTerrainSettings('alpha', 'flat'), mapSize: 2048, resolution: 128 });
    const none = await generateTracks(settings({ length: 9000, longestStraight: 2000, compact: 0, candidates: 2 }), { heightmap: small, terrainSeed: 'alpha', vehicles: VEHICLES });
    expect(none.tracks).toEqual([]);
    expect(none.notes.length).toBeGreaterThan(0);
  });
});

describe('built to a licence', async () => {
  const gp = await generateTracks({ ...DEFAULT_GENERATOR, ...style('grand-prix').settings, seed: 'licence', candidates: 4 }, ctx);
  const bikes = await generateTracks({ ...DEFAULT_GENERATOR, ...style('bikes').settings, seed: 'licence', candidates: 4 }, ctx);

  it('gives a Grand Prix circuit that passes the check for Formula 1', () => {
    expect(gp.tracks.length).toBe(4);
    expect(gp.tracks.filter((t) => t.figures.licence?.passes).length).toBeGreaterThanOrEqual(3);
    expect(gp.tracks[0].figures.licence).toMatchObject({ needs: 'FIA 1', passes: true, failures: [] });
  });

  it('gives a motorcycle circuit that passes the check for MotoGP', () => {
    expect(bikes.tracks.filter((t) => t.figures.licence?.passes).length).toBeGreaterThanOrEqual(3);
    expect(bikes.tracks[0].figures.licence).toMatchObject({ needs: 'FIM A', passes: true });
    for (const t of bikes.tracks) expect(t.figures.longestStraight).toBeLessThan(1100);
  });

  it('is wider where the grid stands, and changes width gently', () => {
    for (const [result, grid] of [[gp, 15], [bikes, 14]] as const) {
      for (const t of result.tracks) {
        const widths = t.design.points.map((p) => p.width);
        expect(Math.max(...widths)).toBe(grid);
        expect(Math.min(...widths)).toBe(t.design.defaultWidth);
        const p = t.design.points;
        for (let i = 0; i < p.length; i++) {
          const q = p[(i + 1) % p.length];
          const d = Math.hypot(q.x - p[i].x, q.y - p[i].y);
          // No faster than 1 m in 20 m, as the FIA recommends.
          expect(Math.abs(q.width - p[i].width)).toBeLessThanOrEqual(d / 20 + 0.11);
        }
      }
    }
  });

  it('puts the passing ones first', () => {
    for (const result of [gp, bikes]) {
      const order = result.tracks.map((t) => (t.figures.licence?.passes ? 1 : 0));
      expect(order).toEqual([...order].sort((a, b) => b - a));
    }
  });
});

describe('tracks at the ends of the sliders', () => {
  const built = async (changes: Partial<GeneratorSettings>, context = ctx) => {
    const result = await generateTracks(settings({ seed: 'built', candidates: 3, ...changes }), context);
    for (const t of result.tracks) {
      const raw = buildTrack(t.design, (x, y) => sampleHeight(context.heightmap, x, y))!;
      expect(raw).not.toBeNull();
      expect(validateTrack(raw, context.heightmap, t.design.grading).filter((i) => i.severity === 'error')).toEqual([]);
    }
    return result;
  };

  it('builds a lap folded right back without one part on another', async () => {
    const result = await built({ foldBack: 1, compact: 1 });
    expect(result.tracks.length).toBe(3);
    for (const t of result.tracks) expect(Math.abs(t.figures.length - 5000)).toBeLessThan(100);
  });

  it('builds a track 30 m wide and one 6 m wide', async () => {
    for (const width of [30, 6]) {
      const result = await built({ width, foldBack: 1 });
      expect(result.tracks.length, `${width} m`).toBe(3);
      for (const t of result.tracks) expect(t.design.defaultWidth).toBe(width);
    }
  });

  it('builds a kilometre and twenty', async () => {
    const short = await built({ length: 1000, longestStraight: 300, startStraight: 250 });
    expect(short.tracks.length).toBe(3);
    for (const t of short.tracks) expect(Math.abs(t.figures.length - 1000)).toBeLessThan(25);
    const big = generateHeightmap({ ...defaultTerrainSettings('alpha', 'rolling'), mapSize: 16384, resolution: 512 });
    const long = await built({ length: 20000 }, { heightmap: big, terrainSeed: 'alpha', vehicles: VEHICLES });
    expect(long.tracks.length).toBe(3);
    for (const t of long.tracks) expect(Math.abs(t.figures.length - 20000)).toBeLessThan(400);
  });

  it('has far more corners at one end of corners or speed than at the other', async () => {
    const twisty = await built({ speed: 0, longestStraight: 400, startStraight: 300 });
    const fast = await built({ speed: 1, foldBack: 0, compact: 0, hairpin: false, esses: false, sweeper: false });
    expect(mean(twisty.tracks.map((t) => t.figures.corners))).toBeGreaterThan(26);
    expect(mean(fast.tracks.map((t) => t.figures.corners))).toBeLessThan(10);
  });

  it('gives a two kilometre straight on a five kilometre lap', async () => {
    const result = await built({ longestStraight: 2000, startStraight: 1500 });
    expect(result.tracks.length).toBe(3);
    for (const t of result.tracks) expect(t.figures.longestStraight).toBeGreaterThan(1750);
  });

  it('builds what is asked whatever the licence, and says the licence is not met', async () => {
    const result = await generateTracks({ ...DEFAULT_GENERATOR, vehicleId: 'f1', licence: true, width: 8, seed: 'built', candidates: 2 }, ctx);
    expect(result.notes.some((n) => n.includes('8 m wide'))).toBe(true);
    expect(result.tracks.length).toBe(2);
    for (const t of result.tracks) {
      expect(t.design.defaultWidth).toBe(8);
      expect(t.figures.licence?.passes).toBe(false);
    }
  });
});

describe('every style', () => {
  it.each(GENERATOR_STYLES.map((s) => [s.name, s] as const))('%s gives tracks on a rolling map', async (_name, s) => {
    const result = await generateTracks({ ...DEFAULT_GENERATOR, ...s.settings, seed: 'styles', candidates: 2 }, ctx);
    expect(result.tracks.length).toBe(2);
    for (const t of result.tracks) {
      expect(Math.abs(t.figures.length - s.settings.length!)).toBeLessThan(s.settings.length! * 0.02);
      expect(Number.isFinite(t.figures.lapTime)).toBe(true);
    }
  });
});
