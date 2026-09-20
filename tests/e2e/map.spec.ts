/**
 * Choosing the standpoint: on an OpenStreetMap map with the fingers, or from
 * the device's GPS. Map tiles are never fetched from the network here; every
 * request to the tile host is answered with one flat PNG.
 */
import { expect, Page, test } from '@playwright/test';
import { STAND } from './fixtures/terrain';
import { MAP_ZOOM } from '../../src/app/mapPicker';

const TILES = '/tests/e2e/fixtures/tiles/';
const W = 1000, H = 600;

/** A 1x1 opaque PNG, enough for Leaflet to count the tile as loaded. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAKEAX5b7B7YAAAAAElFTkSuQmCC', 'base64');

function url(hash: Record<string, number | string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, q: 'high' });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon, lat: STAND.lat, yaw: 90, pitch: 0, fov: 60, ...hash })
    .map(([k, v]) => [k, String(v)]));
  return `/dist/?${q}#${h}`;
}

async function ready(page: Page) {
  await page.waitForFunction(() => {
    const v = (window as any).alp;
    if (!v) return false;
    const s = v.status();
    return s.levelsReady >= s.levels && s.diagnostics.framesDrawn > 3;
  }, null, { timeout: 120_000 });
}

const hashNum = async (page: Page, key: string) =>
  Number(new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get(key));

test.beforeEach(async ({ page }) => {
  await page.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'image/png', body: PNG_1x1 }));
});

test.describe('map picker', () => {
  test('opens on the standpoint with OpenStreetMap tiles, attribution and a marker', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Karte' }).click();
    const map = page.locator('.leaflet-container');
    await expect(map).toBeVisible();
    await expect(page.locator('.leaflet-tile-loaded').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
    await expect(page.locator('.alp-marker')).toBeVisible();
    // The map is centred on the standpoint: the marker sits mid-container.
    const box = (await map.boundingBox())!;
    const m = (await page.locator('.alp-marker').boundingBox())!;
    expect(Math.abs(m.x + m.width / 2 - (box.x + box.width / 2))).toBeLessThan(4);
    expect(Math.abs(m.y + m.height / 2 - (box.y + box.height / 2))).toBeLessThan(4);
  });

  test('tapping the map and confirming moves the standpoint there and keeps the bearing', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Karte' }).click();
    const map = page.locator('.leaflet-container');
    const box = (await map.boundingBox())!;
    // 30 px east of the centre at the map's zoom: a known longitude offset.
    const dx = 30;
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2);
    await page.getByRole('button', { name: 'Panorama von hier' }).click();
    await expect(map).toBeHidden();
    const expectedLon = STAND.lon + (dx * 360) / (256 * 2 ** MAP_ZOOM);
    await expect.poll(() => hashNum(page, 'lon'), { timeout: 30_000 }).toBeCloseTo(expectedLon, 3);
    await expect.poll(() => hashNum(page, 'lat'), { timeout: 30_000 }).toBeCloseTo(STAND.lat, 3);
    expect(await hashNum(page, 'yaw')).toBe(90);
    await ready(page);
  });

  test('closing without confirming changes nothing', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Karte' }).click();
    const box = (await page.locator('.leaflet-container').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 80, box.y + box.height / 2);
    await page.getByRole('button', { name: 'Schließen' }).click();
    await expect(page.locator('.leaflet-container')).toBeHidden();
    expect(await hashNum(page, 'lon')).toBeCloseTo(STAND.lon, 4);
  });
});

test.describe('GPS', () => {
  test.use({
    geolocation: { latitude: STAND.lat + 0.001, longitude: STAND.lon + 0.002, accuracy: 8 },
    permissions: ['geolocation'],
  });

  test('"Mein Standort" moves the standpoint to the device position', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Karte' }).click();
    await page.getByRole('button', { name: 'Mein Standort' }).click();
    await expect.poll(() => hashNum(page, 'lon'), { timeout: 30_000 }).toBeCloseTo(STAND.lon + 0.002, 4);
    await expect.poll(() => hashNum(page, 'lat'), { timeout: 30_000 }).toBeCloseTo(STAND.lat + 0.001, 4);
    await expect(page.locator('.leaflet-container')).toBeHidden();
    await expect(page.getByText(/GPS/)).toBeVisible();
  });
});

test.describe('GPS refused', () => {
  test('a refused position is reported, the standpoint stays', async ({ page }) => {
    // The browser's answer to "Nicht erlauben": the error callback with
    // PERMISSION_DENIED. Injected, because a headless prompt is never answered.
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, fail) => {
        fail?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
      };
    });
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Karte' }).click();
    await page.getByRole('button', { name: 'Mein Standort' }).click();
    await expect(page.getByText('Standort nicht verfügbar: Zugriff verweigert.')).toBeVisible({ timeout: 30_000 });
    expect(await hashNum(page, 'lon')).toBeCloseTo(STAND.lon, 4);
  });
});
