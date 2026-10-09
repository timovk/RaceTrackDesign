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

## monaco.json: Monaco 1950

The Circuit de Monaco as raced from 1929 to 1954 and for the first world championship Grand Prix on 21 May 1950: 3.180 km, clockwise.

**Sources**:

- OpenStreetMap, the street centrelines of Monaco (Overpass API, October 2026), for the streets that are still where they were. (c) OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
- IGN France, the aerial photographs of 1950 to 1965 (`ORTHOIMAGERY.ORTHOPHOTOS.1950-1965` on the Geoplateforme), for what has changed: it shows the harbour before the swimming pool of 1961, the gasworks at its south-west corner and the old station above Portier. Licence Ouverte 2.0.
- IGN France, RGE ALTI, for the heights (see `public/surveys/README.md`).
- The lap length, the place of the start line and the dates of the changes from the [English Wikipedia's article on the circuit](https://en.wikipedia.org/wiki/Circuit_de_Monaco).

**The trace** is in `monaco.trace.json`, in metres east and south of the north-west corner of the survey's map (a 2,048 m square laid on the ground at 7.4258 E, 43.7368 N).

- Today's streets are followed between points on the named streets, the shortest way: the Boulevard Albert Ier northwards, Sainte-Devote, the Avenue d'Ostende and the Avenue de Monte-Carlo up to the Casino, the Avenue des Spelugues down through Mirabeau and the Station hairpin, the Avenue Princesse Grace to Portier, and the Boulevard Louis II where the tunnel is.
- Drawn by hand over the photograph: the Casino square, round the west side of the garden that stood in it (the square was rebuilt in 2020); Portier without today's roundabout; the chicane, left and right off the road from the tunnel onto the quay; Tabac, the left-hander at the corner of the harbour.
- The north quay is a straight line read off the photograph. The quay road down the west side is the boulevard's line 18 m to the east of it, as the photograph has the two roads, with their rows of trees between them.
- The Gasworks hairpin is half a circle of 9 m where the boulevard and the quay road end, in front of the gasometers. The photograph does not show where exactly the cars turned: between the end of the trees and the gasometers there are some 50 m. The two roads are carried on 76 m beyond the end of today's street, which makes the lap 3,179 m.

**Read with care**: points drawn by hand are good to 3 to 5 m. The Casino square is the least certain: the line passes west of the garden, with the garden on the inside of the right-hander, which is the simple line through the square and is what today's lane does; a line between the garden and the Casino would be some 50 m longer overall with the hairpin where it is.

**From the trace to the project**: the lap loses the points that lie within 0.8 m of the line through their neighbours and any point within 4 m of the one before; the app's spline runs through the 102 left.

**Width**: 8 m throughout. The boulevard was wider and some of the streets narrower; with 8 m the two roads along the harbour are the 10 m apart the app wants for its barriers.

**Start line and pits**: the line is on the Boulevard Albert Ier, where it was until 1954 (it moved to the quay in 1955 and back in 1963). The pit lane is on the town side of the boulevard; in 1950 the pits stood on the strip between the boulevard and the quay, where the app has no room for a lane.

**Grading**: the track follows the survey's ground evened out over 12 m, within 3 m of it; the survey itself has the ground beside the road levelled to the road (see there). The lap rises from 2.7 m to 42.4 m and is nowhere steeper than 9.4%.

**Lap times** for comparison: pole in 1950 was 1:50.2 and the fastest race lap 1:51.0, both Juan Manuel Fangio's in an Alfa Romeo 158; Rudolf Caracciola's 1:46.5 of 1937 in a Mercedes-Benz W125 stood as the record of the layout. The app's Formula 1 car of 1950 laps the template in 1:51.6; today's cars lap it in about a minute.
