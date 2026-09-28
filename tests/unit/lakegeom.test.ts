/**
 * Geometry for the lake catalogue build (tools/build_lakes.mjs): OSM hands
 * a multipolygon over as loose way segments; the catalogue wants closed
 * rings, an area, a lighter shore, and a label point on open water.
 */
import { describe, expect, test } from 'bun:test';
// @ts-expect-error plain ES module without types, run by node at build time
import { assembleRings, labelPoint, ringArea, simplifyRing } from '../../tools/lakegeom.mjs';

const M_LAT = 111320;
const M_LON = 111320 * Math.cos((47 * Math.PI) / 180);
/** A point `e` metres east and `n` metres north of 10°E 47°N, as OSM geometry. */
const pt = (e: number, n: number) => ({ lon: 10 + e / M_LON, lat: 47 + n / M_LAT });
/** Flat lon,lat list back to metres, for readable expectations. */
const metres = (ring: number[]) => {
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += 2) out.push([Math.round((ring[i] - 10) * M_LON), Math.round((ring[i + 1] - 47) * M_LAT)]);
  return out;
};

describe('assembleRings', () => {
  test('joins loose segments into one closed ring, whichever way they run', () => {
    const a = [pt(0, 0), pt(1000, 0), pt(1000, 1000)];
    const b = [pt(0, 1000), pt(1000, 1000)];            // runs backwards
    const c = [pt(0, 1000), pt(0, 0)];
    const rings = assembleRings([a, b, c]);
    expect(rings.length).toBe(1);
    const m = metres(rings[0]);
    expect(m.length).toBe(4);                             // closed, without repeating the first point
    expect(new Set(m.map((p) => p.join(','))).size).toBe(4);
  });

  test('an already closed way is a ring on its own; an open end is dropped', () => {
    const closed = [pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 0)];
    const dangling = [pt(500, 500), pt(600, 500)];
    const rings = assembleRings([closed, dangling]);
    expect(rings.length).toBe(1);
    expect(metres(rings[0]).length).toBe(3);
  });
});

describe('ringArea', () => {
  test('a 1 km square is a square kilometre, either orientation', () => {
    const sq = [pt(0, 0), pt(1000, 0), pt(1000, 1000), pt(0, 1000)].flatMap((p) => [p.lon, p.lat]);
    expect(ringArea(sq)).toBeCloseTo(1_000_000, -3);
    const rev = [pt(0, 1000), pt(1000, 1000), pt(1000, 0), pt(0, 0)].flatMap((p) => [p.lon, p.lat]);
    expect(ringArea(rev)).toBeCloseTo(1_000_000, -3);
  });
});

describe('simplifyRing', () => {
  test('points within the tolerance of the shore line go, corners stay', () => {
    const wobbly = [pt(0, 0), pt(500, 3), pt(1000, 0), pt(1000, 1000), pt(500, 996), pt(0, 1000)].flatMap((p) => [p.lon, p.lat]);
    expect(metres(simplifyRing(wobbly, 10))).toEqual([[0, 0], [1000, 0], [1000, 1000], [0, 1000]]);
  });

  test('never below a triangle', () => {
    const tiny = [pt(0, 0), pt(5, 0), pt(5, 5), pt(0, 5)].flatMap((p) => [p.lon, p.lat]);
    expect(simplifyRing(tiny, 100).length / 2).toBeGreaterThanOrEqual(3);
  });
});

describe('labelPoint', () => {
  test('in a C-shaped lake the label sits on water, not in the bay the centroid falls into', () => {
    // A 1 km square with a 600 m wide bay cut in from the east: the centroid
    // is in the bay (dry); the label must be in the western arm.
    const c = [pt(0, 0), pt(1000, 0), pt(1000, 200), pt(200, 200), pt(200, 800), pt(1000, 800), pt(1000, 1000), pt(0, 1000)]
      .flatMap((p) => [p.lon, p.lat]);
    const p = labelPoint([c]);
    const e = (p.lon - 10) * M_LON, n = (p.lat - 47) * M_LAT;
    const inBay = e > 200 && n > 200 && n < 800;
    expect(inBay).toBe(false);
    expect(e > 0 && e < 1000 && n > 0 && n < 1000).toBe(true);
    // Mid-arm, not on a shore: every arm is 200 m wide, so the best point is
    // about 100 m from the outer edge it is nearest to.
    expect(Math.min(e, n, 1000 - e, 1000 - n)).toBeGreaterThan(80);
  });

  test('an island in the middle pushes the label off it', () => {
    const outer = [pt(0, 0), pt(1000, 0), pt(1000, 1000), pt(0, 1000)].flatMap((p) => [p.lon, p.lat]);
    const island = [pt(300, 300), pt(700, 300), pt(700, 700), pt(300, 700)].flatMap((p) => [p.lon, p.lat]);
    const p = labelPoint([outer, island]);
    const e = (p.lon - 10) * M_LON, n = (p.lat - 47) * M_LAT;
    const onIsland = e > 300 && e < 700 && n > 300 && n < 700;
    expect(onIsland).toBe(false);
  });
});
