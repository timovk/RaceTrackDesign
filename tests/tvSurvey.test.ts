import { describe, expect, it } from 'vitest';
import { Director, type TvCamera, tvCameras } from '../src/core/broadcast.ts';
import { DEFAULT_GENERATOR, GENERATOR_STYLES, generateTracks } from '../src/core/generator.ts';
import { seededRandom } from '../src/core/rng.ts';
import { GRID_LENGTH } from '../src/core/startFinish.ts';
import { type TerrainPreset, defaultTerrainSettings, generateHeightmap } from '../src/core/terrain.ts';
import { buildCameraMounts } from '../src/core/trackside.ts';
import { surveyCameras, surveyRace } from '../src/core/tvSurvey.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { barrierOffsets } from '../src/core/venue.ts';
import { type Circuit, circuit, raceOn } from './tvFixture.ts';

const style = (id: string) => GENERATOR_STYLES.find((s) => s.id === id)!.settings;

/** A generated circuit of a kind on a landscape, analysed for a class, with what stands round it. */
async function made(kind: string, preset: TerrainPreset, vehicle: string): Promise<Circuit> {
  const hm = generateHeightmap({ ...defaultTerrainSettings('alpha', preset), resolution: 512 });
  const r = await generateTracks({ ...DEFAULT_GENERATOR, ...style(kind), seed: 'tv', candidates: 1 }, { heightmap: hm, terrainSeed: 'alpha', vehicles: VEHICLES });
  return circuit(r.tracks[0].design, hm, vehicle, r.tracks[0].startFinish);
}

function camerasOf(c: Circuit): TvCamera[] {
  return tvCameras({
    track: c.track, metrics: c.metrics, pit: c.facilities.pitLane, height: (x, y) => c.earth.height(x, y), display: c.display,
    venue: c.venue, solids: c.solids, facilities: c.facilities, extent: c.hm.extent, wet: (x, y) => c.earth.natural(x, y) < c.hm.waterLevel + 0.3,
  });
}

/** Share of the lap from which some camera goes on seeing a car for `metres`. */
function held(cams: readonly TvCamera[], n: number, ds: number, metres: number): number {
  const ahead = new Float32Array(n);
  for (const cam of cams) {
    let run = 0;
    for (let i = 2 * n - 1; i >= 0; i--) {
      const k = i % n;
      run = cam.sees[k] ? run + ds : 0;
      if (i < n && run > ahead[k]) ahead[k] = run;
    }
  }
  return ahead.reduce((a, x) => a + (x >= metres ? 1 : 0), 0) / n;
}

