/**
 * The polar mesh on the CPU: the same ring spacing and height sampling as the
 * vertex shader, so a label can be anchored on the summit as it is drawn
 * rather than on the DEM's sharper one.
 */
import { describe, expect, test } from 'bun:test';
import { destination, groundRange, latToMercY, localRadius, lonToMercX } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';
import { QUALITY_HIGH, QUALITY_LOW } from '../../src/engine/render/gpu/renderer';
import { frameScan, scanBin, scanStart } from '../../src/engine/render/framescan';
import { RINGS, RING_CODE, encodeRings, lookRange, lookRanges, meshTopNear, radialParams, radiusAt, ringTable, ringsOf, rowAt, vertexHeight, wedge } from '../../src/engine/render/mesh';
import { RIDGES, twoRidges } from './helpers/ridges';

const DEG = Math.PI / 180;

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

describe('the telescope: rings where the frame shows ground', () => {
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

  test('zoomed in, a mountain is drawn with the same rings wherever the centre of the view points: the rings follow what is seen in the frame', () => {
    // The fault (2026-11-13, 47.6394/11.3761, 3.2°): one dense band of rings
    // lay around the distance the centre ray met the ground. At SO 137° that
    // was a summit 16 km off (rings 7 m apart there, 340 m apart on the
    // summit 26 km off beside it); at SO 136° the centre ray slipped past it
    // onto the far one (11 m there, 210 m on the near one). A crest between
    // two rings is drawn lower by the slope times half their distance: the
    // same mountain, 60 px different.
    const { hf, eye } = twoRidges();
    const px = (3.2 * DEG) / 600;                              // radians a pixel
    const spacingAt = (radii: Float64Array, r: number) => {
      let i = 0;
      while (i < radii.length - 2 && radii[i + 1] < r) i++;
      return radii[i + 1] - radii[i];
    };
    const tables = [90, 91].map((yaw) => {
      // 5.3° wide, 3.2° high, a degree above the horizon: what the frame holds, a quarter more on every side.
      const view = frameScan(hf, eye, { az0: yaw - 4, az1: yaw + 4, el0: -1.4, el1: 3.4 });
      return ringTable(1600, view, px, hf.maxRange);
    });
    for (const radii of tables) {
      // Both crests, whichever the centre ray meets: rings a pixel or two of the picture apart
      // on the ground that rises into view (a pixel is 1.5 m of height at 16 km, 3 m of a 27° slope).
      expect(spacingAt(radii, 15900)).toBeLessThan(12);
      expect(spacingAt(radii, 25900)).toBeLessThan(18);
    }
    // And the same rings in both views: nothing in the frame changed.
    expect(spacingAt(tables[0], 15900)).toBe(spacingAt(tables[1], 15900));
    expect(spacingAt(tables[0], 25900)).toBe(spacingAt(tables[1], 25900));
  });

  test('the ring table holds every row once, from the feet to the last level, never going back', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    for (const rows of [1600, 900, 300]) {
      const radii = ringTable(rows, view, (3.2 * DEG) / 600, hf.maxRange);
      expect(radii.length).toBe(rows);
      expect(radii[0]).toBe(RINGS.r0);
      expect(radii[rows - 1]).toBeCloseTo(hf.maxRange, 3);
      let distinct = 1;
      for (let i = 1; i < rows; i++) {
        expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1]);
        if (radii[i] > radii[i - 1]) distinct++;
      }
      // Rings to spare lie on the far edge; with too few, none is wasted.
      if (rows === 900) expect(distinct).toBeGreaterThan(rows * 0.7);   // the ladder of spacings has steps of √2
      // Ground the frame does not show still has rings, a few percent of the range apart.
      for (let i = 1; i < rows; i++) if (radii[i] > 30) expect((radii[i] - radii[i - 1]) / radii[i]).toBeLessThan(0.09);
    }
  });

  test('a plain in the frame does not take the rings from the crests behind it: rings go by rows of the screen, not by metres of ground', () => {
    // Looking level over a plain at ridges 16 and 26 km off (the ink-line
    // test of the E2E suite, 2026-11-13): the plain is seen from 2 km on,
    // seven times the depth of both crests together, and fills a part of
    // the frame's height only. By metres of ground it took nine rings in
    // ten and left the crests rings 50 m apart.
    const { hf } = twoRidges();
    const low = RIDGES.plain + 50;
    const view = frameScan(hf, low, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    expect(Array.from(view.classes).filter((c) => c === 2).length).toBeGreaterThan(60);
    const radii = ringTable(900, view, (3.2 * DEG) / 600, hf.maxRange);
    const spacing = (r: number) => {
      let i = 0;
      while (i < radii.length - 2 && radii[i + 1] < r) i++;
      return radii[i + 1] - radii[i];
    };
    expect(spacing(15950)).toBeLessThan(8);
    // (From 50 m up the far ridge stands behind the near one: nothing of it to draw.)
    // The plain between 2 and 13 km: the frame's height below the horizon, a pixel or two a ring.
    const onPlain = Array.from(radii).filter((r) => r > 2000 && r < 13000).length;
    expect(onPlain).toBeGreaterThan(40);
    expect(onPlain).toBeLessThan(450);
  });

  test('terrain that reaches further than the scan did (a level arrived since) has rings all the way out, not one leap to the edge', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    const radii = ringTable(1600, view, (3.2 * DEG) / 600, hf.maxRange * 4);
    expect(radii[1599]).toBeCloseTo(hf.maxRange * 4, 3);
    for (let i = 1; i < 1600; i++) if (radii[i] > 30) expect((radii[i] - radii[i - 1]) / radii[i]).toBeLessThan(0.09);
  });

  test('with too few rings for the frame, all that is seen is drawn coarser alike, not the centre fine and the rest coarse', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    const px = (3.2 * DEG) / 600;
    const spacing = (radii: Float64Array, r: number) => {
      let i = 0;
      while (i < radii.length - 2 && radii[i + 1] < r) i++;
      return radii[i + 1] - radii[i];
    };
    const plenty = ringTable(6000, view, px, hf.maxRange), scarce = ringTable(450, view, px, hf.maxRange);
    // Both crests lose by the same factor (the ladder of spacings has steps of 2^¼).
    const near = spacing(scarce, 15900) / spacing(plenty, 15900), far = spacing(scarce, 25900) / spacing(plenty, 25900);
    expect(near).toBeGreaterThan(2);
    expect(Math.max(near, far) / Math.min(near, far)).toBeLessThan(1.5);
    // With rows to spare a ring comes every RINGS.finest of RINGS.seen pixels of the picture: on the
    // near ridge's face (0.3 steep, 16 km off, a pixel 1.5 m high) that is 5 m of ground a pixel.
    expect(spacing(plenty, 15000)).toBeLessThan(RINGS.seen * RINGS.finest * 5 * 1.3);
    expect(spacing(plenty, 15000)).toBeGreaterThan(RINGS.seen * RINGS.finest * 5 / 3);
  });

  test('a stretch of ground keeps its rings when the frame changes elsewhere: they lie on a lattice of their own', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    const px = (3.2 * DEG) / 600;
    // Rows to spare, so that the spacing is the finest in both: with too few, what the far crest frees goes to the near one.
    const before = ringTable(8000, view, px, hf.maxRange);
    // The far crest leaves the frame; the near one stays.
    const without = { classes: view.classes.slice(), need: view.need.slice() };
    for (let b = scanBin(22000); b < without.classes.length; b++) { without.classes[b] = 0; without.need[b] = 0; }
    const after = ringTable(8000, without, px, hf.maxRange);
    const near = (radii: Float64Array) => Array.from(radii).filter((r) => r > 15300 && r < 16000);
    expect(near(before).length).toBeGreaterThan(50);
    expect(near(after)).toEqual(near(before));
  });

  test('few rows go to waste on the ladder of spacings: whatever the count, most of them are rings of their own', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    // (Up to where the rows are more than the finest spacing asks for.)
    for (let rows = 500; rows <= 1100; rows += 100) {
      const distinct = new Set(ringTable(rows, view, (3.2 * DEG) / 600, hf.maxRange)).size;
      expect(distinct).toBeGreaterThan(rows * 0.86);
    }
  });

  test('the telescope\'s data windows lie one behind the other on what the frame shows, the nearest ground in the finest: not around the centre of the view', () => {
    // Around the point the centre met, the windows gave the mountain there
    // 6 m posts and the one beside it the eye's 100 m: a rock summit when
    // looked at, a round green hill a degree aside (Montscheinspitze,
    // 2026-11-13). What a window serves is now a stretch of the view's
    // depth: the finest takes the nearest ground seen beyond where the
    // eye's own level of that zoom ends, the next goes on from there.
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    const first = scanStart(view.classes.findIndex((c) => c >= 2));   // 12.2 km: the plain comes into the frame
    const windows = [{ depth: 3300, from: 2000 }, { depth: 6600, from: 4000 }, { depth: 13100, from: 8000 }];
    const at = lookRanges(view.classes, windows);
    expect(at[0]).toBeCloseTo(first + 1650, 0);
    expect(at[1]).toBeCloseTo(first + 3300 + 3300, 0);        // goes on where the finest ends: the near crest (16 km) lies in it
    // The third skips the hidden dip behind the near ridge and starts where the far ridge shows its top.
    const far = scanStart(view.classes.findIndex((c, b) => c >= 2 && b >= scanBin(first + 9900)));
    expect(far).toBeGreaterThan(24000);
    expect(at[2]).toBeCloseTo(far + 6550, 0);
    expect(at[2]! - 6550).toBeLessThan(26000);                // the far crest in it
    // Ground nearer than a window's own eye level reaches is left to that level.
    expect(lookRanges(view.classes, [{ depth: 3300, from: 14000 }])[0]).toBeCloseTo(14000 + 1650, 0);
    // A window with nothing left to show gets no place; with nothing seen, none does.
    expect(lookRanges(view.classes, [...windows, { depth: 26000, from: 16000 }])[3]).toBeNull();
    expect(lookRanges(new Uint8Array(view.classes.length), windows)).toEqual([null, null, null]);
  });

  test('on a table rowAt inverts radiusAt, between the rings too; the renderer takes the table as it is', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    const radii = ringTable(900, view, (3.2 * DEG) / 600, hf.maxRange);
    const p = radialParams(QUALITY_LOW, hf, null, radii);
    expect(p.radii).toBe(radii);
    for (const f of [0, 0.5, 10.25, 300.75, 620]) {
      const r = radiusAt(p, f);
      expect(r).toBeGreaterThanOrEqual(radii[Math.floor(f)]);
      expect(rowAt(p, r)).toBeCloseTo(f, 6);
    }
    expect(ringsOf(p)).toBe(radii);
    // Without a table the three segments, as ever, and the table the shader reads is made from them.
    const plain = radialParams(QUALITY_LOW, hf);
    expect(plain.radii).toBeUndefined();
    const made = ringsOf(plain);
    expect(made.length).toBe(QUALITY_LOW.rows);
    for (const f of [0, 7, 200, 899]) expect(made[f]).toBeCloseTo(radiusAt(plain, f), 6);
  });

  test('the table goes to the GPU as three bytes of the logarithm a ring: good to a millionth of the range', () => {
    const { hf, eye } = twoRidges();
    const view = frameScan(hf, eye, { az0: 86, az1: 94, el0: -1.4, el1: 3.4 });
    const radii = ringTable(900, view, (3.2 * DEG) / 600, hf.maxRange);
    const { bytes, r0, span } = encodeRings(radii);
    expect(bytes.length).toBe(900 * 4);
    expect(r0).toBe(radii[0]);
    for (const i of [0, 1, 250, 600, 899]) {
      const v = bytes[i * 4] * 65536 + bytes[i * 4 + 1] * 256 + bytes[i * 4 + 2];
      const r = r0 * Math.exp((v / RING_CODE) * span);
      expect(Math.abs(r - radii[i]) / radii[i]).toBeLessThan(1e-6);
    }
  });
});

