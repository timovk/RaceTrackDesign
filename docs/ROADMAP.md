# Roadmap

What is decided and waiting to be built, and what was proposed and never decided. The README's status table lists what is done. Last updated 2026-10-07.

## Next: side-by-side racing

Decided on 2026-10-05. Steps 1 to 4 are built; step 5 is waiting.

Before step 1 the race was one-dimensional: a car was a position along the lap, and the sideways position that was drawn (passing, the grid, cars spread side by side in 3D) never affected the race. This makes the sideways position real. Bikes still race the old way.

**Decisions**

- **Depth: lanes.** Every car has a sideways position across the track and a width. Off the racing line is slower in corners (tighter on the inside, longer on the outside) and costs nothing on straights. Not free driving lines with a grip limit, and not full car physics.
- **Goals:** the look (cars truly side by side, passes on a visible stretch of road, no clumps), passing that follows from room (narrow tracks hard to pass on, defending the inside matters), and contact and mistakes that come from where the cars are.
- **Contact** is decided by rule, not by physics: when two cars claim the same piece of road, the overlap and the speed decide between a touch that costs time, damage that needs a pit stop, a spin, and a crash. Cars do not bounce or slide.
- **Stewards:** contact also brings penalties (time penalties, drive-throughs), by each series' real rules, looked up and not invented.
- **Speed:** fast-forward and skipping to the end may get slower; only watching has to stay smooth. Measured before: 10 to 16 µs a step, a 90-minute race of 22 cars in 0.47 s, a 6-hour race of 52 cars in 3.4 s. Measured with step 1: 0.60 s and 5.5 s. Measured with step 2: 0.80 s and 7.4 s, so 1.7 to 2.2 times the old cost (the estimate was two to three times). Step 3 added nothing measurable: 0.82 s and 7 to 8 s.
- **Old races change:** the same seed gives a different race than before. There is no switch that keeps the old model.
- **Cars first.** Bikes (three or four abreast, leaning) keep today's model until the car version is right.

**Steps**, each leaving a race to watch:

| Step | What gets built | What it shows |
|---|---|---|
| 1 **done** | Sideways position and car width become real; a car is held up only by a car in its way; passing needs room; off-line costs time in corners. Also built here, because passing made no sense without them: braking later for the inside, and the car ahead shutting the inside | Passes on a stretch of road, cars side by side into corners, faster classes threading past slower ones where there is space |
| 2 **done** | The start and lap 1 on the same rules. What it took: a hole to move over into, two abreast through a corner, following measured in metres of road, and one cost per corner for a lane | The grid fanning out and funnelling into the first corners by room, in place of the three-abreast cap |
| 3 **done** | Contact and mistakes. A driver's own trouble at the corners: running wide, a trip off the road, a spin, a crash. Contact between cars side by side: a touch, a spin, a car forced off, damage that needs the pits, a car out | Incidents where cars were fighting, with yellows and safety cars through the race control there is |
| 4 **done** | Stewards: who is to blame for a contact, by the FIA's driving standards guidelines, and each series' own penalty for it, served in the race or added to the race time | Investigations and penalties in the timing tower, the feed and on TV, and a result that can change after the flag |
| 5 | Restarts and safety-car queues; the TV director using all of it | Replays of contact, cameras picking side-by-side fights |

**Also agreed**

- Overtaking is re-tuned on the real circuits in `data/circuits` (their real widths are in the data), with pass counts per circuit reported before and after.
- Mechanical failures stay random. Driver incidents move to where cars are fighting, with each series' overall rate kept where it is. (Built in step 3; how close the rates stayed is in the table there.)

### Step 1 as built

How it works is in ARCHITECTURE.md under Lanes. Three things changed beside the passing itself, all for cars only: the slipstream is weaker (a car loses 10% to 12% of its drag 0.3 s behind another, where the classes had 20% to 25%) and thins out faster with distance, as does the wake; and in the race the wing opens over the last 450 m of a DRS zone at most. With the old values every car in a tow passed the one ahead on any long straight.

