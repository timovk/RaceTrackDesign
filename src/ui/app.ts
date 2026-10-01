/** Assembles the sidebar (header, mode tabs, panels), the map and the profile, and wires keyboard shortcuts. */
import { newProject, parseProject } from '../core/project.ts';
import { randomSeedString } from '../core/rng.ts';
import { h, isTyping } from './dom.ts';
import { download, slug } from './download.ts';
import { MapView } from './mapView.ts';
import { AnalysePanel } from './panels/analysePanel.ts';
import { DesignPanel } from './panels/designPanel.ts';
import { RacePanel } from './panels/racePanel.ts';
import { TerrainPanel } from './panels/terrainPanel.ts';
import { ProfileView } from './profileView.ts';
import { RaceController } from './raceController.ts';
import { RaceDock } from './raceDock.ts';
import { TimingTower } from './raceTower.ts';
import type { Mode, Store, Topic } from './store.ts';

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'terrain', label: 'Terrain' },
  { mode: 'design', label: 'Design' },
  { mode: 'analyse', label: 'Analyse' },
  { mode: 'race', label: 'Race' },
];

export function mountApp(root: HTMLElement, store: Store): void {
  const race = new RaceController(store);
  const map = new MapView(store, race);
  const locate = (station: number) => map.centreOn(station);
  const profile = new ProfileView(store, locate);
  const panels: Record<Mode, HTMLElement> = {
    terrain: new TerrainPanel(store).el,
    design: new DesignPanel(store, locate).el,
    analyse: new AnalysePanel(store, locate).el,
    race: new RacePanel(store, race, () => map.exportImage(`${slug(store.project.name)}-map.png`)).el,
  };
  const dock = new RaceDock(store, race);

  const name = h('input', {
    class: 'project-name', type: 'text', spellcheck: false, 'aria-label': 'Project name',
    onchange: () => {
      store.project.name = name.value.trim() || 'Untitled circuit';
      store.emit('project');
    },
  });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => void openFile() });
  const undo = h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)', onclick: () => store.undo() }, '↶');
  const redo = h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Y)', onclick: () => store.redo() }, '↷');

  async function openFile(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      store.loadProject(parseProject(await file.text()));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  function saveFile(): void {
    download(`${slug(store.project.name)}.rtd.json`, new Blob([store.serialize()], { type: 'application/json' }));
  }

  function newFile(): void {
    if (store.design.points.length && !confirm('Start a new project? Save first if you want to keep the current one.')) return;
    store.loadProject(newProject(randomSeedString()));
    store.setMode('terrain');
  }

  const tabs = MODES.map(({ mode, label }, i) =>
    h('button', { class: 'tab', onclick: () => store.setMode(mode) }, h('span', { class: 'tab-num' }, String(i + 1)), label));

  const sidebar = h('aside', { class: 'sidebar' },
    h('header', { class: 'brand' },
      h('div', { class: 'brand-row' },
        h('div', { class: 'logo', 'aria-hidden': 'true' }),
        h('span', { class: 'brand-name' }, 'RaceTrackDesign'),
        h('div', { class: 'brand-actions' }, undo, redo)),
      h('div', { class: 'brand-row' },
        name,
        h('button', { class: 'btn small', onclick: newFile }, 'New'),
        h('button', { class: 'btn small', onclick: () => fileInput.click() }, 'Open'),
        h('button', { class: 'btn small', onclick: saveFile }, 'Save'),
        fileInput)),
    h('nav', { class: 'tabs' }, ...tabs),
    h('div', { class: 'panel-scroll' }, ...Object.values(panels)),
  );

  map.el.append(new TimingTower(store, race).el);
  root.append(sidebar, h('main', { class: 'workspace' }, map.el, profile.el, dock.el));

  const update = (topics: Set<Topic>) => {
    if (topics.has('mode')) {
      tabs.forEach((tab, i) => tab.classList.toggle('on', MODES[i].mode === store.mode));
      for (const [mode, el] of Object.entries(panels)) el.hidden = mode !== store.mode;
    }
    // During a race the analysis dock takes the place of the profile strip.
    if (topics.has('mode') || topics.has('race')) profile.el.hidden = store.mode === 'race' && !!race.sim;
    if (topics.has('project') && document.activeElement !== name) name.value = store.project.name;
    if (topics.has('history') || topics.has('project')) {
      undo.disabled = !store.canUndo;
      redo.disabled = !store.canRedo;
    }
  };
  store.subscribe(update);
  update(new Set<Topic>(['mode', 'project', 'history']));

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (ctrl && key === 'y') {
      e.preventDefault();
      store.redo();
    } else if (ctrl && key === 's') {
      e.preventDefault();
      saveFile();
    } else if (ctrl) {
      return;
    } else if ((key === 'delete' || key === 'backspace') && store.mode === 'design' && store.selected !== null) {
      e.preventDefault();
      store.deletePoint(store.selected);
    } else if ((key === 'delete' || key === 'backspace') && store.mode === 'design' && store.linkSelected) {
      e.preventDefault();
      store.deleteLinkPoint(store.linkSelected);
    } else if (key === 'escape') {
      store.cancelLink();
      store.selectLinkPoint(null);
      store.select(null);
      store.setFocus(null);
    } else if (key === 'f') {
      map.fit();
    } else if (key === 'v') {
      store.setView({ dimension: store.view.dimension === '3d' ? '2d' : '3d' });
    } else if (key >= '1' && key <= '4') {
      store.setMode(MODES[Number(key) - 1].mode);
    } else if (key === 'p' && store.mode === 'race') {
      race.togglePlay();
    }
  });
}
