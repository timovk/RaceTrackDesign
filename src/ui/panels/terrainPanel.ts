/** Terrain mode: seed, landscape preset, map size and fine-tuning of the generator. */
import { MAP_SIZES, PRESET_SHAPES, TERRAIN_PRESETS, type TerrainPreset, type TerrainShape } from '../../core/terrain.ts';
import { randomSeedString } from '../../core/rng.ts';
import { type Control, section, segmented, slider } from '../controls.ts';
import { h, isEditing, setChildren } from '../dom.ts';
import * as fmt from '../format.ts';
import type { Store, Topic } from '../store.ts';

const PRESET_LABELS: Record<TerrainPreset, string> = { flat: 'Flat', rolling: 'Rolling', hilly: 'Hilly', mountainous: 'Mountains' };

type ShapeKey = keyof TerrainShape;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const SHAPE_SLIDERS: { key: ShapeKey; label: string; min: number; max: number; step: number; format: (v: number) => string; title: string }[] = [
  { key: 'relief', label: 'Relief', min: 5, max: 1500, step: 5, format: (v) => `${v} m`, title: 'Height between the lowest and highest ground' },
  { key: 'featureSize', label: 'Hill size', min: 800, max: 8000, step: 100, format: (v) => fmt.distance(v), title: 'Wavelength of the largest hills' },
  { key: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01, format: pct, title: 'How much small-scale detail survives' },
  { key: 'warp', label: 'Warp', min: 0, max: 1, step: 0.01, format: pct, title: 'Bends ridges and valleys into less regular shapes' },
  { key: 'ridges', label: 'Ridges', min: 0, max: 1, step: 0.01, format: pct, title: 'Share of sharp mountain crests' },
  { key: 'valleys', label: 'Valley floors', min: 0, max: 1, step: 0.01, format: pct, title: 'How much low ground flattens out' },
  { key: 'erosion', label: 'Erosion', min: 0, max: 1, step: 0.01, format: pct, title: 'Water erosion carving gullies and filling valleys' },
  { key: 'water', label: 'Water', min: 0, max: 0.5, step: 0.01, format: pct, title: 'Share of the map under water' },
  { key: 'baseElevation', label: 'Base elevation', min: 0, max: 2500, step: 10, format: (v) => `${v} m`, title: 'Height of the lowest ground above sea level' },
];

export class TerrainPanel {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly seed: HTMLInputElement;
  private readonly size: HTMLSelectElement;
  private readonly detail: HTMLSelectElement;
  private readonly controls: Control[] = [];
  private readonly stats: HTMLElement;
  private readonly modified: HTMLElement;

  constructor(store: Store) {
    this.store = store;
    const t = () => store.project.terrain;

    this.seed = h('input', {
      type: 'text', class: 'seed-input', spellcheck: false, 'aria-label': 'Seed',
      onchange: () => {
        const v = this.seed.value.trim();
        if (v) store.setTerrain({ seed: v });
      },
    });
    const dice = h('button', { class: 'btn', title: 'New random seed', onclick: () => store.setTerrain({ seed: randomSeedString() }) }, 'Random');

    const presets = segmented(
      TERRAIN_PRESETS.map((p) => ({ value: p, label: PRESET_LABELS[p] })),
      () => t().preset,
      (p) => store.applyPreset(p),
    );
    this.controls.push(presets);

    this.size = h('select', { onchange: () => { store.setTerrain({ mapSize: Number(this.size.value) }); this.size.blur(); } },
      ...MAP_SIZES.map((m) => h('option', { value: String(m) }, `${m / 1024} × ${m / 1024} km`)));
    this.detail = h('select', { onchange: () => { store.setTerrain({ resolution: Number(this.detail.value) }); this.detail.blur(); } },
      h('option', { value: '1024' }, 'Standard (1024²)'),
      h('option', { value: '2048' }, 'High (2048²)'));

    const sliders = SHAPE_SLIDERS.map((s) =>
      slider({
        ...s,
        get: () => t()[s.key],
        onInput: (v) => store.setTerrain({ [s.key]: v }, false),
        onCommit: () => void store.generateTerrain(),
      }),
    );
    this.controls.push(...sliders);

    this.modified = h('span', { class: 'muted small' });
    this.stats = h('dl', { class: 'stats' });

    this.el = h('div', { class: 'panel' },
      section('Seed', h('div', { class: 'row' }, this.seed, dice),
        h('p', { class: 'hint' }, 'The same seed and settings always give the same landscape.')),
      section('Landscape', presets.el,
        h('div', { class: 'row two' },
          h('label', { class: 'field' }, h('span', null, 'Map size'), this.size),
          h('label', { class: 'field' }, h('span', null, 'Detail'), this.detail))),
      h('details', { class: 'panel-section', open: true },
        h('summary', null, h('h3', null, 'Fine-tune'), this.modified),
        ...sliders.map((s) => s.el),
        h('button', { class: 'btn subtle', onclick: () => store.applyPreset(t().preset) }, 'Reset to preset')),
      section('This map', this.stats),
      h('button', { class: 'btn primary block', onclick: () => store.setMode('design') }, 'Next: draw the track'),
    );

    store.subscribe((topics) => this.update(topics));
    this.update(new Set<Topic>(['project', 'terrain']));
  }

  private update(topics: Set<Topic>): void {
    const s = this.store;
    const t = s.project.terrain;
    if (topics.has('project')) {
      if (!isEditing(this.seed)) this.seed.value = t.seed;
      this.size.value = String(t.mapSize);
      this.detail.value = String(t.resolution);
      for (const c of this.controls) c.update();
      const preset = PRESET_SHAPES[t.preset];
      const changed = (Object.keys(preset) as ShapeKey[]).some((k) => Math.abs(preset[k] - t[k]) > 1e-9);
      this.modified.textContent = changed ? 'modified' : '';
    }
    if (topics.has('terrain') || topics.has('project') || topics.has('track')) {
      const layer = s.terrain;
      if (!layer) {
        setChildren(this.stats, h('dd', { class: 'muted' }, 'Generating…'));
        return;
      }
      const hm = layer.heightmap;
      const hasWater = Number.isFinite(hm.waterLevel);
      const row = (k: string, v: string) => [h('dt', null, k), h('dd', null, v)];
      setChildren(this.stats,
        ...row('Elevation', `${fmt.elevation(hm.min)} – ${fmt.elevation(hm.max)}`),
        ...row('Water level', hasWater ? fmt.elevation(hm.waterLevel) : 'none'),
        ...row('Contours', `every ${layer.contourInterval} m`),
        ...row('Grid', `${hm.size}² at ${hm.cellSize} m`),
        ...(s.design.points.length ? row('Track', 'stays put; heights follow the new terrain') : []),
      );
    }
  }
}
