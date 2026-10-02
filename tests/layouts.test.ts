import { describe, expect, it } from 'vitest';
import { VERGE } from '../src/core/earthworks.ts';
import { placeFacilities } from '../src/core/facilities.ts';
import { simulateLap } from '../src/core/lapSim.ts';
import { type LayoutDesign, type LinkDesign, buildLayout, layoutPitLane, layoutStation } from '../src/core/layouts.ts';
import { analysePerformance } from '../src/core/performance.ts';
import { newProject, parseProject, serializeProject } from '../src/core/project.ts';
import { computeRacingLine } from '../src/core/racingLine.ts';
import { placeStartFinish, rotateTrack } from '../src/core/startFinish.ts';
import { DEFAULT_GRADING, buildTrack } from '../src/core/track.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { bigRectangle, design } from './helpers.ts';

// The big rectangle: the top straight runs east along y = 3000, the bottom one west along y = 3900.
// Rolling ground, so the track and the links are graded; the start line on the west half of the top straight.
const ground = (x: number, y: number) => 100 + 15 * Math.sin(x / 300) * Math.cos(y / 260);
const raw = buildTrack(design(bigRectangle(), DEFAULT_GRADING), ground)!;
const full = rotateTrack(raw, placeStartFinish(raw, { x: 3300, y: 3000 }).station);

/** A shortcut across the infield at x = `at`: off the top straight, round to the right, onto the bottom straight. */
function shortcut(at = 3800): LinkDesign {
  return { from: { x: at, y: 3000 }, to: { x: at, y: 3900 }, points: [{ x: at + 80, y: 3150, width: 12 }, { x: at + 100, y: 3450, width: 12 }, { x: at + 80, y: 3750, width: 12 }] };
}

const layout = (...links: LinkDesign[]): LayoutDesign => ({ name: 'Short', links, race: null });

