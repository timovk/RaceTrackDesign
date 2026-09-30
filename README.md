# RaceTrackDesign

Draw a race track on a seeded heightmap, analyse it, and (in later milestones) simulate races on it.

A browser app in TypeScript with no backend. The same seed and settings always produce the same landscape, and a project file reproduces a design exactly.

## Status

| Milestone | Contents | State |
|---|---|---|
| 1 | Terrain, drawing, metrics, elevation profile | **done** |
| 2 | Lap-time model, vehicle classes, calibration on real circuits, timed sectors | **done** |
| 3 | Start/finish, pit lane, other facilities, FIA grade estimate | next |
| 4 | Race core, moving dots, timing tower | planned |
| 5 | Telemetry, charts, statistics, export | planned |
| 6 | Multi-class, safety car, endurance, weather | planned |

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
```

`node scripts/calibrate.ts --write` refits the vehicle classes and rewrites `data/vehicles.json` and [docs/CALIBRATION.md](docs/CALIBRATION.md).

If PowerShell refuses to run `npm` scripts, call Vite directly: `node node_modules/vite/bin/vite.js`.

## Using it

The app works in three modes, in order. Everything downstream recalculates live when something upstream changes.

**1 Terrain.** Enter a seed (or press Random) and pick a landscape: flat, rolling, hilly or mountains. Fine-tune relief, hill size, roughness, warp, ridges, valley floors, erosion, water and base elevation. Maps are 4, 8 or 16 km square; generation runs in a background worker and takes about two seconds.

**2 Design.** Draw a closed loop.
- *Points*: click empty ground to add a point after the selected one; click the track to insert a point there; drag to move; right-click or Delete to remove.
- *Freehand*: drag to sketch a loop; it is simplified into editable points.
- Set the width per point or for new points, reverse the direction, and make any point the start.
- *Grading* evens out the ground profile over the smoothing length, but never digs in or raises the track more than the cut/fill limit.

**3 Analyse.**
- *Lap times* for ten classes: Formula 1, Formula 2, IndyCar, Hypercar, LMP2, GT3, GT4, TCR, MotoGP and Superbike. The table shows each class's flying lap, gap and top speed. Click a class for its three sector times, average and minimum speed, full-throttle share, braking zones, wing setting and vehicle data.
- *Geometry*: length, direction, height difference, climb, steepest gradients, longest straight, corners (numbered, with type, radius and angle), tightest crest and dip, width, cut and fill, and all design warnings.

Click any row to find it on the map.

The strip under the map has two views that share hover with the map: the elevation profile, and a speed trace with every class (the selected one on top). The map can colour the track by speed, gear or throttle and brake for the selected class, or by gradient, corner radius, elevation or cut and fill. **Line** shows the racing line, and yellow bars mark where sectors 2 and 3 start.

Warnings flag corners tighter than the track is wide, very tight corners, steep and too-steep gradients, crossings and overlaps, parts of the track too close together for barriers, water, and track off the map.

| Shortcut | Action |
|---|---|
| 1, 2, 3 | Terrain, Design, Analyse |
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
  "race": null
}
```

Coordinates are metres from the map's top-left corner, x east and y south. The heightmap is never stored; it is regenerated from the terrain settings. `overrides` (manual start/finish and pit lane) and `race` are reserved for milestones 3 and 4.

## Lap times

Each lap is a quasi-steady-state point-mass simulation on a minimum-curvature racing line, using the track's real elevation. The vehicle classes live in [data/vehicles.json](data/vehicles.json) and you can edit or add classes there.

The classes are calibrated against 27 real qualifying laps on flat, unchanged circuits from the [TUMFTM racetrack database](https://github.com/TUMFTM/racetrack-database) (in [data/circuits](data/circuits), LGPL-3.0). Every class is within about 2% RMS; the largest single miss is 4.5%. Details and limits are in [docs/CALIBRATION.md](docs/CALIBRATION.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works inside.
