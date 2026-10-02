/**
 * Surface detail for the 3D view, from photographed textures (CC0, Poly
 * Haven, in public/textures): asphalt, grass, dirt, rock and gravel close
 * up, and two aerial photographs of grassland for variation over tens and
 * hundreds of metres.
 *
 * A surface keeps the colour the view gives it (the height ramp on the
 * ground, the track's colouring, the white lines, the kerbs) and takes the
 * texture as detail: the texture's colour over its mean colour, so it adds
 * the photograph's variation without changing the surface's colour, and
 * fades to nothing in the distance as the texture's mipmaps reach that
 * mean. Each texture's normal map adds relief to the lighting.
 *
 * Textures are laid in world metres: from above on the track and its
 * surroundings, from above and the sides on the ground (triplanar), whose
 * drawn slopes can be steep. A tiled texture shows its repeat from a little
 * way off, so each is read twice, shifted by an amount that changes slowly
 * over the ground, and the two blended (Inigo Quilez's "texture
 * repetition", technique 3).
 *
 * Until the textures have loaded (about 17 MB), surfaces are drawn plain.
 */
import * as THREE from 'three';

export type SurfaceKind = 'asphalt' | 'grass' | 'meadow' | 'hills' | 'dirt' | 'rock' | 'gravel';

interface SetSpec {
  file: string;
  res: '1k' | '2k';
  /** The photograph's size on the ground, metres. */
  size: number;
  /** Whether its normal map is used (not for the aerial photographs, too large for their relief to show). */
  normal: boolean;
}

const SETS: Record<SurfaceKind, SetSpec> = {
  asphalt: { file: 'asphalt_track', res: '2k', size: 2, normal: true },
  grass: { file: 'grass_ground', res: '1k', size: 2.5, normal: true },
  meadow: { file: 'aerial_grass_rock', res: '1k', size: 15, normal: false },
  hills: { file: 'rocky_terrain_02', res: '1k', size: 90, normal: false },
  dirt: { file: 'dirt', res: '1k', size: 2, normal: true },
  rock: { file: 'rock_face', res: '1k', size: 2.4, normal: true },
  gravel: { file: 'gravel_floor_02', res: '1k', size: 2, normal: true },
};

/** The texture files of every set, under public/. */
export function surfaceFiles(): string[] {
  return Object.values(SETS).flatMap((spec) => [
    `textures/${spec.file}_diff_${spec.res}.jpg`,
    ...(spec.normal ? [`textures/${spec.file}_nor_gl_${spec.res}.jpg`] : []),
  ]);
}

export interface SurfaceSet {
  albedo: THREE.IUniform<THREE.Texture>;
  normal: THREE.IUniform<THREE.Texture>;
  /** The albedo's mean colour (linear). */
  mean: THREE.IUniform<THREE.Vector3>;
  /** The photograph's size on the ground, metres. */
  size: number;
}

export class SurfaceTextures {
  readonly sets: Record<SurfaceKind, SurfaceSet>;
  /** 1 once every texture is in, 0 before (surfaces drawn plain). */
  readonly ready: THREE.IUniform<number> = { value: 0 };

  constructor(renderer: THREE.WebGLRenderer, onLoad: () => void) {
    const white = placeholder([255, 255, 255]);
    const flat = placeholder([128, 128, 255]);
    const sets = {} as Record<SurfaceKind, SurfaceSet>;
    for (const k of Object.keys(SETS) as SurfaceKind[]) {
      sets[k] = { albedo: { value: white }, normal: { value: flat }, mean: { value: new THREE.Vector3(1, 1, 1) }, size: SETS[k].size };
    }
    this.sets = sets;
    const loader = new THREE.TextureLoader();
    const anisotropy = renderer.capabilities.getMaxAnisotropy();
    const load = async (kind: SurfaceKind) => {
      const spec = SETS[kind];
      const base = `textures/${spec.file}`;
      const [albedo, normal] = await Promise.all([
        loader.loadAsync(`${base}_diff_${spec.res}.jpg`),
        spec.normal ? loader.loadAsync(`${base}_nor_gl_${spec.res}.jpg`) : Promise.resolve(null),
      ]);
      albedo.colorSpace = THREE.SRGBColorSpace;
      for (const t of [albedo, normal]) {
        if (!t) continue;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = anisotropy;
      }
      const set = this.sets[kind];
      set.albedo.value = albedo;
      if (normal) set.normal.value = normal;
      set.mean.value.copy(meanColour(albedo.image as CanvasImageSource & { width: number; height: number }));
    };
    Promise.all((Object.keys(SETS) as SurfaceKind[]).map(load)).then(() => {
      this.ready.value = 1;
      onLoad();
    }).catch((err) => console.warn('Surface textures could not be loaded; surfaces stay plain.', err));
  }