Overtakes for position after lap 1, Formula 1, each circuit's default race. Before: the one-line model, two races per circuit. After: lanes, three races per circuit. The same seed no longer gives the same race, so the columns are different races, and a single race can be well off these means. The last two columns are with contact and mistakes, and with the stewards.

| Circuit | Width (m) | Before | After step 1 | After step 2 | After step 3 | After step 4 |
|---|---|---|---|---|---|---|
| Austin | 13.9 | 31.0 | 40.0 | 28.7 | 32.0 | 33.0 |
| Brands Hatch | 9.2 | 9.0 | 5.3 | 3.7 | 5.0 | 5.3 |
| Budapest | 10.0 | 27.0 | 9.0 | 9.0 | 11.7 | 11.7 |
| Catalunya | 11.2 | 13.5 | 21.3 | 11.0 | 18.0 | 18.0 |
| Hockenheim | 12.6 | 27.0 | 21.7 | 4.3 | 3.7 | 3.7 |
| Indianapolis | 15.3 | 0.0 | 24.3 | 28.0 | 29.3 | 29.3 |
| Melbourne | 12.3 | 30.0 | 9.7 | 15.3 | 11.0 | 11.0 |
| Mexico City | 12.2 | 57.5 | 59.7 | 53.7 | 46.0 | 45.3 |
| Montreal | 9.7 | 83.0 | 39.0 | 40.7 | 49.0 | 49.0 |
| Monza | 9.4 | 161.5 | 114.0 | 122.7 | 108.3 | 108.3 |
| Moscow Raceway | 11.7 | 17.5 | 35.0 | 32.0 | 17.7 | 18.0 |
| Norisring | 15.9 | 92.5 | 94.3 | 104.3 | 92.0 | 92.0 |
| Nürburgring | 11.8 | 30.0 | 40.0 | 35.0 | 19.3 | 20.3 |
| Oschersleben | 10.6 | 43.5 | 45.3 | 11.0 | 7.0 | 7.0 |
| Sakhir | 13.4 | 83.5 | 70.0 | 50.0 | 56.7 | 55.3 |
| São Paulo | 11.9 | 64.0 | 49.3 | 35.7 | 56.3 | 56.3 |
| Sepang | 14.6 | 47.5 | 50.7 | 43.3 | 52.0 | 50.7 |
| Shanghai | 13.0 | 19.0 | 33.0 | 51.3 | 46.3 | 46.3 |
| Silverstone | 13.8 | 36.5 | 34.7 | 35.3 | 23.3 | 23.3 |
| Sochi | 12.6 | 71.5 | 36.7 | 27.0 | 46.7 | 46.7 |
| Spa | 9.8 | 37.0 | 57.0 | 68.3 | 70.0 | 69.7 |
| Spielberg | 11.0 | 96.0 | 39.3 | 90.0 | 94.7 | 91.7 |
| Suzuka | 9.8 | 15.0 | 63.7 | 64.7 | 69.7 | 69.7 |
| Yas Marina | 12.9 | 76.0 | 67.7 | 82.7 | 99.3 | 102.3 |
| Zandvoort | 10.5 | 20.5 | 39.0 | 38.0 | 32.3 | 32.3 |
| **Mean** | | **47.6** | **44.0** | **43.4** | **43.9** | **43.9** |

GT3, one three-hour race of 30 cars per circuit, before and after: Monza 179 and 129, Spa 169 and 76, Budapest 118 and 36, Suzuka 164 and 35, Silverstone 175 and 141, Brands Hatch 131 and 25, Sakhir 204 and 162; mean 163 and 86. In a 60-minute race of 52 cars in three classes on the test circuit, bodies overlapped for 742 pair-seconds before (755 pairs of cars drove through each other) and for 0.3 after.

Not right yet:

