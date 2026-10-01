/**
 * The map in 3D: the terrain with the track's earthworks, the track and pit
 * lane, water, and the sides of the map as on a model, under a sky, with an
 * orbit camera. On it the scenery: kerbs, run-off, the pit building and pit
 * wall, grandstands, the grid boxes and trees. The geometry comes from
 * core/scene3d.ts and core/scenery.ts; the ground takes its colour in the
 * shader from height and slope, as the flat map does, with embankments as
 * grass and cuttings as bare earth.
 *
 * Camera shots (core/shots.ts) glide the camera to a spot; the flyover and
 * the hot lap move it along the track, and can be paused to look around or
 * save an image. Images are saved at the screen size, twice that or 4K, with
 * the labels drawn in.
 *
 * In Race mode the race runs on it (ui/carLayer.ts): every car drawn as its
 * model where the race puts it, under sun shadows around what the camera
 * looks at; the camera can follow the selected car, and clicking a car
 * selects it. TV shows it as a broadcast (ui/tvBroadcast.ts): trackside
 * cameras and the helicopter, chosen by a director, with captions.
 *
 * The race's weather shows too (ui/weatherLayer.ts): cloud before a shower,
 * rain, a wet and glossy track, spray behind the cars. Marshals stand at
 * their posts and show the flags and boards race control calls for
 * (ui/flagLayer.ts).
 *
 * With layouts, the track is the layout shown; the rest of the circuit and
 * the other layouts' links are built as plain roads round it, so the ground
 * is shaped for all of them.
 *
 * It follows the store: rebuilt shortly after the terrain, the track or the
 * facilities change, recoloured when the track colouring changes. It draws
 * only when something changed or moves (the camera, the data, the hover).
 *
 * Scene coordinates: x east, y up, z south, in metres. The model sits in a
 * group that scales heights (vertical exaggeration) around the lowest point.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, Earthworks, type MeshData, type Road, VERGE, anchoredHeight, buildRoads, buildSides, buildTerrain, pitRoad, startLine, trackRoad } from '../core/scene3d.ts';
import {
  type Footprint, type PostSite, type RunoffArea, TrackIndex, type Trees, buildGrandstands, buildGridMarks, buildKerbs, buildMarshalPosts, buildPitBuilding, buildRunoff,
  forest, inside, kerbRuns, lineFlagSite, marshalPostSites, placeGrandstands, placeTrees, runoffAreas, runoffTest,
} from '../core/scenery.ts';
import { type Pose, type Shot, type ShotInput, type Vec3, flyoverDuration, flyoverPose, hotLapPose, trackShots } from '../core/shots.ts';
import { RAMP, RAMP_MIN_RANGE, ROCK, contourInterval } from '../core/terrainImage.ts';
import type { Track } from '../core/track.ts';
import { buckets, stationBuckets } from './colors.ts';
import { h, setChildren, setText } from './dom.ts';
import { download, slug } from './download.ts';
import * as fmt from './format.ts';
import { type TvCamera, tvCameras } from '../core/broadcast.ts';
import { flagState, lineFlag, postSignals } from '../core/flags.ts';
import { DT } from '../core/race/sim.ts';
import { cloudCover, lineWetness, standingWater } from '../core/weatherFx.ts';
import { CarLayer } from './carLayer.ts';
import { FlagLayer } from './flagLayer.ts';
import { FINE, type WeatherState, WeatherLayer, wetSurfaceMaterial } from './weatherLayer.ts';
import { TvBroadcast } from './tvBroadcast.ts';
import type { RaceController } from './raceController.ts';
import type { Store, Topic } from './store.ts';

/** Rebuilds wait this long after the last change, so an edit in progress is not rebuilt at every step. */
const REBUILD_DELAY = 250;
const HORIZON = 0xc9dbea;
const FOV = 45;
const MARKER = 0x3fb6ff;
const LINE = 0xff5a36;
/** Height of the corner labels over the track, metres. */
const LABEL_LIFT = 8;
/** Towards the sun, from the north-west as the flat map's hillshade. */
const SUN = new THREE.Vector3(-1, 1.3, -1).normalize();
/** Half the side of the patch the sun's shadows cover, metres. */
const SHADOW_REACH = 70;
/** What receives the sun's shadows (when cars are shown). */
const SHADOW_RECEIVERS = new Set(['terrain', 'track', 'trackVerges', 'pit', 'pitVerges', 'otherRoads', 'otherVerges', 'start', 'kerbs', 'runoff', 'grid', 'pitBuilding', 'stands', 'posts']);
/** Driver codes show over this many cars nearest the camera, within this distance (metres). */
const CAR_LABELS = 12;
const CAR_LABEL_REACH = 400;
/** Seconds for a camera move to a shot. */
const GLIDE = 1.4;
const SPEEDS = [0.5, 1, 2, 4];

export type ImageSize = 'screen' | '2x' | '4k';

/** A flyover or hot lap in progress. */
interface Path {
  kind: 'fly' | 'hot';
  label: string;
  time: number;
  duration: number;
  speed: number;
  paused: boolean;
  last: number;
  pose: (time: number) => Pose;
}

