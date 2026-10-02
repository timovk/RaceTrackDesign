/**
 * The sky and weather in the 3D view (core/weatherFx.ts works out the
 * figures from the race's weather):
 *
 * - the sky (ui/sky.ts): photographed skies, partly cloudy on a fine day,
 *   blending to overcast before a shower and back after it, with the light
 *   they give (image-based lighting) and the sun; a dim sun, softer light
 *   and haze in the rain. Until the photographs have loaded, a painted
 *   gradient and a hemisphere light stand in;
 * - rain falls round what the camera looks at, as streaks;
 * - the track darkens and turns glossy as it gets wet (wetSurfaceMaterial):
 *   the racing line less so while it rains and first to dry once it stops,
 *   standing water in patches when it is very wet;
 * - cars on a wet track throw up spray behind them.
 *
 * Outside a race the weather is fine.
 */
import * as THREE from 'three';
import { SPRAY_SLOTS, type Puff, sprayPuffs, sprayStrength } from '../core/weatherFx.ts';
import type { CarLayer } from './carLayer.ts';
import { skyEnvironment } from './carMaterials.ts';
import { Sky } from './sky.ts';
import { SURFACE_GLSL, type SurfaceDetail } from './surfaces.ts';

/** The weather to show; all zero outside a race. */
export interface WeatherState {
  /** Rain intensity, track wetness, the racing line's wetness, standing water and cloud cover, 0 to 1. */
  rain: number;
  wetness: number;
  lineWetness: number;
  puddles: number;
  cloud: number;
  /** Race time, seconds (the spray), and the view's clock (falling rain). */
  raceTime: number;
  clock: number;
}

export const FINE: WeatherState = { rain: 0, wetness: 0, lineWetness: 0, puddles: 0, cloud: 0, raceTime: 0, clock: 0 };

/** Uniforms shared by the wet surfaces. */
export interface WetUniforms {
  [name: string]: THREE.IUniform;
  uWet: THREE.IUniform<number>;
  uLineWet: THREE.IUniform<number>;
  uPuddles: THREE.IUniform<number>;
  /** 1 once the sky lights the scene (the surfaces take its light as the ground does), 0 before. */
  uIbl: THREE.IUniform<number>;
}

const SKY_CLEAR = ['#3f78b8', '#9cc2e2', '#dce8f1'];
const SKY_GREY = ['#5d646c', '#858b92', '#a3a8ad'];
const HORIZON_CLEAR = new THREE.Color(0xc9dbea);
const HORIZON_GREY = new THREE.Color(0x9da3a9);
const SUN_CLEAR = new THREE.Color(0xfff1dc);
const SUN_GREY = new THREE.Color(0xe8ecf0);
const HEMI_CLEAR = new THREE.Color(0xe4efff);
const HEMI_GREY = new THREE.Color(0xd2d7dc);
/** Rain streaks: how many at most, and how fast they fall (m/s), with a little wind. */
const STREAKS = 9000;
const FALL = 9;
const WIND = new THREE.Vector2(1.6, 0.8);
/** Cloud cover levels with an environment map of their own (the painted sky). */
const COVER_LEVELS = [0, 0.5, 1];
/**
 * Sun, hemisphere light and exposure, on a fine day and under full cloud:
 * lit by the photographed sky (the hemisphere light is left out, the sky's
 * own light does its work), or by the painted sky while that loads.
 */
const LIGHT_PHOTO = { sun: [2.8, 0.35], hemi: [0, 0], exposure: [1.0, 0.9] };
const LIGHT_PAINTED = { sun: [2.2, 0.3], hemi: [1.4, 2.1], exposure: [1.15, 1.3] };

