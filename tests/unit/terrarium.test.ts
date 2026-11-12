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

describe('what a tile request can come to', () => {
  const key = { z: 12, x: 2170, y: 1434 };
  async function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = impl as unknown as typeof fetch;
    try { return await run(); } finally { globalThis.fetch = orig; }
  }

  test('a tile the server does not have (404) is no data: null, counted as absent, not as a failure', async () => {
    const s = new TerrariumSource({ store: fakeStore() });
    const got = await withFetch(async () => new Response(null, { status: 404 }), () => s.load(key));
    expect(got).toBeNull();
    expect(s.stats.absent).toBe(1);
    expect(s.stats.failed).toBe(0);
  });

  test('a server error or a dead connection rejects, so the caller can ask again; each is counted', async () => {
    const s = new TerrariumSource({ store: fakeStore() });
    await withFetch(async () => new Response(null, { status: 503 }), async () => {
      await expect(s.load(key)).rejects.toThrow(/503/);
    });
    await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
      await expect(s.load(key)).rejects.toThrow(/Failed to fetch/);
    });
    expect(s.stats.failed).toBe(2);
    // The failure is not remembered: the next request goes out again.
    let asked = 0;
    await withFetch(async () => { asked++; return new Response(null, { status: 404 }); }, () => s.load(key));
    expect(asked).toBe(1);
  });

  test('a request the caller gave up on rejects without counting as a failure', async () => {
    const s = new TerrariumSource({ store: fakeStore() });
    const abort = new AbortController();
    abort.abort();
    await withFetch(async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(null, { status: 200 });
    }, async () => {
      await expect(s.load(key, abort.signal)).rejects.toThrow();
    });
    expect(s.stats.failed).toBe(0);
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

describe('decoder probe', () => {
  test('the probe tile reads back exactly, and a colour-managed decoder that shifts one red byte is 256 m off', async () => {
    const { DECODER_PROBE, probeDeviation } = await import('../../src/engine/sources/terrarium');
    const exact = new Uint8ClampedArray(DECODER_PROBE.rgb.length / 3 * 4);
    for (let i = 0, o = 0; i < DECODER_PROBE.rgb.length; i += 3, o += 4) {
      exact[o] = DECODER_PROBE.rgb[i]; exact[o + 1] = DECODER_PROBE.rgb[i + 1]; exact[o + 2] = DECODER_PROBE.rgb[i + 2]; exact[o + 3] = 255;
    }
    expect(probeDeviation(exact)).toBe(0);
    const shifted = exact.slice();
    shifted[4 * 5] += 1;                      // one pixel's R byte, as a colour transform might
    expect(probeDeviation(shifted)).toBeCloseTo(256, 6);
  });
});

describe('chooseDecoder', () => {
  test('the first exact decoder wins; when the fast path is off, the report says by how much', async () => {
    const { chooseDecoder } = await import('../../src/engine/sources/terrarium');
    expect(chooseDecoder([{ how: 'bitmap', deviation: 0 }, { how: 'image', deviation: 0 }]))
      .toEqual({ decoder: 'bitmap', report: 'exakt (bitmap)' });
    expect(chooseDecoder([{ how: 'bitmap', deviation: 512 }, { how: 'image', deviation: 0 }]))
      .toEqual({ decoder: 'image', report: 'exakt (image), bitmap ±512 m' });
    expect(chooseDecoder([{ how: 'bitmap', deviation: null }, { how: 'image', deviation: 3 }]))
      .toEqual({ decoder: 'image', report: 'kein Dekoder exakt: bitmap fehlgeschlagen, image ±3 m' });
  });
});
