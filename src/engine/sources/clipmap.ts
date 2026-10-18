/**
 * Fills the clipmap from a tile source.
 *
 * Levels are fixed-size Web-Mercator windows centred on the observer, each one
 * zoom step coarser and twice the extent of the one inside it. Moving the
 * observer recomputes the windows and refills them from tiles; because tiles
 * are cached, walking around a valley refills from local storage and never
 * touches the network.
 *
 * Coarse levels are filled first. A blurry but complete horizon is far more
 * use than a sharp foreground with nothing behind it, and it is what makes the
 * first paint feel immediate on a cold cache.
 */

import { HeightField, Level } from '../core/heightfield';
import { latToMercY, lonToMercX, mercResolution } from '../core/geodesy';
import { TileKey, TileSource, normaliseTile, tileZoom } from './types';

export interface ClipmapLevelSpec {
  z: number;
}

export interface ClipmapConfig {
  /** Pixels per side of every level. */
  size: number;
  /** Finest first. */
  levels: ClipmapLevelSpec[];
  /**
   * The telescope's windows: levels cut around the point looked at instead
   * of the observer (setLook), finest first. Zoomed in, the summit looked
   * at is drawn from 6.6 m posts instead of the 26–53 m of the level that
   * reaches it from the observer.
   */
  look?: ClipmapLevelSpec[];
}

/**
 * Eight levels, pixel zoom 14 down to 7: 6.6 m posts out to ~2 km, doubling
 * each step to ~850 m posts at 272 km. Eight is what the shader's level arrays
 * hold. Mapterhorn serves LiDAR-grade data down to tile zoom 17, so the two
 * finest levels here are where the summit shapes come from; the coarse ones
 * are what makes a 200 km horizon affordable.
 */
export const DEFAULT_CLIPMAP: ClipmapConfig = {
  size: 640,
  levels: [{ z: 14 }, { z: 13 }, { z: 12 }, { z: 11 }, { z: 10 }, { z: 9 }, { z: 8 }, { z: 7 }],
  // The telescope: 6.6 m and 13 m posts around the summit looked at, zoomed in.
  look: [{ z: 14 }, { z: 13 }],
};

/** Six levels for phones: 13 m posts out to ~4 km, half the reach (~135 km). */
export const LOW_CLIPMAP: ClipmapConfig = {
  size: 640,
  levels: [{ z: 13 }, { z: 12 }, { z: 11 }, { z: 10 }, { z: 9 }, { z: 8 }],
  look: [{ z: 13 }, { z: 12 }],
};

const QUANT = 1;
const BIAS = -1000;

export interface FillProgress {
  /** Tiles still to fetch for the current centre. */
  pending: number;
  /** Tiles resolved so far for the current centre. */
  done: number;
  total: number;
  levelsReady: number;
}

export class ClipmapStreamer {
  readonly heightField: HeightField;
  readonly progress: FillProgress = { pending: 0, done: 0, total: 0, levelsReady: 0 };

  private levels: Level[] = [];
  /** Window origin currently *loaded* into each level, or null when empty. */
  private loaded: (string | null)[] = [];
  private generation = 0;
  private abort: AbortController | null = null;
  /** The telescope's windows (config.look), cut around the point looked at; see setLook. */
  private lookLevels: Level[] = [];
  private lookLoaded: (string | null)[] = [];
  private lookGeneration = 0;
  private lookAbort: AbortController | null = null;

  onUpdate: ((level: number) => void) | null = null;

  constructor(
    readonly source: TileSource,
    readonly config: ClipmapConfig = DEFAULT_CLIPMAP,
    lon = 0, lat = 0,
  ) {
    this.heightField = new HeightField(lon, lat);
    const { size } = config;
    for (const spec of config.levels) {
      // Windows are centred from the start: addLevel derives each level's
      // usable range from where the observer falls inside the crop, and a
      // placeholder origin would make every level claim a range of zero and
      // leave the level ordering undefined.
      const px0 = Math.round(lonToMercX(lon, spec.z)) - (size >> 1);
      const py0 = Math.round(latToMercY(lat, spec.z)) - (size >> 1);
      const lv = this.heightField.addLevel({
        z: spec.z, px0, py0, w: size, h: size, quant: QUANT, bias: BIAS,
      }, new Uint16Array(size * size), false);
      this.levels.push(lv);
      this.loaded.push(null);
    }
    for (const spec of config.look ?? []) {
      const px0 = Math.round(lonToMercX(lon, spec.z)) - (size >> 1);
      const py0 = Math.round(latToMercY(lat, spec.z)) - (size >> 1);
      const lv = this.heightField.addLevel({
        z: spec.z, px0, py0, w: size, h: size, quant: QUANT, bias: BIAS, role: 'look',
      }, new Uint16Array(size * size), false);
      this.lookLevels.push(lv);
      this.lookLoaded.push(null);
    }
  }

