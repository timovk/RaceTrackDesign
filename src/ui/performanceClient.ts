/**
 * Runs lap-time, facility and licence analysis in a Web Worker. Only the
 * result of the latest request is delivered; older ones are dropped when
 * they arrive. The heightmap crosses to the worker once per terrain.
 */
import type { Heightmap } from '../core/heightmap.ts';
import type { Analysis, PerformanceRequest, PerformanceResponse } from '../worker/protocol.ts';

export type AnalysisRequest = Omit<PerformanceRequest, 'id' | 'heightmap' | 'terrainId'>;

export class PerformanceClient {
  private readonly worker = new Worker(new URL('../worker/performanceWorker.ts', import.meta.url), { type: 'module' });
  private latest = 0;
  private sentHeightmap: Heightmap | null = null;
  private terrainId = 0;

  constructor(onResult: (analysis: Analysis | null, error: string | null) => void) {
    this.worker.onmessage = (event: MessageEvent<PerformanceResponse>) => {
      const msg = event.data;
      if (msg.id !== this.latest) return;
      if (msg.type === 'done') onResult({ performance: msg.performance, facilities: msg.facilities, licence: msg.licence }, null);
      else onResult(null, msg.message);
    };
    this.worker.onerror = (event) => onResult(null, event.message || 'Analysis worker failed.');
  }

  request(req: AnalysisRequest, heightmap: Heightmap): void {
    const fresh = heightmap !== this.sentHeightmap;
    if (fresh) {
      this.sentHeightmap = heightmap;
      this.terrainId++;
    }
    const msg: PerformanceRequest = { ...req, id: ++this.latest, terrainId: this.terrainId, heightmap: fresh ? heightmap : undefined };
    this.worker.postMessage(msg);
  }

  /** Drops any result still on its way, e.g. when the track was removed. */
  cancel(): void {
    this.latest++;
  }
}
