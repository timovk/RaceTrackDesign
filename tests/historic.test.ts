import { describe, expect, it } from 'vitest';
import { analyseTrack } from '../src/core/analysis.ts';
import { buildCar } from '../src/core/carBodies.ts';
import { PART } from '../src/core/carMesh.ts';
import { sampleHeight } from '../src/core/heightmap.ts';
import { simulateLap } from '../src/core/lapSim.ts';
import { raceRules } from '../src/core/race/rules.ts';
import { computeRacingLine } from '../src/core/racingLine.ts';
import { bodyFor } from '../src/core/raceCars.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { findSurvey, loadSurvey } from '../src/core/survey.ts';
import { TEMPLATES, templateProject } from '../src/core/templates.ts';
import { buildTrack } from '../src/core/track.ts';
import { validateTrack } from '../src/core/validate.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { readPublic } from './helpers.ts';
import { car, race } from './raceFixture.ts';

/** A template's lap on its own ground, from its start line. */
async function lapOf(id: string) {
  const p = templateProject(TEMPLATES.find((t) => t.id === id)!);
  const hm = await loadSurvey(findSurvey(p.terrain.survey)!, readPublic);
  const raw = buildTrack(p.track, (x, y) => sampleHeight(hm, x, y))!;
  const startFinish = placeStartFinish(raw, p.overrides.startFinish);
  return { p, hm, raw, startFinish, t: rotateTrack(raw, startFinish.station) };
}

const gp = car('f1-1950');

describe('Monaco 1950', async () => {
  const { p, hm, raw, startFinish, t } = await lapOf('monaco');
  const radius = (k: number) => (Math.abs(t.curvature[k]) > 1e-9 ? 1 / Math.abs(t.curvature[k]) : Infinity);

  it('is the lap of the record books: 3.18 km, clockwise, with no error in it', () => {
    expect(t.length).toBeGreaterThan(3180 * 0.995);
    expect(t.length).toBeLessThan(3180 * 1.005);
    expect(analyseTrack(t).direction).toBe('clockwise');
    expect(validateTrack(raw, hm, p.track.grading).filter((i) => i.severity === 'error')).toEqual([]);
    for (const w of t.width) expect(w).toBe(8);
  });

  it('lies on the harbour: the sea to the east, the water of the port beside the quay', () => {
    expect(hm.extent).toBe(2048);
    expect(hm.waterLevel).toBe(1);
    let water = 0;
    for (const z of hm.data) if (z < hm.waterLevel) water++;
    expect(water / hm.data.length).toBeGreaterThan(0.35);
    expect(water / hm.data.length).toBeLessThan(0.5);
    // The middle of the port and the open sea are water; the hill behind the town is not.
    expect(sampleHeight(hm, 900, 1250)).toBeLessThan(hm.waterLevel);
    expect(sampleHeight(hm, 1900, 1000)).toBeLessThan(hm.waterLevel);
    expect(sampleHeight(hm, 200, 300)).toBeGreaterThan(100);
    // The road itself is never in the water, and close above it along the quays.
    for (let k = 0; k < t.n; k++) expect(t.z[k]).toBeGreaterThan(hm.waterLevel + 1);
  });

  it('climbs from the harbour to the Casino, 40 m up, and comes down again to the sea front', () => {
    let top = 0;
    for (let k = 1; k < t.n; k++) if (t.z[k] > t.z[top]) top = k;
    expect(t.z[top]).toBeGreaterThan(40);
    expect(t.z[top]).toBeLessThan(45);
    // The top is at the Casino, a third of the way round, in the north-east of the map.
    expect(top * t.ds).toBeGreaterThan(700);
    expect(top * t.ds).toBeLessThan(1300);
    expect(t.x[top]).toBeGreaterThan(1100);
    expect(t.y[top]).toBeLessThan(800);
    expect(Math.min(...t.z)).toBeLessThan(4);
    // Steep as the hill up from Sainte-Devote is, no more.
    for (let k = 0; k < t.n; k++) expect(Math.abs(t.gradient[k])).toBeLessThan(0.13);
    // The road is its own ledge: it lies within 3 m of the ground everywhere (the tunnel is opened up).
    for (let k = 0; k < t.n; k++) expect(Math.abs(t.z[k] - t.terrain[k])).toBeLessThan(3);
  });

  it('has its two hairpins: the Station hairpin to the left, and the Gasworks hairpin to the right at the end of the quay', () => {
    const tight: number[] = [];
    for (let k = 0; k < t.n; k++) if (radius(k) < 12 && (tight.length === 0 || k - tight[tight.length - 1] > 50)) tight.push(k);
    expect(tight).toHaveLength(2);
    const [station, gasworks] = tight;
    // The Station hairpin: half-way round, in the north-east; the Gasworks hairpin: the last corner, in the south-west.
    expect(t.x[station]).toBeGreaterThan(1300);
    expect(t.y[station]).toBeLessThan(700);
    expect(t.x[gasworks]).toBeLessThan(800);
    expect(t.y[gasworks]).toBeGreaterThan(1450);
    expect(gasworks * t.ds).toBeGreaterThan(2800);
    // (Curvature is positive turning right, as a clockwise lap mostly does.)
    const right = Math.sign(t.curvature.reduce((a, c) => a + c, 0));
    expect(Math.sign(t.curvature[gasworks])).toBe(right);
    expect(Math.sign(t.curvature[station])).toBe(-right);
  });

  it('runs down the quay beside the start straight, 18 m from it', () => {
    expect(startFinish.overridden).toBe(true);
    // The start line is on the boulevard, heading north; some 2.7 km on the lap comes back past it on the quay, heading south.
    expect(Math.sin(t.heading[0])).toBeLessThan(-0.9);
    let near = -1;
    let best = Infinity;
    for (let k = Math.round(2400 / t.ds); k < t.n - Math.round(200 / t.ds); k++) {
      const d = Math.hypot(t.x[k] - t.x[0], t.y[k] - t.y[0]);
      if (d < best) {
        best = d;
        near = k;
      }
    }
    expect(best).toBeGreaterThan(16);
    expect(best).toBeLessThan(20);
    expect(t.x[near]).toBeGreaterThan(t.x[0]);
    expect(Math.sin(t.heading[near])).toBeGreaterThan(0.9);
  });
});

