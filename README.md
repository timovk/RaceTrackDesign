# RaceTrackDesign

Draw a race track on a seeded heightmap, analyse it, and race on it. Or open a real circuit from the templates, on its real ground.

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
| 9 | Rain and flags in 3D: weather, wet track, spray, lights, marshals and their flags | **done** |
| 10 | Several layouts on one circuit: links, shared start line and pit lane, each layout's own lap times, licence and races | **done** |
| 14 | Race weekend: practice and qualifying sessions to each series' real format, track evolution, tyre knowledge, red flags | **done** |
| 16a | Broadcast extras: onboard and chase cameras, the pit box camera with the stop timer, the grid walk and the start | **done** |
| 16b | Broadcast extras: action replays, start lights, circuit map, gap graphic, final lap, chequered flag and results | **done** |
| G1 | Graphics, phase 1: a photographed sky lighting the scene, shadows across the whole view, physically based materials, ambient occlusion, depth of field, bloom and a grade | **done** |
| G2 | Graphics, phase 2: photographed textures on the ground, track, verges and run-off, a rubbered racing line, rippled water, reflections of the sky on every surface | **done** |
| G3 | Graphics, phase 3: card trees with leaves and needles in two levels of detail, guardrail, tyre walls and catch fencing round the track | **done** |
| T1 | Templates: real circuits to open and change, on surveyed ground with its real woods; the first is Bremgarten 1954 | **done** |
| S1 | Side-by-side racing, step 1: cars have a place across the road and a width, pass where there is room, out-brake each other and defend the inside | **done** |
| S2 | Side-by-side racing, step 2: the start and the first lap on the same rules, the grid fanning out and funnelling two abreast into the first corners | **done** |
| S3 | Side-by-side racing, step 3: contact and mistakes where the cars are: running wide, trips off the road and spins, contact between cars side by side, damage and repairs | **done** |
| TW | Timing tower, TV captions and a qualifying lap timer in the look of Formula 1's broadcast graphics of 2010 to 2014 | **done** |
| S4 | Side-by-side racing, step 4: the stewards: who is to blame for a contact, and each series' own penalties, served in the race or added to the race time | **done** |
| S5 | Side-by-side racing, step 5: restarts and the safety car queue (the leader holds the field up and picks its moment, lapped cars are sent round, a standing restart goes as the start does), and a TV director that shows it | **done** |
| TS | Trackside: advertising boards and gantries, a crowd in the grandstands, a pit building with numbered garages, a race control tower and a podium, and tyre marks on the asphalt | **done** |
| H1 | Historic content, version 1: the Formula 1 car of 1950 as a class of its own, shaped and paced as the Alfa Romeo 158; and the Monaco Grand Prix lap of 1950 as a template on its real ground | **done** |
| G4 | Graphics, phase 4: the cars. A finer model for close-ups with the shut lines between the panels; vents, louvres, pillars, exhausts and brake discs; woven carbon, tyre rubber and glass; shading baked into the crevices; each car's own shadow on the road; damage that shows | **done** |

