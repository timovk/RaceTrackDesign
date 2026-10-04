import { describe, expect, it } from 'vitest';
import { placeFacilities } from '../src/core/facilities.ts';
import { type Heightmap, inWoods, sampleHeight } from '../src/core/heightmap.ts';
import { analysePerformance } from '../src/core/performance.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { findSurvey, loadSurvey } from '../src/core/survey.ts';
import { TEMPLATES, templateProject } from '../src/core/templates.ts';
import { buildTrack } from '../src/core/track.ts';
import { validateTrack } from '../src/core/validate.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { readPublic } from './helpers.ts';

async function ground(survey: string | undefined): Promise<Heightmap> {
  return loadSurvey(findSurvey(survey)!, readPublic);
}

describe('templates', () => {
  it('are projects the app can open, each a fresh copy', () => {
    for (const t of TEMPLATES) {
      const p = templateProject(t);
      expect(p.name).toBe(t.name);
      expect(p.track.points.length).toBeGreaterThan(3);
      for (const pt of p.track.points) {
        expect(pt.x).toBeGreaterThan(100);
        expect(pt.x).toBeLessThan(p.terrain.mapSize - 100);
        expect(pt.y).toBeGreaterThan(100);
        expect(pt.y).toBeLessThan(p.terrain.mapSize - 100);
      }
      p.track.points.length = 0;
      expect(templateProject(t).track.points.length).toBeGreaterThan(3);
    }
  });

  it('build without errors on their own ground', async () => {
    for (const t of TEMPLATES) {
      const p = templateProject(t);
      const hm = await ground(p.terrain.survey);
      const track = buildTrack(p.track, (x, y) => sampleHeight(hm, x, y))!;
      expect(validateTrack(track, hm, p.track.grading).filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
});

describe('Bremgarten 1954', async () => {
  const p = templateProject(TEMPLATES.find((t) => t.id === 'bremgarten')!);
  const hm = await ground(p.terrain.survey);
  const raw = buildTrack(p.track, (x, y) => sampleHeight(hm, x, y))!;
  const startFinish = placeStartFinish(raw, p.overrides.startFinish);
  const t = rotateTrack(raw, startFinish.station);

  it('is the 7.28 km lap, clockwise', () => {
    expect(Math.abs(t.length - 7280)).toBeLessThan(0.005 * 7280);
    let turn = 0;
    for (let k = 0; k < t.n; k++) turn += t.curvature[k] * t.ds;
    expect(turn).toBeCloseTo(2 * Math.PI, 1);
  });

  it('drops from the Forsthaus to the lake at Eymatt and climbs back', () => {
    let lo = 0;
    let hi = 0;
    for (let k = 0; k < t.n; k++) {
      if (t.z[k] < t.z[lo]) lo = k;
      if (t.z[k] > t.z[hi]) hi = k;
      expect(t.z[k]).toBeGreaterThan(hm.waterLevel + 5);
      // The road lies on the ground: no cutting or bank deeper than a few metres.
      expect(Math.abs(t.z[k] - t.terrain[k])).toBeLessThan(6);
    }
    expect(t.z[hi] - t.z[lo]).toBeGreaterThan(60);
    expect(t.z[hi] - t.z[lo]).toBeLessThan(70);
    // Eymatt is the north-west corner of the lap.
    expect(t.x[lo]).toBeLessThan(900);
    expect(t.y[lo]).toBeLessThan(1700);
  });

  it('has its one hairpin at the Forsthaus and the 9 m road of the day', () => {
    let tight = 0;
    for (let k = 1; k < t.n; k++) if (Math.abs(t.curvature[k]) > Math.abs(t.curvature[tight])) tight = k;
    expect(1 / Math.abs(t.curvature[tight])).toBeGreaterThan(18);
    expect(1 / Math.abs(t.curvature[tight])).toBeLessThan(32);
    // The south-east corner of the lap.
    expect(t.x[tight]).toBeGreaterThan(3350);
    expect(t.y[tight]).toBeGreaterThan(2500);
    expect(t.width.every((w) => w === 9)).toBe(true);
  });

  it('runs through the forest for most of the lap', () => {
    let wooded = 0;
    for (let k = 0; k < t.n; k++) {
      // Woods within 40 m on either side.
      const nx = Math.sin(t.heading[k]);
      const ny = -Math.cos(t.heading[k]);
      if (inWoods(hm, t.x[k] + nx * 40, t.y[k] + ny * 40) || inWoods(hm, t.x[k] - nx * 40, t.y[k] - ny * 40)) wooded++;
    }
    expect(wooded / t.n).toBeGreaterThan(0.85);
  });

  it('starts on the Murtenstrasse, with a pit lane that fits beside it', () => {
    expect(startFinish.overridden).toBe(true);
    const performance = analysePerformance(t, VEHICLES);
    const { pitLane } = placeFacilities({
      track: t, startFinish, performance, vehicles: VEHICLES,
      heightAt: (x, y) => sampleHeight(hm, x, y), waterLevel: hm.waterLevel, extent: hm.extent, overrides: p.overrides,
    });
    expect(pitLane?.overridden).toBe(true);
    expect(pitLane?.side).toBe(1);
    expect(pitLane?.problems).toEqual([]);
    expect(pitLane?.adjacentToStart).toBe(true);
  }, 60_000);
});
