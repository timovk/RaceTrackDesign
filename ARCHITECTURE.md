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
    scene3d.ts       3D geometry: earthworks, terrain patches, road surfaces, the model's sides
    race/
      rules.ts       race rules per class from data/racing.json
      model.ts       race lap, slipstream/wake/DRS ratios, fuel, tyres, pit lane, braking zones
      field.ts       seeded teams, drivers and crews
      setup.ts       race settings (classes, length, grid, weather), qualifying, grid
      strategy.ts    tyre loss, stop cost, stint planning
      sim.ts         the race: fixed-step simulation, classes, race control, timing, events, recording
      weather.ts     seeded rain timeline, track wetness, grip, wear and risk per tyre type
      telemetry.ts   speed, pedals, gear and g-forces from a lap's sample times; lap deltas
      stats.ts       fastest laps, speed trap, overtakes, pit stops, chart series
      export.ts      CSV of results, laps and telemetry
  worker/          terrain generation, and lap times + facilities + licence, off the main thread
  ui/              plain TypeScript and canvas (three.js for the 3D view), no framework
    store.ts         state, derived data, undo, autosave
    mapView.ts       map canvas: camera, drawing, editing tools, overlays, the 2D/3D switch
    view3d.ts        the 3D view: scene, terrain shader, orbit camera, picking (loaded on demand)
    profileView.ts   elevation profile and speed trace canvas
    facilityLayer.ts facilities and drag handles on the map
    raceController.ts runs and plays back a race, drops it when the track changes
    raceTower.ts     timing tower over the map, with flags, weather and class tabs
    raceDock.ts      telemetry, lap chart, gaps, lap times, stints, conditions and statistics under the map
    charts.ts        canvas chart helpers
    download.ts      saving files from the browser
    panels/          sidebar panels per mode
data/
  vehicles.json      vehicle classes (edit to add or change classes)
  racing.json        race rules per class: grid, crews, length, start, tyres, fuel, stops, incidents, flags
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
Track + Performance + Facilities + class --buildRaceModel--> RaceModel (one per class)
RaceModel[] + RaceSettings (classes and cars, length, grid, weather, seed) --createRaceSetup--> RaceSetup (field, qualifying, grid, weather)
RaceSetup --RaceSim.step() x N--> cars, timing, events, result
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

`scripts/raceReference.ts` prints each class's average wheel energy and tyre work per kilometre over all the circuits in `data/circuits`; these are the reference values in `data/racing.json` (see Races).

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

## 3D view

`scene3d.ts` builds the geometry in scene coordinates (x east, y up, z south, metres; heights above sea level) and `view3d.ts` shows it with three.js. The 3D view is its own chunk, loaded the first time the map switches to 3D.

**Earthworks.** Roads are centrelines with a height and a half width: the track, and the pit lane (level with the stretch of track beside it, or blending between the track at its ends for a lane across the infield; narrower where it leaves and joins). Around them the ground is shaped as a circuit is built: flat under the road, a 3 m grass verge falling 3%, then an embankment (1 in 2) down to lower ground or a cutting (1 in 1.4) up into higher ground, until it meets the natural terrain. Every road segment within reach puts a floor (its embankment) and a ceiling (its cutting) on the ground at a point, and the natural height is clamped between them; so parts of the track close together share their banks, and where two roads at different heights cannot both be met the ground splits the difference. Under the roads the ground sits 0.3 m below the surface (easing out over the first 2 m of bank), so the road surfaces never fight it for depth. Segments sit in 32 m buckets over the map, each listing the segments that reach it, so a height lookup checks only nearby ones.

**Terrain.** A quadtree of square patches of 32 cells covers the map: 1/256 of the map at the root (32 m on an 8 km map), split while the nearest road is closer than a third of the patch size, down to 2 m cells near the track; the parts of a split patch that are not near a road themselves keep half the detail. Each patch samples the shaped ground with a one-cell border, so its normals match its neighbours'. Patches of different detail leave small cracks between them, which skirts hanging down from every patch edge hide. On Spa the terrain has about 525,000 vertices and builds in about 60 ms; a 13 km track needs about a million vertices.

