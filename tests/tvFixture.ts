// A circuit as the app has it once it is analysed, with all that stands round it: for the television tests.
import { type TrackMetrics, analyseTrack } from '../src/core/analysis.ts';
import { Earthworks, type Road, pitRoad, trackRoad } from '../src/core/earthworks.ts';
import { type Facilities, placeFacilities } from '../src/core/facilities.ts';
import { type Heightmap, sampleHeight } from '../src/core/heightmap.ts';
import { type Licence, assessLicence } from '../src/core/licence.ts';
import { type Performance, analysePerformance } from '../src/core/performance.ts';
import { buildRaceModel } from '../src/core/race/model.ts';
import { raceRules } from '../src/core/race/rules.ts';
import { MAX_CARS, createRaceSetup, defaultRaceSettings } from '../src/core/race/setup.ts';
import { RaceSim } from '../src/core/race/sim.ts';
import type { Display } from '../src/core/shots.ts';
import { Solids } from '../src/core/solids.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { type Track, type TrackDesign, buildTrack } from '../src/core/track.ts';
import { validateTrack } from '../src/core/validate.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { type Venue, placeVenue, venueSolids } from '../src/core/venue.ts';

export interface Circuit {
  hm: Heightmap;
  track: Track;
  metrics: TrackMetrics;
  performance: Performance;
  facilities: Facilities;
  licence: Licence;
  earth: Earthworks;
  venue: Venue;
  /** Heights as the 3D view draws them, the relief three times as tall. */
  display: Display;
  solids: Solids;
}

/** The relief the 3D view draws by default. */
export const RELIEF = 3;

/** Builds a design on a landscape and analyses it for one class, as the app does, and places what stands round it. */
export function circuit(design: TrackDesign, hm: Heightmap, vehicleId = 'f1', startFinish?: { x: number; y: number } | null, relief = RELIEF): Circuit {
  const height = (x: number, y: number) => sampleHeight(hm, x, y);
  const raw = buildTrack(design, height);
  if (!raw) throw new Error('The design does not build.');
  const issues = validateTrack(raw, hm, design.grading);
  const sf = placeStartFinish(raw, startFinish);
  const track = rotateTrack(raw, sf.station);
  const metrics = analyseTrack(track);
  const classes = VEHICLES.filter((v) => v.id === vehicleId);
  const performance = analysePerformance(track, classes);
  const facilities = placeFacilities({ track, startFinish: sf, performance, vehicles: classes, heightAt: height, waterLevel: hm.waterLevel, extent: hm.extent, overrides: {} });
  const licence = assessLicence({ track, metrics, issues, performance, facilities, heightmap: hm, vehicles: classes });
  const roads: Road[] = [trackRoad(track)];
  const pit = facilities.pitLane ? pitRoad(facilities.pitLane, track) : null;
  if (pit) roads.push(pit);
  const earth = new Earthworks(hm, roads);
  const venue = placeVenue({ hm, track, metrics, facilities, runoff: licence.runoff, earth, pitRoad: pit });
  const display: Display = (z) => hm.min + (z - hm.min) * relief;
  const solids = new Solids((x, y) => earth.height(x, y), display, venueSolids(venue));
  return { hm, track, metrics, performance, facilities, licence, earth, venue, display, solids };
}

/** A race of one class on a circuit, set up and not run. */
export function raceOn(c: Circuit, vehicleId = 'f1', cars = 20, seed = '11'): RaceSim {
  const vehicle = VEHICLES.find((v) => v.id === vehicleId)!;
  const model = buildRaceModel({ track: c.track, performance: c.performance, facilities: c.facilities, vehicle, rules: raceRules(vehicle), gridSize: MAX_CARS, corners: c.metrics.corners });
  const settings = { ...defaultRaceSettings(vehicle, model.rules, model.line.length, model.lapTime, seed), classes: [{ vehicleId, cars }] };
  return new RaceSim(createRaceSetup(model, settings));
}
