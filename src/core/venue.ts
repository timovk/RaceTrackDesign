/**
 * What stands round a track once it is analysed: the run-off, the pit
 * building, the grandstands, the barriers, the advertising boards, the
 * gantries and the marshal posts, each placed clear of what was placed
 * before it. The 3D view draws it, and the television cameras are placed
 * and checked against it (`venueSolids`), so both go by one account.
 */
import type { TrackMetrics } from './analysis.ts';
import { type BarrierRun, barrierRuns, insideBarriers } from './barriers.ts';
import { type Earthworks, type Road, Earthworks as Works, VERGE } from './earthworks.ts';
import type { Facilities } from './facilities.ts';
import type { Heightmap } from './heightmap.ts';
import type { Licence } from './licence.ts';
import {
  type Footprint, type PostSite, type RunoffArea, type Stand, TrackIndex,
  buildPitBuilding, inside, lineFlagSite, marshalPostSites, placeGrandstands, runoffAreas, runoffTest, standBlocks,
} from './scenery.ts';
import type { Solid } from './solids.ts';
import type { Track } from './track.ts';
import { type Board, type Gantry, gantryBeam, placeBoards, placeGantries } from './trackside.ts';

export interface VenueInput {
  hm: Heightmap;
  track: Track;
  metrics: TrackMetrics;
  facilities: Facilities;
  /** The run-off the licence asks at each corner, when the licence is known. */
  runoff: Licence['runoff'] | null;
  /** The ground as built for the track and its pit lane (and the other roads of the circuit). */
  earth: Earthworks;
  /** The pit lane as a road, when there is one. */
  pitRoad: Road | null;
  /** The rest of the circuit round a layout: run-off, barriers and posts stop at these roads. */
  otherRoads?: readonly Road[];
}

export interface Venue {
  index: TrackIndex;
  /** Whether a point lies on or right beside another road of the circuit. */
  blocked: ((x: number, y: number) => boolean) | undefined;
  areas: RunoffArea[];
  building: ReturnType<typeof buildPitBuilding> | null;
  stands: Stand[];
  barriers: BarrierRun[];
  boards: Board[];
  gantries: Gantry[];
  /** The marshal posts, and the flag marshal's rostrum at the line. */
  posts: PostSite[];
  lineSite: PostSite;
  /** The outlines of all that is built, for keeping the trees off. */
  footprints: Footprint[];
  onRunoff: ((x: number, y: number, margin: number) => boolean) | null;
  /** Whether a point is on the track's side of the barriers (within a margin of them). */
  insideBarriers: ((x: number, y: number, margin: number) => boolean) | null;
}

export function placeVenue(input: VenueInput): Venue {
  const { hm, track: t, metrics, facilities, earth } = input;
  const pitLane = facilities.pitLane;
  const index = new TrackIndex(t);
  // Run-off and barriers stop at the other roads: a gravel trap ends where the rest of the circuit carries on.
  const others = input.otherRoads?.length ? new Works(hm, [...input.otherRoads]) : null;
  const blocked = others ? (x: number, y: number) => others.clearance(x, y) < VERGE + 2 : undefined;
  const areas = input.runoff ? runoffAreas(t, metrics.corners, input.runoff, earth, index, blocked) : [];

  const footprints: Footprint[] = [];
  const building = pitLane && input.pitRoad ? buildPitBuilding(pitLane, input.pitRoad, { x: t.x[0], y: t.y[0] }) : null;
  if (building) footprints.push(building.footprint);
  const stands = placeGrandstands(t, metrics.corners, facilities.overtaking, pitLane, areas, earth, footprints);
  footprints.push(...stands.map((x) => x.footprint));
  // Barriers round the track, behind the run-off: steel rails, tyre walls at the gravel traps, catch fencing by the stands.
  const barriers = barrierRuns({ track: t, index, earth, runoff: areas, pit: pitLane, stands, avoid: footprints, blocked });
  // Advertising boards behind the barriers, and the gantries over the road.
  const boards = placeBoards(t, barriers, metrics.corners, earth);
  const gantries = placeGantries(t, metrics.straights, pitLane, earth, footprints, blocked);
  // (Nothing grows round their posts.)
  for (const g of gantries) for (const e of g.ends) if (e.post) footprints.push({ x: [e.x - 1, e.x + 1, e.x + 1, e.x - 1], y: [e.y - 1, e.y - 1, e.y + 1, e.y + 1] });

  const onRunoff = areas.length ? runoffTest(t, areas, index) : null;
  const behind = barriers.length ? insideBarriers(t, barriers, index) : null;
  // Marshal posts behind the run-off and the barriers, clear of the buildings, and the flag marshal's rostrum at the line.
  const taken = (x: number, y: number) => (onRunoff?.(x, y, 2) ?? false) || (behind?.(x, y, 1.5) ?? false) || footprints.some((f) => inside(f, x, y, 2));
  const posts = marshalPostSites(t, facilities.marshals.posts, earth, taken);
  const lineSite = lineFlagSite(t, (pitLane?.side ?? 1) as 1 | -1, earth, taken);
  footprints.push(...[...posts, lineSite].map((p) => p.footprint));
  return { index, blocked, areas, building, stands, barriers, boards, gantries, posts, lineSite, footprints, onRunoff, insideBarriers: behind };
}