export class View3D {
  readonly el: HTMLElement;
  /** Shots, playback and image controls, for the map's toolbar. */
  readonly toolbar: HTMLElement;
  private readonly store: Store;
  private readonly readout: HTMLElement;
  private readonly race: RaceController | null;
  private cars: CarLayer | null = null;
  private readonly sun: THREE.DirectionalLight;
  private readonly weather: WeatherLayer;
  private readonly flags = new FlagLayer();
  /** The marshal posts and the line's rostrum as placed in the scenery, once the analysis belongs to the track. */
  private postSites: PostSite[] = [];
  private lineSite: PostSite | null = null;
  /** Seconds on the view's own clock: it runs while a race plays, for waving flags, flashing lights and falling rain. */
  private clock = 0;
  private lastClock = 0;
  /** Driver codes over the cars near the camera (and the selected car), by car id (-1 the safety car). */
  private carLabels = new Map<number, { el: HTMLElement; text: string; p: THREE.Vector3; shown: boolean }>();
  private downAt: { x: number; y: number } | null = null;
  private tv: TvBroadcast | null = null;
  private readonly tvButton: HTMLButtonElement;
  /** The trackside cameras, worked out once per track, facilities and height exaggeration. */
  private tvCams: { input: unknown; relief: number; cams: TvCamera[] } | null = null;
  private lastStep = 0;
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
  private readonly shotSelect: HTMLSelectElement;
  private readonly sizeSelect: HTMLSelectElement;
  private readonly player: HTMLElement;
  private readonly playerLabel: HTMLElement;
  private readonly playerTime: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly speedButtons: HTMLButtonElement[];
  private readonly terrainUniforms = {
    uLandMin: { value: 0 },
    uRampRange: { value: RAMP_MIN_RANGE },
    uWater: { value: -1e9 },
    uContour: { value: 10 },
    uContours: { value: 1 },
    uWetGround: { value: 0 },
  };
  private readonly terrainMaterial: THREE.MeshLambertMaterial;
  private readonly treeMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly treeShapes: [THREE.BufferGeometry, THREE.BufferGeometry];
  /** A surface drawn over the ground (`offset` decides which wins), shining `gloss` much when wet. */
  private readonly surfaceMaterial = (offset: number, gloss = 1, racingLine = false) => wetSurfaceMaterial(offset, gloss, this.weather.wet, this.weather.envMap, racingLine);
  private readonly meshes = new Map<string, THREE.Object3D>();
  private earth: Earthworks | null = null;
  /** The roads round the track shown: the rest of the full circuit and the other layouts' links. */
  private otherRoads: Road[] = [];
  /** Labels stand LABEL_LIFT metres over the track height `base`. */
  private labels: { el: HTMLElement; text: string; cls: string; p: THREE.Vector3; base: number; shown: boolean }[] = [];
  private shots: Shot[] = [];
  private shotInput: ShotInput | null = null;
  private trees: Trees | null = null;
  private forestCache: { hm: unknown; seed: string; data: Float32Array } | null = null;
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
  private glide: { start: number; seconds: number; fromCam: THREE.Vector3; fromTarget: THREE.Vector3; toCam: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  private path: Path | null = null;
  private pendingPointer: { x: number; y: number } | null = null;

  constructor(store: Store, readout: HTMLElement, race: RaceController | null = null) {
    this.store = store;
    this.readout = readout;
    this.race = race;
    this.canvas = h('canvas', { class: 'map3d-canvas' });
    // Throws when WebGL is not available; the map falls back to 2D.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // A film-like picture, as on television.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    // Shadows only while cars are shown: the sun casts them over a patch round what the camera looks at.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.labelLayer = h('div', { class: 'map3d-labels' });
    this.note = h('div', { class: 'map3d-note', hidden: true }, 'Switch to 2D to edit the track.');

    this.playerLabel = h('span', { class: 'strong' });
    this.playerTime = h('span', { class: 'map3d-player-time' });
    this.playButton = h('button', { class: 'chip', onclick: () => this.togglePath() }, 'Pause');
    this.speedButtons = SPEEDS.map((v) => h('button', { class: 'segment', onclick: () => this.setPathSpeed(v) }, `×${v}`));
    this.player = h('div', { class: 'map3d-player', hidden: true },
      this.playerLabel, this.playerTime, this.playButton,
      h('div', { class: 'segmented' }, ...this.speedButtons),
      h('button', { class: 'chip', title: 'Stop and look around from here', onclick: () => this.stopPath() }, 'Stop'));
    this.el = h('div', { class: 'map3d', hidden: true }, this.canvas, this.labelLayer, this.note, this.player);

    this.shotSelect = h('select', {
      title: 'Camera shots',
      onchange: () => {
        const id = this.shotSelect.value;
        this.shotSelect.value = '';
        this.shotSelect.blur();
        this.goTo(id);
      },
    });
    this.sizeSelect = h('select', { title: 'Image size' },
      h('option', { value: 'screen' }, 'Screen'), h('option', { value: '2x' }, '2×'), h('option', { value: '4k' }, '4K'));
    this.tvButton = h('button', { class: 'chip map3d-tv', hidden: true, title: 'Watch the race as on television: trackside cameras and the helicopter, chosen by a director', onclick: () => this.toggleTv() }, 'TV');
    this.toolbar = h('div', { class: 'map3d-tools' },
      this.tvButton,
      this.shotSelect,
      h('button', { class: 'chip', title: 'Save the view as a PNG image', onclick: () => this.saveImage(this.sizeSelect.value as ImageSize) }, 'Save image'),
      this.sizeSelect);
    this.updateShotMenu();

    this.scene.fog = new THREE.Fog(HORIZON, 10_000, 40_000);
    const hemi = new THREE.HemisphereLight(0xe4efff, 0x5d5243, 1.4);
    this.scene.add(hemi);
    // Sun from the north-west, as the hillshade of the flat map.
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.copy(SUN);
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH, near: 1, far: 2000 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.scene.add(this.world);
    // The sky, light and fog follow the weather; fine outside a race.
    this.weather = new WeatherLayer(this.renderer, this.scene, sun, hemi);
    this.scene.add(this.weather.group, this.flags.group);

    this.terrainMaterial = new THREE.MeshLambertMaterial();
    this.terrainMaterial.onBeforeCompile = (shader) => terrainShader(shader, this.terrainUniforms);
    this.terrainMaterial.customProgramCacheKey = () => 'terrain';
    this.treeShapes = [conifer(), broadleaf()];

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
    c.zoomSpeed = 1.5;
    c.maxPolarAngle = Math.PI * 0.47;
    c.minDistance = 4;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.addEventListener('change', () => this.requestRender());
    this.controls = c;

    this.canvas.addEventListener('pointerdown', (e) => {
      // Taking hold of the camera ends a move, a path or the broadcast where the camera is.
      this.glide = null;
      if (this.path) this.stopPath();
      if (this.tv) this.stopTv();
      this.downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      // A click (not a drag) picks a car.
      const d = this.downAt;
      this.downAt = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) this.pickCar(e.clientX, e.clientY);
    });
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
    race?.onTick(() => {
      if (this.raceActive) this.requestRender();
      this.tvButton.hidden = !this.raceActive;
    });
  }

  /** A race to show: in Race mode, once one has started. */
  private get raceActive(): boolean {
    return !!this.race?.sim && this.store.mode === 'race';
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.el.hidden = !on;
    if (!on) {
      if (this.path) this.stopPath();
      return;
    }
    this.resize();
    if (this.needsBuild) this.build();
    this.requestRender();
  }

