# Real circuit data

The CSV files in this folder come from the **TUMFTM racetrack database** by the Chair of Automotive Technology,
Technical University of Munich: https://github.com/TUMFTM/racetrack-database (commit `e59595d`, September 2021).
They are licensed under the GNU Lesser General Public License v3.0, reproduced in [LICENSE](LICENSE), and are
included unchanged.

Each row is `x_m, y_m, w_tr_right_m, w_tr_left_m`: a smoothed centreline point and the track width to the right and
left of it, in metres, in the direction of travel, with y pointing north. The centrelines come from OpenStreetMap GPS
data and the widths from satellite images, so accuracy varies by circuit. There is no elevation data.

RaceTrackDesign uses these circuits only to calibrate its lap-time model (`scripts/calibrate.ts`,
`docs/CALIBRATION.md`). Some layouts in the set are older versions (Melbourne, Yas Marina, Catalunya with its
final chicane, Zandvoort before 2020), and `IMS` is the Indianapolis oval; those are not used for calibration.
