/**
 * Materials for the 3D cars: one physical material for bodies and wheels
 * (per-vertex finish, liveries drawn in the shader from per-car colours and
 * a pattern, the DRS flap turning about its hinge), one for decals (number
 * panels and team names from an atlas, a cell per car), the sky reflected
 * in the paint, and a soft shadow under each car.
 *
 * Per-car (instanced) attributes: livA, livB, livC (linear rgb) and
 * livStyle (pattern, variation, DRS flap open 0..1, unused); wheels use livA
 * for the tyre compound's colour. Decals take decalCell (the cell's column
 * and row in the atlas).
 */
import * as THREE from 'three';
import type { CarMeshData } from '../core/carMesh.ts';

/** Cells per row and column of the decal atlas. */
export const DECAL_GRID = 8;
const CELL = 256;

const LIVERY_GLSL = /* glsl */`
float liveryEdge(float d) {
  float w = max(fwidth(d), 1e-4);
  return smoothstep(-w, w, d);
}

vec3 livery() {
  if (vZone > 3.5) return vLivC;
  if (vZone > 2.5) return vLivB;
  if (vZone > 1.5) return vLivA;
  float u = vLivUv.x;
  // 0 along the top, 0.5 on the sides, 1 underneath.
  float s = abs(vLivUv.y - 0.5) * 2.0;
  int pattern = int(vLivStyle.x + 0.5);
  float q = vLivStyle.y;
  vec3 col = vLivA;
  if (vZone > 0.5) {
    // Side bodywork: the second colour below a line, an accent pinstripe on it.
    float line = 0.55 + 0.12 * q - 0.1 * u;
    col = mix(vLivA, vLivB, liveryEdge(s - line));
    col = mix(col, vLivC, liveryEdge(s - line + 0.025) * (1.0 - liveryEdge(s - line - 0.005)));
    return col;
  }
  if (pattern == 0) {
    // A broad stripe along the spine with accent edges, the nose in the second colour.
    float w = 0.1 + 0.08 * q;
    col = mix(vLivB, vLivA, liveryEdge(s - w));
    col = mix(col, vLivC, liveryEdge(s - w + 0.02) * (1.0 - liveryEdge(s - w - 0.02)));
    col = mix(col, vLivB, liveryEdge(u - 0.93));
  } else if (pattern == 1) {
    // Two tones split on a diagonal, an accent line between them.
    float d = u - (0.42 + 0.15 * q) - (s - 0.5) * 0.4;
    col = mix(vLivB, vLivA, liveryEdge(d));
    col = mix(col, vLivC, liveryEdge(d + 0.012) * (1.0 - liveryEdge(d - 0.012)));
  } else if (pattern == 2) {
    // Twin racing stripes over the top, the lower body in the accent colour.
    float a = liveryEdge(s - 0.04) * (1.0 - liveryEdge(s - 0.13 - 0.04 * q));
    col = mix(vLivA, vLivB, a);
    col = mix(col, vLivC, liveryEdge(s - 0.8));
  } else if (pattern == 3) {
    // The second colour sweeping up the sides towards the front.
    float b = 0.78 - 0.38 * u - 0.1 * q;
    col = mix(vLivA, vLivB, liveryEdge(s - b));
    col = mix(col, vLivC, liveryEdge(s - b + 0.03) * (1.0 - liveryEdge(s - b)));
  } else {
    // An arrow pointing forward over the top, the accent colour on the nose.
    float d = u - 0.5 - s * (0.55 + 0.3 * q);
    col = mix(vLivA, vLivB, liveryEdge(d) * (1.0 - liveryEdge(d - 0.12)));
    col = mix(col, vLivC, liveryEdge(u - 0.95));
  }
  return col;
}
`;

/** The material for car bodies and wheels; one per scene. */
export function carMaterial(envMap: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, vertexColors: true, envMap, envMapIntensity: 1.1,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 finish;
attribute float zone;
attribute vec3 hinge;
attribute vec3 livA;
attribute vec3 livB;
attribute vec3 livC;
attribute vec4 livStyle;
varying vec4 vFinish;
varying float vZone;
varying vec2 vLivUv;
varying vec3 vLivA;
varying vec3 vLivB;
varying vec3 vLivC;
varying vec4 vLivStyle;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
// The DRS flap turns about its hinge (lifting its leading edge) by up to half a radian.
float flapTurn = hinge.z * livStyle.z * 0.5;
float flapC = cos(flapTurn);
float flapS = sin(flapTurn);
objectNormal.xy = vec2(flapC * objectNormal.x - flapS * objectNormal.y, flapS * objectNormal.x + flapC * objectNormal.y);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vec2 flapD = transformed.xy - hinge.xy;
if (hinge.z > 0.5) transformed.xy = hinge.xy + vec2(flapC * flapD.x - flapS * flapD.y, flapS * flapD.x + flapC * flapD.y);
vFinish = finish;
vZone = zone;
vLivUv = uv;
vLivA = livA;
vLivB = livB;
vLivC = livC;
vLivStyle = livStyle;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vFinish;
varying float vZone;
varying vec2 vLivUv;
varying vec3 vLivA;
varying vec3 vLivB;
varying vec3 vLivC;
varying vec4 vLivStyle;
${LIVERY_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if (vZone > -0.5) diffuseColor.rgb = livery();
else if (vZone < -1.5) diffuseColor.rgb = vLivA;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = vFinish.x;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = vFinish.y;`)
      .replace('#include <lights_physical_fragment>', THREE.ShaderChunk.lights_physical_fragment
        .replace('material.clearcoat = clearcoat;', 'material.clearcoat = vFinish.z;')
        // Rough trim (rubber, satin carbon) reflects the sky less, even at grazing angles.
        .replace('#ifdef USE_CLEARCOAT', `float trimSpecular = mix(1.0, 0.2, smoothstep(0.3, 0.9, roughnessFactor));
material.specularColor *= trimSpecular;
material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);
material.specularF90 = mix(material.specularF90 * trimSpecular, 1.0, metalnessFactor);
#ifdef USE_CLEARCOAT`))
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * vFinish.w;`);
  };
  m.customProgramCacheKey = () => 'car-body';
  return m;
}

/** The material for decals, from the atlas: a car's cell picked per instance. */
export function decalMaterial(atlas: THREE.Texture, envMap: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: atlas, alphaTest: 0.5, roughness: 0.35, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMap, envMapIntensity: 1.1,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 decalCell;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vMapUv = (decalCell + uv) / ${DECAL_GRID.toFixed(1)};`);
  };
  m.customProgramCacheKey = () => 'car-decal';
  return m;
}

