/**
 * The static lake catalogue: named water surfaces from OpenStreetMap, cut
 * into 1°×1° cells at build time (tools/build_lakes.mjs) like the summits,
 * each lake filed under the cell of its label point. Served as plain JSON
 * next to the app; no Overpass call at runtime.
 */

import { Lake } from '../core/water';
import { cellsAround } from './peakcatalog';

/** One lake as stored in a cell file. */
export interface LakeRecord {
  /** OSM element: "w123" for a way, "r456" for a multipolygon relation. */
  i: string;
  n: string;
  /** Label point, inside the water. */
  o: number;
  a: number;
  /** Surface elevation, metres, when tagged. */
  e?: number;
  /** Area, square metres. */
  ar?: number;
  w?: string;
  k?: string;
  /** Rings, flat lon,lat lists at five decimals. */
  g: number[][];
}

export type LakeFetcher = (x: number, y: number) => Promise<LakeRecord[] | null>;

export const LAKE_TEMPLATE = 'lakes/{x}_{y}.json';

export function toLake(r: LakeRecord): Lake {
  const kind = r.i[0] === 'r' ? 'relation' : 'way';
  return {
    id: `osm:${kind}/${r.i.slice(1)}`,
    name: r.n,
    lon: r.o,
    lat: r.a,
    ...(r.e !== undefined ? { ele: r.e } : {}),
    ...(r.ar !== undefined ? { area: r.ar } : {}),
    rings: r.g,
    tags: {
      ...(r.w ? { wikidata: r.w } : {}),
      ...(r.k ? { wikipedia: r.k } : {}),
    },
  };
}

export function lakeFetcher(template = LAKE_TEMPLATE): LakeFetcher {
  return async (x, y) => {
    const res = await fetch(template.replace('{x}', String(x)).replace('{y}', String(y)));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lakes ${x}_${y}: HTTP ${res.status}`);
    return (await res.json()) as LakeRecord[];
  };
}

export class LakeCatalog {
  private cells = new Map<string, Lake[]>();
  private inflight = new Map<string, Promise<Lake[]>>();

  constructor(private readonly fetcher: LakeFetcher = lakeFetcher()) {}

  /** Every catalogued lake in the cells around a point. Failed cells are retried next time. */
  async around(lon: number, lat: number, radiusKm: number): Promise<Lake[]> {
    const lists = await Promise.all(cellsAround(lon, lat, radiusKm).map((c) => this.cell(c.x, c.y)));
    return lists.flat();
  }

  private cell(x: number, y: number): Promise<Lake[]> {
    const key = `${x}_${y}`;
    const have = this.cells.get(key);
    if (have) return Promise.resolve(have);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetcher(x, y)
        .then((records) => {
          const lakes = (records ?? []).map(toLake);
          this.cells.set(key, lakes);
          return lakes;
        })
        .catch(() => [] as Lake[])
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}
