/** CSV exports of a race: the classification, every lap, and a telemetry trace. */
import type { RaceSim } from './sim.ts';
import type { Telemetry } from './telemetry.ts';

type Cell = string | number | null;

/** RFC 4180 CSV: fields with commas, quotes or line breaks are quoted; numbers are written as given. */
export function toCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function cell(v: Cell): string {
  if (v === null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? String(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function resultsCsv(sim: RaceSim): string {
  const winner = sim.order[0];
  const rows: Cell[][] = [['Position', 'Number', 'Driver', 'Code', 'Team', 'Laps', 'Race time (s)', 'Gap (s)', 'Laps behind', 'Best lap (s)', 'Best lap on', 'Stops', 'Grid', 'Status']];
  for (const car of sim.order) {
    const e = car.entrant;
    const g = sim.gap(car);
    let best: (typeof car.history)[number] | null = null;
    for (const h of car.history) if (!best || h.time < best.time) best = h;
    const status = car.status === 'retired' ? `DNF: ${car.retired?.reason ?? ''}` : car.status === 'finished' ? 'Finished' : 'Running';
    rows.push([
      car.status === 'retired' ? null : car.position, e.number, e.name, e.code, e.team, car.lapsDone,
      car.finishTime !== null ? r3(car.finishTime) : null,
      car === winner ? 0 : g.kind === 'time' ? r3(g.value) : null,
      g.kind === 'laps' ? g.value : car === winner || g.kind === 'time' ? 0 : null,
      best ? r3(best.time) : null, best?.lap ?? null, car.stops, car.gridPosition, status,
    ]);
  }
  return toCsv(rows);
}

export function lapsCsv(sim: RaceSim): string {
  const compounds = sim.model.rules.tyres.compounds;
  const rows: Cell[][] = [['Number', 'Code', 'Lap', 'Lap time (s)', 'S1 (s)', 'S2 (s)', 'S3 (s)', 'Position', 'Gap to leader (s)', 'Race time (s)', 'Compound', 'Tyre laps', 'Tyre wear (%)', 'Fuel (kg)', 'Pit', 'Speed trap (km/h)']];
  for (const car of sim.order) {
    for (const h of car.history) {
      rows.push([
        car.entrant.number, car.entrant.code, h.lap, r3(h.time), r3(h.sectors[0]), r3(h.sectors[1]), r3(h.sectors[2]), h.position,
        r3(h.gap), r3(h.at), compounds[h.compound].name, h.tyreLaps, r1(h.wear * 100), r1(Math.max(0, h.fuel)), h.pit ? 'yes' : '',
        Number.isFinite(h.trap) ? r1(h.trap * 3.6) : null,
      ]);
    }
  }
  return toCsv(rows);
}

/** One lap's channels, optionally with a second lap alongside and the time delta between them. */
export function telemetryCsv(a: Telemetry, b: Telemetry | null, delta: Float64Array | null, labelA: string, labelB = ''): string {
  const head: Cell[] = ['Distance (m)'];
  const cols = (label: string) => [`${label} time (s)`, `${label} speed (km/h)`, `${label} throttle (%)`, `${label} brake (%)`, `${label} gear`, `${label} lateral (g)`, `${label} longitudinal (g)`];
  head.push(...cols(labelA));
  if (b) head.push(...cols(labelB), `Delta ${labelB} vs ${labelA} (s)`);
  const rows: Cell[][] = [head];
  const values = (tl: Telemetry, i: number): Cell[] => i < tl.count
    ? [r3(tl.t[i]), r1(tl.v[i] * 3.6), Math.round(tl.throttle[i] * 100), Math.round(tl.brake[i] * 100), tl.gear[i], r3(tl.latG[i]), r3(tl.lonG[i])]
    : [null, null, null, null, null, null, null];
  for (let i = 0; i < a.x.length; i++) {
    if (i >= a.count && (!b || i >= b.count)) continue;
    const row: Cell[] = [r1(a.x[i]), ...values(a, i)];
    if (b) row.push(...values(b, i), delta && Number.isFinite(delta[i]) ? r3(delta[i]) : null);
    rows.push(row);
  }
  return toCsv(rows);
}