**Roads.** The paved surface is built as strips across each station (edge asphalt, a white line 0.25 m wide from 0.3 m inside the edge, the coloured middle), so nothing overlaps within it; the verges have a short skirt into the ground. The start line lies on top. Polygon offsets order the overlapping surfaces: start line over track, track over pit lane, both over the verges, all over the ground. The asphalt between the lines takes the flat map's track colouring.

**The model.** The map's sides go down from the ground (or up to the water level where the edge is under water) to a base below the lowest point, as on a model. Water is a translucent plane at the water level.

**Drawing.** The ground takes its colour in the shader: the flat map's height ramp, bare rock on steep slopes, grass on embankments and earth in cuttings (from how far the earthworks moved the ground at each vertex), a darker bed under water, and contour lines from the height with screen-space derivatives. Light comes from a sun in the north-west (as the flat map's hillshade) and a sky-and-ground hemisphere; a gradient sky and haze sit behind. Heights can be exaggerated by scaling the model vertically around its lowest point. The view draws only when something changed; the orbit camera keeps above the ground, and its near plane follows the distance to what it looks at, for depth precision. Hover and double-click find the ground under the cursor by marching along the view ray through the shaped ground (the same height function as the mesh) and refining the crossing, so no triangles are tested; a point on the track sets the store's hover station, which the profile shares.

## Races

### Before the start

A race has one or more classes. `buildRaceModel` builds a model per class; the track, racing line, timing lines, grid slots and pit lane geometry are shared, and everything else (race lap, ratios, fuel, tyres, braking zones, pit speed limit) belongs to the class. For each class it runs the lap simulation a few more times, all at the trim of its qualifying lap:

- the **race lap**, without DRS, as a time per station segment;
- the same lap with 25% less drag (**slipstream**, `air.towDragCut`), with less downforce (**wake**, `air.wakeDownforceLoss`) and with DRS open. Each becomes a per-station ratio to the race lap, so a car's segment time can be blended between them;
- the lap at 75% and at 50% of the dry grip, for a **wet track**. These ratios are blended for any grip level (`gripBlend`: linear between the three laps, extrapolated below 50%), so rain slows the corners and the braking far more than the straights;
- the lap 50 kg heavier, for the lap-time cost of fuel per kg.

Fuel per lap is the class's typical kg/km scaled by this track's wheel energy per km (throttle times power, summed over the lap) against the class's average on the real circuits. Tyre wear is scaled the same way by tyre work, the squared total acceleration summed over distance, clamped to 0.5 to 2 times the reference. Passing zones are the braking onsets with more than 25 km/h lost; their quality grows with the speed lost and the flat-out run before them. The pit lane becomes a path with a speed limit between its ramps and a box per team. The launch curve (speed per metre from a standstill, traction then power limited) serves the start, the pit exit and pulling away from the box or after a neutralisation.

`createRaceSetup` orders the classes by pace (fastest first; its rules set the start, the flags and the time limit) and draws each class's field from the seed: team pace and reliability, and per driver pace, consistency, tyre management, racecraft, error rate and start reaction. Endurance classes have crews of two or three drivers, fastest first; their cars are known by number. Numbers, driver codes and team names are unique across classes, and every team has its own pit box. Qualifying is the best of three laps at the qualifying time by the car's fastest driver, scaled by pace, with scatter and the odd mistake; the grid is class by class. The setup also builds the weather.

### Weather

`weather.ts` makes a seeded rain timeline in 10 s steps from an hour before the start: nothing when dry; one or more showers for changeable weather (more in a long race), each building up and easing off with a slow wobble; and for a wet race, rain from before the start that stops during the race six times in ten, sometimes with a later shower. Track wetness (0 dry, 1 standing water) follows the rain towards `rain^0.6`, with a time constant of 5 minutes when getting wetter and 16 minutes when drying.

