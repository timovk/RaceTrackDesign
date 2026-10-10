# Roadmap

What is decided and waiting to be built, and what was proposed and never decided. The README's status table lists what is done. Last updated 2026-10-11.

## Side-by-side racing

Decided on 2026-10-05. All five steps are built; what is not right yet is listed under each step.

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
| 5 **done** | Restarts and safety-car queues: the field closes up, lapped cars are sent round by the series' rule, the leader holds the field up and picks its moment, a standing restart goes as the start does; and the TV director using all of it | A restart shown on the front of the field, replays of contact with both cars and again at the penalty, cameras preferring side-by-side fights |

**Also agreed**

- Overtaking is re-tuned on the real circuits in `data/circuits` (their real widths are in the data), with pass counts per circuit reported before and after.
- Mechanical failures stay random. Driver incidents move to where cars are fighting, with each series' overall rate kept where it is. (Built in step 3; how close the rates stayed is in the table there.)

### Step 1 as built

How it works is in ARCHITECTURE.md under Lanes. Three things changed beside the passing itself, all for cars only: the slipstream is weaker (a car loses 10% to 12% of its drag 0.3 s behind another, where the classes had 20% to 25%) and thins out faster with distance, as does the wake; and in the race the wing opens over the last 450 m of a DRS zone at most. With the old values every car in a tow passed the one ahead on any long straight.

Overtakes for position after lap 1, Formula 1, each circuit's default race. Before: the one-line model, two races per circuit. After: lanes, three races per circuit. The same seed no longer gives the same race, so the columns are different races, and a single race can be well off these means. The last three columns are with contact and mistakes, with the stewards, and with the new restarts.

| Circuit | Width (m) | Before | After step 1 | After step 2 | After step 3 | After step 4 | After step 5 |
|---|---|---|---|---|---|---|---|
| Austin | 13.9 | 31.0 | 40.0 | 28.7 | 32.0 | 33.0 | 33.3 |
| Brands Hatch | 9.2 | 9.0 | 5.3 | 3.7 | 5.0 | 5.3 | 5.3 |
| Budapest | 10.0 | 27.0 | 9.0 | 9.0 | 11.7 | 11.7 | 14.0 |
| Catalunya | 11.2 | 13.5 | 21.3 | 11.0 | 18.0 | 18.0 | 19.0 |
| Hockenheim | 12.6 | 27.0 | 21.7 | 4.3 | 3.7 | 3.7 | 3.7 |
| Indianapolis | 15.3 | 0.0 | 24.3 | 28.0 | 29.3 | 29.3 | 33.7 |
| Melbourne | 12.3 | 30.0 | 9.7 | 15.3 | 11.0 | 11.0 | 11.0 |
| Mexico City | 12.2 | 57.5 | 59.7 | 53.7 | 46.0 | 45.3 | 54.3 |
| Montreal | 9.7 | 83.0 | 39.0 | 40.7 | 49.0 | 49.0 | 49.0 |
| Monza | 9.4 | 161.5 | 114.0 | 122.7 | 108.3 | 108.3 | 127.0 |
| Moscow Raceway | 11.7 | 17.5 | 35.0 | 32.0 | 17.7 | 18.0 | 17.0 |
| Norisring | 15.9 | 92.5 | 94.3 | 104.3 | 92.0 | 92.0 | 92.0 |
| Nürburgring | 11.8 | 30.0 | 40.0 | 35.0 | 19.3 | 20.3 | 19.0 |
| Oschersleben | 10.6 | 43.5 | 45.3 | 11.0 | 7.0 | 7.0 | 7.0 |
| Sakhir | 13.4 | 83.5 | 70.0 | 50.0 | 56.7 | 55.3 | 55.3 |
| São Paulo | 11.9 | 64.0 | 49.3 | 35.7 | 56.3 | 56.3 | 53.3 |
| Sepang | 14.6 | 47.5 | 50.7 | 43.3 | 52.0 | 50.7 | 50.7 |
| Shanghai | 13.0 | 19.0 | 33.0 | 51.3 | 46.3 | 46.3 | 46.3 |
| Silverstone | 13.8 | 36.5 | 34.7 | 35.3 | 23.3 | 23.3 | 23.7 |
| Sochi | 12.6 | 71.5 | 36.7 | 27.0 | 46.7 | 46.7 | 49.0 |
| Spa | 9.8 | 37.0 | 57.0 | 68.3 | 70.0 | 69.7 | 63.7 |
| Spielberg | 11.0 | 96.0 | 39.3 | 90.0 | 94.7 | 91.7 | 88.7 |
| Suzuka | 9.8 | 15.0 | 63.7 | 64.7 | 69.7 | 69.7 | 65.7 |
| Yas Marina | 12.9 | 76.0 | 67.7 | 82.7 | 99.3 | 102.3 | 98.7 |
| Zandvoort | 10.5 | 20.5 | 39.0 | 38.0 | 32.3 | 32.3 | 32.3 |
| **Mean** | | **47.6** | **44.0** | **43.4** | **43.9** | **43.9** | **44.5** |

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

