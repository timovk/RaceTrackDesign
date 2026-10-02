/**
 * The finish on the 3D view's picture, after the scene is drawn:
 *
 * - the scene is drawn with four-sample antialiasing into a high dynamic
 *   range buffer, keeping its depth;
 * - ambient occlusion (three.js's GTAO, from a normal and depth pass of
 *   its own): darkening where
 *   surfaces meet, under cars and round buildings and trees, so things sit
 *   in the ground rather than float on it;
 * - depth of field for the broadcast's long lenses: what the camera focuses
 *   on sharp, the rest blurred as much as a real lens of that focal length
 *   would (see `lensBlur`);
 * - bloom: a soft glow round the brightest highlights (the sun, its glints
 *   on wet asphalt and paint, the lights);
 * - tone mapping to the screen (the renderer's), then a light grade: a
 *   touch more contrast and colour, and a vignette on the broadcast.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** A broadcast lens: the camera's vertical field of view (degrees) and the distance it focuses at (metres). */
export interface Lens {
  fov: number;
  focus: number;
}

/** A broadcast camera's sensor height (2/3 inch, mm) and aperture (f-number), and the most blur drawn (pixels). */
const SENSOR = 8.8;
const F_NUMBER = 2.8;
const MAX_BLUR = 22;

/**
 * Blur in pixels per unit of |1 - focus / distance| for a lens on a picture
 * `height` pixels high: the circle of confusion f² / (N (S - f)) on the
 * sensor, scaled to the picture. A long lens focused on a car 200 m away
 * blurs the far background by a few pixels; a very long one by twenty.
 */
export function lensBlur(lens: Lens, height: number): number {
  const f = SENSOR / 2 / Math.tan(THREE.MathUtils.degToRad(lens.fov) / 2);
  const s = Math.max(lens.focus * 1000, f * 2);
  return (height * f * f) / (F_NUMBER * (s - f) * SENSOR);
}

export interface Grade {
  contrast: number;
  saturation: number;
  vignette: number;
}

export class PostFx {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly composer: EffectComposer;
  private readonly ao: GTAOPass;
  private readonly dof: ShaderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    const depth = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth });
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new TexturePass(this.target.texture));
    // Ambient occlusion from a pass of its own drawing the scene's normals and depth. Normals rebuilt from the
    // picture's depth showed creases on the surfaces drawn over the ground (their polygon offset steps the depth
    // from one triangle to the next): dark scratches over the run-off.
    this.ao = new GTAOPass(scene, camera, 1, 1);
    this.ao.updateGtaoMaterial({ radius: 2.5, distanceExponent: 1.4, thickness: 3, scale: 1.1, samples: 16, distanceFallOff: 0.6, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.ao.blendIntensity = 0.9;
    this.composer.addPass(this.ao);
    this.dof = new ShaderPass(DOF_SHADER);
    this.dof.uniforms.tDepth.value = depth;
    this.dof.enabled = false;
    this.composer.addPass(this.dof);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.45, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.grade);
  }

  /** The picture's size in CSS pixels and the device pixel ratio. */
  setSize(width: number, height: number, ratio: number): void {
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    this.height = h;
    this.target.setSize(w, h);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.dof.uniforms.resolution.value.set(w, h);
  }

  /** Draws the scene with the finish; `lens` blurs what is out of its focus. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, lens: Lens | null, grade: Grade): void {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.clear();
    r.render(scene, camera);
    r.setRenderTarget(null);
    const blur = lens ? lensBlur(lens, this.height) : 0;
    this.dof.enabled = blur > 0.3;
    if (this.dof.enabled) {
      const u = this.dof.uniforms;
      u.cameraNear.value = camera.near;
      u.cameraFar.value = camera.far;
      u.focus.value = lens!.focus;
      u.blur.value = blur;
      u.maxBlur.value = MAX_BLUR * (this.height / 1080);
    }
    const g = this.grade.uniforms;
    g.contrast.value = grade.contrast;
    g.saturation.value = grade.saturation;
    g.vignette.value = grade.vignette;
    this.composer.render();
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.ao.dispose();
    this.bloom.dispose();
    this.composer.dispose();
  }
}

/**
 * Depth of field by gathering: each pixel averages a disc of samples as wide
 * as its own blur, taking a sample only as far as that sample's blur reaches,
 * so a sharp car does not smear into the blurred background behind it.
 */
const DOF_SHADER = {
  name: 'LensBlur',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 1 },
    cameraFar: { value: 1000 },
    focus: { value: 100 },
    blur: { value: 0 },
    maxBlur: { value: MAX_BLUR },
  },
  vertexShader: /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */`
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float cameraNear;
uniform float cameraFar;
uniform float focus;
uniform float blur;
uniform float maxBlur;
varying vec2 vUv;
float coc(vec2 uv) {
  float z = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
  return min(maxBlur, blur * abs(1.0 - focus / max(z, 0.01)));
}
void main() {
  vec4 centre = texture2D(tDiffuse, vUv);
  float c0 = coc(vUv);
  if (c0 < 0.5) {
    gl_FragColor = centre;
    return;
  }
  vec3 sum = centre.rgb;
  float total = 1.0;
  for (int i = 0; i < 40; i++) {
    float f = (float(i) + 0.5) / 40.0;
    float r = sqrt(f) * c0;
    float a = float(i) * 2.39996323;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r / resolution;
    float w = smoothstep(r - 1.0, r + 1.0, coc(uv));
    sum += texture2D(tDiffuse, uv).rgb * w;
    total += w;
  }
  gl_FragColor = vec4(sum / total, centre.a);
}`,
};

/** A light grade on the tone-mapped picture: contrast round mid-grey, saturation, and a vignette. */
const GRADE_SHADER = {
  name: 'Grade',
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1 },
    saturation: { value: 1 },
    vignette: { value: 0 },
  },
  vertexShader: /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform float contrast;
uniform float saturation;
uniform float vignette;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(l), c.rgb, saturation);
  rgb = (rgb - 0.5) * contrast + 0.5;
  vec2 d = vUv - 0.5;
  rgb *= 1.0 - vignette * smoothstep(0.15, 0.75, dot(d, d) * 2.0);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`,
};
