/**
 * The marshals at their posts during a race, with what race control has
 * them show (core/flags.ts): waved flags, the SC, VSC or FCY board, and the
 * light panel beside each post, flashing yellow or blue or showing green.
 * The flag marshal on the rostrum at the line waves the chequered flag, and
 * the green flag for a rolling start or a restart.
 *
 * Three marshals stand at the front of each post facing the track: the
 * first waves the flag, the second a second flag (a double yellow) or the
 * board, the third the board when both others wave. Everything stands on the
 * drawn ground at its real size, in scene coordinates (outside the
 * height-scaled model group), like the cars.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Board, FlagColour, PostSignal } from '../core/flags.ts';
import { PAD_HALF, type PostSite } from '../core/scenery.ts';

/** Where the marshals stand on a post: along the track, and back from its front edge (metres). */
const MARSHALS: readonly (readonly [number, number])[] = [[-0.9, 0.7], [0.1, 0.7], [1.1, 0.7]];
/** The light panel's face: along the track, back from the front edge, height above the floor. */
const PANEL: readonly [number, number, number] = [-PAD_HALF - 0.125, 0.35, 2.5];
const SHOULDER = new THREE.Vector3(-0.22, 1.42, 0);
/** Waves per second, and how far the flag swings either side (radians). */
const WAVE_RATE = 1.3;
const WAVE_SWING = 0.95;
/** Light panel flashes per second. */
const FLASH_RATE = 2;

const FLAG_RGB: Record<FlagColour, [number, number, number]> = {
  yellow: [1, 0.78, 0.02],
  green: [0.05, 0.62, 0.18],
  blue: [0.05, 0.3, 0.95],
  chequered: [1, 1, 1],
};
/** The panel's light, brighter than white so it glows through the tone mapping. */
const PANEL_RGB: Record<string, [number, number, number]> = {
  yellow: [1.5, 1.0, 0.02],
  green: [0.1, 1.4, 0.3],
  blue: [0.15, 0.45, 1.6],
  off: [0.02, 0.02, 0.025],
};

interface Slot {
  /** The marshal's transform, scene coordinates. */
  base: THREE.Matrix4;
  phase: number;
}

export class FlagLayer {
  readonly group = new THREE.Group();
  private readonly marshalGeo = marshalGeometry();
  private readonly flagGeo = flagGeometry();
  private readonly boardGeo = new THREE.PlaneGeometry(0.8, 0.6);
  private readonly panelGeo = new THREE.PlaneGeometry(0.5, 0.5);
  private readonly marshalMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly flagMat: THREE.MeshLambertMaterial;
  private readonly boardTex: THREE.CanvasTexture;
  private readonly boardMat: THREE.MeshLambertMaterial;
  private readonly panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
  private readonly time = { value: 0 };
  private marshals: THREE.InstancedMesh | null = null;
  private flags: THREE.InstancedMesh | null = null;
  private boards: THREE.InstancedMesh | null = null;
  private panels: THREE.InstancedMesh | null = null;
  /** Per post its three marshals; the line's flag marshal last. */
  private slots: Slot[][] = [];
  private panelAt: THREE.Matrix4[] = [];
  private boardText: Board | null = null;

  constructor() {
    this.flagMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.flagMat.onBeforeCompile = (shader) => flagShader(shader, this.time);
    this.flagMat.customProgramCacheKey = () => 'marshal-flag';
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 192;
    this.boardTex = new THREE.CanvasTexture(c);
    this.boardTex.colorSpace = THREE.SRGBColorSpace;
    this.boardMat = new THREE.MeshLambertMaterial({ map: this.boardTex, side: THREE.DoubleSide });
    this.group.visible = false;
  }

