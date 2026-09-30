# RaceTrackDesign

Draw a race track on a seeded heightmap, analyse it, and (in later milestones) simulate races on it.

A browser app in TypeScript with no backend. The same seed and settings always produce the same landscape, and a project file reproduces a design exactly.

## Status

| Milestone | Contents | State |
|---|---|---|
| 1 | Terrain, drawing, metrics, elevation profile | **done** |
| 2 | Lap-time model, vehicle classes, calibration on real circuits, timed sectors | next |
| 3 | Start/finish, pit lane, other facilities, FIA grade estimate | planned |
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
```

If PowerShell refuses to run `npm` scripts, call Vite directly: `node node_modules/vite/bin/vite.js`.

## Using it

The app works in three modes, in order. Everything downstream recalculates live when something upstream changes.

**1 Terrain.** Enter a seed (or press Random) and pick a landscape: flat, rolling, hilly or mountains. Fine-tune relief, hill size, roughness, warp, ridges, valley floors, erosion, water and base elevation. Maps are 4, 8 or 16 km square; generation runs in a background worker and takes about two seconds.

**2 Design.** Draw a closed loop.
- *Points*: click empty ground to add a point after the selected one; click the track to insert a point there; drag to move; right-click or Delete to remove.
- *Freehand*: drag to sketch a loop; it is simplified into editable points.
- Set the width per point or for new points, reverse the direction, and make any point the start.
- *Grading* evens out the ground profile over the smoothing length, but never digs in or raises the track more than the cut/fill limit.

**3 Analyse.** Length, direction, height difference, climb, steepest gradients, longest straight, corners (numbered, with type, radius and angle), tightest crest and dip, width, cut and fill, and all design warnings. Click any row to find it on the map.

The elevation profile under the map shares hover with the map. The map can colour the track by gradient, corner radius, elevation or cut and fill.

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

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works inside.
