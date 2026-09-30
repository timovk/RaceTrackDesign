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
| 6 | Multi-class, safety car, endurance, weather | next |

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

**4 Race.** Pick a class, the number of cars, the length (laps or time), the grid (qualifying order, reversed or random) and a race seed, then **Start race**. Each class starts with its usual race: 305 km for Formula 1, six hours for Hypercars, 120 km for MotoGP, and so on (**Class default** brings that back).
- The cars run as dots in their team colours, the leader ringed in yellow. The timing tower over the map shows position, places gained, gap (or interval, click the header), last and best lap, sector times in purple, green and yellow, tyres and stops; **Times** and **Less** switch the lap and sector columns.
- Play, pause (P) and play at 1× to 500×, or **Finish now** to simulate the rest at once. Click a car on the map or in the tower for its position, gaps, laps, tyres and wear, fuel, stops, next planned stop and speed; **Follow** keeps the map on it.
- The race feed lists overtakes, pit stops, fastest laps, trips off the track, contact and retirements; the result and the qualifying order follow at the end.
- Under the map, the analysis dock replaces the profile strip during a race (drag its top edge to resize):
  - *Telemetry*: speed, throttle and brake, gear, and lateral and longitudinal g over a lap, for any car and any lap (last, best, the lap in progress or a chosen one). Compare with the fastest lap of the race or another car's lap to see both traces and the time delta along the lap; hovering marks the spot on the map. Clicking a car on the map or in the tower opens its telemetry.
  - *Positions* (a lap chart), *Gaps* to the leader and *Lap times* per lap; click a line to pick a car.
  - *Stints*: every car's tyre sets, with pit stops and retirements.
  - *Statistics*: fastest laps, speed-trap ranking, overtakes made and lost, and pit stops by time in the box and in the lane.
- **Export** saves the results, every lap (times, sectors, position, gap, tyres, fuel, speed trap) and the telemetry shown as CSV files, and the map as a PNG image.
- Changing the track stops the race, since it no longer fits the layout.

Click any row to find it on the map. In Analyse, drag **Start**, **Pit in**, **Pit out** and **Speed** on the map to move them; **Automatic** puts them back.

The strip under the map has two views that share hover with the map: the elevation profile, and a speed trace with every class (the selected one on top). The map can colour the track by speed, gear or throttle and brake for the selected class, or by gradient, corner radius, elevation or cut and fill. **Line** shows the racing line, and yellow bars mark where sectors 2 and 3 start.

Warnings flag corners tighter than the track is wide, very tight corners, steep and too-steep gradients, crossings and overlaps, parts of the track too close together for barriers, water, and track off the map.

| Shortcut | Action |
|---|---|
| 1, 2, 3, 4 | Terrain, Design, Analyse, Race |
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
  "race": { "vehicleId": "f1", "cars": 20, "kind": "laps", "laps": 53, "minutes": 90, "grid": "qualifying", "seed": "785642" }
}
```

Coordinates are metres from the map's top-left corner, x east and y south. The heightmap is never stored; it is regenerated from the terrain settings. `overrides` holds hand-placed facilities as world positions (`startFinish`, `speedTrap`, and `pitLane` with entry, exit and side); anything absent is placed automatically. `race` is the race setup with its own seed (`kind` is `laps` or `time`, and `laps` or `minutes` applies accordingly); it is saved when a race is first started, so the file reproduces the race.

## Lap times

Each lap is a quasi-steady-state point-mass simulation on a minimum-curvature racing line, using the track's real elevation. The vehicle classes live in [data/vehicles.json](data/vehicles.json) and you can edit or add classes there.

The classes are calibrated against 27 real qualifying laps on flat, unchanged circuits from the [TUMFTM racetrack database](https://github.com/TUMFTM/racetrack-database) (in [data/circuits](data/circuits), LGPL-3.0). Every class is within about 2% RMS; the largest single miss is 4.6% (Formula 1 at Bahrain). Details and limits are in [docs/CALIBRATION.md](docs/CALIBRATION.md).

## Facilities and licence

The start/finish goes where the grid of 24 cars fits on a straight with a gradient of at most 2%, preferably 250 m before the first corner (FIA Appendix O 7.4, 7.7). Corners, sectors and lap timing count from it.

The pit lane (15 m wide) is placed beside any stretch of the lap, or across the infield, where the ground is flat, it is clear of the rest of the track and out of water, and its entry and exit keep off the racing line. The FIA prefers it beside the start straight, and that is scored in but not forced.

Marshal posts are at most 500 m apart and in sight of each other over the terrain (FIA Appendix H 2.4.2).

The licence estimate checks the layout against FIA Appendix O (2026) and the FIM Standards for Circuits (2024): length, width, straights, the grid and first corner, the pit lane, marshal posts, crests and run-off. Neither body gives a run-off formula, so the required depth follows the 30–100 m range of Appendix O 7.8, scaled by speed (and 1.3 times for bikes). Each corner's escape paths are traced across the terrain until they meet water, another part of the track or the map edge. A real licence also needs barriers, buildings, medical facilities and an inspection, so treat the grade as an estimate.

## Races

A race runs on the track exactly as analysed: every car drives the class's race lap from the lap-time model (without DRS), made slower or faster per metre by its own state. Car and driver pace differ per entry (drawn from the race seed, with a spread per class), and every lap adds the driver's scatter, tyre wear, the compound and the mass of fuel still on board. Close behind another car the model runs the lap again with less drag (slipstream) and less downforce (the wake), so a follower gains on the straights and loses in fast corners. F1 and F2 get DRS within a second at the detection point, from lap 3.

A car cannot drive through the one ahead. It passes at braking zones, with a chance that grows with the speed difference at the braking point, the pace difference, how good a place the braking zone is (the speed lost and the straight before it) and both drivers' racecraft; a failed attempt costs a little time and can end in contact. Lapped cars let the leaders by.

Stops happen in the real pit lane: braking for the entry, the speed limit, the team's box, the stationary time and pulling away. Classes without refuelling plan their stints before the start (the fastest split of the race into tyre stints that meets the two-compound rule and any mandatory stop), spread the stop by a lap or two, react to a rival's undercut and try one when stuck. Classes with refuelling stop when the fuel runs low and change tyres when the set would not last another stint. Fuel burn and tyre wear follow the track: each class's typical figures are scaled by the track's wheel energy and tyre work against the average of the real circuits. Mistakes, trips off, crashes and technical failures come from per-lap rates per class.

The race rules per class (grid, default length, tyres, fuel, stops, DRS, slipstream, incident rates) live in [data/racing.json](data/racing.json); a class missing there gets generic defaults. The figures are approximate and meant to be edited.

Telemetry is recorded as the moment each car passes a sample point every 5 m or so (coarser on very long laps, so a lap has at most about a thousand points). Speed follows from distance over time, g-forces from the change in speed and the racing line's curvature, gear from the gearing, and throttle and brake from the force the change in speed needs against drag, rolling resistance and gradient, as in the lap-time model. So the pedal traces are the model's estimate, not recorded inputs, and a lap run through the pit lane shows the lane mapped onto the stretch of track it bypasses.

Limits: no safety car, yellow flags or driver changes (milestone 6) and one class per race. Overtaking is only roughly tuned: in trials on the real circuits, Formula 1 races saw from under ten passes after lap 1 (Suzuka, Budapest) to about eighty (Monza, Bahrain), with Spa and Silverstone lower and Zandvoort (whose banking is not modelled) higher than in reality.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works inside.
