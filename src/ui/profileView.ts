/**
 * The strip under the map, with two views sharing the lap distance axis:
 * - Elevation: graded track (coloured by gradient) over the natural terrain.
 * - Speed: every class's speed trace, the selected class drawn on top.
 * Corners run along the top, sectors and warnings are marked, and hover is
 * shared with the map.
 */
import { gradientColor } from './colors.ts';
import { h, setChildren } from './dom.ts';
import * as fmt from './format.ts';
import type { Store, Topic } from './store.ts';

type ProfileMode = 'elevation' | 'speed';

const PAD = { left: 52, right: 14, top: 24, bottom: 22 };
const Y_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const X_STEPS = [50, 100, 200, 250, 500, 1000, 2000, 5000];
const MODE_KEY = 'racetrackdesign.profile';

export class ProfileView {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly summary: HTMLElement;
  private readonly tabs: HTMLButtonElement[];
  private readonly onPick: (station: number) => void;
  private mode: ProfileMode = 'elevation';
  private width = 1;
  private height = 1;
  private frameRequested = false;
  private yLo = 0;
  private yHi = 1;

  constructor(store: Store, onPick: (station: number) => void) {
    this.store = store;
    this.onPick = onPick;
    try {
      if (localStorage.getItem(MODE_KEY) === 'speed') this.mode = 'speed';
    } catch {
      // Storage unavailable; start on the elevation view.
    }
    this.canvas = h('canvas', { class: 'profile-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.summary = h('div', { class: 'profile-summary' });
    this.tabs = (['elevation', 'speed'] as ProfileMode[]).map((mode) =>
      h('button', { class: 'profile-tab', onclick: () => this.setMode(mode) }, mode === 'elevation' ? 'Elevation' : 'Speed'));
    this.el = h('section', { class: 'profile' },
      h('header', { class: 'profile-header' }, h('div', { class: 'profile-tabs' }, ...this.tabs), this.summary),
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

  private setMode(mode: ProfileMode): void {
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Remembering the tab is only a convenience.
    }
    this.updateSummary();
    this.invalidate();
  }

  private onChange(topics: Set<Topic>): void {
    if (topics.has('track') || topics.has('performance') || topics.has('vehicle')) this.updateSummary();
    this.invalidate();
  }

  private updateSummary(): void {
    const s = this.store;
    const m = s.metrics;
    this.tabs.forEach((b, i) => b.classList.toggle('on', (i === 0 ? 'elevation' : 'speed') === this.mode));
    this.el.classList.toggle('empty', !m);
    if (!m) {
      setChildren(this.summary, 'Draw a closed track to see its profile.');
      return;
    }
    const sep = () => h('span', { class: 'sep' }, '·');
    if (this.mode === 'elevation') {
      setChildren(this.summary,
        `${fmt.elevation(m.minZ)} – ${fmt.elevation(m.maxZ)}`,
        sep(), `climb ${fmt.elevation(m.totalClimb)} per lap`,
        sep(), `steepest ${fmt.gradient(m.maxUphill)} / ${fmt.gradient(m.maxDownhill)}`,
      );
      return;
    }
    const lap = s.lap;
    if (!lap) {
      setChildren(this.summary, s.performancePending ? 'Calculating lap times…' : 'No lap yet.');
      return;
    }
    setChildren(this.summary,
      h('span', { class: 'dot', style: `background:${s.vehicle.color}` }), s.vehicle.name,
      sep(), `top ${fmt.speed(lap.topSpeed)}`,
      sep(), `slowest ${fmt.speed(lap.minSpeed)}`,
      sep(), `average ${fmt.speed(lap.avgSpeed)}`,
      sep(), `${fmt.percent(lap.fullThrottle)} full throttle`,
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

  private py(v: number): number {
    return PAD.top + (1 - (v - this.yLo) / (this.yHi - this.yLo)) * (this.height - PAD.top - PAD.bottom);
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / this.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.store.track;
    if (!t) return;
    if (this.mode === 'speed') this.drawSpeed();
    else this.drawElevation();
  }

  // ---- shared parts ------------------------------------------------------------

  private get plotBottom(): number {
    return this.height - PAD.bottom;
  }

  private get plotRight(): number {
    return this.width - PAD.right;
  }

  private drawGrid(yStepTarget: number, yLabel: (v: number) => string): void {
    const ctx = this.ctx;
    const t = this.store.track!;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const yStep = pickStep(Y_STEPS, yStepTarget);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(this.yLo / yStep) * yStep; v <= this.yHi; v += yStep) {
      const y = Math.round(this.py(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(this.plotRight, y);
      ctx.stroke();
      ctx.fillText(yLabel(v), PAD.left - 6, y);
    }
    const xStep = pickStep(X_STEPS, t.length / 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 0; d <= t.length; d += xStep) {
      const x = Math.round(this.px(d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, this.plotBottom);
      ctx.stroke();
      ctx.fillText(xStep >= 1000 ? `${d / 1000} km` : `${(d / 1000).toFixed(xStep < 100 ? 2 : 1)} km`, x, this.plotBottom + 5);
    }
  }

  private band(start: number, end: number, fill: string, y0: number, y1: number): void {
    const t = this.store.track!;
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    const parts: [number, number][] = end >= start ? [[start, end]] : [[start, t.n - 1], [0, end]];
    for (const [a, b] of parts) {
      const xa = this.px(t.s[a]);
      const xb = this.px(t.s[b] + t.ds);
      ctx.fillRect(xa, y0, Math.max(1, xb - xa), y1 - y0);
    }
  }

  /** Corner bands and numbers, the focus band, sector lines and warning marks. */
  private drawContext(): void {
    const s = this.store;
    const t = s.track!;
    const ctx = this.ctx;
    const m = s.metrics;
    if (m) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 10px system-ui, sans-serif';
      for (const c of m.corners) {
        this.band(c.start, c.end, 'rgba(255,255,255,0.045)', PAD.top, this.plotBottom);
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(`T${c.number}`, this.px(t.s[c.apex]), PAD.top - 11);
      }
    }
    if (s.focus) this.band(s.focus.start, s.focus.end, 'rgba(255,255,255,0.12)', PAD.top, this.plotBottom);
    const perf = s.performance;
    if (perf && s.performanceCurrent) {
      ctx.strokeStyle = 'rgba(255,214,10,0.7)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      perf.sectors.forEach((k, i) => {
        const x = Math.round(this.px(t.s[k])) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, this.plotBottom);
        ctx.stroke();
        ctx.fillStyle = '#ffd60a';
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`S${i + 2}`, x + 3, this.plotBottom - 10);
      });
      ctx.setLineDash([]);
    }
    for (const issue of s.issues) {
      if (issue.severity === 'info') continue;
      this.band(issue.start, issue.end, issue.severity === 'error' ? '#ff4d4f' : '#f5b14c', this.plotBottom - 4, this.plotBottom);
    }
  }

  private drawHover(y: number, label: string, color: string): void {
    const s = this.store;
    const t = s.track!;
    const ctx = this.ctx;
    const i = s.hover!;
    const x = this.px(t.s[i]);
    ctx.strokeStyle = '#3fb6ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, PAD.top);
    ctx.lineTo(Math.round(x) + 0.5, this.plotBottom);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '600 11px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 12;
    const lx = Math.min(Math.max(x + 8, PAD.left), this.plotRight - w);
    const ly = Math.max(PAD.top + 2, Math.min(y - 26, this.plotBottom - 22));
    ctx.fillStyle = 'rgba(12,15,19,0.9)';
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, 20, 4);
    ctx.fill();
    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 6, ly + 10.5);
  }