describe('layouts', () => {
  const build = buildLayout(full, layout(shortcut()), ground, DEFAULT_GRADING);
  const t = build.track!;

  it('runs on the full circuit where it shares it, from its start line, and along the link where it leaves', () => {
    expect(build.errors).toEqual([]);
    expect(t).not.toBeNull();
    expect(t.length).toBeGreaterThan(3000);
    expect(t.length).toBeLessThan(full.length - 1200);
    expect(build.shared[0]).toBe(0);
    let onLink = 0;
    for (let k = 0; k < t.n; k++) {
      const f = build.shared[k];
      if (f < 0) {
        onLink++;
        continue;
      }
      // The same road at the same height.
      expect(t.x[k]).toBe(full.x[f]);
      expect(t.y[k]).toBe(full.y[f]);
      expect(t.z[k]).toBe(full.z[f]);
      expect(t.width[k]).toBe(full.width[f]);
    }
    const l = build.links[0];
    expect(onLink).toBe(l.x.length - 2);
    // About the length of the path from end to end, a station every couple of metres.
    let len = 0;
    for (let j = 1; j < l.x.length; j++) len += Math.hypot(l.x[j] - l.x[j - 1], l.y[j] - l.y[j - 1]);
    expect(onLink * t.ds).toBeGreaterThan(len - 3 * t.ds);
    expect(onLink * t.ds).toBeLessThan(len + t.ds);
    expect(layoutStation(build, 0)).toBe(0);
    expect(layoutStation(build, l.from)).toBeGreaterThan(0);
  });

  it('leaves and joins the track without a kink or a step, graded to meet it', () => {
    for (let k = 0; k < t.n; k++) {
      const k1 = (k + 1) % t.n;
      let dh = t.heading[k1] - t.heading[k];
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      expect(Math.abs(dh)).toBeLessThan(0.06);
      expect(Math.abs(t.z[k1] - t.z[k])).toBeLessThan(0.3);
      expect(Math.abs(t.z[k] - t.terrain[k])).toBeLessThanOrEqual(DEFAULT_GRADING.maxCutFill + 1e-9);
    }
  });

  it('keeps the circuit’s surface where the link still overlaps it, so neither road’s grass covers the other', () => {
    const l = build.links[0];
    // The full circuit's centreline distance, half width and surface height nearest a point.
    const under = (x: number, y: number) => {
      let best = { d: Infinity, half: 0, z: 0 };
      for (let k = 0; k < full.n; k++) {
        const k1 = (k + 1) % full.n;
        const dx = full.x[k1] - full.x[k];
        const dy = full.y[k1] - full.y[k];
        const f = Math.max(0, Math.min(1, ((x - full.x[k]) * dx + (y - full.y[k]) * dy) / (dx * dx + dy * dy)));
        const d = Math.hypot(x - full.x[k] - dx * f, y - full.y[k] - dy * f);
        if (d < best.d) best = { d, half: full.width[k] / 2, z: full.z[k] + (full.z[k1] - full.z[k]) * f };
      }
      return best;
    };
    let overlapping = 0;
    for (let j = 1; j < l.x.length - 1; j++) {
      const s = under(l.x[j], l.y[j]);
      // The two roads and their verges overlap.
      if (s.d >= s.half + l.width[j] / 2 + VERGE) continue;
      overlapping++;
      expect(Math.abs(l.z[j] - s.z)).toBeLessThan(0.01);
    }
    // At both ends: the link parts from the track at a shallow angle.
    expect(overlapping).toBeGreaterThan(20);
  });

  it('gives the same lap when its link moves by a millimetre or so', () => {
    const f1 = VEHICLES.find((v) => v.id === 'f1')!;
    const s = shortcut();
    const laps = [0, 0.001, -0.002, 0.003, 0.01].map((d) => {
      // Each point moves its own way.
      const nudge = <P extends { x: number; y: number }>(p: P, i: number): P => ({ ...p, x: p.x + d * Math.cos(i), y: p.y + d * Math.sin(i) });
      const link: LinkDesign = { from: nudge(s.from, 0), to: nudge(s.to, 1), points: s.points.map((p, i) => nudge(p, i + 2)) };
      const track = buildLayout(full, layout(link), ground, DEFAULT_GRADING).track!;
      return simulateLap(track, computeRacingLine(track), f1).time;
    });
    expect(Math.max(...laps) - Math.min(...laps)).toBeLessThan(0.01);
  });

  it('is the same whichever way round the link was drawn', () => {
    const s = shortcut();
    const back = buildLayout(full, layout({ from: s.to, to: s.from, points: [...s.points].reverse() }), ground, DEFAULT_GRADING);
    expect(back.errors).toEqual([]);
    expect(back.track!.n).toBe(t.n);
    expect([...back.shared]).toEqual([...build.shared]);
  });

  it('refuses a layout with no link, a link off the track, one that skips the start line, or links that overlap', () => {
    const errors = (l: LayoutDesign) => buildLayout(full, l, ground, DEFAULT_GRADING).errors.join(' ');
    expect(errors(layout())).toMatch(/no link/);
    expect(errors(layout({ ...shortcut(), from: { x: 3800, y: 3100 } }))).toMatch(/start and end on the track/);
    expect(errors(layout(shortcut(3200)))).toMatch(/start\/finish/);
    expect(errors(layout(shortcut(3800), shortcut(4200)))).toMatch(/overlap/);
    expect(buildLayout(full, layout(shortcut(3200)), ground, DEFAULT_GRADING).track).toBeNull();
  });

  it('warns when a link crosses the circuit on the level', () => {
    expect(build.warnings).toEqual([]);
    // Out across the right-hand side of the rectangle and back in across it.
    const loop: LinkDesign = {
      from: { x: 4200, y: 3000 }, to: { x: 4200, y: 3900 },
      points: [{ x: 4400, y: 3150, width: 12 }, { x: 4800, y: 3300, width: 12 }, { x: 4800, y: 3600, width: 12 }, { x: 4400, y: 3750, width: 12 }],
    };
    const crossing = buildLayout(full, layout(loop), ground, DEFAULT_GRADING);
    expect(crossing.errors).toEqual([]);
    expect(crossing.warnings.map((w) => w.message).join(' ')).toMatch(/crosses the circuit/);
    expect(crossing.warnings[0].link).toBe(0);
  });

  it('shares the full circuit’s pit lane, unless it skips the track beside it', () => {
    const perf = analysePerformance(full, VEHICLES.filter((v) => v.id === 'f1' || v.id === 'gt3'));
    const facilities = placeFacilities({
      track: full, startFinish: { station: 0, firstCornerDistance: 1000, gridMaxGradient: 0, gridMinWidth: 15, gridStraightness: 1, overridden: true },
      performance: perf, vehicles: VEHICLES, heightAt: ground, waterLevel: -Infinity, extent: 8192,
      overrides: { pitLane: { entry: { x: 3080, y: 3000 }, exit: { x: 3700, y: 3000 }, side: 1 } },
    });
    const pit = facilities.pitLane!;
    expect(pit).not.toBeNull();
    const shared = layoutPitLane(build, pit, full.n)!;
    expect(shared).not.toBeNull();
    expect(t.x[shared.entry]).toBe(full.x[pit.entry]);
    expect(t.y[shared.exit]).toBe(full.y[pit.exit]);
    expect(shared.x).toBe(pit.x);
    // A layout given it keeps it as it is.
    const layoutPerf = analysePerformance(t, VEHICLES.filter((v) => v.id === 'f1'));
    const layoutFacilities = placeFacilities({
      track: t, startFinish: { station: 0, firstCornerDistance: 1000, gridMaxGradient: 0, gridMinWidth: 15, gridStraightness: 1, overridden: true },
      performance: layoutPerf, vehicles: VEHICLES, heightAt: ground, waterLevel: -Infinity, extent: 8192, overrides: {}, pitLane: shared,
    });
    expect(layoutFacilities.pitLane).toBe(shared);
    expect(layoutFacilities.pitLoss[0].loss).toBeGreaterThan(5);
    // Leaving the top straight before the pit exit cuts the pit lane out.
    expect(layoutPitLane(buildLayout(full, layout(shortcut(3550)), ground, DEFAULT_GRADING), pit, full.n)).toBeNull();
  });

  it('keeps layouts in the project file, rounded, and drops broken links', () => {
    const p = newProject('7');
    p.layouts = [{ name: 'National', links: [{ ...shortcut(), from: { x: 3800.123, y: 3000.456 } }], race: null }];
    const back = parseProject(serializeProject(p));
    expect(back.layouts).toHaveLength(1);
    expect(back.layouts[0].name).toBe('National');
    expect(back.layouts[0].links[0].from).toEqual({ x: 3800.12, y: 3000.46 });
    expect(back.layouts[0].links[0].points).toEqual(shortcut().points);
    const broken = JSON.parse(serializeProject(p));
    delete broken.layouts[0].links[0].to;
    expect(parseProject(JSON.stringify(broken)).layouts).toEqual([]);
    // Older files have none.
    const old = JSON.parse(serializeProject(newProject('7')));
    delete old.layouts;
    expect(parseProject(JSON.stringify(old)).layouts).toEqual([]);
  });
});
