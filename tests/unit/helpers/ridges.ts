/**
 * Two ridges seen from a hill, for the tests of what a zoomed frame shows
 * (framescan, the ring table): looking east from 300 m above a plain, a
 * ridge 600 m high with its crest 16 km off, and behind it a higher one,
 * 900 m, with its crest 26 km off. Both run north to south, so every ray
 * near east meets the same profile.
 *
 *   east, km:   0 ....... 14 /\ 18 ....... 23 _/\_ 27 ....
 *   crest:                  16 (2100 m)       26 (2400 m)
 */
import { latToMercY, lonToMercX, mercResolution } from '../../../src/engine/core/geodesy';
import { HeightField } from '../../../src/engine/core/heightfield';

export const RIDGES = { lon: 10.0, lat: 47.0, plain: 1500, eye: 1800, near: { at: 16000, top: 2100, foot: 2000 }, far: { at: 26000, top: 2400, foot: 3000 } };

/** Height of the profile at a distance east of the standpoint, metres. */
export function ridgeHeight(east: number): number {
  let h = RIDGES.plain;
  for (const r of [RIDGES.near, RIDGES.far]) {
    const d = Math.abs(east - r.at);
    if (d < r.foot) h = Math.max(h, RIDGES.plain + (r.top - RIDGES.plain) * (1 - d / r.foot));
  }
  return h;
}

export function twoRidges(): { hf: HeightField; eye: number } {
  const { lon, lat } = RIDGES;
  const hf = new HeightField(lon, lat);
  const z = 11, w = 2048, h = 2048;                         // 53 m posts, 54 km to every side
  const px0 = Math.round(lonToMercX(lon, z)) - w / 2, py0 = Math.round(latToMercY(lat, z)) - h / 2;
  const res = mercResolution(lat, z), cx = lonToMercX(lon, z) - px0;
  const raw = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    const v = Math.round(ridgeHeight((x + 0.5 - cx) * res)) + 1000;
    for (let y = 0; y < h; y++) raw[y * w + x] = v;
  }
  hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
  return { hf, eye: RIDGES.eye };
}
