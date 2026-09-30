# Architecture

## Layout

```
src/
  core/            DOM-free logic, unit-tested in Node
    rng.ts           seed hashing and a seeded PRNG
    noise.ts         seeded simplex noise, fBm, ridged noise
    terrain.ts       presets and heightmap generation
    erosion.ts       droplet hydraulic erosion
    heightmap.ts     heightmap type and bilinear sampling
    terrainImage.ts  hillshade, colour ramp, water and contour images
    geometry.ts      spline, smoothing, simplification, intersections, spatial grid
    track.ts         control points -> stations; elevation grading
    analysis.ts      metrics, corners, straights
    validate.ts      design warnings
    racingLine.ts    minimum-curvature racing line
    vehicles.ts      vehicle classes from data/vehicles.json
    lapSim.ts        quasi-steady-state lap simulation
    performance.ts   racing line + a lap per class + sectors
    startFinish.ts   start line placement, grid slots, track rotation
    pitLane.ts       pit lane placement and drive-through time loss
    marshals.ts      marshal posts with terrain sight lines
    facilities.ts    grid, pit lane, speed trap, DRS, overtaking, marshals
    licence.ts       FIA and FIM licence estimate with run-off tracing
    circuits.ts      real circuit CSVs -> track designs
    calibration.ts   reference laps, error, parameter fitting
    project.ts       project file format
  worker/          terrain generation, and lap times + facilities + licence, off the main thread
  ui/              plain TypeScript and canvas, no framework
    store.ts         state, derived data, undo, autosave
    mapView.ts       map canvas: camera, drawing, editing tools, overlays
    profileView.ts   elevation profile and speed trace canvas
    facilityLayer.ts facilities and drag handles on the map
    panels/          sidebar panels per mode
data/
  vehicles.json      vehicle classes (edit to add or change classes)
  reference-laps.json  real qualifying laps with sources
  circuits/          TUMFTM racetrack database (LGPL-3.0)
docs/CALIBRATION.md  generated calibration report
tests/             Vitest suites for core, including calibration against real laps
scripts/           benchmarks and the calibration script (Node)
```

`core` never touches the DOM, so the same code runs in the app, in workers, in tests and in Node scripts.

## Conventions

- **Units.** Metres, seconds and radians. Gradients are fractions (0.05 is 5%).
- **World coordinates.** Metres from the map's top-left corner, x east, y south. Screen and world share orientation, so no axis flip is needed.
- **Signs.** Positive curvature is a right-hand corner; positive gradient is uphill in the direction of travel; negative vertical curvature is a crest. A positive shoelace area means clockwise.
- **Station ranges** (corners, warnings) are inclusive and may wrap past station 0, in which case `end < start`.

## Data flow

```
TerrainSettings --worker--> Heightmap + images
TrackDesign (control points, widths, grading) + Heightmap
    --buildTrack--> Track (stations every ~2 m)
    --placeStartFinish, rotateTrack--> Track with the start line at station 0
    --analyseTrack--> TrackMetrics
    --validateTrack--> Issue[]
Track + metrics + VehicleClass[] + overrides --worker-->
    Performance (racing line, a LapResult per class, sectors)
    Facilities (grid, pit lane and time loss, speed trap, DRS, overtaking, marshals)
    Licence (FIA and FIM grade, checklist, run-off paths)
```

The store owns the project (the only persisted state) and recomputes the track, metrics and warnings whenever the design or terrain changes. Lap times, facilities and the licence follow 150 ms after the last change, in a worker (which keeps the heightmap, sent once per terrain); until they arrive the previous laps stay on screen, mapped onto the new stations by their share of the lap. Views subscribe to topics (`track`, `hover`, `selection`, ...) batched per microtask. Panels update their controls in place rather than rebuilding, so a slider being dragged is never replaced.

## Terrain

