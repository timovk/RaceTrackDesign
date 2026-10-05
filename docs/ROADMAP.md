# Roadmap

What is decided and waiting to be built, and what was proposed and never decided. The README's status table lists what is done. Last updated 2026-10-05.

## Next: side-by-side racing

Decided on 2026-10-05. Steps 1 and 2 are built; steps 3 to 5 are waiting.

Before step 1 the race was one-dimensional: a car was a position along the lap, and the sideways position that was drawn (passing, the grid, cars spread side by side in 3D) never affected the race. This makes the sideways position real. Bikes still race the old way.

**Decisions**

- **Depth: lanes.** Every car has a sideways position across the track and a width. Off the racing line is slower in corners (tighter on the inside, longer on the outside) and costs nothing on straights. Not free driving lines with a grip limit, and not full car physics.
- **Goals:** the look (cars truly side by side, passes on a visible stretch of road, no clumps), passing that follows from room (narrow tracks hard to pass on, defending the inside matters), and contact and mistakes that come from where the cars are.
- **Contact** is decided by rule, not by physics: when two cars claim the same piece of road, the overlap and the speed decide between a touch that costs time, damage that needs a pit stop, a spin, and a crash. Cars do not bounce or slide.
- **Stewards:** contact also brings penalties (time penalties, drive-throughs), by each series' real rules, looked up and not invented.
- **Speed:** fast-forward and skipping to the end may get slower; only watching has to stay smooth. Measured before: 10 to 16 µs a step, a 90-minute race of 22 cars in 0.47 s, a 6-hour race of 52 cars in 3.4 s. Measured with step 1: 0.60 s and 5.5 s. Measured with step 2: 0.80 s and 7.4 s, so 1.7 to 2.2 times the old cost (the estimate was two to three times).
- **Old races change:** the same seed gives a different race than before. There is no switch that keeps the old model.
- **Cars first.** Bikes (three or four abreast, leaning) keep today's model until the car version is right.

**Steps**, each leaving a race to watch:

| Step | What gets built | What it shows |
|---|---|---|
| 1 **done** | Sideways position and car width become real; a car is held up only by a car in its way; passing needs room; off-line costs time in corners. Also built here, because passing made no sense without them: braking later for the inside, and the car ahead shutting the inside | Passes on a stretch of road, cars side by side into corners, faster classes threading past slower ones where there is space |
| 2 **done** | The start and lap 1 on the same rules. What it took: a hole to move over into, two abreast through a corner, following measured in metres of road, and one cost per corner for a lane | The grid fanning out and funnelling into the first corners by room, in place of the three-abreast cap |
| 3 | Contact and mistakes: touches, damage, spins, running wide onto the run-off | Incidents where cars were fighting, with yellows and safety cars through the race control there is |
| 4 | Stewards: fault and penalties per series | Penalties in the timing tower and the feed |
| 5 | Restarts and safety-car queues; the TV director using all of it | Replays of contact, cameras picking side-by-side fights |

**Also agreed**

- Overtaking is re-tuned on the real circuits in `data/circuits` (their real widths are in the data), with pass counts per circuit reported before and after.
- Mechanical failures stay random. Driver incidents move to where cars are fighting, with each series' overall rate kept where it is.

### Step 1 as built

How it works is in ARCHITECTURE.md under Lanes. Three things changed beside the passing itself, all for cars only: the slipstream is weaker (a car loses 10% to 12% of its drag 0.3 s behind another, where the classes had 20% to 25%) and thins out faster with distance, as does the wake; and in the race the wing opens over the last 450 m of a DRS zone at most. With the old values every car in a tow passed the one ahead on any long straight.

Overtakes for position after lap 1, Formula 1, each circuit's default race. Before: the one-line model, two races per circuit. After: lanes, three races per circuit. The same seed no longer gives the same race, so the two columns are different races, and a single race can be well off these means.

| Circuit | Width (m) | Before | After step 1 | After step 2 |
|---|---|---|---|---|
| Austin | 13.9 | 31.0 | 40.0 | 28.7 |
| Brands Hatch | 9.2 | 9.0 | 5.3 | 3.7 |
| Budapest | 10.0 | 27.0 | 9.0 | 9.0 |
| Catalunya | 11.2 | 13.5 | 21.3 | 11.0 |
| Hockenheim | 12.6 | 27.0 | 21.7 | 4.3 |
| Indianapolis | 15.3 | 0.0 | 24.3 | 28.0 |
| Melbourne | 12.3 | 30.0 | 9.7 | 15.3 |
| Mexico City | 12.2 | 57.5 | 59.7 | 53.7 |
| Montreal | 9.7 | 83.0 | 39.0 | 40.7 |
| Monza | 9.4 | 161.5 | 114.0 | 122.7 |
| Moscow Raceway | 11.7 | 17.5 | 35.0 | 32.0 |
| Norisring | 15.9 | 92.5 | 94.3 | 104.3 |
| Nürburgring | 11.8 | 30.0 | 40.0 | 35.0 |
| Oschersleben | 10.6 | 43.5 | 45.3 | 11.0 |
| Sakhir | 13.4 | 83.5 | 70.0 | 50.0 |
| São Paulo | 11.9 | 64.0 | 49.3 | 35.7 |
| Sepang | 14.6 | 47.5 | 50.7 | 43.3 |
| Shanghai | 13.0 | 19.0 | 33.0 | 51.3 |
| Silverstone | 13.8 | 36.5 | 34.7 | 35.3 |
| Sochi | 12.6 | 71.5 | 36.7 | 27.0 |
| Spa | 9.8 | 37.0 | 57.0 | 68.3 |
| Spielberg | 11.0 | 96.0 | 39.3 | 90.0 |
| Suzuka | 9.8 | 15.0 | 63.7 | 64.7 |
| Yas Marina | 12.9 | 76.0 | 67.7 | 82.7 |
| Zandvoort | 10.5 | 20.5 | 39.0 | 38.0 |
| **Mean** | | **47.6** | **44.0** | **43.4** |

