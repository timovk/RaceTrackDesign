/**
 * Runs lap-time analysis in a Web Worker. Only the result of the latest
 * request is delivered; older ones are dropped when they arrive.
 */
import type { Performance } from '../core/performance.ts';
import type { Track } from '../core/track.ts';
import type { VehicleClass } from '../core/vehicles.ts';
import type { PerformanceRequest, PerformanceResponse } from '../worker/protocol.ts';

export class PerformanceClient {
  private readonly worker = new Worker(new URL('../worker/performanceWorker.ts', import.meta.url), { type: 'module' });
  private latest = 0;

  constructor(onResult: (performance: Performance | null, error: string | null) => void) {
    this.worker.onmessage = (event: MessageEvent<PerformanceResponse>) => {
      const msg = event.data;
      if (msg.id !== this.latest) return;
      if (msg.type === 'done') onResult(msg.performance, null);
      else onResult(null, msg.message);
    };
    this.worker.onerror = (event) => onResult(null, event.message || 'Lap-time worker failed.');
  }

  request(track: Track, vehicles: readonly VehicleClass[]): void {
    const msg: PerformanceRequest = { id: ++this.latest, track, vehicles };
    this.worker.postMessage(msg);
  }

  /** Drops any result still on its way, e.g. when the track was removed. */
  cancel(): void {
    this.latest++;
  }
}