export class WeatherLayer {
  readonly group = new THREE.Group();
  readonly wet: WetUniforms = { uWet: { value: 0 }, uLineWet: { value: 0 }, uPuddles: { value: 0 }, uIbl: { value: 0 } };
  readonly sky: Sky;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly envMaps: THREE.Texture[] = [];
  private readonly skyCanvas: HTMLCanvasElement;
  private readonly painted: THREE.CanvasTexture;
  private skyCover = -1;
  private readonly rain: THREE.LineSegments;
  private readonly rainUniforms = {
    uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uSize: { value: 100 }, uFall: { value: FALL },
    uWind: { value: WIND.clone() }, uLen: { value: 0.4 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0xc8ced4) },
  };
  private spray: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | null = null;
  private sprayCapacity = 0;
  private readonly sprayColor = new THREE.Color();
  private readonly puffs: Puff[] = [];
  /** The state last shown, and the map's size. */
  state: WeatherState = FINE;
  private extent = 8192;

  /** `towardsSun` is where the sun shines from; `onSky` is called once the photographed sky has loaded. */
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, towardsSun: THREE.Vector3, onSky: () => void) {
    this.renderer = renderer;
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    this.sky = new Sky(renderer, towardsSun);
    this.group.add(this.sky.mesh);
    this.sky.load(() => {
      this.skyCover = -1;
      this.apply(this.state, null, 1000, null, this.extent);
      onSky();
    });
    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = 2;
    this.skyCanvas.height = 256;
    this.painted = new THREE.CanvasTexture(this.skyCanvas);
    this.painted.colorSpace = THREE.SRGBColorSpace;
    scene.background = this.painted;
    this.rain = rainStreaks(this.rainUniforms);
    this.group.add(this.rain);
    this.apply(FINE, null, 1000, null, 8192);
  }

  /** The sky the cars and the wet track reflect, for the current cloud cover. */
  get envMap(): THREE.Texture {
    return this.envFor(this.state.cloud);
  }

  private envFor(cover: number): THREE.Texture {
    const photo = this.sky.envMap(cover);
    if (photo) return photo;
    let best = 0;
    for (let i = 1; i < COVER_LEVELS.length; i++) if (Math.abs(COVER_LEVELS[i] - cover) < Math.abs(COVER_LEVELS[best] - cover)) best = i;
    if (!this.envMaps[best]) this.envMaps[best] = skyEnvironment(this.renderer, COVER_LEVELS[best]);
    return this.envMaps[best];
  }

  /**
   * Shows the weather `s` for a camera looking at a point `focus` metres
   * away; `cars` throw up the spray. `extent` is the map's size, for the
   * fog on a fine day.
   */
  apply(s: WeatherState, camera: THREE.PerspectiveCamera | null, focus: number, cars: CarLayer | null, extent: number): void {
    this.state = s;
    this.extent = extent;
    const c = s.cloud;
    const photo = this.sky.ready;
    this.sky.setCover(c);
    if (camera) this.sky.follow(camera);
    if (photo) this.scene.background = null;
    else {
      this.scene.background = this.painted;
      this.paintSky(c);
    }
    // The sky lights everything once it is in: no hemisphere light then.
    const env = this.envFor(c);
    this.scene.environment = photo ? env : null;
    this.wet.uIbl.value = photo ? 1 : 0;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      if (photo) this.sky.horizon(c, fog.color);
      else fog.color.copy(HORIZON_CLEAR).lerp(HORIZON_GREY, c);
      // Haze in the rain, closing in round what the camera looks at.
      const haze = Math.min(1, s.rain * 1.3);
      fog.near = THREE.MathUtils.lerp(extent * 0.9, focus * 0.8 + 150, haze);
      fog.far = THREE.MathUtils.lerp(extent * 4, focus * 4 + 1500, haze);
    }
    const light = photo ? LIGHT_PHOTO : LIGHT_PAINTED;
    this.sun.intensity = THREE.MathUtils.lerp(light.sun[0], light.sun[1], c);
    this.sun.color.copy(SUN_CLEAR).lerp(SUN_GREY, c);
    this.hemi.intensity = THREE.MathUtils.lerp(light.hemi[0], light.hemi[1], c);
    this.hemi.color.copy(HEMI_CLEAR).lerp(HEMI_GREY, c);
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(light.exposure[0], light.exposure[1], c);
    cars?.setEnvironment(env);
    this.wet.uWet.value = s.wetness;
    this.wet.uLineWet.value = s.lineWetness;
    this.wet.uPuddles.value = s.puddles;

    // Rain: a box of streaks just in front of the camera, sized to what it looks at.
    const raining = s.rain > 0.03 && !!camera;
    this.rain.visible = raining;
    if (raining && camera) {
      const size = THREE.MathUtils.clamp(focus * 0.6, 20, 300);
      const dir = camera.getWorldDirection(new THREE.Vector3());
      const u = this.rainUniforms;
      u.uCenter.value.copy(camera.position).addScaledVector(dir, size * 0.45);
      u.uSize.value = size;
      u.uTime.value = s.clock;
      u.uLen.value = Math.max(0.35, size * 0.012);
      u.uOpacity.value = 0.18 + 0.25 * Math.min(1, s.rain);
      u.uColor.value.set(0xc8ced4).lerp(new THREE.Color(0xe6eaee), 1 - c);
      // Fewer in the small box round a close-up, where each streak is big on screen.
      this.rain.geometry.setDrawRange(0, 2 * Math.round(STREAKS * Math.min(1, 0.25 + s.rain) * THREE.MathUtils.clamp(size / 60, 0.35, 1)));
    }
    this.updateSpray(s, cars);
  }

  /** The sky's gradient, from clear blue to overcast grey. */
  private paintSky(cover: number): void {
    if (Math.abs(cover - this.skyCover) < 0.01) return;
    this.skyCover = cover;
    const g = this.skyCanvas.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    const mix = (a: string, b: string) => `#${new THREE.Color(a).lerp(new THREE.Color(b), cover).getHexString()}`;
    grad.addColorStop(0, mix(SKY_CLEAR[0], SKY_GREY[0]));
    grad.addColorStop(0.6, mix(SKY_CLEAR[1], SKY_GREY[1]));
    grad.addColorStop(1, mix(SKY_CLEAR[2], SKY_GREY[2]));
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 256);
    this.painted.needsUpdate = true;
  }

  /** Spray behind every car on a wet track, as soft puffs facing the camera. */
  private updateSpray(s: WeatherState, cars: CarLayer | null): void {
    const emitters = cars && s.wetness > 0.05 ? cars.emitters : [];
    const need = emitters.length * SPRAY_SLOTS;
    if (need > this.sprayCapacity) this.buildSpray(Math.max(need, 64 * SPRAY_SLOTS));
    const mesh = this.spray;
    if (!mesh) return;
    const g = mesh.geometry;
    const pos = g.getAttribute('iPos') as THREE.InstancedBufferAttribute;
    const size = g.getAttribute('iSize') as THREE.InstancedBufferAttribute;
    const alpha = g.getAttribute('iAlpha') as THREE.InstancedBufferAttribute;
    const v = new THREE.Vector3();
    let count = 0;
    for (const e of emitters) {
      const strength = sprayStrength(s.wetness, e.speed, e.body);
      if (strength < 0.02) continue;
      sprayPuffs(e.id + 17, s.raceTime, e.speed, strength, e, this.puffs);
      for (const p of this.puffs) {
        if (p.alpha < 0.005) continue;
        cars!.pathPoint(e.u, p.back, e.lateral + p.side, p.up, v);
        pos.setXYZ(count, v.x, v.y, v.z);
        size.setX(count, p.size);
        alpha.setX(count, p.alpha);
        count++;
      }
    }
    g.instanceCount = count;
    mesh.visible = count > 0;
    pos.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;
    // Lit by the sky: whiter on a bright day, greyer under heavy cloud.
    this.sprayColor.set(0xf4f6f8).lerp(new THREE.Color(0xd2d7dc), s.cloud);
    (mesh.material.uniforms.uColor.value as THREE.Color).copy(this.sprayColor);
  }

  private buildSpray(capacity: number): void {
    if (this.spray) {
      this.group.remove(this.spray);
      this.spray.geometry.dispose();
      this.spray.material.dispose();
    }
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color() } }]),
      vertexShader: SPRAY_VERTEX,
      fragmentShader: SPRAY_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.spray = mesh;
    this.sprayCapacity = capacity;
    this.group.add(mesh);
  }

  dispose(): void {
    for (const t of this.envMaps) t?.dispose();
    this.sky.dispose();
    this.painted.dispose();
    this.rain.geometry.dispose();
    (this.rain.material as THREE.Material).dispose();
    if (this.spray) {
      this.spray.geometry.dispose();
      this.spray.material.dispose();
    }
  }
}

