/**
 * The polar mesh on the CPU: the same ring spacing and height sampling as the
 * vertex shader, so a label can be anchored on the summit as it is drawn
 * rather than on the DEM's sharper one.
 */
import { describe, expect, test } from 'bun:test';
import { destination, latToMercY, localRadius, lonToMercX } from '../../src/engine/core/geodesy';
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

describe('meshTopNear: the summit as the mesh draws it', () => {
  test('a sharp summit far out falls between the rings and is drawn lower than the DEM holds it', () => {
    const { hf, at } = field([{ range: 10000, bearing: 90 }]);
    const p = radialParams(QUALITY_LOW, hf);
    const top = meshTopNear(hf, p, at[0].lon, at[0].lat, EYE);
    expect(top).toBeLessThan(PLAIN + SPIKE - 100);
    expect(top).toBeGreaterThanOrEqual(PLAIN);
  });

  test('close by, where the rings are a post apart, the mesh reaches the summit', () => {
    const { hf, at } = field([{ range: 900, bearing: 90 }]);
    const p = radialParams(QUALITY_LOW, hf);
    expect(meshTopNear(hf, p, at[0].lon, at[0].lat, EYE)).toBeGreaterThan(PLAIN + SPIKE * 0.4);
  });

  test('what counts is the silhouette: a vertex just in front of the summit, as high, stands higher on screen', () => {
    // A plateau at 1900 m from 4960 m to 5040 m out, the summit point in its
    // middle: the vertices nearest the viewer rise steepest, and the height
    // they stand for at the summit's range is above 1900 m.
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
    expect(meshTopNear(hf, radialParams(QUALITY_LOW, hf), mid.lon, mid.lat, EYE)).toBeGreaterThan(1900.5);
  });

  test('never above the DEM', () => {
    const { hf, at } = field([{ range: 900, bearing: 90 }, { range: 6000, bearing: 200 }]);
    for (const q of [QUALITY_HIGH, QUALITY_LOW]) {
      const p = radialParams(q, hf);
      for (const a of at) expect(meshTopNear(hf, p, a.lon, a.lat, EYE)).toBeLessThanOrEqual(PLAIN + SPIKE);
    }
  });
});