describe('the Formula 1 car of 1950', () => {
  it('laps Monaco and Bremgarten as the pole sitters of 1950 did', async () => {
    // Fangio's pole laps in the Alfa Romeo 158: 1:50.2 at Monaco, 2:42.1 at Bremgarten.
    for (const [id, pole] of [['monaco', 110.2], ['bremgarten', 162.1]] as const) {
      const { t } = await lapOf(id);
      const lap = simulateLap(t, computeRacingLine(t), gp);
      expect(Math.abs(lap.time / pole - 1), id).toBeLessThan(0.03);
      let fastest = 0;
      for (const v of lap.v) fastest = Math.max(fastest, v);
      expect(fastest * 3.6, id).toBeLessThan(291);
    }
  }, 120_000);

  it('is far slower than the car of today, and has no wings to open', async () => {
    const { t } = await lapOf('monaco');
    const line = computeRacingLine(t);
    const today = simulateLap(t, line, car('f1')).time;
    expect(simulateLap(t, line, gp).time).toBeGreaterThan(today * 1.6);
    expect(gp.drs).toBe(0);
    expect(gp.clA).toEqual([0, 0]);
    expect(gp.gears).toBe(4);
    // 350 bhp for 850 kg with its driver and fuel.
    expect(gp.power / gp.mass).toBeCloseTo(240_000 / 850, 0);
    expect(VEHICLES.filter((v) => v.id.startsWith('f1')).map((v) => v.id)).toEqual(['f1', 'f1-1950']);
  }, 120_000);

  it('races to the rules of its day: 300 km from a standing start, fuel taken on, no safety car, no time penalties', () => {
    const rules = raceRules(gp);
    expect(rules.flags.safetyCar).toBe(false);
    expect(rules.flags.virtual).toBeNull();
    expect(rules.stewards.collision).toEqual({ kind: 'warning' });
    expect(rules.stewards.lesser).toEqual({ kind: 'warning' });
    const sim = race(gp, { cars: 12, seed: '7' });
    // Some 300 km in under three hours and a half.
    const lap = sim.model.line.length;
    expect(sim.setup.laps! * lap).toBeGreaterThan(295_000);
    expect(sim.setup.laps! * lap).toBeLessThan(305_000 + lap);
    expect(sim.t).toBeLessThan(200 * 60);
    // The tank does not last: the cars that got that far stopped for fuel, and stood for most of a minute.
    const fuel = sim.stops.filter((s) => s.reason === 'fuel');
    expect(fuel.length).toBeGreaterThanOrEqual(sim.cars.filter((c) => c.status === 'finished').length);
    // (A full tank takes the best part of a minute; a splash near the end less.)
    expect(Math.max(...fuel.map((s) => s.fuel))).toBeGreaterThan(100);
    expect(Math.max(...fuel.map((s) => s.stationary))).toBeGreaterThan(30);
    for (const s of fuel) expect(s.stationary).toBeGreaterThan(s.fuel / 4 - 0.01);
    // Cars break: not all of them see the flag, but some do.
    const finished = sim.cars.filter((c) => c.status === 'finished').length;
    expect(finished).toBeGreaterThanOrEqual(3);
    expect(finished).toBeLessThan(12);
    expect(sim.safetyCar).toBeNull();
    expect(sim.events.some((e) => /safety car/i.test(e.text))).toBe(false);
    for (const c of sim.cases) expect(c.penalty === null || c.penalty.kind === 'warning').toBe(true);
    for (const c of sim.cars) expect(c.addedTime).toBe(0);
  }, 120_000);

  it('is drawn as it was: the engine in front, the driver in the open ahead of the rear axle, on wire wheels', () => {
    expect(bodyFor(gp)).toBe('f1-1950');
    const model = buildCar('f1-1950');
    // The Alfa Romeo 158's measure.
    expect(model.length).toBeCloseTo(4.28, 1);
    expect(model.wheelbase).toBeCloseTo(2.5, 1);
    expect(model.roundels).toBe(true);
    expect(model.lamps).toHaveLength(0);
    // The driver sits behind the middle of the car, his head the highest thing on it.
    expect(model.eye[0]).toBeLessThan(-0.3);
    expect(model.eye[0]).toBeGreaterThan(-model.wheelbase / 2);
    const body = model.lods[1].body;
    let high = 0;
    for (let i = 1; i < body.positions.length / 3; i++) if (body.positions[i * 3 + 1] > body.positions[high * 3 + 1]) high = i;
    expect(Math.abs(body.positions[high * 3] - model.eye[0])).toBeLessThan(0.3);
    // Bigger wheels behind than in front, narrow, standing out in the open: wider apart than the body is wide.
    const [front, , rear] = model.wheels;
    expect(rear.radius).toBeGreaterThan(front.radius);
    expect(rear.width).toBeLessThan(0.2);
    let widest = 0;
    for (let i = 0; i < body.positions.length / 3; i++) if (body.positions[i * 3 + 1] > 0.7) widest = Math.max(widest, Math.abs(body.positions[i * 3 + 2]));
    expect(front.z - front.width / 2).toBeGreaterThan(widest + 0.1);
    // The tail runs to a point: nothing wider than a hand at the very back.
    let tail = Infinity;
    for (let i = 0; i < body.positions.length; i += 3) tail = Math.min(tail, body.positions[i]);
    for (let i = 0; i < body.positions.length / 3; i++) if (body.positions[i * 3] < tail + 0.02) expect(Math.abs(body.positions[i * 3 + 2])).toBeLessThan(0.06);
    // No wing to lose, no flap to open; a wheel of wire spokes, and no coloured band on the tyre.
    for (const lod of model.lods) for (let i = 2; i < lod.body.hinge.length; i += 3) expect(lod.body.hinge[i]).toBe(PART.none);
    const wheel = model.lods[1].wheel;
    expect(wheel.indices.length / 3).toBeGreaterThan(buildCar('f1').lods[1].wheel.indices.length / 3);
    for (const z of wheel.zone) expect(z).toBe(-1);
    // Its number on the nose, each side of the scuttle and each side of the tail.
    expect(model.lods[1].decals.indices.length).toBeGreaterThan(0);
    let left = 0;
    let right = 0;
    const d = model.lods[1].decals.positions;
    for (let i = 2; i < d.length; i += 3) {
      if (d[i] > 0.1) right++;
      if (d[i] < -0.1) left++;
    }
    expect(left).toBe(right);
    expect(left).toBeGreaterThan(0);
  });
});