1. **Noise.** Three broad fBm octaves are domain-warped for irregular landforms; finer octaves add unwarped detail. Warping the fine octaves too shears them into parallel bands, so they stay isotropic. Octaves continue down to about two cells.
2. **Ridges.** Ridged noise adds crests and spurs only on high ground, so valleys stay open.
3. **Valley floors.** Heights are normalised and shaped with a linear-cubic blend that flattens low ground.
4. **Erosion.** Droplet erosion runs on a 512² copy; the change is upsampled onto the full map, and extended to the edges where droplets cannot reach.
5. **Water** is the height below which the requested share of the map lies.

Generation uses only arithmetic, `Math.floor` and `Math.sqrt` (no `pow`, `exp` or trigonometry), so a seed gives the same map on every engine. A 2048² map takes about two seconds.

The base image uses a colour ramp by height above the lowest land (stretched over at least 120 m, so flat maps stay green), rock on steep slopes, hillshade from the north-west with automatic vertical exaggeration, and depth-shaded water. Contours are a separate transparent image so they toggle without re-rendering.

## Track

- **Spline.** A closed centripetal Catmull-Rom spline through the control points; this parameterisation never forms cusps or loops within a segment. It is sampled densely, then resampled to evenly spaced stations (about 2 m).
- **Curvature** is the change in chord heading per metre, smoothed over about 4 m.
- **Width** blends between control points with a smoothstep.
- **Grading.** The terrain profile under the centreline is smoothed coarse to fine, clamped to the cut/fill limit after every pass, then relaxed with a projected diffusion step. The track bridges small bumps where the limit binds instead of copying them, and the limit holds exactly.

## Analysis

- **Corners.** A station enters a corner below 300 m radius and leaves above 450 m. The entry and exit extend while the radius stays under 1 km. Same-direction corners less than 40 m apart merge into one (a double apex), and turns under 10° are dropped. Each corner is classified from its total angle and minimum radius: kink, hairpin, long corner, sweeper, slow or medium. Quick direction changes are then paired as chicanes (tight) or esses (fast). The track is rotated so station 0 is the start line before analysis, so corners are numbered from the start/finish line.
- **Straights** have a radius above 1 km and change direction by no more than 15° in total. The limit stops a long gentle arc from counting as one straight.
- **Warnings.** Per-station tests are grouped into ranges. Crossings, overlaps and too-close stretches come from a spatial grid over the stations, ignoring neighbours along the lap. One issue is reported per stretch, named after the worst problem in it.

## Racing line

Each station may move sideways by an offset *n* along the track normal, staying 1.2 m inside each edge. Around a reference line with curvature κ, the curvature of the moved line is to first order κ − n″ − κ²n: the last term says that the outside of a corner is gentler. The line minimises ∫κ² ds, which is quadratic in the offsets with a pentadiagonal matrix, and is solved exactly:

- the loop is cut by pinning two stations on a straight, which leaves a banded system solved by LDLᵀ;
- the edge limits are held by an active-set method;
- the problem is re-linearised around the new line eight times, alternating the cut between two straights and limiting each step to 4 m.

It takes 30–90 ms for a 5 km track. Minimum curvature is the standard stand-in for a real line. A direct lap-time optimisation was about 2.4% faster on a synthetic circuit of 90° corners, but too slow to run live; calibration absorbs the difference.

## Lap simulation

A quasi-steady-state point mass on the racing line:

