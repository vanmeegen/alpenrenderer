/**
 * Characterisation of the label pipeline from peakviewer: geometry per
 * summit, visibility by a DEM march, screen layout without overlaps, and
 * picking. The terrain is a synthetic height field: a plain at 1500 m with
 * an east-west wall at 2600 m eight kilometres north of the observer.
 */
import { describe, expect, test } from 'bun:test';
import { Camera } from '../../src/engine/core/camera';
import { latToMercY, lonToMercX, mercYToLat } from '../../src/engine/core/geodesy';
import { HeightField } from '../../src/engine/core/heightfield';
import { computeVisibility } from '../../src/engine/core/horizon';
import { buildTargets, fmtEle, fmtRange, layoutLabels, pickLabel } from '../../src/engine/core/labels';
import { Peak } from '../../src/engine/core/peaks';
import { lakeLabel } from '../../src/engine/core/water';

const LON = 10.0, LAT = 47.0;
const PLAIN = 1500, WALL = 2600;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);
const north = (km: number) => LAT + (km * 1000) / M_PER_DEG_LAT;
const east = (km: number) => LON + (km * 1000) / M_PER_DEG_LON;
const WALL_KM = 8;

/**
 * A 128-px level at pixel zoom 8 (~420 m/px): the plain, with one row at
 * 2600 m eight kilometres north, a ridge one pixel wide. `wallLat` is that
 * row's centre, where the summit catalogue puts the Mauerspitze.
 */
function field(): { hf: HeightField; wallLat: number } {
  const hf = new HeightField(LON, LAT);
  const z = 8, w = 128, h = 128;
  const px0 = Math.round(lonToMercX(LON, z)) - w / 2;
  const py0 = Math.round(latToMercY(LAT, z)) - h / 2;
  const n = 256 * 2 ** z;
  const latOfRow = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * (py0 + y + 0.5)) / n))) * 180 / Math.PI;
  let wallRow = 0, best = Infinity;
  for (let y = 0; y < h; y++) {
    const d = Math.abs((latOfRow(y) - LAT) * M_PER_DEG_LAT / 1000 - WALL_KM);
    if (d < best) { best = d; wallRow = y; }
  }
  const raw = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = (y === wallRow ? WALL : PLAIN) + 1000;
  hf.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
  return { hf, wallLat: latOfRow(wallRow) };
}

const { hf, wallLat } = field();
const WALL_M = (wallLat - LAT) * M_PER_DEG_LAT;

const peaks: Peak[] = [
  { id: 'wall', name: 'Mauerspitze', lon: LON, lat: wallLat, ele: 2650 },
  { id: 'behind', name: 'Hinterhorn', lon: LON, lat: north(14), ele: 3500 },
  { id: 'east', name: 'Osthügel', lon: east(5), lat: LAT, ele: 1510 },
  { id: 'far', name: 'Fernberg', lon: east(200), lat: LAT, ele: 4000 },
];
const obs = { lon: LON, lat: LAT, ground: PLAIN, eye: 1.7 };

