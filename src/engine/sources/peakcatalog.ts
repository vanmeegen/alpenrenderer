/**
 * The static summit catalogue: named `natural=peak` nodes from OpenStreetMap,
 * cut into 1°×1° cells at build time (tools/build_peaks.mjs) and served as
 * plain JSON next to the app. No Overpass call at runtime, so the site keeps
 * naming peaks when the public endpoints are rate-limited or down.
 *
 * Identity comes from here; geometry from the DEM (see core/peaks.ts).
 */

import { Peak } from '../core/peaks';

/** One summit as stored in a cell file: short keys, because there are tens of thousands. */
export interface CatalogRecord {
  /** OSM node id. */
  i: number;
  n: string;
  /** Longitude, latitude. */
  o: number;
  a: number;
  /** Elevation, prominence, metres. */
  e?: number;
  p?: number;
  /** Wikidata id, Wikipedia article (`lang:Title`). */
  w?: string;
  k?: string;
}

export type CellFetcher = (x: number, y: number) => Promise<CatalogRecord[] | null>;

export const CELL_TEMPLATE = 'peaks/{x}_{y}.json';

const M_PER_DEG = 111320;

/** The cells whose 1° box touches the circle of `radiusKm` around a point. */
export function cellsAround(lon: number, lat: number, radiusKm: number): { x: number; y: number }[] {
  const dLat = (radiusKm * 1000) / M_PER_DEG;
  const dLon = (radiusKm * 1000) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const out: { x: number; y: number }[] = [];
  for (let y = Math.floor(lat - dLat); y <= Math.floor(lat + dLat); y++) {
    for (let x = Math.floor(lon - dLon); x <= Math.floor(lon + dLon); x++) out.push({ x, y });
  }
  return out;
}

export function toPeak(r: CatalogRecord): Peak {
  return {
    id: `osm:node/${r.i}`,
    name: r.n,
    lon: r.o,
    lat: r.a,
    ...(r.e !== undefined ? { ele: r.e } : {}),
    ...(r.p !== undefined ? { prom: r.p } : {}),
    src: 'OpenStreetMap',
    tags: {
      ...(r.w ? { wikidata: r.w } : {}),
      ...(r.k ? { wikipedia: r.k } : {}),
    },
  };
}

/** Fetches a cell file; a missing file (no summits there, or the sea) is null. */
export function urlFetcher(template = CELL_TEMPLATE): CellFetcher {
  return async (x, y) => {
    const res = await fetch(template.replace('{x}', String(x)).replace('{y}', String(y)));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`peaks ${x}_${y}: HTTP ${res.status}`);
    return (await res.json()) as CatalogRecord[];
  };
}

export class PeakCatalog {
  private cells = new Map<string, Peak[]>();
  private inflight = new Map<string, Promise<Peak[]>>();

  constructor(private readonly fetcher: CellFetcher = urlFetcher()) {}

  /** Every catalogued summit in the cells around a point. Failed cells are retried next time. */
  async around(lon: number, lat: number, radiusKm: number): Promise<Peak[]> {
    const lists = await Promise.all(cellsAround(lon, lat, radiusKm).map((c) => this.cell(c.x, c.y)));
    return lists.flat();
  }

  private cell(x: number, y: number): Promise<Peak[]> {
    const key = `${x}_${y}`;
    const have = this.cells.get(key);
    if (have) return Promise.resolve(have);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetcher(x, y)
        .then((records) => {
          const peaks = (records ?? []).map(toPeak);
          this.cells.set(key, peaks);
          return peaks;
        })
        .catch(() => [] as Peak[])
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}
