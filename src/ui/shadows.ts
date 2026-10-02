/**
 * The sun's shadows over the whole view: cascaded shadow maps (three.js's
 * CSM), four maps of 4096 texels from the camera out to a little beyond
 * what it looks at, each covering a slice of the view, so a car close by
 * and a forest kilometres away both cast a shadow.
 *
 * The cascades are four directional lights in place of one sun, and a
 * material only takes the light of the cascade a fragment falls in once it
 * is set up for it; a lit material that is not would get the sun four times.
 * So every lit material in the scene is set up (`setupScene`, cheap to run
 * every frame), keeping the shader changes it already makes: the CSM hook
 * is chained after the material's own.
 */
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';

const CASCADES = 4;
const MAP_SIZE = 4096;

/** Materials lit by the scene's lights. */
function lit(m: THREE.Material): boolean {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
    || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial === true
    || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial === true;
}

export class SunShadows {
  private readonly csm: CSM;
  private readonly done = new WeakSet<THREE.Material>();
  private far = 0;
  private near = 0;
  private fov = 0;
  private aspect = 0;
  private offset = '';

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, towardsSun: THREE.Vector3) {
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: CASCADES,
      shadowMapSize: MAP_SIZE,
      lightDirection: towardsSun.clone().negate(),
      lightIntensity: 3,
      maxFar: 4000,
      lightNear: 1,
      lightFar: 40_000,
      lightMargin: 3000,
      mode: 'practical',
    });
    this.csm.fade = true;
    for (const light of this.csm.lights) light.shadow.bias = -0.0001;
  }

  /** The cascades' lights (for colour and intensity from the weather). */
  get lights(): THREE.DirectionalLight[] {
    return this.csm.lights;
  }

  /** The sun's colour and strength. */
  setSun(color: THREE.Color, intensity: number): void {
    for (const l of this.csm.lights) {
      l.color.copy(color);
      l.intensity = intensity;
    }
  }

  /** Shadows on or off. */
  setEnabled(on: boolean): void {
    for (const l of this.csm.lights) l.castShadow = on;
  }

  /** Sets up every lit material in the scene not yet set up. */
  setupScene(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) this.setup(m);
    });
  }

  private setup(m: THREE.Material): void {
    if (this.done.has(m) || !lit(m)) return;
    this.done.add(m);
    const own = m.onBeforeCompile;
    this.csm.setupMaterial(m);
    const hook = m.onBeforeCompile;
    m.onBeforeCompile = function (shader, renderer) {
      own.call(this, shader, renderer);
      hook.call(this, shader, renderer);
    };
    m.needsUpdate = true;
  }

  /**
   * Fits the cascades to the camera: reach a little beyond what it looks
   * at (`focus` metres away) and the whole of the view on a wide shot.
   */
  update(camera: THREE.PerspectiveCamera, focus: number): void {
    const far = Math.min(camera.far, Math.max(600, focus * 3));
    const offset = camera.view?.enabled ? `${camera.view.offsetX}:${camera.view.width}` : '';
    if (Math.abs(far - this.far) > this.far * 0.02 || camera.near !== this.near || camera.fov !== this.fov || camera.aspect !== this.aspect || offset !== this.offset) {
      this.far = far;
      this.near = camera.near;
      this.fov = camera.fov;
      this.aspect = camera.aspect;
      this.offset = offset;
      this.csm.maxFar = far;
      this.csm.updateFrustums();
      // The bias follows each map's texel: fine close by, coarse far away.
      for (const l of this.csm.lights) {
        const texel = (l.shadow.camera.right - l.shadow.camera.left) / MAP_SIZE;
        l.shadow.normalBias = texel * 1.5;
      }
    }
    this.csm.update();
  }

  dispose(): void {
    this.csm.remove();
    this.csm.dispose();
  }
}
