/**
 * The map in 3D: the terrain with the track's earthworks, the track and pit
 * lane, water, and the sides of the map as on a model, under a sky, with an
 * orbit camera. The geometry comes from core/scene3d.ts; the ground takes its
 * colour in the shader from height and slope, as the flat map does, with
 * embankments as grass and cuttings as bare earth.
 *
 * It follows the store: rebuilt shortly after the terrain, the track or the
 * facilities change, recoloured when the track colouring changes. It draws
 * only when something changed (the camera, the data, the hover).
 *
 * Scene coordinates: x east, y up, z south, in metres. The model sits in a
 * group that scales heights (vertical exaggeration) around the lowest point.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COLORS, Earthworks, type MeshData, type Road, VERGE, buildRoads, buildSides, buildTerrain, pitRoad, startLine, trackRoad } from '../core/scene3d.ts';
import { RAMP, RAMP_MIN_RANGE, ROCK, contourInterval } from '../core/terrainImage.ts';
import type { Track } from '../core/track.ts';
import { buckets, stationBuckets } from './colors.ts';
import { h, setText } from './dom.ts';
import { download } from './download.ts';
import * as fmt from './format.ts';
import type { Store, Topic } from './store.ts';

/** Rebuilds wait this long after the last change, so an edit in progress is not rebuilt at every step. */
const REBUILD_DELAY = 250;
const SKY = ['#3f78b8', '#9cc2e2', '#dce8f1'];
const HORIZON = 0xc9dbea;
const FOV = 45;
const MARKER = 0x3fb6ff;
const LINE = 0xff5a36;