### Step 5 as built

How it works is in ARCHITECTURE.md under Race control (the queue, lapped cars and the restart) and under Television (the director).

- **The queue.** The safety car stays out until the track is clear and the field has closed up behind it (no gap over 120 m; it waits three laps for that at most). Every class may go as fast as the fastest class's safety car delta, so the slower classes of a multi-class race catch the queue too. Two cars for the pit entry go in one behind the other (they drove through each other), and a car takes the cheap stop once per neutralisation (some stopped twice).
- **Lapped cars**, by the series' own rule from its regulations: Formula 1 (B5.13) and Formula 2 (Article 40.12) send every lapped car past the queue and the safety car, and the safety car stays out one more lap; the WEC (Article 14, used for the ELMS too) sends every car that is ahead of its class leader on the road, and waits for it. IndyCar, GT World Challenge, GT4 and TCR send nobody. In every series a car caught between the safety car and the leader is waved by.
- **The rolling restart.** The leader slows the field once the safety car is coming in, goes at a point of its choosing over the last 80 to 380 m before the line, and every driver behind follows after a moment of their own. Nobody passes before the line. In IndyCar (7.7.1.3) the leader keeps its pace up to a restart zone and accelerates there.
- **The standing restart** (Formula 1 after a red flag) goes as the start does: the field fans out off the grid and funnels into the first corner, no pass is counted before it, and the stewards treat that lap as a first lap. A lapped car takes the grid slot ahead of it and stays a lap down; before, it drove a lap through the cars standing on the grid to reach a slot a lap further on.
- **The TV director** shows a restart on the front five of the field from the moment the safety car is coming in, and a standing restart from behind the grid as the start was. Two cars side by side for a place count for more than two that are close, and the shot stays on them up to 8 s longer. A contact is replayed with both cars in the picture, and once more when the stewards give a penalty for it; the broadcast keeps every contact for that.

**Restarts, before and after.** The safety car sent out a third of the way into the race; what the 120 s after the green flag bring, per restart:

| Class | Restarts | Passes | Contacts | Leader's speed at the green flag | First ten over the line within | Safety car out for |
|---|---|---|---|---|---|---|
| Formula 1 | 75 on 25 circuits | 1.25, 3.5 | 0.08, 0.32 | 234, 121 km/h | 8.0, 3.7 s | 5.8, 9.9 min |
| GT3 | 14 on 7 | 1.2, 4.6 | 0.07, 0.21 | 166, 113 km/h | 13.3, 3.2 s | 7.3, 10.1 min |
| IndyCar | 12 on 6 | 0.25, 0.25 | 0.08, 0 | 215, 199 km/h | 6.9, 5.8 s | 6.5, 12.0 min |

In Formula 1, 15.5 of the 19 cars running are within 300 m of the leader at the green flag (8.3 before). The safety car is out longer because it waits for the field to close up, which takes a field spread round the lap three to five laps at the pace the delta allows.

Lapped cars: at the Norisring ten lapped Formula 1 cars passed the queue and the safety car in 31 s and were all back on the lead lap at the restart, 0.14 to 0.39 of a lap behind the leader; no bodies overlapped while they went by (five circuits tried). In a six-hour race of three classes at Spa, 14 cars were waved by and 3 passed round, and the GT3 cars sent round restarted 0.1 of a lap behind their class leader where they had been 0.8 to 0.9 behind.

