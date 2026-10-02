/**
 * The trees of the 3D view, as card trees: a trunk (and a broadleaf's
 * limbs) carrying a crown of sprite cards, leaf clusters on a broadleaf and
 * needled branches round a conifer's trunk in whorls, from a texture atlas
 * drawn here (no download). The cards' normals point out from the crown, so
 * a crown is lit as a volume rather than as flat cards, and the inner cards
 * are darker. Edges are smoothed by alpha to coverage on the four-sample
 * picture; the cards cast shadows by their alpha.
 *
 * Each tree is an instance, sized and turned by its own matrix, tinted
 * slightly by its own colour, and stirred a little by the wind on the view's
 * clock. The map is cut into 8 × 8 tiles; each tile draws its trees in full
 * detail when a tree there would stand more than NEAR_PIXELS tall on screen
 * (so a long lens keeps the detail far away) and with a dozen big cards
 * otherwise.
 */
import * as THREE from 'three';
import { seededRandom } from '../core/rng.ts';
import type { Trees } from '../core/scenery.ts';

/** Atlas regions, in uv (image space: v down, as the atlas is not flipped): left, top, right, bottom. */
type Rect = readonly [number, number, number, number];
const INSET = 3 / 1024;
const LEAVES_A: Rect = [INSET, INSET, 0.5 - INSET, 0.5 - INSET];
const LEAVES_B: Rect = [0.5 + INSET, INSET, 1 - INSET, 0.5 - INSET];
const NEEDLES: Rect = [INSET, 0.5 + INSET, 0.5 - INSET, 1 - INSET];
const BARK: Rect = [0.5 + INSET, 0.5 + INSET, 1 - INSET, 1 - INSET];

/** A tree of typical height (m) stands this many pixels tall or more: full detail. */
const NEAR_PIXELS = 40;
const TYPICAL_HEIGHT = 15;
const TILES = 8;

type Kind = 0 | 1;

