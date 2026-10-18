/**
 * The polar mesh on the CPU: the same ring spacing and height sampling as the
 * vertex shader, so a label can be anchored on the summit as it is drawn
 * rather than on the DEM's sharper one.
 */
import { describe, expect, test } from 'bun:test';
import { destination, groundRange, latToMercY, localRadius, lonToMercX } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';
import { QUALITY_HIGH, QUALITY_LOW } from '../../src/engine/render/gpu/renderer';
import { bandFor, lookRange, meshTopNear, radialParams, radiusAt, rowAt, wedge } from '../../src/engine/render/mesh';

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
  test('rowAt inverts radiusAt in every segment', () => {
    const { hf } = field([]);
    for (const q of [QUALITY_HIGH, QUALITY_LOW]) {
      const p = radialParams(q, hf);
      for (const f of [0.5, p.jNear - 0.5, p.jNear + 3.25, p.jSplit + 10.5, q.rows - 2]) {
        expect(rowAt(p, radiusAt(p, f))).toBeCloseTo(f, 6);
      }
    }
  });

  test('beyond the near field the rings are a constant fraction of the range, as fine as the clipmap posts: 1/190 (high), 1/120 (low), out to the last level', () => {
    // A level's posts are 1/318 to 1/159 of the range they serve; a ring
    // spacing of that order draws a ridge where the DEM has it, instead of
    // 0–60 m lower (§8.y), and keeps every summit on a ring.
    const { hf } = field([]);
    for (const [q, worst] of [[QUALITY_HIGH, 1 / 190], [QUALITY_LOW, 1 / 120]] as const) {
      const p = radialParams(q, hf);
      for (let f = p.jNear; f < q.rows - 1; f++) {
        const r = radiusAt(p, f);
        expect((radiusAt(p, f + 1) - r) / r).toBeLessThanOrEqual(worst * 1.001);
      }
      expect(radiusAt(p, q.rows - 1)).toBeCloseTo(Math.max(hf.maxRange, p.rNearEnd * 1.5), 3);
    }
    // Within a vertex budget a 200-euro phone carries: all of it is drawn now, nothing is culled.
    expect(QUALITY_HIGH.azimuths * QUALITY_HIGH.rows).toBeLessThanOrEqual(1.7e6);
    expect(QUALITY_LOW.azimuths * QUALITY_LOW.rows).toBeLessThanOrEqual(0.65e6);
  });
});