  /** Shows the whole track (or map) from the south, a little above, beside `left` pixels covered on the left (the timing tower). */
  fit(left = 0): void {
    const pose = this.overview(left);
    if (!pose) return;
    if (this.path) this.stopPath();
    this.glide = null;
    this.controls.target.copy(pose.target);
    this.camera.position.copy(pose.camera);
    this.controls.update();
    this.fitted = true;
    this.requestRender();
  }

  private overview(left = 0): { camera: THREE.Vector3; target: THREE.Vector3 } | null {
    const s = this.store;
    const hm = s.terrain?.heightmap;
    if (!hm) return null;
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
    const camera = new THREE.Vector3(target.x, target.y + Math.sin(elevation) * dist, target.z + Math.cos(elevation) * dist);
    return { camera, target };
  }

  /**
   * Saves the view as a PNG, with the labels drawn in: at the screen size,
   * twice it, or 4K (3840 x 2160, the view widened or narrowed to 16:9).
   */
  saveImage(size: ImageSize = 'screen', name?: string): void {
    const w = this.width;
    const hgt = this.height;
    const ratio = this.renderer.getPixelRatio();
    const max = Math.min(8192, this.renderer.capabilities.maxTextureSize);
    let W = Math.min(max, Math.round(w * ratio * (size === '2x' ? 2 : 1)));
    let H = Math.round((W * hgt) / w);
    if (size === '4k') {
      W = 3840;
      H = 2160;
    }
    const marker = this.marker.visible;
    this.marker.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(this.canvas, 0, 0);
    if (this.store.view.labels) this.drawLabels(ctx, W, H, size === '4k' ? 2 : W / w);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this.marker.visible = marker;
    this.requestRender();
    const file = name ?? `${slug(this.store.project.name)}-3d${size === 'screen' ? '' : `-${size}`}.png`;
    out.toBlob((blob) => {
      if (blob) download(file, blob);
    }, 'image/png');
  }

