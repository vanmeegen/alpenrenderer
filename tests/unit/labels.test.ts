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
import { RANK, buildTargets, fmtEle, fmtRange, labelCells, layout, layoutLabels, pickLabel, pinAt } from '../../src/engine/core/labels';
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
  // The wall ends eight posts short of the raster's edges: a summit search
  // cannot tell what lies beyond an edge and does not claim a top there.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw[y * w + x] = (y === wallRow && x >= 8 && x < w - 8 ? WALL : PLAIN) + 1000;
  }
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

  test('a summit catalogued on its flank is anchored on its top: where the pin points, not only how high', () => {
    // A fine level (13 m posts) with a ridge row 3 km north; the catalogue
    // point two posts south of it, on the flank. The pin goes to the ridge
    // row at the ridge's height, not to the flank point at the ridge's height
    // (a pin in the air beside the summit, or, lowered onto the drawn flank,
    // a pin in the slope).
    const fine = new HeightField(LON, LAT);
    const z = 13, w = 640, h = 640;
    const px0 = Math.round(lonToMercX(LON, z)) - w / 2, py0 = Math.round(latToMercY(LAT, z)) - h / 2;
    const ridgeRow = Math.round(latToMercY(north(3), z)) - py0;
    const raw = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = (y === ridgeRow && x >= 8 && x < w - 8 ? WALL : PLAIN) + 1000;
    fine.addLevel({ z, px0, py0, w, h, quant: 1, bias: -1000 }, raw, true);
    const ridgeLat = mercYToLat(py0 + ridgeRow + 0.5, z);
    const flankLat = mercYToLat(py0 + ridgeRow + 2 + 0.5, z);
    const asked: number[] = [];
    const t = buildTargets([{ id: 'p', name: 'Flankenpunkt', lon: LON, lat: flankLat }], obs, fine, fine.maxRange,
      (lon, lat) => { asked.push(lat); return { lon, lat, h: WALL }; });
    expect(t[0].anchorAlt).toBe(WALL);
    expect(t[0].north).toBeCloseTo((ridgeLat - LAT) * M_PER_DEG_LAT, -1);   // on the ridge row, not 26 m short of it
    for (const x of t) x.visible = true;
    layoutLabels(t, camera(0), opt());
    expect(asked.length).toBe(1);
    expect(asked[0]).toBeCloseTo(ridgeLat, 6);                            // the drawn surface is asked at the top
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

  test('a lake whose centre is in view but out of the frame is named on the part that is in the frame', () => {
    // A lake 10 km long from west to east, 3 km north: looking north-east
    // with a narrow lens its centre is left of the frame, its eastern end is
    // in it. The name used to stay with the centre and never showed.
    const ring = [east(-5), north(2.6), east(5), north(2.6), east(5), north(3.4), east(-5), north(3.4)];
    const lake = lakeLabel({ id: 'osm:relation/7', name: 'Quersee', lon: LON, lat: north(3), area: 8e6, rings: [ring] });
    expect(lake.spots?.length).toBeGreaterThan(0);
    const t = buildTargets([lake], obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const spare = t.filter((x) => x.spot > 0).sort((a, b) => b.bearing - a.bearing)[0];   // the easternmost spare spot
    expect(spare.bearing).toBeGreaterThan(15);
    const cam = camera(spare.bearing);
    cam.set({ fov: 12 });
    cam.update();
    const placed = layoutLabels(t, cam, opt());
    expect(placed.map((p) => p.target.peak.name)).toEqual(['Quersee']);
    expect(placed[0].target.spot).toBeGreaterThan(0);
    expect(placed[0].ax).toBeGreaterThan(0);
    expect(placed[0].ax).toBeLessThan(1000);
    // Looking at the centre, the centre has it, as before.
    expect(layoutLabels(t, camera(0), opt())[0].target.spot).toBe(0);
  });

  test('a summit beyond the range is dropped before its top is searched for in the DEM', () => {
    // The search reads a few hundred posts; the catalogue holds tens of thousands of summits out of range.
    let searched = 0;
    const counting = Object.create(hf) as HeightField;
    counting.summitAt = (lon: number, lat: number, radius?: number) => { searched++; return hf.summitAt(lon, lat, radius); };
    const t = buildTargets(peaks, obs, counting, hf.maxRange);
    expect(t.map((x) => x.peak.name)).not.toContain('Fernberg');
    expect(searched).toBe(peaks.length - 1);
  });

  test('with the drawn surface given, a label on screen goes onto the drawn top, where and how high; only labels on screen pay for it', () => {
    // The mesh draws the wall's top 40 m lower and one DEM row (420 m) nearer
    // than the DEM holds it: the pin goes there, exactly onto the drawn top.
    const nearerLat = mercYToLat(latToMercY(wallLat, 8) + 1, 8);
    const asked: string[] = [];
    const drawn = (lon: number, lat: number) => { asked.push(`${lon.toFixed(4)},${lat.toFixed(4)}`); return { lon, lat: nearerLat, h: WALL - 40 }; };
    const lake = lakeLabel({ id: 'osm:way/2', name: 'Nordsee', lon: LON + 0.001, lat: north(4), rings: [] });
    const t = buildTargets([...peaks, lake], obs, hf, hf.maxRange, drawn);
    expect(asked.length).toBe(0);                                  // nothing computed up front
    for (const x of t) x.visible = x.peak.id !== 'behind';         // the Hinterhorn is hidden behind the wall
    const placed = layoutLabels(t, camera(0), opt());
    const wall = placed.find((p) => p.target.peak.id === 'wall')!;
    expect(wall.target.anchorAlt).toBe(WALL - 40);
    const range = (nearerLat - LAT) * M_PER_DEG_LAT;
    expect(wall.target.range).toBeCloseTo(range, -1);
    const drop = (range * range) / (2 * (6371008.8 / 0.87));
    const elev = Math.atan2(WALL - 40 - PLAIN - 1.7 - drop, range);
    expect(wall.ay).toBeCloseTo(300 - 300 * Math.tan(elev) / Math.tan(Math.PI / 6), 0);
    // The lake keeps its water; the Osthügel, off to the east, was never asked
    // about, nor the Hinterhorn, which is hidden.
    expect(placed.find((p) => p.target.peak.id === 'osm:way/2')!.target.anchorAlt).toBeCloseTo(PLAIN, 0);
    expect(asked.length).toBe(1);
    // Asked once, remembered: a second frame asks nothing.
    layoutLabels(t, camera(0), opt());
    expect(asked.length).toBe(1);
    // A new wedge (the mesh follows the view) draws the summit elsewhere: asked again, once.
    layoutLabels(t, camera(0), { ...opt(), drawnKey: 'wedge-2' });
    expect(asked.length).toBe(2);
    layoutLabels(t, camera(0), { ...opt(), drawnKey: 'wedge-2' });
    expect(asked.length).toBe(2);
  });

  test('without any prominence known, the nearest summit comes first', () => {
    // None of these has a prominence: all rank 0, and the tie goes to the near one.
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

  test('summits in neighbouring cells whose names would overlap stack without overlapping, and maxLabels caps the count', () => {
    // Three summits on the wall 13° apart (150 px at 60°, one cell each) with
    // names 190 px wide: the boxes collide and are stacked, none is dropped.
    const off = 8000 * Math.tan((13.2 * Math.PI) / 180) / M_PER_DEG_LON;
    const twins: Peak[] = [
      { id: 'a', name: 'Zwilling Alpha im Westen', lon: LON - off, lat: wallLat, ele: 2650 },
      { id: 'b', name: 'Zwilling Beta in der Mitte', lon: LON, lat: wallLat, ele: 2640 },
      { id: 'c', name: 'Zwilling Gamma im Osten', lon: LON + off, lat: wallLat, ele: 2630 },
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

  test('with room for one label the summit that looks biggest gets it; zoomed past it, the next in frame does', () => {
    // A hill without known prominence 3 km east and a 4000er with 2500 m of
    // it 6 km out at 97°: the 4000er looks biggest from here and is named
    // first; zoomed in on 90°, it leaves the frame and the hill is named.
    const pair: Peak[] = [
      { id: 'near', name: 'Nahkopf', lon: east(3), lat: LAT, ele: 1510 },
      { id: 'famous', name: 'Fernhorn', lon: LON + (6000 * Math.sin((97 * Math.PI) / 180)) / M_PER_DEG_LON, lat: LAT + (6000 * Math.cos((97 * Math.PI) / 180)) / M_PER_DEG_LAT, ele: 4000, prom: 2500 },
    ];
    const t = buildTargets(pair, obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    expect(layoutLabels(t, camera(90), opt(1000, 600, 1)).map((p) => p.target.peak.id)).toEqual(['famous']);
    const cam = new Camera();
    cam.aspect = 1000 / 600;
    cam.set({ yaw: 90, pitch: 0, fov: 5 });
    cam.update();
    expect(layoutLabels(t, cam, opt(1000, 600, 1)).map((p) => p.target.peak.id)).toEqual(['near']);
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

describe('which summits get the room: how big they look, how well known, whether they stand on the skyline', () => {
  // Rank = the angle a summit's own rise (its prominence) takes up from here,
  // atan(prominence / range): the hill in front beats the famous summit far
  // behind it, the 4000er beats the knoll at the foot of the hill (PeakVisor
  // ranks by prominence; OpenTopoMap thins by isolation and zoom). Not
  // height, not distance alone.
  const ranked: Peak[] = [
    { id: 'knoll', name: 'Buckel', lon: east(1), lat: LAT, ele: 1530, prom: 30 },
    { id: 'hill', name: 'Hügel', lon: east(7), lat: LAT, ele: 1900, prom: 400 },
    { id: 'big', name: 'Großer', lon: east(20), lat: LAT, ele: 2500, prom: 1000 },
    { id: 'giant', name: 'Riese', lon: east(25), lat: LAT, ele: 4000, prom: 1700 },
    { id: 'nameless', name: 'Ohne Schartenhöhe', lon: east(3), lat: LAT, ele: 1600 },
  ];

  test('orders by apparent prominence; a summit whose prominence nobody recorded counts as a 25 m knoll, not as nothing', () => {
    const t = buildTargets(ranked, obs, hf, hf.maxRange);
    expect(t.map((x) => x.peak.id)).toEqual(['giant', 'hill', 'big', 'knoll', 'nameless']);
    const giant = t.find((x) => x.peak.id === 'giant')!;
    expect(giant.rank).toBeCloseTo(Math.atan2(1700, giant.range), 6);
    // Rank 0 put four fifths of the catalogue after every lake and every knoll with a number.
    const nameless = t.find((x) => x.peak.id === 'nameless')!;
    expect(nameless.rank).toBeCloseTo(Math.atan2(RANK.defaultProm, nameless.range), 6);
  });

  test('a summit people have written about counts for more: half again with a Wikipedia article, a fifth with a Wikidata entry', () => {
    const three: Peak[] = [
      { id: 'plain', name: 'Namenlos', lon: east(10), lat: north(1), ele: 2000, prom: 300 },
      { id: 'data', name: 'Erfasst', lon: east(10), lat: north(2), ele: 2000, prom: 300, tags: { wikidata: 'Q1' } },
      { id: 'wiki', name: 'Bekannt', lon: east(10), lat: north(3), ele: 2000, prom: 300, tags: { wikidata: 'Q2', wikipedia: 'de:Bekannt' } },
    ];
    const t = Object.fromEntries(buildTargets(three, obs, hf, hf.maxRange).map((x) => [x.peak.id, x]));
    expect(t.data.rank / Math.atan2(300, t.data.range)).toBeCloseTo(RANK.wikidata, 6);
    expect(t.wiki.rank / Math.atan2(300, t.wiki.range)).toBeCloseTo(RANK.wikipedia, 6);
    expect(t.plain.rank).toBeCloseTo(Math.atan2(300, t.plain.range), 6);
    expect(RANK.wikipedia).toBe(1.5);
    expect(RANK.wikidata).toBe(1.2);
  });

  test('a lake ranks by the angle its width takes up', () => {
    const lake = lakeLabel({ id: 'osm:way/5', name: 'Rundsee', lon: east(5), lat: LAT, area: 1e6, rings: [] });
    const t = buildTargets([lake], obs, hf, hf.maxRange);
    expect(t[0].rank).toBeCloseTo(Math.atan2(1000, t[0].range), 6);
  });

  test('in one patch of sky the summit on the skyline is named before a bigger-looking one in front of a wall', () => {
    const two: Peak[] = [
      { id: 'front', name: 'Vorberg', lon: east(10), lat: LAT, ele: 1900, prom: 400 },
      { id: 'sky', name: 'Himmelskopf', lon: east(10.2), lat: LAT, ele: 1950, prom: 300 },
    ];
    const t = buildTargets(two, obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    expect(layoutLabels(t, camera(90), opt()).map((p) => p.target.peak.id)).toEqual(['front']);
    t.find((x) => x.peak.id === 'sky')!.skyline = true;
    expect(RANK.skyline * 300).toBeGreaterThan(400);
    expect(layoutLabels(t, camera(90), opt()).map((p) => p.target.peak.id)).toEqual(['sky']);
  });
});

describe('where the labels go: one per patch of sky, the same ones while the view pans', () => {
  /** Summits on the plain at given bearings, 10 km out, each bigger-looking than the next. */
  const row = (bearings: number[]): Peak[] => bearings.map((deg, i) => {
    const brg = (deg * Math.PI) / 180;
    return { id: `s${i}`, name: `Spitze ${i}`, lon: LON + (10000 * Math.sin(brg)) / M_PER_DEG_LON, lat: LAT + (10000 * Math.cos(brg)) / M_PER_DEG_LAT, ele: 1500, prom: 300 - i };
  });
  const cam = (yaw: number, fov = 60) => {
    const c = new Camera();
    c.aspect = 1000 / 600;
    c.set({ yaw, pitch: 0, fov });
    c.update();
    return c;
  };

  test('a cell is a patch of sky about one label wide; its size steps by √2 with the field of view', () => {
    const wide = labelCells(cam(90), opt());
    // 87.8° across 1000 px, a cell 9 line heights = 144 px: 12.6°, on the √2 ladder 11.3°.
    expect(wide.bearing).toBeCloseTo(Math.SQRT2 ** 7, 6);
    expect(labelCells(cam(90, 57), opt()).bearing).toBe(wide.bearing);     // a small zoom keeps the cells
    expect(labelCells(cam(90, 30), opt()).bearing).toBeCloseTo(Math.SQRT2 ** 6, 6);
    expect(wide.elevation).toBeCloseTo(Math.SQRT2 ** 5, 6);                // 48 px of 600 over 60°: 4.8°, on the ladder 5.7°
  });

  test('eight summits 5° apart: one name per cell, more of them when zoomed in', () => {
    const t = buildTargets(row([72, 77, 82, 87, 92, 97, 102, 107]), obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const cellsOf = (c: Camera) => new Set(t.map((x) => Math.floor(x.bearing / labelCells(c, opt()).bearing))).size;
    const wide = layoutLabels(t, cam(90), { ...opt(), maxLabels: 50 });
    expect(wide.length).toBe(cellsOf(cam(90)));
    expect(wide.length).toBe(4);
    const narrow = layoutLabels(t, cam(90, 30), { ...opt(), maxLabels: 50 });
    expect(narrow.length).toBe(cellsOf(cam(90, 30)));
    expect(narrow.length).toBeGreaterThan(wide.length);
  });

  test('panning a third of a cell keeps the labels: the cells are fixed in the sky, not on the screen', () => {
    // On a grid fixed to the screen each summit changed its cell as the view
    // turned, and with it the winner of the cell: names came and went.
    const t = buildTargets(row([60, 64, 69, 75, 80, 86, 91, 95, 101, 106, 112, 117]), obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const names = (yaw: number) => layoutLabels(t, cam(yaw), { ...opt(), maxLabels: 50 }).map((p) => p.target.peak.id).sort();
    const at = names(88);
    const step = labelCells(cam(88), opt()).bearing / 3;
    expect(names(88 + step)).toEqual(at);
    expect(names(88 - step)).toEqual(at);
    expect(at.length).toBeGreaterThan(3);
  });

  test('the best summit of a cell that is out of the frame leaves the cell unnamed rather than hand it to the next for a moment', () => {
    // 80° and 84° share a cell (79.2° to 90.5°). Looking at 130°, the left edge of the frame is at 86°.
    const t = buildTargets(row([80, 89]), obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    expect(Math.floor(80 / labelCells(cam(130), opt()).bearing)).toBe(Math.floor(89 / labelCells(cam(130), opt()).bearing));
    expect(layoutLabels(t, cam(130), opt())).toEqual([]);
    expect(layoutLabels(t, cam(90), opt()).map((p) => p.target.peak.id)).toEqual(['s0']);
  });

  test('a label the stack cannot place leaves its cell to the next summit in it', () => {
    // Two summits a degree apart, in one cell.
    const two: Peak[] = [
      { id: 'minor', name: 'Nebengipfel', lon: LON + (10000 * Math.sin((89 * Math.PI) / 180)) / M_PER_DEG_LON, lat: LAT + (10000 * Math.cos((89 * Math.PI) / 180)) / M_PER_DEG_LAT, ele: 1800, prom: 50 },
      { id: 'major', name: 'Hauptgipfel', lon: east(10), lat: LAT, ele: 1900, prom: 600 },
    ];
    const t = buildTargets(two, obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    expect(layoutLabels(t, camera(90), opt()).map((p) => p.target.peak.id)).toEqual(['major']);
    // A panel over the major one's summit: it gets no label, the minor one does.
    const major = t.find((x) => x.peak.id === 'major')!;
    const ndc = new Float32Array(3);
    camera(90).project(major.east, major.north, major.up, ndc);
    const ax = (ndc[0] * 0.5 + 0.5) * 1000, ay = (1 - (ndc[1] * 0.5 + 0.5)) * 600;
    const blocked = [{ x: ax - 3, y: ay - 3, w: 6, h: 6 }];
    const placed = layoutLabels(t, camera(90), { ...opt(), blocked });
    expect(placed.map((p) => p.target.peak.id)).toEqual(['minor']);
  });

  test('a summit never loses its cell to a lake, and the lakes share a seventh of the labels at most', () => {
    const lakes = [0, 1, 2, 3, 4, 5].map((i) => lakeLabel({
      id: `osm:way/${i}`, name: `See ${i}`, lon: LON + (4000 * Math.sin(((65 + 10 * i) * Math.PI) / 180)) / M_PER_DEG_LON,
      lat: LAT + (4000 * Math.cos(((65 + 10 * i) * Math.PI) / 180)) / M_PER_DEG_LAT, area: 4e6, rings: [],
    }));
    const summit: Peak = { id: 'top', name: 'Seekopf', lon: lakes[2].lon, lat: lakes[2].lat, ele: 1500, prom: 20 };
    const t = buildTargets([...lakes, summit], obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    // The lake looks 25 times as big as the knoll in the same spot, and used to take the name.
    const placed = layoutLabels(t, camera(90), { ...opt(), maxLabels: 14 });
    const ids = placed.map((p) => p.target.peak.id);
    expect(ids).toContain('top');
    expect(ids).not.toContain('osm:way/2');
    expect(placed.filter((p) => p.target.peak.kind === 'lake').length).toBe(2);   // a seventh of 14
  });

  test('label boxes keep clear of the panels on the screen, and a summit under a panel is not named', () => {
    const t = buildTargets(row([84, 96]), obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const free = layoutLabels(t, cam(90), opt());
    expect(free.length).toBe(2);
    const [a, b] = free;
    // A panel exactly where a's box went: the box moves clear of it, the pin stays.
    const overBox = [{ x: a.bx - 2, y: a.by - 2, w: a.bw + 4, h: a.bh + 4 }];
    const moved = layoutLabels(t, cam(90), { ...opt(), blocked: overBox }).find((p) => p.target === a.target)!;
    expect(moved.ax).toBe(a.ax);
    const r = overBox[0];
    expect(moved.bx < r.x + r.w && moved.bx + moved.bw > r.x && moved.by < r.y + r.h && moved.by + moved.bh > r.y).toBe(false);
    // A panel over b's summit: b is not named, a still is.
    const overPin = [{ x: b.ax - 20, y: b.ay - 20, w: 40, h: 40 }];
    expect(layoutLabels(t, cam(90), { ...opt(), blocked: overPin }).map((p) => p.target.peak.id)).toEqual([a.target.peak.id]);
  });

  test('next to a tall panel the box moves sideways, clear of it and still over its summit, rather than down below the panel', () => {
    // The menu rail at the left edge, 38 px wide and 320 px tall, and a summit 30 px to the right of it.
    const rail = { x: 8, y: 8, w: 38, h: 320 };
    const t = buildTargets(row([90]), obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    // Looking so far right that the summit is 76 px from the left edge.
    const free = layoutLabels(t, cam(90), opt())[0];
    const hfov = 2 * Math.atan(Math.tan(Math.PI / 6) * (1000 / 600));
    const yaw = 90 + (Math.atan((1 - 76 / 500) * Math.tan(hfov / 2)) * 180) / Math.PI;
    const p = layoutLabels(t, cam(yaw), { ...opt(), blocked: [rail] })[0];
    expect(Math.abs(p.ax - 76)).toBeLessThan(1);
    expect(p.bx).toBeGreaterThanOrEqual(rail.x + rail.w);          // beside the rail
    expect(p.bx).toBeLessThanOrEqual(p.ax);                         // still over its summit
    expect(Math.abs(p.by - free.by)).toBeLessThan(1);               // at the height it would have had
  });

  test('labels that stood last time are placed first: a change of rank does not reshuffle the stack', () => {
    // Two summits 3° apart at the edge of two cells, names too wide to stand side by side: one box is stacked over the other.
    const t = buildTargets([
      { id: 'a', name: 'Der erste lange Gipfelname', lon: LON + (10000 * Math.sin((89.5 * Math.PI) / 180)) / M_PER_DEG_LON, lat: LAT + (10000 * Math.cos((89.5 * Math.PI) / 180)) / M_PER_DEG_LAT, ele: 1500, prom: 300 },
      { id: 'b', name: 'Der zweite lange Gipfelname', lon: LON + (10000 * Math.sin((92.5 * Math.PI) / 180)) / M_PER_DEG_LON, lat: LAT + (10000 * Math.cos((92.5 * Math.PI) / 180)) / M_PER_DEG_LAT, ele: 1500, prom: 290 },
    ], obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const first = layoutLabels(t, cam(90), opt());
    expect(first.map((p) => p.target.peak.id)).toEqual(['a', 'b']);
    const boxOf = (placed: typeof first, id: string) => { const p = placed.find((q) => q.target.peak.id === id)!; return [p.bx, p.by]; };
    expect(boxOf(first, 'a')[1]).not.toBe(boxOf(first, 'b')[1]);            // stacked
    // b turns out to stand on the skyline: it now ranks first.
    t.find((x) => x.peak.id === 'b')!.skyline = true;
    const reshuffled = layoutLabels(t, cam(90), opt());
    expect(boxOf(reshuffled, 'a')).not.toEqual(boxOf(first, 'a'));
    const kept = layoutLabels(t, cam(90), { ...opt(), previous: first });
    expect(boxOf(kept, 'a')).toEqual(boxOf(first, 'a'));
    expect(boxOf(kept, 'b')).toEqual(boxOf(first, 'b'));
  });

  test('how many visible summits in the frame went without a name is counted', () => {
    const t = buildTargets(row([72, 77, 82, 87, 92, 97, 102, 107]), obs, hf, hf.maxRange);
    for (const x of t) x.visible = true;
    const r = layout(t, cam(90), { ...opt(), maxLabels: 50 });
    expect(r.placed.length).toBe(4);
    expect(r.inFrame).toBe(8);
  });
});

describe('a pin moved onto the visible edge of its own mountain', () => {
  test('settles on the drawn surface there and keeps the summit\'s range', () => {
    // The horizon march found the Mauerspitze hidden behind its own edge
    // one DEM row nearer (horizon.ts ownCrest) and pins the label there:
    // the drawn surface is asked at the edge, the text keeps the summit's range.
    const edgeLat = mercYToLat(latToMercY(wallLat, 8) + 1, 8);
    const asked: number[] = [];
    const drawn = (lon: number, lat: number) => { asked.push(lat); return { lon, lat, h: WALL - 40 }; };
    const t = buildTargets(peaks, obs, hf, hf.maxRange, drawn);
    const wall = t.find((x) => x.peak.id === 'wall')!;
    const summitRange = wall.range, summitBearing = wall.bearing, summitRank = wall.rank;
    pinAt(wall, { lon: LON, lat: edgeLat, h: WALL - 60 }, { lon: LON, lat: LAT, alt: PLAIN + 1.7 });
    expect(wall.atCrest).toBe(true);
    expect(wall.anchor.lat).toBeCloseTo(edgeLat, 9);
    expect(wall.anchorAlt).toBe(WALL - 60);
    expect(wall.north).toBeCloseTo((edgeLat - LAT) * M_PER_DEG_LAT, -1);
    expect(wall.range).toBe(summitRange);
    expect(wall.bearing).toBe(summitBearing);
    expect(wall.rank).toBe(summitRank);
    for (const x of t) x.visible = true;
    const placed = layoutLabels(t, camera(0), opt());
    const p = placed.find((x) => x.target.peak.id === 'wall')!;
    expect(asked).toContain(edgeLat);               // the drawn surface at the edge ...
    expect(asked).not.toContain(wallLat);           // ... not at the summit (the Hinterhorn, now in its own cell, is asked too)
    expect(p.target.anchorAlt).toBe(WALL - 40);     // as drawn there
    expect(p.target.range).toBe(summitRange);       // the text still says how far the summit is
  });
});

