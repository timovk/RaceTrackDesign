# Templates

Projects shipped with the app (`src/core/templates.ts` lists them). Each is an ordinary project file on a surveyed terrain (`public/surveys`).

## bremgarten.json: Bremgarten 1954

The Circuit Bremgarten in Bern as raced until 1954, 7.28 km, clockwise.

**Sources**, all from the Federal Office of Topography swisstopo:

- SWISSIMAGE HIST 1946, the aerial photograph of 1946 at 1 m, and sharper crops of it at 0.3 m, for the road as it was.
- The national map 1:25,000 of 1954 (and of 1964, where the road had not changed), for the stretches the trees hide in the photograph.
- swissTLM3D road centrelines of today, where the old road is still a road.
- swissALTI3D for the heights.

**The trace** is in `bremgarten.trace.json`: the lap in sections, clockwise from the Forsthaus hairpin, in Swiss LV95 coordinates (east, north).

- `tlm` sections follow today's road network between the waypoints given (the shortest way, with paths counted five times their length so it keeps to roads). `shift` moves a section sideways, in metres to the right of travel: today's Murtenstrasse is wider than the old one and its centre lies 4 m south of the road in the photograph.
- `manual` sections are points read off the photograph and the maps, where today's road is gone or has moved: the Forsthaus hairpin and the ramp down from Glasbrunnen (now under the motorway junction), the start straight and the old quarry (rebuilt), Eichholz to Eymatt (the motorway crosses it and the road past Jorden was straightened), a stretch across the clearing east of the Tenni corner, and 250 m of the old main road west of Glasbrunnen that has gone back to forest.

**From the trace to the project.** Each section loses the points that lie within the tracing error of the line through their neighbours (1.5 m for hand-traced points, 1.2 m for surveyed ones), and a surveyed section stops 35 m short of a hand-traced one, so that the two meet in a curve and not in a sideways step. The app's spline runs through the 126 points left, and a light smoothing (5 m) takes out what it overshoots. The control points are picked off that line, 10 to 45 m apart, closer where it bends. The result is 7,294 m long (officially 7,280 m) and passes within 3.5 m of every traced point.

**Width**: 9 m throughout, as the road measures in the photograph.

**Start line and pits**: on the Murtenstrasse straight, the pit lane on the south side. The 1946 photograph shows terraces on the forest side there and a strip that looks like the pits on the south side, between about 2,597,570 and 2,597,815 east. The line itself is placed so that the app's grid and pit lane fit on the straight; where it was in 1954 is not established.

**Grading**: the track follows the ground evened out over 60 m, within 8 m of it. It ends up within 4.5 m of the ground everywhere.

**Lap times** for comparison: the race lap record is 2:34.5 (Bernd Rosemeyer, Auto Union, 1936); the fastest Formula 1 race lap is 2:39.7 (Juan Manuel Fangio, Mercedes-Benz W196, 1954). The app's classes are today's cars, which lap far quicker.
