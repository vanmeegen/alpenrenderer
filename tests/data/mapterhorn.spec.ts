/**
 * Does the live Mapterhorn data still look the way the app assumes?
 *
 * Runs only by hand (`bun run test:data`, or the data-check workflow): it
 * talks to the real tile server and download host, so it must never sit in
 * CI where rate limits or a survey update would break unrelated builds.
 * Decoding happens in Chromium, the same way the app decodes.
 */
import { APIRequestContext, expect, Page, test } from '@playwright/test';
import { PMTiles, RangeResponse, Source } from 'pmtiles';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Reference {
  tilejson: { url: string; encoding: string; tileSize: number; scheme: string; tiles: string[] };
  tileTemplate: string;
  coverageIndex: string;
  attribution: string;
  summits: { name: string; lon: number; lat: number; catalogue: number; z: number; radiusPx: number; expect: number; tolerance: number }[];
  lowZoomTiles: { z: number; x: number; y: number }[];
  beyondMaxZoom: { z: number; x: number; y: number };
  expectedSources: Record<string, string[]>;
  attributionMustContain: string[];
}
const ref: Reference = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'reference.json'), 'utf8'));

const UA = 'Mozilla/5.0 alpenrenderer-data-check';
const tileUrl = (z: number, x: number, y: number) => ref.tileTemplate.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);

const n = (z: number) => 512 * 2 ** z;
const mercX = (lon: number, z: number) => ((lon + 180) / 360) * n(z);
const mercY = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n(z);
};

test.use({ extraHTTPHeaders: { 'user-agent': UA } });

test.describe('TileJSON', () => {
  test('still advertises 512-px terrarium XYZ tiles at the known URL', async ({ request }) => {
    const res = await request.get(ref.tilejson.url);
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({
      encoding: ref.tilejson.encoding, tileSize: ref.tilejson.tileSize,
      scheme: ref.tilejson.scheme, tiles: ref.tilejson.tiles,
    });
  });
});

test.describe('tiles', () => {
  test('a tile is a lossless 512x512 WebP with open CORS and long caching', async ({ request }) => {
    const res = await request.get(tileUrl(12, 2135, 1457));
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/webp');
    expect(res.headers()['access-control-allow-origin']).toBe('*');
    expect(res.headers()['cache-control']).toMatch(/max-age=\d+/);
    const b = await res.body();
    expect(b.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(b.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(b.subarray(12, 16).toString('ascii')).toBe('VP8L');   // lossless, or the heights are garbage
    // VP8L header: 0x2f then 14 bits width-1, 14 bits height-1.
    const w = 1 + ((b[21] | (b[22] << 8)) & 0x3fff);
    const h = 1 + (((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3fff);
    expect([w, h]).toEqual([512, 512]);
  });

  test('low zooms exist globally', async ({ request }) => {
    for (const t of ref.lowZoomTiles) {
      const res = await request.get(tileUrl(t.z, t.x, t.y));
      expect(res.status(), `tile ${t.z}/${t.x}/${t.y}`).toBe(200);
    }
  });

  test('zoom 18 is still absent, so the app must not ask for it', async ({ request }) => {
    const t = ref.beyondMaxZoom;
    const res = await request.get(tileUrl(t.z, t.x, t.y));
    expect(res.status()).toBe(404);
  });
});

test.describe('summit heights', () => {
  for (const s of ref.summits) {
    test(`${s.name} at z${s.z} decodes to ${s.expect} m ± ${s.tolerance}`, async ({ page, request }) => {
      const x = mercX(s.lon, s.z), y = mercY(s.lat, s.z);
      const tx = Math.floor(x / 512), ty = Math.floor(y / 512);
      const got = await decodeSummit(page, request, tileUrl(s.z, tx, ty), x - tx * 512, y - ty * 512, s.radiusPx);
      expect(got.width).toBe(512);
      expect(Math.abs(got.max - s.expect), `${s.name}: got ${got.max}`).toBeLessThanOrEqual(s.tolerance);
      // Whatever the survey says, it must not be far above the catalogue.
      expect(got.max).toBeLessThan(s.catalogue + 15);
    });
  }
});

test.describe('coverage index and attribution', () => {
  test('the coverage index names the expected surveys under each summit', async ({ request }) => {
    const p = new PMTiles(new RequestSource(request, ref.coverageIndex));
    const header = await p.getHeader();
    expect(header.maxZoom).toBe(12);
    const found: Record<string, string[]> = {};
    for (const s of ref.summits.filter((x) => x.z === 12)) {
      const nn = 256 * 2 ** 12;
      const x = Math.floor(((s.lon + 180) / 360) * nn / 256);
      const si = Math.sin((s.lat * Math.PI) / 180);
      const y = Math.floor((0.5 - Math.log((1 + si) / (1 - si)) / (4 * Math.PI)) * nn / 256);
      const t = await p.getZxy(12, x, y);
      found[s.name] = t ? Object.keys(JSON.parse(new TextDecoder().decode(t.data))) : [];
    }
    for (const [name, ids] of Object.entries(ref.expectedSources)) {
      for (const id of ids) expect(found[name], `${name} should list ${id}`).toContain(id);
    }
  });

  test('attribution.json still lists the Alpine surveys with licence and producer', async ({ request }) => {
    const res = await request.get(ref.attribution);
    expect(res.status()).toBe(200);
    const list = (await res.json()) as { source: string; license?: string; producer?: string; resolution?: number }[];
    expect(list.length).toBeGreaterThan(100);
    const byId = new Map(list.map((e) => [e.source, e]));
    for (const id of ref.attributionMustContain) {
      const e = byId.get(id);
      expect(e, `source ${id}`).toBeTruthy();
      expect(e!.license, `${id} licence`).toBeTruthy();
      expect(e!.producer, `${id} producer`).toBeTruthy();
      expect(e!.resolution, `${id} resolution`).toBeGreaterThan(0);
    }
  });
});

/** PMTiles over Playwright's request context, so it works wherever the tests run. */
class RequestSource implements Source {
  constructor(private request: APIRequestContext, private url: string) {}
  getKey() { return this.url; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const res = await this.request.get(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    expect(res.status(), 'range request').toBe(206);
    const b = await res.body();
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

/** Fetches a tile in Node and decodes it in the browser; returns the highest sample near (px, py). */
async function decodeSummit(page: Page, request: APIRequestContext, url: string, px: number, py: number, radius: number) {
  const res = await request.get(url);
  expect(res.status(), url).toBe(200);
  const b64 = (await res.body()).toString('base64');
  await page.goto('about:blank');
  return page.evaluate(async ({ b64, px, py, radius }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let max = -Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.floor(px) + dx, y = Math.floor(py) + dy;
        if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) continue;
        const o = (y * bmp.width + x) * 4;
        max = Math.max(max, d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768);
      }
    }
    return { width: bmp.width, height: bmp.height, max };
  }, { b64, px, py, radius });
}
