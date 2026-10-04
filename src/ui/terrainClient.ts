/**
 * Runs terrain generation (or the reading of a surveyed terrain) in a Web
 * Worker. A new request while one is still running terminates the old worker,
 * so the latest settings always win.
 */
import type { Heightmap } from '../core/heightmap.ts';
import type { TerrainSettings } from '../core/terrain.ts';
import type { TerrainImages } from '../core/terrainImage.ts';
import type { TerrainWorkerResponse } from '../worker/protocol.ts';

export class CancelledError extends Error {
  constructor() {
    super('Terrain generation was replaced by a newer request.');
  }
}

export interface TerrainResult {
  heightmap: Heightmap;
  images: TerrainImages;
}

export class TerrainClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private inFlight: { id: number; reject: (e: Error) => void } | null = null;

  generate(settings: TerrainSettings, onProgress: (fraction: number) => void): Promise<TerrainResult> {
    if (this.inFlight) {
      this.inFlight.reject(new CancelledError());
      this.worker?.terminate();
      this.worker = null;
      this.inFlight = null;
    }
    const worker = (this.worker ??= new Worker(new URL('../worker/terrainWorker.ts', import.meta.url), { type: 'module' }));
    const id = this.nextId++;
    return new Promise<TerrainResult>((resolve, reject) => {
      this.inFlight = { id, reject };
      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        const msg = event.data;
        if (msg.id !== id) return;
        if (msg.type === 'progress') {
          onProgress(msg.value);
          return;
        }
        this.inFlight = null;
        if (msg.type === 'done') resolve({ heightmap: msg.heightmap, images: msg.images });
        else reject(new Error(msg.message));
      };
      worker.onerror = (event) => {
        this.inFlight = null;
        reject(new Error(event.message || 'Terrain worker failed.'));
      };
      // Surveyed terrain is read from files beside the page; a worker's own address is elsewhere.
      worker.postMessage({ id, settings, base: document.baseURI });
    });
  }
}