What comes next, and what was proposed and never decided, is in [docs/ROADMAP.md](docs/ROADMAP.md).

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
node scripts/raceTrial.ts f1 2  # overtakes, contact, trouble and penalties per race on the real circuits, which passing and contact are tuned on (class, races per circuit, circuits)
```

`node scripts/calibrate.ts --write` refits the vehicle classes and rewrites `data/vehicles.json` and [docs/CALIBRATION.md](docs/CALIBRATION.md).

If PowerShell refuses to run `npm` scripts, call Vite directly: `node node_modules/vite/bin/vite.js`.

## Using it

The app works in four modes, in order. Everything downstream recalculates live when something upstream changes.

**Templates** (in the header) lists the circuits that come with the app. Picking one opens it as a project like any other: move its points, add a layout, race on it, save it under another name. They are [Bremgarten 1954](#bremgarten-1954) and [Monaco 1950](#monaco-1950).

**1 Terrain.** Enter a seed (or press Random) and pick a landscape: flat, rolling, hilly or mountains. Fine-tune relief, hill size, roughness, warp, ridges, valley floors, erosion, water and base elevation. Maps are 4, 8 or 16 km square; generation runs in a background worker and takes about two seconds. A template of a real circuit stands on *surveyed ground* instead: real elevations and woods, with no seed and nothing to tune. The panel then says where the ground comes from, and **Use a generated landscape instead** puts the same track on a generated one.

**2 Design.** Draw a closed loop.
- *Points*: click empty ground to add a point after the selected one; click the track to insert a point there; drag to move; right-click or Delete to remove.
- *Freehand*: drag to sketch a loop; it is simplified into editable points.
- Set the width per point or for new points, reverse the direction, and put the start/finish at a selected point.
- *Grading* evens out the ground profile over the smoothing length, but never digs in or raises the track more than the cut/fill limit.
- *Layouts*: a circuit can have several layouts, as Silverstone and Brands Hatch do. **Add layout**, click the track where a link leaves it, click the ground to lead it across, and click the track again where it joins: the new layout runs round the circuit to the link, along it, and on from where it joins, skipping the stretch in between (a link across the infield makes a short layout, a loop out into the country a long one). **Add link** gives a layout another one. Drag a link's points (squares) to reshape it, and its ends along the track; right-click or Delete removes a point. A link leaves and joins the track along its direction of travel, and is graded over the ground to meet the track's height at both ends. Every layout keeps the start/finish line and shares the pit lane; the list shows each layout's length and lap time, or why it cannot be built (a link off the track, links that overlap, the start line skipped). A link that crosses the circuit on the level gets a warning.
- Pick the layout to analyse and race with **Layout** above the map (or in the list). Lap times, the licence, the facilities, races and the 3D view follow it, with the rest of the circuit greyed out round it (in 3D built as roads, the ground shaped for all of them, run-off stopping where another road carries on). Each layout keeps its own race setup. Design always shows the full circuit; a race on a layout keeps running while you look at it.

**3 Analyse.**
- *Lap times* for eleven classes: Formula 1, Formula 2, IndyCar, Hypercar, LMP2, GT3, GT4, TCR, the [Formula 1 of 1950](#the-formula-1-of-1950), MotoGP and Superbike. The table shows each class's flying lap, gap and top speed. Click a class for its three sector times, average and minimum speed, full-throttle share, braking zones, wing setting and vehicle data.
- *Circuit licence*: an estimated FIA grade (1 to 4, cars) and FIM grade (A or B, bikes), with the checklist behind it, which classes may race, run-off escape paths per grade on the map, and the largest permitted grid.
- *Facilities*: start/finish, pit lane with the drive-through time loss per class, speed trap, DRS zones, overtaking spots and marshal posts.
- *Geometry*: length, direction, height difference, climb, steepest gradients, longest straight, corners (numbered, with type, radius and angle), tightest crest and dip, width, cut and fill, and all design warnings.

**4 Race.** Pick one or more classes and their number of cars (up to four classes and 60 cars), the length (laps or time), the sessions of the weekend to run, the grid (qualifying order, reversed or random), the weather (dry, changeable or wet) and a race seed, then **Start weekend** (or **Start race** with every session left out). A single class starts with its usual race: 305 km for Formula 1, six hours for Hypercars, 120 km for MotoGP, and so on (**Class default** brings that back). **WEC-style event** sets up Hypercars, LMP2 and GT3 together for six hours.
- The weekend runs the series' own schedule: Formula 1's FP1, FP2 and FP3 and its Q1, Q2 and Q3, MotoGP's FP1, Practice and FP2 and its Q1 and Q2, and so on. Each session plays like the race (map, tower, 3D, TV); **Finish now** simulates the rest of it, **Next** moves on to the next session and **Skip to race** simulates everything left at once. The panel lists the sessions with the fastest of each, and the classification of the session on now (in qualifying with the cut line).
- The cars run as dots in their team colours, the leader ringed in yellow; in a multi-class race each dot is ringed in its class colour. The safety car leads its queue as an orange box, yellow flags show along the track, a virtual safety car or full course yellow as a dashed yellow lap, and rain as a tint over the map with the track turning glossy as it gets wet.
- Cars race side by side. Each has its place across the road and its real width, is held up only by a car in its way, and pulls out to pass where it has the pace and the room, on the map and in 3D. Off the racing line costs time through a corner, so the inside for the next one is the place to be: a car close enough there can brake later and take it, and the car ahead may move over once to shut it, which leaves the outside. Narrow tracks and fast bends are hard to pass on, a hairpin after a long straight is not. A car being lapped by one of its own class moves aside; a slower class holds its line and the faster cars find their own way by. Bikes still race in one line.
- The start follows from the same rules. The field leaves the grid in its two files, better starters pull out and go round slower ones where the road is wide enough, and into the first corner it funnels by the room there is: a corner takes two abreast, a third car drops in behind, and nobody moves over in front of another without a hole to move into. The cars off the racing line slot in as the field strings out, most of them within the first lap.
- Things go wrong where the cars are. A driver who gets a corner wrong runs wide of the line, leaves the road and comes back when there is a gap, or spins, stands on the verge and turns the car round; it happens more often with a rival right behind. Two cars side by side through a corner now and then touch, and the speed and how far alongside they are decide what comes of it: a touch that costs time, a spin, a car forced off the road, a broken nose or a puncture that sends it to the pits (the tower shows DMG until it is repaired), or a car out of the race where it comes to rest. Yellow flags, safety cars and red flags follow from it.
- Behind the safety car the field closes up into one queue before the safety car comes in. Cars caught between it and the leader are waved by, and where the series does that, lapped cars are sent past the queue to get their lap back (Formula 1 and Formula 2: every lapped car; the WEC and the ELMS: every car ahead of its class leader on the road). For the restart the leader slows the field once the safety car's lights are out, picks its moment over the last few hundred metres and goes; every driver behind follows a moment later, and nobody passes before the line (in IndyCar the leader keeps its pace up to a restart zone). A standing restart after a red flag goes as the start does: the field fans out off the grid and funnels into the first corner.
- The stewards look at every contact that cost a car something. They say so within a minute (the tower shows INV after the two cars' rows) and decide a few minutes later: no further action, or a penalty for the car that was to blame, by the rules of its series. Formula 1 and Formula 2 give 10 seconds (5 in mitigating circumstances), stood still at the car's next pit stop before the work begins, or added to its race time when it makes none. IndyCar, the WEC, the ELMS, GT World Challenge and GT4 give a drive-through, which the car serves under green within a lap or two. TCR adds 5 seconds to the race time, as a rule after the race. The tower shows a penalty after the car's row until it is served (+10, DT), the TV broadcast has a message for every investigation and decision, and time added can change the result after the flag: the classification and the gaps are with it.
- The timing tower on the left of the map has the look of Formula 1's broadcast graphics of 2010 to 2014: slanted dark bars, the position in a box of its own (red for the leader), the driver's three letters, the gap (or the interval, click the header), and the tyre with its age and the number of stops at the end of each row. The lap counter is in the top middle of the map ("Lap 16 / 56", with the time left in a race by time) and follows the flags: black as a rule, yellow under a yellow flag, a safety car, a virtual safety car or a full course yellow, red under a red flag. Where the window is too narrow for it between the figures and the toolbars along the top, it sits under them. **Times** and **Less** add or take away places gained, the last and best lap and the sector times in purple, green and yellow. A banner shows the flags and the head the rain and track wetness; a chequered flag marks a car that has finished. In a multi-class race every row has its class and position in class, gaps are within the class, and the tabs show all classes or one. Endurance cars show their number and the driver at the wheel. In a session the counter shows the session and its clock ("Q2 4:31"), the tower is ordered by best lap and shows the lap times themselves (or the gaps, click the header), a red arrow marks a car on a flying lap, the last column shows what the others are doing (in the garage, out lap, in lap, cooling down, a long run), and in qualifying the cars that would go out have their position in a white box with a red number. The typeface is Titillium Web (SIL Open Font License, in `public/fonts` with its licence); the layout and style are taken from the broadcasts, the Formula 1 and sponsor logos are not.
- Play, pause (P) and play at 1× to 1000×, or **Finish now** to simulate the rest at once. Click a car on the map or in the tower for its position, gaps, laps, tyres and wear, fuel, the crew and each driver's time at the wheel, stops, next planned stop and speed; **Follow** keeps the map on it.
- The race feed lists overtakes, pit stops (with driver changes), fastest laps, trips off the track, contact, the stewards' investigations and penalties, retirements, the flags and the weather; the result (per class in a multi-class race) and the qualifying order follow at the end.
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

**3D view.** The **2D / 3D** switch under the map toolbar (or V) shows the map as a model: the terrain with the earthworks the track needs (grass embankments where it is built up, bare-earth cuttings where it is dug in), the track with its edge lines, verges and start line, the pit lane, water, and the sides of the map, under a photographed sky. The circuit is dressed from its analysis: kerbs where the racing line runs to the edge in a corner, run-off outside each corner as deep as its escape paths allow (asphalt then gravel at fast corners, gravel elsewhere), stopping where a hillside gets steeper than 25% or a cutting is deep (a real circuit would grade it there; the licence checklist says where), the pit building with a numbered garage per box under a glazed upper floor, a race control tower and a podium at the end nearer the line and the teams' timing stands on the pit wall, grandstands on the start straight and at the best overtaking spots with a crowd in them, grid boxes, marshal posts behind the run-off (on a platform where the licence check raised them) with a light panel each and the flag marshal's rostrum at the line, steel guardrail along both sides (behind the run-off at the corners, with a tyre wall at the back of each gravel trap, and catch fencing along the grandstands and by the line), advertising boards in front of the rail along the start straight and round the outside of the corners, a gantry with the start lights over the line and a bridge over the longer straights, rubber worn into the asphalt where the lap brakes hardest, and woods that keep clear of all of it. The signs carry words from racing, not real companies.
- Drag to orbit, right-drag to pan, scroll to zoom towards the cursor, double-click to centre on a spot, F to see the whole track again.
- **Height** draws the hills and dips up to three times as tall, so the elevation changes show; it starts at ×3 (×1 is true scale). Buildings, kerbs, trees and the camera's height over the ground keep their real size, and every figure (gradients, lap times, checks) uses the real heights.
- **Shots** moves the camera to the overview, the start and grid, the pit lane, each numbered corner (from a camera tower beyond its run-off), the steepest climb and drop (from their foot, looking up) and the highest point. A view that a hill would block is raised until it sees over it.
- **Flyover** follows the track as a drone; **Hot lap** rides the racing line at the pace of the class picked in Analyse, at the driver's eye height. Pause, play at ×0.5 to ×4, or **Stop** to look around from where the camera is; dragging the view stops it too.
- **Save image** saves the view as a PNG at the screen size, twice it, or 4K (3840 × 2160), with the labels drawn in.
- The track colouring, **Contours**, **Labels** (corner numbers and the start) and **Line** (the racing line) work in 3D too. Hovering the track marks it on the elevation profile, and hovering the profile marks the spot in 3D; the readout shows the position and height under the cursor.
- The sky lights the scene as well as filling the background, and the sun casts shadows across the whole view, from a car close by to woods kilometres away. The picture gets a finish: shading where surfaces meet (under cars, round buildings and trees), a soft glow round the brightest highlights, and a light grade. **Graphics** in the 3D toolbar picks High (all of it) or Basic (no finish, for a slower computer); the choice is remembered.
- The surfaces are textured from photographs: grass on the ground, bare earth in cuttings and on the high dry ground, rock on steep slopes, the asphalt's grain with a darker rubbered racing line and patches of a different tone, gravel in the traps. The colours stay the view's own (the track colouring, the lines, the kerbs); the ground's height colours are deeper and more natural than on the flat map. Lakes ripple in the wind and mirror the sky.
- Trees are leafy broadleaves and full conifers, their crowns built of leaf and needle sprites and lit as a whole, stirring in the wind while a race plays; far away they are drawn with fewer, bigger sprites.
- Editing happens in 2D. In Race mode **Map image** saves the 3D view.
- The 3D view (three.js) loads the first time it is opened. It needs WebGL; the sky (about 38 MB) and the surface textures (about 17 MB) load in the background, with a painted sky and plain surfaces until they are in.

**The race in 3D.** In Race mode the 3D view shows the race: every car as a model of its class (Formula 1, Formula 2 and IndyCar single-seaters, Hypercar and LMP2 prototypes, GT3, GT4 and TCR cars, the front-engined Grand Prix car of 1950 on its wire wheels, MotoGP and Superbike bikes with their riders, and the safety car), at its real size and in its team's livery, where the race puts it.
- Liveries come from each team's colour: a second colour, an accent and one of five patterns, the same for both cars of a team. Single-seaters carry their number on the nose and the engine cover, closed cars in a roundel on the doors and the bonnet (in the class colour in a multi-class race), bikes on the fairing and the tail; team names are on the rear wing endplates.
- Wheels turn and steer, the tyre sidewalls show the compound fitted, bikes lean into corners, and the DRS flap opens in the DRS zones. Cars stop in their box in the pit lane, and a retired car stays where it stopped. In practice and qualifying the cars wait between runs in their open garages, pushed back in to face the pit lane.
- Cars are where the race has them across the road: side by side through a pass, turned the way they move when they pull out, on the grass beside the road after a mistake, and turning round in a spin. A car that has crashed stays where it came to rest. Bikes, which still race in one line, are drawn side by side where they would overlap.
- Cars leave tyre marks that stay for the rest of the race: wheelspin off the grid at a standing start, two black lines where a driver locks up into a corner or brakes too late for a pass, and a slide across the road in a spin. A replay shows the road as it was at that moment.
- Click a car to select it, as in the timing tower; with **Follow** on, the camera keeps the selected car in view. The driver codes and positions show over the cars nearest the camera.
- A car that fills the picture gets a finer model with the shut lines between its panels. From further away it keeps its vents and louvres, the pillars round its windows, exhausts, a wiper, dive planes, and brake discs behind the spokes; a Formula 1 car its floor fences, diffuser strakes, brake drums and cooling louvres.
- Carbon parts show their weave close up, tyres are rubber with a scuffed tread and lettering on the sidewall that turns with the wheel, and glass shows a little of the cabin when looked into and the sky at a glancing angle. The crevices are shaded: under the wings, in the wheel arches, round the cockpit and underneath.
- Damage shows: a broken front wing (or a closed car's splitter) is gone until the pits fit a new one, a car that was hit carries scratches, a punctured tyre is flat with the car sagging towards it, and a car that crashed out stands there as a wreck.
- Cars cast shadows in the sun and lay a shadow of their own shape on the road right under them, their paint reflects the sky, and they keep their size whatever the **Height**.

**TV.** In Race mode the **TV** button in the 3D toolbar shows the race as a broadcast, with a director choosing what to show and from where.
- Cameras stand where a circuit puts them: a tower beyond the run-off at every corner, one behind the grid, one over the pit lane, one beside every long straight, and more wherever the track would otherwise be out of sight. Each pans and zooms with its car through a long lens; the helicopter hangs high off to one side, circles slowly and climbs when a hill gets in the way. Trees standing in a camera's line of sight to the track are cleared once the broadcast starts, as at a real circuit.
- Through a long lens, what the camera focuses on is sharp and the ground in front of it and behind it blurs, as much as a real broadcast lens would blur it; onboard cameras keep everything sharp.
- Each camera shot holds five to twelve seconds, then cuts to another camera. What is at stake decides what is shown: a battle for the lead of the race comes before one for second, and that before one further down or in a slower class, however close that one is. A battle for fifteenth in the second class gets the screen only when nothing better is on. Then come the leaders on their own, pit stops and the rest of the field; a car you pick (in the tower or by clicking it) is shown most, with its battle when it is in one. A shot ends early when its car leaves the camera's sight.
- The cars the director picks it stays with for at least 45 seconds, cutting from camera to camera and staying on through a pass. If one of two drops the other it goes on with the better placed one, and if a car on its own catches another, with the two. Only something major takes the screen from them: an incident, a crash or a retirement anywhere, or the lead of the race changing hands on track. After an incident it goes back to them, and the time away (replays too) does not count against the 45 seconds; after a change of lead it stays with the new leader. Once it has followed cars it looks elsewhere first, when something worth as much is on.
- A caption names the car or the battle when the camera picks it up, in the look of the timing tower: the driver's name on a slanted bar with the position in a box beside it, and the number, team, gap and tyre under it. Overtakes and pit stops among the first ten, fastest laps, incidents, retirements, race control's flags and the weather pop up as they happen, and so do the sector and lap times of the car on screen (purple for the best of all, green for its own best).
- In qualifying a lap timer follows the car on a flying lap: its name, the running time to the tenth and the lap to beat on a red bar under it (and DRS over it while the wing is open). As it completes a sector, and at the line, a box at the right shows its time there and how far that is from the lap to beat: yellow when slower, green when quicker, purple for a lap that is now the fastest, with the car's new position.
- Onboard cameras ride on the cars: above the driver (the T-cam on a single-seater's airbox, a camera on a closed car's roof, the tail camera behind a rider), on the nose, looking back, and a chase camera following behind. The director cuts to them now and then for the car you pick, a battle (from the car behind, or looking back from the car ahead), the leaders and the rest of the field, never twice running. They tilt with the car, and lean with a bike.
- A car standing in its pit box is shown from the pit wall across the lane, with the stop timer running under its name and the work done (new tyres, fuel, a driver change).
- Start a race with TV on and it waits on the grid: the camera walks the grid from tenth to pole, a caption for each car, then looks down the grid from behind it while the five start lights come on one by one and go out (a rolling start gets the green flag), and the race starts (press play to start sooner). At 1× or 5× the start itself is shown from behind the grid.
- Action replays: a few seconds after an overtake in the top ten or an incident, the director replays it at half speed from another camera (often from on board), behind a REPLAY sting, then cuts back to the race. A contact is replayed with both cars in the picture, and once more when the stewards give a penalty for it minutes later. The broadcast keeps the last 40 seconds of the race for this (and every contact for as long as the race lasts), and replays only at 1× or 5×.
- Two cars side by side for a place count for more than two that are merely close: the director goes to them from a car that is on for nothing in particular, and stays on them longer. A restart is shown on the front of the field from the moment the safety car is coming in, and a standing restart from behind the grid, as the start was.
- A map of the circuit shows every car, the cars on screen larger and named. During a battle a gap graphic shows the gap now and at the line on the last five laps, closing or growing. "Final lap" comes up as the leader starts it, the chequered flag names the winner (each class's in a multi-class race), and once the race is over the results stay on screen.
- In practice and qualifying there are no battles to follow: the director shows cars on push laps (most of all in the closing minutes of qualifying, the quicker ones more), with a "Flying lap" caption and their sector times, and at the flag the session's fastest and its classification. Under a red flag it shows the head of the queue waiting in the pit lane.
- In the rain, drops settle on the lens, a fresh set at every cut; the helicopter's stays clear.
- Shots last as long at any playback speed. At high speeds the cars go by a trackside camera too fast to hold, so the helicopter and the onboard cameras take over; at 1× you get the whole broadcast.
- Drag the view or press **Stop** to take the camera back. **Save image** saves the broadcast frame.

**Weather and flags in 3D.** The race's weather and race control show in the 3D view too.
- The sky clouds over a quarter of an hour before a shower and clears after it: an overcast sky, a dim sun, soft shadows and a flatter, duller picture. Rain falls in front of the camera, heavier in a downpour, with haze closing in round what the camera looks at.
- The track darkens and shines as it gets wet, mirroring the sky. While it rains the cars' tyres keep the racing line a little less wet; once it stops, the line dries first and shows as a duller band. On a very wet track water stands in patches, most near the edges. Kerbs and asphalt run-off shine too; gravel and grass only darken.
- Cars throw up spray behind them on a wet track, more the faster they go and the wetter it is: most behind single-seaters, least behind bikes. It hangs in the air and fades, so a car following closely drives into the cloud of the car ahead.
- Rear rain lights come on with intermediates or wets (and on closed cars in the rain), closed cars run with their headlights up in the wet, and the lights glow through the spray. The safety car's orange beacons flash in turn while it is out and go dark once it comes in this lap, as in Formula 1.
- Three marshals stand at every marshal post and show what race control calls for, following FIA Appendix H: a waved yellow flag at the post before an incident and through the stretch under yellow, two (a double waved yellow) where the track is blocked, and green at the first post after it. Under the safety car every post waves yellow and holds up the SC board; under a virtual safety car or full course yellow every post shows a single yellow and the VSC or FCY board, keeping the double yellow before the incident; green flags come out when the race is released and stay for a lap. Blue flags are waved at the post a car is coming to when a car a lap up, or from a faster class, is about to pass. The light panel beside each post flashes yellow or blue or shows green. At the line the flag marshal waves the chequered flag for the finish, and green for a rolling start or a restart.

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
    "kind": "time", "laps": 125, "minutes": 360, "grid": "qualifying", "weather": "changeable", "seed": "785642", "skip": ["p3"]
  },
  "layouts": [
    {
      "name": "National",
      "links": [{ "from": { "x": 4107.86, "y": 3154.72 }, "to": { "x": 4186.81, "y": 4781.28 }, "points": [{ "x": 4252.13, "y": 3358.47, "width": 12 }] }],
      "race": null
    }
  ]
}
```

