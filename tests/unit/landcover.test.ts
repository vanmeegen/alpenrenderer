/**
 * Land cover: ESA WorldCover baked into small tiles (tools/landcover.mjs,
 * the pure parts of tools/build_landcover.mjs) and read back onto the
 * clipmap's grids (src/engine/sources/landcover.ts).
 */
import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { CLASSES, PIXEL_ZOOMS, classIndex, despeckle, encodeGray4, majority, mercatorTile, tileRange } from '../../tools/landcover.mjs';

/** A 4-bit greyscale PNG back to one value per pixel, the way a browser's decoder reads it (without the ×17). */
function decodeGray4(png: Uint8Array): { w: number; h: number; px: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8, w = 0, h = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = view.getUint32(o), type = String.fromCharCode(...png.slice(o + 4, o + 8));
    const body = png.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = view.getUint32(o + 8); h = view.getUint32(o + 12);
      expect(body[8]).toBe(4);      // bit depth
      expect(body[9]).toBe(0);      // greyscale
    }
    if (type === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(w / 2) + 1, px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    expect(raw[y * stride]).toBe(0);                    // filter: none
    for (let x = 0; x < w; x++) {
      const b = raw[y * stride + 1 + (x >> 1)];
      px[y * w + x] = x & 1 ? b & 15 : b >> 4;
    }
  }
  return { w, h, px };
}

describe('the classes', () => {
  test('WorldCover\'s codes map to a compact index that fits four bits, 0 for no data', () => {
    expect(classIndex(0)).toBe(0);
    expect(classIndex(255)).toBe(0);
    expect(classIndex(10)).toBe(1);
    expect(CLASSES.map((c) => c.code)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]);
    expect(CLASSES.map((c) => classIndex(c.code))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(CLASSES.map((c) => c.name)).toEqual(['tree', 'shrub', 'grass', 'crop', 'built', 'bare', 'snow', 'water', 'wetland', 'mangrove', 'moss']);
  });

  test('the shading palette names the same classes in the same order', async () => {
    const { COVER_CLASSES } = await import('../../src/engine/render/shading');
    expect(COVER_CLASSES).toEqual(['none', ...CLASSES.map((c) => c.name)]);
  });
});

describe('majority: the next coarser zoom', () => {
  test('each pixel takes the class most of its four children have; a tie goes to the first of them; no data only where there is none', () => {
    //  1 1 | 3 0      ->  1 | 3
    //  1 3 | 0 0
    //  ----+----
    //  6 3 | 0 0      ->  6 | 0
    //  3 6 | 0 0
    const src = Uint8Array.from([
      1, 1, 3, 0,
      1, 3, 0, 0,
      6, 3, 0, 0,
      3, 6, 0, 0,
    ]);
    expect(Array.from(majority(src, 4, 4))).toEqual([1, 3, 6, 0]);
  });
});

describe('despeckle: single pixels are noise at 53 m, lines and edges are not', () => {
  const grid = (rows: string[]) => Uint8Array.from(rows.join('').split('').map(Number));
  const show = (px: Uint8Array, w: number) => Array.from({ length: px.length / w }, (_, y) => Array.from(px.slice(y * w, (y + 1) * w)).join(''));

  test('a lone pixel takes the class around it; a line one pixel wide, a corner and an edge stay', () => {
    const before = [
      '3333311',
      '3133311',      // a lone tree in the meadow goes
      '3333311',      // the forest's edge on the right stays
      '8888811',      // a river one pixel wide stays
      '3333311',
      '3333331',      // a step in the edge stays
    ];
    expect(show(despeckle(grid(before), 7, 6), 7)).toEqual([
      '3333311',
      '3333311',
      '3333311',
      '8888811',
      '3333311',
      '3333331',
    ]);
  });

  test('no data is not filled in, and a lone pixel in no data stays', () => {
    const before = ['000', '030', '000'];
    expect(show(despeckle(grid(before), 3, 3), 3)).toEqual(before);
    expect(show(despeckle(grid(['333', '303', '333']), 3, 3), 3)).toEqual(['333', '303', '333']);
  });
});

describe('the tiles', () => {
  test('a 4-bit greyscale PNG holds every class as written', () => {
    const w = 37, h = 5, px = new Uint8Array(w * h);
    for (let i = 0; i < px.length; i++) px[i] = (i * 7) % 12;
    const back = decodeGray4(encodeGray4(px, w, h));
    expect(back.w).toBe(w);
    expect(back.h).toBe(h);
    expect(Array.from(back.px)).toEqual(Array.from(px));
  });

  test('a uniform tile is well under a kilobyte: the sea of forest costs next to nothing', () => {
    expect(encodeGray4(new Uint8Array(512 * 512).fill(1), 512, 512).length).toBeLessThan(1000);
  });

  test('tileRange: the tiles of one zoom that touch a box of longitudes and latitudes', () => {
    // 512 px tiles at tile zoom 10 are pixel zoom 11: 1024 tiles round the world.
    const r = tileRange([5, 43, 17, 49], 10);
    expect(r.x0).toBe(Math.floor(((5 + 180) / 360) * 1024));
    expect(r.x1).toBe(Math.floor(((17 + 180) / 360) * 1024));
    expect(r.y0).toBeLessThan(r.y1);                         // north first
    expect((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)).toBeGreaterThan(700);
    expect((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)).toBeLessThan(1100);
  });

  test('mercatorTile asks the source for the class at each pixel\'s centre, north at the top', () => {
    // A world that is forest north of 47° and grass south of it, crop east of 10°.
    const world = (lon: number, lat: number) => (lon >= 10 ? 4 : lat >= 47 ? 1 : 3);
    const z = 10, x = Math.floor(((9.9 + 180) / 360) * 1024);
    const s = Math.sin(47 * Math.PI / 180);
    const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 1024);
    const px = mercatorTile(world, z, x, y, 64);
    const classes = new Set(px);
    expect(classes.has(1) && classes.has(3) && classes.has(4)).toBe(true);
    // The first row is the tile's north edge: forest (or crop), never grass. The last is its south edge.
    expect(Array.from(px.slice(0, 64)).includes(3)).toBe(false);
    expect(Array.from(px.slice(63 * 64)).includes(1)).toBe(false);
    // Crop is on the right.
    expect(px[32 * 64 + 63]).toBe(4);
    expect(px[32 * 64]).not.toBe(4);
  });
});

