/**
 * Which surveys lie under the terrain on screen.
 *
 * Mapterhorn publishes a small PMTiles archive (coverage-index.pmtiles, zoom 4
 * to 12) whose "tiles" are JSON objects mapping source id to survey metadata.
 * Reading the z12 cells around the observer gives the list the Credits panel
 * has to show, in the order the licences would want: finest survey first.
 */

import { PMTiles } from 'pmtiles';
import { latToMercY, lonToMercX, MERC_PX } from '../core/geodesy';

export const COVERAGE_INDEX_URL = 'https://download.mapterhorn.com/coverage-index.pmtiles';
const INDEX_ZOOM = 12;

export interface SurveyCredit {
  id: string;
  name: string;
  producer: string;
  producerShort: string;
  website: string;
  license: string;
  /** Metres. */
  resolution: number;
}

interface RawEntry {
  name?: string;
  producer?: string;
  producer_short?: string;
  website?: string;
  license?: string;
  resolution?: number;
}

export class CoverageIndex {
  private archive: PMTiles | null = null;
  private cells = new Map<string, Record<string, RawEntry>>();

  constructor(private url = COVERAGE_INDEX_URL) {}

  private async cell(x: number, y: number): Promise<Record<string, RawEntry>> {
    const id = `${x}/${y}`;
    const hit = this.cells.get(id);
    if (hit) return hit;
    this.archive ??= new PMTiles(this.url);
    let out: Record<string, RawEntry> = {};
    try {
      const t = await this.archive.getZxy(INDEX_ZOOM, x, y);
      if (t) out = JSON.parse(new TextDecoder().decode(t.data));
    } catch { /* offline or blocked: an empty cell just shows the fixed credits */ }
    this.cells.set(id, out);
    return out;
  }

  /**
   * Surveys within `radiusKm` of a point, finest first, one entry per producer.
   * The radius is what the near levels of the clipmap actually draw in detail;
   * the far horizon is Copernicus almost everywhere and is credited statically.
   */
  async around(lon: number, lat: number, radiusKm = 25): Promise<SurveyCredit[]> {
    const n = MERC_PX * (1 << INDEX_ZOOM);
    const cx = lonToMercX(lon, INDEX_ZOOM), cy = latToMercY(lat, INDEX_ZOOM);
    const mpp = (40075016.686 * Math.cos(lat * Math.PI / 180)) / n;   // metres per pixel
    const r = (radiusKm * 1000) / mpp;
    const x0 = Math.floor((cx - r) / MERC_PX), x1 = Math.floor((cx + r) / MERC_PX);
    const y0 = Math.floor((cy - r) / MERC_PX), y1 = Math.floor((cy + r) / MERC_PX);
    const merged: Record<string, RawEntry> = {};
    const jobs: Promise<void>[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        jobs.push(this.cell(x, y).then((c) => { Object.assign(merged, c); }));
      }
    }
    await Promise.all(jobs);
    const seen = new Set<string>();
    return Object.entries(merged)
      .map(([id, e]) => ({
        id,
        name: e.name ?? id,
        producer: e.producer ?? '',
        producerShort: e.producer_short ?? e.producer ?? id,
        website: e.website ?? '',
        license: e.license ?? '',
        resolution: e.resolution ?? 0,
      }))
      .sort((a, b) => a.resolution - b.resolution)
      .filter((s) => !seen.has(s.producerShort) && (seen.add(s.producerShort), true));
  }
}
