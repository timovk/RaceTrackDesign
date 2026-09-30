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
    circuits.ts      real circuit CSVs -> track designs
    calibration.ts   reference laps, error, parameter fitting
    project.ts       project file format
  worker/          terrain generation and lap-time analysis off the main thread
  ui/              plain TypeScript and canvas, no framework
    store.ts         state, derived data, undo, autosave
    mapView.ts       map canvas: camera, drawing, editing tools, overlays
    profileView.ts   elevation profile and speed trace canvas
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
    --analyseTrack--> TrackMetrics
    --validateTrack--> Issue[]
Track + VehicleClass[] --worker--> Performance (racing line, a LapResult per class, sectors)
```

The store owns the project (the only persisted state) and recomputes the track, metrics and warnings whenever the design or terrain changes. Lap times follow 150 ms after the last change, in a worker; until they arrive the previous laps stay on screen, mapped onto the new stations by their share of the lap. Views subscribe to topics (`track`, `hover`, `selection`, ...) batched per microtask. Panels update their controls in place rather than rebuilding, so a slider being dragged is never replaced.

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

- **Corners.** A station enters a corner below 300 m radius and leaves above 450 m. The entry and exit extend while the radius stays under 1 km. Same-direction corners less than 40 m apart merge into one (a double apex), and turns under 10° are dropped. Each corner is classified from its total angle and minimum radius: kink, hairpin, long corner, sweeper, slow or medium. Quick direction changes are then paired as chicanes (tight) or esses (fast). Corners are numbered from the first control point; milestone 3 will number them from the start/finish line.
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
2. **Forward pass**: acceleration limited by power, by traction on the driven wheels after the cornering force is taken (friction ellipse), and for bikes by the wheelie limit. Drag, rolling resistance and gradient act against it. F1 and F2 open DRS on straights of 300 m or more.
3. **Backward pass**: braking limited the same way, and for bikes by the stoppie limit.

Both passes start at the slowest corner and run twice round the loop, so the lap closes on itself. The speed is the lowest of the three. Throttle and brake come from the force each speed change needs. Gears are spaced geometrically from first gear to top speed. Cars with an aero range are run at five wing settings and the fastest is kept.

Sectors split the lap of a reference class (GT3) into thirds of time, each line moved to the nearest full-throttle station within 6% of the lap time.

## Calibration

`scripts/calibrate.ts` builds the flat TUMFTM circuits, runs every class and compares the result with the real qualifying laps in `data/reference-laps.json`. It then fits the parameters described in [docs/CALIBRATION.md](docs/CALIBRATION.md) by golden-section search on squared log errors. `tests/calibration.test.ts` keeps every class within 2.5% RMS and every fitted lap within 5%.