Per tyre type, wetness sets the grip (a share of a slick's in the dry: slicks fall from 1 to 0.52, intermediates from 0.9 to 0.65, wets from 0.82 to 0.74), an extra loss for aquaplaning on slicks (and on intermediates in standing water), tyre wear (wet tyres overheat and wear up to ten times faster on a drying track; slicks wear less in the wet) and the risk of mistakes (up to twenty-odd times higher on slicks in the wet). Slicks are best up to about 12% wetness, intermediates up to about 65%, then wets; classes without intermediates go straight from slicks to wets at about 28%.

### Stepping

The simulation advances in fixed steps of 0.1 s, so a seed gives the same race at any playback speed. Randomness comes from one seeded generator per car, one for the race and one for race control, and draws use only arithmetic (normal draws sum four uniforms), so every engine agrees.

A car's position is race progress in stations from the start line, negative on the grid. Within a step it walks station by station; each segment takes

    race-lap segment × lap pace × (1 + tow × (towRatio − 1) + wake × (wakeRatio − 1) + DRS) × wet-grip ratio

where lap pace is car and driver pace times (1 + race pace + compound + tyre loss + fuel mass × sensitivity + fuel saving + cold tyres + aquaplaning) times the lap's scatter (larger on a wet track), set at each lap start and after a stop. Yellow flags slow the segments in their zone (6% single, 20% double). Under a neutralisation no car is faster than the VSC delta (the race lap `flags.vscPct` slower), the full course yellow limit (`flags.fcyKmh`) or the safety car delta (25% slower than the race lap), reached over 5 s. Speed caps apply on the launch curve and when braking for the pit entry. Every station crossed is checked against a per-station mark (timing line, sector line, timing loop every 100 m, pit decision point, pit entry, braking zone of any class, DRS detection, telemetry sample, speed trap), and crossings are timed to the exact moment inside the step.

Cars move front to back, starting behind the biggest gap, so each car sees the car ahead already moved. A car stops a minimum gap (6 m + 0.12 s × the speed of the car ahead; 10 m + 0.25 s under a safety car) behind the car ahead unless that car does not block it: off the track, on the pit entry or exit road, being passed, or on the run from the grid to the first braking zone (so the start can shuffle the order). A car that would reach that gap within the step spreads its movement over the whole step, so its speed follows the car ahead instead of surging and stopping. Slipstream is full within 0.3 s of the car ahead and gone at 1 s; the wake is full within 0.4 s and gone at 1.6 s. A standing start launches from zero after each driver's reaction; a rolling start (endurance classes and IndyCar) launches from 100 km/h.

### Racing

At a braking zone of its class, a car within 0.6 s of the car ahead may attack, unless the zone is under yellow, the race is neutralised or the car has not yet crossed the line after a restart. The advantage is the speed ratio at the braking point (the defender's speed taken where it crossed the same point) plus twice the pace difference; the chance is the zone quality × the class's overtaking factor × a ramp from 1.5% to 8.5% advantage × racecraft × closeness, capped at 80% (lap 1 × 1.3). A success lets the attacker through with a brief boost (up to its top speed) while the defender loses a quarter of a second; the defender cannot strike back for 15% of a lap. A failure costs the attacker 0.1 to 0.35 s and occasionally ends in contact (time lost for both, sometimes a retirement). A car a lap or more ahead passes a backmarker with a 90% chance at any braking zone, and a car of a faster class passes a slower-class car with 85%; neither counts as an overtake.

DRS opens when the gap at the detection point, from each car's crossing times, is within the class's limit from the given lap, on green and on a track less than 30% wet.

Each lap draws at most one incident from the class's rates, scaled by the driver's error rate, by 1.5 on tyres past their life and by the wet-weather risk of the tyres fitted: a technical failure (reliability per km), a crash, a trip off (3 to 10 s, off the racing line so others pass) or a small mistake (0.4 to 1.5 s). A failed car limps back to the pits (35%), parks where the marshals can leave it, or stops where it has to be recovered.

### Race control

Race control follows the fastest class's `flags` rules and draws from its own random stream:

- a trip off, contact or a parked car brings a single yellow (20 to 45 s) from 250 m before the spot to 60 m after it;
- a crash or a car stopped on track brings a double yellow for the recovery (60 to 210 s) and may neutralise the race. A safety car comes out with a chance that grows with the speed at the spot (30% to 70% for a crash; less in series with a full course yellow, which keep it for barrier repairs); otherwise often a virtual safety car or full course yellow until the car is recovered. A series without a virtual safety car (IndyCar, TCR) uses the safety car more; bikes only wave yellows. Nothing is neutralised on the last lap or after the flag;
- the safety car joins 150 m ahead of the leader, in a gap between cars, and runs at 70% of the fastest class's race speed (at most 198 km/h). Cars catch up at the safety car delta and queue behind it. Once the track is clear and it has led a full lap, it is "in this lap" at the line, leaves at the pit entry (or 400 m before the line), and the car behind it leads the field to the line, where racing resumes; nobody passes before crossing it;
- when a VSC or full course yellow ends, or at the restart, every car pulls away from its current speed on the launch curve.

The pit lane stays open throughout. A neutralised lap makes a stop cheap, so a car that still has to stop before the end (for fuel, tyres, the driver or its plan) takes it when the stop is due soon, the tyres are half worn, half the tank is gone or a driver change is near.

### Tyres, fuel, drivers and stops

A set loses `deg × wear` of lap time up to the end of its life (wear 1), then falls off a cliff: `deg × (1 + 6x + 20x²)` for x past it. Classes without refuelling plan before the start: a dynamic programme over (laps covered, compounds used) per number of stints finds the fastest split over the dry compounds, with stints capped at 1.6 lives, the two-compound rule (lifted once wet-weather tyres have been used) and mandatory stops enforced; the choice is random among plans within a small margin of the best, and the stop lap is spread by about 1.5 laps. At the decision point 500 m before the pit entry a car stops when the plan says so, when its tyres are past 1.08 lives, to cover a rival in its class close behind who has just stopped, to try the undercut after two laps stuck within a second of the car ahead, for a cheap stop under a neutralisation, or for the weather. Classes with refuelling stop when less than 1.2 laps of fuel remain, fill up to what the rest of the race needs, and change tyres when the set would pass 0.9 of its life in the next stint.

The weather call compares the tyres fitted with the best type for the average wetness over the next two and a half laps (what a team sees on the radar). When the time gained over up to eight laps beats the cost of a stop, the car comes in; slicks on a wet track count half as much again, wet tyres overheating on a dry one add to it, and teams weigh the stop differently. A class that does not stop at all (MotoGP, Superbike, TCR) comes in only for the weather, as in flag-to-flag racing. A race that starts wet starts on wet-weather tyres, and the dry plan waits until the track dries.

In a crew, the driver in the car hands over at a stop when their stint would pass the class's longest stint (`driverStintMinutes`) before the next stop, to the team-mate who has driven least. The change happens while refuelling (`driverChangeS`); tyres come afterwards, or at the same time in classes that do both at once.

In the pit lane a car brakes to the limit, drives to its team's box (waiting if a team-mate is still being served), stops for the service time (tyres, fuel at the refuelling rate and the driver change, concurrently or one after the other, the minimum stationary time of a mandatory stop, and a 4% chance of a slow stop), pulls away on the launch curve and rejoins; under a full course yellow the limit holds out to the exit. Its race progress is the lane mapped onto the stretch of lap it bypasses, so timing lines inside the lane still count.

### Timing and the end

Lap and sector times come from line crossings; sector colours compare with the car's and its class's best. Gaps use the timing loops: each car keeps the last two laps of loop times, and a gap is the difference between two cars' times at the loop the rear car passed last. A car a full lap or more behind shows laps instead. The race order is race progress (finishers by finish time within a lap count, retired cars last); the class order is the race order filtered by class, with gaps and intervals to the class leader and to the car ahead in the class.

A race by laps ends when the overall leader completes them, or at the time limit of the fastest class; a race by time at the leader's first crossing after the time. Everyone else, in every class, finishes at their next crossing, so slower classes run fewer laps; their fuel and strategy are planned for the laps they will actually get.

### Recording, telemetry and statistics

Besides timing, the simulation records per car and lap:

- a lap record: time, sectors, overall and class position, the race time at the line and the gap to the first car of the class to complete that lap, compound, tyre age and wear, fuel, whether the car stopped, its speed through the speed trap (timed over the last 20 m before the trap line), the driver, the track wetness and whether the lap was neutralised;
- a telemetry trace: the time since the start of the lap at every sample station (every 5 m, coarser on laps over 5 km so a lap keeps at most about 1000 samples; a Float32Array per lap);
- every pit stop: entry and exit times, time in the box (including waiting for a team-mate), tyres before and after, fuel, the driver who took over and the reason.

For the race it records every neutralisation (kind, start, end, reason), the yellow zones, and every half minute the rain, wetness, flag state and how many cars run on each tyre type.

`telemetry.ts` turns a trace into channels. Speed is racing-line distance over time between the neighbouring samples; longitudinal acceleration is the change in speed over two samples either side; lateral acceleration is v² times the line's curvature at the sample; the gear comes from the gearing; throttle and brake come from the force balance of the lap simulation (mass with the fuel on board, drag and downforce at the class's trim, rolling resistance, gradient). The throttle is the share of power needed; the brake is the share of the grip-limited braking force, with the grip the fitted tyres have at that lap's wetness. A complete lap ends with a sample at the line at the lap time, so a delta between two laps (the difference of their sample times) ends at the lap-time difference.

`stats.ts` reads the rankings and chart series from these records and the event log, for one class or class by class: fastest laps, best trap speeds (laps without a stop), overtakes made and lost (from 'overtake' events, so lapping and passing slower classes are not counted), pit stops, positions (overall or in the class) and gaps per lap, tyre stints (a new stint where the compound changes or the tyre age drops back to one lap), driver stints, and the neutralised periods as leader laps. `export.ts` writes results, laps, the feed and telemetry as RFC 4180 CSV.

### In the app

`RaceController` builds a model per class from the store's current track, analysis and facilities, plays the race back with requestAnimationFrame (simulated time = real time × speed up to 1000×, at most 12 ms of stepping per frame, positions interpolated between the last two steps), and skips to the end in 12 ms slices. It stops the race when the track or its analysis changes. A Formula 1 race runs to the end in about a quarter of a second, a six-hour race with 54 cars in three classes in about three seconds. Structural changes go out as the store's `race` topic; per-frame updates reach the map, the tower, the panel and the dock through `onTick`, and they refresh a few times a second. The controller also holds the class shown in a multi-class race, which the tower's tabs and the dock's class picker share.

The map draws the cars in team colours (ringed in their class colour in a multi-class race), the safety car on top of its queue, yellow zones along the track, a dashed yellow lap under a VSC or full course yellow, a wet sheen on the track as it gets wet, and rain over the map.

`RaceDock` replaces the profile strip during a race. The controller holds the telemetry selection (car, lap, comparison), which the dock's selectors and the telemetry export share; picking a car on the map or in the tower sets it and opens the Telemetry tab. The lap charts shade neutralised laps; Conditions plots rain, wetness, flags and the field's tyres against race time. The dock redraws only when the recorded data moves on (a lap completed, a stop, a new selection or class; every second for the lap in progress and the conditions) or on hover. Telemetry hover sets the store's hover station, so the map marks the spot; chart clicks select the car under the pointer.