describe('the wedge: columns over the view, not the whole circle', () => {
  test('the columns cover the frustum\'s arc with a spare column at each end, and the first sits on the column grid', () => {
    const { az0, azStep } = wedge(1024, { start: 50, span: 100 });
    const DEG = Math.PI / 180;
    expect(azStep).toBeCloseTo((100 * DEG) / 1022, 12);
    expect(az0).toBeLessThanOrEqual(50 * DEG);
    expect(az0).toBeGreaterThan(50 * DEG - azStep);
    expect(az0 / azStep).toBeCloseTo(Math.round(az0 / azStep), 9);
    expect(az0 + 1024 * azStep).toBeGreaterThanOrEqual(150 * DEG);
  });

  test('panning within a column leaves the columns where they are; a steep view takes the whole circle', () => {
    const a = wedge(1024, { start: 50.02, span: 100 }), b = wedge(1024, { start: 50.06, span: 100 });
    expect(b.az0).toBe(a.az0);
    expect(b.azStep).toBe(a.azStep);
    expect(wedge(1024, null)).toEqual({ az0: 0, azStep: (2 * Math.PI) / 1024 });
    expect(wedge(1024, { start: 10, span: 360 })).toEqual({ az0: 0, azStep: (2 * Math.PI) / 1024 });
  });

  test('zoomed in, a column is a fraction of a degree, and meshTopNear finds the summit in the wedge, not outside it', () => {
    const { hf, at } = field([{ range: 900, bearing: 90 }, { range: 900, bearing: 270 }]);
    const p = radialParams(QUALITY_LOW, hf, { start: 85, span: 10 });
    expect((p.azStep * 180) / Math.PI).toBeLessThan(0.02);
    const east = meshTopNear(hf, p, at[0].lon, at[0].lat, EYE);
    expect(east.h).toBeGreaterThan(PLAIN + SPIKE * 0.4);
    expect(groundRange(east.lon, east.lat, at[0].lon, at[0].lat)).toBeLessThan(10);
    // The west spike is not drawn: the point itself, at the DEM's height.
    const west = meshTopNear(hf, p, at[1].lon, at[1].lat, EYE);
    expect(west.lon).toBe(at[1].lon);
    expect(west.h).toBe(hf.height(at[1].lon, at[1].lat, 900));
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
    expect(radiusAt(p, f + 1) - radiusAt(p, f)).toBeGreaterThan(20);          // a cell deep enough to matter (1/120 of 5 km = 42 m)
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

describe('the telescope: a dense band of rings around the distance looked at', () => {
  test('lookRange: where the centre ray meets the ground, or null for sky', () => {
    const { hf, at } = field([]);
    // Above the horizon: sky.
    expect(lookRange(hf, EYE, 90, 2)).toBeNull();
    // Level, 1.7 m above a plain: the ray meets the curved ground at the horizon, sqrt(2 R' h) ≈ 5.0 km.
    expect(Math.abs(lookRange(hf, EYE, 90, 0)! - Math.sqrt(2 * (6371008.8 / 0.87) * 1.7))).toBeLessThan(200);
    // Looking 1° down from 1.7 m above a plain: the ground 97 m out.
    expect(lookRange(hf, EYE, 90, -1)).toBeCloseTo(1.7 / Math.tan(Math.PI / 180), -1);
    // A 400 m wall from 4.94 km on, looked at 2° up: the ray meets its front, about 4.94 km out.
    const walled = new HeightField(LON, LAT);
    const z = 13, w = 2048, hh = 2048;
    const px0 = Math.round(lonToMercX(LON, z)) - w / 2, py0 = Math.round(latToMercY(LAT, z)) - hh / 2;
    const raw = new Uint16Array(w * hh).fill(PLAIN + 1000);
    const front = destination(LON, LAT, 90, 4940, localRadius(LAT));
    const xf = Math.floor(lonToMercX(front.lon, z) - px0), yc = Math.floor(latToMercY(LAT, z) - py0);
    for (let y = yc - 20; y <= yc + 20; y++) for (let x = xf; x < xf + 40; x++) raw[y * w + x] = 1900 + 1000;
    walled.addLevel({ z, px0, py0, w, h: hh, quant: 1, bias: -1000 }, raw, true);
    const r = lookRange(walled, EYE, 90, 2);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(4900);
    expect(r!).toBeLessThan(4960);
    void at;
  });

  test('bandFor quantises the distance in steps of 1.25, so panning across a slope does not move the rings', () => {
    expect(bandFor(10000)).toEqual(bandFor(10800));
    expect(bandFor(10000)).not.toEqual(bandFor(13000));
    const b = bandFor(10000)!;
    expect(b.r1).toBeLessThan(10000 * 0.8);
    expect(b.r2).toBeGreaterThan(10000 * 1.2);
    expect(bandFor(null)).toBeNull();
  });

  test('with a band the rings there are a post apart or finer, and rowAt still inverts radiusAt everywhere', () => {
    const { hf } = field([]);
    const band = { r1: 7000, r2: 13000 };
    for (const q of [QUALITY_HIGH, QUALITY_LOW]) {
      const p = radialParams(q, hf, null, band);
      expect(radiusAt(p, p.jNear)).toBeCloseTo(7000, 3);
      expect(radiusAt(p, p.jSplit)).toBeCloseTo(13000, 3);
      // Inside the band the step is constant and no coarser than the level's post there (13.3 m here) times two.
      const step = radiusAt(p, p.jNear + 1) - radiusAt(p, p.jNear);
      expect(step).toBeCloseTo(radiusAt(p, p.jSplit) - radiusAt(p, p.jSplit - 1), 6);
      expect(step).toBeLessThanOrEqual(2 * hf.levels[0].res);
      // The band takes at most 45 % of the rows; the rest still reaches the last level.
      expect(p.jSplit - p.jNear).toBeLessThanOrEqual(0.45 * q.rows);
      expect(radiusAt(p, q.rows - 1)).toBeCloseTo(Math.max(hf.maxRange, 13000 * 1.5), 3);
      for (const f of [0.5, p.jNear - 0.5, p.jNear + 3.25, p.jSplit - 1, p.jSplit + 10.5, q.rows - 2]) {
        expect(rowAt(p, radiusAt(p, f))).toBeCloseTo(f, 6);
      }
    }
    // Without a band, nothing changes.
    expect(radialParams(QUALITY_HIGH, hf, null, null)).toEqual(radialParams(QUALITY_HIGH, hf));
  });
});