  /** The uniforms of some sets, named `t<Name>`, `t<Name>N`, `u<Name>Mean`, plus `uSurfaces` (ready). */
  uniforms(kinds: Partial<Record<string, SurfaceKind>>): Record<string, THREE.IUniform> {
    const out: Record<string, THREE.IUniform> = { uSurfaces: this.ready };
    for (const [name, kind] of Object.entries(kinds)) {
      const set = this.sets[kind!];
      out[`t${name}`] = set.albedo;
      out[`t${name}N`] = set.normal;
      out[`u${name}Mean`] = set.mean;
    }
    return out;
  }

  dispose(): void {
    for (const set of Object.values(this.sets)) {
      set.albedo.value.dispose();
      set.normal.value.dispose();
    }
  }
}

/** Detail for a surface drawn over the ground (see `wetSurfaceMaterial`). */
export interface SurfaceDetail {
  uniforms: Record<string, THREE.IUniform>;
  /** Run-off: gravel's detail where the surface's colour is gravel's, the main set's elsewhere. */
  gravel: boolean;
  /** Asphalt: broad patches of a slightly different tone. */
  patches: boolean;
}

/**
 * Detail from one set for a surface: `amount` of its colour variation,
 * `chroma` of its hue, `normal` the strength of its normal map; with
 * `gravel`, the gravel set takes over where the colour is gravel's;
 * `patches` adds asphalt's broad differences of tone.
 */
export function surfaceDetail(s: SurfaceTextures, main: SurfaceKind, opts: { amount?: number; chroma?: number; normal?: number; gravel?: boolean; patches?: boolean } = {}): SurfaceDetail {
  const gravel = opts.gravel ?? false;
  const uniforms = s.uniforms(gravel ? { A: main, B: 'gravel' } : { A: main });
  uniforms.uSurfSize = { value: new THREE.Vector2(s.sets[main].size, s.sets.gravel.size) };
  uniforms.uSurfDetail = { value: new THREE.Vector3(opts.amount ?? 1, opts.chroma ?? 0.3, opts.normal ?? 1) };
  return { uniforms, gravel, patches: opts.patches ?? false };
}

/**
 * Water: a lake's colour, glossy, mirroring the sky, its surface rippled by
 * a light wind: five waves of 0.6 to 6.3 m running within 40 degrees of the
 * wind at deep-water speeds, moving with `time` (seconds). Waves too small
 * for the pixels they fall on fade out, so the water does not shimmer far
 * away.
 */
