/**
 * The polar mesh on the CPU: the same ring spacing and height sampling as the
 * vertex shader, so a label can be anchored on the summit as it is drawn
 * rather than on the DEM's sharper one.
 */
import { describe, expect, test } from 'bun:test';
import { destination, groundRange, latToMercY, localRadius, lonToMercX } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';
import { QUALITY_HIGH, QUALITY_LOW } from '../../src/engine/render/gpu/renderer';
import { meshTopNear, radialParams, radiusAt, rowAt } from '../../src/engine/render/mesh';

const LON = 10.0, LAT = 47.0, PLAIN = 1500, SPIKE = 500, EYE = PLAIN + 1.7;

/** One level at pixel zoom 13 (about 13 m a post), 2048 posts square, flat but for single-post spikes. */
function field(spikes: { range: number; bearing: number }[]) {
  const hf = new HeightField(LON, LAT);
  const z = 13, w = 2048, h = 2048;
  const px0 = Math.round(lonToMercX(LON, z)) - w / 2;
  const py0 = Math.round(latToMercY(LAT, z)) - h / 2;
  const raw = new Uint16Array(w * h).fill(PLAIN + 1000);
  const at = spikes.map((s) => {
    const p = destination(LON, LAT, s.bearing, s.range, localRadius(LAT));
    const x = Math.floor(lonToMercX(p.lon, z) - px0), y = Math.floor(latToMercY(p.lat, z) - py0);
    raw[y * w + x] = PLAIN + SPIKE + 1000;
    return p;
  });
  hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
  return { hf, at };
}

describe('ring spacing', () => {
  test('rowAt inverts radiusAt in all three segments', () => {
    const { hf } = field([]);
    for (const q of [QUALITY_HIGH, QUALITY_LOW]) {
      const p = radialParams(q, hf);
      for (const f of [0.5, p.jNear - 0.5, p.jNear + 3.25, p.jSplit - 1, p.jSplit + 10.5, q.rows - 2]) {
        expect(rowAt(p, radiusAt(p, f))).toBeCloseTo(f, 6);
      }
    }
  });
});