  /**
   * Stands the marshals at the posts (and the line's flag marshal at
   * `line`); `sceneY` gives a real height's scene height.
   */
  setSites(posts: readonly PostSite[], line: PostSite | null, sceneY: (z: number) => number): void {
    this.clear();
    const all = line ? [...posts, line] : [...posts];
    // The floor keeps its real height above the ground, as the post does.
    const floorY = (s: PostSite) => sceneY(s.ground) + s.floor - s.ground;
    this.slots = all.map((s, i) => {
      const spots = s.rostrum ? [[0, 0.8] as const] : MARSHALS;
      return spots.map(([a, b], j) => {
        const x = s.x + s.tx * a - s.fx * b;
        const y = s.y + s.ty * a - s.fy * b;
        const base = new THREE.Matrix4().compose(
          new THREE.Vector3(x, floorY(s), y),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.fx, s.fy)),
          new THREE.Vector3(1, 1, 1),
        );
        return { base, phase: i * 1.7 + j * 2.3 };
      });
    });
    this.panelAt = posts.map((s) => {
      const [a, b, z] = PANEL;
      return new THREE.Matrix4().compose(
        new THREE.Vector3(s.x + s.tx * a - s.fx * b, floorY(s) + z, s.y + s.ty * a - s.fy * b),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-s.tx, -s.ty)),
        new THREE.Vector3(1, 1, 1),
      );
    });
    const people = this.slots.reduce((sum, s) => sum + s.length, 0);
    this.marshals = this.instanced(this.marshalGeo, this.marshalMat, people);
    let i = 0;
    for (const post of this.slots) for (const m of post) this.marshals.setMatrixAt(i++, m.base);
    this.marshals.instanceMatrix.needsUpdate = true;
    this.marshals.castShadow = true;
    const flagGeo = this.flagGeo.clone();
    flagGeo.setAttribute('flagColor', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, all.length * 2) * 3), 3));
    flagGeo.setAttribute('pattern', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, all.length * 2)), 1));
    this.flags = this.instanced(flagGeo, this.flagMat, all.length * 2);
    this.boards = this.instanced(this.boardGeo, this.boardMat, posts.length);
    this.panels = this.instanced(this.panelGeo, this.panelMat, Math.max(1, posts.length));
    this.panels.count = posts.length;
    this.panelAt.forEach((m, j) => this.panels!.setMatrixAt(j, m));
    this.panels.instanceMatrix.needsUpdate = true;
  }

  private instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Shows the signals at the posts (in the order of setSites) and the flag
   * at the line, at `clock` seconds on the view's clock (the waving).
   */
  update(signals: readonly PostSignal[], line: FlagColour | null, clock: number): void {
    const flags = this.flags;
    const boards = this.boards;
    const panels = this.panels;
    if (!flags || !boards || !panels) return;
    this.time.value = clock;
    const color = flags.geometry.getAttribute('flagColor') as THREE.InstancedBufferAttribute;
    const pattern = flags.geometry.getAttribute('pattern') as THREE.InstancedBufferAttribute;
    const m = new THREE.Matrix4();
    const swing = new THREE.Matrix4();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const posts = this.panelAt.length;
    let board: Board | null = null;
    let boardCount = 0;
    const panelColor = new THREE.Color();
    for (let i = 0; i < this.slots.length; i++) {
      const slots = this.slots[i];
      const sig: PostSignal = i < posts ? signals[i] ?? { flags: [], board: null } : { flags: line ? [line] : [], board: null };
      for (let f = 0; f < 2; f++) {
        const colour = sig.flags[f];
        const slot = slots[f];
        if (!colour || !slot) {
          flags.setMatrixAt(i * 2 + f, hidden);
          continue;
        }
        // Swung from side to side overhead, about the axis towards the track.
        const angle = WAVE_SWING * Math.sin(2 * Math.PI * WAVE_RATE * clock + slot.phase);
        swing.makeRotationZ(angle).premultiply(m.makeTranslation(SHOULDER.x, SHOULDER.y, SHOULDER.z));
        flags.setMatrixAt(i * 2 + f, m.multiplyMatrices(slot.base, swing));
        color.setXYZ(i * 2 + f, ...FLAG_RGB[colour]);
        pattern.setX(i * 2 + f, colour === 'chequered' ? 1 : 0);
      }
      if (i < posts) {
        if (sig.board) {
          // Held up by the next marshal free of a flag, at chest height, facing the track.
          const holder = slots[Math.min(slots.length - 1, sig.flags.length)];
          board = sig.board;
          boards.setMatrixAt(boardCount++, m.multiplyMatrices(holder.base, swing.makeTranslation(0, 1.3, 0.3)));
        }
        const first = sig.flags[0];
        const lit = first === 'green' || ((first === 'yellow' || first === 'blue') && Math.floor(clock * FLASH_RATE * 2) % 2 === 0);
        panelColor.setRGB(...PANEL_RGB[lit && first ? first : 'off']);
        panels.setColorAt(i, panelColor);
      }
    }
    boards.count = boardCount;
    if (board !== this.boardText) this.paintBoard(board);
    flags.instanceMatrix.needsUpdate = true;
    color.needsUpdate = true;
    pattern.needsUpdate = true;
    boards.instanceMatrix.needsUpdate = true;
    if (panels.instanceColor) panels.instanceColor.needsUpdate = true;
  }

  /** The board's face: black letters on white, with a black border. */
  private paintBoard(text: Board | null): void {
    this.boardText = text;
    const c = this.boardTex.image as HTMLCanvasElement;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#111111';
    g.lineWidth = 10;
    g.strokeRect(5, 5, c.width - 10, c.height - 10);
    g.fillStyle = '#111111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${text && text.length > 2 ? 92 : 110}px "Arial Black", "Segoe UI", system-ui, sans-serif`;
    if (text) g.fillText(text, c.width / 2, c.height / 2 + 6);
    this.boardTex.needsUpdate = true;
  }

  private clear(): void {
    for (const mesh of [this.marshals, this.flags, this.boards, this.panels]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      if (mesh === this.flags) mesh.geometry.dispose();
      mesh.dispose();
    }
    this.marshals = this.flags = this.boards = this.panels = null;
    this.slots = [];
    this.panelAt = [];
  }

  dispose(): void {
    this.clear();
    for (const g of [this.marshalGeo, this.flagGeo, this.boardGeo, this.panelGeo]) g.dispose();
    for (const mat of [this.marshalMat, this.flagMat, this.boardMat, this.panelMat]) mat.dispose();
    this.boardTex.dispose();
  }
}

