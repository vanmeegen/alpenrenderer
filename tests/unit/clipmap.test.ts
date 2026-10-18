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
const value = (pz: number, gx: number, gy: number) => (pz * 7919 + gx * 31 + gy * 17) % 50000;

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

describe('clipmap configurations', () => {
  test('default has eight levels 14..7 and two look levels 14, 13; low six levels 13..8 and look levels 13, 12', () => {
    expect(DEFAULT_CLIPMAP.levels.map((l) => l.z)).toEqual([14, 13, 12, 11, 10, 9, 8, 7]);
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
    // A few metres east: the z12 window moves by a pixel, the z8 one does not.
    await streamer.setCenter(LON + 0.0002, LAT);
    const z8 = asked.slice(first).filter((k) => k.z === 7).length;
    expect(z8).toBe(0);
    expect(asked.length).toBeGreaterThan(first);
  });

  test('planPreload never asks finer than the window covers', () => {
    const streamer = new ClipmapStreamer(syntheticSource(512), DEFAULT_CLIPMAP, LON, LAT);
    const keys = streamer.planPreload(LON, LAT, 150);
    const zooms = new Set(keys.map((k) => k.z));
    expect([...zooms].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
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
