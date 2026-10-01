/**
 * Computes the racing line, every class's lap, the sectors, the facilities
 * and the licence estimate off the main thread, so editing stays smooth.
 * Results carry the request id; the client ignores all but the latest.
 */
import { placeFacilities } from '../core/facilities.ts';
import { type Heightmap, sampleHeight } from '../core/heightmap.ts';
import { assessLicence } from '../core/licence.ts';
import { analysePerformance } from '../core/performance.ts';
import type { PerformanceRequest, PerformanceResponse } from './protocol.ts';

const scope = self as unknown as Worker;
let heightmap: Heightmap | null = null;
let heightmapId = -1;

scope.onmessage = (event: MessageEvent<PerformanceRequest>) => {
  const req = event.data;
  let msg: PerformanceResponse;
  try {
    if (req.heightmap) {
      heightmap = req.heightmap;
      heightmapId = req.terrainId;
    }
    if (!heightmap || heightmapId !== req.terrainId) throw new Error('The worker has no heightmap for this terrain.');
    const hm = heightmap;
    const performance = analysePerformance(req.track, req.vehicles);
    const facilities = placeFacilities({
      track: req.track, startFinish: req.startFinish, performance, vehicles: req.vehicles,
      heightAt: (x, y) => sampleHeight(hm, x, y), waterLevel: hm.waterLevel, extent: hm.extent, overrides: req.overrides, pitLane: req.pitLane,
    });
    const licence = assessLicence({
      track: req.track, metrics: req.metrics, issues: req.issues, performance, facilities, heightmap: hm, vehicles: req.vehicles,
    });
    msg = { id: req.id, type: 'done', performance, facilities, licence };
  } catch (err) {
    msg = { id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(msg);
};
