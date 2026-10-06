/**
 * The broadcast's graphics beyond captions, pop-ups and the stop timer:
 * the start lights (or the green flag for a rolling start), a map of the
 * circuit with every car on it, a gap graphic for a battle on screen, the
 * final lap as the leader starts it, and the chequered flag and the results
 * at the end. (The timing tower shows the lap and the time left.)
 */
import { formatLapTime } from '../core/calibration.ts';
import type { RaceView } from '../core/race/replay.ts';
import type { RaceCar, RaceSim } from '../core/race/sim.ts';
import type { Track } from '../core/track.ts';
import { h, setChildren } from './dom.ts';

const SVG = 'http://www.w3.org/2000/svg';
/** Laps shown in the gap graphic, and seconds the final lap and the chequered flag banners stay up. */
const GAP_LAPS = 5;
const FINAL_LAP_BANNER = 6;
const FLAG_BANNER = 8;
/** Cars listed per class in the results. */
const RESULTS_ROWS = 10;

export interface GraphicsFrame {
  sim: RaceSim;
  /** The race as drawn: live, or as it was in a replay. */
  view: RaceView;
  alpha: number;
  /** Cars on screen, a battle's pair when one is shown (and not in a replay), and the viewer's car. */
  onScreen: readonly number[];
  battle: { ahead: number; behind: number } | null;
  selected: number | null;
  /** Screen seconds, always running. */
  time: number;
}

export class TvGraphics {
  readonly el: HTMLElement;
  private readonly map: SVGSVGElement;
  private readonly dots = new Map<number, { dot: SVGCircleElement; label: SVGTextElement }>();
  private readonly safety: SVGCircleElement;
  private readonly scale: number;
  private readonly lights: HTMLElement;
  private readonly lap: HTMLElement;
  private readonly gap: HTMLElement;
  private readonly flag: HTMLElement;
  private readonly results: HTMLElement;
  private gapKey = '';
  private finalAt = -1;
  private flagUntil = -1;
  private sim: RaceSim | null = null;

  constructor(track: Track) {
    // The circuit in world coordinates (y south, as on the flat map), every few stations.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const pts: string[] = [];
    for (let k = 0; k <= track.n; k += 3) {
      const i = k % track.n;
      x0 = Math.min(x0, track.x[i]);
      y0 = Math.min(y0, track.y[i]);
      x1 = Math.max(x1, track.x[i]);
      y1 = Math.max(y1, track.y[i]);
      pts.push(`${track.x[i].toFixed(1)},${track.y[i].toFixed(1)}`);
    }
    const size = Math.max(x1 - x0, y1 - y0, 1);
    const pad = size * 0.08;
    this.scale = size;
    this.map = document.createElementNS(SVG, 'svg');
    this.map.setAttribute('class', 'tv-map');
    this.map.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
    for (const [cls, width] of [['tv-map-edge', size / 45], ['tv-map-road', size / 90]] as const) {
      const line = document.createElementNS(SVG, 'polyline');
      line.setAttribute('points', pts.join(' '));
      line.setAttribute('class', cls);
      line.setAttribute('stroke-width', String(width));
      this.map.append(line);
    }
    this.safety = document.createElementNS(SVG, 'circle');
    this.safety.setAttribute('class', 'tv-map-sc');
    this.safety.setAttribute('r', String(size / 55));
    this.map.append(this.safety);
    this.lights = h('div', { class: 'tv-lights', hidden: true });
    this.lap = h('div', { class: 'tv-lap', hidden: true }, h('span', { class: 'fom' }, 'Final lap'));
    this.gap = h('div', { class: 'tv-gap-box', hidden: true });
    this.flag = h('div', { class: 'tv-flag', hidden: true });
    this.results = h('div', { class: 'tv-results', hidden: true });
    this.el = h('div', { class: 'tv-graphics' }, this.map, this.lap, this.lights, this.gap, this.flag, this.results);
  }

  /** The start lights: `lit` red lights of five, all out, the green flag of a rolling start, or none. */
  setLights(state: { lit: number } | 'out' | 'green' | null): void {
    this.lights.hidden = state === null;
    if (state === null) return;
    if (state === 'green') {
      if (!this.lights.classList.contains('green')) {
        this.lights.className = 'tv-lights green';
        setChildren(this.lights, h('div', { class: 'tv-green' }, 'Green flag'));
      }
      return;
    }
    const lit = state === 'out' ? 0 : state.lit;
    if (this.lights.classList.contains('green') || this.lights.children.length !== 5) {
      this.lights.className = 'tv-lights';
      setChildren(this.lights, ...Array.from({ length: 5 }, () => h('div', { class: 'tv-light' }, h('span'), h('span'))));
    }
    [...this.lights.children].forEach((el, i) => el.classList.toggle('on', i < lit));
  }

