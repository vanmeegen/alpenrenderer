/**
 * Land cover: what grows or lies on the ground, per DEM post.
 *
 * The heights say how the ground is shaped, not what it is. ESA WorldCover
 * (10 m, 2021) says forest, meadow, rock, ice, village; baked into small
 * tiles at build time (tools/build_landcover.mjs: 106 m pixels, coarser
 * zooms by majority) it is served next to the app like the summits and
 * lakes. Here the tiles are read back onto a clipmap level's grid, one
 * class per post, for the shade pass to colour by (render/shading.ts).
 *
 * A tile is a 4-bit greyscale PNG: the class index 0..11 a pixel, 0 where
 * there is no data. Tiles are 512 px and named by tile zoom, one below the
 * pixel zoom, like the terrain's.
 */

import { MaskGrid } from '../core/water';
import { pixelsOf } from './terrarium';

export const COVER_TILES = {
  /** Pixels per tile side. */
  tile: 512,
  /** Pixel zooms the tiles exist at: 106 m pixels (at 47° north) down to 850 m. */
  maxZoom: 10,
  minZoom: 7,
  /** Decoded tiles kept (a quarter megabyte each). */
  keep: 48,
};

export const COVER_TEMPLATE = 'landcover/{z}/{x}/{y}.png';

/** One tile's classes, row-major from the north-west corner; null where the source has none. Zoom is the tile zoom. */
export type CoverLoader = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

/** The class indices out of a decoded tile's RGBA pixels: a 4-bit grey comes back as index × 17. */
export function classesFromRgba(px: Uint8ClampedArray, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(px[i * 4] / 17);
  return out;
}

/** Fetches and decodes tiles; a missing tile (outside the survey) is null, as is one that cannot be read. */
export function urlCoverLoader(template = COVER_TEMPLATE): CoverLoader {
  return async (z, x, y) => {
    const res = await fetch(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const n = COVER_TILES.tile;
    for (const how of ['bitmap', 'image'] as const) {
      try {
        const px = await pixelsOf(bytes, n, how);
        if (px) return classesFromRgba(px, n * n);
      } catch { /* the other decoder */ }
    }
    return null;
  };
}

export class LandCover {
  private tiles = new Map<string, Promise<Uint8Array | null>>();

  constructor(private readonly loader: CoverLoader = urlCoverLoader()) {}

  private tile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) { this.tiles.delete(key); this.tiles.set(key, t); return t; }   // most recently used last
    t = this.loader(z, x, y).catch(() => null);
    this.tiles.set(key, t);
    if (this.tiles.size > COVER_TILES.keep) this.tiles.delete(this.tiles.keys().next().value!);
    return t;
  }

  /**
   * The class of every post of a level's grid, or null when the source has
   * nothing for it. A level at one of the cover's zooms reads its pixels one
   * to one; a finer one reads the finest cover zoom, each cover pixel spread
   * over the posts it covers.
   */
  async rasterize(grid: MaskGrid): Promise<Uint8Array | null> {
    const zoom = Math.min(COVER_TILES.maxZoom, Math.max(COVER_TILES.minZoom, grid.z));
    const scale = 2 ** (zoom - grid.z);                // cover pixels per post
    const T = COVER_TILES.tile;
    const at = (p: number) => Math.floor((p + 0.5) * scale);
    const x0 = at(grid.px0), x1 = at(grid.px0 + grid.w - 1), y0 = at(grid.py0), y1 = at(grid.py0 + grid.h - 1);
    const tx0 = Math.floor(x0 / T), tx1 = Math.floor(x1 / T), ty0 = Math.floor(y0 / T), ty1 = Math.floor(y1 / T);
    const cols = tx1 - tx0 + 1;
    const jobs: Promise<Uint8Array | null>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(this.tile(zoom - 1, tx, ty));
    const tiles = await Promise.all(jobs);
    if (tiles.every((t) => !t)) return null;
    const out = new Uint8Array(grid.w * grid.h);
    // The cover column of every post column, once.
    const cx = new Int32Array(grid.w);
    for (let x = 0; x < grid.w; x++) cx[x] = at(grid.px0 + x);
    for (let y = 0; y < grid.h; y++) {
      const cy = at(grid.py0 + y), ty = Math.floor(cy / T), row = (cy - ty * T) * T;
      for (let x = 0; x < grid.w; x++) {
        const tx = Math.floor(cx[x] / T);
        const t = tiles[(ty - ty0) * cols + (tx - tx0)];
        if (t) out[y * grid.w + x] = t[row + cx[x] - tx * T];
      }
    }
    return out;
  }
}
