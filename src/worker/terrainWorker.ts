/**
 * Generates a heightmap, or reads a surveyed one, and renders its images off
 * the main thread. Messages carry an id so the UI can ignore results from
 * requests it has since replaced.
 */
import { findSurvey, loadSurvey } from '../core/survey.ts';
import { generateHeightmap, type TerrainSettings } from '../core/terrain.ts';
import { renderTerrain } from '../core/terrainImage.ts';
import type { TerrainWorkerResponse } from './protocol.ts';

const scope = self as unknown as Worker;

scope.onmessage = async (event: MessageEvent<{ id: number; settings: TerrainSettings; base: string }>) => {
  const { id, settings, base } = event.data;
  const post = (msg: TerrainWorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
  try {
    let last = 0;
    const progress = (f: number) => {
      if (f - last >= 0.02) {
        last = f;
        post({ id, type: 'progress', value: 0.9 * f });
      }
    };
    const survey = findSurvey(settings.survey);
    const heightmap = survey ? await loadSurvey(survey, (path) => readFile(new URL(path, base)), progress) : generateHeightmap(settings, progress);
    const images = renderTerrain(heightmap);
    post(
      { id, type: 'done', heightmap, images },
      [heightmap.data.buffer, images.base.buffer, images.contours.buffer],
    );
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

async function readFile(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the surveyed terrain (${response.status} for ${url.pathname}).`);
  return response.arrayBuffer();
}