  update(f: GraphicsFrame): void {
    const { sim } = f;
    if (sim !== this.sim) {
      this.sim = sim;
      this.finalAt = -1;
      this.flagUntil = -1;
      this.results.hidden = true;
      this.flag.hidden = true;
      for (const d of this.dots.values()) {
        d.dot.remove();
        d.label.remove();
      }
      this.dots.clear();
    }
    this.updateMap(f);
    this.updateLap(f);
    this.updateGap(f);
    this.updateFinish(f);
  }

  /** Every car on the map, where it is drawn; the cars on screen larger and named. */
  private updateMap(f: GraphicsFrame): void {
    const r = this.scale / 45;
    const on = new Set(f.onScreen);
    for (const car of f.view.cars) {
      let d = this.dots.get(car.id);
      if (!d) {
        const dot = document.createElementNS(SVG, 'circle');
        dot.setAttribute('fill', car.entrant.color);
        dot.setAttribute('class', 'tv-map-car');
        const label = document.createElementNS(SVG, 'text');
        label.setAttribute('class', 'tv-map-label');
        label.setAttribute('font-size', String(this.scale / 18));
        label.textContent = car.entrant.code;
        this.map.insertBefore(dot, this.safety);
        this.map.append(label);
        d = { dot, label };
        this.dots.set(car.id, d);
      }
      const pose = car.status === 'finished' || car.status === 'retired' ? null : f.view.pose(car, f.alpha);
      d.dot.style.display = pose ? '' : 'none';
      const shown = !!pose && (on.has(car.id) || car.id === f.selected);
      d.label.style.display = shown ? '' : 'none';
      if (!pose) continue;
      const big = on.has(car.id);
      d.dot.setAttribute('cx', pose.x.toFixed(1));
      d.dot.setAttribute('cy', pose.y.toFixed(1));
      d.dot.setAttribute('r', String(big ? r * 1.7 : r));
      d.dot.classList.toggle('on', big);
      d.dot.classList.toggle('picked', car.id === f.selected);
      if (shown) {
        d.label.setAttribute('x', (pose.x + r * 2.4).toFixed(1));
        d.label.setAttribute('y', (pose.y + r).toFixed(1));
        // On top of the other dots.
        this.map.append(d.dot, d.label);
      }
    }
    const sc = f.view.safetyCar;
    this.safety.style.display = sc ? '' : 'none';
    if (sc) {
      const pose = f.sim.safetyCarPose(f.alpha);
      if (pose) {
        this.safety.setAttribute('cx', pose.x.toFixed(1));
        this.safety.setAttribute('cy', pose.y.toFixed(1));
      }
    }
  }

  /** "Final lap" for a few seconds as the leader starts it (or the time runs out in a race by time). */
  private updateLap(f: GraphicsFrame): void {
    const sim = f.sim;
    const laps = sim.setup.laps;
    const limit = sim.limit;
    const final = !sim.setup.session && !sim.chequered && !sim.finished && sim.t > 0
      && (sim.setup.duration !== null ? limit !== null && sim.t >= limit : laps !== null && sim.leaderLap >= laps);
    if (final && this.finalAt < 0) this.finalAt = f.time;
    this.lap.hidden = !(final && f.time - this.finalAt < FINAL_LAP_BANNER);
  }

  /** For a battle on screen once its caption has gone: the gap now, and at the line on the last few laps. */
  private updateGap(f: GraphicsFrame): void {
    const b = f.battle;
    if (!b) {
      this.gap.hidden = true;
      this.gapKey = '';
      return;
    }
    const sim = f.sim;
    const ahead = sim.cars[b.ahead];
    const behind = sim.cars[b.behind];
    const now = sim.classInterval(behind);
    const key = `${b.ahead}:${b.behind}:${Math.floor(f.time * 2)}`;
    if (key === this.gapKey) return;
    this.gapKey = key;
    const atLine = (car: RaceCar) => new Map(car.history.map((r) => [r.lap, r.at]));
    const a = atLine(ahead);
    const lapGaps: { lap: number; gap: number }[] = [];
    for (const r of behind.history) {
      const t = a.get(r.lap);
      if (t !== undefined) lapGaps.push({ lap: r.lap, gap: r.at - t });
    }
    const last = lapGaps.slice(-GAP_LAPS);
    const gapNow = now.kind === 'time' ? now.value : null;
    if (gapNow === null && last.length === 0) {
      this.gap.hidden = true;
      return;
    }
    const top = Math.max(0.1, ...last.map((g) => Math.abs(g.gap)), Math.abs(gapNow ?? 0));
    const trend = last.length >= 2 ? last[last.length - 1].gap - last[last.length - 2].gap : null;
    // In the look of the captions (styles: .fc): a tag, the gap on a bar, and the laps as columns under it.
    setChildren(this.gap, h('div', { class: 'fc' },
      h('div', { class: 'fc-tag fom' }, `Gap ${behind.entrant.code} to ${ahead.entrant.code}`),
      h('div', { class: 'fc-line fom tv-gap-now' },
        h('span', { class: 'tv-gap-value' }, gapNow !== null ? gapNow.toFixed(3) : '—'),
        trend !== null ? h('span', { class: `tv-gap-trend ${trend < 0 ? 'closing' : 'growing'}` }, `${trend < 0 ? '▼' : '▲'} ${Math.abs(trend).toFixed(3)} last lap`) : null),
      last.length ? h('div', { class: 'tv-gap-bars fom' }, ...last.map((g) =>
        h('div', { class: 'tv-gap-bar' },
          h('span', { class: 'tv-gap-fill', style: `height:${Math.round((Math.abs(g.gap) / top) * 100)}%` }),
          h('span', { class: 'tv-gap-lap' }, `L${g.lap}`)))) : null));
    this.gap.hidden = false;
  }

