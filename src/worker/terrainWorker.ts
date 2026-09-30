/**
 * Generates a heightmap and its images off the main thread. Messages carry an
 * id so the UI can ignore results from requests it has since replaced.
 */
import { generateHeightmap, type TerrainSettings } from '../core/terrain.ts';
import { renderTerrain } from '../core/terrainImage.ts';
import type { TerrainWorkerResponse } from './protocol.ts';

const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<{ id: number; settings: TerrainSettings }>) => {
  const { id, settings } = event.data;
  const post = (msg: TerrainWorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
  try {
    let last = 0;
    const heightmap = generateHeightmap(settings, (f) => {
      if (f - last >= 0.02) {
        last = f;
        post({ id, type: 'progress', value: 0.9 * f });
      }
    });
    const images = renderTerrain(heightmap);
    post(
      { id, type: 'done', heightmap, images },
      [heightmap.data.buffer, images.base.buffer, images.contours.buffer],
    );
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
