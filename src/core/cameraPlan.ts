/**
 * Where the television cameras of a circuit stand.
 *
 * A host broadcaster has two dozen cameras round a circuit, and more on a
 * long one: 24 round Monaco's 3.3 km, with ten more for slow motion where
 * cars pass; 23 fixed ones round Aragon's 5.1 km for MotoGP, "two on every
 * important corner"; 34 round the 13.6 km of Le Mans. (`CAMERAS` is the line
 * through those three; the sources are in docs/ROADMAP.md.) They stand on
 * towers and platforms behind the barriers, lower now than they used to,
 * to show the speed; on a lift over the first corner; on the grandstands
 * for the wide view; over the pit lane; and a few are built into the kerbs
 * (those are left out here: what they showed was grass and kerb).
 * A long straight is covered in three: out of the corner before it, at top
 * speed, and into the braking zone.
 *
 * So the cameras are not put down by rule but chosen. Every place a camera
 * could stand is a candidate: beyond the barrier round the outside of each
 * corner and inside it, head-on where the straight into it would run on,
 * three along each straight on both sides, on the roof of each grandstand
 * and of the pit building, each at more than one height. A candidate is one
 * only if a camera can stand there (`Solids.standing`: clear of everything
 * built and of the hillside, behind the barrier, off the roads and out of
 * the water). What it sees is tried against the ground as drawn and
 * against everything built (`Solids.between`), and each station it sees
 * gets a mark for the picture: better when the car is at a good distance
 * and comes towards the lens. Then cameras are taken one at a time, each
 * the one that adds most to the best picture there is of every station
 * (braking zones and corners counting for more), until the circuit has its
 * number or nothing is left to gain; the places where cars pass get a
 * second camera, and a stretch still unseen gets one of its own.
 */
import type { Corner, TrackMetrics } from './analysis.ts';
import { VERGE } from './earthworks.ts';
import type { Facilities } from './facilities.ts';
import type { PitLane } from './pitLane.ts';
import { STAND_DEPTH, STAND_ROOF, TrackIndex, cornerName } from './scenery.ts';
import type { Display, Vec3 } from './shots.ts';
import { Solids } from './solids.ts';
import { GRID_LENGTH } from './startFinish.ts';
import type { Track } from './track.ts';
import { type Venue, barrierOffsets } from './venue.ts';

export interface TvCamera {
  id: string;
  label: string;
  /** Position, world coordinates (x east, y south, z up) with heights as drawn. */
  at: Vec3;
  /** Per station: 1 where the camera sees the track. */
  sees: Uint8Array;
  /** Per station it sees: how good the picture of a car there is, 1 to 255. */
  quality?: Uint8Array;
  /** The side of the road it stands on: 1 left of the direction of travel, -1 right (none for one that is not beside it). */
  side?: 1 | -1;
  /** What it stands on: a tower of its own from the ground up (the default), a platform on a roof, or a post on the pit wall. */
  mount?: 'tower' | 'roof' | 'post';
  /** How far it turns either way from the way it faces, radians: what it stands on is behind it. */
  pan?: number;
  /** The station it was placed for (a corner's turn-in, the middle of a straight), and the station it sees that is nearest to it: where a car passes it. */
  station?: number;
  closest?: number;
  /** For drawing what it stands on: the real height of the ground or roof under it, how far above that it is, and the way it faces (radians, as a heading). */
  stand?: { ground: number; up: number; facing: number };
}

export interface CameraInput {
  track: Track;
  metrics: TrackMetrics;
  pit: PitLane | null;
  /** Shaped ground height (real). */
  height: (x: number, y: number) => number;
  /** A real height as drawn (default: as it is). */
  display?: Display;
  /** Run-off depth beside station k on a side, where the barriers are not known. */
  runoff?: (k: number, side: 1 | -1) => number;
  /** What stands round the track, and what of it is in the way (without them: open ground). */
  venue?: Venue;
  solids?: Solids;
  /** For where cars brake and pass. */
  facilities?: Facilities;
  /** Whether a point is under water. */
  wet?: (x: number, y: number) => boolean;
  /** The size of the map, to keep the cameras on it. */
  extent?: number;
}