**Whole races** change where a safety car comes out, which is in one Formula 1 race in six. Passes for position after lap 1: Formula 1 44.5 a race over the 75 races of the table above (43.9), and 42.5 against 42.4 over the 100 races of step 3's table; GT3 74.7 against 72.6 over 30 races, and one race per circuit Monza 210, Spa 45, Budapest 42, Suzuka 37, Silverstone 121, Brands Hatch 83, Sakhir 93, mean 90 (91). Three six-hour races of three classes at Spa: 147 passes a race (139), 119 mistakes and touches (129), 17 trips off, spins and cases of damage (18), 3.0 cars out through the driver (3.3).

Seen in the app, at Bremgarten in a Formula 1 race: the director cut to the front five of the field 20 s before a restart, from a trackside camera, and the leader went at 123 km/h some 300 m before the line; a contact made between two cars was shown live on the car that spun and replayed 11 s later from the corner's camera with both cars as its subject; and when the stewards gave a 10-second penalty for it three minutes later, the same seven seconds were replayed again, with the stewards' message and +10 after the car's row in the tower.

Not right yet:

- **Lapped cars at a red flag** stay a lap down. Formula 1 and Formula 2 let them have their lap back before a standing restart.
- **The WEC's drop-back** (the field sorted by class behind the safety car) is not built; the pass-around is.
- **Restart zones** are this project's own (120 to 300 m before the line): IndyCar announces them per event.
- **IndyCar restarts bring few passes** (0.25 in two minutes): the leader does not slow the field, and IndyCar has few passes here anyway.
- **Cold tyres and brakes** at a restart make no difference; a driver's own trouble rises only because everyone has a rival right behind.
- **The safety car** still appears ahead of the leader out of nowhere and vanishes at the pit entry; it does not drive out of and into the pit lane.
- **The director was not seen picking a side-by-side fight by itself** in the app: the rule is tested, the picture is not.
- **Bikes** restart as before.

## Graphics, phase 4: the cars

Built 2026-10-09, on the generated models (no hand-made ones, nothing downloaded). How it works is in ARCHITECTURE.md under Cars.

### Phase 4 as built

- **Smoother geometry up close.** A fourth level of detail for a car longer than 420 pixels on screen, with twice the segments: 25,000 to 35,000 triangles in a body where the full level has 7,000 to 11,000.
- **Aero detail and panel lines.** Vents, louvres, pillars over the glass, exhausts, a wiper, dive planes, tow hooks, diffuser strakes, floor fences and brake drums on a single-seater, dished spoked wheels with a brake disc; and on the level for close-ups the shut lines between the panels.
- **Materials.** Carbon with its weave, tyre rubber with a scuffed tread and lettering on the sidewall, glass that is no longer flat black.
- **Baked shading and contact shadows.** Ambient occlusion per vertex, worked out when a model is built; and under each car a shadow of its own shape in place of the oval.
- **Visible damage** (it was open whether this belonged here; built as the last part). A broken front wing or splitter is gone, a car that was hit is scratched, a punctured tyre is flat, a car that crashed out is a wreck. A replay shows the car as it was.

Seen in the app, at Bremgarten on the grid: Formula 1, Hypercar, LMP2, GT3 and TCR cars and a MotoGP bike close up, in High and in Basic graphics; a Formula 1 car without its front wing, a wrecked Formula 1 car and a wrecked GT3 car, and a flat tyre by its numbers (the wheel 6 cm lower, the car leaning towards it).

Not right yet:

