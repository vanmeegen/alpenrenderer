/**
 * Anything that can hand back a square patch of elevation.
 *
 * Two zooms are in play and must not be confused. The clipmap, the height
 * field and the shaders work in *pixel zoom*: the Web-Mercator grid with
 * `MERC_PX * 2^Z` pixels around the globe (MERC_PX = 256, see geodesy.ts). A
 * source serves tiles of `tileSize` pixels at a *tile zoom*; for 256-px tiles
 * the two zooms coincide, for 512-px tiles the tile zoom is one less than the
 * pixel zoom of the pixels it contains.
 */

import { MERC_PX } from '../core/geodesy';

export interface TileKey {
  /** Tile zoom, in the source's own tile grid. */
  z: number;
  x: number;
  y: number;
}

export interface TileSource {
  readonly name: string;
  /** Pixels per tile edge: 256 or 512. */
  readonly tileSize: number;
  /** Tile zooms this source serves. */
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Heights in metres, row-major, tileSize*tileSize entries. Null if not available. */
  load(key: TileKey, signal?: AbortSignal): Promise<Float32Array | null>;
  /** True when the tile is already local — used to decide what to preload. */
  has?(key: TileKey): Promise<boolean>;
}

/** How many zoom steps a source's tile zoom sits below the pixel zoom. */
export function zoomShift(tileSize: number): number {
  return Math.round(Math.log2(tileSize / MERC_PX));
}

/** Tile zoom of a source for a clipmap level at a given pixel zoom. */
export function tileZoom(pixelZoom: number, tileSize: number): number {
  return pixelZoom - zoomShift(tileSize);
}

export function tileId(k: TileKey): string {
  return `${k.z}/${k.x}/${k.y}`;
}

/** Wraps x around the date line and rejects y outside the projection. */
export function normaliseTile(k: TileKey): TileKey | null {
  const n = 1 << k.z;
  if (k.y < 0 || k.y >= n) return null;
  return { z: k.z, x: ((k.x % n) + n) % n, y: k.y };
}
