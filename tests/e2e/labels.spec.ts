/**
 * Summit labels over the panorama. The catalogue is the fixture's own
 * (tests/e2e/fixtures/peaks), served next to the tiles; expectations for
 * where a label sits come from the terrain formula, not from a picture.
 */
import { expect, Page, test } from '@playwright/test';
import { PEAKS, RIDGE_CREST, STAND, heightAt, summitScreenY } from './fixtures/terrain';

const TILES = '/tests/e2e/fixtures/tiles/';
const PEAK_CELLS = '/tests/e2e/fixtures/peaks/';
const W = 1000, H = 600;
const R_EFF_M = 6371008.8 / (1 - 0.13);

function url(hash: Record<string, number | string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, peaks: PEAK_CELLS, lakes: '/tests/e2e/fixtures/lakes/', q: 'high' });
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

/** The drawn apex of the view: the column whose terrain reaches highest, and that row (range buffer, read bottom-up). */
const drawnApex = (page: Page) => page.evaluate(async () => {
  const r = await (window as any).alp.renderer.readRange();
  let best = { x: -1, y: Infinity };
  for (let c = 0; c < r.width; c++) {
    for (let y = 0; y < r.height; y++) {
      if (r.pixels[((r.height - 1 - y) * r.width + c) * 4 + 3] > 0) {
        if (y < best.y) best = { x: (c * 1000) / r.width, y: (y * 600) / r.height };
        break;
      }
    }
  }
  return best;
});

/**
 * How far the Testhorn's pin is from the drawn apex, in units of the
 * tolerance (3 px across, 3 px down): below 1 means on it. A label from a
 * rebuild on half-loaded levels can stand for a moment; the final one counts.
 */
const pinOffApex = async (page: Page) => {
  const t = (await labels(page)).find((l) => l.name === 'Testhorn');
  if (!t) return Infinity;
  const apex = await drawnApex(page);
  return Math.max(Math.abs(t.ax - apex.x) / 3, Math.abs(t.ay - apex.y) / 3);
};

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

  test('the leader line stops a little above the summit instead of sticking in it', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Testhorn']);
    const [t] = await labels(page);
    // Nothing painted on the summit itself, the line (and its dot) just above.
    expect(await inkIn(page, { bx: t.ax - 3, by: t.ay - 2, bw: 6, bh: 5 })).toBe(0);
    expect(await inkIn(page, { bx: t.ax - 3, by: t.ay - 10, bw: 6, bh: 6 })).toBeGreaterThan(0);
  });

  test('zoomed in on a phone-quality mesh, the Testhorn label sits on the apex as drawn, not above it', async ({ page }) => {
    // Beyond a few kilometres the polar mesh steps a percent or two of the
    // range between rings, so a sharp apex falls between two rings and is
    // drawn lower than the DEM holds it. At 60° nobody sees that; zoomed to
    // 5° a label anchored on the DEM summit floats tens of pixels above the
    // drawn one (Schynige Platte, 2026). The anchor follows the mesh.
    const q = new URLSearchParams({ tiles: TILES, peaks: PEAK_CELLS, lakes: '/tests/e2e/fixtures/lakes/', q: 'low' });
    await page.goto(`/dist/?${q}#lon=${STAND.lon}&lat=${STAND.lat}&yaw=90&pitch=26&fov=5`);
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Testhorn']);
    await expect.poll(() => pinOffApex(page), { timeout: 30_000 }).toBeLessThan(1);
  });

  test('a summit catalogued on its flank gets its pin on the drawn top, not in the air beside it or in the slope', async ({ page }) => {
    // OSM points often sit some tens of metres off the top. Here the Testhorn
    // is catalogued 60 m north of its apex, on the flank: the pin belongs on
    // the apex as drawn (Schynige Platte, 2026: pins in the slope).
    await page.route(/fixtures\/peaks\/10_47\.json/, (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(PEAKS.map((p) => (p.n === 'Testhorn' ? { ...p, a: p.a + 60 / 111320 } : p))),
    }));
    const q = new URLSearchParams({ tiles: TILES, peaks: PEAK_CELLS, lakes: '/tests/e2e/fixtures/lakes/', q: 'low' });
    await page.goto(`/dist/?${q}#lon=${STAND.lon}&lat=${STAND.lat}&yaw=90&pitch=26&fov=5`);
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Testhorn']);
    await expect.poll(() => pinOffApex(page), { timeout: 30_000 }).toBeLessThan(1);
  });

  test('looking north, the ridge is labelled where curvature and refraction put it', async ({ page }) => {
    await page.goto(url({ yaw: 0 }));
    const s = await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Gratspitze']);
    // The Gratspitze on the ripple's crest of the ridge: its bearing and range
    // and its height from the formula.
    const east = (RIDGE_CREST.lon - STAND.lon) * 111320 * Math.cos((STAND.lat * Math.PI) / 180);
    const north = (RIDGE_CREST.lat - STAND.lat) * 111320;
    const range = Math.hypot(east, north);
    const drop = range ** 2 / (2 * R_EFF_M);
    const elev = Math.atan2(heightAt(RIDGE_CREST.lon, RIDGE_CREST.lat) - s.eyeAltitude - drop, range);
    const expectedY = H / 2 - (H / 2) * Math.tan(elev) / Math.tan(Math.PI / 6);
    const expectedX = W / 2 + (W / 2) * (east / north) / (Math.tan(Math.PI / 6) * (W / H));
    // A label from a rebuild on half-loaded levels can stand until the last
    // rebuild's sightlines are done; where it ends up is what counts.
    await expect.poll(async () => Math.abs((await labels(page))[0].ay - expectedY), { timeout: 30_000 }).toBeLessThan(H * 0.01);
    const [g] = await labels(page);
    // Within a ray and a half of the mesh either way: the pin sits on the drawn crest.
    expect(Math.abs(g.ax - expectedX)).toBeLessThan(4);
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
