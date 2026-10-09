/**
 * Materials for the 3D cars: one physical material for bodies and wheels
 * (per-vertex finish, liveries drawn in the shader from per-car colours and
 * a pattern, the DRS flap turning about its hinge), one for decals (number
 * panels and team names from an atlas, a cell per car), the sky reflected
 * in the paint, and the shadow each model lays on the road under it.
 *
 * The body material also gives each kind of trim its look (the weave of
 * carbon, the tread and sidewall of a tyre, glass one sees a little way
 * into), darkens what sees little of the sky (the occlusion baked into the
 * model), and shows a car's damage: a broken nose part gone, scuffed paint.
 *
 * Per-vertex: finish, tags (how it is coloured, which light it is, what it
 * is made of, its occlusion) and hinge (with the part it belongs to).
 * Per-car (instanced) attributes: livA, livB, livC (linear rgb), livStyle
 * (pattern, variation, DRS flap open 0..1, lights) and carState (damage
 * bits, a number of the car's own); wheels use livA for the tyre compound's
 * colour. Decals take decalCell (the cell's column and row in the atlas).
 * The lights are bits (LIGHTS): the rear (rain) light, bright headlights,
 * each of the safety car's beacons, and running lights (a closed car's tail
 * lights glow when the rear light is off). With the instance matrix that is
 * sixteen attributes, as many as WebGL promises: another needs one packed.
 */
import * as THREE from 'three';
import type { CarMeshData } from '../core/carMesh.ts';
import type { GroundShadow } from '../core/carShade.ts';

/** Bits of livStyle.w: which of a car's lights are on. */
export const LIGHTS = { rear: 1, head: 2, beaconA: 4, beaconB: 8, running: 16 } as const;

/** Bits of carState.x: the nose part (front wing, splitter) is gone; the paint is scuffed; the car is wrecked. */
export const DAMAGE = { nose: 1, scuffed: 2, wrecked: 4 } as const;

/** Cells per row and column of the decal atlas. */
export const DECAL_GRID = 8;
const CELL = 256;

