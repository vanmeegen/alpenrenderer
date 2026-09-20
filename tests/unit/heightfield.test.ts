import { describe, expect, test } from 'bun:test';
import { latToMercY, lonToMercX } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';

const LON = 10.0, LAT = 47.0;

/** One 64-px level at pixel zoom `z` centred on the origin, heights from f(px, py). */
function level(hf: HeightField, z: number, f: (px: number, py: number) => number, filled = true) {
  const w = 64, h = 64;
  const px0 = Math.round(lonToMercX(LON, z)) - w / 2;
  const py0 = Math.round(latToMercY(LAT, z)) - h / 2;
  const raw = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = f(px0 + x, py0 + y) + 1000;
  return hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, filled);
}

describe('HeightField', () => {
  test('a flat level reads back its height anywhere inside, NaN outside', () => {
    const hf = new HeightField(LON, LAT);
    const l = level(hf, 12, () => 2000);
    expect(hf.heightIn(l, LON, LAT)).toBe(2000);
    expect(hf.height(LON, LAT)).toBe(2000);
    expect(hf.heightIn(l, LON + 1, LAT)).toBeNaN();
  });

  test('bilinear sampling interpolates between posts', () => {
    const hf = new HeightField(LON, LAT);
    const z = 12;
    const l = level(hf, z, (px) => px % 2 === 0 ? 1000 : 1200);
    // Halfway between two posts lies exactly between their heights.
    const u = hf.project(l, LON, LAT).u;
    // At a pixel *centre* (u = i + 0.5) the sample is that post's own height;
    // half a pixel on it is the mean of two neighbouring posts.
    const i = Math.floor(u);
    const centre = i + 0.5;
    const lonAt = (uu: number) => LON + ((uu - u) / (256 * 2 ** z)) * 360;
    const own = (l.px0 + i) % 2 === 0 ? 1000 : 1200;
    expect(hf.heightIn(l, lonAt(centre), LAT)).toBeCloseTo(own, 5);
    expect(hf.heightIn(l, lonAt(centre + 0.5), LAT)).toBeCloseTo(1100, 5);
  });

  test('an unfilled level is skipped, not sampled as -1000 m', () => {
    const hf = new HeightField(LON, LAT);
    level(hf, 12, () => 0, false);      // allocated, empty: would read as -1000
    level(hf, 10, () => 1800);
    expect(hf.height(LON, LAT)).toBe(1800);
  });

  test('the finest level covering the range wins', () => {
    const hf = new HeightField(LON, LAT);
    level(hf, 12, () => 1500);
    level(hf, 8, () => 1900);
    expect(hf.height(LON, LAT, 0)).toBe(1500);
    // Far beyond the fine level's reach only the coarse one is authoritative.
    expect(hf.height(LON, LAT, 1e6)).toBe(1900);
  });

  test('summitNear returns the local maximum, not the interpolated height', () => {
    const hf = new HeightField(LON, LAT);
    const z = 13;
    const cx = Math.round(lonToMercX(LON, z)), cy = Math.round(latToMercY(LAT, z));
    // A single 3000 m post two pixels east of the origin in a 2000 m plain.
    level(hf, z, (px, py) => (px === cx + 2 && py === cy) ? 3000 : 2000);
    expect(hf.groundAt(LON, LAT)).toBeCloseTo(2000, 3);
    expect(hf.summitNear(LON, LAT, 100)).toBe(3000);
    // A radius too small to reach it stays on the plain.
    expect(hf.summitNear(LON, LAT, 5)).toBe(2000);
  });
});
