/**
 * The aerial picture: satellite tiles read onto a clipmap level's grid at
 * half its resolution, for the shade pass to colour the ground by.
 */
import { describe, expect, test } from 'bun:test';
import { IMAGERY, Imagery, imageryZoom } from '../../src/engine/sources/imagery';

/** A world of 256-px tiles in which every pixel's colour follows from its own place and zoom. */
const colourAt = (zoom: number, gx: number, gy: number): [number, number, number] => [(gx * 7 + zoom) & 255, (gy * 5) & 255, (gx + gy) & 255];
function world(asked: string[] = [], has: (z: number, x: number, y: number) => boolean = () => true) {
  return async (z: number, x: number, y: number) => {
    asked.push(`${z}/${x}/${y}`);
    if (!has(z, x, y)) return null;
    const t = new Uint8ClampedArray(256 * 256 * 4);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const c = colourAt(z, x * 256 + i, y * 256 + j), o = (j * 256 + i) * 4;
      t[o] = c[0]; t[o + 1] = c[1]; t[o + 2] = c[2]; t[o + 3] = 255;
    }
    return t;
  };
}

describe('imageryZoom', () => {
  test('the picture is read one zoom below the level, and no finer than the satellite sees', () => {
    // Sentinel-2 has 10 m pixels: zoom 13 is 13 m at 47° north, anything finer would be the same picture enlarged.
    expect(IMAGERY.maxZoom).toBe(13);
    expect(imageryZoom(15)).toBe(13);
    expect(imageryZoom(14)).toBe(13);
    expect(imageryZoom(13)).toBe(12);
    expect(imageryZoom(8)).toBe(7);
  });
});

describe('Imagery: the colour of every other post of a clipmap level', () => {
  test('a level reads the tiles one zoom below it, one picture pixel for two posts each way', async () => {
    const asked: string[] = [];
    const im = new Imagery(world(asked));
    const grid = { z: 12, px0: 1_080_000, py0: 728_000, w: 640, h: 640 };
    const got = (await im.rasterize(grid))!;
    expect(got.length).toBe(320 * 320 * 4);
    let bad = 0;
    for (let j = 0; j < 320; j += 7) for (let i = 0; i < 320; i += 5) {
      const want = colourAt(11, grid.px0 / 2 + i, grid.py0 / 2 + j), o = (j * 320 + i) * 4;
      if (got[o] !== want[0] || got[o + 1] !== want[1] || got[o + 2] !== want[2] || got[o + 3] !== 255) bad++;
    }
    expect(bad).toBe(0);
    expect(asked.every((k) => k.startsWith('11/'))).toBe(true);
    expect(asked.length).toBeLessThanOrEqual(9);                 // 320 px across 256-px tiles: two or three each way
  });

  test('the near level, finer than the satellite, reads zoom 13 enlarged', async () => {
    const im = new Imagery(world());
    const grid = { z: 15, px0: 8_640_000, py0: 5_824_000, w: 640, h: 640 };
    const got = (await im.rasterize(grid))!;
    // A picture pixel of the level covers two posts: half a zoom-13 pixel. Neighbours two apart share one.
    const o = (100 * 320 + 100) * 4, want = colourAt(13, Math.floor((grid.px0 + 201) / 4), Math.floor((grid.py0 + 201) / 4));
    expect([got[o], got[o + 1], got[o + 2]]).toEqual(want);
  });

  test('where a tile is missing the picture is see-through there, and with no tile at all there is no picture', async () => {
    const grid = { z: 10, px0: 270_000, py0: 182_000, w: 640, h: 640 };
    const seam = Math.ceil(grid.px0 / 2 / 256);                  // the tile column the window runs into
    const half = new Imagery(world([], (_z, x) => x < seam));
    const got = (await half.rasterize(grid))!;
    expect(got[(160 * 320 + 0) * 4 + 3]).toBe(255);
    expect(got[(160 * 320 + 319) * 4 + 3]).toBe(0);
    expect(await new Imagery(world([], () => false)).rasterize(grid)).toBeNull();
  });

  test('a tile is asked for once, and a tile that failed is see-through, not an error', async () => {
    const asked: string[] = [];
    const im = new Imagery(world(asked));
    const a = { z: 12, px0: 1_080_000, py0: 728_000, w: 640, h: 640 };
    await Promise.all([im.rasterize(a), im.rasterize(a)]);
    expect(new Set(asked).size).toBe(asked.length);
    const failing = new Imagery(async () => { throw new Error('rate limited'); });
    expect(await failing.rasterize(a)).toBeNull();
  });
});
