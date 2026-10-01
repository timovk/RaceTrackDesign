# RaceTrackDesign

Draw a race track on a seeded heightmap, analyse it, and race on it.

A browser app in TypeScript with no backend. The same seed and settings always produce the same landscape and the same race, and a project file reproduces both exactly.

## Status

| Milestone | Contents | State |
|---|---|---|
| 1 | Terrain, drawing, metrics, elevation profile | **done** |
| 2 | Lap-time model, vehicle classes, calibration on real circuits, timed sectors | **done** |
| 3 | Start/finish, pit lane, other facilities, FIA grade estimate | **done** |
| 4 | Race core, moving dots, timing tower | **done** |
| 5 | Telemetry, charts, statistics, export | **done** |
| 6 | Multi-class, safety car, endurance, weather | **done** |
| 7a | 3D view: terrain with the track's earthworks, track and pit lane, orbit camera | **done** |
| 7b | 3D dressing (kerbs, run-off, buildings, trees), camera shots, image export | **done** |
| 8a | The race in 3D: detailed cars for every class, liveries, shadows | **done** |
| 8b | Broadcast look: trackside and helicopter cameras, a director, on-screen graphics | **done** |
| 9 | Rain and flag visuals in 3D | next |

## Running it

Requires Node 22.18 or newer (the benchmark script runs TypeScript directly).

```bash
npm install
npm run dev
```

Then open http://localhost:5183. Other scripts:

```bash
npm test            # unit tests (Vitest)
npm run typecheck   # TypeScript, no emit
npm run build       # production bundle in dist/
node scripts/bench-terrain.ts   # time terrain generation per preset
node scripts/calibrate.ts       # compare the lap-time model with real qualifying laps
node scripts/raceReference.ts   # per-class energy and tyre work on the real circuits (reference values in data/racing.json)
```

`node scripts/calibrate.ts --write` refits the vehicle classes and rewrites `data/vehicles.json` and [docs/CALIBRATION.md](docs/CALIBRATION.md).

If PowerShell refuses to run `npm` scripts, call Vite directly: `node node_modules/vite/bin/vite.js`.

## Using it

The app works in four modes, in order. Everything downstream recalculates live when something upstream changes.

**1 Terrain.** Enter a seed (or press Random) and pick a landscape: flat, rolling, hilly or mountains. Fine-tune relief, hill size, roughness, warp, ridges, valley floors, erosion, water and base elevation. Maps are 4, 8 or 16 km square; generation runs in a background worker and takes about two seconds.

**2 Design.** Draw a closed loop.
- *Points*: click empty ground to add a point after the selected one; click the track to insert a point there; drag to move; right-click or Delete to remove.
- *Freehand*: drag to sketch a loop; it is simplified into editable points.
- Set the width per point or for new points, reverse the direction, and put the start/finish at a selected point.
- *Grading* evens out the ground profile over the smoothing length, but never digs in or raises the track more than the cut/fill limit.

**3 Analyse.**
- *Lap times* for ten classes: Formula 1, Formula 2, IndyCar, Hypercar, LMP2, GT3, GT4, TCR, MotoGP and Superbike. The table shows each class's flying lap, gap and top speed. Click a class for its three sector times, average and minimum speed, full-throttle share, braking zones, wing setting and vehicle data.
- *Circuit licence*: an estimated FIA grade (1 to 4, cars) and FIM grade (A or B, bikes), with the checklist behind it, which classes may race, run-off escape paths per grade on the map, and the largest permitted grid.
- *Facilities*: start/finish, pit lane with the drive-through time loss per class, speed trap, DRS zones, overtaking spots and marshal posts.
- *Geometry*: length, direction, height difference, climb, steepest gradients, longest straight, corners (numbered, with type, radius and angle), tightest crest and dip, width, cut and fill, and all design warnings.