/** The parts of a tree geometry as it is built, for one unit of height. */
class TreeBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly leaf: number[] = [];
  readonly idx: number[] = [];

  private vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, shade: number, leaf: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(shade, shade, shade);
    this.leaf.push(leaf);
    return this.pos.length / 3 - 1;
  }

  /** A card: corners in order round it, their normals and shades, and the atlas rectangle laid on it (first corner at its left-top). */
  card(c: THREE.Vector3[], n: THREE.Vector3[], shade: number[], r: Rect): void {
    const uv = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    const i = c.map((p, k) => this.vertex(p, n[k], uv[k][0], uv[k][1], shade[k], 1));
    this.idx.push(i[0], i[1], i[2], i[0], i[2], i[3]);
  }

  /** A tapered tube of bark from `a` to `b`. */
  tube(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, sides: number, shade = 1): void {
    const axis = b.clone().sub(a).normalize();
    const side = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(axis, side).normalize();
    const w = new THREE.Vector3().crossVectors(axis, u).normalize();
    const base = this.pos.length / 3;
    for (let s = 0; s <= sides; s++) {
      const a2 = (s / sides) * Math.PI * 2;
      const dir = u.clone().multiplyScalar(Math.cos(a2)).addScaledVector(w, Math.sin(a2));
      const uu = BARK[0] + (BARK[2] - BARK[0]) * (s / sides);
      this.vertex(a.clone().addScaledVector(dir, r0), dir, uu, BARK[3], shade * 0.8, 0);
      this.vertex(b.clone().addScaledVector(dir, r1), dir, uu, BARK[1], shade, 0);
    }
    for (let s = 0; s < sides; s++) {
      const p = base + s * 2;
      this.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
    }
  }

  build(): THREE.BufferGeometry {
    // The tree is as tall as it says: a crown's top cards pushing above a unit come down to it.
    let top = 0;
    for (let i = 1; i < this.pos.length; i += 3) top = Math.max(top, this.pos[i]);
    if (top > 1) for (let i = 1; i < this.pos.length; i += 3) this.pos[i] /= top;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('leaf', new THREE.Float32BufferAttribute(this.leaf, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** A direction on the sphere from two numbers in [0, 1). */
function sphereDir(a: number, b: number): THREE.Vector3 {
  const z = 2 * a - 1;
  const r = Math.sqrt(1 - z * z);
  const t = b * Math.PI * 2;
  return new THREE.Vector3(r * Math.cos(t), z, r * Math.sin(t));
}

/**
 * A broadleaf tree one unit high: a trunk forking into limbs under a crown,
 * an ellipsoid of leaf-cluster cards; `detail` 1 for the full tree, 0 for a
 * dozen big cards.
 */
export function broadleafTree(detail: 0 | 1, seed = 'broadleaf'): THREE.BufferGeometry {
  const rng = seededRandom(seed);
  const b = new TreeBuilder();
  const top = new THREE.Vector3(0, 0.46, 0);
  b.tube(new THREE.Vector3(0, -0.05, 0), top, 0.042, 0.026, detail ? 7 : 4, 1);
  const centre = new THREE.Vector3(0, 0.61, 0);
  const radii = new THREE.Vector3(0.36, 0.26, 0.36);
  if (detail) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rng() * 0.8;
      const end = new THREE.Vector3(Math.cos(a) * 0.2, 0.6 + rng() * 0.12, Math.sin(a) * 0.2);
      b.tube(new THREE.Vector3(0, 0.36 + rng() * 0.08, 0), end, 0.018, 0.008, 4, 0.95);
    }
  }
  const cards = detail ? 84 : 16;
  for (let i = 0; i < cards; i++) {
    // Spread over the crown, more of them towards its surface and its top.
    const dir = sphereDir((i + rng()) / cards, rng());
    if (dir.y < -0.4) dir.y *= 0.6;
    dir.normalize();
    const depth = detail ? 0.45 + 0.55 * Math.sqrt(rng()) : 0.7;
    const p = centre.clone().add(dir.clone().multiply(radii).multiplyScalar(depth));
    const size = detail ? 0.2 + rng() * 0.1 : 0.4 + rng() * 0.08;
    const n = dir.clone().addScaledVector(new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5), 1.2).normalize();
    const spin = rng() * Math.PI * 2;
    const t0 = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    const s0 = new THREE.Vector3().crossVectors(n, t0);
    const t = t0.clone().multiplyScalar(Math.cos(spin)).addScaledVector(s0, Math.sin(spin)).multiplyScalar(size / 2);
    const s = new THREE.Vector3().crossVectors(n, t);
    const corners = [p.clone().sub(t).add(s), p.clone().add(t).add(s), p.clone().add(t).sub(s), p.clone().sub(t).sub(s)];
    // Normals out from the crown, so it is lit as a whole; deeper cards and those underneath are darker.
    const normals = corners.map((c) => c.clone().sub(centre).divide(radii).normalize().multiplyScalar(0.8).addScaledVector(n, 0.2).normalize());
    const shades = corners.map((c) => {
      const out = c.clone().sub(centre).divide(radii);
      return THREE.MathUtils.clamp(0.35 + 0.55 * out.length() + 0.12 * out.y, 0.3, 1);
    });
    b.card(corners, normals, shades, rng() < 0.5 ? LEAVES_A : LEAVES_B);
  }
  return b.build();
}

/**
 * A conifer one unit high: a trunk to the top, and whorls of needled
 * branches round it, wide at the bottom and narrowing to the top, drooping
 * and tilted either way so the tree has body from every side; `detail` 1
 * for the full tree, 0 for fewer, wider whorls.
 */