GT3, one three-hour race of 30 cars per circuit, before and after: Monza 179 and 129, Spa 169 and 76, Budapest 118 and 36, Suzuka 164 and 35, Silverstone 175 and 141, Brands Hatch 131 and 25, Sakhir 204 and 162; mean 163 and 86. In a 60-minute race of 52 cars in three classes on the test circuit, bodies overlapped for 742 pair-seconds before (755 pairs of cars drove through each other) and for 0.3 after.

Not right yet:

- **Monza** is still too high and **Suzuka** went up a lot: on a long straight a car in the tow with an open wing gets alongside whatever its pace, and the two swap places lap after lap. The wing takes the same share of the drag at every wing level, which probably overstates it at Monza.
- **Budapest and Melbourne** are low. A car has to be clearly quicker to get by there, and few races put such cars together. Budapest also has one DRS zone here and two in reality.
- **GT3** has about half the passes it had. Nothing says which number is nearer the truth: there are no real pass counts for these races in the data.
- **No contact.** A failed pass costs a quarter of a second and nothing else, so drivers risk nothing by trying. The one-line model's random contact after a failed pass is gone for cars. That is step 3.
- **Defending** is one move to the inside by a car that sees the attack coming. No defending on the exit, no forcing a car wide, no weaving rules: the rest belongs with the stewards in step 4.

### Step 2 as built

Step 1 left a stand-in at the first corner: nobody drove round the cars ahead. It turned the first corner into a queue: at Sakhir the whole field went through in single file, the back half at about 22 km/h, the last car over 12 s behind the leader at the apex. Taking the stand-in out was not enough; four things in the race itself had to change, and they hold all race long, not on the first lap only:

- **A hole to move into.** A car does not move over in front of one close behind it in the next lane. This is what keeps the two files of the grid apart down to the first corner and through it, and what makes a car that has pulled out wait for a gap to get back in.
- **Two abreast through a corner.** Of three, the one furthest back drops in behind before they turn in, and nobody moves up beside two as a third.
- **Following in metres of road.** Cars followed each other by stations along the middle of the track. On the racing line a station is under half a metre long at a hairpin's apex and over two metres just after it, so a car matching the one ahead station for station nearly stood still there. A car a little too close now eases off instead of braking, and cars in one lane can no longer end up inside each other.
- **One cost per corner for a lane.** Station by station the outside lane was charged up to six times the racing line's time at an apex.

Also out: the 0.3 s a car lost when it was passed (in a pack it cost the next place too), and an overtake is no longer counted when cars merely fall into line under a safety car.

The start, Formula 1, four starts on each of Sakhir, Monza, Budapest, Silverstone and Spa: 31 places change hands on the first lap in all (23 of them before the first corner), no car gains or loses more than six, the field is past the first apex within 3.9 s of the leader on average, and bodies overlap for 0.03 pair-seconds. The pole-sitter leads the first lap in 64% of 96 starts on eight circuits. From a rolling start (GT3, 30 cars) 8 places change before the first corner and 52 by the end of the lap.

The pass counts after lap 1 moved too (the last column of the table above); GT3, one race per circuit: Monza 197, Spa 78, Budapest 18, Suzuka 24, Silverstone 120, Brands Hatch 45, Sakhir 72, mean 79.

Not right yet, beside what is listed under step 1:

- **Hairpins after a straight** (Hockenheim, Oschersleben) lost most of their passes. In step 1 a car squeezed back behind the one it was passing could close up through it and come out beside it; that is gone, and a dive from right behind now has to get out from behind the other car first, which it rarely manages in time.
- **Monza** went up again for GT3 (197 in the one race run, 129 after step 1).
- **The field is past the first corner quickly**: under 4 s for 20 cars, nose to tail in two files. Real fields take longer, because drivers leave more room on cold tyres with a full tank; nobody does here, since nothing can go wrong until step 3.
- **Mistakes in a pack.** A small mistake still means half speed for a second or two, which a car in the next lane now drives round; in the pack at the first corner that costs several places. Step 3 replaces it.

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
