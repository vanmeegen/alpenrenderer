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

/**
 * A 4×4 lossless WebP whose terrarium bytes sit on the byte edges (0, 1, 127,
 * 128, 254, 255 in every channel), and the bytes it must read back as. A
 * decoder that colour-manages the image, premultiplies, or resamples shifts a
 * byte here or there; in the red channel one step is 256 m, which is what a
 * field of spikes on a tablet looks like.
 */
export const DECODER_PROBE = {
  webp: 'UklGRkQAAABXRUJQVlA4TDgAAAAvA8AAAIWBSDLuJRNGEM0kM1dDQds2TMZ1PHqI10DaNpnyXeEtrf8BBKZFnf9a/rYuu8YBBw+xAQ==',
  size: 4,
  rgb: [0, 0, 0, 255, 255, 255, 128, 0, 0, 127, 255, 255, 128, 1, 128, 200, 100, 50, 1, 2, 3, 254, 253, 252,
    0, 128, 255, 255, 0, 128, 64, 64, 64, 191, 191, 191, 128, 0, 1, 128, 0, 255, 127, 0, 0, 129, 255, 0],
};

/** Largest height error, metres, a decoder made on the probe tile; 0 when it read every byte back. */
export function probeDeviation(px: Uint8ClampedArray): number {
  const n = DECODER_PROBE.rgb.length / 3;
  const got = decodeTerrarium(px, n);
  const want = decodeTerrarium(new Uint8ClampedArray(DECODER_PROBE.rgb.flatMap((_, i) => (i % 3 === 0 ? [DECODER_PROBE.rgb[i], DECODER_PROBE.rgb[i + 1], DECODER_PROBE.rgb[i + 2], 255] : []))), n);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  return worst;
}

/**
 * Two ways from image bytes to pixels. `bitmap` (createImageBitmap into an
 * OffscreenCanvas) is the fast path and works off the main thread; `image`
 * (an <img> drawn onto a canvas) is what every browser has decoded pictures
 * with for twenty years. Which one reads the bytes back untouched is decided
 * on the probe tile at start-up, per browser.
 */
export type Decoder = 'bitmap' | 'image';

async function pixelsOf(bytes: ArrayBuffer | Uint8Array, size: number, how: Decoder): Promise<Uint8ClampedArray | null> {
  const blob = new Blob([bytes as BlobPart]);
  if (how === 'bitmap') {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (bmp.width !== size || bmp.height !== size) { bmp.close(); return null; }
    const cv = new OffscreenCanvas(size, size);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return ctx.getImageData(0, 0, size, size).data;
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (img.naturalWidth !== size || img.naturalHeight !== size) return null;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, size, size).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes an image (PNG or WebP) to heights; null if it is not `size` square or cannot be decoded. */
async function bytesToHeights(bytes: ArrayBuffer, size: number, how: Decoder): Promise<Float32Array | null> {
  try {
    const px = await pixelsOf(bytes, size, how);
    return px ? decodeTerrarium(px, size * size) : null;
  } catch {
    return null;
  }
}

/** Tries each decoder on the probe tile; the first exact one is used, else the least wrong. */
export async function probeDecoders(): Promise<{ decoder: Decoder; report: string }> {
  const bytes = Uint8Array.from(atob(DECODER_PROBE.webp), (c) => c.charCodeAt(0));
  const results: { how: Decoder; deviation: number | null }[] = [];
  for (const how of ['bitmap', 'image'] as Decoder[]) {
    try {
      const px = await pixelsOf(bytes, DECODER_PROBE.size, how);
      results.push({ how, deviation: px ? probeDeviation(px) : null });
    } catch {
      results.push({ how, deviation: null });
    }
  }
  const exact = results.find((r) => r.deviation === 0);
  if (exact) return { decoder: exact.how, report: `exakt (${exact.how})` };
  const usable = results.filter((r) => r.deviation !== null).sort((a, b) => a.deviation! - b.deviation!);
  const describe = results.map((r) => `${r.how} ${r.deviation === null ? 'fehlgeschlagen' : `±${Math.round(r.deviation)} m`}`).join(', ');
  return { decoder: usable[0]?.how ?? 'bitmap', report: `kein Dekoder exakt: ${describe}` };
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
  /** Which decoder reads bytes back untouched in this browser, decided on the probe tile before the first tile. */
  decoder: Decoder = 'bitmap';
  decoderReport = '';
  private readonly decoderReady: Promise<void>;

  constructor(opt: TerrariumOptions = {}) {
    this.name = opt.name ?? 'Mapterhorn';
    this.url = opt.url ?? MAPTERHORN_URL;
    this.tileSize = opt.tileSize ?? 512;
    this.minZoom = opt.minZoom ?? 0;
    this.maxZoom = opt.maxZoom ?? 17;
    this.prefix = opt.storePrefix ?? 'mh/';
    this.store = opt.store ?? new TileStore();
    this.concurrency = opt.concurrency ?? 6;
    this.decoderReady = probeDecoders()
      .then((r) => { this.decoder = r.decoder; this.decoderReport = r.report; })
      .catch(() => { this.decoderReport = 'Probe fehlgeschlagen'; });
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
      await this.decoderReady;
      const cached = await this.store.get(id);
      if (cached) {
        const h = await bytesToHeights(cached, this.tileSize, this.decoder);
        if (h) { this.stats.fromStore++; this.decoded.set(id, h); return h; }
      }
      return this.slot(async () => {
        try {
          const res = await fetch(this.tileUrl(key), { signal, mode: 'cors' });
          if (!res.ok) { this.stats.failed++; return null; }
          const bytes = await res.arrayBuffer();
          const h = await bytesToHeights(bytes, this.tileSize, this.decoder);
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
