/**
 * The surface of a clipmap level as the shade pass reads it: a normal and
 * an occlusion value for every post, worked out once on the CPU when the
 * level arrives.
 *
 * The shade pass used to take the normal from four height texels at the
 * DEM cell a pixel falls in: one normal per cell, so every post was a facet.
 * Zoomed in, a rock face was a chequerboard of squares, each with its own
 * shade and, near the snow line, its own idea of snow or rock. Interpolating
 * the heights first had been tried and looked soft: the foot of every wall
 * rounded off.
 *
 * So the normal is computed per post (Sobel: the slope over the post's
 * eight neighbours), sharpened (an unsharp mask on the slopes takes back
 * what the Sobel rounds off at a break), and interpolated between posts by
 * the shader. With it comes the occlusion: how far a post lies below or
 * above the ground around it, in units of the slope that would take. Gullies
 * and the feet of walls are darkened, ridges lightened: what a relief
 * shader calls sky view, at the price of a box blur.
 */

export const SURFACE = {
  /** Unsharp mask on the slopes: how much of (slope − blurred slope) is added back. */
  sharpen: 0.5,
  /** Posts each way the ground around a post is averaged over, for the occlusion. */
  radius: 4,
  /** A post this fraction of `radius` posts' worth of 45° slope below its surroundings is fully occluded. */
  gain: 1.2,
  /** How much the occlusion darkens a gully and lightens a ridge in the shade pass (shading.ts). */
  strength: 0.22,
};

let scratch: { n: number; h: Float32Array; gx: Float32Array; gy: Float32Array; row: Float32Array; rowY: Float32Array; mean: Float32Array } | null = null;

/**
 * Fills `out` (w·h·4 bytes) for a level: R, G the east and north components
 * of the unit normal as (c·0.5 + 0.5)·255, B the occlusion (128 neutral, 0
 * in a hole, 255 on a point), A 255. `raw` are the level's heights in steps
 * of `quant` metres, `mpp` the metres between posts.
 */
export function levelSurface(raw: Uint16Array, w: number, h: number, quant: number, mpp: number, out: Uint8Array): void {
  const n = w * h;
  if (!scratch || scratch.n !== n) {
    scratch = { n, h: new Float32Array(n), gx: new Float32Array(n), gy: new Float32Array(n), row: new Float32Array(n), rowY: new Float32Array(n), mean: new Float32Array(n) };
  }
  const { h: H, gx, gy, row, rowY, mean } = scratch;
  for (let i = 0; i < n; i++) H[i] = raw[i] * quant;

  // Slopes, metres per metre, east and north positive (rows run south).
  const k = 1 / (8 * mpp);
  for (let y = 0; y < h; y++) {
    const yn = y > 0 ? y - 1 : 0, ys = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xw = x > 0 ? x - 1 : 0, xe = x < w - 1 ? x + 1 : w - 1;
      const nw = H[yn * w + xw], nn = H[yn * w + x], ne = H[yn * w + xe];
      const ww = H[y * w + xw], ee = H[y * w + xe];
      const sw = H[ys * w + xw], ss = H[ys * w + x], se = H[ys * w + xe];
      gx[y * w + x] = (ne + 2 * ee + se - nw - 2 * ww - sw) * k;
      gy[y * w + x] = (nw + 2 * nn + ne - sw - 2 * ss - se) * k;
    }
  }

  // The ground around each post: a box of (2·radius + 1)² posts, as two running sums.
  const R = SURFACE.radius;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -R; x <= R; x++) sum += H[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      row[y * w + x] = sum;
      sum += H[y * w + Math.min(w - 1, x + R + 1)] - H[y * w + Math.max(0, x - R)];
    }
  }
  const cells = (2 * R + 1) * (2 * R + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -R; y <= R; y++) sum += row[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      mean[y * w + x] = sum / cells;
      sum += row[Math.min(h - 1, y + R + 1) * w + x] - row[Math.max(0, y - R) * w + x];
    }
  }

  // The slopes of the neighbourhood, for the unsharp mask: sums of three along the rows first.
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const l = o + (x > 0 ? x - 1 : 0), r = o + (x < w - 1 ? x + 1 : w - 1);
      row[o + x] = gx[l] + gx[o + x] + gx[r];
      rowY[o + x] = gy[l] + gy[o + x] + gy[r];
    }
  }

  const s = SURFACE.sharpen / 9, reach = SURFACE.gain / (R * mpp);
  for (let y = 0; y < h; y++) {
    const o = y * w, up = (y > 0 ? y - 1 : 0) * w, down = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      // Unsharp mask: the slope, plus a share of what it differs by from its neighbourhood's.
      const sx = gx[i] * (1 + SURFACE.sharpen) - s * (row[up + x] + row[i] + row[down + x]);
      const sy = gy[i] * (1 + SURFACE.sharpen) - s * (rowY[up + x] + rowY[i] + rowY[down + x]);
      const inv = 127.5 / Math.sqrt(sx * sx + sy * sy + 1);
      const occ = 127.5 + 255 * (H[i] - mean[i]) * reach;
      const q = i * 4;
      out[q] = (127.5 - sx * inv + 0.5) | 0;
      out[q + 1] = (127.5 - sy * inv + 0.5) | 0;
      out[q + 2] = occ <= 0 ? 0 : occ >= 255 ? 255 : (occ + 0.5) | 0;
      out[q + 3] = 255;
    }
  }
}

/** A post's normal (east, north, up) and occlusion (0..1) from the packed bytes, as the shader decodes them. */
export function surfaceAt(bytes: Uint8Array, w: number, x: number, y: number): { normal: [number, number, number]; occlusion: number } {
  const o = (y * w + x) * 4;
  const nx = (bytes[o] / 255) * 2 - 1, ny = (bytes[o + 1] / 255) * 2 - 1;
  return { normal: [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))], occlusion: bytes[o + 2] / 255 };
}