/**
 * A surface that gets wet: dull asphalt (or kerb paint, or run-off) when
 * dry, darker and glossy as it gets wet, `gloss` setting how much (gravel
 * and grass darken but hardly shine). `envMap` is the sky it mirrors (the
 * weather layer's envMap; marked `userData.wet` for swapping it). Track geometry with a `wetLine`
 * attribute (metres from the racing line, metres from the edge) shows the
 * racing line's own wetness and puddles near the edges. With `detail`, a
 * surface texture adds its grain and relief (ui/surfaces.ts), laid in world
 * metres; water filling it smooths the relief as the surface gets wet.
 */
export function wetSurfaceMaterial(offset: number, gloss: number, wet: WetUniforms, envMap: THREE.Texture, racingLine = false, detail: SurfaceDetail | null = null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0, envMap, envMapIntensity: 1,
    polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset,
  });
  m.userData.wet = true;
  m.defines = {
    ...(racingLine ? { WET_LINE: '' } : {}),
    ...(detail ? { SURFACE_DETAIL: '' } : {}),
    ...(detail?.gravel ? { SURFACE_GRAVEL: '' } : {}),
    ...(detail?.patches ? { SURFACE_PATCHES: '' } : {}),
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wet, { uGloss: { value: gloss } }, detail?.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
#ifdef WET_LINE
attribute vec2 wetLine;
varying vec2 vWetLine;
#endif
varying vec2 vWetXZ;
varying vec3 vWetPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef WET_LINE
vWetLine = wetLine;
#endif
vWetXZ = position.xz;
vWetPos = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uWet;
uniform float uLineWet;
uniform float uPuddles;
uniform float uGloss;
uniform float uIbl;
#ifdef WET_LINE
varying vec2 vWetLine;
#endif
varying vec2 vWetXZ;
float wetHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float wetNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wetHash(i), wetHash(i + vec2(1.0, 0.0)), u.x), mix(wetHash(i + vec2(0.0, 1.0)), wetHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wetSurface;
float puddle;
#ifdef SURFACE_DETAIL
uniform float uSurfaces;
uniform sampler2D tA;
uniform sampler2D tAN;
uniform vec3 uAMean;
uniform vec2 uSurfSize;
uniform vec3 uSurfDetail;
#ifdef SURFACE_GRAVEL
uniform sampler2D tB;
uniform sampler2D tBN;
uniform vec3 uBMean;
#endif
${SURFACE_GLSL}
varying vec3 vWetPos;
Tiling surfA;
Tiling surfB;
float surfGravel = 0.0;
// 1 on level faces, 0 on steep ones (a verge's skirt into the ground), where a texture laid from above would streak.
float surfFlat = 1.0;
#endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
#ifdef SURFACE_DETAIL
surfFlat = smoothstep(0.3, 0.6, abs(normalize(cross(dFdx(vWetPos), dFdy(vWetPos))).y));
if (uSurfaces > 0.5) {
  surfA = tiling(vWetXZ / uSurfSize.x);
  vec3 grain = detail(tiled(tA, surfA), uAMean, uSurfDetail.x * surfFlat, uSurfDetail.y);
  #ifdef SURFACE_GRAVEL
  // Gravel where the colour is gravel's (warm), the main surface where it is asphalt's (grey).
  surfGravel = smoothstep(0.08, 0.25, vColor.r - vColor.b);
  surfB = tiling(vWetXZ / uSurfSize.y);
  grain = mix(grain, detail(tiled(tB, surfB), uBMean, surfFlat, 0.3), surfGravel);
  #endif
  diffuseColor.rgb *= grain;
}
#endif
#ifdef SURFACE_PATCHES
// Asphalt laid and patched at different times: broad, faint differences of tone.
float patches = 0.55 * surfNoise(vWetXZ / 9.0) + 0.3 * surfNoise(vWetXZ / 31.0) + 0.15 * surfNoise(vWetXZ / 2.7);
float tone = mix(0.86, 1.14, patches);
#ifdef SURFACE_GRAVEL
// Gravel lies in drifts, a little darker and lighter.
float drifts = 0.6 * surfNoise(vWetXZ / 3.3) + 0.4 * surfNoise(vWetXZ / 1.1);
tone = mix(tone, mix(0.82, 1.15, drifts), surfGravel);
#endif
diffuseColor.rgb *= tone;
#endif
#if defined( WET_LINE ) && defined( SURFACE_DETAIL )
// Rubber laid down by the tyres: a darker band along the racing line, dustier and lighter off it.
diffuseColor.rgb *= mix(1.12, 0.68, 1.0 - smoothstep(0.6, 2.2, vWetLine.x));
#endif
float edgeBias = 0.0;
wetSurface = uWet;
#ifdef WET_LINE
// The racing line: the tyres' two tracks, a car's width.
wetSurface = mix(uWet, uLineWet, 1.0 - smoothstep(0.7, 1.5, vWetLine.x));
edgeBias = 0.3 * (1.0 - smoothstep(0.0, 3.0, vWetLine.y));
#endif
float n = 0.65 * wetNoise(vWetXZ / 9.0) + 0.35 * wetNoise(vWetXZ / 2.3);
puddle = uPuddles * smoothstep(0.62, 0.72, n + edgeBias) * step(0.3, uGloss);
// Even a damp surface darkens and shines; it is much the same from wet on.
wetSurface = smoothstep(0.02, 0.5, wetSurface);
diffuseColor.rgb *= mix(1.0, 0.45, wetSurface * min(1.0, uGloss + 0.4)) * (1.0 - 0.5 * puddle);`)
      // The texture's relief, smoothed where water fills it.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
#ifdef SURFACE_DETAIL
if (uSurfaces > 0.5) {
  float strength = uSurfDetail.z * surfFlat * (1.0 - puddle) * mix(1.0, 0.45, wetSurface * uGloss);
  vec3 sn = tangentNormal(tiled(tAN, surfA), strength);
  #ifdef SURFACE_GRAVEL
  sn = normalize(mix(sn, tangentNormal(tiled(tBN, surfB), surfFlat * (1.0 - puddle)), surfGravel));
  #endif
  normal = normalize(surfaceFrame(-vViewPosition, normal, vWetXZ) * sn);
}
#endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.14, wetSurface * uGloss);
roughnessFactor = mix(roughnessFactor, 0.03, puddle);`)
      // Lit as the ground is (by the sky's light, or the hemisphere light before it loads), it mirrors the sky the more the wetter it is.
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse )
iblIrradiance *= uIbl;
#endif
#if defined( RE_IndirectSpecular )
radiance *= mix(0.35, 0.7, max(wetSurface * uGloss, puddle)) * (1.0 + 0.5 * puddle);
#endif`);
  };
  m.customProgramCacheKey = () => `wet-surface${racingLine ? '-line' : ''}${detail ? (detail.gravel ? '-gravel' : '-detail') : ''}${detail?.patches ? '-patches' : ''}`;
  return m;
}