/** A marshal post's hut reaches this far above its floor, and a rostrum's rail this far, metres. */
const POST_TOP = 2.9;
const ROSTRUM_TOP = 1.2;

/** What of a venue hides a view or is no place for a camera: the pit building, the grandstands, the beams of the gantries and the marshal posts. */
export function venueSolids(v: Venue): Solid[] {
  const out: Solid[] = [];
  for (const b of v.building?.blocks ?? []) out.push({ kind: 'pit building', ...b });
  for (const s of v.stands) for (const b of standBlocks(s)) out.push({ kind: 'grandstand', ...b });
  for (const g of v.gantries) {
    const [l, r] = g.ends;
    const beam = gantryBeam(g);
    const len = Math.hypot(r.x - l.x, r.y - l.y) || 1;
    // (Along the track: the beam is this deep either side of the line between its ends.)
    const ax = (-(r.y - l.y) / len) * beam.depth;
    const ay = ((r.x - l.x) / len) * beam.depth;
    out.push({ kind: 'gantry', x: [l.x + ax, r.x + ax, r.x - ax, l.x - ax], y: [l.y + ay, r.y + ay, r.y - ay, l.y - ay], anchor: g.road, lo: beam.lo, hi: beam.hi });
  }
  for (const p of [...v.posts, v.lineSite]) {
    // (A post's pad is given corner by corner across it: round it, they are 0, 1, 3, 2.)
    const f = p.footprint;
    out.push({ kind: 'marshal post', x: [f.x[0], f.x[1], f.x[3], f.x[2]], y: [f.y[0], f.y[1], f.y[3], f.y[2]], anchor: p.ground, lo: 0, hi: p.floor - p.ground + (p.rostrum ? ROSTRUM_TOP : POST_TOP) });
  }
  return out;
}

/**
 * How far from the middle of the road the barrier stands at each station,
 * on the left (index 0) and on the right (1): NaN where there is none; and
 * whether it carries a catch fence there.
 */
export function barrierOffsets(t: Track, runs: readonly BarrierRun[]): { offset: [Float32Array, Float32Array]; fence: [Uint8Array, Uint8Array] } {
  const offset: [Float32Array, Float32Array] = [new Float32Array(t.n).fill(NaN), new Float32Array(t.n).fill(NaN)];
  const fence: [Uint8Array, Uint8Array] = [new Uint8Array(t.n), new Uint8Array(t.n)];
  for (const run of runs) {
    const side = run.side > 0 ? 0 : 1;
    for (let i = 0; i < run.stations.length; i++) {
      offset[side][run.stations[i]] = run.offset[i];
      if (run.fence[i]) fence[side][run.stations[i]] = 1;
    }
  }
  return { offset, fence };
}
