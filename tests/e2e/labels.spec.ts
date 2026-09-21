/**
 * Summit labels over the panorama. The catalogue is the fixture's own
 * (tests/e2e/fixtures/peaks), served next to the tiles; expectations for
 * where a label sits come from the terrain formula, not from a picture.
 */
import { expect, Page, test } from '@playwright/test';
import { PEAKS, RIDGE, RIDGE_RANGE, STAND, summitScreenY } from './fixtures/terrain';

const TILES = '/tests/e2e/fixtures/tiles/';
const PEAK_CELLS = '/tests/e2e/fixtures/peaks/';
const W = 1000, H = 600;
const R_EFF_M = 6371008.8 / (1 - 0.13);

function url(hash: Record<string, number | string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, peaks: PEAK_CELLS, q: 'high' });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon, lat: STAND.lat, yaw: 90, pitch: 0, fov: 60, ...hash })
    .map(([k, v]) => [k, String(v)]));
  return `/dist/?${q}#${h}`;
}

interface Placed { name: string; ax: number; ay: number; bx: number; by: number; bw: number; bh: number }

async function ready(page: Page) {
  await page.waitForFunction(() => {
    const v = (window as any).alp;
    if (!v) return false;
    const s = v.status();
    return s.levelsReady >= s.levels && s.diagnostics.framesDrawn > 3;
  }, null, { timeout: 120_000 });
  return page.evaluate(() => (window as any).alp.status() as { eyeAltitude: number; peaks: { total: number; visible: number } });
}

const labels = (page: Page) => page.evaluate(() => (window as any).alp.labels() as Placed[]);

/** Painted pixels of the label overlay inside a box. */
async function inkIn(page: Page, box: { bx: number; by: number; bw: number; bh: number }): Promise<number> {
  return page.evaluate(([bx, by, bw, bh]) => {
    const c = document.querySelector('canvas.labels') as HTMLCanvasElement;
    const dpr = c.width / c.clientWidth;
    const d = c.getContext('2d')!.getImageData(Math.round(bx * dpr), Math.round(by * dpr), Math.round(bw * dpr), Math.round(bh * dpr)).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, [box.bx, box.by, box.bw, box.bh]);
}

test.describe('summit labels', () => {
  test('the Testhorn is labelled at its summit; the Hinterhorn behind it is not', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name).sort()), { timeout: 30_000 }).toEqual(['Testhorn']);
    expect((await ready(page)).peaks).toMatchObject({ total: PEAKS.length, visible: 2 });
    const [t] = await labels(page);
    expect(Math.abs(t.ax - W / 2)).toBeLessThan(3);
    expect(Math.abs(t.ay - summitScreenY(s.eyeAltitude, 60) * H)).toBeLessThan(H * 0.02);
    expect(t.by + t.bh).toBeLessThan(t.ay);
    expect(await inkIn(page, t)).toBeGreaterThan(50);
    await expect(page.getByText('Gipfel 2/3')).toBeVisible();
  });

  test('looking north, the ridge is labelled where curvature and refraction put it', async ({ page }) => {
    await page.goto(url({ yaw: 0 }));
    const s = await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Gratspitze']);
    const [g] = await labels(page);
    const drop = RIDGE_RANGE ** 2 / (2 * R_EFF_M);
    const elev = Math.atan2(RIDGE.height - s.eyeAltitude - drop, RIDGE_RANGE);
    const expectedY = H / 2 - (H / 2) * Math.tan(elev) / Math.tan(Math.PI / 6);
    expect(Math.abs(g.ax - W / 2)).toBeLessThan(3);
    expect(Math.abs(g.ay - expectedY)).toBeLessThan(H * 0.01);
  });

  test('tapping a label opens its card with height, range and bearing', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.length), { timeout: 30_000 }).toBe(1);
    const [t] = await labels(page);
    await page.mouse.click(t.bx + t.bw / 2, t.by + t.bh / 2);
    const card = page.locator('.alp-peak-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Testhorn');
    await expect(card).toContainText('4000 m');
    await expect(card).toContainText('5.0 km');
    await expect(card).toContainText('O 90°');
    await expect(card.getByRole('link', { name: 'Wikipedia' })).toHaveAttribute('href', 'https://de.wikipedia.org/wiki/Testhorn');
    await card.getByRole('button', { name: 'Schließen' }).click();
    await expect(card).toBeHidden();
  });

  test('"Gipfel aus" clears the overlay and back on restores it', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.length), { timeout: 30_000 }).toBe(1);
    const [t] = await labels(page);
    await page.getByRole('button', { name: 'Gipfel aus' }).click();
    await expect.poll(() => labels(page).then((l) => l.length)).toBe(0);
    expect(await inkIn(page, t)).toBe(0);
    await page.getByRole('button', { name: 'Gipfel an' }).click();
    await expect.poll(() => labels(page).then((l) => l.length)).toBe(1);
  });
});