**4 Race.** Pick one or more classes and their number of cars (up to four classes and 60 cars), the length (laps or time), the grid (qualifying order, reversed or random), the weather (dry, changeable or wet) and a race seed, then **Start race**. A single class starts with its usual race: 305 km for Formula 1, six hours for Hypercars, 120 km for MotoGP, and so on (**Class default** brings that back). **WEC-style event** sets up Hypercars, LMP2 and GT3 together for six hours.
- The cars run as dots in their team colours, the leader ringed in yellow; in a multi-class race each dot is ringed in its class colour. The safety car leads its queue as an orange box, yellow flags show along the track, a virtual safety car or full course yellow as a dashed yellow lap, and rain as a tint over the map with the track turning glossy as it gets wet.
- The timing tower over the map shows position, places gained, gap (or interval, click the header), last and best lap, sector times in purple, green and yellow, tyres and stops; **Times** and **Less** switch the lap and sector columns. A banner shows the flags and the header the rain and track wetness. In a multi-class race every row has its class and position in class, gaps are within the class, and the tabs show all classes or one. Endurance cars show their number and the driver at the wheel.
- Play, pause (P) and play at 1× to 1000×, or **Finish now** to simulate the rest at once. Click a car on the map or in the tower for its position, gaps, laps, tyres and wear, fuel, the crew and each driver's time at the wheel, stops, next planned stop and speed; **Follow** keeps the map on it.
- The race feed lists overtakes, pit stops (with driver changes), fastest laps, trips off the track, contact, retirements, the flags and the weather; the result (per class in a multi-class race) and the qualifying order follow at the end.
- Under the map, the analysis dock replaces the profile strip during a race (drag its top edge to resize). In a multi-class race the class picker narrows every tab to one class.
  - *Telemetry*: speed, throttle and brake, gear, and lateral and longitudinal g over a lap, for any car and any lap (last, best, the lap in progress or a chosen one). Compare with the fastest lap of the race or another car's lap to see both traces and the time delta along the lap; hovering marks the spot on the map. Clicking a car on the map or in the tower opens its telemetry.
  - *Positions* (a lap chart), *Gaps* to the (class) leader and *Lap times* per lap, with laps under a safety car or VSC shaded; click a line to pick a car.
  - *Stints*: every car's tyre sets, with pit stops and retirements, and for crews who drove when.
  - *Conditions*: rain and track wetness over the race, the flag periods, and how many cars run on slicks, intermediates and wets.
  - *Statistics*: fastest laps, speed-trap ranking, overtakes made and lost, and pit stops by time in the box and in the lane.
- **Export** saves the results, every lap (times, sectors, position, gap, tyres, fuel, speed trap, driver, wetness), the race feed and the telemetry shown as CSV files, and the map as a PNG image.
- Changing the track stops the race, since it no longer fits the layout.

Click any row to find it on the map. In Analyse, drag **Start**, **Pit in**, **Pit out** and **Speed** on the map to move them; **Automatic** puts them back.

The strip under the map has two views that share hover with the map: the elevation profile, and a speed trace with every class (the selected one on top). The map can colour the track by speed, gear or throttle and brake for the selected class, or by gradient, corner radius, elevation or cut and fill. **Line** shows the racing line, and yellow bars mark where sectors 2 and 3 start.

Warnings flag corners tighter than the track is wide, very tight corners, steep and too-steep gradients, crossings and overlaps, parts of the track too close together for barriers, water, and track off the map.