- **Monza** is still too high and **Suzuka** went up a lot: on a long straight a car in the tow with an open wing gets alongside whatever its pace, and the two swap places lap after lap. The wing takes the same share of the drag at every wing level, which probably overstates it at Monza.
- **Budapest and Melbourne** are low. A car has to be clearly quicker to get by there, and few races put such cars together. Budapest also has one DRS zone here and two in reality.
- **GT3** has about half the passes it had. Nothing says which number is nearer the truth: there are no real pass counts for these races in the data.
- **No contact.** A failed pass costs a quarter of a second and nothing else, so drivers risk nothing by trying. The one-line model's random contact after a failed pass is gone for cars. (Step 3 brought contact; drivers still do not weigh the risk of it.)
- **Defending** is one move to the inside by a car that sees the attack coming. No defending on the exit, no forcing a car wide, no weaving rules: the rest belongs with the stewards in step 4. (Step 4 judges contact only; nobody weaves or crowds, so there is nothing of that to judge.)

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
- **The field is past the first corner quickly**: under 4 s for 20 cars, nose to tail in two files. Real fields take longer, because drivers leave more room on cold tyres with a full tank; nobody does here. (Still so after step 3: things can go wrong now, but drivers do not leave room for it.)
- **Mistakes in a pack.** A small mistake still means half speed for a second or two, which a car in the next lane now drives round; in the pack at the first corner that costs several places. (Replaced in step 3: a mistake takes the car wide and costs a fifth of its speed for a few seconds.)

### Step 3 as built

How it works is in ARCHITECTURE.md under Contact and mistakes.

- **A driver's own trouble comes at the corners**, two and a half times as often with a rival within half a second behind or while going for a pass. The car runs wide of its line, leaves the road and comes back when there is a gap, or spins, stands on the verge and turns round; a crash ends on the verge too. Before, trouble was time lost and nothing else: the car stayed on the racing line at half speed, or crawled along it.
- **Contact is decided by rule**, where two cars are side by side through a corner. For every second of it there is a small chance that they touch, larger when one of them has no room left or is braking later than its line allows, and a quarter of it between two cars that are not racing each other for position (one lapping the other, or of two classes). The speed and the overlap decide what comes of it: a touch that costs time, the car ahead turned round by a tap, the car on the outside forced off the road, a broken front wing or a puncture, or a car out (rare in a slow corner, common in a fast one). Cars do not bounce or slide.
- **Damage.** A broken front wing or nose makes a car slower until the pits fit a new one; with a puncture it crawls back for tyres; bodywork costs a little for the rest of the race; and some damage a car only limps back with, to retire in the pits. The time a repair adds to a stop is new in `data/racing.json` (`repairS`: 8 s for Formula 1, 35 s for a prototype, 60 s for a GT car), and is this project's own rough figure, not a looked-up one.
- **A record of each contact**: who was ahead, how far alongside the other was, who was on the inside, who was braking late, who had no room, and what came of it for whom. The stewards of step 4 start from it.
- **Flags** come through the race control there was. A touch brings no flag and no replay on TV; it is in the feed.

**The rates.** Each class has a chance per lap of a mistake, of a trip off and of a crash (`data/racing.json`). Before, every car drew from them once a lap, wherever it was. Now a part comes at the braking points and the rest as contact, set on the real circuits so that the totals stay what they were. Per lap and car, as the class's figure, then measured before and after:

| Class | Races | Mistakes and touches | Trips off, spins and damage | Cars out through the driver |
|---|---|---|---|---|
| Formula 1 | 100 on 25 circuits | 0.020: 0.0196, 0.0186 | 0.003: 0.0032, 0.0031 | 0.0004: 0.00037, 0.00040 |
| GT3 | 30 on 10 | 0.020: 0.0199, 0.0210 | 0.003: 0.0030, 0.0027 | 0.0003: 0.00023, 0.00019 |
| Formula 2 | 12 on 6 | 0.025: 0.0252, 0.0232 | 0.004: 0.0028, 0.0049 | 0.0006: 0.00013, 0.00063 |
| IndyCar | 12 on 6 | 0.020: 0.0191, 0.0160 | 0.003: 0.0023, 0.0028 | 0.0005: 0.00050, 0.00086 |
| Hypercar | 12 on 6 | 0.015: 0.0148, 0.0130 | 0.002: 0.0024, 0.0012 | 0.0002: 0.00015, 0.00029 |
| LMP2 | 12 on 6 | 0.020: 0.0200, 0.0149 | 0.003: 0.0023, 0.0026 | 0.0003: 0.00010, 0.00040 |
| GT4 | 12 on 6 | 0.025: 0.0234, 0.0285 | 0.004: 0.0027, 0.0050 | 0.0004: 0.00048, 0.00099 |
| TCR | 12 on 6 | 0.030: 0.0317, 0.0342 | 0.005: 0.0050, 0.0079 | 0.0008: 0.00095, 0.00228 |

