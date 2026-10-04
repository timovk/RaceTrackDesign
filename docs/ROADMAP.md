# Roadmap

What is decided and waiting to be built, and what was proposed and never decided. The README's status table lists what is done. Last updated 2026-10-05.

## Next: side-by-side racing

Decided on 2026-10-05; step 1 starts on 2026-10-06.

Today the race is one-dimensional: a car is a position along the lap, and the sideways position that is drawn (passing, the grid, cars spread side by side in 3D) never affects the race. This makes the sideways position real.

**Decisions**

- **Depth: lanes.** Every car has a sideways position across the track and a width. Off the racing line is slower in corners (tighter on the inside, longer on the outside) and costs nothing on straights. Not free driving lines with a grip limit, and not full car physics.
- **Goals:** the look (cars truly side by side, passes on a visible stretch of road, no clumps), passing that follows from room (narrow tracks hard to pass on, defending the inside matters), and contact and mistakes that come from where the cars are.
- **Contact** is decided by rule, not by physics: when two cars claim the same piece of road, the overlap and the speed decide between a touch that costs time, damage that needs a pit stop, a spin, and a crash. Cars do not bounce or slide.
- **Stewards:** contact also brings penalties (time penalties, drive-throughs), by each series' real rules, looked up and not invented.
- **Speed:** fast-forward and skipping to the end may get slower; only watching has to stay smooth. Measured today: 10 to 16 µs a step, a 90-minute race of 22 cars in 0.47 s, a 6-hour race of 52 cars in 3.4 s. Lanes are estimated (not measured) at two to three times that.
- **Old races change:** the same seed gives a different race than before. There is no switch that keeps the old model.
- **Cars first.** Bikes (three or four abreast, leaning) keep today's model until the car version is right.

**Steps**, each leaving a race to watch:

| Step | What gets built | What it shows |
|---|---|---|
| 1 | Sideways position and car width become real; a car is held up only by a car in its way; passing needs room; off-line costs time in corners | Passes on a stretch of road, cars side by side into corners, faster classes threading past slower ones where there is space |
| 2 | The start and lap 1 on the same rules | The grid fanning out and funnelling into the first corners by room, in place of the three-abreast cap |
| 3 | Contact and mistakes: touches, damage, spins, running wide onto the run-off | Incidents where cars were fighting, with yellows and safety cars through the race control there is |
| 4 | Stewards: fault and penalties per series | Penalties in the timing tower and the feed |
| 5 | Restarts and safety-car queues; the TV director using all of it | Replays of contact, cameras picking side-by-side fights |

**Also agreed**

- Overtaking is re-tuned on the real circuits in `data/circuits` (their real widths are in the data), with pass counts per circuit reported before and after.
- Mechanical failures stay random. Driver incidents move to where cars are fighting, with each series' overall rate kept where it is.

## Graphics, phase 4: the cars

Agreed in the graphics plan of 2026-10-02 as the phase after the surroundings; not started. The look agreed for all phases: stylised but polished; downloaded CC0 assets are fine; heavy effects are fine on the target machine.

A car has 4,000 to 10,000 triangles, which is enough. What makes it look plain is the surface:

- smoother geometry up close;
- more aero detail and panel lines;
- carbon, rubber and glass materials;
- baked shading in the crevices, and contact shadows under the car.

To decide when it starts:

- **Generated or hand-made models.** Hand-made models look better, but need licence-checked generic models, and one per class is a lot of work. The plan so far keeps the generated ones.
- **Visible damage.** Side-by-side racing (step 3) gives cars damage; whether it shows on the car (a missing front wing, say) belongs here.

## Graphics, phase 5: a quality setting

Agreed in the same plan; not started. Low to Ultra, so slower machines stay smooth with 50 cars or more. Today there is only High and Basic (Basic leaves out the picture's finish).

## Left over from graphics phases 1 to 3

In the original plan, and not built in those phases. Not decided either way; listed so they are not lost.

- Motion blur for the TV cameras.
- Skid marks on the asphalt.
- Grass up close.
- Advertising boards and gantries.
- Crowds in the grandstands.
- A more detailed pit building.

## Proposed, not decided

- Projects and backups.
- Bridges and crossovers.
- Banking and ovals.
- A championship across circuits (with sprint races and points).
- Night races.
- Sound.
- A track generator.
- More templates of real circuits, made the way Bremgarten was (`data/templates/README.md`).
- Side-by-side racing for bikes, after the car version.