  /**
   * Points the telescope: cuts each look window around (lon, lat) and fills
   * it, unless the point is still within a quarter window of the current
   * centre (panning across a summit must not refetch). Outside the eye's
   * progress: the panorama is complete without it, the window only sharpens
   * what is looked at.
   */
  async setLook(lon: number, lat: number): Promise<void> {
    const size = this.config.size;
    const jobs: { index: number; keys: TileKey[]; px0: number; py0: number }[] = [];
    this.lookLevels.forEach((lv, i) => {
      const cx = lonToMercX(lon, lv.z), cy = latToMercY(lat, lv.z);
      if (this.lookLoaded[i] && lv.filled
        && Math.abs(cx - (lv.px0 + size / 2)) < size / 4 && Math.abs(cy - (lv.py0 + size / 2)) < size / 4) return;
      const px0 = Math.round(cx) - (size >> 1), py0 = Math.round(cy) - (size >> 1);
      if (this.lookLoaded[i] === `${lv.z}:${px0}:${py0}` && lv.filled) return;
      const T = this.source.tileSize, tz = tileZoom(lv.z, T);
      const keys: TileKey[] = [];
      for (let ty = Math.floor(py0 / T); ty <= Math.floor((py0 + size - 1) / T); ty++) {
        for (let tx = Math.floor(px0 / T); tx <= Math.floor((px0 + size - 1) / T); tx++) {
          const k = normaliseTile({ z: tz, x: tx, y: ty });
          if (k) keys.push(k);
        }
      }
      jobs.push({ index: i, keys, px0, py0 });
    });
    if (!jobs.length) return;
    const gen = ++this.lookGeneration;
    this.lookAbort?.abort();
    this.lookAbort = new AbortController();
    const { signal } = this.lookAbort;
    for (const job of jobs) {
      const lv = this.lookLevels[job.index];
      const tiles = await Promise.all(job.keys.map((key) => this.source.load(key, signal)));
      if (gen !== this.lookGeneration) return;
      // A window moves as a whole: cut, filled, then shown, so no frame draws half of each.
      lv.px0 = job.px0;
      lv.py0 = job.py0;
      lv.raw.fill(0);
      job.keys.forEach((key, k) => { if (tiles[k]) this.blit(lv, job.px0, job.py0, key, tiles[k]!); });
      this.heightField.setOrigin(this.heightField.lon, this.heightField.lat);
      lv.version++;
      lv.filled = true;
      this.lookLoaded[job.index] = `${lv.z}:${job.px0}:${job.py0}`;
      this.onUpdate?.(this.levels.length + job.index);
    }
  }

  /** The telescope is put down: its windows are empty again and the GPU skips them. Idle when they already are. */
  clearLook() {
    let changed = false;
    this.lookLevels.forEach((lv, i) => {
      if (!lv.filled && !this.lookLoaded[i]) return;
      lv.filled = false;
      lv.version++;
      this.lookLoaded[i] = null;
      changed = true;
    });
    if (this.lookAbort) { this.lookAbort.abort(); this.lookAbort = null; this.lookGeneration++; changed = true; }
    if (changed) this.onUpdate?.(this.levels.length);
  }

  /** Ground sample distance of each level at the current latitude, metres. */
  resolutions(): number[] {
    return this.levels.map((l) => mercResolution(this.heightField.lat, l.z));
  }