/** A trackside lens reaches this far (metres), and is no use closer than this. */
export const CAMERA_REACH = 750;
const CAMERA_NEAR = 12;
/** Cameras round a circuit: this many, and this many more per kilometre (Monaco 24 for 3.3 km, Aragon 23 for 5.1, Le Mans 34 for 13.6). */
const CAMERAS = [18, 1.25];
const MOST_CAMERAS = 60;
/** A stretch of track out of every camera's sight longer than this gets another camera. */
const BLIND_STRETCH = 120;
/** A camera stands this far behind the barrier, and no nearer another camera than this (metres). */
const BEHIND = 4;
const APART = 25;
/** Heights of a camera on a tower above the ground (metres): low, as they stand now, or higher where that sees more; and on a lift. */
const TOWER = [4, 8];
const LIFT = 14;
const HOIST = [6, 12, 25];
/** A camera on a roof is this far above it. */
const ON_ROOF = 1.7;
/** A quarter of the width of the picture a camera has of one car, metres at the car: nothing built may stand within that of the car, either side. */
export const FRAME_HALF = 4;
/**
 * How far a camera turns either way from the way it faces (degrees): on a
 * tower nearly right round, its platform's rail behind it; on a roof only
 * to where the roof would come into the picture; on a post right round.
 */
const PAN = { tower: 125, roof: 70, post: 180 } as const;
/** The camera for the pit lane stands on the pit wall, this far above the lane (metres); the wall is this far beyond the lane's edge. */
const ON_WALL = 4.5;
const WALL_OUT = 0.9;
/** A camera behind a catch fence stands at least this high, to look over it (the fence is 3.5 m). */
const OVER_FENCE = 6;
/**
 * A director can only cut to a camera that keeps the car a few seconds, so
 * what cameras see must overlap where one hands over to the next: a car
 * anywhere should have a camera that sees it for the next HOLD metres (three
 * seconds at 180 km/h). Sight further ahead than HOLD_MOST counts for no
 * more. Where the cameras a circuit gets by its length leave a car without
 * one, more are added, up to this many times that number.
 */
const HOLD = 150;
const HOLD_MOST = 300;
const MORE_TO_HOLD = 1.4;
/** Corners that get a second camera. */
const TWO_CAMERAS = 5;