  // ---- elevation -----------------------------------------------------------------

  private drawElevation(): void {
    const s = this.store;
    const t = s.track!;
    const ctx = this.ctx;
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
    this.drawGrid((this.yHi - this.yLo) / 4, (z) => `${z} m`);
    this.drawContext();

    // Terrain: dashed grey line.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#7d8590';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= t.n; k++) {
      const x = this.px(k * t.ds);
      if (k === 0) ctx.moveTo(x, this.py(t.terrain[k % t.n]));
      else ctx.lineTo(x, this.py(t.terrain[k % t.n]));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Graded track: soft fill, then a line coloured by gradient.
    ctx.beginPath();
    ctx.moveTo(this.px(0), this.plotBottom);
    for (let k = 0; k <= t.n; k++) ctx.lineTo(this.px(k * t.ds), this.py(t.z[k % t.n]));
    ctx.lineTo(this.px(t.length), this.plotBottom);
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

    if (s.hover !== null && s.hover < t.n) {
      const i = s.hover;
      this.drawHover(this.py(t.z[i]), `${fmt.km(t.s[i])} · ${fmt.elevation(t.z[i])} · ${fmt.gradient(t.gradient[i])}`, '#3fb6ff');
    }
  }

  // ---- speed ------------------------------------------------------------------------

  private drawSpeed(): void {
    const s = this.store;
    const t = s.track!;
    const ctx = this.ctx;
    const perf = s.performance;
    let top = 0;
    for (const lap of perf?.laps ?? []) top = Math.max(top, lap.topSpeed);
    this.yLo = 0;
    this.yHi = Math.max(top * 3.6 * 1.08, 100);
    this.drawGrid(this.yHi / 4, (v) => `${v}`);
    this.drawContext();
    if (!perf) return;

    const trace = (vs: Float64Array) => {
      ctx.beginPath();
      for (let k = 0; k <= t.n; k++) {
        const v = vs[s.lapIndex(k % t.n)] * 3.6;
        const x = this.px(k * t.ds);
        if (k === 0) ctx.moveTo(x, this.py(v));
        else ctx.lineTo(x, this.py(v));
      }
      ctx.stroke();
    };
    ctx.lineJoin = 'round';
    ctx.globalAlpha = s.performancePending ? 0.2 : 0.35;
    ctx.lineWidth = 1;
    for (const lap of perf.laps) {
      if (lap.vehicleId === s.vehicleId) continue;
      ctx.strokeStyle = s.vehicles.find((v) => v.id === lap.vehicleId)?.color ?? '#888';
      trace(lap.v);
    }
    ctx.globalAlpha = s.performancePending ? 0.5 : 1;
    const lap = s.lap;
    if (lap) {
      ctx.strokeStyle = s.vehicle.color;
      ctx.lineWidth = 2;
      trace(lap.v);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('km/h', 6, 4);

    if (lap && s.hover !== null && s.hover < t.n) {
      const i = s.lapIndex(s.hover);
      this.drawHover(this.py(lap.v[i] * 3.6), `${s.vehicle.name} · ${fmt.km(t.s[s.hover])} · ${fmt.speed(lap.v[i])} · gear ${lap.gear[i]}`, s.vehicle.color);
    }
  }
}

function pickStep(steps: readonly number[], target: number): number {
  for (const s of steps) if (s >= target) return s;
  return steps[steps.length - 1];
}