export class View3D {
  readonly el: HTMLElement;
  private readonly store: Store;
  private readonly readout: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1, 100_000);
  private readonly controls: OrbitControls;
  /** The model, in metres with heights above sea level, scaled and moved into the scene. */
  private readonly world = new THREE.Group();
  private readonly labelLayer: HTMLElement;
  private readonly note: HTMLElement;
  private readonly marker: THREE.Group;
  private readonly terrainUniforms = {
    uLandMin: { value: 0 },
    uRampRange: { value: RAMP_MIN_RANGE },
    uWater: { value: -1e9 },
    uContour: { value: 10 },
    uContours: { value: 1 },
  };
  private readonly terrainMaterial: THREE.MeshLambertMaterial;
  private readonly surfaceMaterial = (offset: number) => new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
  private readonly meshes = new Map<string, THREE.Object3D>();
  private earth: Earthworks | null = null;
  private labels: { el: HTMLElement; p: THREE.Vector3 }[] = [];
  private visible = false;
  private needsBuild = true;
  private needsRoads = false;
  private fitted = false;
  private zRef = 0;
  private extent = 8192;
  private width = 1;
  private height = 1;
  private frame = 0;
  private rebuildTimer = 0;
  private fly: { start: number; from: THREE.Vector3; to: THREE.Vector3; cam: THREE.Vector3 } | null = null;
  private pendingPointer: { x: number; y: number } | null = null;

  constructor(store: Store, readout: HTMLElement) {
    this.store = store;
    this.readout = readout;
    this.canvas = h('canvas', { class: 'map3d-canvas' });
    // Throws when WebGL is not available; the map falls back to 2D.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.labelLayer = h('div', { class: 'map3d-labels' });
    this.note = h('div', { class: 'map3d-note', hidden: true }, 'Switch to 2D to edit the track.');
    this.el = h('div', { class: 'map3d', hidden: true }, this.canvas, this.labelLayer, this.note);

    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(HORIZON, 10_000, 40_000);
    this.scene.add(new THREE.HemisphereLight(0xe4efff, 0x5d5243, 1.4));
    // Sun from the north-west, as the hillshade of the flat map.
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-1, 1.3, -1);
    this.scene.add(sun);
    this.scene.add(this.world);

    this.terrainMaterial = new THREE.MeshLambertMaterial();
    this.terrainMaterial.onBeforeCompile = (shader) => terrainShader(shader, this.terrainUniforms);
    this.terrainMaterial.customProgramCacheKey = () => 'terrain';

    this.marker = new THREE.Group();
    const pinMaterial = new THREE.MeshLambertMaterial({ color: MARKER, emissive: MARKER, emissiveIntensity: 0.35 });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 10, 8), pinMaterial);
    stem.position.y = 5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), pinMaterial);
    head.position.y = 10.5;
    this.marker.add(stem, head);
    this.marker.visible = false;
    this.scene.add(this.marker);

    const c = new OrbitControls(this.camera, this.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.maxPolarAngle = Math.PI * 0.47;
    c.minDistance = 15;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.addEventListener('change', () => this.requestRender());
    this.controls = c;

    this.canvas.addEventListener('pointermove', (e) => {
      this.pendingPointer = { x: e.clientX, y: e.clientY };
      this.requestRender();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pendingPointer = null;
      this.store.setHover(null);
      setText(this.readout, '');
    });
    this.canvas.addEventListener('dblclick', (e) => this.flyToPoint(e.clientX, e.clientY));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(this.el);
    store.subscribe((topics) => this.onStore(topics));
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.el.hidden = !on;
    if (!on) return;
    this.resize();
    if (this.needsBuild) this.build();
    this.requestRender();
  }

  /** Shows the whole track (or map) from the south, a little above, beside `left` pixels covered on the left (the timing tower). */
  fit(left = 0): void {
    const s = this.store;
    const hm = s.terrain?.heightmap;
    if (!hm) return;
    const t = s.track;
    let minX = 0;
    let maxX = hm.extent;
    let minY = 0;
    let maxY = hm.extent;
    let z = (hm.min + hm.max) / 2;
    if (t) {
      minX = Infinity;
      maxX = -Infinity;
      minY = Infinity;
      maxY = -Infinity;
      z = 0;
      for (let k = 0; k < t.n; k++) {
        minX = Math.min(minX, t.x[k]);
        maxX = Math.max(maxX, t.x[k]);
        minY = Math.min(minY, t.y[k]);
        maxY = Math.max(maxY, t.y[k]);
        z += t.z[k] / t.n;
      }
    }
    const target = this.toScene((minX + maxX) / 2, z, (minY + maxY) / 2);
    const radius = Math.max(100, Math.hypot(maxX - minX, maxY - minY) / 2);
    const fov = (FOV * Math.PI) / 180;
    const free = Math.max(0.3, (this.width - left) / this.width);
    const aspect = Math.max(0.3, Math.min(1, (this.width * free) / this.height));
    const dist = (radius / Math.sin(fov / 2)) / aspect * 0.95;
    const elevation = (38 * Math.PI) / 180;
    // Looking north from the south, east is to the right: move the target west to centre it in the free part.
    const metresPerPixel = (2 * dist * Math.tan(fov / 2)) / this.height;
    target.x -= (left / 2) * metresPerPixel;
    this.controls.target.copy(target);
    this.camera.position.set(target.x, target.y + Math.sin(elevation) * dist, target.z + Math.cos(elevation) * dist);
    this.controls.update();
    this.fitted = true;
    this.requestRender();
  }

  /** Saves the view as a PNG. */
  exportImage(filename: string): void {
    this.render();
    this.canvas.toBlob((blob) => {
      if (blob) download(filename, blob);
    }, 'image/png');
  }

  // ---- store ---------------------------------------------------------------------

  private onStore(topics: Set<Topic>): void {
    if (topics.has('terrain') || topics.has('track') || topics.has('performance')) this.scheduleBuild();
    if (topics.has('view') || topics.has('vehicle')) {
      const v = this.store.view;
      this.terrainUniforms.uContours.value = v.contours ? 1 : 0;
      this.applyRelief();
      this.needsRoads = true;
    }
    if (topics.has('mode') || topics.has('view')) this.note.hidden = this.store.mode !== 'design';
    this.requestRender();
  }

  private scheduleBuild(): void {
    this.needsBuild = true;
    if (!this.visible) return;
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.build(), REBUILD_DELAY);
  }

  // ---- building ------------------------------------------------------------------

  private build(): void {
    clearTimeout(this.rebuildTimer);
    this.needsBuild = false;
    this.needsRoads = false;
    const s = this.store;
    const hm = s.terrain?.heightmap;
    for (const key of [...this.meshes.keys()]) this.remove(key);
    this.earth = null;
    if (!hm) return;
    // A map of another size needs a new overview.
    if (hm.extent !== this.extent) this.fitted = false;
    this.extent = hm.extent;
    this.zRef = hm.min;
    this.applyRelief();

    const t = s.track;
    const roads: Road[] = [];
    const track = t ? trackRoad(t) : null;
    if (track) roads.push(track);
    // The pit lane once the facilities belong to this version of the track.
    const pitLane = t && s.performanceCurrent ? s.facilities?.pitLane ?? null : null;
    const pit = t && pitLane ? pitRoad(pitLane, t) : null;
    if (pit) roads.push(pit);
    const earth = new Earthworks(hm, roads);
    this.earth = earth;

    const terrain = buildTerrain(hm, roads, earth);
    const geo = geometry(terrain);
    geo.setAttribute('bank', new THREE.BufferAttribute(terrain.bank, 1));
    this.add('terrain', new THREE.Mesh(geo, this.terrainMaterial));

    const hasWater = Number.isFinite(hm.waterLevel);
    const landMin = hasWater ? Math.max(hm.min, hm.waterLevel) : hm.min;
    this.terrainUniforms.uLandMin.value = landMin;
    this.terrainUniforms.uRampRange.value = Math.max(hm.max - landMin, RAMP_MIN_RANGE);
    this.terrainUniforms.uWater.value = hasWater ? hm.waterLevel : -1e9;
    this.terrainUniforms.uContour.value = contourInterval(Math.max(hm.max - landMin, 1e-6));

    const base = hm.min - Math.max(30, hm.extent * 0.012);
    this.add('sides', new THREE.Mesh(geometry(buildSides(earth, base)), new THREE.MeshLambertMaterial({ vertexColors: true })));
    if (hasWater && hm.waterLevel > hm.min) {
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(hm.extent, hm.extent).rotateX(-Math.PI / 2),
        new THREE.MeshPhongMaterial({ color: 0x3a78b2, transparent: true, opacity: 0.78, shininess: 80, specular: 0x6a8aa8 }),
      );
      water.position.set(hm.extent / 2, hm.waterLevel, hm.extent / 2);
      this.add('water', water);
    }
    this.buildRoads(t, pit);
    this.buildLine(t);
    this.buildLabels(t);

    const fog = this.scene.fog as THREE.Fog;
    fog.near = hm.extent * 0.9;
    fog.far = hm.extent * 4;
    this.controls.maxDistance = hm.extent * 2.5;
    if (!this.fitted) this.fit();
    this.requestRender();
  }

  private buildRoads(t: Track | null, pit: Road | null): void {
    this.remove('track');
    this.remove('trackVerges');
    this.remove('pit');
    this.remove('pitVerges');
    this.remove('start');
    if (!t) return;
    const main = buildRoads([{ road: trackRoad(t), style: { surface: this.surfaceColors(t), lines: true } }]);
    // The track wins over the pit lane where they meet, and both over the verges.
    this.add('track', new THREE.Mesh(geometry(main.paved), this.surfaceMaterial(-3)));
    this.add('trackVerges', new THREE.Mesh(geometry(main.verges), this.surfaceMaterial(-1)));
    if (pit) {
      const lane = buildRoads([{ road: pit, style: { surface: COLORS.pitAsphalt, lines: false } }]);
      this.add('pit', new THREE.Mesh(geometry(lane.paved), this.surfaceMaterial(-2)));
      this.add('pitVerges', new THREE.Mesh(geometry(lane.verges), this.surfaceMaterial(-1)));
    }
    this.add('start', new THREE.Mesh(geometry(startLine(t)), this.surfaceMaterial(-4)));
  }

  /** The track colouring of the flat map, on the asphalt between the edge lines. */
  private surfaceColors(t: Track): Float32Array | readonly number[] {
    const s = this.store;
    const list = buckets(s.view.colorBy, t, s.lap, s.vehicle.gears);
    if (!list.length) return COLORS.asphalt;
    const idx = stationBuckets(t, s.view.colorBy, { lap: s.lap, index: (k) => s.lapIndex(k) });
    const rgb = list.map((b) => hexToRgb(b.color));
    const out = new Float32Array(t.n * 3);
    for (let k = 0; k < t.n; k++) {
      const c = idx[k] >= 0 ? rgb[idx[k]] : COLORS.asphalt;
      out[k * 3] = c[0];
      out[k * 3 + 1] = c[1];
      out[k * 3 + 2] = c[2];
    }
    return out;
  }

  private buildLine(t: Track | null): void {
    this.remove('line');
    const s = this.store;
    const line = s.performanceCurrent ? s.performance?.line : null;
    if (!t || !line || line.n !== t.n) return;
    const pos = new Float32Array(t.n * 3);
    for (let k = 0; k < t.n; k++) {
      pos[k * 3] = line.x[k];
      pos[k * 3 + 1] = t.z[k] + 0.25;
      pos[k * 3 + 2] = line.y[k];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const loop = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: LINE }));
    loop.visible = s.view.line;
    this.add('line', loop);
  }

  /** Corner numbers and the start, as labels over the view. */
  private buildLabels(t: Track | null): void {
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    const m = this.store.metrics;
    if (!t) return;
    const at = (k: number, text: string, cls = '') => {
      const el = h('div', { class: `map3d-label ${cls}` }, text);
      this.labelLayer.append(el);
      this.labels.push({ el, p: new THREE.Vector3(t.x[k], t.z[k] + 8, t.y[k]) });
    };
    at(0, 'Start', 'start');
    for (const c of m?.corners ?? []) at(c.apex, `T${c.number}`);
  }

  private add(key: string, obj: THREE.Object3D): void {
    this.remove(key);
    this.meshes.set(key, obj);
    this.world.add(obj);
  }

  private remove(key: string): void {
    const obj = this.meshes.get(key);
    if (!obj) return;
    this.world.remove(obj);
    this.meshes.delete(key);
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      if (mat && mat !== this.terrainMaterial) mat.dispose();
    });
  }

  private applyRelief(): void {
    const r = this.store.view.relief;
    this.world.scale.set(1, r, 1);
    this.world.position.set(0, -this.zRef * r, 0);
    this.world.updateMatrixWorld(true);
  }

  /** A model point (x east, height, y south) in scene coordinates. */
  private toScene(x: number, z: number, y: number): THREE.Vector3 {
    return this.world.localToWorld(new THREE.Vector3(x, z, y));
  }

  // ---- drawing -------------------------------------------------------------------

  private resize(): void {
    const rect = this.el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.width = rect.width;
    this.height = rect.height;
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.visible || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    if (this.needsRoads) {
      this.needsRoads = false;
      const t = this.store.track;
      const pit = t && this.store.performanceCurrent && this.store.facilities?.pitLane ? pitRoad(this.store.facilities.pitLane, t) : null;
      if (this.earth) this.buildRoads(t, pit);
      const line = this.meshes.get('line');
      if (line) line.visible = this.store.view.line;
    }
    let moving = this.controls.update();
    if (this.fly) moving = this.stepFly() || moving;
    this.keepAboveGround();
    // Depth precision: the near plane follows the distance to what the camera looks at.
    const d = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.1, Math.min(20, d / 800));
    this.camera.far = d * 4 + this.extent * 3;
    this.camera.updateProjectionMatrix();
    this.updateMarker(d);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    if (this.pendingPointer) {
      this.hoverAt(this.pendingPointer.x, this.pendingPointer.y);
      this.pendingPointer = null;
    }
    if (moving) this.requestRender();
  }

  private keepAboveGround(): void {
    if (!this.earth) return;
    const local = this.world.worldToLocal(this.camera.position.clone());
    const ground = this.ground(local.x, local.z);
    if (ground === null) return;
    const min = this.toScene(local.x, ground, local.z).y + 3;
    if (this.camera.position.y < min) this.camera.position.y = min;
  }

  private updateMarker(dist: number): void {
    const t = this.store.track;
    const k = this.store.hover;
    this.marker.visible = !!t && k !== null && k < t.n;
    if (!this.marker.visible || !t || k === null) return;
    this.marker.position.copy(this.toScene(t.x[k], t.z[k], t.y[k]));
    // Roughly the same size on screen at any distance.
    const scale = Math.max(1, Math.min(60, dist / 120));
    this.marker.scale.setScalar(scale);
  }

  private updateLabels(): void {
    const show = this.store.view.labels;
    this.labelLayer.hidden = !show;
    if (!show) return;
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.p);
      this.world.localToWorld(v);
      v.project(this.camera);
      const off = v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1;
      l.el.hidden = off;
      if (off) continue;
      const x = ((v.x + 1) / 2) * this.width;
      const y = ((1 - v.y) / 2) * this.height;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  // ---- picking -------------------------------------------------------------------

  /** Shaped ground height at a model point, or null off the map. */
  private ground(x: number, y: number): number | null {
    if (!this.earth || x < 0 || y < 0 || x > this.extent || y > this.extent) return null;
    return this.earth.height(x, y);
  }

  /** The ground point under a screen position: marches along the view ray until it passes below the ground. */
  private pick(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.earth) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = this.world.worldToLocal(ray.ray.origin.clone());
    const d = this.world.worldToLocal(ray.ray.origin.clone().add(ray.ray.direction)).sub(o).normalize();
    const above = (t: number) => {
      const x = o.x + d.x * t;
      const y = o.z + d.z * t;
      const g = this.ground(x, y);
      return g === null ? null : o.y + d.y * t - g;
    };
    const maxT = this.extent * 5;
    let prev = 0;
    let t = 0;
    let wasInside = false;
    for (let i = 0; i < 4000 && t < maxT; i++) {
      const a = above(t);
      if (a !== null) {
        wasInside = true;
        if (a <= 0) {
          // Home in on the crossing between the last point above and this one.
          let lo = prev;
          let hi = t;
          for (let j = 0; j < 24; j++) {
            const mid = (lo + hi) / 2;
            const am = above(mid);
            if (am !== null && am <= 0) hi = mid;
            else lo = mid;
          }
          return new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
        }
      } else if (wasInside) {
        return null;
      }
      prev = t;
      t += Math.max(0.5, t * 0.002);
    }
    return null;
  }

  private hoverAt(clientX: number, clientY: number): void {
    const p = this.pick(clientX, clientY);
    const t = this.store.track;
    if (!p) {
      setText(this.readout, '');
      this.store.setHover(null);
      return;
    }
    let station: number | null = null;
    if (t) {
      let best = Infinity;
      for (let k = 0; k < t.n; k++) {
        const dx = t.x[k] - p.x;
        const dy = t.y[k] - p.z;
        const dd = dx * dx + dy * dy;
        if (dd < best) {
          best = dd;
          station = k;
        }
      }
      if (station !== null && Math.sqrt(best) > t.width[station] / 2 + VERGE) station = null;
    }
    this.store.setHover(station);
    const z = t && station !== null ? t.z[station] : p.y;
    setText(this.readout, `${(p.x / 1000).toFixed(2)} km E  ${(p.z / 1000).toFixed(2)} km S  ·  ${fmt.elevation(z)}${station !== null ? `  ·  ${fmt.km(t!.s[station])} along the lap` : ''}`);
  }

  /** Double-click: glide the view to centre on the point under the cursor. */
  private flyToPoint(clientX: number, clientY: number): void {
    const p = this.pick(clientX, clientY);
    if (!p) return;
    this.fly = { start: performance.now(), from: this.controls.target.clone(), to: this.world.localToWorld(p.clone()), cam: this.camera.position.clone() };
    this.requestRender();
  }

  private stepFly(): boolean {
    const f = this.fly!;
    const k = Math.min(1, (performance.now() - f.start) / 600);
    const e = k * k * (3 - 2 * k);
    const shift = f.to.clone().sub(f.from).multiplyScalar(e);
    this.controls.target.copy(f.from).add(shift);
    this.camera.position.copy(f.cam).add(shift);
    if (k >= 1) this.fly = null;
    return true;
  }
}

