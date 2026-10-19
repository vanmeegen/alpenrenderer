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

describe('a summit behind the visible edge of its own mountain', () => {
  // The Haidachstellwand from the Mauritzalm, 1225 m away: the wall rises
  // 323 m to its top edge 1111 m out, then a shoulder climbs another 24 m
  // over 114 m to the summit point. The edge stands 16.2° up, the summit
  // 15.8°: the summit is behind its own edge, but what you see is the
  // Haidachstellwand, so its name goes on the edge. A summit behind a
  // separate ridge, with a valley between, stays hidden; so does one well
  // below its rim.
  const RANGE = 1225, EDGE = 1111, EDGE_RISE = 323, TOP_RISE = 347;
  /** Wall and shoulder along north; `dip` metres of valley behind the edge when asked. */
  const mountain = (dip: number, topRise = TOP_RISE) => (north: number, east: number) => {
    const w = Math.max(0, 1 - Math.abs(east) / 1500);
    if (north < 700 || north > RANGE + 300) return PLAIN;
    let rise: number;
    if (north <= EDGE) rise = EDGE_RISE * (north - 700) / (EDGE - 700);
    else if (north <= RANGE) {
      rise = EDGE_RISE + (topRise - EDGE_RISE) * (north - EDGE) / (RANGE - EDGE);
      // A notch right behind the edge, 40 m wide.
      if (dip > 0 && north > EDGE + 20 && north < EDGE + 60) rise -= dip;
    } else rise = topRise - (topRise - 100) * (north - RANGE) / 300;
    return PLAIN + rise * w;
  };
  const summit = (hf: HeightField, rowLat: (k: number) => number, res: number, ele: number): Peak =>
    ({ id: 'wand', name: 'Stellwand', lon: LON, lat: rowLat(Math.round(RANGE / res)), ele, prom: 145 });

  test('a summit a little behind its own edge is visible, the pin on the edge, the range the summit\'s', () => {
    const { hf, res, rowLat } = field(13, 256, mountain(0));
    const targets = buildTargets([summit(hf, rowLat, res, PLAIN + TOP_RISE)], obs, hf, hf.maxRange);
    const t = targets[0];
    const summitRange = t.range;
    expect(computeVisibility(targets, hf, EYE)).toBe(1);
    expect(t.visible).toBe(true);
    expect(t.atCrest).toBe(true);
    expect(Math.abs(t.north - EDGE)).toBeLessThan(2 * res);
    expect(Math.abs(t.anchorAlt - (PLAIN + EDGE_RISE))).toBeLessThan(2 * res);
    // The edge's angle from the formula, within the grid's rounding of where the edge row lies.
    const edgeElev = Math.atan2(PLAIN + EDGE_RISE - EYE, EDGE) * (180 / Math.PI);
    expect(Math.abs(t.elevation - edgeElev)).toBeLessThan(0.15);
    expect(t.range).toBe(summitRange);
    expect(t.anchor.lat).toBeLessThan(summit(hf, rowLat, res, 0).lat);   // the anchor moved towards the observer
  });

  test('a separate ridge with a valley behind it keeps hiding the summit', () => {
    const { hf, res, rowLat } = field(13, 256, mountain(60));
    const targets = buildTargets([summit(hf, rowLat, res, PLAIN + TOP_RISE)], obs, hf, hf.maxRange);
    expect(computeVisibility(targets, hf, EYE)).toBe(0);
    expect(targets[0].atCrest).toBeFalsy();
  });

  test('a summit well below its rim stays hidden', () => {
    // The ground falls away behind the edge for 300 m to a catalogued point
    // 60 m lower: 5.7° below the edge's sightline, and no top within the
    // anchor search's reach. What you see is the edge, not that point.
    const DEEP = EDGE + 300;
    const deep = (north: number, east: number) => {
      const w = Math.max(0, 1 - Math.abs(east) / 1500);
      if (north < 700 || north > DEEP + 300) return PLAIN;
      const rise = north <= EDGE ? EDGE_RISE * (north - 700) / (EDGE - 700) : EDGE_RISE - 60 * (north - EDGE) / 300;
      return PLAIN + rise * w;
    };
    const { hf, res, rowLat } = field(13, 256, deep);
    const point: Peak = { id: 'tief', name: 'Tiefpunkt', lon: LON, lat: rowLat(Math.round(DEEP / res)), ele: PLAIN + EDGE_RISE - 60, prom: 50 };
    const targets = buildTargets([point], obs, hf, hf.maxRange);
    expect(Math.abs(targets[0].range - DEEP)).toBeLessThan(2 * res);   // the anchor stayed on the point
    expect(computeVisibility(targets, hf, EYE)).toBe(0);
    expect(targets[0].atCrest).toBeFalsy();
  });
});

