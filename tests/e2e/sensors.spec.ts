/**
 * The view axis from the device's sensors. No real sensor here: the page
 * dispatches `deviceorientationabsolute` events itself, at a steady rate,
 * with the Euler angles of a phone held upright and pointed along a known
 * bearing. Expectations come from the fixture terrain and the World
 * Magnetic Model, not from a picture.
 */
import { expect, Page, test } from '@playwright/test';
import { STAND, skylineRow, summitScreenY } from './fixtures/terrain';
import { declinationAt } from '../../src/engine/core/pose';
import { wrap360 } from '../../src/app/state';

const TILES = '/tests/e2e/fixtures/tiles/';
const W = 1000, H = 600;
/** Horizontal field of view at 60° vertical in a 1000x600 viewport. */
const HFOV = 2 * Math.atan(Math.tan(Math.PI / 6) * (W / H)) * 180 / Math.PI;
const DECL = declinationAt(STAND.lon, STAND.lat);

function url(hash: Record<string, number | string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, q: 'high' });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon, lat: STAND.lat, yaw: 200, pitch: 0, fov: 60, ...hash })
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

const hashNum = async (page: Page, key: string) =>
  Number(new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get(key));

async function skyRows(page: Page, x: number): Promise<number> {
  return page.evaluate(async (col) => {
    const r = await (window as any).alp.renderer.readRange();
    let sky = 0;
    for (let y = 0; y < r.height; y++) if (r.pixels[(y * r.width + col) * 4 + 3] === 0) sky++;
    return sky;
  }, x);
}

/** Magnetic alpha of a phone held upright and looking along true bearing `yaw`. */
const alphaFor = (yaw: number) => wrap360(360 - (yaw - DECL));

/**
 * Points the simulated phone: Euler angles of an upright phone facing `yaw`,
 * dispatched as an absolute orientation event every 16 ms until changed.
 */
async function point(page: Page, yaw: number, beta = 90) {
  await page.evaluate(([alpha, beta]) => {
    const w = window as any;
    w.__reading = { alpha, beta, gamma: 0 };
    if (!w.__feed) {
      w.__feed = setInterval(() => {
        const r = w.__reading;
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute',
          { alpha: r.alpha, beta: r.beta, gamma: r.gamma, absolute: true }));
      }, 16);
    }
  }, [alphaFor(yaw), beta]);
}

const yawClose = (page: Page, yaw: number, tol = 0.6) =>
  expect.poll(async () => {
    const d = ((await hashNum(page, 'yaw')) - yaw + 540) % 360 - 180;
    return Math.abs(d);
  }, { timeout: 30_000 }).toBeLessThan(tol);

test.describe('sensors', () => {
  test('the view follows the device: pointed at the Testhorn, the summit is dead centre', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    await page.getByRole('button', { name: 'Sensoren' }).click();
    await point(page, 90);
    await yawClose(page, 90);
    await expect.poll(() => hashNum(page, 'pitch')).toBeCloseTo(0, 0);
    await expect(page.getByText(/Sensoren/).first()).toBeVisible();
    // The renderer draws what the sensors say: the summit on its computed row.
    const expected = summitScreenY(s.eyeAltitude, 60) * H;
    await expect.poll(() => skyRows(page, W / 2)).toBeLessThan(expected + H * 0.02);
    expect(Math.abs((await skyRows(page, W / 2)) - expected)).toBeLessThan(H * 0.02);
    // The compass rose shows the heading.
    await expect.poll(() => page.locator('.alp-compass').getAttribute('data-yaw').then(Number)).toBeCloseTo(90, 0);

    // Turn the phone around: the plain, where the DEM march puts it.
    await point(page, 270);
    await yawClose(page, 270);
    const plain = skylineRow(270, W / 2, s.eyeAltitude, 60, W, H);
    await expect.poll(() => skyRows(page, W / 2)).toBeGreaterThan(plain - H * 0.01);
    expect(Math.abs((await skyRows(page, W / 2)) - plain)).toBeLessThan(H * 0.01);
  });

  test('a drag corrects the compass instead of being undone by it, and the correction survives a reload', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Sensoren' }).click();
    await point(page, 90);
    await yawClose(page, 90);

    // 100 px to the left at 60° fov: the view turns right by a tenth of the horizontal fov.
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(550, 300, { steps: 5 });
    await page.mouse.move(500, 300, { steps: 5 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    const corrected = 90 + HFOV / 10;
    await yawClose(page, corrected);
    await page.waitForTimeout(1500);              // the sensors keep reporting 90...
    await yawClose(page, corrected);              // ...and the view stays corrected
    await expect(page.getByText(/Korrektur \+8[,.]\d°/)).toBeVisible();
    expect(Number(await page.locator('.alp-compass').getAttribute('data-offset'))).toBeCloseTo(HFOV / 10, 0);

    await page.reload();
    await ready(page);
    expect(await hashNum(page, 'yaw')).toBeCloseTo(corrected, 0);   // the URL kept the view
    await page.getByRole('button', { name: 'Sensoren' }).click();
    await point(page, 90);
    await page.waitForTimeout(1500);
    await yawClose(page, corrected);              // the stored correction is applied again
    await page.getByRole('button', { name: 'Korrektur zurücksetzen' }).click();
    await yawClose(page, 90);
  });

  test('switching the sensors off keeps the view and stops following', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Sensoren' }).click();
    await point(page, 90);
    await yawClose(page, 90);
    await page.getByRole('button', { name: 'Sensoren aus' }).click();
    await point(page, 270);
    await page.waitForTimeout(1500);
    expect(await hashNum(page, 'yaw')).toBeCloseTo(90, 0);
    await expect(page.getByRole('button', { name: 'Sensoren', exact: true })).toBeVisible();
  });
});

test.describe('motion access refused', () => {
  test('is reported, and the view does not follow', async ({ page }) => {
    // iOS gates the sensors behind a prompt; this is the browser saying no.
    await page.addInitScript(() => {
      (DeviceOrientationEvent as any).requestPermission = () => Promise.resolve('denied');
    });
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Sensoren' }).click();
    await expect(page.getByText('Sensoren nicht verfügbar: Zugriff verweigert.')).toBeVisible();
    await point(page, 90);
    await page.waitForTimeout(1000);
    expect(await hashNum(page, 'yaw')).toBe(200);
  });
});
