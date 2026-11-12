/**
 * Does the clipmap fill correctly from 256- and 512-px tiles?
 *
 * A synthetic source hands back tiles whose every pixel encodes its own global
 * pixel coordinate at the level's pixel zoom. After a fill, every raster cell
 * of every level must hold exactly the value of the pixel it claims to be —
 * which catches an off-by-one in the tile-zoom mapping, a wrong tile origin,
 * or a blit that reads the tile with the wrong stride.
 */
import { describe, expect, test } from 'bun:test';
import { ClipmapStreamer, DEFAULT_CLIPMAP, LOW_CLIPMAP } from '../../src/engine/sources/clipmap';
import { TileKey, TileSource } from '../../src/engine/sources/types';
import { latToMercY, lonToMercX } from '../../src/engine/core/geodesy';

const LON = 10.98527, LAT = 47.42111;
// Below the 15 383 m that sixteen bits of quarter metres reach.
const value = (pz: number, gx: number, gy: number) => (pz * 7919 + gx * 31 + gy * 17) % 12000;

function syntheticSource(tileSize: number, asked: TileKey[] = []): TileSource {
  const shift = Math.round(Math.log2(tileSize / 256));
  return {
    name: `synthetic ${tileSize}`, tileSize, minZoom: 0, maxZoom: 20,
    async load(k) {
      asked.push(k);
      const pz = k.z + shift;
      const h = new Float32Array(tileSize * tileSize);
      for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
          h[y * tileSize + x] = value(pz, k.x * tileSize + x, k.y * tileSize + y);
        }
      }
      return h;
    },
  };
}

describe.each([256, 512])('clipmap fill from %i-px tiles', (tileSize) => {
  test('every level cell holds the pixel it claims to be', async () => {
    const asked: TileKey[] = [];
    const cfg = { size: 640, levels: [{ z: 14 }, { z: 13 }, { z: 10 }, { z: 7 }] };
    const streamer = new ClipmapStreamer(syntheticSource(tileSize, asked), cfg, LON, LAT);
    await streamer.setCenter(LON, LAT);
    const shift = Math.round(Math.log2(tileSize / 256));

    for (const lv of streamer.heightField.levels) {
      expect(lv.filled).toBe(true);
      let bad = 0;
      for (let y = 0; y < lv.h; y += 7) {
        for (let x = 0; x < lv.w; x += 5) {
          const expected = value(lv.z, lv.px0 + x, lv.py0 + y);
          const got = lv.raw[y * lv.w + x] * lv.quant + lv.bias;
          if (Math.abs(got - expected) > 0.5) bad++;
        }
      }
      expect(bad).toBe(0);
    }
    // Tiles were asked for at the source's tile zoom, never at the pixel zoom.
    const askedZooms = [...new Set(asked.map((k) => k.z))].sort((a, b) => a - b);
    expect(askedZooms).toEqual(cfg.levels.map((l) => l.z - shift).sort((a, b) => a - b));
    expect(streamer.progress.levelsReady).toBe(cfg.levels.length);
  });

  test('a 640-px window needs at most (640/T + 1)^2 tiles per level', async () => {
    const asked: TileKey[] = [];
    const cfg = { size: 640, levels: [{ z: 12 }] };
    const streamer = new ClipmapStreamer(syntheticSource(tileSize, asked), cfg, LON, LAT);
    await streamer.setCenter(LON, LAT);
    const perAxis = Math.ceil(640 / tileSize) + 1;
    expect(asked.length).toBeLessThanOrEqual(perAxis * perAxis);
  });
});

describe('how finely heights are held', () => {
  test('to a quarter of a metre: a LiDAR tile\'s decimetres are not rounded to whole metres', async () => {
    // Whole metres made terraces of every gentle slope: a step every 13 m
    // of ground on a 4° meadow, each one a facet with its own shade.
    const frac = (gx: number, gy: number) => 1500 + ((gx * 7 + gy * 3) % 40) * 0.11;
    const source: TileSource = {
      name: 'fine', tileSize: 512, minZoom: 0, maxZoom: 20,
      async load(k) {
        const h = new Float32Array(512 * 512);
        for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) h[y * 512 + x] = frac(k.x * 512 + x, k.y * 512 + y);
        return h;
      },
    };
    const s = new ClipmapStreamer(source, { size: 640, levels: [{ z: 13 }] }, LON, LAT);
    await s.setCenter(LON, LAT);
    const [lv] = s.heightField.levels;
    expect(lv.quant).toBe(0.25);
    let worst = 0;
    for (let y = 0; y < lv.h; y += 7) for (let x = 0; x < lv.w; x += 5) {
      worst = Math.max(worst, Math.abs(lv.raw[y * lv.w + x] * lv.quant + lv.bias - frac(lv.px0 + x, lv.py0 + y)));
    }
    expect(worst).toBeLessThanOrEqual(0.125 + 1e-6);
    expect(worst).toBeGreaterThan(0.05);                          // and it is a rounding, not a float
  });
});

