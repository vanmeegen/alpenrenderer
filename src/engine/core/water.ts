/**
 * Lakes on the terrain: named water surfaces from OpenStreetMap, burnt into
 * the clipmap as a mask so the shade pass can paint them blue.
 *
 * The DEM already holds the lake as a flat surface (LiDAR water returns);
 * what it does not hold is that the flat is water. The mask adds exactly
 * that, one byte per DEM post, on the same grid as the heights.
 */

import { latToMercY, lonToMercX } from './geodesy';
import { Peak } from './peaks';

export interface Lake {
  /** Stable id, e.g. "osm:way/123" or "osm:relation/456". */
  id: string;
  name: string;
  /** Label point: inside the water, away from the shore. */
  lon: number;
  lat: number;
  /** Catalogued surface elevation, metres, when OSM has one. */
  ele?: number;
  /** Surface area, square metres. */
  area?: number;
  /** Rings as flat lon,lat lists; outer shores and islands alike, filled even-odd. */
  rings: number[][];
  tags?: Record<string, string>;
}

export interface MaskGrid {
  z: number;
  px0: number;
  py0: number;
  w: number;
  h: number;
}

/**
 * The water mask for one level: 255 where a post's centre lies inside a lake,
 * 0 elsewhere. Even-odd over all rings, so islands stay dry without needing
 * to know which ring is which.
 */
export function rasterizeLakes(level: MaskGrid, lakes: Lake[]): Uint8Array {
  const { z, px0, py0, w, h } = level;
  const mask = new Uint8Array(w * h);
  const xs: number[] = [];
  for (const lake of lakes) {
    // Rings in level pixels; lakes wholly outside the level are skipped.
    const rings: Float64Array[] = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of lake.rings) {
      const n = r.length >> 1;
      if (n < 3) continue;
      const p = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const x = lonToMercX(r[2 * i], z) - px0;
        const y = latToMercY(r[2 * i + 1], z) - py0;
        p[2 * i] = x; p[2 * i + 1] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      rings.push(p);
    }
    if (!rings.length || maxX < 0 || maxY < 0 || minX > w || minY > h) continue;

    const y0 = Math.max(0, Math.ceil(minY - 0.5)), y1 = Math.min(h - 1, Math.floor(maxY - 0.5));
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (const p of rings) {
        const n = p.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ay = p[2 * j + 1], by = p[2 * i + 1];
          // Half-open in y, so a vertex on the scanline counts once.
          if ((ay <= yc) === (by <= yc)) continue;
          const ax = p[2 * j], bx = p[2 * i];
          xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // Posts whose centre x+0.5 lies in [xs[k], xs[k+1]).
        const from = Math.max(0, Math.ceil(xs[k] - 0.5));
        const to = Math.min(w - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        if (to >= from) mask.fill(255, y * w + from, y * w + to + 1);
      }
    }
  }
  return mask;
}

/** Lakes at least this big (m²) get spare anchor points; a small one is seen whole or not at all. */
export const SPOT_AREA = 500_000;
const MAX_SPOTS = 8;

function insideRings(rings: number[][], lon: number, lat: number): boolean {
  let c = false;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/**
 * Spare anchor points on the water, spread over the lake: points of a grid
 * inside the shore, picked farthest-first from the label point and from
 * each other, so that whichever part of the lake is in view holds one.
 */
function lakeSpots(l: Lake): { lon: number; lat: number }[] {
  if ((l.area ?? 0) < SPOT_AREA || !l.rings.length) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of l.rings) {
    for (let i = 0; i < r.length; i += 2) {
      minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]);
      minY = Math.min(minY, r[i + 1]); maxY = Math.max(maxY, r[i + 1]);
    }
  }
  const k = Math.cos((l.lat * Math.PI) / 180);
  const N = 9;
  const cand: { lon: number; lat: number }[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const lon = minX + ((i + 0.5) / N) * (maxX - minX), lat = minY + ((j + 0.5) / N) * (maxY - minY);
      if (insideRings(l.rings, lon, lat)) cand.push({ lon, lat });
    }
  }
  const chosen = [{ lon: l.lon, lat: l.lat }];
  const d2 = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => ((a.lon - b.lon) * k) ** 2 + (a.lat - b.lat) ** 2;
  const out: { lon: number; lat: number }[] = [];
  while (out.length < MAX_SPOTS && cand.length) {
    let best = -1, bestD = -1;
    cand.forEach((c, i) => {
      const d = Math.min(...chosen.map((x) => d2(c, x)));
      if (d > bestD) { bestD = d; best = i; }
    });
    const [c] = cand.splice(best, 1);
    chosen.push(c);
    out.push(c);
  }
  return out;
}

/** A lake as a label: its name at the label point, anchored on the water surface. */
export function lakeLabel(l: Lake): Peak {
  const spots = lakeSpots(l);
  return {
    id: l.id, name: l.name, lon: l.lon, lat: l.lat, kind: 'lake', src: 'OpenStreetMap',
    ...(l.ele !== undefined ? { ele: l.ele } : {}),
    ...(l.tags ? { tags: l.tags } : {}),
    ...(spots.length ? { spots } : {}),
  };
}