Formula 1 and GT3 were what the shares were set on. The other classes ran twelve races each (two on each of Sakhir, Monza, Budapest, Silverstone, Spa and Suzuka), which is too few to pin down a rate of cars out: one car more or less in twelve races moves it by a fifth or more.

A Formula 1 race, on average over the 100: 5.1 contacts (3.2 touches, 1.7 with a spin, a car forced off or damage, 0.21 with a car out), 1.35 of them on the first lap; besides, as a driver's own trouble, 20.6 mistakes, 2.2 trips off and spins and 0.22 crashes. The safety car came out 0.17 times a race (0.25 before), a virtual safety car 0.22 times (0.23) and the red flag 0.12 times (0.14).

The start, Formula 1, four starts on each of five circuits: 36 places change hands on the first lap (31 after step 2), 23 of them before the first corner; the pole-sitter leads the first lap in 63% of 96 starts (64%).

GT3, one race per circuit, passes after lap 1: Monza 244, Spa 46, Budapest 48, Suzuka 44, Silverstone 125, Brands Hatch 92, Sakhir 73, mean 96 (79 after step 2). Over the 30 GT3 races of the table above, which ran on other seeds, the mean went from 63 to 73.

Several classes together, three six-hour races of 52 cars each. On the test circuit: mistakes and touches from 205 to 199 a race, trips off, spins and damage from 30 to 29, cars out through the driver from 2.3 to 1.3; 39 contacts a race, 11 of them between cars of two classes. At Spa: 151 to 123, 17 to 20 and 1.7 to 2.3.

Seen in the app, in a Formula 1 race at Bremgarten: a car made to spin stood on the grass facing backwards, clear of the road and short of the guardrail, turned round and rejoined, and the TV director cut to a replay of it; a car made to crash stayed on the verge under double yellows; a car given a broken nose showed DMG in the tower and pitted for "repairs, 11.5 s"; and a touch that happened by itself appeared in the feed. Not seen happening by itself on screen: a contact with a spin or a car out.

Not right yet:

- **Contact follows the fighting, circuit by circuit.** A driver's own trouble is the same on every circuit; contact is not. Monza, with three and a half times the average circuit's side-by-side running through corners, has 11 touches a race in Formula 1 where the average is 3, and Brands Hatch, Silverstone and Zandvoort have fewer than 1. On a circuit with far more passing than any real one (the test circuit sees 300 passes a race) a Formula 1 race has about three times the class's figure for cars out. The cause is the passing where it is too high, listed under step 1.
- **Short races have more contact than their class's figures.** The first lap brings 1 to 2 contacts however long the race is, so a 25-minute TCR race had nearly three times its figure for cars out, and GT4 over twice (twelve races each).
- **Some classes make fewer mistakes than their figures**: LMP2 a quarter fewer, IndyCar a fifth, Hypercar an eighth, and Hypercar 40% fewer trips off (twelve races each). Their fields spread out more, so fewer drivers have a rival right behind.
- **GT3 has more passes than after step 2** (73 a race against 63): a driver under pressure runs wide and the car behind is through.
- **Drivers do not weigh the risk.** They go for the same passes as before; contact happens to them. Nobody backs out of a move because it might end in contact, or leaves more room on the first lap.
- **Nobody is at fault.** The record says who was where; nothing is done with it until the stewards (step 4). (Built in step 4.)
- **A contact is between two cars.** A car that spins in the middle of a pack is avoided by all the others (they drive round it, or through it where there is no room): no pile-ups.
- **The race does not know the run-off.** A car that leaves the road stops half a metre clear of its edge wherever that is: on the verge, short of the gravel or asphalt the 3D view draws beyond it. A deeper trip through the gravel needs the race to know those areas.
- **Nothing shows on the car** (see Graphics, phase 4), and a spin leaves no smoke or marks.
- **Bikes** keep their one-line trouble: time lost on the racing line.