- **The frame time was not measured.** The timer in the browser pane read 1.5 ms a frame, which cannot be right. By the counts it should cost little: with 52 cars on the grid 2 took the close-up level, 6 the full, 18 the medium and 26 the far one, some 350,000 triangles for all cars in a scene of three million.
- **A model takes 0.1 to 0.2 s to build** where it took a few milliseconds: half a second at the first start of a race of three classes, then never again in that session.
- **Glass is not see-through.** There is no cabin, no driver and no roll cage in a closed car.
- **The shut lines show only close up**, and the carbon weave only from a metre or two.
- **Damage is rough.** The sun's shadow and the shading of the picture's finish still show a wing that is gone; a flat tyre is a wheel sunk into the road, not a tyre off its rim; which wheel is flat goes by the car's number and where the scratches are by chance, not by where the car was hit; no parts lie on the road.
- **The shapes are the same.** Proportions, headlights and tail lights are as they were; there are no sponsors' logos; bikes got the finer level, the shading and the shadow, and no new parts.
- **Tyres** show no wear, and wet tyres no grooves.
- **Not looked at**: Formula 2, IndyCar, GT4, the superbike and the safety car close up; cars in the rain; a race played through with real damage (the damage seen was set by hand).

## Graphics, phase 5: a quality setting