export function coniferTree(detail: 0 | 1, seed = 'conifer'): THREE.BufferGeometry {
  const rng = seededRandom(seed);
  const b = new TreeBuilder();
  b.tube(new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0, 0.97, 0), 0.024, 0.004, detail ? 6 : 4, 0.85);
  const whorls = detail ? 17 : 6;
  const perWhorl = detail ? 8 : 5;
  const low = 0.22;
  const high = 0.94;
  for (let w = 0; w < whorls; w++) {
    const f = w / (whorls - 1);
    const h = low + (high - low) * f;
    const reach = 0.04 + 0.27 * Math.pow(1 - f, 0.9);
    const width = reach * (detail ? 1.05 : 1.3);
    for (let j = 0; j < perWhorl; j++) {
      const a = (j / perWhorl) * Math.PI * 2 + w * 2.39996 + (rng() - 0.5) * 0.5;
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const across = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      // The branch droops; the card is tilted about the branch so it shows from the side and from above.
      const droop = 0.25 + rng() * 0.2;
      const along = out.clone().addScaledVector(UP, -droop).normalize();
      const tilt = (j % 2 ? 1 : -1) * (0.55 + rng() * 0.25);
      const side = across.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(UP, Math.sin(tilt)).normalize();
      const root = new THREE.Vector3(0, h, 0);
      const tip = root.clone().addScaledVector(along, reach * (0.9 + rng() * 0.2));
      const half = side.clone().multiplyScalar(width / 2);
      const corners = [root.clone().add(half), tip.clone().add(half), tip.clone().sub(half), root.clone().sub(half)];
      const n = new THREE.Vector3().crossVectors(along, side).normalize();
      if (n.y < 0) n.negate();
      const normals = corners.map((c) => new THREE.Vector3(c.x, 0, c.z).normalize().multiplyScalar(0.6).addScaledVector(UP, 0.45).addScaledVector(n, 0.25).normalize());
      // Darker in by the trunk and low down.
      const shade = 0.6 + 0.4 * f;
      b.card(corners, normals, [shade * 0.5, shade, shade, shade * 0.5], NEEDLES);
    }
  }
  // The leader at the top: two crossed cards.
  for (let k = 0; k < 2; k++) {
    const a = k * Math.PI / 2;
    const half = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.03);
    const bottom = new THREE.Vector3(0, 0.88, 0);
    const topP = new THREE.Vector3(0, 1.0, 0);
    const corners = [bottom.clone().add(half), topP.clone().add(half), topP.clone().sub(half), bottom.clone().sub(half)];
    b.card(corners, corners.map(() => UP.clone()), [1, 1, 1, 1], NEEDLES);
  }
  return b.build();
}

/** The foliage and bark atlas, drawn on a canvas: two leaf clusters, a needled branch and bark. Needs a DOM. */
export function treeAtlas(): THREE.DataTexture {
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rng = seededRandom('tree-atlas');
  leafCluster(ctx, 0, 0, 512, rng, 96);
  leafCluster(ctx, 512, 0, 512, rng, 82);
  needleBranch(ctx, 0, 512, 512, rng);
  bark(ctx, 512, 512, 512, rng);
  const img = ctx.getImageData(0, 0, S, S);
  bleed(img.data, S);
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer.slice(0)), S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** A cluster of leaves in a square: twigs, then leaves from the darker inside out to the lighter top. */
function leafCluster(ctx: CanvasRenderingContext2D, x0: number, y0: number, size: number, rng: () => number, hue: number): void {
  const cx = x0 + size / 2;
  const cy = y0 + size / 2;
  const R = size * 0.45;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgb(74, 58, 42)';
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    ctx.lineWidth = 3 + rng() * 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy + R * 0.2);
    ctx.quadraticCurveTo(cx + Math.cos(a) * R * 0.3, cy + Math.sin(a) * R * 0.3, cx + Math.cos(a) * R * 0.75, cy + Math.sin(a) * R * 0.75);
    ctx.stroke();
  }
  const lobes = rng() * Math.PI * 2;
  const leaves: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 760; i++) {
    const a = rng() * Math.PI * 2;
    const edge = R * (0.82 + 0.18 * Math.sin(a * 5 + lobes));
    const r = edge * Math.sqrt(rng());
    leaves.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, r: r / edge });
  }
  // Inner and lower leaves first and darker; the outer, upper ones over them and lighter.
  leaves.sort((p, q) => p.r - q.r);
  for (const l of leaves) {
    const up = (cy - l.y) / R;
    const light = 17 + 17 * l.r + 7 * up + rng() * 10;
    ctx.fillStyle = `hsl(${hue + (rng() - 0.5) * 18}, ${38 + rng() * 18}%, ${light}%)`;
    const len = 22 + rng() * 15;
    const wid = 9 + rng() * 6;
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(rng() * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.quadraticCurveTo(0, -wid, len / 2, 0);
    ctx.quadraticCurveTo(0, wid, -len / 2, 0);
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue}, 30%, ${light - 8}%, 0.6)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.lineTo(len / 2, 0);
    ctx.stroke();
    ctx.restore();
  }
}

