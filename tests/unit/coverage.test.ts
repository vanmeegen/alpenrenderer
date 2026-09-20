import { describe, expect, test } from 'bun:test';
import { CoverageIndex } from '../../src/engine/sources/coverage';

/** A coverage index whose cells are given, not fetched. */
function index(cells: Record<string, Record<string, unknown>>, calls: string[] = []) {
  return new CoverageIndex(async (z, x, y) => {
    calls.push(`${z}/${x}/${y}`);
    return cells[`${x}/${y}`] ?? null;
  });
}

const SWISS = { name: 'swissALTI3D', producer: 'Federal Office of Topography swisstopo',
  producer_short: 'swisstopo', website: 'https://swisstopo', license: 'OGD', resolution: 0.5 };
const AOSTA = { name: 'DTM', producer: 'Regione Valle d\'Aosta', producer_short: 'SCT',
  website: 'https://vda', license: 'CC BY 4.0', resolution: 2 };
const GLO = { name: 'COPERNICUS GLO-30', producer: 'DLR', producer_short: 'Copernicus',
  website: 'https://copernicus', license: 'COPERNICUS', resolution: 30 };

describe('CoverageIndex.around', () => {
  test('merges the z12 cells within the radius, finest survey first, one per producer', async () => {
    // Matterhorn cell at z12 is 2135/1457; neighbours carry other surveys.
    const idx = index({
      '2135/1457': { swissalti3d: SWISS, glo30: GLO },
      '2134/1457': { itaosta: AOSTA, itaosta2: { ...AOSTA, resolution: 5 } },
    });
    const list = await idx.around(7.65862, 45.97639, 25);
    expect(list.map((s) => s.producerShort)).toEqual(['swisstopo', 'SCT', 'Copernicus']);
    expect(list[0]).toMatchObject({ id: 'swissalti3d', license: 'OGD', resolution: 0.5, website: 'https://swisstopo' });
  });

  test('asks only for z12 cells and caches them across calls', async () => {
    const calls: string[] = [];
    const idx = index({ '2135/1457': { swissalti3d: SWISS } }, calls);
    await idx.around(7.65862, 45.97639, 1);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith('12/'))).toBe(true);
    await idx.around(7.65862, 45.97639, 1);
    expect(calls.length).toBe(first);
  });

  test('a fetcher that throws yields an empty list, not an error', async () => {
    const idx = new CoverageIndex(async () => { throw new Error('offline'); });
    expect(await idx.around(10, 47, 10)).toEqual([]);
  });

  test('a larger radius touches more cells', async () => {
    const small: string[] = [], large: string[] = [];
    await index({}, small).around(10, 47, 1);
    await index({}, large).around(10, 47, 40);
    expect(large.length).toBeGreaterThan(small.length);
  });
});