function rainStreaks(uniforms: Record<string, THREE.IUniform>): THREE.LineSegments {
  const seeds = new Float32Array(STREAKS * 2 * 3);
  const ends = new Float32Array(STREAKS * 2);
  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < STREAKS; i++) {
    const x = rnd();
    const y = rnd();
    const z = rnd();
    for (let e = 0; e < 2; e++) {
      seeds.set([x, y, z], (i * 2 + e) * 3);
      ends[i * 2 + e] = e;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  g.setAttribute('end', new THREE.BufferAttribute(ends, 1));
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: RAIN_VERTEX,
    fragmentShader: RAIN_FRAGMENT,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(g, material);
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  lines.visible = false;
  return lines;
}

/** Each streak keeps its place in the world as the box round the camera moves, wrapping at the box's faces. */
const RAIN_VERTEX = /* glsl */`
attribute float end;
uniform float uTime;
uniform float uSize;
uniform float uFall;
uniform float uLen;
uniform float uOpacity;
uniform vec3 uCenter;
uniform vec2 uWind;
varying float vAlpha;
void main() {
  vec3 velocity = vec3(uWind.x, -uFall, uWind.y);
  vec3 q = fract(position + (velocity * uTime - uCenter) / uSize) - 0.5;
  vec3 p = uCenter + q * uSize - normalize(velocity) * uLen * end;
  float edge = max(abs(q.x), max(abs(q.y), abs(q.z)));
  vAlpha = uOpacity * (1.0 - smoothstep(0.32, 0.5, edge)) * (1.0 - 0.6 * end);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const RAIN_FRAGMENT = /* glsl */`
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha);
  #include <colorspace_fragment>
}`;

const SPRAY_VERTEX = /* glsl */`
attribute vec3 iPos;
attribute float iSize;
attribute float iAlpha;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vAlpha = iAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  mvPosition.xy += position.xy * iSize;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const SPRAY_FRAGMENT = /* glsl */`
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  // A soft round puff, fading out from the middle with no edge to see.
  vec2 d = (vUv - 0.5) * 2.0;
  float a = vAlpha * exp(-dot(d, d) * 3.5) * (1.0 - smoothstep(0.8, 1.0, length(d)));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
