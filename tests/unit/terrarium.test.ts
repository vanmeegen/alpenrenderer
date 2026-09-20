import { describe, expect, test } from 'bun:test';
import { AWS_TERRARIUM_URL, MAPTERHORN_URL, TerrariumSource, decodeTerrarium } from '../../src/engine/sources/terrarium';

describe('decodeTerrarium', () => {
  test('R*256 + G + B/256 - 32768', () => {
    // 4478 m: 4478 + 32768 = 37246 = 145*256 + 126, B = 0.
    const px = new Uint8ClampedArray([145, 126, 0, 255, 0, 0, 0, 255, 128, 0, 128, 255]);
    const h = decodeTerrarium(px, 3);
    expect(h[0]).toBe(4478);
    expect(h[1]).toBe(-32768);
    expect(h[2]).toBeCloseTo(0.5, 6);
  });
});

describe('TerrariumSource configuration', () => {
  test('defaults to Mapterhorn: 512-px tiles up to zoom 17', () => {
    const s = new TerrariumSource({ store: fakeStore() });
    expect(s.name).toBe('Mapterhorn');
    expect(s.tileSize).toBe(512);
    expect(s.maxZoom).toBe(17);
    expect(MAPTERHORN_URL).toBe('https://tiles.mapterhorn.com/{z}/{x}/{y}.webp');
  });

  test('the AWS flavour is 256-px PNG up to zoom 14', () => {
    const s = TerrariumSource.aws({ store: fakeStore() });
    expect(s.tileSize).toBe(256);
    expect(s.maxZoom).toBe(14);
    expect(AWS_TERRARIUM_URL).toContain('elevation-tiles-prod');
  });

  test('a tile outside the zoom range resolves to null without a request', async () => {
    const s = new TerrariumSource({ store: fakeStore() });
    let fetched = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetched++; return new Response(null, { status: 404 }); }) as typeof fetch;
    try {
      expect(await s.load({ z: 18, x: 0, y: 0 })).toBeNull();
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

/** The IndexedDB store, minus IndexedDB. */
function fakeStore() {
  return {
    unavailable: true,
    async get() { return null; },
    async put() { /* nothing */ },
    async has() { return false; },
  } as unknown as ConstructorParameters<typeof TerrariumSource>[0] extends { store?: infer S } ? S : never;
}