Coordinates are metres from the map's top-left corner, x east and y south. The heightmap is never stored; it is regenerated from the terrain settings, or, when `terrain.survey` names a surveyed terrain shipped with the app (`"survey": "bremgarten"`), read from that: the seed and the shape settings then play no part, and the map takes the survey's size. `overrides` holds hand-placed facilities as world positions (`startFinish`, `speedTrap`, and `pitLane` with entry, exit and side); anything absent is placed automatically. `race` is the race setup with its own seed: the classes and their cars, `kind` (`laps` or `time`, and `laps` or `minutes` applies accordingly), the grid order, the `weather` (`dry`, `changeable` or `wet`) and the weekend sessions left out (`skip`: `p1`, `p2`, ... for practice, `qualifying` for all of it; a file without it runs the whole weekend). It is saved when a weekend is first started, so the file reproduces the weekend and the race, weather included. Files from earlier versions, with a single `vehicleId` and `cars`, still open. `layouts` lists the circuit's other layouts: each link's ends (`from` and `to`, snapped to the track) and the points between, and the layout's own `race`. Files without it have only the full circuit.

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

A car cannot drive through the one ahead. Cars have a place across the road and a width: one is held up only by a car in its way, pulls out where it has the pace and the room, and may out-brake the car ahead on the inside (see Race above, and Lanes in ARCHITECTURE.md). Bikes race in one line: one that has come too close drops back a little rather than stopping, from the grid to the first corner the field may run up to three abreast, and a bike passes at braking zones, with a chance that grows with the speed difference at the braking point, the pace difference, how good a place the braking zone is (the speed lost and the straight before it) and both riders' racecraft; a failed attempt costs a little time and can end in contact. Lapped cars let the leaders by.