1. **Corner speed** per station by bisection, from tyre grip (falling linearly with load above the car's weight), downforce and vertical curvature (crests unload the tyres, dips load them).
2. **Forward pass**: acceleration limited by power, by traction on the driven wheels after the cornering force is taken (friction ellipse), and for bikes by the wheelie limit. Drag, rolling resistance and gradient act against it.
3. **Backward pass**: braking limited the same way, and for bikes by the stoppie limit.

Both passes start at the slowest corner and run twice round the loop, so the lap closes on itself. The speed is the lowest of the three. Throttle and brake come from the force each speed change needs (full throttle on the rev limiter). Gears are spaced geometrically from first gear to top speed. Cars with an aero range are run at five wing settings and the fastest is kept.

F1 and F2 open DRS in up to three zones, the longest straights of the racing line of at least 400 m.

Sectors split the lap of a reference class (GT3) into thirds of time, each line moved to the nearest full-throttle station within 6% of the lap time.

## Calibration

`scripts/calibrate.ts` builds the flat TUMFTM circuits, runs every class and compares the result with the real qualifying laps in `data/reference-laps.json`. It then fits the parameters described in [docs/CALIBRATION.md](docs/CALIBRATION.md) by golden-section search on squared log errors. `tests/calibration.test.ts` keeps every class within 2.5% RMS and every fitted lap within 5%.

## Facilities

- **Start/finish** (on the track as built, before rotation). Every 5 m is scored on how much of a 202 m grid lies on a straight (radius above 700 m), the distance to the first corner in the FIA sense (at least 45 degrees, radius under 300 m, preferably 250 m away), the grid gradient (at most 2%), the grid width (15 m) and the length of the straight. A hand-placed line snaps to the nearest station.
- **Pit lane.** Parallel candidates start every 20 m on either side, 500 to 660 m long, with 120 m ramps; chord candidates cut straight across the infield and join the track at 25 degrees or less. A candidate is rejected when it leaves the map, enters water, comes within 5 m of another part of the track, needs more than 12 m of earthworks, bends too tightly or has less than 250 m for the boxes; a chord is also rejected when a stop would cost under 8 s (a shortcut). The rest are scored on entry and exit clearance from the racing line, braking at the exit, flatness, gradient, box length and adjacency to the start.
- **Pit loss.** Braking from track speed to the class's limit, the lane at the limit, and accelerating back, against the lap's own time over the same widened stretch.
- **Speed trap:** the end of the longest stretch at the fastest class's top speed. **Overtaking spots:** braking zones with a drop of more than 60 km/h after a full-throttle run of 250 m or more, the four biggest.
- **Marshal posts.** Greedy: from each post, the next goes as far ahead as possible (at most 500 m) while the two posts see each other and every sampled station between them is seen by one of them. Sight lines are traced over the heightmap at 1.7 m eye height.
- **Overrides.** Dragging a handle in Analyse saves a world position in the project's `overrides` (start line, pit entry and exit with the side, speed trap), not a station number, so it survives edits that renumber the stations; each is snapped to the nearest station when used. A hand-placed pit lane is built as a parallel lane between its two points and keeps its problems listed instead of being rejected. Overrides are undoable like any edit.

## Licence

`licence.ts` builds a checklist per body from FIA Appendix O 2026 (with supplement 2 for lengths and the maximum number of starters), FIA Appendix H 2026 (marshal posts) and the FIM Standards for Circuits 2024. Each check applies to all grades or to some; the estimated grade is the best one whose required checks all pass. Recommended and info checks are shown but do not block. Each class names the grade it needs in `data/vehicles.json` (`licence`), set by weight/power ratio as in Appendix O.

This is an estimate from the geometry alone: barriers, kerbs, medical centre and buildings are not modelled, and real homologation needs an inspection. The run-off depth and the crest limit (cars keep at least half their weight) are this tool's own assumptions, since the regulations set run-off per circuit.

Run-off is checked per grade with the laps of the classes that need exactly that grade. Each corner gets two escape paths: straight on from the turn-in point, at the fastest speed in the 100 m before it, and along the apex tangent at apex speed. A path starts where it leaves the track surface and runs until it meets water, the map edge or another part of the track (not the stretch within 300 m of the corner). It passes when it is free for the required depth: 30 m at 100 km/h rising to 100 m at 300 km/h for cars, and 1.3 times that (40 to 130 m) for bikes. The ground slope along it is reported against the FIA (25% up, 3% down) and FIM (10% up, 3% down) limits.