describe('inside the telescope\'s window the mesh is sampled from the look level, as the shader draws it', () => {
  // The shader (glsl.ts lookLevel/lookFade) takes a filled look level by
  // position: inside its window with room for the bilinear taps, blended
  // back into the observer's levels from 80 % to 95 % of the half width. A
  // label pin anchored on the observer's level alone sits a few metres, at
  // 5° of view a few pixels, off the drawn apex.
  const LOOK = PLAIN + 200;
  function withWindow(filled = true) {
    const { hf } = field([]);
    const z = 14, w = 640, h = 640;
    const centre = destination(LON, LAT, 90, 5000, localRadius(LAT));
    const px0 = Math.round(lonToMercX(centre.lon, z)) - w / 2, py0 = Math.round(latToMercY(centre.lat, z)) - h / 2;
    hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000, role: 'look' }, new Uint16Array(w * h).fill(LOOK + 1000), filled);
    // Longitude of a crop column: mercator x is linear in longitude.
    const perDeg = lonToMercX(LON + 1, z) - lonToMercX(LON, z);
    const lonAt = (u: number) => LON + (px0 + u - lonToMercX(LON, z)) / perDeg;
    const probe = (u: number) => {
      const lon = lonAt(u);
      return vertexHeight(hf, lon, centre.lat, groundRange(LON, LAT, lon, centre.lat));
    };
    return { hf, centre, probe };
  }

  test('well inside the window the height is the look level\'s, outside it the eye level\'s', () => {
    const { probe } = withWindow();
    expect(probe(320)).toBeCloseTo(LOOK, 6);              // the centre
    expect(probe(320 + 0.7 * 320)).toBeCloseTo(LOOK, 6);  // 70 % out: still fully the window
    expect(probe(639)).toBeCloseTo(PLAIN, 6);             // no room for the taps: not in the window
    expect(probe(700)).toBeCloseTo(PLAIN, 6);             // outside
  });

  test('from 80 % to 95 % of the half width the window blends back into the eye level, smoothstep', () => {
    const { probe } = withWindow();
    expect(probe(320 + 0.875 * 320)).toBeCloseTo(PLAIN + 100, 4);   // smoothstep(0.80, 0.95, 0.875) = 0.5
    expect(probe(320 + 0.96 * 320)).toBeCloseTo(PLAIN, 4);
  });

  test('windows nest: at the fine window\'s edge the height runs into the coarser window\'s, not down to the eye level\'s and up again', () => {
    // Zoomed in on a ridge 15 km off, the eye's level there has 51 m posts
    // and holds a crest twenty metres lower than the 6 m window does. The
    // fine window used to fade into that at its edge, although the coarser
    // window around it had the crest: a dent in the ridge along the edge.
    const { hf, centre, probe } = withWindow();
    const z = 13, w = 640, h = 640, COARSER = PLAIN + 120;
    hf.addLevel({
      z, px0: Math.round(lonToMercX(centre.lon, z)) - w / 2, py0: Math.round(latToMercY(centre.lat, z)) - h / 2, w, h, quant: 1, bias: -1000, role: 'look',
    }, new Uint16Array(w * h).fill(COARSER + 1000), true);
    expect(probe(320)).toBeCloseTo(LOOK, 6);                          // the fine window's own
    expect(probe(320 + 0.875 * 320)).toBeCloseTo((LOOK + COARSER) / 2, 4);   // half fine, half coarser window
    expect(probe(320 + 0.97 * 320)).toBeCloseTo(COARSER, 4);          // past the fine window: the coarser one, whole
    // The coarser window's own edge runs into the eye level (its centre is a post off the fine one's).
    expect(Math.abs(probe(320 + 1.75 * 320) - (COARSER + PLAIN) / 2)).toBeLessThan(3);
    expect(probe(320 + 2.2 * 320)).toBeCloseTo(PLAIN, 6);
  });

  test('a window that is still fading in is drawn by its weight: half in, half the eye level\'s height', () => {
    const { hf, probe } = withWindow();
    const look = hf.levels.find((l) => l.role === 'look')!;
    look.weight = 0.5;
    expect(probe(320)).toBeCloseTo(PLAIN + 100, 6);
    look.weight = 0;
    expect(probe(320)).toBeCloseTo(PLAIN, 6);
    look.weight = undefined;
    expect(probe(320)).toBeCloseTo(LOOK, 6);
  });

  test('an empty window is not read, and the pin follows the window: meshTopNear at its centre is on the look level', () => {
    const empty = withWindow(false);
    expect(empty.probe(320)).toBeCloseTo(PLAIN, 6);
    const { hf, centre } = withWindow();
    const top = meshTopNear(hf, radialParams(QUALITY_LOW, hf), centre.lon, centre.lat, EYE);
    expect(top.h).toBeCloseTo(LOOK, 3);
  });
});
