/**
 * Real circuits from the TUMFTM racetrack database (data/circuits, LGPL-3.0):
 * CSV rows of centreline x, y and the track width to the right and left, in
 * metres, in the direction of travel, with y pointing north. Used to
 * calibrate the lap-time model; they carry no elevation.
 */
import type { ControlPoint, TrackDesign } from './track.ts';

export interface CircuitRow {
  x: number;
  y: number;
  wRight: number;
  wLeft: number;
}

export function parseCircuitCsv(text: string): CircuitRow[] {
  const rows: CircuitRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(',').map(Number);
    if (parts.length < 4 || parts.some((v) => !Number.isFinite(v))) throw new Error(`Bad circuit row: "${trimmed}"`);
    rows.push({ x: parts[0], y: parts[1], wRight: parts[2], wLeft: parts[3] });
  }
  if (rows.length < 10) throw new Error('A circuit needs at least 10 rows.');
  return rows;
}

/**
 * Turns circuit rows into a track design in world coordinates (y south):
 * the centreline is moved to the true middle of the track, since the
 * database's smoothed line is not centred, and the width becomes symmetric.
 */
export function circuitDesign(rows: CircuitRow[]): TrackDesign {
  const n = rows.length;
  const points: ControlPoint[] = rows.map((r, i) => {
    const prev = rows[(i - 1 + n) % n];
    const next = rows[(i + 1) % n];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    // Right normal with y pointing north.
    const rx = ty / len;
    const ry = -tx / len;
    const shift = (r.wRight - r.wLeft) / 2;
    return { x: r.x + rx * shift, y: -(r.y + ry * shift), width: r.wRight + r.wLeft };
  });
  return { points, defaultWidth: 12, grading: { smoothing: 0, maxCutFill: 0 } };
}
