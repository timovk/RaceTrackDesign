/**
 * Drawing of the circuit facilities on the map: pit lane and garages, grid
 * slots, speed trap, DRS zones, overtaking spots, marshal posts and run-off
 * escape paths, plus the handles that move the start line, pit entry, pit
 * exit and speed trap in Analyse mode.
 */
import type { Store } from './store.ts';

export type Handle = 'start' | 'pitEntry' | 'pitExit' | 'speedTrap';

export const HANDLE_LABELS: Record<Handle, string> = {
  start: 'Start',
  pitEntry: 'Pit in',
  pitExit: 'Pit out',
  speedTrap: 'Speed',
};

export interface LayerContext {
  ctx: CanvasRenderingContext2D;
  store: Store;
  scale: number;
  sx: (x: number) => number;
  sy: (y: number) => number;
}

const PIT_ASPHALT = '#34373d';
const GARAGE = '#8d96a1';
const SPEED_TRAP = '#b48cf7';
const DRS = '#22c55e';
const MARSHAL = '#f59e0b';
const HANDLE = '#ffffff';

/** Stations of the draggable handles on the current track. */
export function handleStations(store: Store): { handle: Handle; station: number }[] {
  const f = store.facilities;
  if (!store.track || !f || !store.performanceCurrent) return [{ handle: 'start', station: 0 }];
  const out: { handle: Handle; station: number }[] = [{ handle: 'start', station: 0 }];
  if (f.pitLane) out.push({ handle: 'pitEntry', station: f.pitLane.entry }, { handle: 'pitExit', station: f.pitLane.exit });
  out.push({ handle: 'speedTrap', station: f.speedTrap.station });
  return out;
}