describe('clipmap configurations', () => {
  test('default has nine levels 15..7 and two look levels 14, 13; low six levels 13..8 and look levels 13, 12', () => {
    // Pixel zoom 15 is 3.3 m posts for the kilometre around the standpoint, where a survey has them.
    expect(DEFAULT_CLIPMAP.levels.map((l) => l.z)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7]);
    expect(DEFAULT_CLIPMAP.look?.map((l) => l.z)).toEqual([14, 13]);
    expect(LOW_CLIPMAP.levels.map((l) => l.z)).toEqual([13, 12, 11, 10, 9, 8]);
    expect(LOW_CLIPMAP.look?.map((l) => l.z)).toEqual([13, 12]);
  });

  test('recentring only refetches levels whose window moved', async () => {
    const asked: TileKey[] = [];
    const streamer = new ClipmapStreamer(syntheticSource(512, asked),
      { size: 640, levels: [{ z: 12 }, { z: 8 }] }, LON, LAT);
    await streamer.setCenter(LON, LAT);
    const first = asked.length;
    // 5 km east: the z12 window follows, the z8 one (12 px of 640) does not.
    await streamer.setCenter(LON + 0.07, LAT);
    const z8 = asked.slice(first).filter((k) => k.z === 7).length;
    expect(z8).toBe(0);
    expect(asked.length).toBeGreaterThan(first);
  });

  test('planPreload never asks finer than the window covers', () => {
    const streamer = new ClipmapStreamer(syntheticSource(512), DEFAULT_CLIPMAP, LON, LAT);
    const keys = streamer.planPreload(LON, LAT, 150);
    const zooms = new Set(keys.map((k) => k.z));
    expect([...zooms].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(keys.length).toBeLessThan(120);
  });
});

describe('look levels: the telescope\'s fine windows around the point looked at', () => {
  const M_LON = 111320 * Math.cos((LAT * Math.PI) / 180);

  test('are cut around the look point on setLook, hold their pixels, are kept out of the eye levels and off the CPU, and are dropped on clearLook', async () => {
    const asked: TileKey[] = [];
    const cfg = { size: 640, levels: [{ z: 12 }, { z: 9 }], look: [{ z: 14 }] };
    const s = new ClipmapStreamer(syntheticSource(512, asked), cfg, LON, LAT);
    await s.setCenter(LON, LAT);
    const hf = s.heightField;
    expect(s.progress.levelsReady).toBe(2);
    expect(hf.eyeLevels().map((l) => l.z)).toEqual([12, 9]);
    const look = hf.levels.find((l) => l.role === 'look')!;
    expect(look.z).toBe(14);
    expect(look.filled).toBe(false);

    // Looking at a point 10 km east: the window is centred there, not on the observer.
    const target = { lon: LON + 10000 / M_LON, lat: LAT };
    const before = hf.height(target.lon, target.lat, 10000);
    const askedBefore = asked.length;
    await s.setLook(target.lon, target.lat);
    expect(look.filled).toBe(true);
    expect(look.px0 + 320).toBe(Math.round(lonToMercX(target.lon, 14)));
    expect(look.py0 + 320).toBe(Math.round(latToMercY(target.lat, 14)));
    expect(asked.length).toBeGreaterThan(askedBefore);
    let bad = 0;
    for (let y = 0; y < look.h; y += 7) for (let x = 0; x < look.w; x += 5) {
      if (Math.abs(look.raw[y * look.w + x] * look.quant + look.bias - value(14, look.px0 + x, look.py0 + y)) > 0.5) bad++;
    }
    expect(bad).toBe(0);
    // The eye's progress is untouched, and the CPU (labels, sightlines, the eye) never reads a look level.
    expect(s.progress.levelsReady).toBe(2);
    expect(hf.height(target.lon, target.lat, 10000)).toBe(before);
    expect(hf.groundAt(target.lon, target.lat)).toBe(before);

    // Looking a little aside stays inside the window: no refetch.
    const n = asked.length;
    await s.setLook(target.lon + 500 / M_LON, target.lat);
    expect(asked.length).toBe(n);
    // Looking well beyond it refetches around the new point.
    await s.setLook(target.lon + 3000 / M_LON, target.lat);
    expect(asked.length).toBeGreaterThan(n);

    s.clearLook();
    expect(look.filled).toBe(false);
  });
});