  /** Labels as on screen, for a saved image W x H pixels, `scale` times their size on screen. */
  private drawLabels(ctx: CanvasRenderingContext2D, W: number, H: number, scale: number): void {
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(11 * scale)}px system-ui, sans-serif`;
    const v = new THREE.Vector3();
    const eye = this.world.worldToLocal(this.camera.position.clone());
    for (const l of this.labels) {
      v.copy(l.p);
      this.world.localToWorld(v);
      v.project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1 || this.blocked(eye, l.p)) continue;
      const x = ((v.x + 1) / 2) * W;
      const y = ((1 - v.y) / 2) * H;
      const tw = ctx.measureText(l.text).width;
      const pw = tw + 10 * scale;
      const ph = 16 * scale;
      ctx.fillStyle = l.cls === 'start' ? '#f1f3f5' : 'rgba(12,15,19,0.8)';
      ctx.beginPath();
      ctx.roundRect(x - pw / 2, y - ph, pw, ph, 4 * scale);
      ctx.fill();
      ctx.fillStyle = l.cls === 'start' ? '#111' : '#f1f3f5';
      ctx.textAlign = 'center';
      ctx.fillText(l.text, x, y - ph / 2);
    }
    // Driver codes over the cars, where they are shown on screen.
    for (const [id, l] of this.carLabels) {
      if (!l.shown) continue;
      v.copy(l.p).project(this.camera);
      if (v.z > 1) continue;
      const x = ((v.x + 1) / 2) * W;
      const y = ((1 - v.y) / 2) * H;
      const selected = id === this.race?.selected;
      ctx.font = `700 ${Math.round(10 * scale)}px system-ui, sans-serif`;
      const pw = ctx.measureText(l.text).width + 10 * scale;
      const ph = 15 * scale;
      ctx.fillStyle = selected ? '#f1f3f5' : 'rgba(12,15,19,0.75)';
      ctx.beginPath();
      ctx.roundRect(x - pw / 2, y - ph, pw, ph, 4 * scale);
      ctx.fill();
      ctx.fillStyle = selected ? '#111' : '#f1f3f5';
      ctx.textAlign = 'center';
      ctx.fillText(l.text, x, y - ph / 2);
    }
  }

  // ---- shots and paths -------------------------------------------------------------

  private updateShotMenu(): void {
    const s = this.store;
    const lapReady = !!s.lap && !!s.performance && s.performanceCurrent;
    const options: (HTMLElement | null)[] = [
      h('option', { value: '' }, 'Shots…'),
      h('option', { value: 'overview' }, 'Overview'),
      ...this.shots.map((shot) => h('option', { value: shot.id }, shot.label)),
      s.track ? h('option', { value: 'fly' }, 'Flyover') : null,
      lapReady ? h('option', { value: 'hot' }, `Hot lap: ${s.vehicle.name}`) : null,
    ];
    setChildren(this.shotSelect, ...options);
    this.shotSelect.value = '';
  }

  /** Moves to a shot, the overview, or starts the flyover or the hot lap. */
  goTo(id: string): void {
    if (id === 'fly' || id === 'hot') {
      this.startPath(id);
      return;
    }
    if (this.path) this.stopPath();
    let pose: { camera: THREE.Vector3; target: THREE.Vector3 } | null = null;
    if (id === 'overview') pose = this.overview();
    const shot = this.shots.find((x) => x.id === id);
    if (shot) pose = { camera: this.fromDrawn(shot.camera), target: this.fromDrawn(shot.target) };
    if (!pose) return;
    this.glide = {
      start: performance.now(), seconds: GLIDE,
      fromCam: this.camera.position.clone(), fromTarget: this.controls.target.clone(),
      toCam: pose.camera, toTarget: pose.target,
    };
    this.requestRender();
  }

  private startPath(kind: 'fly' | 'hot'): void {
    const s = this.store;
    const t = s.track;
    const earth = this.earth;
    if (!t || !earth) return;
    this.glide = null;
    let path: Path | null = null;
    if (kind === 'fly') {
      path = { kind, label: 'Flyover', time: 0, duration: flyoverDuration(t), speed: 1, paused: false, last: performance.now(), pose: (time) => flyoverPose(t, (time / flyoverDuration(t)) * t.length, (x, y) => earth.height(x, y), this.drawn) };
    } else {
      const lap = s.lap;
      const line = s.performance?.line;
      if (!lap || !line || !s.performanceCurrent || line.n !== t.n) return;
      const eye = s.vehicle.kind === 'bike' ? 1.15 : 0.95;
      path = { kind, label: `Hot lap: ${s.vehicle.name}`, time: 0, duration: lap.time, speed: 1, paused: false, last: performance.now(), pose: (time) => hotLapPose(t, line, lap, time, eye, this.drawn) };
    }
    this.path = path;
    this.controls.enabled = false;
    this.player.hidden = false;
    setText(this.playerLabel, path.label);
    this.setPathSpeed(1);
    this.updatePlayer();
    this.requestRender();
  }

  private togglePath(): void {
    const p = this.path;
    if (!p) return;
    p.paused = !p.paused;
    p.last = performance.now();
    this.updatePlayer();
    this.requestRender();
  }

  private setPathSpeed(v: number): void {
    if (this.path) this.path.speed = v;
    this.speedButtons.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === v));
  }

  /** Ends the path and hands the camera back, looking where it looked. */
  private stopPath(): void {
    const p = this.path;
    if (!p) return;
    const pose = p.pose(p.time);
    this.path = null;
    this.player.hidden = true;
    this.controls.target.copy(this.fromDrawn(pose.target));
    this.controls.enabled = true;
    this.controls.update();
    this.requestRender();
  }

  private updatePlayer(): void {
    const p = this.path;
    if (!p) return;
    setText(this.playButton, p.paused ? 'Play' : 'Pause');
    setText(this.playerTime, `${clock(p.time)} / ${clock(p.duration)}`);
  }

  /** Advances a path or a glide; returns whether the camera keeps moving. */
  private stepCamera(): boolean {
    const now = performance.now();
    const dt = this.lastStep ? Math.min(0.1, (now - this.lastStep) / 1000) : 0;
    this.lastStep = now;
    if (this.tv) {
      this.tv.update(dt);
      setText(this.playerLabel, `TV · ${this.tv.label}`);
      return true;
    }
    if (this.path) {
      const p = this.path;
      if (!p.paused) {
        p.time = (p.time + ((now - p.last) / 1000) * p.speed) % p.duration;
        p.last = now;
      }
      const pose = p.pose(p.time);
      this.camera.position.copy(this.fromDrawn(pose.camera));
      this.camera.lookAt(this.fromDrawn(pose.target));
      this.updatePlayer();
      return !p.paused;
    }
    if (this.glide) {
      const g = this.glide;
      const k = Math.min(1, (now - g.start) / 1000 / g.seconds);
      const e = k * k * (3 - 2 * k);
      // Rise over the middle of a long move, so the camera arcs over the landscape instead of through it.
      const lift = Math.sin(Math.PI * e) * Math.min(1500, g.fromCam.distanceTo(g.toCam) * 0.25);
      this.camera.position.lerpVectors(g.fromCam, g.toCam, e).y += lift;
      this.controls.target.lerpVectors(g.fromTarget, g.toTarget, e);
      if (k >= 1) this.glide = null;
      return true;
    }
    return false;
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
    if (topics.has('vehicle') || topics.has('performance')) this.updateShotMenu();
    if (topics.has('mode') || topics.has('view')) this.note.hidden = this.store.mode !== 'design';
    if (topics.has('mode') || topics.has('race')) {
      this.tvButton.hidden = !this.raceActive;
      if (this.tv && !this.raceActive) this.stopTv();
    }
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
    this.trees = null;
    this.shotInput = null;
    if (this.path) this.stopPath();
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
    // The facilities, licence and racing line once they belong to this version of the track.
    const ready = !!t && s.performanceCurrent && !!s.facilities && !!s.metrics;
    const pitLane = ready ? s.facilities!.pitLane : null;
    const pit = t && pitLane ? pitRoad(pitLane, t) : null;
    if (pit) roads.push(pit);
    this.otherRoads = this.roundRoads();
    roads.push(...this.otherRoads);
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

    // Scenery, once the analysis belongs to this track.
    const footprints: Footprint[] = [];
    let areas: RunoffArea[] = [];
    let index: TrackIndex | null = null;
    if (t && ready) {
      const metrics = s.metrics!;
      index = new TrackIndex(t);
      this.add('kerbs', new THREE.Mesh(geometry(buildKerbs(t, kerbRuns(t, s.performance!.line, metrics.corners))), this.surfaceMaterial(-2)));
      // Run-off stops at the other roads: a gravel trap ends where the rest of the circuit carries on.
      const others = this.otherRoads.length ? new Earthworks(hm, this.otherRoads) : null;
      const blocked = others ? (x: number, y: number) => others.clearance(x, y) < VERGE + 2 : undefined;
      areas = s.licence ? runoffAreas(t, metrics.corners, s.licence.runoff, earth, index, blocked) : [];
      // Run-off lies beyond the verges and never overlaps a road, so it can win over the ground by a wide margin.
      if (areas.length) this.add('runoff', new THREE.Mesh(geometry(buildRunoff(t, areas, earth)), this.surfaceMaterial(-4, 0.5)));
      if (pitLane && pit) {
        const building = buildPitBuilding(pitLane, pit);
        footprints.push(building.footprint);
        this.add('pitBuilding', new THREE.Mesh(geometry(building.mesh), new THREE.MeshLambertMaterial({ vertexColors: true })));
      }
      const stands = placeGrandstands(t, metrics.corners, s.facilities!.overtaking, pitLane, areas, earth, footprints);
      footprints.push(...stands.map((x) => x.footprint));
      if (stands.length) this.add('stands', new THREE.Mesh(geometry(buildGrandstands(stands)), new THREE.MeshLambertMaterial({ vertexColors: true })));
      this.add('grid', new THREE.Mesh(geometry(buildGridMarks(t, s.facilities!.grid, index)), this.surfaceMaterial(-4)));
    }
    const onRunoff = t && index && areas.length ? runoffTest(t, areas, index) : null;
    this.postSites = [];
    this.lineSite = null;
    if (t && ready) {
      // Marshal posts behind the run-off and clear of the buildings, and the flag marshal's rostrum at the line.
      const taken = (x: number, y: number) => (onRunoff?.(x, y, 2) ?? false) || footprints.some((f) => inside(f, x, y, 2));
      this.postSites = marshalPostSites(t, s.facilities!.marshals.posts, earth, taken);
      this.lineSite = lineFlagSite(t, (pitLane?.side ?? 1) as 1 | -1, earth, taken);
      const sites = [...this.postSites, this.lineSite];
      footprints.push(...sites.map((p) => p.footprint));
      this.add('posts', new THREE.Mesh(geometry(buildMarshalPosts(sites)), new THREE.MeshLambertMaterial({ vertexColors: true })));
    }
    this.placeMarshals();
    this.trees = placeTrees(earth, this.forestFor(hm), (x, y) => (onRunoff?.(x, y, 10) ?? false) || footprints.some((f) => inside(f, x, y, 8)));
    this.buildTrees();
    this.buildLabels(t);

    this.shotInput = t && s.metrics
      ? {
          track: t, metrics: s.metrics, pit: pitLane, height: (x, y) => earth.height(x, y),
          // The deepest run-off of the corner there, so the camera stands beyond all of it.
          runoff: (k, side) => Math.max(0, ...areas.filter((r) => r.side === side && r.stations.includes(k)).map((r) => Math.max(...r.depth))),
        }
      : null;
    this.updateShots();

    this.controls.maxDistance = hm.extent * 2.5;
    if (!this.fitted) this.fit();
    this.requestRender();
  }

  /** Where trees could grow, kept per terrain: it depends only on the heightmap and the seed. */
  private forestFor(hm: NonNullable<Store['terrain']>['heightmap']): Float32Array {
    const seed = this.store.project.terrain.seed;
    if (this.forestCache?.hm !== hm || this.forestCache.seed !== seed) this.forestCache = { hm, seed, data: forest(hm, seed) };
    return this.forestCache.data;
  }

  /** Trees as two instanced meshes (conifers and broadleaves), sized and turned per tree; not stretched by the height exaggeration. */
  private buildTrees(): void {
    this.remove('conifers');
    this.remove('broadleaves');
    const trees = this.trees;
    if (!trees || !trees.count) return;
    const counts = [0, 0];
    for (let i = 0; i < trees.count; i++) counts[trees.data[i * 5 + 4]]++;
    const meshes = [0, 1].map((kind) => {
      const mesh = new THREE.InstancedMesh(this.treeShapes[kind], this.treeMaterial, Math.max(1, counts[kind]));
      mesh.count = counts[kind];
      mesh.frustumCulled = false;
      return mesh;
    });
    const filled = [0, 0];
    const color = new THREE.Color();
    const relief = this.store.view.relief;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < trees.count; i++) {
      const d = trees.data;
      const kind = d[i * 5 + 4];
      const size = d[i * 5 + 3];
      const turn = ((i * 2654435761) % 1000) / 1000;
      q.setFromAxisAngle(axis, turn * Math.PI * 2);
      m.compose(new THREE.Vector3(d[i * 5], d[i * 5 + 1], d[i * 5 + 2]), q, new THREE.Vector3(size, size / relief, size));
      const mesh = meshes[kind];
      mesh.setMatrixAt(filled[kind], m);
      // Slightly different greens, darker for conifers.
      const shade = 0.85 + 0.3 * (((i * 40503) % 997) / 997);
      if (kind === 0) color.setRGB(0.13 * shade, 0.27 * shade, 0.15 * shade, THREE.SRGBColorSpace);
      else color.setRGB(0.3 * shade, 0.45 * shade, 0.18 * shade, THREE.SRGBColorSpace);
      mesh.setColorAt(filled[kind], color);
      filled[kind]++;
    }
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.add('conifers', meshes[0]);
    this.add('broadleaves', meshes[1]);
  }

  /**
   * The roads round the track shown: the stretches of the full circuit a
   * layout shown skips (each from the station where its link leaves to the
   * one where it joins), and the links of the other layouts.
   */
  private roundRoads(): Road[] {
    const s = this.store;
    const shown = s.shownLayout;
    const out: Road[] = [];
    const full = s.fullTrack;
    if (shown !== 0 && full) {
      for (const l of s.layoutStates[shown - 1]?.build.links ?? []) {
        const count = ((l.to - l.from + full.n) % full.n) + 1;
        const pick = (src: Float64Array, f = 1) => Float64Array.from({ length: count }, (_, i) => src[(l.from + i) % full.n] * f);
        out.push({ x: pick(full.x), y: pick(full.y), z: pick(full.z), half: pick(full.width, 0.5), closed: false });
      }
    }
    s.layoutStates.forEach((state, i) => {
      if (i + 1 === shown) return;
      for (const l of state.build.links) out.push({ x: l.x, y: l.y, z: l.z, half: Float64Array.from(l.width, (w) => w / 2), closed: false });
    });
    return out;
  }

  private buildRoads(t: Track | null, pit: Road | null): void {
    this.remove('track');
    this.remove('trackVerges');
    this.remove('pit');
    this.remove('pitVerges');
    this.remove('otherRoads');
    this.remove('otherVerges');
    this.remove('start');
    if (!t) return;
    if (this.otherRoads.length) {
      // Under the track where they share it.
      const other = buildRoads(this.otherRoads.map((road) => ({ road, style: { surface: COLORS.asphalt, lines: true } })));
      this.add('otherRoads', new THREE.Mesh(geometry(other.paved), this.surfaceMaterial(-2)));
      this.add('otherVerges', new THREE.Mesh(geometry(other.verges), this.surfaceMaterial(-1, 0.15)));
    }
    const main = buildRoads([{ road: trackRoad(t), style: { surface: this.surfaceColors(t), lines: true } }]);
    // The track wins over the pit lane where they meet, and both over the verges.
    const paved = geometry(main.paved);
    paved.setAttribute('wetLine', this.wetLine(t, paved));
    this.add('track', new THREE.Mesh(paved, this.surfaceMaterial(-3, 1, true)));
    this.add('trackVerges', new THREE.Mesh(geometry(main.verges), this.surfaceMaterial(-1, 0.15)));
    if (pit) {
      const lane = buildRoads([{ road: pit, style: { surface: COLORS.pitAsphalt, lines: false } }]);
      this.add('pit', new THREE.Mesh(geometry(lane.paved), this.surfaceMaterial(-2)));
      this.add('pitVerges', new THREE.Mesh(geometry(lane.verges), this.surfaceMaterial(-1, 0.15)));
    }
    this.add('start', new THREE.Mesh(geometry(startLine(t)), this.surfaceMaterial(-4)));
  }

  /**
   * Per vertex of the track surface: metres from the racing line and from
   * the nearer edge, for the wet track (the racing line dries first, water
   * stands near the edges). Without a racing line, all of it is off-line.
   */
  private wetLine(t: Track, g: THREE.BufferGeometry): THREE.BufferAttribute {
    const s = this.store;
    const line = s.performanceCurrent ? s.performance?.line : null;
    const pos = g.getAttribute('position');
    const out = new Float32Array(pos.count * 2);
    const index = new TrackIndex(t);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getZ(i);
      const near = index.nearest(x, y, 40);
      if (!near) {
        out[i * 2] = 99;
        continue;
      }
      const lat = index.lateral(near.k, x, y);
      out[i * 2] = line && line.n === t.n ? Math.abs(lat - line.offset[near.k]) : 99;
      out[i * 2 + 1] = Math.max(0, t.width[near.k] / 2 - Math.abs(lat));
    }
    return new THREE.BufferAttribute(out, 2);
  }

  /** Stands the marshals at the posts, on the drawn ground. */
  private placeMarshals(): void {
    this.flags.setSites(this.postSites, this.lineSite, (z) => (z - this.zRef) * this.store.view.relief);
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
    anchor(geo, Float32Array.from(t.z));
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
      this.labels.push({ el, text, cls, p: new THREE.Vector3(t.x[k], t.z[k] + LABEL_LIFT / this.store.view.relief, t.y[k]), base: t.z[k], shown: false });
    };
    at(0, 'Start', 'start');
    for (const c of m?.corners ?? []) at(c.apex, `T${c.number}`);
  }

  private add(key: string, obj: THREE.Object3D): void {
    this.remove(key);
    this.meshes.set(key, obj);
    this.world.add(obj);
    obj.receiveShadow = SHADOW_RECEIVERS.has(key);
    obj.castShadow = key === 'pitBuilding' || key === 'stands';
    reanchor(obj, this.store.view.relief);
  }

  private remove(key: string): void {
    const obj = this.meshes.get(key);
    if (!obj) return;
    this.world.remove(obj);
    this.meshes.delete(key);
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh instanceof THREE.InstancedMesh) {
        mesh.dispose();
        return;
      }
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      if (mat && mat !== this.terrainMaterial && mat !== this.treeMaterial) mat.dispose();
    });
  }

  private applyRelief(): void {
    const r = this.store.view.relief;
    const changed = this.world.scale.y !== r;
    this.world.scale.set(1, r, 1);
    this.world.position.set(0, -this.zRef * r, 0);
    this.world.updateMatrixWorld(true);
    if (!changed) return;
    // Trees, buildings, kerbs, the racing line, labels and camera heights over the ground keep their real size.
    if (this.trees) this.buildTrees();
    for (const obj of this.meshes.values()) reanchor(obj, r);
    for (const l of this.labels) l.p.y = l.base + LABEL_LIFT / r;
    this.placeMarshals();
    this.updateShots();
    // The broadcast's cameras stand on the drawn ground: set them up again.
    if (this.tv) {
      this.stopTv();
      this.startTv();
    }
  }

  // ---- broadcast ------------------------------------------------------------------

  private toggleTv(): void {
    if (this.tv) this.stopTv();
    else this.startTv();
  }

  /** Hands the camera to the broadcast director. */
  private startTv(): void {
    const r = this.race;
    const input = this.shotInput;
    const t = this.store.track;
    if (!r?.sim || !this.raceActive || !input || !t || !this.earth) return;
    if (this.path) this.stopPath();
    this.glide = null;
    const relief = this.store.view.relief;
    if (!this.tvCams || this.tvCams.input !== input || this.tvCams.relief !== relief) {
      this.tvCams = { input, relief, cams: tvCameras({ ...input, display: this.drawn }) };
    }
    const earth = this.earth;
    this.tv = new TvBroadcast({
      camera: this.camera,
      overlay: this.el,
      car: (id) => {
        const s = this.cars?.shown.find((c) => c.id === id);
        if (!s) return null;
        const m = s.matrix.elements;
        return { position: s.position, heading: Math.atan2(m[2], m[0]), length: s.look.set.model.length };
      },
      fromDrawn: (p) => this.fromDrawn(p),
      groundY: (x, z) => {
        const local = this.world.worldToLocal(new THREE.Vector3(x, 0, z));
        if (local.x < 0 || local.z < 0 || local.x > this.extent || local.z > this.extent) return null;
        return (earth.height(local.x, local.z) - this.zRef) * this.store.view.relief;
      },
      size: () => {
        // The timing tower covers the left of the map.
        const tower = this.el.parentElement?.querySelector<HTMLElement>('.tower');
        const covered = tower && !tower.hidden ? Math.min(tower.offsetLeft + tower.offsetWidth + 8, this.width * 0.6) : 0;
        return { width: this.width, height: this.height, covered };
      },
    }, r, this.tvCams.cams, t.n, t.ds);
    this.controls.enabled = false;
    this.marker.visible = false;
    this.player.hidden = false;
    this.player.classList.add('tv-mode');
    this.tvButton.classList.add('on');
    this.lastStep = 0;
    this.requestRender();
  }

  /** Back to the orbit camera, looking where the broadcast looked. */
  private stopTv(): void {
    const tv = this.tv;
    if (!tv) return;
    this.tv = null;
    tv.dispose();
    this.camera.clearViewOffset();
    this.camera.fov = FOV;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(tv.focus);
    this.controls.enabled = true;
    this.controls.update();
    this.player.hidden = true;
    this.player.classList.remove('tv-mode');
    this.tvButton.classList.remove('on');
    this.requestRender();
  }

  /** The shots for the current height exaggeration. */
  private updateShots(): void {
    this.shots = this.shotInput ? trackShots({ ...this.shotInput, display: this.drawn }) : [];
    this.updateShotMenu();
  }

  /** A real height as the view draws it: exaggerated around the lowest point of the map. */
  private readonly drawn = (z: number): number => this.zRef + (z - this.zRef) * this.store.view.relief;

  /** A model point (x east, height, y south) in scene coordinates. */
  private toScene(x: number, z: number, y: number): THREE.Vector3 {
    return this.world.localToWorld(new THREE.Vector3(x, z, y));
  }

  /** A point from core (x east, y south, z up), its height as drawn (see `drawn`), in scene coordinates. */
  private fromDrawn(p: Vec3): THREE.Vector3 {
    return this.toScene(p[0], this.zRef + (p[2] - this.zRef) / this.store.view.relief, p[1]);
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
    // The view's clock runs while the race plays.
    const now = performance.now();
    if (this.race?.playing && this.raceActive && this.lastClock) this.clock += Math.min(0.1, (now - this.lastClock) / 1000);
    this.lastClock = now;
    this.updateCars();
    if (this.needsRoads) {
      this.needsRoads = false;
      const t = this.store.track;
      const pit = t && this.store.performanceCurrent && this.store.facilities?.pitLane ? pitRoad(this.store.facilities.pitLane, t) : null;
      if (this.earth) this.buildRoads(t, pit);
      const line = this.meshes.get('line');
      if (line) line.visible = this.store.view.line;
    }
    let moving = this.stepCamera();
    if (!this.path && !this.tv) {
      moving = this.controls.update() || moving;
      this.keepAboveGround();
    }
    // Depth precision: the near plane follows the distance to what the camera looks at (the broadcast sets its own).
    const d = this.tv ? this.camera.position.distanceTo(this.tv.focus) : this.path ? 60 : this.camera.position.distanceTo(this.controls.target);
    if (!this.tv) this.camera.near = Math.max(0.1, Math.min(20, d / 800));
    this.camera.far = d * 4 + this.extent * 3;
    this.camera.updateProjectionMatrix();
    this.updateMarker(d);
    if (this.sun.castShadow) {
      // The sun's shadows cover a patch round what the camera looks at.
      const focus = this.tv ? this.tv.focus.clone() : this.path ? this.camera.position.clone().add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(40)) : this.controls.target.clone();
      this.sun.target.position.copy(focus);
      this.sun.position.copy(focus).addScaledVector(SUN, 600);
      this.sun.target.updateMatrixWorld();
    }
    this.updateWeather(d);
    this.updateFlags();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    if (this.pendingPointer) {
      this.hoverAt(this.pendingPointer.x, this.pendingPointer.y);
      this.pendingPointer = null;
    }
    if (moving) this.requestRender();
  }

  /** The race's weather (fine outside a race), for a camera looking at a point `focus` metres away. */
  private updateWeather(focus: number): void {
    const r = this.race;
    const sim = this.raceActive && this.earth ? r?.sim : null;
    let state: WeatherState = FINE;
    if (r && sim) {
      const t = sim.t - DT * (1 - r.alpha);
      state = {
        rain: sim.rain, wetness: sim.wetness, lineWetness: lineWetness(sim.wetness, sim.rain), puddles: standingWater(sim.wetness),
        cloud: cloudCover(sim.setup.weather, t), raceTime: t, clock: this.clock,
      };
    }
    this.weather.apply(state, this.camera, focus, sim ? this.cars : null, this.extent);
    this.terrainUniforms.uWetGround.value = state.wetness;
    // The wet surfaces mirror the sky of the moment.
    const env = this.weather.envMap;
    for (const obj of this.meshes.values()) {
      const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (mat?.userData?.wet && mat.envMap !== env) mat.envMap = env;
    }
  }

  /** The marshals' flags, boards and light panels, during a race. */
  private updateFlags(): void {
    const r = this.race;
    const sim = this.raceActive ? r?.sim : null;
    this.flags.group.visible = !!sim && this.postSites.length > 0;
    if (!r || !sim || !this.flags.group.visible) return;
    const state = flagState(sim, r.alpha);
    this.flags.update(postSignals(state, this.postSites), lineFlag(state), this.clock);
  }

  /** Places the race's cars (or hides them when no race is shown), and keeps a followed car in view. */
  private updateCars(): void {
    const r = this.race;
    const active = this.raceActive && !!this.earth;
    if (!active || !r?.sim) {
      if (this.cars) this.cars.group.visible = false;
      this.sun.castShadow = false;
      return;
    }
    if (!this.cars) {
      this.cars = new CarLayer(this.weather.envMap);
      this.scene.add(this.cars.group);
    }
    this.cars.group.visible = true;
    this.sun.castShadow = true;
    const relief = this.store.view.relief;
    this.cars.update(r.sim, r.alpha, {
      earth: this.earth!,
      sceneY: (z) => (z - this.zRef) * relief,
      pitSide: this.store.facilities?.pitLane?.side ?? 1,
      rain: r.sim.rain,
      wetness: r.sim.wetness,
      clock: this.clock,
    }, this.camera, this.height);
    if (r.follow && r.selected !== null && !this.path && !this.tv) {
      const p = this.cars.positionOf(r.selected);
      if (p) {
        const delta = p.clone().sub(this.controls.target);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
  }

  private pickCar(clientX: number, clientY: number): void {
    const r = this.race;
    if (!this.raceActive || !r || !this.cars) return;
    const rect = this.canvas.getBoundingClientRect();
    const id = this.cars.pick(clientX - rect.left, clientY - rect.top, this.camera, this.width, this.height);
    if (id !== null) r.select(id, true);
    else if (r.selected !== null && !r.follow) r.select(null);
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
    this.marker.visible = !!t && k !== null && k < t.n && !this.path;
    if (!this.marker.visible || !t || k === null) return;
    this.marker.position.copy(this.toScene(t.x[k], t.z[k], t.y[k]));
    // Roughly the same size on screen at any distance.
    const scale = Math.max(1, Math.min(60, dist / 120));
    this.marker.scale.setScalar(scale);
  }

  /** A model point on screen in CSS pixels, or null behind the camera or off screen. */
  private project(p: THREE.Vector3, v: THREE.Vector3): { x: number; y: number } | null {
    v.copy(p);
    this.world.localToWorld(v);
    v.project(this.camera);
    if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) return null;
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  private updateLabels(): void {
    // A broadcast has its own graphics.
    const show = this.store.view.labels && !this.tv;
    this.labelLayer.hidden = !show;
    if (!show) return;
    const v = new THREE.Vector3();
    const eye = this.world.worldToLocal(this.camera.position.clone());
    for (const l of this.labels) {
      const p = this.project(l.p, v);
      // Hidden behind a hill: the ground rises above the line from the camera to the label.
      l.shown = !!p && !this.blocked(eye, l.p);
      l.el.hidden = !l.shown;
      if (!l.shown || !p) continue;
      l.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    this.updateCarLabels(eye);
  }

  /** Driver codes over the selected car and the cars nearest the camera. */
  private updateCarLabels(eye: THREE.Vector3): void {
    const r = this.race;
    const cars = this.cars;
    const wanted = new Map<number, { text: string; p: THREE.Vector3 }>();
    if (cars && this.raceActive && r?.sim && cars.group.visible) {
      const sim = r.sim;
      const near = cars.shown
        .map((s) => ({ s, d: s.position.distanceTo(this.camera.position) }))
        .filter(({ s, d }) => s.id === r.selected || d < CAR_LABEL_REACH)
        .sort((a, b) => a.d - b.d)
        .slice(0, CAR_LABELS);
      for (const { s } of near) {
        const car = s.id >= 0 ? sim.cars[s.id] : null;
        if (car && car.status === 'retired') continue;
        const text = car ? `${car.position} ${car.entrant.code}` : 'SC';
        wanted.set(s.id, { text, p: s.position.clone().add(new THREE.Vector3(0, s.look.set.model.height / 2 + 0.6, 0)) });
      }
    }
    for (const [id, l] of this.carLabels) {
      if (!wanted.has(id)) {
        l.el.remove();
        this.carLabels.delete(id);
      }
    }
    const v = new THREE.Vector3();
    for (const [id, w] of wanted) {
      let l = this.carLabels.get(id);
      if (!l) {
        l = { el: h('div', { class: `map3d-label car${id === this.race?.selected ? ' selected' : ''}` }), text: '', p: w.p, shown: false };
        this.labelLayer.append(l.el);
        this.carLabels.set(id, l);
      }
      l.el.classList.toggle('selected', id === this.race?.selected);
      if (l.text !== w.text) {
        l.text = w.text;
        setText(l.el, w.text);
      }
      l.p = w.p;
      v.copy(w.p).project(this.camera);
      const visible = v.z <= 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 && !this.blocked(eye, this.world.worldToLocal(w.p.clone()));
      l.shown = visible;
      l.el.hidden = !visible;
      if (visible) l.el.style.transform = `translate(${(((v.x + 1) / 2) * this.width).toFixed(1)}px, ${(((1 - v.y) / 2) * this.height).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  /** Whether the ground blocks the line between two model points. */
  private blocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (let i = 1; i < 32; i++) {
      const f = i / 32;
      if (f > 0.95) break;
      const x = a.x + (b.x - a.x) * f;
      const y = a.z + (b.z - a.z) * f;
      const g = this.ground(x, y);
      if (g !== null && g > a.y + (b.y - a.y) * f + 1) return true;
    }
    return false;
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
    if (this.path) return;
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
    const to = this.world.localToWorld(p.clone());
    const shift = to.clone().sub(this.controls.target);
    this.glide = {
      start: performance.now(), seconds: 0.6,
      fromCam: this.camera.position.clone(), fromTarget: this.controls.target.clone(),
      toCam: this.camera.position.clone().add(shift), toTarget: to,
    };
    this.requestRender();
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
  if (m.anchors) anchor(g, m.anchors);
  g.computeBoundingSphere();
  return g;
}

interface Anchored {
  /** Each vertex's height as built, the height it stands on, and the exaggeration its positions are set for. */
  heights: Float32Array;
  anchors: Float32Array;
  relief: number;
}

/** Marks a geometry whose vertices keep their real height above their anchors (see MeshData.anchors). */
function anchor(g: THREE.BufferGeometry, anchors: Float32Array): void {
  const positions = g.getAttribute('position').array;
  const heights = new Float32Array(anchors.length);
  for (let i = 0; i < heights.length; i++) heights[i] = positions[i * 3 + 1];
  const anchored: Anchored = { heights, anchors, relief: 1 };
  g.userData.anchored = anchored;
}

/** Sets a model's anchored vertices for a height exaggeration, undoing it above their anchors. */
function reanchor(obj: THREE.Object3D, relief: number): void {
  obj.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const a = g?.userData.anchored as Anchored | undefined;
    if (!g || !a || a.relief === relief) return;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < a.heights.length; i++) pos.array[i * 3 + 1] = anchoredHeight(a.heights[i], a.anchors[i], relief);
    pos.needsUpdate = true;
    g.computeBoundingSphere();
    a.relief = relief;
  });
}

