/**
 * The crowd on the grandstands (core/trackside.ts `seatCrowd`): every
 * spectator an instance of one seated figure, a body in the colour they
 * wear and a head, facing the track. Stylised like the rest: two boxes and
 * a ball. They keep their real size whatever the height exaggeration the
 * group is drawn with.
 */
import * as THREE from 'three';
import { anchoredHeight } from '../core/scene3d.ts';
import type { Crowd } from '../core/trackside.ts';

const SKIN = [0xe8c4a0, 0xc99a72, 0x9a6a48, 0x6e4a32, 0xf0d2b6];

/** A seated figure's body: a torso over the legs, which reach forward (towards +z). */
function bodyGeometry(): THREE.BufferGeometry {
  const torso = new THREE.BoxGeometry(0.42, 0.56, 0.24).translate(0, 0.72, -0.06);
  const legs = new THREE.BoxGeometry(0.4, 0.2, 0.46).translate(0, 0.42, 0.14);
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (const part of [torso, legs]) {
    const base = pos.length / 3;
    pos.push(...(part.getAttribute('position').array as Float32Array));
    nrm.push(...(part.getAttribute('normal').array as Float32Array));
    for (const i of part.getIndex()!.array) idx.push(base + i);
    part.dispose();
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export class CrowdLayer {
  readonly group = new THREE.Group();
  private readonly body = bodyGeometry();
  private readonly head = new THREE.SphereGeometry(0.115, 8, 6).translate(0, 1.13, -0.04);
  private readonly bodyMaterial = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  private readonly headMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  private meshes: THREE.InstancedMesh[] = [];

  /** Seats the crowd, for a view that draws heights `relief` times as tall. */
  build(crowd: Crowd | null, relief: number): void {
    this.clear();
    if (!crowd || !crowd.count) return;
    const bodies = new THREE.InstancedMesh(this.body, this.bodyMaterial, crowd.count);
    const heads = new THREE.InstancedMesh(this.head, this.headMaterial, crowd.count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < crowd.count; i++) {
      // A little taller or shorter, each their own (from where they sit, so it is the same every time).
      const tall = 0.9 + 0.2 * (((crowd.positions[i * 3] * 13.7 + crowd.positions[i * 3 + 2] * 7.3) % 1 + 1) % 1);
      p.set(crowd.positions[i * 3], anchoredHeight(crowd.positions[i * 3 + 1], crowd.floors[i], relief), crowd.positions[i * 3 + 2]);
      q.setFromAxisAngle(up, crowd.facing[i]);
      s.set(1, tall / relief, 1);
      m.compose(p, q, s);
      bodies.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      bodies.setColorAt(i, c.setRGB(crowd.colors[i * 3], crowd.colors[i * 3 + 1], crowd.colors[i * 3 + 2], THREE.SRGBColorSpace));
      heads.setColorAt(i, c.setHex(SKIN[i % SKIN.length], THREE.SRGBColorSpace));
    }
    for (const mesh of [bodies, heads]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  clear(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes = [];
  }
}
