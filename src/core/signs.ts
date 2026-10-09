/**
 * The signs of the circuit: the words on the advertising boards and the
 * gantries, and the numbers over the garages. They are words from racing,
 * not real companies. All of them are drawn into one picture by the 3D view
 * (ui/signAtlas.ts); the meshes that show them carry texture coordinates
 * into it, built with `PanelBuilder`.
 */
import type { MeshData } from './scene3d.ts';

// ---- the signs ---------------------------------------------------------------------

/** A sign: its word, and the colours of its ground and its letters. */
export interface Sign {
  text: string;
  background: string;
  color: string;
}

/** The signs on the boards: words from racing, in the colours of no one in particular. */
export const SIGNS: readonly Sign[] = [
  { text: 'RACETRACKDESIGN', background: '#14171c', color: '#ffffff' },
  { text: 'GRAND PRIX', background: '#d0021b', color: '#ffffff' },
  { text: 'POLE POSITION', background: '#ffd60a', color: '#14171c' },
  { text: 'FASTEST LAP', background: '#7a17c4', color: '#ffffff' },
  { text: 'APEX', background: '#0a66d8', color: '#ffffff' },
  { text: 'SLIPSTREAM', background: '#f4f4f4', color: '#0a3d91' },
  { text: 'PADDOCK', background: '#0f8a3c', color: '#ffffff' },
  { text: 'FLAT OUT', background: '#ff6a00', color: '#14171c' },
  { text: 'CHICANE', background: '#14171c', color: '#ffd60a' },
  { text: 'GREEN FLAG', background: '#19a84a', color: '#ffffff' },
  { text: 'PIT STOP', background: '#f4f4f4', color: '#d0021b' },
  { text: 'FULL THROTTLE', background: '#1f242b', color: '#ff4a3d' },
  { text: 'HAIRPIN', background: '#00979a', color: '#ffffff' },
  { text: 'LIGHTS OUT', background: '#b3091c', color: '#ffe42b' },
  { text: 'KERB', background: '#f4f4f4', color: '#14171c' },
  { text: 'START · FINISH', background: '#14171c', color: '#f4f4f4' },
];
/** The sign on the start gantry, and the one behind the podium. */
export const START_SIGN = 15;
export const PODIUM_SIGN = 0;

/**
 * The picture all signs are drawn in: ATLAS pixels, the signs in cells of
 * SIGN_CELL four to a row from the top, and under them the numbers 1 to
 * NUMBERS in square cells (for the garages).
 */
export const ATLAS = { width: 2048, height: 1024 };
export const SIGN_CELL = { width: 512, height: 128 };
export const NUMBER_CELL = 128;
export const NUMBERS = 64;
const NUMBERS_TOP = 512;

/** A cell of the atlas in pixels: left, top, width, height. */
export function signCell(sign: number): [number, number, number, number] {
  const i = ((sign % SIGNS.length) + SIGNS.length) % SIGNS.length;
  return [(i % 4) * SIGN_CELL.width, Math.floor(i / 4) * SIGN_CELL.height, SIGN_CELL.width, SIGN_CELL.height];
}

export function numberCell(n: number): [number, number, number, number] {
  const i = Math.max(1, Math.min(NUMBERS, Math.round(n))) - 1;
  return [(i % 16) * NUMBER_CELL, NUMBERS_TOP + Math.floor(i / 16) * NUMBER_CELL, NUMBER_CELL, NUMBER_CELL];
}

/** Texture coordinates of a cell (u right, v up, the picture's top at v = 1): left, bottom, right, top, a little inside its edge. */
export function cellUv(cell: readonly [number, number, number, number], inset = 2): [number, number, number, number] {
  const [x, y, w, h] = cell;
  return [(x + inset) / ATLAS.width, 1 - (y + h - inset) / ATLAS.height, (x + w - inset) / ATLAS.width, 1 - (y + inset) / ATLAS.height];
}

/** Grows a textured mesh: flat faces with texture coordinates, each vertex anchored to its floor. */
export class PanelBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private anc: number[] = [];
  private idx: number[] = [];

  /**
   * A face from four corners (x, height, z, floor) in order round it, seen
   * from the side `normal` points to: the first corner bottom left, then
   * bottom right, top right and top left of the picture in `uv` (left,
   * bottom, right, top).
   */
  face(corners: readonly (readonly [number, number, number, number])[], normal: readonly [number, number, number], uv: readonly [number, number, number, number]): void {
    const first = this.pos.length / 3;
    const st = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
    corners.forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(normal[0], normal[1], normal[2]);
      this.uv.push(st[i][0], st[i][1]);
      this.anc.push(Math.min(p[1], p[3]));
    });
    // Anticlockwise seen from the normal's side.
    const [a, b, c] = corners;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const along = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
    if (along >= 0) this.idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
    else this.idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
  }

  build(): MeshData {
    return {
      positions: Float32Array.from(this.pos), normals: Float32Array.from(this.nrm), uvs: Float32Array.from(this.uv),
      indices: Uint32Array.from(this.idx), anchors: Float32Array.from(this.anc),
    };
  }
}