  /**
   * Recentres on a position and refills. Safe to call on every GPS fix: a
   * level whose window has not moved is left alone.
   */
  async setCenter(lon: number, lat: number): Promise<void> {
    const gen = ++this.generation;
    this.abort?.abort();
    this.abort = new AbortController();
    const { signal } = this.abort;

    const size = this.config.size;
    const jobs: { index: number; keys: TileKey[]; px0: number; py0: number }[] = [];

    this.levels.forEach((lv, i) => {
      const cx = lonToMercX(lon, lv.z);
      const cy = latToMercY(lat, lv.z);
      const px0 = Math.round(cx) - (size >> 1);
      const py0 = Math.round(cy) - (size >> 1);
      const stamp = `${lv.z}:${px0}:${py0}`;
      if (this.loaded[i] === stamp) return;
      lv.px0 = px0;
      lv.py0 = py0;
      // The window is cut on the pixel grid at lv.z; the source's tiles may be
      // bigger than 256 px, in which case they live one tile zoom lower and
      // each covers `T` pixels of this level.
      const T = this.source.tileSize;
      const tz = tileZoom(lv.z, T);
      const keys: TileKey[] = [];
      const tx0 = Math.floor(px0 / T), tx1 = Math.floor((px0 + size - 1) / T);
      const ty0 = Math.floor(py0 / T), ty1 = Math.floor((py0 + size - 1) / T);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const k = normaliseTile({ z: tz, x: tx, y: ty });
          if (k) keys.push(k);
        }
      }
      jobs.push({ index: i, keys, px0, py0 });
    });

    // Only now that every px0/py0 is settled can the field recompute where the
    // observer sits inside each window, and hence each level's usable range.
    this.heightField.setOrigin(lon, lat);

    this.progress.total = jobs.reduce((a, j) => a + j.keys.length, 0);
    this.progress.done = 0;
    this.progress.pending = this.progress.total;
    this.progress.levelsReady = this.levels.length - jobs.length;

    // Coarsest first: a complete horizon beats a sharp foreground.
    jobs.sort((a, b) => b.index - a.index);

    for (const job of jobs) {
      const lv = this.levels[job.index];
      await Promise.all(job.keys.map(async (key) => {
        const heights = await this.source.load(key, signal);
        if (gen !== this.generation) return;
        if (heights) this.blit(lv, job.px0, job.py0, key, heights);
        this.progress.done++;
        this.progress.pending--;
      }));
      if (gen !== this.generation) return;
      lv.version++;
      lv.filled = true;
      this.loaded[job.index] = `${lv.z}:${job.px0}:${job.py0}`;
      this.progress.levelsReady++;
      this.onUpdate?.(job.index);
    }
  }

  /**
   * Copies the overlapping part of a tile into a level's raster. The tile's
   * pixels are on the level's pixel grid; its origin is `key.x * T` where T is
   * the tile edge, whatever tile zoom it was fetched at.
   */
  private blit(lv: Level, px0: number, py0: number, key: TileKey, heights: Float32Array) {
    const T = Math.round(Math.sqrt(heights.length));
    const n = T * (1 << key.z);
    // The tile may be the wrapped copy of a column left or right of the window.
    for (const originX of [key.x * T, key.x * T - n, key.x * T + n]) {
      const x0 = Math.max(px0, originX);
      const x1 = Math.min(px0 + lv.w, originX + T);
      if (x1 <= x0) continue;
      const originY = key.y * T;
      const y0 = Math.max(py0, originY);
      const y1 = Math.min(py0 + lv.h, originY + T);
      if (y1 <= y0) continue;
      for (let y = y0; y < y1; y++) {
        const src = (y - originY) * T - originX;
        const dst = (y - py0) * lv.w - px0;
        for (let x = x0; x < x1; x++) {
          const h = heights[src + x];
          lv.raw[dst + x] = Math.max(0, Math.min(65535, Math.round(h - BIAS)));
        }
      }
    }
  }

  /** Tiles a preload of `radiusKm` around a point would need. */
  planPreload(lon: number, lat: number, radiusKm: number): TileKey[] {
    const out: TileKey[] = [];
    const seen = new Set<string>();
    for (const lv of this.levels) {
      const res = mercResolution(lat, lv.z);
      // Never fetch a level finer than its own window would cover anyway.
      const reach = Math.min(radiusKm * 1000, (this.config.size / 2) * res);
      const half = Math.ceil(reach / res);
      const cx = Math.round(lonToMercX(lon, lv.z));
      const cy = Math.round(latToMercY(lat, lv.z));
      const T = this.source.tileSize;
      const tz = tileZoom(lv.z, T);
      const tx0 = Math.floor((cx - half) / T), tx1 = Math.floor((cx + half) / T);
      const ty0 = Math.floor((cy - half) / T), ty1 = Math.floor((cy + half) / T);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const k = normaliseTile({ z: tz, x: tx, y: ty });
          if (!k) continue;
          const id = `${k.z}/${k.x}/${k.y}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(k);
        }
      }
    }
    return out;
  }

  cancel() {
    this.abort?.abort();
    this.generation++;
  }
}
