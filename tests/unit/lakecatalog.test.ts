/**
 * The static lake catalogue: named water surfaces from OpenStreetMap, one
 * JSON file per 1°×1° cell like the summits, with the shore as rings.
 */
import { describe, expect, test } from 'bun:test';
import { LakeCatalog, LakeRecord, toLake } from '../../src/engine/sources/lakecatalog';

const WALCHENSEE: LakeRecord = {
  i: 'r1234', n: 'Walchensee', o: 11.33, a: 47.59, e: 802, ar: 16_400_000, w: 'Q259220', k: 'de:Walchensee',
  g: [[11.30, 47.57, 11.37, 47.57, 11.37, 47.62, 11.30, 47.62], [11.33, 47.59, 11.34, 47.59, 11.34, 47.60]],
};

describe('toLake', () => {
  test('maps the compact record onto the engine\'s Lake, ways and relations alike', () => {
    expect(toLake(WALCHENSEE)).toEqual({
      id: 'osm:relation/1234', name: 'Walchensee', lon: 11.33, lat: 47.59, ele: 802, area: 16_400_000,
      rings: WALCHENSEE.g,
      tags: { wikidata: 'Q259220', wikipedia: 'de:Walchensee' },
    });
    expect(toLake({ i: 'w77', n: 'Eibsee', o: 10.97, a: 47.46, g: [[10.9, 47.4, 11, 47.4, 11, 47.5]] }).id).toBe('osm:way/77');
  });
});

describe('LakeCatalog', () => {
  test('fetches the cells around a point once each; a missing cell is no lakes', async () => {
    const calls: string[] = [];
    const cat = new LakeCatalog(async (x, y) => {
      calls.push(`${x}_${y}`);
      return x === 11 && y === 47 ? [WALCHENSEE] : null;
    });
    const a = await cat.around(11.3, 47.6, 20);
    expect(a.map((l) => l.name)).toEqual(['Walchensee']);
    const n = calls.length;
    await cat.around(11.3, 47.6, 20);
    expect(calls.length).toBe(n);
  });
});
