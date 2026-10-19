/**
 * Which summits the terrain hides, and which only seem hidden: a summit the
 * DEM flattens into a couple of posts must not be hidden by its own cell,
 * and a summit a little behind the visible edge of its own wall is seen as
 * that wall. The observer stands on a plain at 1500 m, eye 1.7 m up.
 */
import { describe, expect, test } from 'bun:test';
import { latToMercY, lonToMercX, mercResolution, mercYToLat } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';
import { computeVisibility } from '../../src/engine/core/horizon';
import { buildTargets } from '../../src/engine/core/labels';
import { Peak } from '../../src/engine/core/peaks';

const LON = 10.0, LAT = 47.0, PLAIN = 1500, EYE = PLAIN + 1.7;
const obs = { lon: LON, lat: LAT, ground: EYE, eye: 0 };

/**
 * One level at pixel zoom `z`, `size` posts square around the observer, heights
 * from `f(north, east)` in metres from the observer (post centres).
 */
function field(z: number, size: number, f: (north: number, east: number) => number) {
  const hf = new HeightField(LON, LAT);
  const res = mercResolution(LAT, z);
  const cx = lonToMercX(LON, z), cy = latToMercY(LAT, z);
  const px0 = Math.round(cx) - size / 2, py0 = Math.round(cy) - size / 2;
  const raw = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const north = (cy - (py0 + y + 0.5)) * res, east = (px0 + x + 0.5 - cx) * res;
      raw[y * size + x] = Math.round(f(north, east)) + 1000;
    }
  }
  hf.addLevel({ z, px0, py0, w: size, h: size, quant: 1, bias: -1000 }, raw, true);
  /** Latitude of the post row `k` rows north of the observer's row. */
  const rowLat = (k: number) => mercYToLat(Math.floor(cy) - k + 0.5, z);
  return { hf, res, rowLat };
}

describe('a summit the grid flattens', () => {
  // The Gschöllkopf from the Mauritzalm, 367 m away and 28° up: with 13 m
  // posts its top is two posts of 1697 and 1695 m. The march used to end
  // 1.5 % of the range before the anchor, 5.5 m here, inside the summit's
  // own cell, where a point 6 m nearer at nearly the same height stands
  // 0.6° "higher" than the anchor. The march must stop two posts short.
  test('a near summit whose top the grid flattens into two posts is visible, pin on the summit', () => {
    const z = 13;
    const resZ = mercResolution(LAT, z);
    const kTop = Math.round(367 / resZ);
    const { hf, res, rowLat } = field(z, 64, (north, east) => {
      const k = Math.round(north / resZ);
      if (Math.abs(east) > 3.5 * resZ) return PLAIN;
      if (k === kTop) return 1697;
      if (k === kTop - 1) return 1695;
      if (k < kTop - 1) return Math.max(PLAIN, 1695 - 13 * (kTop - 1 - k));
      return Math.max(PLAIN, 1697 - 13 * (k - kTop));
    });
    const peak: Peak = { id: 'kopf', name: 'Kopf', lon: LON, lat: rowLat(kTop), ele: 1697, prom: 197 };
    const targets = buildTargets([peak], obs, hf, hf.maxRange);
    expect(targets.length).toBe(1);
    const t = targets[0];
    expect(Math.abs(t.range - kTop * res)).toBeLessThan(res);
    expect(t.anchorAlt).toBe(1697);
    expect(computeVisibility(targets, hf, EYE)).toBe(1);
    expect(t.visible).toBe(true);
    // The pin stays on the summit, not on the post before it.
    expect(Math.abs(t.north - kTop * res)).toBeLessThan(res / 2);
  });
});
