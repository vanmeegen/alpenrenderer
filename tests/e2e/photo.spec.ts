/**
 * A photo behind the outline. The fixture photo was rendered from the test
 * range by a camera at a known pose (tests/e2e/fixtures/terrain.ts, PHOTO)
 * and carries the standpoint and the lens in its EXIF. Loading it sets
 * both; "Ausrichten" must recover the heading and pitch from the skyline.
 */
import { expect, Page, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTO, STAND, TESTHORN_BEARING } from './fixtures/terrain';
import { coverFovY } from '../../src/app/cameraFeed';

const here = dirname(fileURLToPath(import.meta.url));
const TILES = '/tests/e2e/fixtures/tiles/';
const PEAK_CELLS = '/tests/e2e/fixtures/peaks/';
const W = 1000, H = 600;

function url(hash: Record<string, number | string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, peaks: PEAK_CELLS, q: 'high' });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon + 0.01, lat: STAND.lat, yaw: 90, pitch: 0, fov: 60, ...hash })
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

async function rgb(page: Page, x0: number, y0: number, w: number, h: number): Promise<[number, number, number]> {
  return page.evaluate(async ([x0, y0, w, h]) => {
    const c = await (window as any).alp.renderer.capture();
    const sum = [0, 0, 0];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const o = (y * c.width + x) * 4;
      sum[0] += c.pixels[o]; sum[1] += c.pixels[o + 1]; sum[2] += c.pixels[o + 2];
    }
    const n = w * h * 255;
    return [sum[0] / n, sum[1] / n, sum[2] / n] as [number, number, number];
  }, [x0, y0, w, h]);
}

const labels = (page: Page) => page.evaluate(() => (window as any).alp.labels() as { name: string; ax: number; ay: number }[]);

test.describe('photo mode', () => {
  test('a photo with EXIF sets the standpoint and the lens; alignment recovers the pose; labels land on the photo', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    expect(await hashNum(page, 'lon')).toBeCloseTo(STAND.lon + 0.01, 3);
    await page.getByLabel('Foto laden').setInputFiles(join(here, 'fixtures', 'photo.png'));
    // The standpoint is the photo's, the field of view the lens's, cover-cropped.
    await expect.poll(() => hashNum(page, 'lon'), { timeout: 30_000 }).toBeCloseTo(STAND.lon, 4);
    const fov = coverFovY(PHOTO.fovY, PHOTO.width, PHOTO.height, W, H);
    await expect.poll(() => hashNum(page, 'fov'), { timeout: 30_000 }).toBeCloseTo(fov, 0);
    await expect(page.getByText('(Foto-GPS)')).toBeVisible();
    await expect(page.getByText('Objektiv aus EXIF')).toBeVisible();
    // The photo's grey sky is behind the outline, not the blue one.
    await ready(page);
    await expect.poll(async () => { const t = await rgb(page, 100, 20, 40, 20); return Math.abs(t[2] - t[0]); }, { timeout: 30_000 }).toBeLessThan(0.03);

    // Alignment: from the URL's 90° / 0° to the photo's 94° / 2°.
    await page.getByRole('button', { name: 'Ausrichten' }).click();
    await expect(page.locator('.alp-align')).toContainText(/Ausgerichtet: Fit \d+ %/, { timeout: 60_000 });
    await expect.poll(() => hashNum(page, 'yaw'), { timeout: 30_000 }).toBeCloseTo(PHOTO.yaw, 0);
    expect(Math.abs((await hashNum(page, 'yaw')) - PHOTO.yaw)).toBeLessThan(0.5);
    expect(Math.abs((await hashNum(page, 'pitch')) - PHOTO.pitch)).toBeLessThan(0.8);

    // The Testhorn's label now sits where the photo shows the summit: 4° left of centre.
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toContain('Testhorn');
    const t = (await labels(page)).find((p) => p.name === 'Testhorn')!;
    const tanH = Math.tan((fov * Math.PI) / 360) * (W / H);
    const expectedX = W / 2 + (Math.tan(((TESTHORN_BEARING - PHOTO.yaw) * Math.PI) / 180) / tanH) * (W / 2);
    expect(Math.abs(t.ax - expectedX)).toBeLessThan(8);

    await page.getByRole('button', { name: 'Foto schließen' }).click();
    await expect.poll(async () => { const t = await rgb(page, 100, 20, 40, 20); return t[2] - t[0]; }, { timeout: 30_000 }).toBeGreaterThan(0.05);
  });

  test('a photo without EXIF keeps the standpoint, says so, and fog cannot be aligned', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByLabel('Foto laden').setInputFiles(join(here, 'fixtures', 'photo-fog.png'));
    await expect(page.getByText('Foto ohne GPS: Standpunkt per Karte setzen.')).toBeVisible({ timeout: 30_000 });
    expect(await hashNum(page, 'lon')).toBeCloseTo(STAND.lon + 0.01, 3);
    await expect(page.getByText('Objektiv geschätzt')).toBeVisible();
    await page.getByRole('button', { name: 'Ausrichten' }).click();
    await expect(page.locator('.alp-align')).toContainText(/Nicht ausgerichtet/, { timeout: 60_000 });
    expect(await hashNum(page, 'yaw')).toBe(90);
  });
});