const LIVERY_GLSL = /* glsl */`
float liveryEdge(float d) {
  float w = max(fwidth(d), 1e-4);
  return smoothstep(-w, w, d);
}

float carHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float carNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(carHash(i), carHash(i + vec2(1.0, 0.0)), f.x), mix(carHash(i + vec2(0.0, 1.0)), carHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec3 livery() {
  float vZone = vTags.x;
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
attribute vec4 tags;
attribute vec3 hinge;
attribute vec3 livA;
attribute vec3 livB;
attribute vec3 livC;
attribute vec4 livStyle;
attribute vec4 carState;
varying vec4 vTags;
varying vec4 vFinish;
varying vec2 vLivUv;
varying vec3 vLivA;
varying vec3 vLivB;
varying vec3 vLivC;
varying vec4 vLivStyle;
varying vec4 vCarState;
varying vec3 vObjPos;
varying vec3 vObjNormal;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
// The DRS flap (part 1) turns about its hinge (lifting its leading edge) by up to half a radian.
float isFlap = hinge.z > 0.5 && hinge.z < 1.5 ? 1.0 : 0.0;
float flapTurn = isFlap * livStyle.z * 0.5;
float flapC = cos(flapTurn);
float flapS = sin(flapTurn);
vObjNormal = objectNormal;
objectNormal.xy = vec2(flapC * objectNormal.x - flapS * objectNormal.y, flapS * objectNormal.x + flapC * objectNormal.y);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vObjPos = transformed;
vec2 flapD = transformed.xy - hinge.xy;
if (isFlap > 0.5) transformed.xy = hinge.xy + vec2(flapC * flapD.x - flapS * flapD.y, flapS * flapD.x + flapC * flapD.y);
vFinish = finish;
vTags = tags;
vLivUv = uv;
vLivA = livA;
vLivB = livB;
vLivC = livC;
vLivStyle = livStyle;
vCarState = carState;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
// A broken nose part (part 2) is gone: its vertices leave the picture.
if (hinge.z > 1.5 && mod(carState.x, 2.0) > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vTags;
varying vec4 vFinish;
varying vec2 vLivUv;
varying vec3 vLivA;
varying vec3 vLivB;
varying vec3 vLivC;
varying vec4 vLivStyle;
varying vec4 vCarState;
varying vec3 vObjPos;
varying vec3 vObjNormal;
${LIVERY_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float carZone = vTags.x;
float carKind = vTags.z;
vec3 objN = normalize(vObjNormal);
float carRough = vFinish.x;
float carCoat = vFinish.z;
if (carZone > -0.5) {
  diffuseColor.rgb = livery();
  // Scuffed paint: patches of fine scratches along the car through to the primer, low on its sides, more of them on a wreck.
  int damage = int(vCarState.x + 0.5);
  if ((damage & ${DAMAGE.scuffed | DAMAGE.wrecked}) != 0) {
    float seed = vCarState.y * 31.0;
    float wreck = (damage & ${DAMAGE.wrecked}) != 0 ? 1.0 : 0.0;
    float streak = carNoise(vec2(vObjPos.x * 9.0 + seed, vObjPos.y * 190.0 + abs(vObjPos.z) * 80.0));
    float blotch = carNoise(vec2(vObjPos.x * 2.2 + seed * 3.0, vObjPos.y * 3.0 + vObjPos.z * 2.0));
    float where = (1.0 - smoothstep(0.3, 0.8, objN.y)) * (1.0 - smoothstep(0.35, 1.0, vObjPos.y));
    float worn = smoothstep(mix(0.6, 0.42, wreck), mix(0.75, 0.62, wreck), blotch) * where;
    float scuff = worn * smoothstep(0.38, 0.6, streak);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.05, 0.052), scuff * 0.8);
    carRough = mix(carRough, 0.85, max(scuff, worn * 0.5));
    carCoat *= 1.0 - max(scuff, worn * 0.6);
  }
} else if (carZone < -1.5) {
  // The compound's band round the sidewall, broken twice a turn by the maker's lettering.
  float turn = fract(vLivUv.x * 2.0);
  float letters = step(0.5, fract(vLivUv.x * 46.0)) * step(0.02, turn) * step(turn, 0.12);
  diffuseColor.rgb = mix(vec3(0.02), vLivA, smoothstep(0.14, 0.15, turn));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.7), letters);
} else if (carKind > 0.5 && carKind < 1.5) {
  // Carbon: a twill of tows 6 mm wide, each over two and under two, drawn in the plane the surface faces most.
  // The tows that run one way catch the light, the others do not; it fades out where a tow is under two pixels.
  vec3 an = abs(objN);
  vec2 q = (an.y > an.x && an.y > an.z ? vObjPos.xz : an.x > an.z ? vObjPos.zy : vObjPos.xy) / 0.006;
  float fade = 1.0 - smoothstep(0.2, 0.5, max(fwidth(q.x), fwidth(q.y)));
  vec2 cell = floor(q);
  float warp = step(mod(cell.x - cell.y, 4.0), 1.5);
  vec2 f = fract(q) - 0.5;
  float across = warp > 0.5 ? f.x : f.y;
  float ridge = 1.0 - 4.0 * across * across;
  diffuseColor.rgb *= mix(1.0, mix(0.45, 2.3, ridge) * mix(0.55, 1.5, warp), fade);
  carRough = mix(carRough, mix(0.62, 0.26, warp), fade);
} else if (carKind > 1.5 && carKind < 2.5) {
  // Rubber: the tread scuffed grey and dull, the sidewall darker with a sheen and fine rings moulded round it.
  float tread = 1.0 - smoothstep(0.35, 0.8, abs(objN.z));
  float radius = length(vObjPos.xy) * 480.0;
  float rings = (0.5 + 0.5 * sin(radius)) * (1.0 - smoothstep(0.6, 1.6, fwidth(radius)));
  diffuseColor.rgb *= mix(1.0 - 0.3 * rings, 1.7, tread);
  carRough = mix(0.72, 0.96, tread);
} else if (carKind > 2.5) {
  // Glass: looking straight in one sees a little of the cabin, lighter higher up where the far windows are; at a glancing angle only the sky in it.
  float into = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.115, 0.14), 0.75 * into * into * smoothstep(0.6, 1.25, vObjPos.y));
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = carRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = vFinish.y;`)
      .replace('#include <lights_physical_fragment>', THREE.ShaderChunk.lights_physical_fragment
        .replace('material.clearcoat = clearcoat;', 'material.clearcoat = carCoat;')
        // Rough trim (rubber, satin carbon) reflects the sky less, even at grazing angles.
        .replace('#ifdef USE_CLEARCOAT', `float trimSpecular = mix(1.0, 0.2, smoothstep(0.3, 0.9, roughnessFactor));
material.specularColor *= trimSpecular;
material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);
material.specularF90 = mix(material.specularF90 * trimSpecular, 1.0, metalnessFactor);
#ifdef USE_CLEARCOAT`))
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
// The shading baked into the model: what sees little of the sky gets little of its light, and deep in a crevice less of the sun as well.
float carAo = vTags.w;
reflectedLight.indirectDiffuse *= mix(0.12, 1.0, carAo);
reflectedLight.indirectSpecular *= mix(0.2, 1.0, carAo);
reflectedLight.directDiffuse *= mix(0.68, 1.0, carAo);
reflectedLight.directSpecular *= mix(0.5, 1.0, carAo);
#ifdef USE_CLEARCOAT
clearcoatSpecularIndirect *= mix(0.2, 1.0, carAo);
clearcoatSpecularDirect *= mix(0.5, 1.0, carAo);
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// Lights glow brighter when switched on, and the rear light of a single-seater or bike is dark when off.
float lampGain = 1.0;
float vLamp = vTags.y;
if (vLamp > 0.5) {
  int lights = int(vLivStyle.w + 0.5);
  if (vLamp < 1.5) lampGain = (lights & ${LIGHTS.head}) != 0 ? 4.0 : 1.0;
  else if (vLamp < 2.5) lampGain = (lights & ${LIGHTS.rear}) != 0 ? 7.0 : (lights & ${LIGHTS.running}) != 0 ? 1.0 : 0.12;
  else if (vLamp < 3.5) lampGain = (lights & ${LIGHTS.beaconA}) != 0 ? 2.5 : 0.04;
  else lampGain = (lights & ${LIGHTS.beaconB}) != 0 ? 2.5 : 0.04;
}
totalEmissiveRadiance += vColor.rgb * vFinish.w * lampGain;`);
  };
  m.customProgramCacheKey = () => 'car-body-4';
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
    // How it is coloured, which light it is, what it is made of and its occlusion, in one attribute.
    const tags = new Float32Array(m.zone.length * 4);
    for (let i = 0; i < m.zone.length; i++) {
      tags[i * 4] = m.zone[i];
      tags[i * 4 + 1] = m.lamp[i];
      tags[i * 4 + 2] = m.material[i];
      tags[i * 4 + 3] = m.ao[i];
    }
    g.setAttribute('tags', new THREE.BufferAttribute(tags, 4));
    g.setAttribute('hinge', new THREE.BufferAttribute(m.hinge, 3));
    for (const name of ['livA', 'livB', 'livC']) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('livStyle', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
    g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4));
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
 * The sky reflected in the cars and the wet track, as an environment map:
 * a blue zenith fading to a pale horizon, the ground below it, and the sun
 * in the north-west; under cloud (`cover` 1) a flat grey sky and no sun.
 */
export function skyEnvironment(renderer: THREE.WebGLRenderer, cover = 0): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 48, 24);
  const colors: number[] = [];
  const zenith = new THREE.Color('#2f6cb4').lerp(new THREE.Color('#7d848c'), cover);
  const horizon = new THREE.Color('#dfe9f2').lerp(new THREE.Color('#aab0b6'), cover);
  const ground = new THREE.Color('#4d5240').lerp(new THREE.Color('#3a3d38'), cover);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 100;
    const c = y >= 0 ? horizon.clone().lerp(zenith, Math.pow(y, 0.6)) : horizon.clone().lerp(ground, Math.min(1, -y * 6));
    colors.push(c.r * 1.2, c.g * 1.2, c.b * 1.2);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  if (cover < 0.95) {
    const sun = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.85).multiplyScalar(30 * (1 - cover) ** 2) }));
    sun.position.set(-1, 1.3, -1).normalize().multiplyScalar(90);
    scene.add(sun);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  geo.dispose();
  return texture;
}

/**
 * The shadow a model lays on the road under it (core/carShade.ts), as a
 * mesh to instance per car: a quad over the shadow's grid in car
 * coordinates, flat on the road, black and as dark as the grid says.
 */
export function groundShadowMesh(shadow: GroundShadow, capacity: number): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const pixels = new Uint8Array(shadow.data.length * 4);
  for (let i = 0; i < shadow.data.length; i++) pixels[i * 4 + 3] = shadow.data[i];
  // A row of the grid runs across the car: the picture is as wide as the car is, and as high as it is long.
  const map = new THREE.DataTexture(pixels, shadow.nz, shadow.nx, THREE.RGBAFormat);
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  const x1 = shadow.x0 + shadow.nx * shadow.cell;
  const z1 = shadow.z0 + shadow.nz * shadow.cell;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([shadow.x0, 0, shadow.z0, shadow.x0, 0, z1, x1, 0, shadow.z0, x1, 0, z1], 3));
  // (Facing up: the picture's finish reads the normals of everything drawn, and takes a surface without one for a hole.)
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 1, 3, 0, 3, 2]);
  const material = new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
  const mesh = new THREE.InstancedMesh(g, material, capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.renderOrder = 1;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
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
