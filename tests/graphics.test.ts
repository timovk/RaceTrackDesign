import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { describe, expect, it } from 'vitest';
import { lensBlur } from '../src/ui/postFx.ts';
import { SunShadows, withLights } from '../src/ui/shadows.ts';
import { skyTurn, sunDirection } from '../src/ui/sky.ts';
import { surfaceFiles } from '../src/ui/surfaces.ts';

describe('lens blur', () => {
  it('blurs a long lens on a distant car by a few pixels and a wide one not at all', () => {
    const long = lensBlur({ fov: 3, focus: 200 }, 1080);
    expect(long).toBeGreaterThan(3);
    expect(long).toBeLessThan(15);
    expect(lensBlur({ fov: 1.5, focus: 200 }, 1080)).toBeGreaterThan(long * 3.5);
    expect(lensBlur({ fov: 50, focus: 20 }, 1080)).toBeLessThan(0.3);
  });

  it('blurs less the farther the lens focuses, and scales with the picture', () => {
    const near = lensBlur({ fov: 4, focus: 100 }, 1080);
    expect(lensBlur({ fov: 4, focus: 200 }, 1080)).toBeCloseTo(near / 2, 0);
    expect(lensBlur({ fov: 4, focus: 100 }, 2160)).toBeCloseTo(near * 2, 6);
  });

  it('stays finite for a lens focused closer than it can', () => {
    expect(Number.isFinite(lensBlur({ fov: 2, focus: 0 }, 1080))).toBe(true);
  });
});

describe('the sky', () => {
  it("has the sun in the north-west at the photograph's height", () => {
    const sun = sunDirection();
    expect(sun.length()).toBeCloseTo(1, 6);
    expect(sun.x).toBeLessThan(0);
    expect(sun.z).toBeLessThan(0);
    expect(sun.x).toBeCloseTo(sun.z, 6);
    expect((Math.asin(sun.y) * 180) / Math.PI).toBeCloseTo(47.9, 6);
  });

  it("turns the panorama so its sun stands where the scene's does", () => {
    for (const az of [-135, 0, 60, 170]) {
      const sun = sunDirection(az);
      const lon = Math.atan2(sun.z, sun.x) + skyTurn(sun);
      const deg = ((((lon * 180) / Math.PI) % 360) + 360) % 360;
      expect(deg).toBeCloseTo(34.2, 6);
    }
  });
});

describe('the shadow cascades', () => {
  // CSM puts its own copy of three.js's chunk in place for every material.
  const three = THREE.ShaderChunk.lights_fragment_begin;
  new CSM({ camera: new THREE.PerspectiveCamera(), parent: new THREE.Scene() });
  const csm = THREE.ShaderChunk.lights_fragment_begin;
  THREE.ShaderChunk.lights_fragment_begin = three;
  const merged = withLights(three, csm);

  it("keep three.js's set-up before the lights, so materials reflect the sky", () => {
    expect(csm).not.toContain('material.dfg');
    expect(merged).toContain('material.dfg = texture2D( dfgLUT');
    expect(merged).toContain('material.multiScatteringCompensation');
  });

  it("light with CSM's cascades, once", () => {
    expect(merged).toContain('CSM_cascades');
    expect(merged.split('IncidentLight directLight;').length).toBe(2);
    expect(merged.split('#if defined( RE_IndirectDiffuse )').length).toBe(2);
  });

  it("fall back to CSM's chunk when either is not as expected", () => {
    expect(withLights('something else', csm)).toBe(csm);
  });

  it('are set up with the merged chunk', () => {
    new SunShadows(new THREE.Scene(), new THREE.PerspectiveCamera(), new THREE.Vector3(0, 1, 0));
    expect(THREE.ShaderChunk.lights_fragment_begin).toBe(merged);
    THREE.ShaderChunk.lights_fragment_begin = three;
  });
});

describe('the surface textures', () => {
  it('are all in public/textures', () => {
    const files = surfaceFiles();
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) expect(existsSync(`public/${f}`), f).toBe(true);
  });
});
