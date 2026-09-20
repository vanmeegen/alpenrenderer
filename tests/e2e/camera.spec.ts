/**
 * The live camera behind the terrain. Chromium plays a fixture Y4M file as
 * the device camera: light grey above, dark grey below. In camera mode the
 * composite shows that frame washed towards white with the skyline drawn
 * over it, the field of view follows the lens, and "Foto" saves a PNG.
 */
import { expect, Page, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMERA_BOTTOM_Y, CAMERA_FRAME, CAMERA_TOP_Y, STAND, skylineRow } from './fixtures/terrain';
import { CHROMIUM_ARGS, EXECUTABLE } from './playwright.config';
import { coverFovY } from '../../src/app/cameraFeed';

const here = dirname(fileURLToPath(import.meta.url));
const TILES = '/tests/e2e/fixtures/tiles/';
const W = 1000, H = 600;
/** The renderer's wash: the camera image is desaturated and mixed towards white. */
const WHITEN = 0.62;
const DEFAULT_LENS_FOV = 51;

test.use({
  launchOptions: {
    ...EXECUTABLE,
    args: [...CHROMIUM_ARGS, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${join(here, 'fixtures', 'camera.y4m')}`],
  },
  permissions: ['camera'],
});

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
  return page.evaluate(() => (window as any).alp.status() as { eyeAltitude: number });
}

/** Mean RGB (0..1) of the composited image in a window, top-down coordinates. */
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

/** Darkest luminance (0..1) in a column segment of the composited image. */
async function darkest(page: Page, x: number, y0: number, h: number): Promise<number> {
  return page.evaluate(async ([x, y0, h]) => {
    const c = await (window as any).alp.renderer.capture();
    let best = 1;
    for (let y = y0; y < y0 + h; y++) {
      const o = (y * c.width + x) * 4;
      best = Math.min(best, (0.2126 * c.pixels[o] + 0.7152 * c.pixels[o + 1] + 0.0722 * c.pixels[o + 2]) / 255);
    }
    return best;
  }, [x, y0, h]);
}

const hashNum = async (page: Page, key: string) =>
  Number(new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get(key));

/** What the wash makes of a grey of luma `y8`. */
const washed = (y8: number) => y8 / 255 * (1 - WHITEN) + WHITEN;

test.describe('camera mode', () => {
  test('shows the camera frame washed towards white, the skyline drawn over it, and follows the lens', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    await page.getByRole('button', { name: 'Kamera', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Kamera aus' })).toBeVisible({ timeout: 30_000 });
    // The field of view is the lens angle, cover-cropped into the canvas.
    const fov = coverFovY(DEFAULT_LENS_FOV, CAMERA_FRAME.width, CAMERA_FRAME.height, W, H);
    await expect.poll(() => hashNum(page, 'fov'), { timeout: 30_000 }).toBeCloseTo(fov, 0);
    await expect(page.getByText(/Kamera/).first()).toBeVisible();

    // Top of the frame: light grey, washed. Bottom: dark grey, washed. Neutral both.
    await expect.poll(async () => (await rgb(page, 100, 20, 40, 20))[1], { timeout: 30_000 }).toBeCloseTo(washed(CAMERA_TOP_Y), 1);
    const top = await rgb(page, 100, 20, 40, 20);
    const bottom = await rgb(page, 100, 560, 40, 20);
    expect(Math.abs(top[0] - top[2])).toBeLessThan(0.03);          // no blue sky tint any more
    expect(bottom[1]).toBeCloseTo(washed(CAMERA_BOTTOM_Y), 1);
    // The Testhorn's silhouette is still drawn, as ink, where the DEM march
    // puts the skyline: at this narrower field of view the apex is above the
    // frame, so the flank is checked, a quarter of the way in.
    const flank = skylineRow(90, 250, s.eyeAltitude, fov, W, H);
    expect(flank).toBeGreaterThan(10);
    expect(await darkest(page, 250, Math.round(flank) - 4, 9)).toBeLessThan(0.45);
    expect(await darkest(page, 250, 10, 9)).toBeGreaterThan(0.8);   // and only there

    await page.getByRole('button', { name: 'Kamera aus' }).click();
    await expect(page.getByRole('button', { name: 'Kamera', exact: true })).toBeVisible();
    await expect.poll(async () => { const t = await rgb(page, 100, 20, 40, 20); return t[2] - t[0]; }, { timeout: 30_000 })
      .toBeGreaterThan(0.05);                                       // the sky is blue again
  });

  test('the lens field of view can be corrected by hand and the view follows', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Kamera', exact: true }).click();
    const slider = page.getByLabel('Objektiv');
    await expect(slider).toBeVisible({ timeout: 30_000 });
    await slider.fill('70');
    const fov = coverFovY(70, CAMERA_FRAME.width, CAMERA_FRAME.height, W, H);
    await expect.poll(() => hashNum(page, 'fov'), { timeout: 30_000 }).toBeCloseTo(fov, 0);
  });

  test('"Foto" saves a PNG of the view with the labels', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Kamera', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Foto' })).toBeVisible({ timeout: 30_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Foto' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^alpen-\d{8}-\d{6}-47\.0000_10\.0000-90deg\.png$/);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const png = readFileSync(path!);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(W);
    expect(png.readUInt32BE(20)).toBe(H);
  });
});

test.describe('camera refused', () => {
  test('is reported and the view stays shaded', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    });
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Kamera', exact: true }).click();
    await expect(page.getByText('Kamera nicht verfügbar: Zugriff verweigert.')).toBeVisible({ timeout: 30_000 });
    const top = await rgb(page, 100, 20, 40, 20);
    expect(top[2] - top[0]).toBeGreaterThan(0.05);
  });
});