/** Paints a geometry one colour (as vertex colours, linear). */
function painted(g: THREE.BufferGeometry, rgb: readonly number[]): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] = srgbToLinear(rgb[j]);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** A conifer one unit high: a trunk and a cone, the foliage white for the tree's own colour to tint. */
function conifer(): THREE.BufferGeometry {
  const trunk = painted(new THREE.CylinderGeometry(0.035, 0.045, 0.25, 5, 1, true).translate(0, 0.125, 0), [0.55, 0.42, 0.3]);
  const crown = painted(new THREE.ConeGeometry(0.24, 0.86, 7, 1).translate(0, 0.57, 0), [1, 1, 1]);
  return mergeGeometries([trunk.toNonIndexed(), crown.toNonIndexed()])!;
}

/** A broadleaf tree one unit high: a trunk and a rounded crown. */
function broadleaf(): THREE.BufferGeometry {
  const trunk = painted(new THREE.CylinderGeometry(0.04, 0.05, 0.42, 5, 1, true).translate(0, 0.21, 0), [0.55, 0.42, 0.3]);
  const crown = painted(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.85, 1).translate(0, 0.68, 0), [1, 1, 1]);
  return mergeGeometries([trunk.toNonIndexed(), crown.toNonIndexed()])!;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string): number[] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
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
uniform float uWetGround;
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
  // Wet ground is darker.
  c *= 1.0 - 0.2 * uWetGround;
  return pow(c, vec3(2.2));
}
${shader.fragmentShader}`.replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( groundColour(), opacity );');
}