/** A conifer branch in a square, from its left edge (the trunk) out to the right: twigs either side, thick with needles. */
function needleBranch(ctx: CanvasRenderingContext2D, x0: number, y0: number, size: number, rng: () => number): void {
  const mid = y0 + size / 2;
  const len = size * 0.96;
  ctx.lineCap = 'round';
  const needles = (x: number, y: number, ax: number, ay: number, l: number, light: number) => {
    // Needles along a twig from (x, y) in direction (ax, ay), length l, angled forward either side.
    const n = Math.max(5, Math.round(l / 3.4));
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const px = x + ax * l * f;
      const py = y + ay * l * f;
      const nl = 12 + rng() * 9 * (1 - f * 0.5);
      for (const s of [-1, 1]) {
        const a = Math.atan2(ay, ax) + s * (0.9 + rng() * 0.4);
        ctx.strokeStyle = `hsl(${128 + (rng() - 0.5) * 16}, ${42 + rng() * 16}%, ${light + rng() * 10}%)`;
        ctx.lineWidth = 2 + rng();
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(a) * nl, py + Math.sin(a) * nl);
        ctx.stroke();
      }
    }
  };
  // Twigs either side of the main stem, longest a third of the way out, shorter to the tip.
  for (let x = 6; x < len - 16; x += 15 + rng() * 7) {
    const f = x / len;
    const reach = size * 0.44 * Math.sin(Math.PI * Math.min(1, f * 1.1 + 0.18)) * (1 - f * 0.35);
    for (const s of [-1, 1]) {
      // Some twigs missing and the rest of uneven length, for a ragged outline.
      if (rng() < 0.18) continue;
      const twig = reach * (0.5 + 0.5 * rng());
      const a = s * (0.65 + rng() * 0.5);
      const ax = Math.cos(a);
      const ay = Math.sin(a);
      const sy = mid + f * f * 26;
      ctx.strokeStyle = 'rgb(70, 56, 40)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0 + x, sy);
      ctx.lineTo(x0 + x + ax * twig, sy + ay * twig);
      ctx.stroke();
      needles(x0 + x, sy, ax, ay, twig, 14 + 14 * (1 - Math.abs(ay)) * 0.5 + (s < 0 ? 6 : 0));
    }
  }
  ctx.strokeStyle = 'rgb(66, 50, 36)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x0, mid);
  ctx.quadraticCurveTo(x0 + len * 0.6, mid + 4, x0 + len, mid + 26);
  ctx.stroke();
  needles(x0, mid, 1, 0.02, len, 18);
}

/** Bark: dark grey-brown with lengthwise fissures. */
function bark(ctx: CanvasRenderingContext2D, x0: number, y0: number, size: number, rng: () => number): void {
  ctx.fillStyle = 'rgb(118, 98, 76)';
  ctx.fillRect(x0, y0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = x0 + rng() * size;
    const l = 20 + rng() * 120;
    const y = y0 + rng() * (size - l);
    const v = 60 + rng() * 80;
    ctx.strokeStyle = `rgb(${v}, ${v * 0.82}, ${v * 0.64})`;
    ctx.lineWidth = 1 + rng() * 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 6, y + l);
    ctx.stroke();
  }
}