describe('moving the standpoint', () => {
  const M_LON = 111320 * Math.cos((LAT * Math.PI) / 180);
  const cells = (lv: { w: number; h: number; raw: Uint16Array; quant: number; bias: number; z: number; px0: number; py0: number }) => {
    let bad = 0;
    for (let y = 0; y < lv.h; y += 7) for (let x = 0; x < lv.w; x += 5) {
      if (Math.abs(lv.raw[y * lv.w + x] * lv.quant + lv.bias - value(lv.z, lv.px0 + x, lv.py0 + y)) > 0.5) bad++;
    }
    return bad;
  };
  /** A source whose tiles land only when `release()` is called. */
  function gated(asked: TileKey[] = []) {
    const inner = syntheticSource(512, asked);
    let open = true;
    let waiting: (() => void)[] = [];
    const source: TileSource = {
      ...inner,
      async load(k, signal) {
        if (!open) await new Promise<void>((r) => waiting.push(r));
        return inner.load(k, signal);
      },
    };
    return { source, hold() { open = false; }, release() { open = true; waiting.forEach((r) => r()); waiting = []; } };
  }

  test('a window stays where it is while the observer is within an eighth of it of its centre: no refetch, the eye moves inside it', async () => {
    const asked: TileKey[] = [];
    const s = new ClipmapStreamer(syntheticSource(512, asked), { size: 640, levels: [{ z: 12 }, { z: 8 }] }, LON, LAT);
    await s.setCenter(LON, LAT);
    const [fine] = s.heightField.levels;
    const px0 = fine.px0, reach = fine.maxRange, first = asked.length;
    // 1 km east: 38 px at z12, inside the 80 px the window tolerates.
    await s.setCenter(LON + 1000 / M_LON, LAT);
    expect(asked.length).toBe(first);
    expect(fine.px0).toBe(px0);
    expect(fine.filled).toBe(true);
    expect(s.heightField.lon).toBeCloseTo(LON + 1000 / M_LON, 9);
    expect(fine.maxRange).toBeLessThan(reach);                       // the eye is off-centre: the level reaches less far
    expect(fine.maxRange).toBeGreaterThan(reach * 0.8);
    expect(s.progress.levelsReady).toBe(2);
    // 5 km east: 190 px, the fine window follows; the z8 one (0.4 px) does not.
    await s.setCenter(LON + 5000 / M_LON, LAT);
    expect(asked.slice(first).some((k) => k.z === 11)).toBe(true);
    expect(asked.slice(first).some((k) => k.z === 7)).toBe(false);
    expect(fine.px0 + 320).toBe(Math.round(lonToMercX(LON + 5000 / M_LON, 12)));
    expect(cells(fine)).toBe(0);
  });

  test('a moved level is never the old terrain at the new place: far away it is empty until its tiles land', async () => {
    const g = gated();
    const s = new ClipmapStreamer(g.source, { size: 640, levels: [{ z: 12 }, { z: 9 }] }, LON, LAT);
    await s.setCenter(LON, LAT);
    g.hold();
    // 300 km east: no window covers the new standpoint.
    const far = LON + 300000 / M_LON;
    const moving = s.setCenter(far, LAT);
    await Promise.resolve();
    for (const lv of s.heightField.levels) expect(lv.filled).toBe(false);
    expect(s.progress.levelsReady).toBe(0);
    g.release();
    await moving;
    for (const lv of s.heightField.levels) {
      expect(lv.filled).toBe(true);
      expect(lv.px0 + 320).toBe(Math.round(lonToMercX(far, lv.z)));
      expect(cells(lv)).toBe(0);
    }
    expect(s.progress.levelsReady).toBe(2);
  });

  test('nearby, the old window is kept whole and in its own place until the new one is complete, then they swap', async () => {
    const g = gated();
    const s = new ClipmapStreamer(g.source, { size: 640, levels: [{ z: 12 }, { z: 9 }] }, LON, LAT);
    await s.setCenter(LON, LAT);
    const [fine] = s.heightField.levels;
    const px0 = fine.px0, version = fine.version;
    g.hold();
    const near = LON + 5000 / M_LON;                                 // 190 px at z12: beyond the hysteresis, inside the old window
    const moving = s.setCenter(near, LAT);
    await Promise.resolve();
    expect(fine.filled).toBe(true);
    expect(fine.px0).toBe(px0);                                      // not moved under its data
    expect(fine.version).toBe(version);
    expect(cells(fine)).toBe(0);
    expect(fine.maxRange).toBeGreaterThan(0);
    expect(s.progress.levelsReady).toBe(1);                          // the coarse level is in place, the fine one is on its way
    g.release();
    await moving;
    expect(fine.px0 + 320).toBe(Math.round(lonToMercX(near, 12)));
    expect(fine.version).toBeGreaterThan(version);
    expect(cells(fine)).toBe(0);
    expect(s.progress.levelsReady).toBe(2);
  });
});

