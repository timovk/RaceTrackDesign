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
    project.ts       project file format
  worker/          terrain generation off the main thread
  ui/              plain TypeScript and canvas, no framework
    store.ts         state, derived data, undo, autosave
    mapView.ts       map canvas: camera, drawing, editing tools, overlays
    profileView.ts   elevation profile canvas
    panels/          sidebar panels per mode
tests/             Vitest suites for core
scripts/           benchmarks
```

`core` never touches the DOM, so later milestones (lap-time model, race simulation) can run in a worker or in tests without changes.

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
```

The store owns the project (the only persisted state) and recomputes the track, metrics and warnings whenever the design or terrain changes. Views subscribe to topics (`track`, `hover`, `selection`, ...) batched per microtask. Panels update their controls in place rather than rebuilding, so a slider being dragged is never replaced.

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