Stops happen in the real pit lane: braking for the entry, the speed limit, the team's box, the stationary time and pulling away. Classes without refuelling plan their stints before the start (the fastest split of the race into tyre stints that meets the two-compound rule and any mandatory stop), spread the stop by a lap or two, react to a rival's undercut and try one when stuck. Classes with refuelling stop when the fuel runs low and change tyres when the set would not last another stint. Fuel burn and tyre wear follow the track: each class's typical figures are scaled by the track's wheel energy and tyre work against the average of the real circuits. Technical failures come from a rate per kilometre per class, and the drivers' own trouble from the class's chances per lap of a mistake, a trip off and a crash. Bikes draw those once a lap. Cars get part of each at the braking points (two and a half times as often with a rival right behind) and the rest as contact between cars side by side through a corner, tuned on the real circuits so that the totals stay what the class's figures say; contact follows the fighting, so a circuit with much passing has much more of it than one with little. Damage is repaired at a stop, which takes the class's repair time longer.

The race rules per class (grid, crews, default length and start, tyres, fuel, stops and repairs, driver changes, DRS, slipstream, incident rates, flags, the stewards' penalties) live in [data/racing.json](data/racing.json); a class missing there gets generic defaults. The figures are approximate and meant to be edited. The penalties are each series' own, from its 2026 regulations and its stewards' decisions (`stewardsSources` in the file says where each comes from, and where one rests on a single decision or on another series of the same organiser).

Several classes can race together, as at Le Mans. Each runs its own race lap, strategy and rules; the fastest class starts in front and its rules set the start, the flags and the time limit. Faster classes come up behind slower ones and get by at the next braking zone, losing a little time in the traffic; positions, gaps, fastest laps and sector colours count within the class, and passes of slower classes are not overtakes. When the flag falls for the overall leader, every car finishes at its next crossing, so slower classes run fewer laps, and they fuel and plan for those.

Endurance cars (Hypercar, LMP2, GT3 and GT4) have crews of two or three drivers with their own pace, consistency and error rate. A driver hands over at a stop before passing the class's longest stint, to the team-mate who has driven least; the change happens while refuelling. These classes take a rolling start, as does IndyCar.

Race control waves yellow flags where a car went off or stopped: no passing there, and a little slower through it. A crash or a car stopped on track may bring out the safety car, a virtual safety car (Formula 1 and 2: everyone a set share slower) or a full course yellow (endurance classes: 80 km/h everywhere), by the rules of the fastest class; bikes only get yellows. The safety car collects the field into a queue and stays out until the track is clear and the field has closed up behind it (see Race above for lapped cars and the restart). Teams take the cheap pit stop a neutralisation offers when they have to stop anyway, once. Over 100 Formula 1 races on the real circuits there were 0.17 safety cars, 0.22 virtual safety cars and 0.12 red flags a race; three six-hour races of three classes on the test circuit had two full course yellows each, and one of them a safety car.

A red flag stops the race after a big accident (more likely where it happened at speed, rare for bikes, which leave no wreck across the track) or in rain too heavy to race in (not for bikes: riders change bikes and race on). The cars drive slowly to where their series has them wait, in the order they arrive: queued at the pit exit (Formula 1, Formula 2, IndyCar, GT3, TCR, the bikes) or stopped in single file before the line (WEC, LMP2, GT4). Where the rules allow it they may change tyres. Formula 1 and GT World Challenge add the stoppage to the race's time limit; the others' clocks run on. When the track is clear the race resumes behind the safety car: rolling, or for Formula 1 in the dry with a standing restart after a lap behind it (the field forms up on the grid in race order, a lapped car a lap down, then the lights go out and it goes as the start did). Bikes restart from the grid after a sighting lap, and a bike race stopped after three quarters (MotoGP) or two thirds (WorldSBK) of its distance is over. A race that cannot resume in time is classified laps back: two laps before the red flag in most series. The figures come from each series' 2026 sporting regulations (2025 for the bikes).

Weather comes from the race seed: dry, changeable (one or more showers, more in a long race) or wet (raining from the start, stopping and drying out in most races). The track gets wet within minutes of the rain and dries over about twenty. On a wet track every class loses grip, much more on slicks, which also aquaplane and crash far more easily; intermediates (Formula 1 only) suit a damp track and full wets a very wet one, and both wear out fast when it dries. Teams watch the rain on the radar and change tyres when the time it gains outweighs the stop; classes that never stop (MotoGP, Superbike, TCR) come in only for the weather. A race that starts wet starts on wet-weather tyres, DRS stays shut on a wet track, and the two-compound rule no longer applies once wet tyres are used.

Telemetry is recorded as the moment each car passes a sample point every 5 m or so (coarser on very long laps, so a lap has at most about a thousand points). Speed follows from distance over time, g-forces from the change in speed and the racing line's curvature, gear from the gearing, and throttle and brake from the force the change in speed needs against drag, rolling resistance and gradient, as in the lap-time model (with the grip the tyres have on a wet track). So the pedal traces are the model's estimate, not recorded inputs, and a lap run through the pit lane shows the lane mapped onto the stretch of track it bypasses.

## Race weekend

Before the race come practice and qualifying, each series to its own format (from its 2026 sporting regulations; the sources are listed in [data/racing.json](data/racing.json)):

| Series | Practice | Qualifying |
|---|---|---|
| Formula 1 | FP1, FP2 60 min (day 1), FP3 60 min | Q1 18 min, Q2 15 min, Q3 13 min: a knockout, as many out at each step (5 with 20 cars, 6 with 22) |
| Formula 2 | 45 min | 30 min |
| IndyCar (road courses) | 2 × 52 min | Two groups of 10 min (split by practice), the best 6 of each into the Fast 12 (10 min), the best 6 into the Fast Six (6 min); the rest of the groups take places in turn |
| Hypercar (WEC) | FP1, FP2 90 min, FP3 60 min | Qualifying 12 min, the best 10 in Hyperpole (10 min) |
| LMP2 (ELMS) | 2 × 90 min | 15 min |
| GT3 (GT World Challenge) | 2 × 90 min | Q1, Q2 and Q3 of 15 min, one per driver; the grid by the average of the three |
| GT4 | 2 × 60 min | 20 min |
| TCR | 2 × 30 min | Q1 20 min, the best 12 in Q2 (10 min) |
| MotoGP | FP1 45 min, Practice 60 min, FP2 30 min | The top 10 of FP1 and Practice go straight to Q2; the rest ride Q1 (15 min) and its best 2 join them in Q2 (15 min) |
| WorldSBK | FP1, FP2 45 min, FP3 20 min | Superpole 15 min |

A session runs on the race simulation. Cars start in their garages and go out in runs: an out lap from the pit exit, push laps (with cool-down laps between them), or a long run at race pace on race fuel, then an in lap back to the garage. Practice opens with an installation run, then short runs on low fuel and, in the session meant for it (Formula 1's FP2), race simulations on the race compounds. In qualifying each car has a run or a few, the last timed to start its final push lap just before the flag, as the track is quickest then; a car comfortably through to the next stage may save its tyres. Only push laps, cool-down laps and long runs are timed; a lap begun before the chequered flag still counts. A car on a slow lap waves a pushing car by, which costs it a moment and now and then a spoilt lap. The order is by best lap, the earlier time first when two are equal. In qualifying a push lap runs at the calibrated qualifying pace (no fuel to speak of, the wing open in every DRS zone), so pole matches the lap-time model.

A crash or a car stopped on track in a session brings out the red flag: everyone returns to the garage and the lap in progress does not count. The qualifying clock stops for it; the practice clock runs on. In qualifying the car that caused it loses lap times where its series says so: all of them in WEC and ELMS, its two best in IndyCar, its best in Formula 2, GT World Challenge, GT4 and TCR.

The weekend carries into the race:
- Rubber builds up on the racing line lap by lap. A green track is up to 1% slower (0.6 to 1.2% depending on the series), a little rubber goes between sessions and more overnight, and rain washes it away. A weekend that skips practice starts the race on a greener track.
- Teams start with a guess of how fast their tyres wear (off by about a fifth, more or less) and learn the truth from laps on race fuel in practice. Their race strategy uses what they believe, while the tyres wear as they really do. A weekend without race simulations brings rougher strategies, and stops that come early when the tyres go off sooner than planned.
- The grid comes from qualifying: from the last stage each car reached, then its time there. Leaving qualifying out works the grid out from the lap-time model, as before.

The same seed and the same sessions always give the same weekend.

Limits: no drying line, one weather for the whole circuit, and no rule on each endurance driver's minimum time at the wheel. Teams have no tyre allocation: every qualifying run is on new tyres. The IndyCar groups are split by practice (since 2026 the series splits them by the previous race's qualifying), GT World Challenge's qualifying runs unsplit (the 2025 format), and GT4 runs the session that sets its first race's grid. A bike race stopped in its first three laps restarts for the laps left rather than over the full distance less one. Sprint races, reversed grids for a second race and championship points are not modelled. Lapped cars are not waved past the safety car. The class paces come from the lap-time calibration, so on some circuits the gaps between classes are smaller than in reality (LMP2 and GT3 run close at Spa, for example). Overtaking is only roughly tuned: in trials on the real circuits, Formula 1 races saw from under ten passes after lap 1 (Suzuka, Budapest) to about a hundred (Monza, Bahrain), with Spa and Silverstone lower and Zandvoort (whose banking is not modelled) higher than in reality.

## Bremgarten 1954

The Circuit Bremgarten ran over public roads through the Bremgartenwald, the forest north-west of Bern, from 1931 to 1954: 7.28 km of fast bends with no real straight, the Swiss Grand Prix's home until Switzerland banned circuit racing in 1955. Part of it now lies under the A1 motorway. The template rebuilds it as it was raced:

- **The lap** is traced on swisstopo's 1946 aerial photograph and the 1954 national map, and taken from today's surveyed road centrelines (swissTLM3D) where the old road is still there: about three fifths by hand, two fifths surveyed. It comes to 7,294 m against the official 7,280 m, runs clockwise, and is 9 m wide throughout, the width of the road in the photograph.
- **The ground** is swisstopo's swissALTI3D elevation model at 2 m, 4.1 km square. Today's motorway, its junctions at the Forsthaus and Eichholz and their banks are taken out: the ground there is filled in from the ground on both sides. The lap falls and climbs 66 m, from 555 m at the Forsthaus to 489 m above the Wohlensee at Eymatt.
- **The forest** is the green of the 1954 map, with today's forest outline beyond the part of the map that was used. The Aare and the Wohlensee lie where they do.
- **The start line** is on the Murtenstrasse, with the grid in front of what the 1946 photograph shows there (terraces on the forest side, a strip that looks like the pits on the south side), and the pit lane on the south side as then.

What is not of 1954: the app builds the circuit to today's practice, as chosen for this template. It clears the trees 20 m back from the road and lays run-off, gravel, guardrail and tyre walls, and its pit lane, pit building and grandstand are today's and far longer than the pits of the day. Where exactly the line was in 1954 is not established; it is placed so that today's longer grid and pit lane fit on the straight. Beyond the road and the forest the ground is today's: the city's buildings are not there, but their terraces, the railway cuttings and newer roads show in it.

How exact it is: the surveyed stretches are good to about a metre. The hand-traced ones are within about 4 m of the road in the photograph, which itself lies a few metres off today's survey in places. Bends are smooth curves through the traced points, so a corner's radius is right to perhaps a tenth. The widths of single stretches, the camber and the road's surface (part of it was cobbled) are not modelled. With its 9 m road the circuit fails today's licence checks on width, as it would. [data/templates](data/templates/README.md) has the method and the trace.

## Monaco 1950

The Monaco Grand Prix as it was run for the first world championship, on 21 May 1950: the lap of 1929 to 1954, 3.18 km, clockwise. From the start on the Boulevard Albert Ier it turns right at Sainte-Devote, climbs 40 m to the Casino, drops through Mirabeau and the Station hairpin to Portier, runs along the sea front, flicks through the chicane onto the quay, turns left at Tabac and goes down the quay beside the boulevard to the Gasworks hairpin, where it comes back onto the start straight. There is no swimming pool and no Rascasse: those came in 1973.

- **The ground** is IGN France's RGE ALTI elevation model at 2 m, 2 km square, with the harbour and the sea as water. Beside the road the ground is levelled to the road's own height, as a street on a hillside is a ledge; where the tunnel is, it is opened up into a cutting; on the quays it is evened out where they have been built on since.
- **The line** follows today's streets from OpenStreetMap where they are the streets of 1950. What has changed is drawn over IGN's aerial photograph of the 1950s, which shows the harbour before the pool, the gasworks and the old station: the Casino square, Portier, the chicane, Tabac, the quay road and the hairpin. How far south the hairpin lies is set so that the lap comes to the 3.180 km of the record books; the photograph allows it within some 25 m.
- **The road** is 8 m wide throughout.

What is not of 1950: there are no buildings, no tunnel and no railway, so it is a road on a bare hill by the sea, with a few trees. The ground and the shore are today's: the harbour has the piers and the wider quays built since. The app dresses the lap to today's practice (guardrail, kerbs, run-off where there is room, grandstands), puts its pit lane on the town side of the boulevard (in 1950 the pits stood on the strip between the boulevard and the quay) and lines the grid up two abreast (it was three and two by turns). The licence check fails it on width, length and run-off, as it would fail the real one.

For comparison: Juan Manuel Fangio took pole in 1:50.2 in an Alfa Romeo 158 and won the 100 laps in 3 h 13 min; nine cars went out together at Tabac on the first lap, where a wave had wet the road. The app's car of 1950 laps the template in 1:51.6.

Sources and method: [data/templates/README.md](data/templates/README.md) and [public/surveys/README.md](public/surveys/README.md).

## The Formula 1 of 1950

A class of its own beside today's Formula 1: the front-engined Grand Prix car of the first world championship, to the figures of the Alfa Romeo 158, the car that took pole and won at Monaco and at Bremgarten in 1950.

- **The car**: 350 bhp from a supercharged 1.5 litre straight-eight, 700 kg dry (850 kg here with its driver and fuel), four gears, drum brakes, no wings; 2.50 m between the axles and 4.28 m long, on tall narrow tyres. Its top speed is set at 290 km/h. Its tyre grip (0.77, where today's car has 1.85 before its downforce) is fitted to two pole laps of 1950, both Fangio's: 1:50.2 at Monaco and 2:42.1 at Bremgarten, on the two templates. The model gives 1:51.6 and 2:40.5, 1.2% slow and 1.0% fast.
- **In 3D** it is a cigar of a body with an oval grille and a tail that runs to a point, louvres and straps on the bonnet, one exhaust along the left side, the driver upright in the open behind a big wheel and a small screen, wire wheels with knock-off spinners, and its number in white roundels. It is painted in its team's colour with a band of the second colour round the nose.
- **The race**: 300 km from a standing start, in a field of 19 (as started at Monaco) with far bigger gaps between the cars than today. The tank does not last the distance, so the cars stop for fuel, and stand for most of a minute. Cars break often: a third or more of the field does not see the flag. There is no safety car and no virtual one; the stewards give warnings only. The weekend is a Thursday and a Saturday practice of 90 minutes; the Saturday sets the grid.

What rests on little: the fuel it burns is the 1951 car's figure scaled down (1 kg a kilometre), the tank size, the refuelling rate and the tyre life are estimates, and so are the rates of mistakes and breakdowns. The pit lane speed is 100 km/h because the app wants one; there was no limit. In 1950 the first five places on the Monaco grid went by Thursday's times; here Saturday decides them all. Rain tyres did not exist: the app's stand in.

## Credits

The sky panoramas are "Kloofendal 48d Partly Cloudy (Pure Sky)" and "Kloofendal Overcast (Pure Sky)" by Greg Zaal and Jarod Guest, from [Poly Haven](https://polyhaven.com), CC0 (see [public/sky](public/sky/README.md)). The surface textures are Poly Haven's too, CC0, by Dimitrios Savva, Charlotte Baglioni, Rob Tuytel, Amal Kumar, Greg Zaal, Dario Barresi and Jenelle van Heerden (see [public/textures](public/textures/README.md)).

The Bremgarten template's elevation, road centrelines, aerial photograph and maps are from the Federal Office of Topography swisstopo (swissALTI3D, swissTLM3D, SWISSIMAGE HIST 1946, the national map of 1954), free to use with the source named (see [public/surveys](public/surveys/README.md)).

The Monaco template's elevation and the aerial photograph of the 1950s it was traced over are from IGN France (RGE ALTI; the photographs of 1950 to 1965), free to reuse under the Licence Ouverte 2.0 with the source named. Its street lines are from OpenStreetMap, (c) OpenStreetMap contributors, under the Open Database License. See [public/surveys](public/surveys/README.md) and [data/templates](data/templates/README.md).

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works inside.
