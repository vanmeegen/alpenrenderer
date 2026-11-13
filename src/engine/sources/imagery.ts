/**
 * The aerial picture: a satellite mosaic laid over the terrain.
 *
 * Sentinel-2 cloudless by EOX (10 m pixels, the 2017 mosaic, CC BY 4.0) is
 * the one picture of the whole Alps that may be used without a key. Its
 * tiles are read onto a clipmap level's grid at half the level's
 * resolution: one picture pixel for two posts each way, from the tiles one
 * zoom below the level, and no finer than the satellite sees. That is
 * four to nine small tiles a level.
 *
 * The service is EOX's demonstration server: rate-limited, without
 * guarantee. So nothing here is an error. A tile that does not come is
 * see-through in the picture, and the shade pass draws the relief there.
 */

import { MaskGrid } from '../core/water';
import { pixelsOf } from './terrarium';

export const IMAGERY = {
  /** Pixels per tile side (the service's 256). */
  tile: 256,
  /** Finest zoom read: 13 m pixels at 47° north, the satellite's own 10 m. */
  maxZoom: 13,
  /** Posts of a level per picture pixel, each way. */
  shrink: 2,
  /** Decoded tiles kept (a quarter megabyte each). */
  keep: 64,
};

/** EOX's tile service, the 2017 mosaic in Web Mercator. */
export const IMAGERY_TEMPLATE = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/{z}/{y}/{x}.jpg';

/** The zoom the picture for a level at pixel zoom `z` is read at. */
export function imageryZoom(z: number): number {
  return Math.min(IMAGERY.maxZoom, z - 1);
}

/** One tile as RGBA pixels, row-major from the north-west corner; null where there is none. */
export type ImageryLoader = (z: number, x: number, y: number) => Promise<Uint8ClampedArray | null>;

/** Fetches and decodes tiles; anything that goes wrong is "no tile". */
export function urlImageryLoader(template = IMAGERY_TEMPLATE): ImageryLoader {
  return async (z, x, y) => {
    const res = await fetch(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    for (const how of ['bitmap', 'image'] as const) {
      try {
        const px = await pixelsOf(bytes, IMAGERY.tile, how);
        if (px) return px;
      } catch { /* the other decoder */ }
    }
    return null;
  };
}

export class Imagery {
  private tiles = new Map<string, Promise<Uint8ClampedArray | null>>();

  constructor(private readonly loader: ImageryLoader = urlImageryLoader()) {}

  private tile(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) { this.tiles.delete(key); this.tiles.set(key, t); return t; }   // most recently used last
    t = this.loader(z, x, y).catch(() => null);
    this.tiles.set(key, t);
    if (this.tiles.size > IMAGERY.keep) this.tiles.delete(this.tiles.keys().next().value!);
    return t;
  }

  /**
   * The picture for a level's grid: (w / 2) × (h / 2) RGBA pixels, alpha
   * 255 where a tile gave the colour and 0 where none came; null when none
   * came at all.
   */
  async rasterize(grid: MaskGrid): Promise<Uint8Array | null> {
    const zoom = imageryZoom(grid.z), scale = 2 ** (zoom - grid.z);
    const T = IMAGERY.tile, k = IMAGERY.shrink;
    const w = Math.floor(grid.w / k), h = Math.floor(grid.h / k);
    // The picture pixel under the middle of each output pixel's posts.
    const at = (p0: number, i: number) => Math.floor((p0 + k * i + k / 2) * scale);
    const tx0 = Math.floor(at(grid.px0, 0) / T), tx1 = Math.floor(at(grid.px0, w - 1) / T);
    const ty0 = Math.floor(at(grid.py0, 0) / T), ty1 = Math.floor(at(grid.py0, h - 1) / T);
    const cols = tx1 - tx0 + 1;
    const jobs: Promise<Uint8ClampedArray | null>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(this.tile(zoom, tx, ty));
    const tiles = await Promise.all(jobs);
    if (tiles.every((t) => !t)) return null;
    const out = new Uint8Array(w * h * 4);
    const cx = new Int32Array(w);
    for (let i = 0; i < w; i++) cx[i] = at(grid.px0, i);
    for (let j = 0; j < h; j++) {
      const cy = at(grid.py0, j), ty = Math.floor(cy / T), row = (cy - ty * T) * T;
      for (let i = 0; i < w; i++) {
        const tx = Math.floor(cx[i] / T);
        const t = tiles[(ty - ty0) * cols + (tx - tx0)];
        if (!t) continue;
        const s = (row + cx[i] - tx * T) * 4, o = (j * w + i) * 4;
        out[o] = t[s]; out[o + 1] = t[s + 1]; out[o + 2] = t[s + 2]; out[o + 3] = 255;
      }
    }
    return out;
  }
}