**3D view.** The **2D / 3D** switch under the map toolbar (or V) shows the map as a model: the terrain with the earthworks the track needs (grass embankments where it is built up, bare-earth cuttings where it is dug in), the track with its edge lines, verges and start line, the pit lane, water, and the sides of the map, under a sky. The circuit is dressed from its analysis: kerbs where the racing line runs to the edge in a corner, run-off outside each corner as deep as its escape paths allow (asphalt then gravel at fast corners, gravel elsewhere), the pit building with a garage per box, grandstands on the start straight and at the best overtaking spots, grid boxes, and woods that keep clear of all of it.
- Drag to orbit, right-drag to pan, scroll to zoom towards the cursor, double-click to centre on a spot, F to see the whole track again.
- **Height** draws the hills and dips up to three times as tall, so the elevation changes show; it starts at ×3 (×1 is true scale). Buildings, kerbs, trees and the camera's height over the ground keep their real size, and every figure (gradients, lap times, checks) uses the real heights.
- **Shots** moves the camera to the overview, the start and grid, the pit lane, each numbered corner (from a camera tower beyond its run-off), the steepest climb and drop (from their foot, looking up) and the highest point. A view that a hill would block is raised until it sees over it.
- **Flyover** follows the track as a drone; **Hot lap** rides the racing line at the pace of the class picked in Analyse, at the driver's eye height. Pause, play at ×0.5 to ×4, or **Stop** to look around from where the camera is; dragging the view stops it too.
- **Save image** saves the view as a PNG at the screen size, twice it, or 4K (3840 × 2160), with the labels drawn in.
- The track colouring, **Contours**, **Labels** (corner numbers and the start) and **Line** (the racing line) work in 3D too. Hovering the track marks it on the elevation profile, and hovering the profile marks the spot in 3D; the readout shows the position and height under the cursor.
- Editing happens in 2D. In Race mode **Map image** saves the 3D view.
- The 3D view (three.js) loads the first time it is opened. It needs WebGL.

**The race in 3D.** In Race mode the 3D view shows the race: every car as a model of its class (Formula 1, Formula 2 and IndyCar single-seaters, Hypercar and LMP2 prototypes, GT3, GT4 and TCR cars, MotoGP and Superbike bikes with their riders, and the safety car), at its real size and in its team's livery, where the race puts it.
- Liveries come from each team's colour: a second colour, an accent and one of five patterns, the same for both cars of a team. Single-seaters carry their number on the nose and the engine cover, closed cars in a roundel on the doors and the bonnet (in the class colour in a multi-class race), bikes on the fairing and the tail; team names are on the rear wing endplates.
- Wheels turn and steer, the tyre sidewalls show the compound fitted, bikes lean into corners, and the DRS flap opens in the DRS zones. Cars stop in their box in the pit lane, and a retired car stays where it stopped.
- Cars that would overlap (at the start, while passing, when lapping) are drawn side by side; the race itself is unchanged.
- Click a car to select it, as in the timing tower; with **Follow** on, the camera keeps the selected car in view. The driver codes and positions show over the cars nearest the camera.
- Cars cast shadows in the sun around what the camera looks at, and keep their size whatever the **Height**.

**TV.** In Race mode the **TV** button in the 3D toolbar shows the race as a broadcast, with a director choosing what to show and from where.
- Cameras stand where a circuit puts them: a tower beyond the run-off at every corner, one behind the grid, one over the pit lane, one beside every long straight, and more wherever the track would otherwise be out of sight. Each pans and zooms with its car through a long lens; the helicopter hangs high off to one side, circles slowly and climbs when a hill gets in the way.
- Each shot holds five to twelve seconds, then cuts. Close battles come first, then incidents, overtakes, the leaders, pit stops and the rest of the field; a car you pick (in the tower or by clicking it) is shown most, with its battle when it is in one. A shot ends early when its car leaves the camera's sight.
- A caption names the car or the battle when the camera picks it up: position, driver, number, team, gap and tyre. Overtakes and pit stops among the first ten, fastest laps, incidents and retirements pop up as they happen, and so do the sector and lap times of the car on screen (purple for the best of all, green for its own best).
- Shots last as long at any playback speed. At high speeds the cars go by a trackside camera too fast to hold, so the helicopter takes over; at 1× you get the whole broadcast.
- Drag the view or press **Stop** to take the camera back. **Save image** saves the broadcast frame.

The 3D view has a film-like picture (ACES tone mapping), as on television.

| Shortcut | Action |
|---|---|
| 1, 2, 3, 4 | Terrain, Design, Analyse, Race |
| V | Switch between the flat map and the 3D view |
| P | Play or pause the race |
| Scroll | Zoom |
| Right-drag, Space + drag | Pan |
| F | Fit map |
| Delete | Remove the selected point |
| Esc | Clear selection and highlight |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+S | Save project file |

The current project autosaves in the browser. **Save** downloads a `.rtd.json` project file and **Open** loads one.

## Project file

