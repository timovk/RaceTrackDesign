/**
 * The track generator's dialog: a kind of circuit to start from, every
 * setting as a slider, a switch or a choice, and the tracks it comes up
 * with as cards (the lap drawn small, and what it turned out as). Picking
 * one makes it the design; undo brings the old one back.
 */
import { formatLapTime } from '../core/calibration.ts';
import { DEFAULT_GENERATOR, GENERATOR_RANGE, GENERATOR_STYLES, type GeneratedTrack, type GeneratorSettings, generateTracks } from '../core/generator.ts';
import { randomSeedString } from '../core/rng.ts';
import { VEHICLES } from '../core/vehicles.ts';
import { type Control, section, segmented, slider } from './controls.ts';
import { h, setChildren } from './dom.ts';
import * as fmt from './format.ts';
import type { Store } from './store.ts';

/** The settings as last used, kept while the app is open. */
let settings: GeneratorSettings = { ...DEFAULT_GENERATOR, seed: randomSeedString() };
let styleId: string | null = null;
let open: HTMLElement | null = null;

/** A tick box with its label. */
function tick(label: string, get: () => boolean, set: (v: boolean) => void, title?: string): Control {
  const input = h('input', { type: 'checkbox', onchange: () => set(input.checked) });
  return { el: h('label', { class: 'gen-tick', title }, input, h('span', null, label)), update: () => { input.checked = get(); } };
}

/** The lap drawn small: its line, the start line across it, and an arrow for the way round. */
function drawOutline(canvas: HTMLCanvasElement, track: GeneratedTrack): void {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const w = 260, hgt = 170;
  canvas.width = w * ratio;
  canvas.height = hgt * ratio;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hgt}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const o = track.outline;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < o.length; i += 2) {
    x0 = Math.min(x0, o[i]);
    x1 = Math.max(x1, o[i]);
    y0 = Math.min(y0, o[i + 1]);
    y1 = Math.max(y1, o[i + 1]);
  }
  const pad = 16;
  const scale = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), (hgt - 2 * pad) / Math.max(1, y1 - y0));
  const px = (x: number) => (pad + (w - 2 * pad - (x1 - x0) * scale) / 2 + (x - x0) * scale) * ratio;
  const py = (y: number) => (pad + (hgt - 2 * pad - (y1 - y0) * scale) / 2 + (y - y0) * scale) * ratio;
  const css = getComputedStyle(document.documentElement);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < o.length; i += 2) {
    if (i) ctx.lineTo(px(o[i]), py(o[i + 1]));
    else ctx.moveTo(px(o[i]), py(o[i + 1]));
  }
  ctx.closePath();
  ctx.strokeStyle = css.getPropertyValue('--text').trim() || '#e8ecf1';
  ctx.lineWidth = Math.max(2, track.design.defaultWidth * scale) * ratio;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;
  // The start line, and the way the lap runs from it: towards the nearest point of the outline that follows.
  const sx = track.startFinish.x, sy = track.startFinish.y;
  let near = 0;
  let best = Infinity;
  for (let i = 0; i < o.length; i += 2) {
    const d = Math.hypot(o[i] - sx, o[i + 1] - sy);
    if (d < best) {
      best = d;
      near = i;
    }
  }
  const next = (near + 8) % o.length;
  const dx = o[next] - o[near], dy = o[next + 1] - o[near + 1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const accent = css.getPropertyValue('--accent').trim() || '#ff5a36';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 2.5 * ratio;
  ctx.beginPath();
  ctx.moveTo(px(sx) - uy * 9 * ratio, py(sy) + ux * 9 * ratio);
  ctx.lineTo(px(sx) + uy * 9 * ratio, py(sy) - ux * 9 * ratio);
  ctx.stroke();
  const ax = px(sx) + ux * 20 * ratio, ay = py(sy) + uy * 20 * ratio;
  ctx.beginPath();
  ctx.moveTo(ax + ux * 8 * ratio, ay + uy * 8 * ratio);
  ctx.lineTo(ax - ux * 4 * ratio - uy * 6 * ratio, ay - uy * 4 * ratio + ux * 6 * ratio);
  ctx.lineTo(ax - ux * 4 * ratio + uy * 6 * ratio, ay - uy * 4 * ratio - ux * 6 * ratio);
  ctx.closePath();
  ctx.fill();
}

