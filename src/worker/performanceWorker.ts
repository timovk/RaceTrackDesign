/**
 * Computes the racing line, every class's lap and the sectors off the main
 * thread, so editing stays smooth. Results carry the request id; the client
 * ignores all but the latest.
 */
import { analysePerformance } from '../core/performance.ts';
import type { PerformanceRequest, PerformanceResponse } from './protocol.ts';

const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<PerformanceRequest>) => {
  const { id, track, vehicles } = event.data;
  let msg: PerformanceResponse;
  try {
    msg = { id, type: 'done', performance: analysePerformance(track, vehicles) };
  } catch (err) {
    msg = { id, type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(msg);
};