/** Gives fully transparent pixels the colour of their quadrant's leaves, so mipmaps do not darken the edges. */
function bleed(px: Uint8ClampedArray, S: number): void {
  const half = S / 2;
  for (let q = 0; q < 4; q++) {
    const qx = (q % 2) * half;
    const qy = Math.floor(q / 2) * half;
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = qy; y < qy + half; y++) {
      for (let x = qx; x < qx + half; x++) {
        const i = (y * S + x) * 4;
        if (px[i + 3] < 200) continue;
        sum[0] += px[i];
        sum[1] += px[i + 1];
        sum[2] += px[i + 2];
        n++;
      }
    }
    if (!n) continue;
    for (let y = qy; y < qy + half; y++) {
      for (let x = qx; x < qx + half; x++) {
        const i = (y * S + x) * 4;
        if (px[i + 3] > 0) continue;
        px[i] = sum[0] / n;
        px[i + 1] = sum[1] / n;
        px[i + 2] = sum[2] / n;
      }
    }
  }
}

interface Tile {
  /** The tile's middle and the radius round it holding its trees, in the layer's (local) coordinates. */
  centre: THREE.Vector3;
  radius: number;
  near: THREE.InstancedMesh[];
  far: THREE.InstancedMesh[];
  detailed: boolean;
}

export class TreeLayer {
  /** Goes in the height-scaled world group. */
  readonly group = new THREE.Group();
  readonly time = { value: 0 };
  private readonly material: THREE.MeshStandardMaterial;
  private readonly shapes: { near: THREE.BufferGeometry; far: THREE.BufferGeometry }[];
  private tiles: Tile[] = [];