/** One track on offer: the lap drawn small, its figures, what could not be met, and the button that takes it. */
function card(track: GeneratedTrack, index: number, use: () => void): HTMLElement {
  const f = track.figures;
  const vehicle = VEHICLES.find((v) => v.id === settings.vehicleId);
  const canvas = h('canvas', { class: 'gen-outline' });
  drawOutline(canvas, track);
  const lines: (HTMLElement | null)[] = [
    h('p', { class: 'gen-head' }, `${fmt.km(f.length)} · ${f.corners} corners`, h('span', { class: 'muted' }, ` (${f.right} right, ${f.left} left) · ${f.direction}`)),
    h('p', null, `Height difference ${Math.round(f.heightDifference)} m, steepest ${(f.steepest * 100).toFixed(1)}%`),
    h('p', null, `Longest straight ${Math.round(f.longestStraight)} m, start straight ${Math.round(f.startStraight)} m`),
    Number.isFinite(f.lapTime) && vehicle
      ? h('p', null, `${vehicle.name}: ${formatLapTime(f.lapTime)}, top ${Math.round(f.topSpeed * 3.6)} km/h, ${f.brakingPoints} heavy braking point${f.brakingPoints === 1 ? '' : 's'}`)
      : null,
    f.licence
      ? h('p', { class: f.licence.passes ? 'gen-pass' : 'gen-fail', title: f.licence.failures.join('\n') },
        f.licence.passes ? `Passes the ${f.licence.needs} check` : `Fails the ${f.licence.needs} check on ${f.licence.failures.length || 'some'} point${f.licence.failures.length === 1 ? '' : 's'}: ${f.licence.failures[0] ?? 'see Analyse'}`)
      : null,
    f.warnings ? h('p', { class: 'muted' }, `${f.warnings} warning${f.warnings === 1 ? '' : 's'} in the checks`) : null,
    ...track.notes.map((n) => h('p', { class: 'gen-note' }, n)),
  ];
  return h('div', { class: 'gen-card' },
    h('div', { class: 'gen-card-top' }, h('span', { class: 'gen-number' }, String(index + 1)), canvas),
    h('div', { class: 'gen-figures' }, ...lines),
    h('button', { class: 'btn primary', title: 'Make this the design; Undo brings the old track back', onclick: use }, 'Use this track'));
}

