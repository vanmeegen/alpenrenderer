/**
 * Which summits the terrain hides, and which only seem hidden: a summit the
 * DEM flattens into a couple of posts must not be hidden by its own cell,
 * and a summit a little behind the visible edge of its own wall is seen as
 * that wall. The observer stands on a plain at 1500 m, eye 1.7 m up.
 */
import { describe, expect, test } from 'bun:test';
import { curvatureDrop, latToMercY, localRadius, lonToMercX, mercResolution, mercYToLat } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';
import { DEFAULT_HORIZON, HorizonTable, VisibilityJob, computeVisibility } from '../../src/engine/core/horizon';
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
  return { hf, ...level(hf, z, size, f) };
}

/** Adds such a level to a height field: several of them make a clipmap. */
function level(hf: HeightField, z: number, size: number, f: (north: number, east: number) => number) {
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
  return { res, rowLat };
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


describe('the horizon table: every post between the eye and the summit counts', () => {
  const RADIUS = localRadius(LAT);
  /** A summit block `km` north: two posts deep, a few wide, `h` metres high, on the level with resolution `res`. */
  const block = (km: number, res: number, h: number) => (north: number, east: number) =>
    (Math.abs(north - km * 1000) <= res && Math.abs(east) <= 3 * res ? h : PLAIN);

  test('a 3 m bank 20 m ahead hides a summit 20 km out; with the eye over the bank it shows', () => {
    // The march used to start 80 m out: what stood nearer was the picture's
    // whole foreground and did not exist for the labels (Pertisau).
    const hf = new HeightField(LON, LAT);
    const near = level(hf, 13, 256, (north, east) => (north >= 20 && north <= 60 && Math.abs(east) < 200 ? PLAIN + 3 : PLAIN));
    const res9 = mercResolution(LAT, 9);
    const far = level(hf, 9, 256, block(20, res9, 2100));
    expect(near.res).toBeLessThan(14);
    const peak: Peak = { id: 'fern', name: 'Fernkopf', lon: LON, lat: far.rowLat(Math.round(20000 / res9)), ele: 2100, prom: 500 };
    // 570 m above the eye's horizon at 20 km: 1.6° up. The bank's top, 1.3 m over the eye 20 to 33 m out, stands at 2.3° to 3.7°.
    const from = (eye: number) => {
      const t = buildTargets([peak], { ...obs, ground: eye }, hf, hf.maxRange);
      return computeVisibility(t, hf, eye);
    };
    expect(from(EYE)).toBe(0);
    expect(from(PLAIN + 5)).toBe(1);
  });

  test('a ridge one post wide 88 km out hides the summit behind it', () => {
    // 96 samples to a summit 100 km away are 6 to 7 km apart out there: a
    // ridge between two of them did not exist.
    const res8 = mercResolution(LAT, 8);
    const kRidge = Math.round(88000 / res8);
    const { hf, rowLat } = field(8, 640, (north, east) => {
      if (Math.round(north / res8) === kRidge && Math.abs(east) < 20000) return 3500;
      return block(100, res8, 3000)(north, east);
    });
    const peak: Peak = { id: 'hinten', name: 'Hinterkopf', lon: LON, lat: rowLat(Math.round(100000 / res8)), ele: 3000, prom: 800 };
    const t = buildTargets([peak], obs, hf, hf.maxRange);
    expect(t.length).toBe(1);
    expect(t[0].elevation).toBeLessThan(0.6);                 // 0.47° up; the ridge stands at 0.96°
    expect(computeVisibility(t, hf, EYE)).toBe(0);
  });

  test('40 m under the sightline at 100 km is hidden, 10 m under it is seen: the slack is metres, not an angle', () => {
    // 0.05° was 87 m at 100 km and 0.9 m at 1 km. Now 2 m plus 3 % of the
    // curvature drop: 22 m at 100 km (what refraction moves a summit by from
    // day to day), 2 m close by (the DEM's own rounding).
    const res8 = mercResolution(LAT, 8);
    const kRidge = Math.round(60000 / res8), kTop = Math.round(100000 / res8);
    const rRidge = kRidge * res8, rTop = kTop * res8;
    const tanRidge = (3000 - EYE - curvatureDrop(rRidge, RADIUS)) / rRidge;
    const sightline = EYE + tanRidge * rTop + curvatureDrop(rTop, RADIUS);     // the height a point at 100 km needs to peep over the ridge
    const seen = (under: number) => {
      const h = Math.round(sightline - under);
      const { hf, rowLat } = field(8, 640, (north, east) => {
        if (Math.round(north / res8) === kRidge && Math.abs(east) < 20000) return 3000;
        return block(rTop / 1000, res8, h)(north, east);
      });
      const peak: Peak = { id: 'kante', name: 'Kantenkopf', lon: LON, lat: rowLat(kTop), ele: h, prom: 800 };
      const t = buildTargets([peak], obs, hf, hf.maxRange);
      return computeVisibility(t, hf, EYE);
    };
    expect(seen(40)).toBe(0);
    expect(seen(10)).toBe(1);
    expect(seen(-30)).toBe(1);
  });

  test('a row is marched once, when a summit needs it, and reads about as many posts as the levels are wide', () => {
    const hf = new HeightField(LON, LAT);
    for (const z of [13, 12, 11, 10, 9, 8]) level(hf, z, 640, () => PLAIN);
    const table = new HorizonTable(hf, EYE);
    expect(table.rowsBuilt).toBe(0);
    table.before(37.3, 50000);
    expect(table.rowsBuilt).toBe(2);                           // the two bearings the summit lies between
    const perRow = table.samples / table.rowsBuilt;
    expect(perRow).toBeGreaterThan(600);
    expect(perRow).toBeLessThan(1400);
    table.before(37.3, 90000);
    table.before(37.35, 20000);
    expect(table.rowsBuilt).toBe(2);
    // On a level plain the horizon is the plain itself, falling away with the curvature: nothing stands above the eye.
    expect(table.before(37.3, 90000).tan).toBeLessThan(0);
    expect(table.skyline(37.3)).toBeLessThan(0);
  });

  test('a summit with nothing higher behind it stands on the skyline; one in front of a higher wall does not', () => {
    const res9 = mercResolution(LAT, 9);
    const { hf, rowLat } = field(9, 640, (north, east) => {
      if (Math.abs(north - 30000) <= res9 && Math.abs(east) < 15000) return 4000;       // a wall 30 km north
      if (Math.abs(north - 10000) <= res9 && Math.abs(east) <= 3 * res9) return 2200;   // a summit in front of it
      if (Math.abs(east - 10000) <= res9 && Math.abs(north) <= 3 * res9) return 2200;   // and one to the east, sky behind
      return PLAIN;
    });
    const peaks: Peak[] = [
      { id: 'vor', name: 'Vorberg', lon: LON, lat: rowLat(Math.round(10000 / res9)), ele: 2200, prom: 600 },
      { id: 'ost', name: 'Ostberg', lon: LON + 10000 / (111320 * Math.cos((LAT * Math.PI) / 180)), lat: LAT, ele: 2200, prom: 600 },
    ];
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    expect(computeVisibility(t, hf, EYE)).toBe(2);
    const by = Object.fromEntries(t.map((x) => [x.peak.id, x]));
    expect(by.vor.skyline).toBe(false);
    expect(by.ost.skyline).toBe(true);
  });
});

describe('checking the sightlines again', () => {
  test('what was seen stays seen until it is decided anew: a level arriving does not blank the labels', () => {
    // Every rebuild of the targets (a level lands, the eye height changes)
    // began with all of them hidden: the labels went out and came back one by one.
    const res9 = mercResolution(LAT, 9);
    const { hf, rowLat } = field(9, 640, (north, east) => {
      if (Math.abs(north - 10000) <= res9 && Math.abs(east) <= 3 * res9) return 2200;
      if (Math.abs(north - 20000) <= res9 && Math.abs(east) <= 3 * res9) return 2000;      // behind the first, and lower
      return PLAIN;
    });
    const peaks: Peak[] = [
      { id: 'vorn', name: 'Vorderkopf', lon: LON, lat: rowLat(Math.round(10000 / res9)), ele: 2200, prom: 600 },
      { id: 'hinten', name: 'Hinterkopf', lon: LON, lat: rowLat(Math.round(20000 / res9)), ele: 2000, prom: 400 },
    ];
    const first = buildTargets(peaks, obs, hf, hf.maxRange);
    expect(computeVisibility(first, hf, EYE)).toBe(1);
    const again = buildTargets(peaks, obs, hf, hf.maxRange);
    const job = new VisibilityJob(again, hf, EYE, DEFAULT_HORIZON, () => 0, first);
    const by = (id: string) => again.find((t) => t.peak.id === id)!;
    expect(by('vorn').visible).toBe(true);                        // carried over…
    expect(by('vorn').decided).toBe(false);                       // …not yet checked
    expect(by('hinten').visible).toBe(false);
    expect(job.visible).toBe(1);
    job.step(Infinity);
    expect(by('vorn').visible).toBe(true);
    expect(by('vorn').decided).toBe(true);
    expect(by('hinten').visible).toBe(false);
    expect(job.visible).toBe(1);
    // From higher up the one behind shows too: what is carried over is a guess, the check decides.
    const high = buildTargets(peaks, { ...obs, ground: EYE + 2000 }, hf, hf.maxRange);
    const up = new VisibilityJob(high, hf, EYE + 2000, DEFAULT_HORIZON, () => 0, again);
    up.step(Infinity);
    expect(up.visible).toBe(2);
  });
});
