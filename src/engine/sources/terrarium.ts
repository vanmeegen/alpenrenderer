/**
 * Terrarium-encoded raster tiles over HTTP.
 *
 * height = R*256 + G + B/256 - 32768, which gives 1/256 m resolution over the
 * whole plausible range in three bytes. Two public servers speak it:
 *
 *   - Mapterhorn (tiles.mapterhorn.com): 512-px lossless WebP, a composite of
 *     national LiDAR surveys (swissALTI3D, BEV, Bayern DGM1, ...) with
 *     Copernicus GLO-30 as the global fallback. The default here.
 *   - AWS Terrain Tiles: 256-px PNG, ~30 m SRTM/NASADEM class data. Kept as a
 *     fallback and for comparison.
 *
 * Every tile that arrives is written to the local store, so ordinary use warms
 * the cache that offline mode later relies on.
 */

import { DecodedCache, TileStore } from './tilestore';
import { TileKey, TileSource, tileId } from './types';

export const MAPTERHORN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const AWS_TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export function decodeTerrarium(px: Uint8ClampedArray, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }
  return out;
}

/** Decodes an image (PNG or WebP) to heights; null if it is not `size` square. */
async function bytesToHeights(bytes: ArrayBuffer, size: number): Promise<Float32Array | null> {
  const blob = new Blob([bytes]);
  try {
    const bmp = await createImageBitmap(blob);
    if (bmp.width !== size || bmp.height !== size) { bmp.close(); return null; }
    const cv = new OffscreenCanvas(size, size);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return decodeTerrarium(ctx.getImageData(0, 0, size, size).data, size * size);
  } catch {
    return null;
  }
}

export interface TerrariumOptions {
  name?: string;
  url?: string;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  /** Prefix for store keys, so two servers never share a cache entry. */
  storePrefix?: string;
  store?: TileStore;
  /** How many requests may be in flight at once. */
  concurrency?: number;
}

export class TerrariumSource implements TileSource {
  readonly name: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;

  readonly store: TileStore;
  readonly decoded = new DecodedCache();
  private url: string;
  private prefix: string;
  private inflight = new Map<string, Promise<Float32Array | null>>();
  private queue: (() => void)[] = [];
  private active = 0;
  private concurrency: number;

  /** Counters the UI reports. */
  stats = { fromMemory: 0, fromStore: 0, fromNetwork: 0, failed: 0, bytes: 0 };

  constructor(opt: TerrariumOptions = {}) {
    this.name = opt.name ?? 'Mapterhorn';
    this.url = opt.url ?? MAPTERHORN_URL;
    this.tileSize = opt.tileSize ?? 512;
    this.minZoom = opt.minZoom ?? 0;
    this.maxZoom = opt.maxZoom ?? 17;
    this.prefix = opt.storePrefix ?? 'mh/';
    this.store = opt.store ?? new TileStore();
    this.concurrency = opt.concurrency ?? 6;
  }

  /** The AWS Terrain Tiles flavour: 256-px PNG, ~30 m data. */
  static aws(opt: TerrariumOptions = {}): TerrariumSource {
    return new TerrariumSource({
      name: 'AWS Terrain Tiles', url: AWS_TERRARIUM_URL, tileSize: 256, maxZoom: 14,
      storePrefix: 'aws/', ...opt,
    });
  }

  private storeId(key: TileKey): string {
    return this.prefix + tileId(key);
  }

  private tileUrl(key: TileKey): string {
    return this.url
      .replace('{z}', String(key.z))
      .replace('{x}', String(key.x))
      .replace('{y}', String(key.y));
  }

  private slot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((res, rej) => {
      const run = () => {
        this.active++;
        fn().then(res, rej).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.concurrency) run();
      else this.queue.push(run);
    });
  }

  async has(key: TileKey): Promise<boolean> {
    const id = this.storeId(key);
    return this.decoded.get(id) !== undefined || this.store.has(id);
  }

  load(key: TileKey, signal?: AbortSignal): Promise<Float32Array | null> {
    if (key.z < this.minZoom || key.z > this.maxZoom) return Promise.resolve(null);
    const id = this.storeId(key);
    const hot = this.decoded.get(id);
    if (hot) { this.stats.fromMemory++; return Promise.resolve(hot); }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const job = (async () => {
      const cached = await this.store.get(id);
      if (cached) {
        const h = await bytesToHeights(cached, this.tileSize);
        if (h) { this.stats.fromStore++; this.decoded.set(id, h); return h; }
      }
      return this.slot(async () => {
        try {
          const res = await fetch(this.tileUrl(key), { signal, mode: 'cors' });
          if (!res.ok) { this.stats.failed++; return null; }
          const bytes = await res.arrayBuffer();
          const h = await bytesToHeights(bytes, this.tileSize);
          if (!h) { this.stats.failed++; return null; }
          this.stats.fromNetwork++;
          this.stats.bytes += bytes.byteLength;
          this.decoded.set(id, h);
          void this.store.put(id, bytes);
          return h;
        } catch {
          this.stats.failed++;
          return null;
        }
      });
    })().finally(() => this.inflight.delete(id));

    this.inflight.set(id, job);
    return job;
  }

  /** Downloads a tile without decoding it — used by the offline downloader. */
  async prefetch(key: TileKey, signal?: AbortSignal): Promise<number> {
    const id = this.storeId(key);
    if (await this.store.has(id)) return 0;
    return this.slot(async () => {
      try {
        const res = await fetch(this.tileUrl(key), { signal, mode: 'cors' });
        if (!res.ok) { this.stats.failed++; return 0; }
        const bytes = await res.arrayBuffer();
        this.stats.fromNetwork++;
        this.stats.bytes += bytes.byteLength;
        await this.store.put(id, bytes);
        return bytes.byteLength;
      } catch {
        this.stats.failed++;
        return 0;
      }
    });
  }
}