/** Opens the generator, unless it is open. `onUse` is called once a track has been made the design. */
export function openGenerator(store: Store, onUse: () => void = () => {}): void {
  if (open) return;
  const controls: Control[] = [];
  const set = (changes: Partial<GeneratorSettings>, keepStyle = false) => {
    settings = { ...settings, ...changes };
    if (!keepStyle) styleId = null;
    for (const c of controls) c.update();
    updateStyles();
  };
  const add = <T extends Control>(c: T): T => {
    controls.push(c);
    return c;
  };
  const number = (label: string, key: 'length' | 'width' | 'heightDifference' | 'longestStraight' | 'startStraight' | 'brakingPoints' | 'slow' | 'medium' | 'fast', min: number, max: number, step: number, format: (v: number) => string, title?: string) =>
    add(slider({ label, min, max, step, format, title, get: () => settings[key], onInput: (v) => set({ [key]: v } as Partial<GeneratorSettings>) })).el;
  const share = (label: string, key: 'speed' | 'compact' | 'foldBack', low: string, high: string, title?: string) =>
    add(slider({ label, min: 0, max: 1, step: 0.05, title, format: (v) => (v < 0.15 ? low : v < 0.4 ? `mostly ${low}` : v <= 0.6 ? 'in between' : v <= 0.85 ? `mostly ${high}` : high), get: () => settings[key], onInput: (v) => set({ [key]: v } as Partial<GeneratorSettings>) })).el;

  // The kinds of circuit.
  const styles = h('div', { class: 'gen-styles' });
  const updateStyles = () => setChildren(styles, ...GENERATOR_STYLES.map((st) => h('button', {
    class: `gen-style${styleId === st.id ? ' on' : ''}`, title: st.summary,
    onclick: () => {
      styleId = st.id;
      set(st.settings, true);
    },
  }, h('strong', null, st.name), h('span', null, st.summary))));

  const vehicleSelect = h('select', { class: 'gen-select', onchange: () => set({ vehicleId: vehicleSelect.value }) },
    ...VEHICLES.map((v) => h('option', { value: v.id }, v.name)));
  controls.push({ el: vehicleSelect, update: () => { vehicleSelect.value = settings.vehicleId; } });
  const licence = add(tick('Build it to that class\'s licence', () => settings.licence, (v) => set({ licence: v }),
    'Keeps room for run-off between the parts of the track, widens the grid, puts the start line where the licence wants it, and offers the tracks that pass first. It changes nothing you set: where a setting stands in the way of the licence, the result says so.'));
  const direction = add(segmented<GeneratorSettings['direction']>(
    [{ value: 'clockwise', label: 'Clockwise' }, { value: 'anticlockwise', label: 'Anticlockwise' }, { value: 'either', label: 'Either' }],
    () => settings.direction, (v) => set({ direction: v })));
  const seed = h('input', { type: 'text', class: 'gen-seed', spellcheck: false, onchange: () => set({ seed: seed.value.trim() || '1' }, true) });
  controls.push({ el: seed, update: () => { seed.value = settings.seed; } });

  const status = h('p', { class: 'gen-status muted' }, 'Set what you want and press Generate. The same seed and settings give the same tracks.');
  const notes = h('div', { class: 'gen-notes' });
  const results = h('div', { class: 'gen-results-grid' });
  const go = h('button', { class: 'btn primary grow', onclick: () => void run() }, 'Generate');

  const close = () => {
    backdrop.remove();
    window.removeEventListener('keydown', onKey);
    open = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  let running = false;
  const run = async () => {
    if (running) return;
    const hm = store.terrain?.heightmap;
    if (!hm) {
      status.textContent = 'The terrain is still being made: try again in a moment.';
      return;
    }
    running = true;
    go.disabled = true;
    setChildren(results);
    setChildren(notes);
    const used = { ...settings };
    try {
      const out = await generateTracks(used, { heightmap: hm, terrainSeed: store.project.terrain.seed, vehicles: VEHICLES }, {
        pause: () => new Promise((r) => setTimeout(r)),
        progress: (done, of, doing) => { status.textContent = `${doing}… (${Math.min(done + 1, of)} of ${of})`; },
      });
      status.textContent = out.tracks.length
        ? `${out.tracks.length} track${out.tracks.length === 1 ? '' : 's'} for seed ${used.seed}, the nearest to what was asked first.`
        : 'No track could be made.';
      setChildren(notes, ...out.notes.map((n) => h('p', { class: 'gen-note' }, n)));
      setChildren(results, ...out.tracks.map((t, i) => card(t, i, () => {
        store.replaceDesign(t.design, t.startFinish);
        if (VEHICLES.some((v) => v.id === used.vehicleId)) store.selectVehicle(used.vehicleId);
        close();
        onUse();
      })));
    } catch (e) {
      status.textContent = `Generating failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      running = false;
      go.disabled = false;
    }
  };

  const R = GENERATOR_RANGE;
  const panel = h('div', { class: 'gen-settings' },
    section('Kind of circuit', styles, h('p', { class: 'hint' }, 'Each sets everything below at once; adjust from there.')),
    section('The lap',
      number('Length', 'length', R.length[0], R.length[1], 100, (v) => `${(v / 1000).toFixed(1)} km`),
      number('Width', 'width', R.width[0], R.width[1], 0.5, (v) => `${v} m`),
      number('Height difference', 'heightDifference', R.heightDifference[0], R.heightDifference[1], 10, (v) => `${v} m`, 'Between the highest and the lowest point of the lap. The generator looks for a place on this map that has it, on slopes of up to 16% when a lot is asked.'),
      share('Corners or speed', 'speed', 'corners', 'speed', 'From about nine corners a kilometre (a kart track) to hardly more than one (an oval with a bend in it), counted over the lap without its longest straight and its start straight')),
    section('Built for', vehicleSelect, licence.el),
    section('Straights and overtaking',
      number('Longest straight', 'longestStraight', R.longestStraight[0], R.longestStraight[1], 50, (v) => `${v} m`, `No straight comes out longer than this. At most ${Math.round(R.straightShare * 100)}% of the lap: two of them and the two ends make an oval.`),
      number('Start straight', 'startStraight', R.startStraight[0], R.startStraight[1], 50, (v) => `${v} m`, 'The straight the start line and the pits are on; no longer than the longest'),
      number('Heavy braking points', 'brakingPoints', R.brakingPoints[0], R.brakingPoints[1], 1, (v) => String(v), 'Places where the cars lose 90 km/h or more: where passing is done')),
    section('Corners',
      number('Slow corners', 'slow', 0, 3, 0.1, (v) => v.toFixed(1), 'Weight of corners under 45 m of radius in the mix'),
      number('Medium corners', 'medium', 0, 3, 0.1, (v) => v.toFixed(1), 'Weight of corners of 45 to 120 m'),
      number('Fast corners', 'fast', 0, 3, 0.1, (v) => v.toFixed(1), 'Weight of corners over 120 m'),
      h('div', { class: 'gen-ticks' },
        add(tick('A hairpin', () => settings.hairpin, (v) => set({ hairpin: v }))).el,
        add(tick('A chicane', () => settings.chicane, (v) => set({ chicane: v }))).el,
        add(tick('Esses', () => settings.esses, (v) => set({ esses: v }))).el,
        add(tick('A long sweeper', () => settings.sweeper, (v) => set({ sweeper: v }))).el)),
    section('Shape',
      direction.el,
      share('Spread out or compact', 'compact', 'spread out', 'compact', 'From a long thin loop to a lap that turns inward and fills its own middle'),
      share('Folding back on itself', 'foldBack', 'one loop', 'folded', 'How much of the lap turns in on itself: from none, by way of arms that go off to one side and come back, to rows of parallel straights joined by turns right round, as near each other as the track is wide and a strip of ground. The rows come only in the top fifth of the slider.'),
      h('div', { class: 'gen-ticks' },
        add(tick('Keep clear of water', () => settings.avoidWater, (v) => set({ avoidWater: v }))).el,
        add(tick('Keep clear of woods', () => settings.avoidWoods, (v) => set({ avoidWoods: v }), 'Prefers open ground; where the map is all woods it says how much of the lap runs through them')).el)),
    section('Seed',
      h('div', { class: 'row' }, seed, h('button', { class: 'btn', onclick: () => set({ seed: randomSeedString() }, true) }, 'Random')),
      h('p', { class: 'hint' }, 'Another seed, other tracks to the same settings.')),
  );

  const dialog = h('div', { class: 'gen-dialog', role: 'dialog', 'aria-label': 'Generate a track' },
    h('header', { class: 'gen-header' },
      h('h2', null, 'Generate a track'),
      h('span', { class: 'muted' }, 'on the best spot of this map'),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: close }, '×')),
    h('div', { class: 'gen-body' },
      h('div', { class: 'gen-left' }, panel, h('div', { class: 'gen-actions row' }, go)),
      h('div', { class: 'gen-right' }, status, notes, results)));
  const backdrop = h('div', { class: 'gen-backdrop', onclick: (e: Event) => { if (e.target === backdrop) close(); } }, dialog);
  document.body.append(backdrop);
  window.addEventListener('keydown', onKey);
  open = backdrop;
  updateStyles();
  for (const c of controls) c.update();
}