```json
{
  "version": 1,
  "name": "Untitled circuit",
  "terrain": { "seed": "482913", "preset": "rolling", "mapSize": 8192, "resolution": 2048, "relief": 75, "...": "..." },
  "track": { "points": [{ "x": 3100.5, "y": 2890.2, "width": 12 }], "defaultWidth": 12, "grading": { "smoothing": 60, "maxCutFill": 12 } },
  "overrides": {},
  "race": {
    "classes": [{ "vehicleId": "hypercar", "cars": 18 }, { "vehicleId": "gt3", "cars": 22 }],
    "kind": "time", "laps": 125, "minutes": 360, "grid": "qualifying", "weather": "changeable", "seed": "785642"
  }
}
```

Coordinates are metres from the map's top-left corner, x east and y south. The heightmap is never stored; it is regenerated from the terrain settings. `overrides` holds hand-placed facilities as world positions (`startFinish`, `speedTrap`, and `pitLane` with entry, exit and side); anything absent is placed automatically. `race` is the race setup with its own seed: the classes and their cars, `kind` (`laps` or `time`, and `laps` or `minutes` applies accordingly), the grid order and the `weather` (`dry`, `changeable` or `wet`). It is saved when a race is first started, so the file reproduces the race, weather included. Files from earlier versions, with a single `vehicleId` and `cars`, still open.

## Lap times

Each lap is a quasi-steady-state point-mass simulation on a minimum-curvature racing line, using the track's real elevation. The vehicle classes live in [data/vehicles.json](data/vehicles.json) and you can edit or add classes there.