  constructor() {
    this.material = new THREE.MeshStandardMaterial({
      map: treeAtlas(), vertexColors: true, alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 1, metalness: 0,
    });
    const time = this.time;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTreeTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float leaf;\nuniform float uTreeTime;')
        // The tree's own tint is for its foliage, not its bark.
        .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.rgb *= instanceColor.rgb;', 'vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, leaf);'))
        // The crown sways a little in the wind, each tree in its own time.
        .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 treeAt = instanceMatrix[3].xyz;
float sway = sin(uTreeTime * 1.3 + treeAt.x * 0.05 + treeAt.z * 0.07) * 0.012 + sin(uTreeTime * 2.7 + treeAt.z * 0.11) * 0.004;
float bend = leaf * transformed.y * transformed.y;
transformed.x += sway * bend;
transformed.z += sway * 0.6 * bend;
#endif`);
      // Both faces of a card keep the crown's outward normals.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;'));
    };
    this.material.customProgramCacheKey = () => 'card-tree';
    this.shapes = [
      { near: coniferTree(1), far: coniferTree(0) },
      { near: broadleafTree(1), far: broadleafTree(0) },
    ];
  }

  /** Removes the trees. */
  clear(): void {
    for (const tile of this.tiles) for (const m of [...tile.near, ...tile.far]) {
      this.group.remove(m);
      m.dispose();
    }
    this.tiles = [];
  }

  /**
   * Places the trees (`trees.data`: x, ground height, z, height, kind per
   * tree), leaving out the `hidden` ones, on a map `extent` metres across,
   * at their real height whatever the `relief` the group is drawn with.
   */
  build(trees: Trees, hidden: Uint8Array | null, extent: number, relief: number): void {
    this.clear();
    const d = trees.data;
    const size = extent / TILES;
    const buckets: number[][] = Array.from({ length: TILES * TILES }, () => []);
    for (let i = 0; i < trees.count; i++) {
      if (hidden?.[i]) continue;
      const tx = THREE.MathUtils.clamp(Math.floor(d[i * 5] / size), 0, TILES - 1);
      const tz = THREE.MathUtils.clamp(Math.floor(d[i * 5 + 2] / size), 0, TILES - 1);
      buckets[tz * TILES + tx].push(i);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const color = new THREE.Color();
    for (const list of buckets) {
      if (!list.length) continue;
      const counts = [0, 0];
      for (const i of list) counts[d[i * 5 + 4]]++;
      const make = (kind: Kind, geometry: THREE.BufferGeometry) => {
        const mesh = new THREE.InstancedMesh(geometry, this.material, Math.max(1, counts[kind]));
        mesh.count = counts[kind];
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.noAo = true;
        return mesh;
      };
      const near = ([0, 1] as Kind[]).map((k) => make(k, this.shapes[k].near));
      const far = ([0, 1] as Kind[]).map((k) => make(k, this.shapes[k].far));
      const filled = [0, 0];
      let lo = new THREE.Vector3(Infinity, Infinity, Infinity);
      let hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const i of list) {
        const kind = d[i * 5 + 4] as Kind;
        const height = d[i * 5 + 3];
        // A turn, a little stretch either way and a tint of its own, from the tree's index.
        const h1 = ((i * 2654435761) >>> 0) / 4294967296;
        const h2 = ((i * 40503 + 977) % 997) / 997;
        const h3 = ((i * 69069 + 12345) % 1009) / 1009;
        q.setFromAxisAngle(UP, h1 * Math.PI * 2);
        const wide = height * (0.85 + 0.3 * h3);
        p.set(d[i * 5], d[i * 5 + 1], d[i * 5 + 2]);
        s.set(wide, height / relief, wide * (0.9 + 0.2 * h2));
        m.compose(p, q, s);
        const shade = 0.82 + 0.3 * h2;
        if (kind === 0) color.setRGB(shade * 0.92, shade, shade * 0.96);
        else color.setRGB(shade * (1 + 0.12 * (h3 - 0.5)), shade, shade * (0.9 + 0.12 * h1));
        for (const set of [near, far]) {
          set[kind].setMatrixAt(filled[kind], m);
          set[kind].setColorAt(filled[kind], color);
        }
        filled[kind]++;
        lo = lo.min(p);
        hi = hi.max(p.clone().setY(p.y + height / relief));
      }
      const tile: Tile = { centre: lo.clone().add(hi).multiplyScalar(0.5), radius: hi.distanceTo(lo) / 2 + 20, near, far, detailed: false };
      for (const mesh of [...near, ...far]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.visible = mesh.count > 0 && far.includes(mesh);
        this.group.add(mesh);
      }
      this.tiles.push(tile);
    }
  }

  /** Picks each tile's detail for a camera drawing a picture `height` pixels high, and sets the wind's clock. */
  update(camera: THREE.PerspectiveCamera, height: number, clock: number): void {
    this.time.value = clock;
    this.group.updateMatrixWorld();
    const world = new THREE.Vector3();
    const pixels = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const tile of this.tiles) {
      world.copy(tile.centre).applyMatrix4(this.group.matrixWorld);
      const dist = Math.max(1, camera.position.distanceTo(world) - tile.radius);
      const tall = (TYPICAL_HEIGHT / dist) * pixels;
      // A little either way before changing, so a tile on the edge does not flicker.
      const detailed = tile.detailed ? tall > NEAR_PIXELS * 0.85 : tall > NEAR_PIXELS;
      tile.detailed = detailed;
      for (const m of tile.near) m.visible = detailed && m.count > 0;
      for (const m of tile.far) m.visible = !detailed && m.count > 0;
    }
  }

  dispose(): void {
    this.clear();
    for (const s of this.shapes) {
      s.near.dispose();
      s.far.dispose();
    }
    this.material.map?.dispose();
    this.material.dispose();
  }
}