describe('meshTopNear: the summit as the mesh draws it, where and how high', () => {
  test('a sharp summit far out falls between the rings and is drawn lower than the DEM holds it', () => {
    const { hf, at } = field([{ range: 10000, bearing: 90 }]);
    const p = radialParams(QUALITY_LOW, hf);
    const top = meshTopNear(hf, p, at[0].lon, at[0].lat, EYE);
    expect(top.h).toBeLessThan(PLAIN + SPIKE - 100);
    expect(top.h).toBeGreaterThanOrEqual(PLAIN);
  });

  test('close by, where the rings are a post apart, the mesh reaches the summit', () => {
    const { hf, at } = field([{ range: 900, bearing: 90 }]);
    const p = radialParams(QUALITY_LOW, hf);
    const top = meshTopNear(hf, p, at[0].lon, at[0].lat, EYE);
    expect(top.h).toBeGreaterThan(PLAIN + SPIKE * 0.4);
    // And it is found where the summit is: within a ring and a ray of it.
    expect(groundRange(top.lon, top.lat, at[0].lon, at[0].lat)).toBeLessThan(20);
  });

  test('what counts is the silhouette: of vertices as high, the one in front stands highest on screen', () => {
    // A plateau at 1900 m from 4940 m to 5060 m out, the summit point in its
    // middle: the vertex nearest the viewer rises steepest and is the top.
    const hf = new HeightField(LON, LAT);
    const z = 13, w = 2048, h = 2048;
    const px0 = Math.round(lonToMercX(LON, z)) - w / 2;
    const py0 = Math.round(latToMercY(LAT, z)) - h / 2;
    const raw = new Uint16Array(w * h).fill(PLAIN + 1000);
    const near = destination(LON, LAT, 90, 4940, localRadius(LAT)), far = destination(LON, LAT, 90, 5060, localRadius(LAT));
    const x0 = Math.floor(lonToMercX(near.lon, z) - px0), x1 = Math.ceil(lonToMercX(far.lon, z) - px0);
    const yc = Math.floor(latToMercY(LAT, z) - py0);
    for (let y = yc - 20; y <= yc + 20; y++) for (let x = x0; x <= x1; x++) raw[y * w + x] = 1900 + 1000;
    hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
    const mid = destination(LON, LAT, 90, 5000, localRadius(LAT));
    const top = meshTopNear(hf, radialParams(QUALITY_LOW, hf), mid.lon, mid.lat, EYE);
    expect(top.h).toBeCloseTo(1900, 0);
    expect(groundRange(LON, LAT, top.lon, top.lat)).toBeLessThan(5000);
  });

  test('a hill in front of a rising slope keeps its pin on the hill, not on the slope behind', () => {
    // A 30 m bump at 8 km on a plain that, from 8.15 km on, climbs 1 m per
    // metre: the slope behind rises steeper on screen than the bump, but the
    // pin belongs on the bump.
    const hf = new HeightField(LON, LAT);
    const z = 13, w = 2048, h = 2048;
    const px0 = Math.round(lonToMercX(LON, z)) - w / 2;
    const py0 = Math.round(latToMercY(LAT, z)) - h / 2;
    const raw = new Uint16Array(w * h);
    const bump = destination(LON, LAT, 90, 8000, localRadius(LAT));
    const bx = lonToMercX(bump.lon, z) - px0, by = latToMercY(bump.lat, z) - py0;
    const mpp = (156543.03 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z;   // metres a post, about 13
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5 - bx) * mpp, dy = (y + 0.5 - by) * mpp;
        const slope = Math.max(0, dx - 150);                     // metres east of 8.15 km
        const hill = Math.max(0, 30 - Math.hypot(dx, dy) / 3);   // 30 m, 90 m wide
        raw[y * w + x] = Math.round(PLAIN + Math.max(slope, hill)) + 1000;
      }
    }
    hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
    // And a coarse level out to some 200 km, so the rings are spaced as in the app.
    const zc = 6, wc = 256;
    hf.addLevel({ z: zc, px0: Math.round(lonToMercX(LON, zc)) - wc / 2, py0: Math.round(latToMercY(LAT, zc)) - wc / 2, w: wc, h: wc, quant: 1, bias: -1000 },
      new Uint16Array(wc * wc).fill(PLAIN + 1000), true);
    expect(hf.maxRange).toBeGreaterThan(150000);
    for (const q of [QUALITY_HIGH, QUALITY_LOW]) {
      const top = meshTopNear(hf, radialParams(q, hf), bump.lon, bump.lat, EYE);
      expect(groundRange(top.lon, top.lat, bump.lon, bump.lat)).toBeLessThan(200);
      expect(top.h).toBeLessThanOrEqual(PLAIN + 30);
    }
  });

  test('of the cell\'s corners, the one that stands highest on screen, not the one highest above the sea', () => {
    // Ground 400 m above the eye at 5 km, rising on 3.6 % away from it: the
    // far corner of a cell is a few metres higher, but seen from the eye it
    // is lower, and hidden behind the near one. The pin goes on the visible top.
    const hf = new HeightField(LON, LAT);
    const z = 13, w = 2048, h = 2048;
    const px0 = Math.round(lonToMercX(LON, z)) - w / 2;
    const py0 = Math.round(latToMercY(LAT, z)) - h / 2;
    const raw = new Uint16Array(w * h);
    const x5 = lonToMercX(destination(LON, LAT, 90, 5000, localRadius(LAT)).lon, z) - px0;
    const mpp = (156543.03 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = Math.round(1900 + 0.036 * (x + 0.5 - x5) * mpp) + 1000;
    hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
    const zc = 6, wc = 256;
    hf.addLevel({ z: zc, px0: Math.round(lonToMercX(LON, zc)) - wc / 2, py0: Math.round(latToMercY(LAT, zc)) - wc / 2, w: wc, h: wc, quant: 1, bias: -1000 },
      new Uint16Array(wc * wc).fill(1900 + 1000), true);
    const p = radialParams(QUALITY_LOW, hf);
    const at = destination(LON, LAT, 90, 5040, localRadius(LAT));
    const top = meshTopNear(hf, p, at.lon, at.lat, EYE);
    const f = Math.floor(rowAt(p, 5040));
    expect(radiusAt(p, f + 1) - radiusAt(p, f)).toBeGreaterThan(50);          // a cell deep enough to matter
    expect(groundRange(LON, LAT, top.lon, top.lat)).toBeLessThan(5040);      // the near corner
  });

  test('never above the DEM', () => {
    const { hf, at } = field([{ range: 900, bearing: 90 }, { range: 6000, bearing: 200 }]);
    for (const q of [QUALITY_HIGH, QUALITY_LOW]) {
      const p = radialParams(q, hf);
      for (const a of at) expect(meshTopNear(hf, p, a.lon, a.lat, EYE).h).toBeLessThanOrEqual(PLAIN + SPIKE);
    }
  });
});
