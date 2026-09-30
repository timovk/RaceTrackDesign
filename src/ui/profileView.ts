/**
 * Elevation profile strip under the map: graded track (coloured by
 * gradient) over the natural terrain, corners along the top and warnings
 * along the bottom. Hover is shared with the map.
 */
import { gradientColor } from './colors.ts';
import { h, setChildren } from './dom.ts';
import * as fmt from './format.ts';
import type { Store, Topic } from './store.ts';

const PAD = { left: 48, right: 14, top: 24, bottom: 22 };
const Y_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const X_STEPS = [50, 100, 200, 250, 500, 1000, 2000, 5000];

export class ProfileView {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly summary: HTMLElement;
  private readonly onPick: (station: number) => void;
  private width = 1;
  private height = 1;
  private frameRequested = false;
  private yLo = 0;
  private yHi = 1;

  constructor(store: Store, onPick: (station: number) => void) {
    this.store = store;
    this.onPick = onPick;
    this.canvas = h('canvas', { class: 'profile-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.summary = h('div', { class: 'profile-summary' });
    this.el = h('section', { class: 'profile' },
      h('header', { class: 'profile-header' }, h('h2', null, 'Elevation profile'), this.summary),
      h('div', { class: 'profile-body' }, this.canvas),
    );

    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    this.canvas.addEventListener('pointermove', (e) => store.setHover(this.stationAtEvent(e)));
    this.canvas.addEventListener('pointerleave', () => store.setHover(null));
    this.canvas.addEventListener('click', (e) => {
      const k = this.stationAtEvent(e);
      if (k !== null) this.onPick(k);
    });
    store.subscribe((topics) => this.onChange(topics));
    this.onChange(new Set<Topic>(['track']));
  }

  private onChange(topics: Set<Topic>): void {
    if (topics.has('track')) this.updateSummary();
    if (topics.has('track') || topics.has('hover') || topics.has('focus')) this.invalidate();
  }

  private updateSummary(): void {
    const m = this.store.metrics;
    this.el.classList.toggle('empty', !m);
    if (!m) {
      setChildren(this.summary, 'Draw a closed track to see its profile.');
      return;
    }
    setChildren(this.summary,
      `${fmt.elevation(m.minZ)} – ${fmt.elevation(m.maxZ)}`,
      h('span', { class: 'sep' }, '·'), `climb ${fmt.elevation(m.totalClimb)} per lap`,
      h('span', { class: 'sep' }, '·'), `steepest ${fmt.gradient(m.maxUphill)} / ${fmt.gradient(m.maxDownhill)}`,
    );
  }

  private resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.invalidate();
  }

  private invalidate(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  private stationAtEvent(e: MouseEvent): number | null {
    const t = this.store.track;
    if (!t) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const f = (x - PAD.left) / (this.width - PAD.left - PAD.right);
    if (f < 0 || f > 1) return null;
    return Math.min(t.n - 1, Math.round((f * t.length) / t.ds));
  }

  private px(s: number): number {
    const t = this.store.track!;
    return PAD.left + (s / t.length) * (this.width - PAD.left - PAD.right);
  }

  private py(z: number): number {
    return PAD.top + (1 - (z - this.yLo) / (this.yHi - this.yLo)) * (this.height - PAD.top - PAD.bottom);
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / this.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const s = this.store;
    const t = s.track;
    if (!t) return;

    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < t.n; k++) {
      lo = Math.min(lo, t.z[k], t.terrain[k]);
      hi = Math.max(hi, t.z[k], t.terrain[k]);
    }
    if (hi - lo < 10) {
      const mid = (hi + lo) / 2;
      lo = mid - 5;
      hi = mid + 5;
    }
    const pad = (hi - lo) * 0.08;
    this.yLo = lo - pad;
    this.yHi = hi + pad;
    const plotBottom = this.height - PAD.bottom;
    const plotRight = this.width - PAD.right;

    // Grid and axes.
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const yStep = pickStep(Y_STEPS, (this.yHi - this.yLo) / 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let z = Math.ceil(this.yLo / yStep) * yStep; z <= this.yHi; z += yStep) {
      const y = Math.round(this.py(z)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.fillText(`${z} m`, PAD.left - 6, y);
    }
    const xStep = pickStep(X_STEPS, t.length / 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 0; d <= t.length; d += xStep) {
      const x = Math.round(this.px(d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.fillText(xStep >= 1000 ? `${d / 1000} km` : `${(d / 1000).toFixed(xStep < 100 ? 2 : 1)} km`, x, plotBottom + 5);
    }

    const bands = (start: number, end: number, fill: string, y0: number, y1: number) => {
      ctx.fillStyle = fill;
      const parts: [number, number][] = end >= start ? [[start, end]] : [[start, t.n - 1], [0, end]];
      for (const [a, b] of parts) {
        const xa = this.px(t.s[a]);
        const xb = this.px(t.s[b] + t.ds);
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), y1 - y0);
      }
    };

    // Corners along the top, focus band across the plot.
    const m = s.metrics;
    if (m) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 10px system-ui, sans-serif';
      for (const c of m.corners) {
        bands(c.start, c.end, 'rgba(255,255,255,0.045)', PAD.top, plotBottom);
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(`T${c.number}`, this.px(t.s[c.apex]), PAD.top - 11);
      }
    }
    if (s.focus) bands(s.focus.start, s.focus.end, 'rgba(255,255,255,0.12)', PAD.top, plotBottom);

    // Terrain: dashed grey line.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#7d8590';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= t.n; k++) {
      const i = k % t.n;
      const x = this.px(k * t.ds);
      if (k === 0) ctx.moveTo(x, this.py(t.terrain[i]));
      else ctx.lineTo(x, this.py(t.terrain[i]));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Graded track: soft fill, then a line coloured by gradient.
    ctx.beginPath();
    ctx.moveTo(this.px(0), plotBottom);
    for (let k = 0; k <= t.n; k++) ctx.lineTo(this.px(k * t.ds), this.py(t.z[k % t.n]));
    ctx.lineTo(this.px(t.length), plotBottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    let k = 0;
    while (k < t.n) {
      const color = gradientColor(t.gradient[k]);
      let end = k;
      while (end + 1 < t.n && gradientColor(t.gradient[end + 1]) === color) end++;
      ctx.beginPath();
      ctx.moveTo(this.px(k * t.ds), this.py(t.z[k]));
      for (let i = k + 1; i <= end + 1; i++) ctx.lineTo(this.px(i * t.ds), this.py(t.z[i % t.n]));
      ctx.strokeStyle = color;
      ctx.stroke();
      k = end + 1;
    }

    // Warnings along the bottom edge.
    for (const issue of s.issues) {
      if (issue.severity === 'info') continue;
      bands(issue.start, issue.end, issue.severity === 'error' ? '#ff4d4f' : '#f5b14c', plotBottom - 4, plotBottom);
    }

    // Hover marker with a readout.
    if (s.hover !== null && s.hover < t.n) {
      const i = s.hover;
      const x = this.px(t.s[i]);
      const y = this.py(t.z[i]);
      ctx.strokeStyle = '#3fb6ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, PAD.top);
      ctx.lineTo(Math.round(x) + 0.5, plotBottom);
      ctx.stroke();
      ctx.fillStyle = '#3fb6ff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      const label = `${fmt.km(t.s[i])} · ${fmt.elevation(t.z[i])} · ${fmt.gradient(t.gradient[i])}`;
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      const lx = Math.min(Math.max(x + 8, PAD.left), plotRight - w);
      const ly = Math.max(PAD.top + 2, Math.min(y - 26, plotBottom - 22));
      ctx.fillStyle = 'rgba(12,15,19,0.9)';
      ctx.beginPath();
      ctx.roundRect(lx, ly, w, 20, 4);
      ctx.fill();
      ctx.fillStyle = '#e6edf3';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 6, ly + 10.5);
    }
  }
}

function pickStep(steps: readonly number[], target: number): number {
  for (const s of steps) if (s >= target) return s;
  return steps[steps.length - 1];
}