describe('the cameras of a Grand Prix circuit', async () => {
  const c = await made('grand-prix', 'rolling', 'f1');
  const t = c.track;
  const cams = camerasOf(c);
  const reports = surveyCameras(cams, t, c.display, c.solids, c.venue.insideBarriers);
  const byId = new Map(cams.map((cam) => [cam.id, cam]));

  it('has the buildings that used to be in the way', () => {
    expect(c.venue.building).not.toBeNull();
    expect(c.venue.stands.length).toBeGreaterThan(0);
    expect(c.solids.count).toBeGreaterThan(50);
  });

  it('are about as many as a broadcaster brings', () => {
    // 18 and 1.25 a kilometre (Monaco, Aragon, Le Mans), and up to two fifths more where a car would be lost between two.
    const wanted = 18 + (1.25 * t.length) / 1000;
    expect(cams.length).toBeGreaterThanOrEqual(Math.round(wanted * 0.7));
    expect(cams.length).toBeLessThanOrEqual(Math.round(wanted * 1.4) + 1);
    expect(new Set(cams.map((cam) => cam.id)).size).toBe(cams.length);
  });

  it('stand in nothing: no grandstand, no pit building, no hillside, and behind the barrier', () => {
    expect(reports.filter((r) => r.standsIn).map((r) => `${r.id}: ${r.standsIn}`)).toEqual([]);
    expect(reports.filter((r) => r.inFront).map((r) => r.id)).toEqual([]);
  });

  it('see what they are said to see', () => {
    const sees = reports.reduce((a, r) => a + r.sees, 0);
    const hidden = reports.reduce((a, r) => a + r.hidden, 0);
    // (A station between two that are seen is taken as seen: a post may stand in front of one.)
    expect(hidden / sees).toBeLessThan(0.015);
    for (const r of reports) {
      expect(r.sees * t.ds, r.id).toBeGreaterThan(100);
      expect(r.by['grandstand'] ?? 0, r.id).toBe(0);
      expect(r.by['pit building'] ?? 0, r.id).toBe(0);
    }
    const covered = new Uint8Array(t.n);
    for (const cam of cams) for (let k = 0; k < t.n; k++) covered[k] |= cam.sees[k];
    expect(covered.reduce((a, x) => a + x, 0) / t.n).toBeGreaterThan(0.97);
  });

  it('have a camera behind the grid, one for the first corner and one on the pit wall', () => {
    const start = byId.get('start')!;
    const far = (cam: TvCamera, k: number) => Math.hypot(t.x[k] - cam.at[0], t.y[k] - cam.at[1]);
    const last = t.n - Math.round(GRID_LENGTH / t.ds);
    expect(far(start, last)).toBeLessThan(far(start, 0));
    for (let k = last; k < t.n; k += 5) expect(start.sees[k], `grid ${k}`).toBe(1);
    const corner = byId.get('t1')!;
    const first = c.metrics.corners.find((x) => x.angle >= 45)!;
    expect(corner.station).toBe(first.start);
    let into = 0;
    for (let i = 0; i < 60; i++) into += corner.sees[(first.start - i + t.n) % t.n];
    expect(into).toBeGreaterThan(30);
    const pit = byId.get('pit')!;
    expect(pit.mount).toBe('post');
    // Between the lane and the road, a few metres over the lane.
    const lane = c.facilities.pitLane!;
    let nearest = Infinity;
    for (let i = lane.boxStart; i <= lane.boxEnd; i++) nearest = Math.min(nearest, Math.hypot(lane.x[i] - pit.at[0], lane.y[i] - pit.at[1]));
    expect(nearest).toBeLessThan(lane.width / 2 + 2);
    expect(pit.stand!.up).toBeGreaterThan(3);
  });

  it('stand on the roofs at their edge, and turn no further than keeps the roof out of the picture', () => {
    const roofs = cams.filter((cam) => cam.mount === 'roof');
    for (const cam of roofs) {
      expect(c.solids.standing(cam.at[0], cam.at[1], cam.at[2], 1.5, true), cam.id).toBeNull();
      expect(cam.at[2] - c.solids.groundAt(cam.at[0], cam.at[1])).toBeGreaterThan(8);
    }
    for (const cam of cams) {
      const st = cam.stand!;
      const limit = Math.cos(Math.min(Math.PI, cam.pan! + 0.02));
      for (let k = 0; k < t.n; k += 3) {
        if (!cam.sees[k]) continue;
        const dx = t.x[k] - cam.at[0];
        const dy = t.y[k] - cam.at[1];
        // (Stations between two that are seen count as seen: a degree or two over is the filling in.)
        expect((dx * Math.cos(st.facing) + dy * Math.sin(st.facing)) / Math.hypot(dx, dy), `${cam.id} at ${k}`).toBeGreaterThan(limit - 0.06);
      }
    }
  });

  it('look over a catch fence, never through it', () => {
    const { fence } = barrierOffsets(t, c.venue.barriers);
    for (const cam of cams) {
      if (cam.mount !== undefined && cam.mount !== 'tower') continue;
      if (cam.station === undefined || !cam.side || !cam.id.match(/^(corner-\\d+[abci]|straight|start[lr]?$)/)) continue;
      if (fence[cam.side > 0 ? 0 : 1][cam.station]) expect(cam.stand!.up, cam.id).toBeGreaterThanOrEqual(6);
    }
  });

  it('hand a car on from one to the next', () => {
    // Somewhere to cut to that keeps the car three seconds at 180 km/h, from nearly anywhere on the lap.
    expect(held(cams, t.n, t.ds, 150)).toBeGreaterThan(0.85);
  });

  it('are drawn: a tower, a platform or a post under each', () => {
    const mesh = buildCameraMounts(cams);
    expect(mesh.indices.length).toBeGreaterThan(cams.length * 36);
    expect(mesh.anchors).toBeDefined();
    // Nothing of a camera's own tower is in front of its lens.
    expect(cams.every((cam) => cam.stand)).toBe(true);
  });

  it('is found out when a camera stands in a grandstand or looks through the pit building', () => {
    const stand = c.venue.stands[0];
    const p = stand.front[Math.floor(stand.front.length / 2)];
    const inStand: TvCamera = { id: 'bad-1', label: 'In the stand', at: [p.x + p.ox * 7, p.y + p.oy * 7, c.display(stand.base) + 5], sees: new Uint8Array(t.n).fill(1) };
    const block = c.venue.building!.blocks[Math.floor(c.venue.building!.blocks.length / 2)];
    // In a garage, a little way in from its door.
    const gx = (block.x[0] + block.x[1]) / 2 + ((block.x[2] + block.x[3]) / 2 - (block.x[0] + block.x[1]) / 2) * 0.3;
    const gy = (block.y[0] + block.y[1]) / 2 + ((block.y[2] + block.y[3]) / 2 - (block.y[0] + block.y[1]) / 2) * 0.3;
    const inGarage: TvCamera = { id: 'bad-2', label: 'In a garage', at: [gx, gy, c.display(block.anchor) + 2], sees: new Uint8Array(t.n).fill(1) };
    const found = surveyCameras([inStand, inGarage], t, c.display, c.solids, c.venue.insideBarriers);
    expect(found[0].standsIn).toBe('grandstand');
    expect(found[1].standsIn).toBe('pit building');
    expect(found[1].by['pit building'] ?? 0).toBeGreaterThan(t.n * 0.5);
  });

  it('shows a race with the cars in the picture', () => {
    const sim = raceOn(c, 'f1', 20);
    const director = new Director(cams, { n: t.n, ds: t.ds }, seededRandom('survey'));
    const air = surveyRace(sim, director, t, c.display, c.solids, 240);
    expect(air.trackside).toBeGreaterThan(0.4 * air.total);
    expect(air.helicopter).toBeLessThan(0.3 * air.total);
    expect(air.fromFaulty).toBe(0);
    // (Cars that go behind something are cut away from within half a second: what is left is that half second.)
    expect(air.hidden / air.trackside).toBeLessThan(0.04);
    expect(air.by['grandstand'] ?? 0).toBeLessThan(2);
    expect(air.by['pit building'] ?? 0).toBeLessThan(2);
  });
}, 120000);