describe('tiles that fail', () => {
  /** A source that rejects the first `failures` requests for every tile at tile zoom `tz`, and has no tile (null) where `absent` says so. */
  function flaky(tz: number, failures: number, asked: TileKey[], absent: (k: TileKey) => boolean = () => false): TileSource {
    const inner = syntheticSource(512);
    const seen = new Map<string, number>();
    return {
      ...inner,
      async load(k, signal) {
        asked.push(k);
        if (absent(k)) return null;
        const id = `${k.z}/${k.x}/${k.y}`, n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (k.z === tz && n <= failures) throw new Error('network');
        return inner.load(k, signal);
      },
    };
  }
  const cfg = { size: 640, levels: [{ z: 12 }, { z: 9 }] };
  const quick = { retryDelays: [0, 0] };

  test('a failed tile is asked again and the level fills; a tile the server does not have is asked once and its level is left out for good', async () => {
    const asked: TileKey[] = [];
    const s = new ClipmapStreamer(flaky(11, 2, asked), cfg, LON, LAT, quick);
    await s.setCenter(LON, LAT);
    expect(s.heightField.levels.every((l) => l.filled)).toBe(true);
    expect(s.progress.failed).toBe(0);
    const perTile = new Map<string, number>();
    for (const k of asked.filter((k) => k.z === 11)) perTile.set(`${k.x}/${k.y}`, (perTile.get(`${k.x}/${k.y}`) ?? 0) + 1);
    expect([...perTile.values()].every((n) => n === 3)).toBe(true);

    const once: TileKey[] = [];
    const t = new ClipmapStreamer(flaky(-1, 0, once, (k) => k.z === 11), cfg, LON, LAT, quick);
    await t.setCenter(LON, LAT);
    // No data at that zoom (Mapterhorn has the fine zooms only where a survey
    // exists): the level shows nothing rather than a pit 1000 m below the
    // sea where the tile would be, and the coarser one is drawn there.
    const [fine, coarse] = t.heightField.levels;
    expect(fine.filled).toBe(false);
    expect(coarse.filled).toBe(true);
    expect(t.progress.failed).toBe(0);                                 // nothing to retry
    expect(t.progress.empty).toBe(1);
    expect(t.progress.levelsReady).toBe(2);                            // and nothing to wait for
    const ids = once.filter((k) => k.z === 11).map((k) => `${k.x}/${k.y}`);
    expect(new Set(ids).size).toBe(ids.length);
    // Asked for the same place again, the answer is known.
    const n = once.length;
    await t.setCenter(LON, LAT);
    await t.retry();
    expect(once.length).toBe(n);
    expect(t.progress.empty).toBe(1);
  });

  test('where the source has only part of a window, the rest is filled from the coarser level: no pit, and the level is shown', async () => {
    // The fine zooms end where a survey ends. Standing near that edge, the
    // window is drawn from what there is, and the rest of it from the level
    // below, blended between its posts; the whole level used to be left out.
    const asked: TileKey[] = [];
    const cx = Math.round(lonToMercX(LON, 12)), T = 512;
    const eastOfCentre = (k: TileKey) => k.z === 11 && k.x * T >= cx;       // the tile columns east of the standpoint
    const s = new ClipmapStreamer(flaky(-1, 0, asked, eastOfCentre), cfg, LON, LAT, quick);
    await s.setCenter(LON, LAT);
    const [fine, coarse] = s.heightField.levels;
    expect(asked.some(eastOfCentre)).toBe(true);
    expect(fine.filled).toBe(true);
    expect(s.progress.empty).toBe(0);
    expect(s.progress.levelsReady).toBe(2);
    const at = (lv: typeof fine, x: number, y: number) => lv.raw[y * lv.w + x] * lv.quant + lv.bias;
    // West of the edge: the fine tiles' own pixels.
    expect(at(fine, 10, 320)).toBeCloseTo(value(12, fine.px0 + 10, fine.py0 + 320), 0);
    // East of it: what the coarse level holds there, between its posts.
    const x = fine.w - 10, y = 320;
    const shift = 2 ** (coarse.z - fine.z);
    const u = (fine.px0 + x + 0.5) * shift - 0.5 - coarse.px0, v = (fine.py0 + y + 0.5) * shift - 0.5 - coarse.py0;
    const u0 = Math.floor(u), v0 = Math.floor(v), tu = u - u0, tv = v - v0;
    const want = (at(coarse, u0, v0) * (1 - tu) + at(coarse, u0 + 1, v0) * tu) * (1 - tv)
      + (at(coarse, u0, v0 + 1) * (1 - tu) + at(coarse, u0 + 1, v0 + 1) * tu) * tv;
    expect(Math.abs(at(fine, x, y) - want)).toBeLessThan(0.3);
    expect(at(fine, x, y)).toBeGreaterThan(-900);
    // Known, not asked again.
    const n = asked.length;
    await s.setCenter(LON, LAT);
    expect(asked.length).toBe(n);
  });

  test('…but only from a coarser level that reaches across the window: one left behind at the old place is not stretched over it', async () => {
    // The coarse window could not follow (its tiles fail), and the observer
    // has moved 300 of its 640 px: it still reaches them, but not the far
    // side of the fine window around them.
    const asked: TileKey[] = [];
    const east = LON + 300 / ((256 * 2 ** 9) / 360);
    const cx = Math.round(lonToMercX(east, 12));
    let down = false;
    // The fine tiles from the boundary 98 px west of the new standpoint on are not there.
    const gone = (k: TileKey) => k.z === 11 && k.x * 512 >= cx - 100;
    const inner = flaky(-1, 0, asked, gone);
    const source: TileSource = { ...inner, async load(k, signal) { if (down && k.z === 8) throw new Error('network'); return inner.load(k, signal); } };
    const s = new ClipmapStreamer(source, cfg, LON, LAT, quick);
    await s.setCenter(LON, LAT);
    expect(s.heightField.levels.every((l) => l.filled)).toBe(true);
    down = true;
    await s.setCenter(east, LAT);
    const [fine, coarse] = s.heightField.levels;
    const fineAsked = asked.filter((k) => k.z === 11).slice(-4);
    expect(fineAsked.some(gone)).toBe(true);
    expect(fineAsked.every(gone)).toBe(false);           // part of the window is there
    expect(coarse.filled).toBe(true);                    // the old window, still under the observer
    expect(coarse.maxRange).toBeGreaterThan(0);
    expect(fine.filled).toBe(false);
    expect(s.progress.empty).toBe(1);
  });

  test('a tile that keeps failing leaves its level out, counted, instead of a pit 1000 m below sea level; retry() asks again', async () => {
    const asked: TileKey[] = [];
    const s = new ClipmapStreamer(flaky(11, 5, asked), cfg, LON, LAT, quick);
    await s.setCenter(LON, LAT);
    const [fine, coarse] = s.heightField.levels;
    expect(coarse.filled).toBe(true);
    expect(fine.filled).toBe(false);
    expect(s.progress.failed).toBeGreaterThan(0);
    expect(s.progress.levelsReady).toBe(1);
    expect(s.progress.pending).toBe(0);
    // The fourth and fifth request still fail, the sixth lands.
    await s.retry();
    expect(fine.filled).toBe(true);
    expect(s.progress.failed).toBe(0);
    expect(s.progress.levelsReady).toBe(2);
  });
});
