/**
 * A phone held sideways: 844 x 390. The menu is a narrow rail of icons at
 * the left edge, panels open next to it without covering the view, and the
 * whole menu folds away to a single button.
 */
import { expect, Page, test } from '@playwright/test';
import { STAND } from './fixtures/terrain';

const TILES = '/tests/e2e/fixtures/tiles/';
const W = 844, H = 390;

test.use({ viewport: { width: W, height: H }, hasTouch: true });

function url() {
  const q = new URLSearchParams({ tiles: TILES, peaks: '/tests/e2e/fixtures/peaks/', lakes: '/tests/e2e/fixtures/lakes/', q: 'high' });
  const h = new URLSearchParams({ lon: String(STAND.lon), lat: String(STAND.lat), yaw: '90', pitch: '0', fov: '60' });
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

/** Screen area covered by everything that takes touches, as a fraction of the screen. */
async function covered(page: Page): Promise<number> {
  return page.evaluate(([w, h]) => {
    const els = [...document.querySelectorAll<HTMLElement>('.pointer-events-auto')]
      .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
    // Rasterise the boxes coarsely so that overlaps are not counted twice.
    const cell = 4, cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    const hit = new Uint8Array(cols * rows);
    for (const e of els) {
      const r = e.getBoundingClientRect();
      for (let y = Math.max(0, Math.floor(r.top / cell)); y < Math.min(rows, Math.ceil(r.bottom / cell)); y++) {
        for (let x = Math.max(0, Math.floor(r.left / cell)); x < Math.min(cols, Math.ceil(r.right / cell)); x++) hit[y * cols + x] = 1;
      }
    }
    return hit.reduce((a, b) => a + b, 0) / hit.length;
  }, [W, H]);
}

test.describe('phone held sideways', () => {
  test('the menu is a narrow rail of icons at the left edge, all of it on screen', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    const rail = page.getByRole('navigation', { name: 'Menü' });
    const box = (await rail.boundingBox())!;
    expect(box.x).toBeLessThan(12);
    expect(box.width).toBeLessThanOrEqual(80);
    for (const name of ['Karte', 'Standpunkt', 'Sensoren', 'Kamera', 'Foto laden', 'Gipfel aus', 'Umrisse aus', 'Einstellungen', 'Quellen', 'Check']) {
      const b = (await rail.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.y + b.height, name).toBeLessThanOrEqual(H);
      expect(b.width, name).toBeLessThanOrEqual(40);
    }
    // Rail and status together leave four fifths of the screen to the view.
    expect(await covered(page)).toBeLessThan(0.2);
  });

  test('a panel opens beside the rail, fits on the screen and scrolls', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Standpunkt' }).click();
    const panel = page.getByRole('region', { name: 'Standpunkt wählen' });
    await expect(panel).toBeVisible();
    const b = (await panel.boundingBox())!;
    const rail = (await page.getByRole('navigation', { name: 'Menü' }).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    expect(b.x + b.width).toBeLessThan(W * 0.6);
    expect(b.y + b.height).toBeLessThanOrEqual(H);
  });

  test('the whole menu folds away to one button and comes back', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Standpunkt' }).click();
    await page.getByRole('button', { name: 'Menü ausblenden' }).click();
    await expect(page.getByRole('button', { name: 'Karte' })).toBeHidden();
    await expect(page.getByRole('region', { name: 'Standpunkt wählen' })).toBeHidden();
    const only = page.getByRole('button', { name: 'Menü einblenden' });
    const b = (await only.boundingBox())!;
    expect(b.width).toBeLessThanOrEqual(40);
    expect(b.height).toBeLessThanOrEqual(40);
    expect(await covered(page)).toBeLessThan(0.01);
    await only.click();
    await expect(page.getByRole('button', { name: 'Karte' })).toBeVisible();
  });
});