  /** The chequered flag as the winner takes it, then the results once the race is over. */
  private updateFinish(f: GraphicsFrame): void {
    const sim = f.sim;
    if (sim.chequered && this.flagUntil < 0) {
      this.flagUntil = f.time + FLAG_BANNER;
      const session = sim.setup.session;
      const winners = sim.classes.map((c) => sim.order.find((car) => car.cls === c && (session ? car.bestLap !== null : car.status !== 'retired'))).filter((c): c is RaceCar => !!c);
      const said = (w: RaceCar) => (session ? `${w.driver.name} fastest, ${formatLapTime(w.bestLap!)}` : `${w.driver.name} wins`);
      setChildren(this.flag,
        h('div', { class: 'tv-flag-chequer' }),
        h('div', { class: 'tv-flag-text' },
          h('div', { class: 'tv-flag-title' }, session ? `Chequered flag · ${session.name}` : 'Chequered flag'),
          ...winners.map((w) => h('div', { class: 'tv-flag-winner' }, h('span', { class: 'tv-team', style: `background:${w.entrant.color}` }), `${sim.multiClass ? `${w.cls.label} · ` : ''}${said(w)}`))));
    }
    this.flag.hidden = !(this.flagUntil >= 0 && f.time < this.flagUntil);
    if (sim.finished && this.results.hidden) {
      this.flag.hidden = true;
      this.flagUntil = 0;
      setChildren(this.results, ...sim.classes.map((c) => {
        const cars = sim.order.filter((car) => car.cls === c).slice(0, sim.multiClass ? RESULTS_ROWS : RESULTS_ROWS * 2);
        const title = sim.setup.session ? sim.setup.session.name : 'Results';
        return h('div', { class: 'tv-card tv-results-card' },
          h('div', { class: 'tv-card-head' }, sim.multiClass ? `${title} · ${c.label}` : title),
          ...cars.map((car) => resultRow(sim, car)));
      }));
      this.results.hidden = false;
    }
    if (!sim.finished) this.results.hidden = true;
  }
}

function resultRow(sim: RaceSim, car: RaceCar): HTMLElement {
  const g = sim.classGap(car);
  const pos = car.status === 'retired' ? 'DNF' : String(sim.multiClass ? car.classPosition : car.position);
  // A session: the best lap, and the gap to the fastest.
  const session = !!sim.setup.session;
  const lead = session ? (car.bestLap !== null ? formatLapTime(car.bestLap) : 'No time') : car.finishTime !== null ? clock(car.finishTime, true) : '';
  const gap = car.status === 'retired' && !(session && car.bestLap !== null) ? 'Out' : g.kind === 'leader' ? lead : g.kind === 'time' ? `+${g.value.toFixed(3)}` : g.kind === 'laps' ? `+${g.value} lap${g.value > 1 ? 's' : ''}` : session ? 'No time' : '';
  return h('div', { class: 'tv-row' },
    h('span', { class: 'tv-pos' }, pos),
    h('span', { class: 'tv-team', style: `background:${car.entrant.color}` }),
    h('span', { class: 'tv-name' }, h('span', { class: 'tv-driver' }, car.driver.name), h('span', { class: 'tv-sub' }, `#${car.entrant.number} · ${car.entrant.team}`)),
    h('span', { class: 'tv-gap' }, gap));
}

/** 1:23:45, or with thousandths for a race time. */
function clock(seconds: number, fine = false): string {
  const hrs = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  const s = fine ? sec.toFixed(3).padStart(6, '0') : String(Math.floor(sec)).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${String(min).padStart(2, '0')}:${s}` : `${min}:${s}`;
}