/** Paints a geometry one colour (as vertex colours, linear). */
function painted(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g.toNonIndexed();
}

/** A marshal 1.75 m tall in orange overalls, facing +z, arms down. */
function marshalGeometry(): THREE.BufferGeometry {
  const suit = 0xf06a10;
  const parts = [
    painted(new THREE.BoxGeometry(0.13, 0.82, 0.16).translate(-0.09, 0.41, 0), suit),
    painted(new THREE.BoxGeometry(0.13, 0.82, 0.16).translate(0.09, 0.41, 0), suit),
    painted(new THREE.BoxGeometry(0.42, 0.62, 0.24).translate(0, 1.13, 0), suit),
    painted(new THREE.BoxGeometry(0.1, 0.58, 0.12).translate(-0.27, 1.12, 0), suit),
    painted(new THREE.BoxGeometry(0.1, 0.58, 0.12).translate(0.27, 1.12, 0), suit),
    painted(new THREE.SphereGeometry(0.115, 10, 8).translate(0, 1.6, 0), 0xd9a98a),
    painted(new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 1.63, 0), 0xf2f2f2),
    painted(new THREE.BoxGeometry(0.14, 0.06, 0.24).translate(-0.09, 0.03, 0.03), 0x1a1a1a),
    painted(new THREE.BoxGeometry(0.14, 0.06, 0.24).translate(0.09, 0.03, 0.03), 0x1a1a1a),
  ];
  return mergeGeometries(parts)!;
}

/**
 * A flag held up from the shoulder: the raised arm, the stick, and the
 * cloth (an attribute `cloth`: 0 off it, else how far out from the stick).
 * The cloth is white for its colour to come from the flag.
 */
function flagGeometry(): THREE.BufferGeometry {
  const arm = painted(new THREE.BoxGeometry(0.1, 0.6, 0.12).translate(0, 0.27, 0), 0xf06a10);
  const stick = painted(new THREE.CylinderGeometry(0.012, 0.012, 1.05, 5).translate(0, 0.95, 0.04), 0x3a3a3a);
  const cloth = painted(new THREE.PlaneGeometry(0.8, 0.6, 8, 4).translate(0.4, 1.17, 0.04), 0xffffff);
  const parts = [arm, stick, cloth];
  for (const p of parts) {
    const n = p.getAttribute('position').count;
    const d = new Float32Array(n);
    if (p === cloth) for (let i = 0; i < n; i++) d[i] = 0.02 + p.getAttribute('position').getX(i) / 0.8;
    p.setAttribute('cloth', new THREE.BufferAttribute(d, 1));
  }
  return mergeGeometries(parts)!;
}

/** The cloth ripples, and takes the flag's colour (or the chequered pattern). */
function flagShader(shader: THREE.WebGLProgramParametersWithUniforms, time: { value: number }): void {
  shader.uniforms.uTime = time;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute float cloth;
attribute vec3 flagColor;
attribute float pattern;
uniform float uTime;
varying float vCloth;
varying vec3 vFlagColor;
varying float vPattern;
varying vec2 vFlagUv;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vCloth = cloth;
vFlagColor = flagColor;
vPattern = pattern;
vFlagUv = vec2(position.x / 0.8, (position.y - 0.87) / 0.6);
#ifdef USE_INSTANCING
float flagSeed = float(gl_InstanceID) * 1.7;
#else
float flagSeed = 0.0;
#endif
if (cloth > 0.0) transformed.z += sin(cloth * 9.0 - uTime * 14.0 + flagSeed) * 0.08 * cloth;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying float vCloth;
varying vec3 vFlagColor;
varying float vPattern;
varying vec2 vFlagUv;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
if (vCloth > 0.0) {
  vec3 flag = vFlagColor;
  if (vPattern > 0.5) {
    vec2 cell = floor(vFlagUv * vec2(8.0, 6.0));
    flag = mod(cell.x + cell.y, 2.0) < 0.5 ? vec3(0.02) : vec3(0.95);
  }
  diffuseColor.rgb = flag;
}`);
}
