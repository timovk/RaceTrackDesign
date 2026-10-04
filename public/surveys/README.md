# Surveyed terrains

Real ground for the templates of real circuits. `data/surveys.json` lists them; `src/core/survey.ts` reads them.

Each folder holds two gzipped files:

- `height.bin`: the heights, row by row from the north-west corner, as 16-bit little-endian steps above the survey's base. Each value is stored as its difference from the plane through its left, upper and upper-left neighbours (the first row and column from the one neighbour they have).
- `woods.bin`: one byte per cell of a coarser grid over the same map, 1 where woods stand.

## bremgarten

The Bremgartenwald north-west of Bern, 4,096 m square at 2 m, with its north-west corner at 2,595,128 / 1,202,744 in the Swiss LV95 grid (EPSG:2056).

| What | From | Changed how |
|---|---|---|
| Heights | [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d), 2 m grid, 2025 edition | Within 45 m of today's motorway and its ramps (swissTLM3D), and over the junction banks at Eichholz, the ground is filled in from the ground around it (Laplace's equation); the Murtenstrasse keeps its level. The Aare and the Wohlensee lie 3 m under their surface. Heights are rounded to 2 cm. |
| Woods | The green tint of the [national map 1:25,000 of 1954](https://www.swisstopo.admin.ch/en/timetravel) on a 4 m grid, in the part of the map between 2,595,488 and 2,599,328 east, 1,199,472 and 1,201,776 north; today's forest ([swissTLM3D](https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d)) beyond it | Cells under lettering and line work take their neighbours' value; a majority filter over 20 m takes out specks. |

Source: Federal Office of Topography swisstopo. Its geodata is free to use, with the source named ([terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)).
