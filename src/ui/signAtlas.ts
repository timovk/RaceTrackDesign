/**
 * The picture all signs of the circuit are drawn in (core/signs.ts): the
 * words of the advertising boards, each on its own ground in a cell, and
 * the garage numbers under them. Drawn here on a canvas (no download), in
 * the app's own typeface once that has loaded.
 */
import * as THREE from 'three';
import { ATLAS, NUMBERS, SIGNS, numberCell, signCell } from '../core/signs.ts';

const FONT = '"Titillium Web", Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif';

function draw(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#20242a';
  ctx.fillRect(0, 0, ATLAS.width, ATLAS.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  SIGNS.forEach((sign, i) => {
    const [x, y, w, h] = signCell(i);
    ctx.fillStyle = sign.background;
    ctx.fillRect(x, y, w, h);
    // A thin line inside the edge, as printed boards have.
    ctx.strokeStyle = sign.color;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 9, y + 9, w - 18, h - 18);
    ctx.globalAlpha = 1;
    // The word, as large as fits.
    let size = 84;
    ctx.font = `italic 700 ${size}px ${FONT}`;
    const width = ctx.measureText(sign.text).width;
    if (width > w - 56) size = Math.floor((size * (w - 56)) / width);
    ctx.font = `italic 700 ${size}px ${FONT}`;
    ctx.fillStyle = sign.color;
    ctx.fillText(sign.text, x + w / 2, y + h / 2 + size * 0.04);
  });
  for (let n = 1; n <= NUMBERS; n++) {
    const [x, y, w, h] = numberCell(n);
    ctx.fillStyle = '#14171c';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#f4f4f4';
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 7, y + 7, w - 14, h - 14);
    ctx.font = `italic 700 ${n < 10 ? 92 : 78}px ${FONT}`;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillText(String(n), x + w / 2 - 2, y + h / 2 + 5);
  }
}

/** The signs as a texture; it redraws itself once the typeface is there. */
export function signAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS.width;
  canvas.height = ATLAS.height;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  draw(ctx);
  void document.fonts?.load('italic 700 80px "Titillium Web"').then(() => {
    draw(ctx);
    tex.needsUpdate = true;
  }).catch(() => undefined);
  return tex;
}