describe('LandCover: the class of every post of a clipmap level', () => {
  /** A world of 512-px tiles in which every pixel's class follows from its own place: stripes 64 cover pixels wide. */
  const classAt = (pixelZoom: number, gx: number, gy: number) => 1 + ((Math.floor(gx / 64) + Math.floor(gy / 64) + pixelZoom) % 11);
  function world(asked: string[] = [], has: (z: number, x: number, y: number) => boolean = () => true) {
    return async (z: number, x: number, y: number) => {
      asked.push(`${z}/${x}/${y}`);
      if (!has(z, x, y)) return null;
      const t = new Uint8Array(512 * 512);
      for (let j = 0; j < 512; j++) for (let i = 0; i < 512; i++) t[j * 512 + i] = classAt(z + 1, x * 512 + i, y * 512 + j);
      return t;
    };
  }

  test('a level at one of the cover\'s own zooms reads its pixels one to one, from the tiles one zoom lower', async () => {
    const { LandCover } = await import('../../src/engine/sources/landcover');
    const asked: string[] = [];
    const cover = new LandCover(world(asked));
    const grid = { z: 9, px0: 135_000, py0: 91_000, w: 640, h: 640 };
    const got = (await cover.rasterize(grid))!;
    let bad = 0;
    for (let y = 0; y < 640; y += 7) for (let x = 0; x < 640; x += 5) if (got[y * 640 + x] !== classAt(9, grid.px0 + x, grid.py0 + y)) bad++;
    expect(bad).toBe(0);
    expect(new Set(asked.map((k) => k.split('/')[0]))).toEqual(new Set(['8']));
    expect(asked.length).toBeLessThanOrEqual(9);
  });

  test('a finer level reads the finest cover zoom, each cover pixel spread over the posts it covers', async () => {
    const { COVER_TILES, LandCover } = await import('../../src/engine/sources/landcover');
    // 106 m pixels at 47° north: the whole Alps in ten megabytes. At 53 m they were thirty-five.
    expect(COVER_TILES.maxZoom).toBe(10);
    expect({ max: COVER_TILES.maxZoom, min: COVER_TILES.minZoom }).toEqual(PIXEL_ZOOMS);   // what the tool writes
    const asked: string[] = [];
    const cover = new LandCover(world(asked));
    const grid = { z: 13, px0: 2_160_000, py0: 1_456_000, w: 640, h: 640 };
    const got = (await cover.rasterize(grid))!;
    let bad = 0;
    for (let y = 0; y < 640; y += 3) for (let x = 0; x < 640; x += 3) {
      if (got[y * 640 + x] !== classAt(10, Math.floor((grid.px0 + x) / 8), Math.floor((grid.py0 + y) / 8))) bad++;
    }
    expect(bad).toBe(0);
    // 640 posts are 80 cover pixels: one tile, two at a seam each way.
    expect(asked.every((k) => k.startsWith('9/'))).toBe(true);
    expect(asked.length).toBeLessThanOrEqual(4);
  });

  test('where the source has no tile the posts have no class; with no tile at all there is nothing to burn in', async () => {
    const { LandCover } = await import('../../src/engine/sources/landcover');
    const grid = { z: 10, px0: 270_000 + 200, py0: 182_000, w: 640, h: 640 };
    const seam = Math.ceil(grid.px0 / 512);                                    // the tile column the window runs into
    const half = new LandCover(world([], (_z, x) => x < seam));
    const got = (await half.rasterize(grid))!;
    expect(got[320 * 640 + 0]).toBeGreaterThan(0);
    expect(got[320 * 640 + 639]).toBe(0);
    expect(await new LandCover(world([], () => false)).rasterize(grid)).toBeNull();
  });

  test('a tile is asked for once, however many levels read it', async () => {
    const { LandCover } = await import('../../src/engine/sources/landcover');
    const asked: string[] = [];
    const cover = new LandCover(world(asked));
    const a = { z: 12, px0: 1_080_000, py0: 728_000, w: 640, h: 640 };
    await Promise.all([cover.rasterize(a), cover.rasterize({ ...a, z: 13, px0: a.px0 * 2, py0: a.py0 * 2 })]);
    expect(new Set(asked).size).toBe(asked.length);
  });

  test('a decoded PNG gives the classes back: index × 17 in the red channel, off by a little or not', async () => {
    const { classesFromRgba } = await import('../../src/engine/sources/landcover');
    const px = new Uint8ClampedArray([0, 0, 0, 255, 17, 17, 17, 255, 119, 119, 119, 255, 187 + 3, 187, 187, 255, 51 - 4, 51, 51, 255]);
    expect(Array.from(classesFromRgba(px, 5))).toEqual([0, 1, 7, 11, 3]);
  });
});