The classes are calibrated against 27 real qualifying laps on flat, unchanged circuits from the [TUMFTM racetrack database](https://github.com/TUMFTM/racetrack-database) (in [data/circuits](data/circuits), LGPL-3.0). Every class is within about 2% RMS; the largest single miss is 4.6% (Formula 1 at Bahrain). Details and limits are in [docs/CALIBRATION.md](docs/CALIBRATION.md).

## Facilities and licence

The start/finish goes where the grid of 24 cars fits on a straight with a gradient of at most 2%, preferably 250 m before the first corner (FIA Appendix O 7.4, 7.7). Corners, sectors and lap timing count from it.

The pit lane (15 m wide) is placed beside any stretch of the lap, or across the infield, where the ground is flat, it is clear of the rest of the track and out of water, and its entry and exit keep off the racing line. The FIA prefers it beside the start straight, and that is scored in but not forced.

Marshal posts are at most 500 m apart, in sight of each other, and between them see all the track (FIA Appendix H 2.4.2). Sight lines run over the ground as built: a track graded into a hillside is seen along its cutting, and banks and hills in between block the view. At a sharp crest a post may stand right behind the verge or on a raised platform, as at real circuits; the licence checklist says how many are raised.

The licence estimate checks the layout against FIA Appendix O (2026) and the FIM Standards for Circuits (2024): length, width, straights, the grid and first corner, the pit lane, marshal posts, crests and run-off. Neither body gives a run-off formula, so the required depth follows the 30–100 m range of Appendix O 7.8, scaled by speed (and 1.3 times for bikes). Each corner's escape paths are traced across the terrain until they meet water, another part of the track or the map edge. A real licence also needs barriers, buildings, medical facilities and an inspection, so treat the grade as an estimate.

## Races

A race runs on the track exactly as analysed: every car drives the class's race lap from the lap-time model (without DRS), made slower or faster per metre by its own state. Car and driver pace differ per entry (drawn from the race seed, with a spread per class), and every lap adds the driver's scatter, tyre wear, the compound and the mass of fuel still on board. Close behind another car the model runs the lap again with less drag (slipstream) and less downforce (the wake), so a follower gains on the straights and loses in fast corners. F1 and F2 get DRS within a second at the detection point, from lap 3.

A car cannot drive through the one ahead. It passes at braking zones, with a chance that grows with the speed difference at the braking point, the pace difference, how good a place the braking zone is (the speed lost and the straight before it) and both drivers' racecraft; a failed attempt costs a little time and can end in contact. Lapped cars let the leaders by.

Stops happen in the real pit lane: braking for the entry, the speed limit, the team's box, the stationary time and pulling away. Classes without refuelling plan their stints before the start (the fastest split of the race into tyre stints that meets the two-compound rule and any mandatory stop), spread the stop by a lap or two, react to a rival's undercut and try one when stuck. Classes with refuelling stop when the fuel runs low and change tyres when the set would not last another stint. Fuel burn and tyre wear follow the track: each class's typical figures are scaled by the track's wheel energy and tyre work against the average of the real circuits. Mistakes, trips off, crashes and technical failures come from per-lap rates per class.

The race rules per class (grid, crews, default length and start, tyres, fuel, stops, driver changes, DRS, slipstream, incident rates, flags) live in [data/racing.json](data/racing.json); a class missing there gets generic defaults. The figures are approximate and meant to be edited.

Several classes can race together, as at Le Mans. Each runs its own race lap, strategy and rules; the fastest class starts in front and its rules set the start, the flags and the time limit. Faster classes come up behind slower ones and get by at the next braking zone, losing a little time in the traffic; positions, gaps, fastest laps and sector colours count within the class, and passes of slower classes are not overtakes. When the flag falls for the overall leader, every car finishes at its next crossing, so slower classes run fewer laps, and they fuel and plan for those.

Endurance cars (Hypercar, LMP2, GT3 and GT4) have crews of two or three drivers with their own pace, consistency and error rate. A driver hands over at a stop before passing the class's longest stint, to the team-mate who has driven least; the change happens while refuelling. These classes take a rolling start, as does IndyCar.

Race control waves yellow flags where a car went off or stopped: no passing there, and a little slower through it. A crash or a car stopped on track may bring out the safety car, a virtual safety car (Formula 1 and 2: everyone a set share slower) or a full course yellow (endurance classes: 80 km/h everywhere), by the rules of the fastest class; bikes only get yellows. The safety car collects the field into a queue, comes in after the clean-up and at least a lap in front, and racing resumes at the line. Teams take the cheap pit stop a neutralisation offers when they have to stop anyway. In trials on the real circuits, the safety car came out in 15% (Bahrain) to 50% (Silverstone) of Formula 1 races and a VSC in about a quarter; six-hour WEC races at Spa averaged just over one safety car and two to three full course yellows.

Weather comes from the race seed: dry, changeable (one or more showers, more in a long race) or wet (raining from the start, stopping and drying out in most races). The track gets wet within minutes of the rain and dries over about twenty. On a wet track every class loses grip, much more on slicks, which also aquaplane and crash far more easily; intermediates (Formula 1 only) suit a damp track and full wets a very wet one, and both wear out fast when it dries. Teams watch the rain on the radar and change tyres when the time it gains outweighs the stop; classes that never stop (MotoGP, Superbike, TCR) come in only for the weather. A race that starts wet starts on wet-weather tyres, DRS stays shut on a wet track, and the two-compound rule no longer applies once wet tyres are used.

Telemetry is recorded as the moment each car passes a sample point every 5 m or so (coarser on very long laps, so a lap has at most about a thousand points). Speed follows from distance over time, g-forces from the change in speed and the racing line's curvature, gear from the gearing, and throttle and brake from the force the change in speed needs against drag, rolling resistance and gradient, as in the lap-time model (with the grip the tyres have on a wet track). So the pedal traces are the model's estimate, not recorded inputs, and a lap run through the pit lane shows the lane mapped onto the stretch of track it bypasses.

Limits: no red flags, no track evolution or drying line, one weather for the whole circuit, and no rule on each endurance driver's minimum time at the wheel. Lapped cars are not waved past the safety car. The class paces come from the lap-time calibration, so on some circuits the gaps between classes are smaller than in reality (LMP2 and GT3 run close at Spa, for example). Overtaking is only roughly tuned: in trials on the real circuits, Formula 1 races saw from under ten passes after lap 1 (Suzuka, Budapest) to about a hundred (Monza, Bahrain), with Spa and Silverstone lower and Zandvoort (whose banking is not modelled) higher than in reality.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works inside.