interface Candidate extends TvCamera {
  quality: Uint8Array;
  /** Per station: how far ahead of a car there it sees without a break, metres (up to HOLD_MOST). */
  ahead: Uint16Array;
  /** How much a station seen from here counts: a little less from higher up, where a lower one sees as much. */
  factor: number;
  station: number;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** The trackside cameras of a circuit, with what each can see. */
export function planCameras(input: CameraInput): TvCamera[] {
  const t = input.track;
  const n = t.n;
  const ds = t.ds;
  const display = input.display ?? ((z: number) => z);
  const solids = input.solids ?? new Solids(input.height, display);
  const venue = input.venue;
  const index = venue?.index ?? new TrackIndex(t);
  const barriers = venue ? barrierOffsets(t, venue.barriers) : null;
  const stations = (m: number) => Math.round(m / ds);
  /** Where the barrier stands at a station on a side (metres from the middle of the road), or where one would. */
  const barrier = (k: number, side: 1 | -1): number => {
    const known = barriers?.offset[side > 0 ? 0 : 1][k];
    return known !== undefined && Number.isFinite(known) ? known : t.width[k] / 2 + VERGE + 4 + (input.runoff?.(k, side) ?? 0);
  };
  const beside = (k: number, side: number, d: number): [number, number] => {
    const h = t.heading[k];
    return [t.x[k] + Math.sin(h) * side * d, t.y[k] - Math.cos(h) * side * d];
  };
  const extent = input.extent ?? Infinity;
  /** Whether a camera on a tower can stand at a point `up` metres above the ground there. */
  const free = (x: number, y: number, z: number, mounted = false): boolean => {
    if (x < 15 || y < 15 || x > extent - 15 || y > extent - 15) return false;
    if (input.wet?.(x, y)) return false;
    if (!mounted && (venue?.blocked?.(x, y) || venue?.insideBarriers?.(x, y, 1.5) || venue?.onRunoff?.(x, y, 1))) return false;
    return solids.standing(x, y, z, 2.5, mounted) === null;
  };

  // ---- what a camera sees ------------------------------------------------------
  const look = new Float64Array(n);
  for (let k = 0; k < n; k++) look[k] = display(t.z[k]) + 1;
  const survey = (c: Omit<Candidate, 'sees' | 'quality' | 'ahead'>, reach = CAMERA_REACH, near = CAMERA_NEAR): Candidate => {
    const sees = new Uint8Array(n);
    const quality = new Uint8Array(n);
    const [ax, ay] = c.at;
    const facing = c.stand?.facing ?? 0;
    const turn = Math.cos(((PAN[c.mount ?? 'tower']) * Math.PI) / 180);
    const fx = Math.cos(facing);
    const fy = Math.sin(facing);
    const test = (k: number): boolean => {
      const dx = t.x[k] - ax;
      const dy = t.y[k] - ay;
      const d = Math.hypot(dx, dy);
      if (d < near || d > reach) return false;
      // (Within what it can turn to.)
      if (c.stand && (dx * fx + dy * fy) / d < turn) return false;
      // (And with a clear picture of it: nothing built at the edges of the frame either.)
      return solids.framed(c.at, [t.x[k], t.y[k], look[k]], FRAME_HALF, Math.min(6, near));
    };
    const step = 3;
    let prev = -1;
    let prevSeen = false;
    for (let k = 0; k <= n; k += step) {
      const kk = Math.min(k, n - 1);
      const seen = test(kk);
      if (seen) sees[kk] = 1;
      if (prev >= 0 && seen && prevSeen) for (let j = prev + 1; j < kk; j++) sees[j] = 1;
      prev = kk;
      prevSeen = seen;
    }
    // A glimpse lost for a few metres (a post, a bump) does not end the shot: close short gaps.
    const gap = 6;
    for (let k = 0; k < n; k++) {
      if (sees[k] || !sees[mod(k - 1, n)]) continue;
      let j = 0;
      while (j < gap && !sees[(k + j) % n]) j++;
      if (j < gap) for (let i = 0; i < j; i++) sees[(k + i) % n] = 1;
    }
    // The picture: best at 40 to 300 m, of a car that comes towards the lens.
    let closest = -1;
    let nearest = Infinity;
    for (let k = 0; k < n; k++) {
      if (!sees[k]) continue;
      const dx = ax - t.x[k];
      const dy = ay - t.y[k];
      const d = Math.hypot(dx, dy) || 1;
      if (d < nearest) {
        nearest = d;
        closest = k;
      }
      const far = d < 40 ? 0.6 + 0.4 * (d / 40) : d <= 300 ? 1 : 1 - 0.65 * ((d - 300) / (reach - 300 || 1));
      const towards = (dx * Math.cos(t.heading[k]) + dy * Math.sin(t.heading[k])) / d;
      const way = towards > 0.5 ? 1 : towards > -0.5 ? 0.85 : 0.6;
      const down = (c.at[2] - look[k]) / d > 0.7 ? 0.8 : 1;
      quality[k] = Math.max(1, Math.round(255 * far * way * down));
    }
    // How far ahead of a car at each station it goes on seeing it: twice round, backwards, so that a stretch across the line counts whole.
    const ahead = new Uint16Array(n);
    let run = 0;
    for (let i = 2 * n - 1; i >= 0; i--) {
      const k = i % n;
      run = sees[k] ? Math.min(HOLD_MOST, run + ds) : 0;
      if (i < n) ahead[k] = run;
    }
    return { ...c, sees, quality, ahead, pan: (PAN[c.mount ?? 'tower'] * Math.PI) / 180, ...(closest >= 0 ? { closest } : {}) };
  };

  // ---- the places a camera could stand -----------------------------------------
  const candidates: Candidate[] = [];
  const facingTrack = (x: number, y: number, k: number) => Math.atan2(t.y[k] - y, t.x[k] - x);
  /** A camera on a tower beside the track: at station k, `d` metres from the middle of the road on a side, at each height that can be. */
  const tower = (id: string, label: string, k: number, side: 1 | -1, d: number, ups: readonly number[] = TOWER): void => {
    const [x, y] = beside(k, side, d);
    const ground = input.height(x, y);
    // (Behind a catch fence, only from over it: no camera looks through the wire.)
    const fenced = barriers?.fence[side > 0 ? 0 : 1][k] === 1;
    for (const up of ups) {
      if (fenced && up < OVER_FENCE) continue;
      const z = display(ground) + up;
      if (!free(x, y, z)) continue;
      candidates.push(survey({ id: `${id}-${up}`, label, at: [x, y, z], side, mount: 'tower', stand: { ground, up, facing: facingTrack(x, y, k) }, factor: up <= TOWER[0] ? 1 : up <= TOWER[1] ? 0.93 : 0.85, station: k }));
    }
  };
  /** Where the straight into a corner would run on, beyond the barrier: the place to look back up it. */
  const headOn = (c: Corner): { x: number; y: number; k: number; side: 1 | -1 } | null => {
    const h = t.heading[mod(c.start - stations(15), n)];
    for (let s = 20; s <= 320; s += 4) {
      const x = t.x[c.start] + Math.cos(h) * s;
      const y = t.y[c.start] + Math.sin(h) * s;
      const near = index.nearest(x, y, 160);
      if (!near) return s >= 40 ? { x, y, k: c.apex, side: c.direction === 'right' ? 1 : -1 } : null;
      const lateral = index.lateral(near.k, x, y);
      const side: 1 | -1 = lateral >= 0 ? 1 : -1;
      if (Math.abs(lateral) >= barrier(near.k, side) + BEHIND) return { x, y, k: near.k, side };
    }
    return null;
  };
  const cornerLabel = (c: Corner) => cornerName(c).split(' ')[0];
  const span = (from: number, to: number) => mod(to - from, n);
  for (const c of input.metrics.corners) {
    if (c.angle < 20) continue;
    const out: 1 | -1 = c.direction === 'right' ? 1 : -1;
    const name = cornerLabel(c);
    const len = span(c.start, c.end);
    const early = mod(c.start + Math.round(len * 0.25), n);
    const late = mod(c.start + Math.round(len * 0.75), n);
    for (const [tag, k] of [['a', c.apex], ['b', early], ['c', late]] as const) tower(`corner-${c.number}${tag}`, name, k, out, barrier(k, out) + BEHIND);
    tower(`corner-${c.number}i`, `${name} inside`, c.apex, -out as 1 | -1, barrier(c.apex, -out as 1 | -1) + BEHIND);
    const on = headOn(c);
    if (on) {
      const ground = input.height(on.x, on.y);
      for (const up of TOWER) {
        const z = display(ground) + up;
        if (!free(on.x, on.y, z)) continue;
        candidates.push(survey({ id: `corner-${c.number}h-${up}`, label: `${name} head-on`, at: [on.x, on.y, z], side: on.side, mount: 'tower', stand: { ground, up, facing: facingTrack(on.x, on.y, c.start) }, factor: up <= TOWER[0] ? 1 : 0.93, station: c.start }));
      }
    }
  }
  // Three along every straight worth one: out of the corner before it, at top speed, and into the braking zone.
  input.metrics.straights.forEach((st, i) => {
    if (st.length < 200) return;
    const len = span(st.start, st.end);
    for (const [tag, f] of [['a', 0.15], ['b', 0.5], ['c', 0.85]] as const) {
      const k = mod(st.start + Math.round(len * f), n);
      for (const side of [1, -1] as const) tower(`straight-${i + 1}${tag}${side > 0 ? 'l' : 'r'}`, 'Straight', k, side, barrier(k, side) + BEHIND);
    }
  });
  // On the roofs: the back of each grandstand, and the pit building over the lane.
  const roofs: Candidate[] = [];
  (venue?.stands ?? []).forEach((s, i) => {
    for (const [tag, f] of [['a', 0.5], ['b', 0.15], ['c', 0.85]] as const) {
      const p = s.front[Math.min(s.front.length - 1, Math.round((s.front.length - 1) * f))];
      // (At the front edge of the roof, which covers the upper rows: nothing of it in the picture.)
      const x = p.x + p.ox * (STAND_DEPTH * 0.3 + 0.5);
      const y = p.y + p.oy * (STAND_DEPTH * 0.3 + 0.5);
      const ground = s.base + STAND_ROOF;
      const z = display(s.base) + STAND_ROOF + ON_ROOF;
      if (!free(x, y, z, true)) continue;
      const near = index.nearest(x, y, 200);
      const k = near?.k ?? 0;
      const c = survey({ id: `stand-${i + 1}${tag}`, label: 'Grandstand', at: [x, y, z], side: index.lateral(k, x, y) >= 0 ? 1 : -1, mount: 'roof', stand: { ground, up: ON_ROOF, facing: Math.atan2(-p.oy, -p.ox) }, factor: 0.9, station: k });
      roofs.push(c);
      candidates.push(c);
    }
  });
  const pitRoofs: Candidate[] = [];
  const blocks = venue?.building?.blocks ?? [];
  if (blocks.length && input.pit) {
    // (Not on the tower at its end: the main roof, a third and two thirds of the way along and at its ends.)
    const main = blocks.filter((b) => b.hi <= Math.min(...blocks.map((x) => x.hi)) + 0.01);
    for (const [tag, f] of [['a', 0.5], ['b', 0.04], ['c', 0.96], ['d', 0.25], ['e', 0.75]] as const) {
      const b = main[Math.min(main.length - 1, Math.round((main.length - 1) * f))];
      // (Corners: the front from a to b, then the rear from b back to a.)
      const fx = (b.x[0] + b.x[1]) / 2;
      const fy = (b.y[0] + b.y[1]) / 2;
      const rx = (b.x[2] + b.x[3]) / 2;
      const ry = (b.y[2] + b.y[3]) / 2;
      const deep = Math.hypot(rx - fx, ry - fy) || 1;
      // (Out on the eave over the doors, at its edge.)
      const x = fx - ((rx - fx) / deep) * 1.1;
      const y = fy - ((ry - fy) / deep) * 1.1;
      const z = display(b.anchor) + b.hi + ON_ROOF;
      if (!free(x, y, z, true)) continue;
      const near = index.nearest(x, y, 300);
      const k = near?.k ?? 0;
      const c = survey({ id: `pitroof-${tag}`, label: 'Pit roof', at: [x, y, z], side: index.lateral(k, x, y) >= 0 ? 1 : -1, mount: 'roof', stand: { ground: b.anchor + b.hi, up: ON_ROOF, facing: Math.atan2(fy - ry, fx - rx) }, factor: 0.9, station: k });
      pitRoofs.push(c);
      candidates.push(c);
    }
  }

  // ---- choosing --------------------------------------------------------------
  // What a station counts for: more where cars brake and pass, in the corners, and on the grid and away from it.
  const weight = new Float32Array(n).fill(1);
  for (const c of input.metrics.corners) for (let i = 0; i <= span(c.start, c.end); i++) weight[(c.start + i) % n] += 0.4;
  const zones = [...(input.facilities?.overtaking ?? [])].sort((a, b) => b.speedDrop - a.speedDrop);
  const cornerAfter = (k: number) => [...input.metrics.corners].sort((a, b) => mod(a.apex - k, n) - mod(b.apex - k, n))[0];
  for (const z of zones) {
    const c = cornerAfter(z.station);
    if (!c) continue;
    for (let i = 0; i <= span(z.station, c.apex); i++) weight[(z.station + i) % n] += 1;
  }
  const grid = stations(GRID_LENGTH);
  for (let i = -grid; i <= stations(250); i++) weight[mod(i, n)] += 0.5;

  const chosen: Candidate[] = [];
  const best = new Uint8Array(n);
  /** Per station: the furthest ahead any camera taken so far goes on seeing a car there. */
  const held = new Uint16Array(n);
  const take = (c: Candidate): void => {
    chosen.push(c);
    for (let k = 0; k < n; k++) {
      if (c.quality[k] > best[k]) best[k] = c.quality[k];
      if (c.ahead[k] > held[k]) held[k] = c.ahead[k];
    }
  };
  const taken = (c: Candidate) => chosen.includes(c);
  const crowded = (c: Candidate) => chosen.some((o) => Math.hypot(o.at[0] - c.at[0], o.at[1] - c.at[1]) < APART);
  // What a camera adds: a better picture of the stations it sees, and a longer hold on a car at each.
  const gain = (c: Candidate): number => {
    let g = 0;
    for (let k = 0; k < n; k++) {
      if (c.quality[k] > best[k]) g += (weight[k] * (c.quality[k] - best[k])) / 255;
      if (c.ahead[k] > held[k]) g += (weight[k] * (c.ahead[k] - held[k])) / HOLD_MOST;
    }
    return g * c.factor * ds;
  };
  const over = (c: Candidate, from: number, count: number): number => {
    let q = 0;
    for (let i = 0; i < count; i++) q += c.quality[mod(from + i, n)];
    return q / (255 * Math.max(1, count));
  };

  // The start, from behind the grid: a tower beside the road behind the last row, or a roof that looks down the grid.
  const back = mod(-grid - stations(35), n);
  const startTowers = candidates.length;
  // (High: it looks along the fence that lines the start straight, and over it.)
  for (const side of [1, -1] as const) tower(`start${side > 0 ? 'l' : 'r'}`, 'Start', back, side, barrier(back, side) + BEHIND, [LIFT]);
  const starts = [...candidates.slice(startTowers), ...pitRoofs, ...roofs].filter((c) => {
    // Behind the grid, looking down it: the car on pole comes no nearer than the last row.
    const d = (k: number) => Math.hypot(t.x[k] - c.at[0], t.y[k] - c.at[1]);
    return d(mod(-grid, n)) < d(0) && over(c, mod(-grid, n), grid + stations(120)) > 0.5;
  });
  // (A tower behind the last row before a roof beside the grid: it looks down the grid as the field does.)
  const down = (c: Candidate) => over(c, mod(-grid, n), grid + stations(150)) + (c.mount === 'tower' ? 0.25 : 0);
  let start = starts.sort((a, b) => down(b) - down(a))[0] ?? null;
  if (start) {
    start = { ...start, id: 'start', label: 'Start' };
    take(start);
  }
  // The first corner from a lift: head-on where the straight into it would run on, or round its outside, wherever
  // the way into it is seen best.
  const first = input.metrics.corners.find((c) => c.angle >= 45) ?? input.metrics.corners[0];
  if (first) {
    const out: 1 | -1 = first.direction === 'right' ? 1 : -1;
    const len = span(first.start, first.end);
    const places: { x: number; y: number; side: 1 | -1 }[] = [];
    const on = headOn(first);
    if (on) places.push(on);
    for (const f of [0.25, 0.5, 0.75]) {
      const k = mod(first.start + Math.round(len * f), n);
      const [x, y] = beside(k, out, barrier(k, out) + BEHIND);
      places.push({ x, y, side: out });
    }
    const into = mod(first.start - stations(150), n);
    let lift: Candidate | null = null;
    for (const p of places) {
      const ground = input.height(p.x, p.y);
      for (const up of [LIFT, 10]) {
        const z = display(ground) + up;
        if (!free(p.x, p.y, z)) continue;
        const c = survey({ id: 't1', label: `${cornerLabel(first)} high`, at: [p.x, p.y, z], side: p.side, mount: 'tower', stand: { ground, up, facing: facingTrack(p.x, p.y, first.start) }, factor: 1, station: first.start });
        if (over(c, into, stations(170)) >= 0.4 && (!lift || over(c, into, stations(170)) > over(lift, into, stations(170)) + 0.03)) lift = c;
        break;
      }
    }
    if (lift) take(lift);
  }
  // For the pit lane: on a post on the pit wall, across the lane from the garages, a quarter of the way in from the
  // end the cars leave by: the boxes in front of it with the garages behind them, the lane both ways, and the
  // start straight at its back.
  if (blocks.length && input.pit) {
    const main = blocks.filter((b) => b.hi <= Math.min(...blocks.map((x) => x.hi)) + 0.01);
    const exit = input.pit.exit;
    const order = [...main].sort((a, b) => {
      const ka = index.nearest((a.x[0] + a.x[1]) / 2, (a.y[0] + a.y[1]) / 2, 400)?.k ?? 0;
      const kb = index.nearest((b.x[0] + b.x[1]) / 2, (b.y[0] + b.y[1]) / 2, 400)?.k ?? 0;
      return mod(exit - ka, n) - mod(exit - kb, n);
    });
    const b = order[Math.min(order.length - 1, Math.round(order.length * 0.25))];
    if (b) {
      const fx = (b.x[0] + b.x[1]) / 2;
      const fy = (b.y[0] + b.y[1]) / 2;
      const rx = (b.x[2] + b.x[3]) / 2;
      const ry = (b.y[2] + b.y[3]) / 2;
      const deep = Math.hypot(rx - fx, ry - fy) || 1;
      // (The doors are a metre and a half back from the lane's edge on their side; the wall is beyond its other edge.)
      const across = 1.5 + input.pit.width + WALL_OUT;
      const x = fx - ((rx - fx) / deep) * across;
      const y = fy - ((ry - fy) / deep) * across;
      const z = display(b.anchor) + ON_WALL;
      if (solids.standing(x, y, z, 0.6, true) === null) {
        const k = index.nearest(x, y, 400)?.k ?? 0;
        take(survey({ id: 'pit', label: 'Pit lane', at: [x, y, z], side: index.lateral(k, x, y) >= 0 ? 1 : -1, mount: 'post', stand: { ground: b.anchor, up: ON_WALL, facing: Math.atan2(ry - fy, rx - fx) }, factor: 0.9, station: k }));
      }
    }
  }
  // Then one at a time, each the one that adds most to the picture there is of the lap.
  const whole = weight.reduce((a, w) => a + w, 0) * ds;
  const wanted = Math.min(MOST_CAMERAS, Math.max(6, Math.round(CAMERAS[0] + (CAMERAS[1] * t.length) / 1000)));
  while (chosen.length < wanted) {
    let pick: Candidate | null = null;
    let most = 0;
    for (const c of candidates) {
      if (taken(c) || crowded(c)) continue;
      const g = gain(c);
      if (g > most) {
        most = g;
        pick = c;
      }
    }
    if (!pick || most < 0.003 * whole) break;
    take(pick);
  }
  // Two on every corner that matters: where cars pass, one more that sees the apex, from another place.
  for (const z of zones.slice(0, TWO_CAMERAS)) {
    const c = cornerAfter(z.station);
    if (!c || chosen.length >= MOST_CAMERAS) continue;
    const from = mod(c.apex - stations(60), n);
    const seeing = chosen.filter((x) => over(x, from, stations(90)) > 0.45);
    if (seeing.length >= 2) continue;
    const more = candidates.filter((x) => !taken(x) && !crowded(x) && over(x, from, stations(90)) > 0.45).sort((a, b) => over(b, from, stations(90)) - over(a, from, stations(90)))[0];
    if (more) take(more);
  }
  // A stretch still out of sight: a camera of its own beside its middle, on a hoist if it must be.
  const covered = () => {
    const out = new Uint8Array(n);
    for (const c of chosen) for (let k = 0; k < n; k++) out[k] |= c.sees[k];
    return out;
  };
  let fill = 0;
  for (let guard = 0; guard < 12 && chosen.length < MOST_CAMERAS; guard++) {
    const seen = covered();
    const run = longestGap(seen);
    if (!run || run.length * ds < BLIND_STRETCH) break;
    const k = mod(run.start + Math.floor(run.length / 2), n);
    let placed: Candidate | null = null;
    // (One of the candidates there are, if one sees it; else a new place beside it.)
    const known = candidates.filter((c) => !taken(c) && c.sees[k]).sort((a, b) => over(b, run.start, run.length) - over(a, run.start, run.length))[0];
    if (known) placed = known;
    for (const up of HOIST) {
      if (placed) break;
      for (const side of [1, -1] as const) {
        const [x, y] = beside(k, side, barrier(k, side) + BEHIND);
        const ground = input.height(x, y);
        const z = display(ground) + up;
        if (!free(x, y, z)) continue;
        const c = survey({ id: `fill-${fill + 1}`, label: 'Trackside', at: [x, y, z], side, mount: 'tower', stand: { ground, up, facing: facingTrack(x, y, k) }, factor: 1, station: k });
        if (c.sees[k] && (!placed || over(c, run.start, run.length) > over(placed, run.start, run.length))) placed = c;
      }
    }
    if (!placed) {
      // A stretch no camera can see from beside it: given up on.
      break;
    }
    if (placed.id.startsWith('fill-')) fill++;
    take(placed);
  }
  // Where a car would still be lost between two cameras, another that keeps it.
  const most = Math.min(MOST_CAMERAS, Math.round(wanted * MORE_TO_HOLD));
  while (chosen.length < most) {
    let short = 0;
    for (let k = 0; k < n; k++) if (held[k] < HOLD) short += ds;
    if (short < 0.02 * t.length) break;
    let pick: Candidate | null = null;
    let most2 = 0;
    for (const c of candidates) {
      if (taken(c) || crowded(c)) continue;
      let g = 0;
      for (let k = 0; k < n; k++) if (held[k] < HOLD && c.ahead[k] > held[k]) g += Math.min(HOLD, c.ahead[k]) - held[k];
      if (g > most2) {
        most2 = g;
        pick = c;
      }
    }
    // (Not for less than a stretch of 40 m held whole.)
    if (!pick || most2 * ds < 40 * HOLD) break;
    take(pick);
  }
  // The start has to be shown from somewhere: without a place behind the grid, the camera that sees most of it.
  if (!start && chosen.length) {
    const from = mod(-grid, n);
    const c = [...chosen].sort((a, b) => over(b, from, grid + stations(150)) - over(a, from, grid + stations(150)))[0];
    chosen[chosen.indexOf(c)] = { ...c, id: 'start' };
  }
  // And the first corner: without a place for the lift, the camera that has the best picture of the way into it.
  if (first && !chosen.some((c) => c.id === 't1')) {
    const from = mod(first.start - stations(150), n);
    const c = chosen.filter((x) => x.id !== 'start' && x.id !== 'pit' && x.mount !== 'roof').sort((a, b) => over(b, from, stations(170)) - over(a, from, stations(170)))[0];
    if (c && over(c, from, stations(170)) > 0.3) chosen[chosen.indexOf(c)] = { ...c, id: 't1', station: first.start };
  }
  return chosen.map(({ factor: _factor, ahead: _ahead, ...cam }) => cam);
}

/** The longest run of zeros round the lap, or null when there is none. */
export function longestGap(covered: Uint8Array): { start: number; length: number } | null {
  const n = covered.length;
  const first = covered.indexOf(1);
  if (first < 0) return { start: 0, length: n };
  let best: { start: number; length: number } | null = null;
  let start = -1;
  for (let i = 1; i <= n; i++) {
    const k = (first + i) % n;
    if (!covered[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      const length = mod(k - start, n);
      if (!best || length > best.length) best = { start, length };
      start = -1;
    }
  }
  return best;
}