/** A geometry from car mesh data, with room for `count` instances' livery attributes. */
export function carGeometry(m: CarMeshData, count: number, decals = false): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  if (decals) {
    g.setAttribute('decalCell', new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2));
  } else {
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setAttribute('finish', new THREE.BufferAttribute(m.finish, 4));
    g.setAttribute('zone', new THREE.BufferAttribute(m.zone, 1));
    g.setAttribute('hinge', new THREE.BufferAttribute(m.hinge, 3));
    for (const name of ['livA', 'livB', 'livC']) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('livStyle', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
  }
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** A '#rrggbb' colour as linear rgb. */
export function linearRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/**
 * The sky reflected in the cars: a blue zenith fading to a pale horizon,
 * the ground below it, and the sun in the north-west, as an environment map.
 */
export function skyEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 48, 24);
  const colors: number[] = [];
  const zenith = new THREE.Color('#2f6cb4');
  const horizon = new THREE.Color('#dfe9f2');
  const ground = new THREE.Color('#4d5240');
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 100;
    const c = y >= 0 ? horizon.clone().lerp(zenith, Math.pow(y, 0.6)) : horizon.clone().lerp(ground, Math.min(1, -y * 6));
    colors.push(c.r * 1.2, c.g * 1.2, c.b * 1.2);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.85).multiplyScalar(30) }));
  sun.position.set(-1, 1.3, -1).normalize().multiplyScalar(90);
  scene.add(sun);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  geo.dispose();
  return texture;
}

/** A soft dark oval, for the shadow under a car. */
export function shadowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface DecalCar {
  number: string;
  team: string;
  /** How the number is shown: painted straight on (single-seaters), on a panel, or in a roundel. */
  style: 'painted' | 'panel' | 'roundel';
  /** Panel colour ('#rrggbb'); the number is white on it, or black on white when absent. */
  panel?: string;
}

/** The decal atlas: per car (in order) its number panel in the upper half of its cell and its team name in the lower half. */
export function decalAtlas(cars: readonly DecalCar[]): THREE.CanvasTexture {
  const size = CELL * DECAL_GRID;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  cars.slice(0, DECAL_GRID * DECAL_GRID).forEach((car, i) => {
    const col = i % DECAL_GRID;
    const row = Math.floor(i / DECAL_GRID);
    // Cell (col, row) counts rows from the bottom of the texture (flipped on upload).
    const x0 = col * CELL;
    const y0 = (DECAL_GRID - 1 - row) * CELL;
    // Number panel: the upper half of the cell, 2:1.
    const nx = x0 + CELL / 2;
    const ny = y0 + CELL / 4;
    if (car.style === 'painted') {
      ctx.font = `italic 900 ${CELL * 0.4}px "Arial Black", "Segoe UI", system-ui, sans-serif`;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(car.number, nx, ny + 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(car.number, nx, ny + 4);
    } else {
      const back = car.panel ?? '#ffffff';
      const ink = car.panel ? '#ffffff' : '#111111';
      ctx.fillStyle = back;
      ctx.strokeStyle = car.panel ? '#ffffff' : '#111111';
      ctx.lineWidth = 6;
      if (car.style === 'roundel') {
        ctx.beginPath();
        ctx.arc(nx, ny, CELL * 0.235, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.roundRect(x0 + 12, y0 + 12, CELL - 24, CELL / 2 - 24, 14);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = ink;
      ctx.font = `900 ${car.style === 'roundel' ? CELL * 0.26 : CELL * 0.3}px "Arial Black", "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(car.number, nx, ny + 4);
    }
    // Team name: the lower half, fitted to the width.
    const name = car.team.toUpperCase();
    let fontSize = CELL * 0.16;
    ctx.font = `800 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    const w = ctx.measureText(name).width;
    if (w > CELL * 0.92) fontSize *= (CELL * 0.92) / w;
    ctx.font = `800 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    ctx.lineWidth = Math.max(3, fontSize * 0.14);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(name, x0 + CELL / 2, y0 + CELL * 0.75);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, x0 + CELL / 2, y0 + CELL * 0.75);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
