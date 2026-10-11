import { describe, expect, it } from 'vitest';
import { type Character, REAL_CIRCUITS, spreadOf, trackCharacter } from '../src/core/character.ts';
import { DEFAULT_GENERATOR, GENERATOR_STYLES, generateTracks } from '../src/core/generator.ts';
import { sampleHeight } from '../src/core/heightmap.ts';
import { cornersWanted, foldedWanted, hullWanted, mixWanted, spreadWanted } from '../src/core/lapComposer.ts';
import { defaultTerrainSettings, generateHeightmap } from '../src/core/terrain.ts';
import { buildTrack } from '../src/core/track.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { circuitNames, loadCircuitDesign } from '../scripts/circuitData.ts';

const keys = Object.keys(REAL_CIRCUITS) as (keyof Character)[];
/** Degrees are kept whole, the rest to two places. */
const whole = (k: keyof Character) => k === 'turningPerKm' || k === 'cornerAngle';

const real = circuitNames().map((name) => trackCharacter(buildTrack(loadCircuitDesign(name), () => 0)!));

describe('what a circuit is like', () => {
  it('measures a real circuit as it is known', () => {
    const of = (name: string) => trackCharacter(buildTrack(loadCircuitDesign(name), () => 0)!);
    const monza = of('Monza'), budapest = of('Budapest'), suzuka = of('Suzuka');
    // Monza: few corners and long straights. The Hungaroring: corner after corner. Suzuka crosses itself, and encloses next to nothing.
    expect(monza.cornersPerKm).toBeLessThan(2.5);
    expect(budapest.cornersPerKm).toBeGreaterThan(3.3);
    expect(monza.turningPerKm).toBeLessThan(200);
    expect(budapest.turningPerKm).toBeGreaterThan(330);
    expect(monza.longestStraight).toBeGreaterThan(0.15);
    expect(suzuka.hull).toBeLessThan(0.3);
    for (const c of [monza, budapest, suzuka]) {
      expect(c.slow + c.medium + c.fast).toBeCloseTo(1, 6);
      expect(c.spread).toBeGreaterThan(0.2);
      expect(c.spread).toBeLessThan(0.5);
      // (A corner's tightest point is tighter than the middle of it.)
      expect(c.tightening).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the figures of the real circuits as they measure', () => {
    expect(real.length).toBe(25);
    for (const k of keys) {
      const measured = spreadOf(real.map((c) => c[k]));
      for (let i = 0; i < 3; i++) expect(Math.abs(measured[i] - REAL_CIRCUITS[k][i]), `${k} ${i}`).toBeLessThan(whole(k) ? 1 : 0.0051);
    }
  });
});

describe('the generator, set from real circuits', () => {
  const style = (id: string) => GENERATOR_STYLES.find((s) => s.id === id)!.settings;
  const middle = { ...DEFAULT_GENERATOR, speed: 0.5, compact: 0.5, foldBack: 0.5, slow: 1, medium: 1, fast: 1 };

  it('asks in the middle of each slider for what real circuits have', () => {
    expect(spreadWanted(middle)).toBeCloseTo(REAL_CIRCUITS.spread[1], 6);
    expect(foldedWanted(middle)).toBeCloseTo(REAL_CIRCUITS.folded[1], 6);
    expect(hullWanted(middle)).toBeCloseTo(REAL_CIRCUITS.hull[1], 6);
    const mix = mixWanted(middle);
    expect(mix.slow).toBeCloseTo(REAL_CIRCUITS.slow[1], 6);
    expect(mix.medium).toBeCloseTo(REAL_CIRCUITS.medium[1], 6);
    expect(mix.fast).toBeCloseTo(REAL_CIRCUITS.fast[1], 6);
    // Corners: a twentieth over the real figure a kilometre, on a lap whose straights are a real circuit's share of it.
    const straights = { longestStraight: 5000 * REAL_CIRCUITS.longestStraight[1], startStraight: 5000 * REAL_CIRCUITS.secondStraight[1] };
    expect(cornersWanted({ ...middle, length: 5000, ...straights })).toBe(Math.round(5 * REAL_CIRCUITS.cornersPerKm[1] * 1.05));
  });

  it('goes from one end of what real circuits have to beyond the other', () => {
    for (const [wanted, key, low, high] of [
      [spreadWanted, 'spread', { compact: 1 }, { compact: 0 }], [foldedWanted, 'folded', { foldBack: 0 }, { foldBack: 1 }], [hullWanted, 'hull', { foldBack: 1 }, { foldBack: 0 }],
    ] as const) {
      expect(wanted({ ...middle, ...low }), key).toBeLessThanOrEqual(REAL_CIRCUITS[key][0] + 0.03);
      expect(wanted({ ...middle, ...high }), key).toBeGreaterThanOrEqual(REAL_CIRCUITS[key][2]);
    }
    const perKm = (speed: number) => cornersWanted({ ...middle, length: 5000, longestStraight: 700, startStraight: 450, speed }) / 5;
    expect(perKm(0)).toBeGreaterThan(REAL_CIRCUITS.cornersPerKm[2] * 1.5);
    expect(perKm(1)).toBeLessThan(REAL_CIRCUITS.cornersPerKm[0] * 0.75);
  });

  it('makes Grand Prix circuits that are like real ones', async () => {
    const hm = generateHeightmap({ ...defaultTerrainSettings('alpha', 'rolling'), resolution: 512 });
    const made: Character[] = [];
    for (const seed of ['like', 'real']) {
      const result = await generateTracks({ ...DEFAULT_GENERATOR, ...style('grand-prix'), seed }, { heightmap: hm, terrainSeed: 'alpha', vehicles: VEHICLES });
      expect(result.tracks.length).toBe(6);
      for (const t of result.tracks) made.push(trackCharacter(buildTrack(t.design, (x, y) => sampleHeight(hm, x, y))!));
    }
    // The middle one of them lies, by every measure, where four in five real circuits lie. (But for how a corner
    // tightens to its apex: a generated corner is still an arc of one radius.)
    for (const k of keys) {
      if (k === 'tightening') continue;
      const [, mid] = spreadOf(made.map((c) => c[k]));
      expect(mid, k).toBeGreaterThanOrEqual(REAL_CIRCUITS[k][0]);
      expect(mid, k).toBeLessThanOrEqual(REAL_CIRCUITS[k][2]);
    }
    // And they are not six of one kind: what they enclose of the outline round them differs as it does between real circuits.
    const [low, , high] = spreadOf(made.map((c) => c.hull));
    expect(high - low).toBeGreaterThan(0.1);
  }, 120000);
});
