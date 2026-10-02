/**
 * The sky of the 3D view, from two photographed panoramas of the open sky
 * (high dynamic range, CC0, Poly Haven: "Kloofendal 48d Partly Cloudy" and
 * "Kloofendal Overcast", pure-sky versions, in public/sky): partly cloudy
 * for a fine day and overcast for rain, blended by the cloud cover.
 *
 * A dome round the camera shows it, turned so the sun in the photograph
 * stands where the scene's sun shines from. Its light reaches the scene as
 * image-based lighting: environment maps rendered from the dome with the
 * sun's disc clipped (the sun itself is the directional light, so it is not
 * counted twice), one per tenth of cloud cover, made when first needed.
 * Until the photographs have loaded the dome is hidden and the caller keeps
 * its simple sky.
 */
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const CLEAR_URL = 'sky/kloofendal_48d_partly_cloudy_puresky_4k.hdr';
const OVERCAST_URL = 'sky/kloofendal_overcast_puresky_4k.hdr';
/** Where the sun is in the partly cloudy panorama: longitude (atan2(z, x) of the direction) and elevation, degrees. */
const PHOTO_SUN = { lon: 34.2, lat: 47.9 };
/** The overcast panorama is brighter than the fine one; scaled to sit under it, as an overcast day does. */
const OVERCAST_GAIN = 0.62;
/** Radiance above this is clipped from the lighting maps: the sun's disc. */
const ENV_CLAMP = 24;
/** The horizon's colour (linear) in each panorama, averaged over the bottom 6 degrees of sky; for the fog. */
const HORIZON_CLEAR = new THREE.Color(0.443, 0.477, 0.581);
const HORIZON_OVERCAST = new THREE.Color(0.687, 0.733, 0.822).multiplyScalar(OVERCAST_GAIN);

/** The direction the sun shines from, for a sun in the north-west at the photograph's elevation (scene: x east, y up, z south). */
export function sunDirection(azimuthDeg = -135): THREE.Vector3 {
  const lat = THREE.MathUtils.degToRad(PHOTO_SUN.lat);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.cos(lat) * Math.cos(az), Math.sin(lat), Math.cos(lat) * Math.sin(az));
}

/** How far to turn the panorama (radians, added to a direction's longitude) to put its sun at `sun`. */
export function skyTurn(sun: THREE.Vector3): number {
  return THREE.MathUtils.degToRad(PHOTO_SUN.lon) - Math.atan2(sun.z, sun.x);
}

export class Sky {
  /** The dome; it follows the camera (see `follow`). */
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** Whether the photographs have loaded. */
  ready = false;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly uniforms = {
    tClear: { value: null as THREE.Texture | null },
    tOvercast: { value: null as THREE.Texture | null },
    uCover: { value: 0 },
    uTurn: { value: 0 },
    uGain: { value: OVERCAST_GAIN },
    uClamp: { value: 1e9 },
  };
  private readonly envs = new Map<number, THREE.Texture>();
  private onReady: (() => void) | null = null;

  constructor(renderer: THREE.WebGLRenderer, sun: THREE.Vector3) {
    this.renderer = renderer;
    this.uniforms.uTurn.value = skyTurn(sun);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMaterial(this.uniforms));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** Loads the photographs; `done` is called once they are in (to redraw and swap the lighting). */
  load(done: () => void): void {
    this.onReady = done;
    const loader = new HDRLoader().setDataType(THREE.HalfFloatType);
    Promise.all([loader.loadAsync(CLEAR_URL), loader.loadAsync(OVERCAST_URL)]).then(([clear, overcast]) => {
      for (const t of [clear, overcast]) {
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        t.wrapS = THREE.RepeatWrapping;
      }
      this.uniforms.tClear.value = clear;
      this.uniforms.tOvercast.value = overcast;
      this.ready = true;
      this.mesh.visible = true;
      this.onReady?.();
    }).catch((err) => console.warn('Sky panoramas could not be loaded; keeping the simple sky.', err));
  }

  /** Cloud cover 0 (fine) to 1 (overcast). */
  setCover(cover: number): void {
    this.uniforms.uCover.value = THREE.MathUtils.clamp(cover, 0, 1);
  }

  /** Keeps the dome round the camera, inside its far plane. */
  follow(camera: THREE.PerspectiveCamera): void {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.5);
    this.mesh.updateMatrixWorld();
  }

  /** The horizon's colour (linear) at this cloud cover, for the fog. */
  horizon(cover: number, out = new THREE.Color()): THREE.Color {
    return out.copy(HORIZON_CLEAR).lerp(HORIZON_OVERCAST, THREE.MathUtils.clamp(cover, 0, 1));
  }

  /** The lighting map for a cloud cover (the nearest tenth), or null until the photographs are in. */
  envMap(cover: number): THREE.Texture | null {
    if (!this.ready) return null;
    const level = Math.round(THREE.MathUtils.clamp(cover, 0, 1) * 10);
    let env = this.envs.get(level);
    if (!env) {
      env = this.renderEnv(level / 10);
      this.envs.set(level, env);
    }
    return env;
  }

  private renderEnv(cover: number): THREE.Texture {
    const scene = new THREE.Scene();
    const material = skyMaterial({ ...this.uniforms, uCover: { value: cover }, uClamp: { value: ENV_CLAMP } });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), material);
    scene.add(dome);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(scene, 0, 0.1, 100).texture;
    pmrem.dispose();
    dome.geometry.dispose();
    material.dispose();
    return env;
  }

  dispose(): void {
    for (const t of this.envs.values()) t.dispose();
    this.uniforms.tClear.value?.dispose();
    this.uniforms.tOvercast.value?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

function skyMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

const SKY_VERTEX = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** The panorama in the direction of the fragment, turned by uTurn, the fine and overcast skies mixed by the cover. */
const SKY_FRAGMENT = /* glsl */`
uniform sampler2D tClear;
uniform sampler2D tOvercast;
uniform float uCover;
uniform float uTurn;
uniform float uGain;
uniform float uClamp;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float lon = atan(d.z, d.x) + uTurn;
  vec2 uv = vec2(fract(lon / 6.28318530718 + 0.5), asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
  vec3 clear = texture2D(tClear, uv).rgb;
  vec3 overcast = texture2D(tOvercast, uv).rgb * uGain;
  vec3 c = min(mix(clear, overcast, uCover), vec3(uClamp));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