describe('the cameras of a mountain course', async () => {
  const c = await made('mountain', 'mountainous', 'gt3');
  const t = c.track;
  const cams = camerasOf(c);
  const reports = surveyCameras(cams, t, c.display, c.solids, c.venue.insideBarriers);

  it('climbs', () => {
    expect(c.metrics.elevationRange).toBeGreaterThan(25);
  });

  it('stand clear of the hillsides, with the relief drawn three times as tall', () => {
    expect(reports.filter((r) => r.standsIn).map((r) => `${r.id}: ${r.standsIn}`)).toEqual([]);
    for (const cam of cams) expect(cam.at[2] - c.solids.groundAt(cam.at[0], cam.at[1]), cam.id).toBeGreaterThan(1.5);
  });

  it('see no car through a hill', () => {
    const sees = reports.reduce((a, r) => a + r.sees, 0);
    const hidden = reports.reduce((a, r) => a + (r.by.ground ?? 0), 0);
    expect(hidden / sees).toBeLessThan(0.015);
    const sim = raceOn(c, 'gt3', 20);
    const director = new Director(cams, { n: t.n, ds: t.ds }, seededRandom('survey'));
    const air = surveyRace(sim, director, t, c.display, c.solids, 240);
    expect(air.hidden / air.trackside).toBeLessThan(0.05);
    expect(held(cams, t.n, t.ds, 150)).toBeGreaterThan(0.8);
  });
}, 120000);