/** Everything but the handles; skipped while the facilities belong to an older version of the track. */
export function drawFacilities(c: LayerContext): void {
  const s = c.store;
  const t = s.track;
  const f = s.facilities;
  if (!t || !f || !s.performanceCurrent) return;
  const ctx = c.ctx;

  // Pit lane: garages first, then the lane itself.
  const pit = f.pitLane;
  if (pit) {
    const lanePx = Math.max(2.5, pit.width * c.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Garages: a strip beyond the lane along the pit boxes.
    const off = (pit.width / 2 + 7) * pit.side;
    ctx.beginPath();
    for (let i = pit.boxStart; i <= pit.boxEnd; i++) {
      const j = Math.min(pit.x.length - 1, i + 1);
      const i0 = Math.max(0, i - 1);
      const hx = pit.x[j] - pit.x[i0];
      const hy = pit.y[j] - pit.y[i0];
      const len = Math.hypot(hx, hy) || 1;
      // Left normal of the lane direction, scaled to the garage offset.
      const gx = pit.x[i] + (hy / len) * off;
      const gy = pit.y[i] - (hx / len) * off;
      if (i === pit.boxStart) ctx.moveTo(c.sx(gx), c.sy(gy));
      else ctx.lineTo(c.sx(gx), c.sy(gy));
    }
    ctx.strokeStyle = GARAGE;
    ctx.lineWidth = Math.max(2, 12 * c.scale);
    ctx.lineCap = 'butt';
    ctx.stroke();
    ctx.lineCap = 'round';
    path(c, pit.x, pit.y);
    ctx.strokeStyle = '#15171b';
    ctx.lineWidth = lanePx + 2;
    ctx.stroke();
    ctx.strokeStyle = pit.problems.length ? '#7a3434' : PIT_ASPHALT;
    ctx.lineWidth = lanePx;
    ctx.stroke();
    if (c.scale * pit.width > 14) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // DRS zones: a green stripe along the left edge.
  ctx.lineWidth = 3;
  ctx.strokeStyle = DRS;
  for (const z of f.drsZones) {
    ctx.beginPath();
    const len = z.end >= z.start ? z.end - z.start : t.n - z.start + z.end;
    for (let i = 0; i <= len; i++) {
      const k = (z.start + i) % t.n;
      const x = c.sx(t.leftX[k]);
      const y = c.sy(t.leftY[k]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const k = z.start;
    label(c, t.leftX[k], t.leftY[k], 'DRS', DRS, '#062b12', -14);
  }

  // Grid slots once they are big enough to see.
  if (c.scale * 5 > 3) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const g of f.grid) {
      ctx.save();
      ctx.translate(c.sx(g.x), c.sy(g.y));
      ctx.rotate(g.heading);
      ctx.fillRect(-2.5 * c.scale, -1 * c.scale, 5 * c.scale, 2 * c.scale);
      ctx.restore();
    }
  }

  // Overtaking spots: small markers where braking starts.
  for (const o of f.overtaking) {
    const x = c.sx(t.x[o.station]);
    const y = c.sy(t.y[o.station]);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ff9f1c';
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Marshal posts.
  const showNumbers = c.scale > 0.35;
  for (const p of f.marshals.posts) {
    const x = c.sx(p.x);
    const y = c.sy(p.y);
    ctx.fillStyle = MARSHAL;
    ctx.fillRect(x - 3, y - 3, 6, 6);
    if (showNumbers) {
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.fillStyle = '#ffd08a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(p.number), x, y - 4);
    }
  }

  // Speed trap: a violet bar across the track.
  const k = f.speedTrap.station;
  bar(c, k, SPEED_TRAP, 3);

  // Run-off escape paths for the chosen grade.
  const grade = s.view.runoffGrade;
  const lic = s.licence;
  if (grade && lic) {
    for (const r of lic.runoff) {
      if (r.grade !== grade) continue;
      ctx.beginPath();
      ctx.moveTo(c.sx(r.x0), c.sy(r.y0));
      ctx.lineTo(c.sx(r.x1), c.sy(r.y1));
      ctx.strokeStyle = r.pass ? 'rgba(74,222,128,0.9)' : 'rgba(255,77,79,0.95)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (!r.pass) {
        ctx.beginPath();
        ctx.arc(c.sx(r.x1), c.sy(r.y1), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ff4d4f';
        ctx.fill();
      }
    }
  }
}

/** Handles for dragging facilities (Analyse mode). */
export function drawHandles(c: LayerContext, dragging: { handle: Handle; station: number } | null): void {
  const s = c.store;
  const t = s.track;
  if (!t) return;
  const ctx = c.ctx;
  for (const h of handleStations(s)) {
    const station = dragging?.handle === h.handle ? dragging.station : h.station;
    const x = c.sx(t.x[station]);
    const y = c.sy(t.y[station]);
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = h.handle === 'speedTrap' ? SPEED_TRAP : h.handle === 'start' ? '#f4f4f4' : '#6b7280';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = dragging?.handle === h.handle ? '#3fb6ff' : '#111';
    ctx.stroke();
    label(c, t.x[station], t.y[station], HANDLE_LABELS[h.handle], HANDLE, '#111', -18);
  }
}

function path(c: LayerContext, xs: Float64Array, ys: Float64Array): void {
  const ctx = c.ctx;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    if (i === 0) ctx.moveTo(c.sx(xs[i]), c.sy(ys[i]));
    else ctx.lineTo(c.sx(xs[i]), c.sy(ys[i]));
  }
}

function bar(c: LayerContext, k: number, color: string, width: number): void {
  const t = c.store.track!;
  const ctx = c.ctx;
  ctx.beginPath();
  ctx.moveTo(c.sx(t.leftX[k]), c.sy(t.leftY[k]));
  ctx.lineTo(c.sx(t.rightX[k]), c.sy(t.rightY[k]));
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(width, 0.1);
  ctx.stroke();
}

function label(c: LayerContext, wx: number, wy: number, text: string, bg: string, fg: string, dy: number): void {
  const ctx = c.ctx;
  ctx.font = '700 10px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 8;
  const x = c.sx(wx);
  const y = c.sy(wy) + dy;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 7, w, 14, 3);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}