Agreed in the same plan; not started. Low to Ultra, so slower machines stay smooth with 50 cars or more. Today there is only High and Basic (Basic leaves out the picture's finish).

## Left over from graphics phases 1 to 3

In the original plan, and not built in those phases. Not decided either way; listed so they are not lost.

- Motion blur for the TV cameras.
- Grass up close.

Built since (2026-10-09): skid marks on the asphalt, advertising boards and gantries, crowds in the grandstands and a more detailed pit building. How they work is in ARCHITECTURE.md under 3D view (Scenery) and, for the marks a race leaves, under Contact and mistakes.

### Trackside as built

- **Advertising boards** stand in front of the guardrail along the start straight and round the outside of the corners, a metre high, each sign 4.2 m long. The signs are sixteen words from racing ("GRAND PRIX", "POLE POSITION", "APEX"), not real companies.
- **Gantries**: one over the start line with the housings of the start lights, and a bridge with boards over up to two straights of 300 m or more, away from the line.
- **The crowd** fills 84% of the seats of every grandstand, as seated figures in a dozen colours (4,663 people at Bremgarten).
- **The pit building** has a number over every garage, a glazed upper floor, a parapet, a race control tower and a podium at the end nearer the line, the teams' timing stands on the pit wall and painted lines in the lane.
- **Tyre marks**: rubber worn into the braking points of the lap, and what a race's cars leave (wheelspin off the grid, locked wheels at a mistake or a late lunge, the slide of a spin), which stays for the race and is left out of a replay of an earlier moment.

Seen in the app, at Bremgarten: all of the above, the signs reading the right way round from the track and from both sides of a bridge, and a replay of a moment 13 s back drawn without a spin's marks made since.

Found on the way and fixed: sunlight came through the front of the pit building onto the garage floors (only faces turned from the sun cast shadows; the building now casts from every face).

Not right yet:

- **The start lights do not light.** The housings hang under the gantry; the lights of the start are still only in the TV graphics.
- **The crowd sits still**, and every stand is as full as the next whatever the session.
- **No pit boxes are painted** in the lane, and the garages are empty when no car is in them.
- **Marks only in 3D**: the 2D map shows none.
- **Marks do not wear away** or get rained off, and they do not build up over a weekend: a race starts on a road with only the worn-in rubber. Practice and qualifying leave none.
- **A mark is drawn from the middle of the car**: the locked wheels are the front ones, and in a spin the car's four wheels would each draw a line.
- **Bridges were looked at on Bremgarten only**, which has none of its own at 400 m and gets two at the 300 m chosen; other circuits were not looked at.
- **No bridge carries a road or people**, and the boards stand only at the line and the corners, not along every straight a camera sees.
- **The worn-in rubber follows the GT3 car's braking points** for every class (the reference class, as for the sector lines); it was looked at in the app with the Formula 1 lap, before that was settled.
- **Bikes** leave no marks.

## Historic content

Asked for on 2026-10-09 as "version 1 of the Historic Content Update: 1950-shaped F1 cars, and the 1950 Monaco GP layout template". Chosen then: the cars as a class of their own at the pace of 1950, with the rules of 1950 as far as the app has them; real data downloaded for Monaco; and for version 1 the road, the ground and the sea only.

### Version 1 as built

- **The Formula 1 of 1950**: a class beside today's, to the Alfa Romeo 158's figures, its grip fitted to the pole laps of 1950 at Monaco and Bremgarten; a 3D model of its own; races of 300 km with fuel stops, breakdowns, no safety car and warnings only. README, "The Formula 1 of 1950".
- **Monaco 1950**: the 3.18 km lap of 1929 to 1954 as a template, on IGN France's ground, traced from today's streets and an aerial photograph of the 1950s. README, "Monaco 1950"; sources and method in `data/templates/README.md` and `public/surveys/README.md`.

Seen in the app: the template in 2D and 3D, the car close up on the grid and on the hill, and a race of twelve cars running its first laps.

Not right yet:

- **No buildings, no tunnel, no railway**: Monaco is a road on a bare hill by the sea. The tunnel is a cutting.
- **Today's ground and shore**, with the piers and quays built since 1950.
- **Today's dressing**: guardrail, red and white kerbs, catch fencing, run-off, the app's grandstands and pit building. In 1950 there were kerbstones, lamp posts, straw bales and the harbour's edge.
- **The pits** are on the town side of the boulevard; they stood between the boulevard and the quay.
- **The grid** is two abreast; it was three and two by turns.
- **The Gasworks hairpin** is placed by the lap length, within some 25 m; **the Casino square** is read off a photograph that is not sharp there.
- **One shape of car** for the whole field: the Alfa Romeo. The Ferraris, Maseratis, Talbots, ERAs and Gordinis looked different and were slower; here the spread in pace stands for that.
- **The driver does not move**: no arms at work, no head in the wind.
- **Figures that rest on little**: fuel use, tank, refuelling rate, tyre life, and the rates of mistakes and breakdowns.
- **The first-five-on-Thursday rule** of the Monaco grid, and points, are not in.
- **Not looked at**: a whole race at Monaco in the app (the 300 km were run on the test circuit only), the car in the rain, the wreck and flat-tyre looks on this car, Bremgarten with this class in 3D.

### Ideas for a version 2 (proposed, not decided)

- Buildings as plain blocks along the lap, and the tunnel.
- A dressing of the day: no kerbs or guardrail, straw bales, the pits on the strip by the quay, a grid of three and two.
- More shapes of car, and the other circuits of 1950 (Bremgarten is there already).

## The track generator

Asked for on 2026-10-10: "Implement the race track generator. Make sure the user is able to pick parameters, like preferred track length, track width, high/low elevation, lots of corners or lots of high-speed sections". Chosen then: the track goes on the best spot of the map there is, and the landscape is left alone; sliders, plus kinds of circuit that set them all at once; beyond the basics the class and its licence, straights and overtaking, the make-up of the corners, and shape and direction; and several tracks to pick from, repeatable by a seed.

Asked for later the same day, after trying it: "Track generator should be more extreme. If I select extreme variables, the track generator should allow those. Folding back on itself should also be more folding."

And on 2026-10-11, of a Grand Prix circuit at its defaults lengthened to 17.9 km, which came out as a plain loop with clusters of wavy parallel fingers: "Not sure if I was looking for these Caesar Palace-esque corners.. This just sucks, plain said."

### As built

- **Design, Generate a track.** A dialog with seven kinds of circuit, twelve sliders, seven tick boxes, the class and the direction, and a seed. Generate offers six tracks as cards (the lap drawn, length, corners, height difference, straights, the class's lap and top speed, heavy braking points, the licence verdict, and what the map or the lap had no room for). Use this track makes one the design in one step that Undo takes back.
- **How it works** is in ARCHITECTURE.md (Track generator): laps drawn as polygons with rounded corners, sorted on shape, tried all over the map, and the best built and measured with the app's own analysis and licence check.
- **The ends of the sliders** (the second request). The first version drew every lap much the same whatever was asked: the corners slider moved a 5 km lap from 3.1 corners a kilometre to 1.6, and folding back at its maximum left 17% of the lap with another part within 120 m, against 15% at the default. Now, on the same map and 5 km: 6.8 corners a kilometre at one end (with straights of 400 and 300 m) and 1.4 at the other; folding back at its maximum 66% of the lap, 73% with short straights, as rows of parallel legs joined by turns right round, 34 m apart for a track 12 m wide; a straight of 2 km on a 5 km lap comes out at 1.9 km on six tracks of six (it was 1.6 km on the one track that could be made); laps of 1 km and of 20 km are made (they were held to 1.2 and 14 km), and tracks 30 m wide (held to 20 m).
- **A circuit, not a pattern** (the third). The second version put the rows of legs in the middle of the fold slider too, as many as the lap was to have corners, and made up the corners with regular zigzags and legs swinging in step; on a long lap that was most of the lap. Now the middle of the slider gives arms: the lap goes off to one side and comes back, each arm of its own width, depth and lean. Corners come from bends at every scale, a long edge first and then its pieces, each pushed to one side, as an S or as a bay. Rows of legs are for the top fifth of the fold slider only. Judged on drawn sheets of six tracks for each kind of circuit, each end of each slider, and laps of 1 to 20 km, not on figures alone.
- **What is set is what is built.** Building to a licence no longer raises the width, the lap length and the start straight or holds the longest straight down: it says which settings stand in the way, and the card says the check fails. This is my reading of "should allow those"; the first version did the opposite on the answer "class sets least width, straight and run-off needs".
- **The licence check itself** counted a long corner that opens onto a straight as blocked by "another part of the track": the path of a car running wide at its end follows the straight, and after 300 m the check took that straight for an obstacle. Fixed in `licence.ts` (it failed hand-drawn tracks the same way). Without the fix three of twelve Grand Prix circuits of 12 and 17.9 km fail on it; with it none.
- **Checked**: on the rolling, hilly and mountain landscapes at 8 km and a rolling one at 16 km. On rolling ground (one seed), all 18 of the Grand Prix, motorcycle and high-speed circuits pass the licence they are built to (FIA grade 1, FIM Grade A, FIA grade 2), in under two seconds for six; Grand Prix circuits of 3.5, 8, 12 and 17.9 km pass six of six each, the longest in four and a half seconds. The kinds built to no licence take half a second to one. Every track is within 1% of the length asked.

### Not right yet

- **Long laps look alike.** At 18 to 20 km the six are all a big loop with a dozen arms and bays round it: irregular, but of one family. A circuit that long could also be a road out to a far point and back, or two loops joined; the generator draws one loop.
- **Short laps with long straights are plain.** A 1.5 km club circuit or a 3.5 km Grand Prix circuit with its kind's straights (550 and 400 m; 1,050 and 700 m) is two straights and four to seven corners: there is no lap left for more. The dialog does not shorten the straights when the length is lowered.
- **The high-speed circuit** is a box with a chicane: at so few corners the loop is all there is.
- **The twisty end with long straights.** With the default straights (900 m and 600 m of a 5 km lap) the most corners is about 22, 4.3 a kilometre: the two straights carry none. The nine a kilometre the slider stands for is of the lap without them, and the lap reaches 6.8 with short straights, not nine: half the laps drawn that twisty come too near themselves and are thrown away.
- **How much can fold.** At the maximum two thirds of a 5 km lap has another part within 120 m, not all of it: the longest straight and the start straight take 1.5 km, and the loop they are on is left open on one side. Shorter straights fold more.
- **Legs or turns.** At the top of the fold slider the number of pairs of legs follows "corners or speed": few long ones for a fast lap, many short ones for a twisty one. That was my choice; nothing was asked about it.
- **Fast corners and arms.** A lap asked nothing but fast corners gets them on one loop (nine in ten), but with arms on it about half: an arm's end is a turn right round or two corners close together.
- **Compact without folding does little.** With folding at nothing, compact against spread out changes how far the lap is across from 43% of its length to 35%: a lap of one loop is that far across whatever its shape.
- **The sweeper needs room.** It wants two straights of 380 m, and often finds none; the card says so.
- **The six do not stand apart on the map.** Each takes its own best place, and several often lie on the same spot. Nothing spreads them out.
- **Height on rough maps.** On the mountain landscape a lap asked to climb 160 m gets 30 to 50 m on five tracks of six and 130 m on one, and on the hilly one a lap asked 300 m gets about 75 m: the generator keeps off slopes over 16% and does not touch the grading to make a steep place work (evening the profile out over a longer stretch was tried, and made the slopes worse where the cut and fill limit binds). The card says so.
- **Run-off is estimated before building.** The speeds are rough, and water or the edge of the map beyond a corner is not looked at until the track is built and the licence check runs. That check is the judge, and a track that fails says so on its card.
- **Many control points.** About 110 on a 5 km track, 230 on a twisty one and 450 on 20 km, one every 18 degrees of every corner: easy to nudge, slow to reshape by hand.
- **On the main thread**: the page stands still for a moment at a time while the tracks are made. It is not in a worker.
- **No crossings and no banking**, as the app has neither.
- **The kinds of circuit and the ranges are my own**: the seven kinds, their numbers and how far each slider goes are not from a source.

### Measured against real circuits (2026-10-11)

After the third round he rated the generator "6/10; it's working now, but still far from the best it could be". The 25 real circuits in `data/circuits` and 36 generated Grand Prix circuits (4.3, 5.4 and 6.5 km, two seeds, six each, rolling map) were put through the same analysis (`analyseTrack`). Middle value, and the range that holds four in five:

| | Real circuits | Generated |
|---|---|---|
| Share of its own hull the lap encloses | 0.65 (0.49 to 0.79) | 0.92 (0.83 to 0.96) |
| Turning per kilometre | 308° (235 to 370) | 202° (170 to 285) |
| Corners per kilometre | 3.2 (2.2 to 4.2) | 2.4 (2.1 to 2.6) |
| Corners tighter than 45 m at the apex | 64% (35 to 78) | 33% (20 to 50) |
| Corners faster than 120 m | 6% (0 to 23) | 14% (0 to 23) |
| Share of a corner within a fifth of its tightest | 19% (13 to 24) | 34% (30 to 41) |
| Lap with another part within 120 m | 32% (0 to 59) | 13% (8 to 18) |
| Longest straight, and the next, as shares of the lap | 14% and 9% | 18% and 14% |
| Corners that turn the other way from the one before | 67% | 53% |

What it says: a generated lap is a blob with things on it (it fills nine tenths of its hull, a real circuit two thirds: real circuits wrap round themselves); it turns a third less and has fewer, gentler corners than the Grand Prix kind should; its corners are arcs of one radius where real ones tighten and open; and the six are far more alike than real circuits are. The kinds of circuit and the meaning of the sliders were set by judgement, not against these.

The probe is not in the repo (scratch: `real.test.ts`); the table is what to beat.

### Ideas for the next version (proposed, not decided)

1. **Real circuits as the yardstick.** Set the kinds of circuit and the middle of each slider from the table; keep the measurement in the repo as a test (so many of the measures within the real range) and as part of the ranking. Small.
2. **Another way of laying out a lap.** Not one loop with things on it. Either a lap put together from sectors (a main straight, a slow complex, a fast run out and back, a stadium), each from a few forms and joined, which is how circuits are designed and gives different families of lap; or corners and straights drawn in sequence from the real circuits' own figures and closed. Large; it is what the hull, turning and likeness figures ask for.
3. **Corners with an anatomy.** Corners that tighten or open, two apexes, a hairpin that is not half a circle, chicanes of more than one kind. Medium.
4. **The land first.** The lap is drawn blind and a place looked for. Instead: the start straight on the flattest strip, the lap along the contours and over the hill on purpose, so that the height asked is reached at gentle gradients (a mountain map now gives 30 to 50 m of 160 asked). Large.
5. **Choosing as designing.** Six that differ (in form and in place), each shown on the map with its height profile and not as a thumbnail, "more like this one", and keeping part of a lap while the rest is drawn again. Medium.
6. **Ranked as a place to race.** The lap simulation and the overtaking analysis are there: rank by places to pass, range of corner speeds and rhythm, and offer a target lap time. Medium.
7. **A lap that can be edited.** Thirty to fifty control points for 5 km, at the corners, not 110. Small to medium.

## Proposed, not decided

- Projects and backups.
- Bridges and crossovers.
- Banking and ovals.
- A championship across circuits (with sprint races and points).
- Night races.
- Sound.
- More templates of real circuits, made the way Bremgarten was (`data/templates/README.md`).
- Side-by-side racing for bikes, after the car version.
