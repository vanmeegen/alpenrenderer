import { describe, expect, test } from 'bun:test';
import { latToMercY, lonToMercX, mercXToLon, mercYToLat } from '../../src/engine/core/geodesy';
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

  test('summitAt says where the highest post is, not only how high: its centre, or the point itself when already on it', () => {
    const hf = new HeightField(LON, LAT);
    const z = 13;
    const cx = Math.round(lonToMercX(LON, z)), cy = Math.round(latToMercY(LAT, z));
    level(hf, z, (px, py) => (px === cx + 2 && py === cy - 1) ? 3000 : 2000);
    const s = hf.summitAt(LON, LAT, 100);
    expect(s.h).toBe(3000);
    expect(s.lon).toBeCloseTo(mercXToLon(cx + 2 + 0.5, z), 9);
    expect(s.lat).toBeCloseTo(mercYToLat(cy - 1 + 0.5, z), 9);
    // Already on the highest post: not moved at all.
    const flat = new HeightField(LON, LAT);
    level(flat, z, () => 2000);
    expect(flat.summitAt(LON, LAT, 100)).toEqual({ lon: LON, lat: LAT, h: 2000 });
    // Out of reach, the point itself with the height there.
    const near = hf.summitAt(LON, LAT, 5);
    expect(near.h).toBe(2000);
  });

  test('summitAt on a slope with no top in reach stays at the point, at the height there', () => {
    // Rising 1 m a post to the east: the highest post within reach is on the
    // rim, and further out it only climbs on. A shoulder, not a summit: the
    // pin stays on the catalogue point instead of walking up the slope.
    const hf = new HeightField(LON, LAT);
    const z = 13;
    const cx = Math.round(lonToMercX(LON, z));
    level(hf, z, (px) => 2000 + (px - cx));
    const s = hf.summitAt(LON, LAT, 100);
    expect(s.lon).toBe(LON);
    expect(s.lat).toBe(LAT);
    expect(s.h).toBeCloseTo(hf.heightIn(hf.levels[0], LON, LAT), 6);
  });

  test('summitAt finds the nearest local maximum: a bump on a slope, even where the slope climbs higher further out', () => {
    // Rising 1 m a post to the east, with a 3 m bump three posts east of the
    // point. The highest post in reach is on the rim, up the slope; the
    // summit is the bump: the nearest post at least as high as its eight
    // neighbours.
    const hf = new HeightField(LON, LAT);
    const z = 13;
    const cx = Math.round(lonToMercX(LON, z)), cy = Math.round(latToMercY(LAT, z));
    level(hf, z, (px, py) => 2000 + (px - cx) + (px === cx + 3 && py === cy ? 3 : 0));
    const s = hf.summitAt(LON, LAT, 100);
    expect(s.h).toBe(2006);
    expect(s.lon).toBeCloseTo(mercXToLon(cx + 3 + 0.5, z), 9);
    expect(s.lat).toBeCloseTo(mercYToLat(cy + 0.5, z), 9);
  });

  test('summitNear searches a disc: a post in the corner of the square is out of range', () => {
    const hf = new HeightField(LON, LAT);
    const z = 13;
    const cx = Math.round(lonToMercX(LON, z)), cy = Math.round(latToMercY(LAT, z));
    // 10 px east and 10 px south: 10 px in each axis, 14.1 px away.
    level(hf, z, (px, py) => (px === cx + 10 && py === cy + 10) ? 3000 : 2000);
    const res = hf.levels[0].res;
    expect(hf.summitNear(LON, LAT, 11 * res)).toBe(2000);
    expect(hf.summitNear(LON, LAT, 15 * res)).toBe(3000);
  });

  test('a look level (the telescope\'s window) is drawn but never read on the CPU: height, ground, summits and the range come from the eye levels', () => {
    const hf = new HeightField(LON, LAT);
    const z = 10;
    const cx = Math.round(lonToMercX(LON, z)), cy = Math.round(latToMercY(LAT, z));
    level(hf, z, () => 2000);
    const w = 64, h = 64;
    const px0 = Math.round(lonToMercX(LON, 13)) - w / 2, py0 = Math.round(latToMercY(LAT, 13)) - h / 2;
    hf.addLevel({ z: 13, px0, py0, w, h, quant: 1, bias: -1000, role: 'look' }, new Uint16Array(w * h).fill(3000 + 1000), true);
    expect(hf.levels.length).toBe(2);
    expect(hf.eyeLevels().length).toBe(1);
    expect(hf.height(LON, LAT)).toBe(2000);
    expect(hf.groundAt(LON, LAT)).toBe(2000);
    expect(hf.summitNear(LON, LAT, 100)).toBe(2000);
    expect(hf.maxRange).toBe(hf.eyeLevels()[0].maxRange);
    void cx; void cy;
  });

  test('the label anchor follows the telescope\'s window: summitAt searches the look level where it holds the point, as drawn', () => {
    // The GPU draws the window's posts (lookAt); a pin whose summit was
    // searched on the coarser eye level lands a post or two off the drawn
    // apex, at 5° of view a few pixels beside it.
    const hf = new HeightField(LON, LAT);
    level(hf, 10, () => 2000);
    const w = 64, h = 64, z = 13;
    const px0 = Math.round(lonToMercX(LON, z)) - w / 2, py0 = Math.round(latToMercY(LAT, z)) - h / 2;
    const raw = new Uint16Array(w * h).fill(3000 + 1000);
    const cx = Math.floor(lonToMercX(LON, z) - px0), cy = Math.floor(latToMercY(LAT, z) - py0);
    raw[cy * w + cx + 5] = 3100 + 1000;                 // a top five posts (~65 m) east of the point
    const look = hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000, role: 'look' }, raw, true);
    const top = hf.summitAt(LON, LAT, 100);
    expect(top.h).toBe(3100);
    const east = (top.lon - LON) * 111320 * Math.cos((LAT * Math.PI) / 180);
    expect(east).toBeGreaterThan(4 * look.res);
    expect(east).toBeLessThan(6 * look.res);
    expect(Math.abs(top.lat - LAT) * 111320).toBeLessThan(look.res);
    // Out of reach of the point, the window's flat ground is no summit: the point stays, at the window's height.
    expect(hf.summitAt(LON, LAT, 30)).toEqual({ lon: LON, lat: LAT, h: 3000 });
    // Summits, ground and the eye's levels are untouched by the window.
    expect(hf.summitNear(LON, LAT, 100)).toBe(2000);
    expect(hf.height(LON, LAT)).toBe(2000);
  });
});