export function waterMaterial(time: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x24506e, transparent: true, opacity: 0.82, roughness: 0.06, metalness: 0 });
  const waves = [[0.6, 0.0], [1.1, 0.5], [1.9, -0.35], [3.4, 0.25], [6.3, -0.7]].map(([length, turn]) => {
    const dir = new THREE.Vector2(Math.cos(0.3 + turn), Math.sin(0.3 + turn));
    const k = (Math.PI * 2) / length;
    const speed = Math.sqrt((9.81 * length) / (Math.PI * 2));
    // Steepness (height times wavenumber) 0.025 to 0.045: ripples, not waves.
    const steep = 0.047 - 0.0035 * length;
    return `s += wave(p, vec2(${dir.x.toFixed(4)}, ${dir.y.toFixed(4)}), ${k.toFixed(4)}, ${speed.toFixed(4)}, ${steep.toFixed(4)}, fp);`;
  }).join('\n  ');
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
varying vec2 vWaterXZ;
${SURFACE_GLSL}
// One wave's slope: direction d, wavenumber k, speed c, steepness a; gone when finer than the pixels (fp metres each).
vec2 wave(vec2 p, vec2 d, float k, float c, float a, float fp) {
  float fade = 1.0 - smoothstep(0.4, 1.6, fp * k);
  return d * a * cos(k * (dot(d, p) - c * uTime)) * fade;
}
vec2 waterSlope(vec2 p) {
  float fp = length(fwidth(p));
  vec2 s = vec2(0.0);
  ${waves}
  return s;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
vec2 slope = waterSlope(vWaterXZ);
normal = normalize(surfaceFrame(-vViewPosition, normal, vWaterXZ) * normalize(vec3(-slope, 1.0)));`);
  };
  m.customProgramCacheKey = () => 'water';
  return m;
}

function placeholder(rgb: [number, number, number]): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** The mean colour of an sRGB image, in linear values (as the GPU averages its mipmaps). */
function meanColour(image: CanvasImageSource & { width: number; height: number }): THREE.Vector3 {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) sum[c] += srgbToLinear(px[i + c] / 255);
  }
  const n = px.length / 4;
  return new THREE.Vector3(sum[0] / n, sum[1] / n, sum[2] / n);
}

/**
 * GLSL shared by the surfaces: a value noise, the two shifted reads of a
 * tiled texture (`Tiling`, `tiled`), detail as a colour over the mean
 * (`detail`), and a tangent frame for normal maps laid in world xz.
 */
export const SURFACE_GLSL = /* glsl */`
float surfHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float surfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(surfHash(i), surfHash(i + vec2(1.0, 0.0)), u.x), mix(surfHash(i + vec2(0.0, 1.0)), surfHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
struct Tiling {
  vec2 a;
  vec2 b;
  float f;
  vec2 dx;
  vec2 dy;
};
// uv in tiles: two layouts of the texture shifted by a hash, chosen by a noise that changes every few tiles.
Tiling tiling(vec2 uv) {
  float k = surfNoise(uv * 0.27) * 7.0;
  float i = floor(k);
  Tiling t;
  t.a = uv + sin(vec2(3.0, 7.0) * i);
  t.b = uv + sin(vec2(3.0, 7.0) * (i + 1.0));
  t.f = smoothstep(0.3, 0.7, fract(k));
  t.dx = dFdx(uv);
  t.dy = dFdy(uv);
  return t;
}
vec3 tiled(sampler2D s, Tiling t) {
  return mix(textureGrad(s, t.a, t.dx, t.dy).rgb, textureGrad(s, t.b, t.dx, t.dy).rgb, t.f);
}
// The same, blurred: read from a smaller mipmap, so only the broad variation is left.
vec3 tiledBlur(sampler2D s, Tiling t, float blur) {
  return mix(textureGrad(s, t.a, t.dx * blur, t.dy * blur).rgb, textureGrad(s, t.b, t.dx * blur, t.dy * blur).rgb, t.f);
}
// The texture's colour over its mean: 1 on average; amount scales it, chroma keeps (1) or drops (0) its hue.
vec3 detail(vec3 c, vec3 mean, float amount, float chroma) {
  vec3 r = c / max(mean, vec3(1e-3));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) / max(dot(mean, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  return mix(vec3(1.0), mix(vec3(l), r, chroma), amount);
}
// A normal map's tangent-space normal, flattened by strength.
vec3 tangentNormal(vec3 c, float strength) {
  vec3 n = c * 2.0 - 1.0;
  n.xy *= strength;
  return normalize(n);
}
// Triplanar: a texture laid from above and from both sides, weighted by the surface's normal, so it does not
// stretch on steep ground. w: the weights of the projection along x (uv zy), from above (uv xz) and along z (uv xy).
struct Tri {
  Tiling x;
  Tiling y;
  Tiling z;
  vec3 w;
};
Tri triTiling(vec3 p, vec3 n, float size) {
  Tri t;
  vec3 w = pow(abs(n), vec3(4.0));
  t.w = w / (w.x + w.y + w.z);
  t.x = tiling(p.zy / size);
  t.y = tiling(p.xz / size);
  t.z = tiling(p.xy / size);
  return t;
}
vec3 triColour(sampler2D s, Tri t) {
  vec3 c = vec3(0.0);
  float sum = 0.0;
  if (t.w.y > 0.02) { c += t.w.y * tiled(s, t.y); sum += t.w.y; }
  if (t.w.x > 0.02) { c += t.w.x * tiled(s, t.x); sum += t.w.x; }
  if (t.w.z > 0.02) { c += t.w.z * tiled(s, t.z); sum += t.w.z; }
  return c / max(sum, 1e-3);
}
// A triplanar normal map, given each projection's tangent frame (surfaceFrame with uv zy, xz and xy).
vec3 triNormal(sampler2D s, Tri t, mat3 fx, mat3 fy, mat3 fz, float strength, vec3 n) {
  vec3 r = vec3(0.0);
  if (t.w.y > 0.02) r += t.w.y * (fy * tangentNormal(tiled(s, t.y), strength));
  if (t.w.x > 0.02) r += t.w.x * (fx * tangentNormal(tiled(s, t.x), strength));
  if (t.w.z > 0.02) r += t.w.z * (fz * tangentNormal(tiled(s, t.z), strength));
  return dot(r, r) > 0.0 ? normalize(r) : n;
}
// The tangent frame of a surface for uv laid in world xz (after three.js's getTangentFrame).
mat3 surfaceFrame(vec3 eye, vec3 n, vec2 uv) {
  vec3 q0 = dFdx(eye);
  vec3 q1 = dFdy(eye);
  vec2 st0 = dFdx(uv);
  vec2 st1 = dFdy(uv);
  vec3 q1perp = cross(q1, n);
  vec3 q0perp = cross(n, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, n);
}
`;

/**
 * Chain-link fencing as a texture of 0.6 m of fence: diamonds of wire 6 cm
 * across, see-through between. Needs a DOM. Laid with uv in metres.
 */
export function chainLink(): THREE.DataTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.strokeStyle = 'rgb(200, 204, 208)';
  ctx.lineWidth = 2.2;
  const cells = 10;
  const step = S / cells;
  for (let i = -cells; i <= 2 * cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step + S, S);
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step - S, S);
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, S, S);
  // The wire's colour in the gaps too, so mipmaps fade the mesh to a grey haze rather than darken it.
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] > 0) continue;
    img.data[i] = 200;
    img.data[i + 1] = 204;
    img.data[i + 2] = 208;
  }
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer.slice(0)), S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 0.6, 1 / 0.6);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
