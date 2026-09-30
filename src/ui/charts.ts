/** Small canvas chart helpers shared by the race charts: sizing, tick steps, axes and labels. */

export const GRID = 'rgba(255,255,255,0.06)';
export const AXIS_TEXT = '#8b949e';
export const TEXT = '#e6edf3';
export const FONT = '11px system-ui, sans-serif';

export interface Plot {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Resizes a canvas to CSS width x height at the device pixel ratio and returns a context drawing in CSS pixels. */
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/** A tick step of 1, 2 or 5 times a power of ten giving about `ticks` ticks over `range`. */
export function niceStep(range: number, ticks: number): number {
  const raw = Math.max(1e-9, range / Math.max(1, ticks));
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Horizontal grid lines with labels on the left, from lo to hi; `invert` puts lo at the top. */
export function yAxis(ctx: CanvasRenderingContext2D, plot: Plot, lo: number, hi: number, step: number, label: (v: number) => string, invert = false): (v: number) => number {
  const y = (v: number) => {
    const f = (v - lo) / (hi - lo || 1);
    return plot.y0 + (invert ? f : 1 - f) * plot.h;
  };
  ctx.font = FONT;
  ctx.fillStyle = AXIS_TEXT;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
    const py = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.x0, py);
    ctx.lineTo(plot.x0 + plot.w, py);
    ctx.stroke();
    ctx.fillText(label(Math.abs(v) < step / 1e6 ? 0 : v), plot.x0 - 6, py);
  }
  return y;
}

/** Vertical grid lines at whole laps with lap numbers underneath. */
export function lapAxis(ctx: CanvasRenderingContext2D, plot: Plot, first: number, last: number): (lap: number) => number {
  const x = (lap: number) => plot.x0 + ((lap - first) / Math.max(1, last - first)) * plot.w;
  const step = Math.max(1, Math.round(niceStep(last - first, Math.max(2, plot.w / 60))));
  ctx.font = FONT;
  ctx.fillStyle = AXIS_TEXT;
  ctx.strokeStyle = GRID;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let lap = Math.ceil(first / step) * step; lap <= last; lap += step) {
    const px = Math.round(x(lap)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, plot.y0);
    ctx.lineTo(px, plot.y0 + plot.h);
    ctx.stroke();
    ctx.fillText(lap === 0 ? 'Grid' : String(lap), px, plot.y0 + plot.h + 4);
  }
  return x;
}

/** A small label box with text. */
export function tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, align: 'left' | 'right' = 'left'): void {
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  const left = align === 'left' ? x : x - w;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y - 9, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 5, y + 0.5);
}

/** Strokes a polyline through points, leaving gaps at non-finite values. */
export function polyline(ctx: CanvasRenderingContext2D, count: number, px: (i: number) => number, py: (i: number) => number): void {
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < count; i++) {
    const x = px(i);
    const y = py(i);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
}
