/**
 * The static summit catalogue: one JSON file per 1°×1° cell, fetched around
 * the standpoint, parsed into the engine's Peak records, cached per cell.
 */
import { describe, expect, test } from 'bun:test';
import { CatalogRecord, PeakCatalog, cellsAround, toPeak } from '../../src/engine/sources/peakcatalog';

const ZUGSPITZE: CatalogRecord = { i: 27347453, n: 'Zugspitze', o: 10.98527, a: 47.42111, e: 2962, p: 1746, w: 'Q3375', k: 'de:Zugspitze' };

function catalog(cells: Record<string, CatalogRecord[] | null | (() => never)>, calls: string[] = []) {
  return new PeakCatalog(async (x, y) => {
    calls.push(`${x}_${y}`);
    const c = cells[`${x}_${y}`];
    if (typeof c === 'function') c();
    return c ?? null;
  });
}

describe('cellsAround', () => {
  test('a small radius inside a cell needs only that cell', () => {
    expect(cellsAround(10.5, 47.5, 1)).toEqual([{ x: 10, y: 47 }]);
  });

  test('a radius reaching across the cell edges takes the neighbours', () => {
    const cells = cellsAround(10.0, 47.0, 30).map((c) => `${c.x}_${c.y}`).sort();
    expect(cells).toEqual(['10_46', '10_47', '9_46', '9_47']);
  });

  test('the label range of 260 km spans 7 by 5 cells at 47° north', () => {
    const cells = cellsAround(10.5, 47.5, 260);
    const keys = new Set(cells.map((c) => `${c.x}_${c.y}`));
    expect(cells.length).toBe(35);
    expect(keys.has('7_45') && keys.has('13_49')).toBe(true);
    expect(keys.has('6_45') || keys.has('14_49')).toBe(false);
  });
});

describe('toPeak', () => {
  test('maps the compact record onto the engine\'s Peak', () => {
    expect(toPeak(ZUGSPITZE)).toEqual({
      id: 'osm:node/27347453', name: 'Zugspitze', lon: 10.98527, lat: 47.42111, ele: 2962, prom: 1746,
      src: 'OpenStreetMap', tags: { wikidata: 'Q3375', wikipedia: 'de:Zugspitze' },
    });
  });

  test('missing elevation and links stay absent', () => {
    const p = toPeak({ i: 1, n: 'Namenlos', o: 10, a: 47 });
    expect(p.ele).toBeUndefined();
    expect(p.prom).toBeUndefined();
    expect(p.tags).toEqual({});
  });
});

describe('PeakCatalog.around', () => {
  test('returns the peaks of every cell the radius touches, parsed', async () => {
    const c = catalog({ '10_47': [ZUGSPITZE], '10_46': [{ i: 2, n: 'Südspitze', o: 10.5, a: 46.9, e: 3000 }] });
    const peaks = await c.around(10.5, 47.0, 20);
    expect(peaks.map((p) => p.name).sort()).toEqual(['Südspitze', 'Zugspitze']);
    expect(peaks.find((p) => p.name === 'Zugspitze')!.id).toBe('osm:node/27347453');
  });

  test('a cell without a file (the sea, or outside the Alps) is simply empty', async () => {
    const c = catalog({ '10_47': [ZUGSPITZE] });
    const peaks = await c.around(10.5, 47.0, 20);
    expect(peaks.length).toBe(1);
  });

  test('cells are fetched once and reused', async () => {
    const calls: string[] = [];
    const c = catalog({ '10_47': [ZUGSPITZE] }, calls);
    await c.around(10.5, 47.5, 1);
    await c.around(10.6, 47.6, 1);
    expect(calls).toEqual(['10_47']);
  });

  test('a failing fetch is not an error and is retried next time', async () => {
    const calls: string[] = [];
    let fail = true;
    const c = new PeakCatalog(async (x, y) => {
      calls.push(`${x}_${y}`);
      if (fail) throw new Error('offline');
      return [ZUGSPITZE];
    });
    expect(await c.around(10.5, 47.5, 1)).toEqual([]);
    fail = false;
    expect((await c.around(10.5, 47.5, 1)).length).toBe(1);
    expect(calls).toEqual(['10_47', '10_47']);
  });
});