### Step 4 as built

How it works is in ARCHITECTURE.md under Stewards.

- **Every contact that cost a car something goes to the stewards**: a spin, a car forced off the road, damage, a car out. A touch does not. They say they are looking at it within a minute and decide two to six minutes after the contact; what is still open at the flag is decided then. (These times are this project's own.)
- **Who is to blame** is decided the same way for every series, by the FIA's driving standards guidelines (version 4.1 of February 2025). A car coming up the inside is entitled to room once its front axle is beside the other car's mirror (70% alongside here), unless it dived in. A car on the outside is entitled to room only when it is ahead. A car that hits one that was entitled to its place is to blame; where both were entitled to theirs, the one that left the other no room; and where it is not clear, nobody is. Formula 1 and Formula 2 judge the first lap more leniently.
- **The penalty is the series' own**, looked up in its 2026 regulations and in decisions of its stewards (the sources are in `data/racing.json` under `stewardsSources`):

| Series | Causing a collision, or forcing a car off | In mitigating circumstances | How it is served | Given too late to serve |
|---|---|---|---|---|
| Formula 1, Formula 2 | 10 s | 5 s | Stood still at the next pit stop before the work begins; added to the race time when the car makes no stop | |
| IndyCar | Drive-through | Warning | Under green, on the next lap, after crossing the line | 30 s added |
| WEC (Hypercar), ELMS (LMP2) | Drive-through | Warning | Within four crossings of the line, not under a neutralisation | In the last 15 minutes: the time the pit lane costs |
| GT World Challenge (GT3) | Drive-through | Warning | Within two crossings of the line, not under a neutralisation | In the last 10 minutes: the time the pit lane costs |
| GT4 European Series | Drive-through | Warning | As GT3 | In the last 10 minutes: 30 s |
| TCR | 5 s | Warning | Added to the race time; decided after the race unless the fault is completely clear | |

- **Serving.** A car with a drive-through comes in at the first chance under green and drives the pit lane at the limit without stopping; it is not a pit stop. What a car has not served when it finishes is added to its race time.
- **The result** is by race time with what the stewards added, so the order can change after the flag; the feed says who lost places to a penalty, and who wins where that changed. The gaps, the results table and the CSV export are the classification's.
- **On screen.** The tower has a box after the row of a car under investigation (INV) or with a penalty (DT, +10). The feed has every investigation, decision and penalty served. The TV broadcast shows a message for each investigation and decision.

**Where a figure rests on little.** The mitigated penalty is written down only for Formula 1 (5 s); for the other series a warning is this project's reading of "a lower level of penalty", and Formula 2's 5 s is taken over from Formula 1. A drive-through for a collision in the WEC is taken over from the ELMS stewards (same organiser); no WEC decision was looked up. IndyCar's 30 s for a drive-through that is not served comes from one race report, and TCR's 5 s from one decision. The first-lap leniency is stewards' practice and in none of the documents. GT4's procedure is GT World Challenge's.

**What the races give.** Per race, on the real circuits (Formula 1: four races on each of the 25; GT3: three on each of ten; the others: two on each of Sakhir, Monza, Budapest, Silverstone, Spa and Suzuka, which is too few for more than an impression):

| Class | Races | Cases | No further action | Warnings | Penalties | Served | Added to the race time | Car already out | Cars classified lower |
|---|---|---|---|---|---|---|---|---|---|
| Formula 1 | 100 | 1.92 | 1.04 | | 0.88 (0.56 of 10 s, 0.32 of 5 s) | 0.46 | 0.34 | 0.08 | 0.19 |
| GT3 | 30 | 2.13 | 1.03 | 0.33 | 0.77 | 0.70 | 0.07 | 0 | 0.07 |
| Formula 2 | 12 | 1.75 | 1.00 | | 0.75 (0.58 of 10 s, 0.17 of 5 s) | 0.17 | 0.50 | 0.08 | 0.50 |
| IndyCar | 12 | 1.67 | 1.00 | 0 | 0.67 | 0.58 | 0 | 0.08 | 0 |
| Hypercar | 12 | 1.42 | 0.75 | 0.25 | 0.42 | 0.25 | 0 | 0.17 | 0 |
| LMP2 | 12 | 1.50 | 0.58 | 0.25 | 0.67 | 0.42 | 0 | 0.25 | 0 |
| GT4 | 12 | 2.25 | 1.33 | 0.25 | 0.67 | 0.42 | 0 | 0.25 | 0 |
| TCR | 12 | 1.92 | 0.75 | 0.33 | 0.83 | 0 | 0.67 | 0.17 | 0.67 |

In Formula 1 a quarter of the cases come from the first lap, and the verdicts over the 100 races are: a racing incident 20%, a car on the outside that was owed no room 19%, a car behind on the outside that turned in on the car ahead 16% (to blame), not far enough alongside on the inside 20% (to blame, half of them mitigated), a first-lap incident 12%, a car that dived in 10% (to blame), not clear 3%. The winner changed in none of the 100 races, and in one of the 12 Formula 2 races. No real counts of penalties per race were looked up to hold these against.

The stewards draw from a random stream of their own, so the races are the same as after step 3 until a penalty is served. Passes for position after lap 1: Formula 1 43.9 a race as before over the 75 races of the table above, and 42.4 against 42.2 over the 100 races of step 3's table; GT3 72.6 against 72.7 over 30 races, and one race per circuit Monza 224, Spa 50, Budapest 45, Suzuka 44, Silverstone 121, Brands Hatch 83, Sakhir 73, mean 91 (96).

Several classes together, three six-hour races of 52 cars at Spa: 10 cases a race, half of them between cars of two classes; 4.7 without further action, 2 warnings and 3.3 drive-throughs, of which 3 were served and the rest were for cars already out.

Seen in the app, at Bremgarten: INV after the rows of two Formula 1 cars under investigation, and "no further action" in the feed; a car with +10 after its row from the second lap; a 5-second penalty with the stewards' message on the TV picture for the investigation and for the decision, and "5 s penalty served" in the feed at the car's stop; a car that finished ninth on the road classified eighteenth with 5 s added, in the tower, the results table and the feed; and a GT3 car with DT after its row driving through the pit lane at the limit, back out with no stop counted.

Not right yet:

- **The stewards see one moment.** Blame comes from where the two cars were when they touched, not from how they got there: no moving under braking, no weaving, no crowding a car off on a straight, which the guidelines also cover.
- **Contact only.** No track limits, no gaining an advantage off the track or giving a place back, no unsafe rejoining, no jump starts, no pit-lane offences (speeding, unsafe release), and nothing in practice or qualifying.
- **Two penalties per series.** No stop-and-go, no heavier penalty for putting a car out or for doing it again, no reprimands, penalty points or grid penalties for a next race. IndyCar's other penalties (to the back of the field at a restart, reordered in the result) are missing.
- **Drivers do not mind.** Nobody races more carefully because a penalty might follow, or once a car is under investigation.
- **A car always serves a drive-through at the first chance**, where a team may use the laps the rules allow.
- **In a race of several classes the fastest class's rules** hold for every car.
- **Bikes** have no stewards: they race in one line and keep no record of contact.

## Graphics, phase 4: the cars

Agreed in the graphics plan of 2026-10-02 as the phase after the surroundings; not started. The look agreed for all phases: stylised but polished; downloaded CC0 assets are fine; heavy effects are fine on the target machine.

A car has 4,000 to 10,000 triangles, which is enough. What makes it look plain is the surface:

- smoother geometry up close;
- more aero detail and panel lines;
- carbon, rubber and glass materials;
- baked shading in the crevices, and contact shadows under the car.

To decide when it starts:

- **Generated or hand-made models.** Hand-made models look better, but need licence-checked generic models, and one per class is a lot of work. The plan so far keeps the generated ones.
- **Visible damage.** Side-by-side racing gives cars damage since step 3 (a broken front wing, a puncture, bodywork), and none of it shows on the car: whether it should (a missing front wing, say) belongs here. A car that has crashed also looks whole.

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