/** A mesh's buffers as three.js geometry, with colours made linear. */
function geometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  if (m.colors) {
    const lin = new Float32Array(m.colors.length);
    for (let i = 0; i < lin.length; i++) lin[i] = srgbToLinear(m.colors[i]);
    g.setAttribute('color', new THREE.BufferAttribute(lin, 3));
  }
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string): number[] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, SKY[0]);
  grad.addColorStop(0.6, SKY[1]);
  grad.addColorStop(1, SKY[2]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Colours the ground in the shader: the height ramp of the flat map, bare
 * rock on steep slopes, grass on embankments and earth in cuttings, the bed
 * under water, and contour lines.
 */
function terrainShader(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Record<string, THREE.IUniform>): void {
  Object.assign(shader.uniforms, uniforms);
  const c = (rgb: readonly number[]) => `vec3(${(rgb[0] / 255).toFixed(4)}, ${(rgb[1] / 255).toFixed(4)}, ${(rgb[2] / 255).toFixed(4)})`;
  let ramp = `vec3 c = ${c(RAMP[RAMP.length - 1].slice(1))};\n`;
  for (let i = RAMP.length - 1; i >= 1; i--) {
    const a = RAMP[i - 1];
    const b = RAMP[i];
    ramp += `if (t <= ${b[0].toFixed(3)}) c = mix(${c(a.slice(1))}, ${c(b.slice(1))}, (t - ${a[0].toFixed(3)}) / ${(b[0] - a[0]).toFixed(3)});\n`;
  }
  shader.vertexShader = `attribute float bank;\nvarying float vHeight;\nvarying float vUp;\nvarying float vBank;\n${shader.vertexShader}`.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\nvHeight = position.y;\nvUp = normal.y;\nvBank = bank;',
  );
  shader.fragmentShader = `varying float vHeight;\nvarying float vUp;\nvarying float vBank;
uniform float uLandMin;
uniform float uRampRange;
uniform float uWater;
uniform float uContour;
uniform float uContours;
vec3 groundColour() {
  float t = clamp((vHeight - uLandMin) / uRampRange, 0.0, 1.0);
  ${ramp}
  float up = max(vUp, 0.05);
  float slope = sqrt(max(0.0, 1.0 - up * up)) / up;
  c = mix(c, ${c(ROCK)}, clamp((slope - 0.35) / 0.4, 0.0, 0.75));
  c = mix(c, vec3(0.42, 0.58, 0.28), clamp(vBank / 1.5, 0.0, 1.0) * 0.8);
  c = mix(c, vec3(0.55, 0.43, 0.30), clamp(-vBank / 1.5, 0.0, 1.0) * 0.8);
  if (vHeight < uWater) c = mix(c, vec3(0.20, 0.33, 0.36), 0.45 + 0.4 * clamp((uWater - vHeight) / 15.0, 0.0, 1.0));
  if (uContours > 0.5) {
    float h = vHeight / uContour;
    float f = abs(fract(h + 0.5) - 0.5) / max(fwidth(h), 1e-4);
    float line = 1.0 - clamp(f, 0.0, 1.0);
    float major = abs(mod(floor(h + 0.5), 5.0)) < 0.5 ? 0.5 : 0.28;
    c = mix(c, vec3(0.23, 0.16, 0.09), line * major);
  }
  return pow(c, vec3(2.2));
}
${shader.fragmentShader}`.replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( groundColour(), opacity );');
}
