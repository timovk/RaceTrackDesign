import './styles.css';
import { newProject } from './core/project.ts';
import { randomSeedString } from './core/rng.ts';
import { mountApp } from './ui/app.ts';
import { Store } from './ui/store.ts';

const restored = Store.restoreAutosave();
const store = new Store(restored ?? newProject(randomSeedString()));
if (restored?.track.points.length) store.setMode('design');
mountApp(document.getElementById('app')!, store);
void store.generateTerrain();