describe('buildTargets', () => {
  test('anchors on the DEM summit, not the catalogue elevation, and drops what is out of range', () => {
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    const wall = t.find((x) => x.peak.id === 'wall')!;
    expect(wall.anchorAlt).toBe(WALL);
    expect(wall.range).toBeCloseTo(WALL_M, -1);
    expect(wall.bearing).toBeCloseTo(0, 0);
    expect(wall.elevation).toBeCloseTo(Math.atan2(WALL - PLAIN - 1.7, WALL_M) * 180 / Math.PI, 0);
    expect(t.find((x) => x.peak.id === 'far')).toBeUndefined();
  });

  test('a lake anchors on its water surface, not on the highest ground around it', () => {
    // The label point one DEM row south of the wall: a summit there would
    // climb onto the wall (2600 m), a lake stays on its own surface (1500 m).
    const shoreLat = mercYToLat(latToMercY(wallLat, 8) + 1, 8);
    const lake = lakeLabel({ id: 'osm:way/1', name: 'Mauersee', lon: LON, lat: shoreLat, rings: [] });
    expect(lake.kind).toBe('lake');
    const t = buildTargets([lake, { id: 'p', name: 'Uferkopf', lon: LON, lat: shoreLat }], obs, hf, hf.maxRange);
    const byId = Object.fromEntries(t.map((x) => [x.peak.id, x]));
    expect(byId['osm:way/1'].anchorAlt).toBeCloseTo(PLAIN, 0);
    expect(byId.p.anchorAlt).toBe(WALL);
    // Its second line gives the surface height the DEM has, when OSM has none.
    for (const x of t) x.visible = true;
    const placed = layoutLabels(t.filter((x) => x.peak.kind === 'lake'), camera(0), opt());
    expect(placed[0].lines).toEqual(['Mauersee', `1500 m · ${(byId['osm:way/1'].range / 1000).toFixed(1)} km`]);
  });

  test('a big lake whose centre is hidden behind a ridge is named where it shows, once', () => {
    // A lake from 5 to 12 km north, 2 km wide: its label point at 10 km lies
    // behind the wall at 8 km, its southern part in front of it is in view.
    const ring = [LON - 0.013, north(5), LON + 0.013, north(5), LON + 0.013, north(12), LON - 0.013, north(12)];
    const lake = lakeLabel({ id: 'osm:relation/9', name: 'Langsee', lon: LON, lat: north(10), area: 14e6, rings: [ring] });
    expect(lake.spots?.length).toBeGreaterThan(0);
    const t = buildTargets([lake], obs, hf, hf.maxRange);
    computeVisibility(t, hf, PLAIN + 1.7);
    const main = t.find((x) => x.spot === 0)!;
    expect(main.visible).toBe(false);                     // the centre is behind the wall
    const placed = layoutLabels(t, camera(0), opt());
    expect(placed.map((p) => p.target.peak.name)).toEqual(['Langsee']);
    expect(placed[0].target.range).toBeLessThan(WALL_M);  // on the part in front of the wall
  });

  test('a lake in full view keeps its label on its centre, not on the nearest spot', () => {
    const ring = [LON - 0.013, north(2), LON + 0.013, north(2), LON + 0.013, north(6), LON - 0.013, north(6)];
    const lake = lakeLabel({ id: 'osm:relation/8', name: 'Vorsee', lon: LON, lat: north(4), area: 8e6, rings: [ring] });
    const t = buildTargets([lake], obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const placed = layoutLabels(t, camera(0), opt());
    expect(placed.length).toBe(1);
    expect(placed[0].target.spot).toBe(0);
  });

  test('with the drawn surface given, a label on screen sits on the summit as drawn; only labels on screen pay for it', () => {
    // The mesh draws the wall 40 m lower than the DEM holds it; the label goes there.
    const asked: string[] = [];
    const drawn = (lon: number, lat: number) => { asked.push(`${lon.toFixed(4)},${lat.toFixed(4)}`); return WALL - 40; };
    const lake = lakeLabel({ id: 'osm:way/2', name: 'Nordsee', lon: LON + 0.001, lat: north(4), rings: [] });
    const t = buildTargets([...peaks, lake], obs, hf, hf.maxRange, drawn);
    expect(asked.length).toBe(0);                                  // nothing computed up front
    for (const x of t) x.visible = true;
    const placed = layoutLabels(t, camera(0), opt());
    const wall = placed.find((p) => p.target.peak.id === 'wall')!;
    expect(wall.target.anchorAlt).toBe(WALL - 40);
    const elev = Math.atan2(WALL - 40 - PLAIN - 1.7, WALL_M);
    expect(wall.ay).toBeCloseTo(300 - 300 * Math.tan(elev) / Math.tan(Math.PI / 6), 0);
    // The lake keeps its water; the Osthügel, off to the east, was never asked about.
    expect(placed.find((p) => p.target.peak.id === 'osm:way/2')!.target.anchorAlt).toBeCloseTo(PLAIN, 0);
    expect(asked.length).toBe(2);                                  // the wall and the Hinterhorn, both in view
    // Asked once, remembered: a second frame asks nothing.
    layoutLabels(t, camera(0), opt());
    expect(asked.length).toBe(2);
    // A surface above the DEM summit never lifts the anchor.
    const high = buildTargets(peaks, obs, hf, hf.maxRange, () => WALL + 500);
    for (const x of high) x.visible = true;
    layoutLabels(high, camera(0), opt());
    expect(high.find((x) => x.peak.id === 'wall')!.anchorAlt).toBe(WALL);
  });

  test('orders by distance: the nearest summit first, however famous the ones behind', () => {
    // Hinterhorn (3500 m) outranks the Osthügel (1510 m) by any measure of
    // fame; standing there, the hill in front is the one to name first.
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    expect(t.map((x) => x.peak.id)).toEqual(['east', 'wall', 'behind']);
  });
});

describe('computeVisibility', () => {
  test('the wall hides what stands behind it and shows what stands on it', () => {
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    const n = computeVisibility(t, hf, PLAIN + 1.7);
    const vis = Object.fromEntries(t.map((x) => [x.peak.id, x.visible]));
    expect(vis).toEqual({ wall: true, behind: false, east: true });
    expect(n).toBe(2);
  });

  test('in slices: each step stops when its budget is spent, and the answer is the same at the end', async () => {
    // Forty thousand catalogue summits take a second or two of sightlines;
    // done in one go on the main thread, the app freezes for that long at
    // every level that arrives. The job decides as many as its budget allows
    // per frame, nearest first, and the rest wait for the next frame.
    const { VisibilityJob } = await import('../../src/engine/core/horizon');
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    let clock = 0;
    const job = new VisibilityJob(t, hf, PLAIN + 1.7, undefined, () => clock++);   // every look at the clock is a millisecond
    expect(job.done).toBe(false);
    expect(job.step(1)).toBe(false);          // one target fits into one millisecond
    expect(t.filter((x) => x.decided).length).toBe(1);
    expect(t.filter((x) => x.visible).length).toBeLessThanOrEqual(1);
    while (!job.step(1)) { /* frame by frame */ }
    expect(job.done).toBe(true);
    expect(job.visible).toBe(2);
    expect(Object.fromEntries(t.map((x) => [x.peak.id, x.visible]))).toEqual({ wall: true, behind: false, east: true });
  });
});

function camera(yaw: number, w = 1000, h = 600) {
  const cam = new Camera();
  cam.aspect = w / h;
  cam.set({ yaw, pitch: 0, fov: 60 });
  cam.update();
  return cam;
}
const opt = (w = 1000, h = 600, maxLabels = 20) => ({
  width: w, height: h, measure: (s: string) => s.length * 7, lineHeight: 16, maxLabels, detailed: 1, gap: 5,
});

describe('layoutLabels', () => {
  test('puts a visible summit at its projected point, box above the anchor, detail on the top label', () => {
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    computeVisibility(t, hf, PLAIN + 1.7);
    const placed = layoutLabels(t, camera(0), opt());
    const names = placed.map((p) => p.target.peak.name);
    expect(names).toEqual(['Mauerspitze']);        // Hinterhorn hidden, Osthügel off screen
    const m = placed[0];
    expect(m.ax).toBeCloseTo(500, 0);
    const elev = Math.atan2(WALL - PLAIN - 1.7, WALL_M);
    expect(m.ay).toBeCloseTo(300 - 300 * Math.tan(elev) / Math.tan(Math.PI / 6), 0);
    expect(m.by + m.bh).toBeLessThan(m.ay);
    expect(m.lines).toEqual(['Mauerspitze', `2650 m · ${(WALL_M / 1000).toFixed(1)} km`]);
  });

  test('two summits at the same spot stack without overlapping, and maxLabels caps the count', () => {
    const twins: Peak[] = [
      { id: 'a', name: 'Zwilling A', lon: LON, lat: wallLat, ele: 2650 },
      { id: 'b', name: 'Zwilling B', lon: LON, lat: wallLat, ele: 2640 },
      { id: 'c', name: 'Zwilling C', lon: LON, lat: wallLat, ele: 2630 },
    ];
    const t = buildTargets(twins, obs, hf, hf.maxRange);
    computeVisibility(t, hf, PLAIN + 1.7);
    const placed = layoutLabels(t, camera(0), opt());
    expect(placed.length).toBe(3);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const overlap = a.bx < b.bx + b.bw && a.bx + a.bw > b.bx && a.by < b.by + b.bh && a.by + a.bh > b.by;
        expect(overlap).toBe(false);
      }
    }
    expect(layoutLabels(t, camera(0), opt(1000, 600, 2)).length).toBe(2);
  });

  test('a summit near the top edge keeps its label, clamped into the frame', () => {
    // At 17° the wall summit projects to about 25 px from the top: no room
    // for a box above the anchor. The label must not be dropped for that.
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    computeVisibility(t, hf, PLAIN + 1.7);
    const cam = new Camera();
    cam.aspect = 1000 / 600;
    cam.set({ yaw: 0, pitch: 0, fov: 17 });
    cam.update();
    const placed = layoutLabels(t, cam, opt());
    expect(placed.map((p) => p.target.peak.name)).toEqual(['Mauerspitze']);
    const m = placed[0];
    expect(m.ay).toBeLessThan(60);
    expect(m.by).toBeGreaterThanOrEqual(2);
    expect(m.by + m.bh).toBeLessThan(600);
  });

  test('near before far: with room for one label the near hill gets it; zoomed onto the famous peak, it gets its own', () => {
    // A nameless-looking hill 3 km east and a famous 4000er 6 km out at 97°:
    // at 60° both are in view and the near one wins the only slot.
    const pair: Peak[] = [
      { id: 'near', name: 'Nahkopf', lon: east(3), lat: LAT, ele: 1510 },
      { id: 'famous', name: 'Fernhorn', lon: LON + (6000 * Math.sin((97 * Math.PI) / 180)) / M_PER_DEG_LON, lat: LAT + (6000 * Math.cos((97 * Math.PI) / 180)) / M_PER_DEG_LAT, ele: 4000, prom: 2500 },
    ];
    const t = buildTargets(pair, obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    expect(layoutLabels(t, camera(90), opt(1000, 600, 1)).map((p) => p.target.peak.id)).toEqual(['near']);
    // Zoomed in on 97°, the hill leaves the frame and the famous peak is named.
    const cam = new Camera();
    cam.aspect = 1000 / 600;
    cam.set({ yaw: 97, pitch: 0, fov: 5 });
    cam.update();
    expect(layoutLabels(t, cam, opt(1000, 600, 1)).map((p) => p.target.peak.id)).toEqual(['famous']);
  });

  test('looking away, nothing is placed', () => {
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    computeVisibility(t, hf, PLAIN + 1.7);
    expect(layoutLabels(t, camera(180), opt())).toEqual([]);
  });
});

describe('pickLabel and formatting', () => {
  test('a tap in the box or near the anchor picks the label, far away picks nothing', () => {
    const t = buildTargets(peaks, obs, hf, hf.maxRange);
    computeVisibility(t, hf, PLAIN + 1.7);
    const placed = layoutLabels(t, camera(0), opt());
    const m = placed[0];
    expect(pickLabel(placed, m.bx + 3, m.by + 3)).toBe(m);
    expect(pickLabel(placed, m.ax + 10, m.ay + 10)).toBe(m);
    expect(pickLabel(placed, m.ax + 200, m.ay + 200)).toBeNull();
  });

  test('ranges and elevations read the way a hiker says them', () => {
    expect(fmtRange(4321)).toBe('4.3 km');
    expect(fmtRange(84500)).toBe('85 km');
    expect(fmtEle({ id: 'x', name: 'x', lon: 0, lat: 0, ele: 4477.5 })).toBe('4478 m');
    expect(fmtEle({ id: 'x', name: 'x', lon: 0, lat: 0, demEle: 4470 })).toBe('4470 m');
    expect(fmtEle({ id: 'x', name: 'x', lon: 0, lat: 0 })).toBe('');
  });
});
