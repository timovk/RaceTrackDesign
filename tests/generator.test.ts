import { describe, expect, it } from 'vitest';
import {
  CORNER_RADII, DEFAULT_GENERATOR, GENERATOR_STYLES, type GeneratorSettings, type Shape,
  classNeeds, cornersWanted, drawShape, findSite, generateTracks, measureShape, resolveSettings, scoreShape, shortRunoff, tracePath,
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
    const { settings: s, needs, notes } = resolveSettings(settings({ length: 90000, width: 2, speed: 3, compact: -1, brakingPoints: 40, slow: 0, medium: 0, fast: 0, longestStraight: 9000, startStraight: 9000, candidates: 99 }), vehicle('gt3'));
    expect(s.length).toBeLessThanOrEqual(14000);
    expect(s.width).toBe(6);
    expect(s.speed).toBe(1);
    expect(s.compact).toBe(0);
    expect(s.brakingPoints).toBe(8);
    expect(s.slow + s.medium + s.fast).toBeGreaterThan(0);
    expect(s.longestStraight).toBeLessThanOrEqual(s.length * 0.4);
    expect(s.startStraight).toBeLessThanOrEqual(s.longestStraight);
    expect(s.candidates).toBe(12);
    expect(needs).toBeNull();
    expect(notes).toEqual([]);
  });

  it('raises a track built to a licence to what the licence needs, and says so', () => {
    const { settings: s, needs, notes } = resolveSettings(settings({ licence: true, vehicleId: 'f1', length: 2500, width: 9, startStraight: 300, longestStraight: 400 }), vehicle('f1'));
    expect(needs).not.toBeNull();
    expect(s.length).toBe(3500);
    expect(s.width).toBe(12);
    expect(s.startStraight).toBeGreaterThanOrEqual(GRID_LENGTH + 250);
    expect(s.longestStraight).toBeGreaterThanOrEqual(s.startStraight);
    expect(notes.length).toBe(3);
    expect(notes.every((n) => n.includes('Formula 1'))).toBe(true);
  });

  it('holds a motorcycle circuit to the straight the FIM allows', () => {
    const { settings: s, notes } = resolveSettings(settings({ licence: true, vehicleId: 'motogp', length: 6000, longestStraight: 1800 }), vehicle('motogp'));
    expect(s.longestStraight).toBe(1000);
    expect(notes.some((n) => n.includes('1000 m'))).toBe(true);
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

  it('scores the laps nearest to what was asked best', () => {
    const scored = drawn.map((shape) => ({ shape, m: measureShape(shape), score: scoreShape(measureShape(shape), shape, s) })).sort((a, b) => a.score - b.score);
    const best = scored.slice(0, 8);
    const worst = scored.slice(-8);
    // The start straight: some laps come out with a short one; those do not come first.
    for (const b of best) expect(b.m.startStraight).toBeGreaterThan(s.startStraight * 0.7);
    const off = (list: typeof scored) => mean(list.map((x) => Math.abs(x.m.corners - cornersWanted(s)) / cornersWanted(s) + Math.abs(x.m.longestStraight - s.longestStraight) / s.longestStraight));
    expect(off(best)).toBeLessThan(off(worst));
    // A feature asked for and not made costs.
    const without = scored.filter((x) => !x.shape.made.sweeper);
    const withIt = scored.filter((x) => x.shape.made.sweeper);
    expect(withIt.length).toBeGreaterThan(0);
    if (without.length) expect(mean(withIt.map((x) => x.score))).toBeLessThan(mean(without.map((x) => x.score)));
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
