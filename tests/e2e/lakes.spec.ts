/**
 * Lakes: the Testsee of the synthetic range is drawn as water where the
 * formula puts it, and named on its surface. Seen from 2500 m, a kilometre
 * above the plain, so the ripple hides none of it.
 */
import { expect, Page, test } from '@playwright/test';
import { LAKE, STAND, inLake, terrainHit } from './fixtures/terrain';

const W = 1000, H = 600;
const EYE = 2500;
const R_EFF_M = 6371008.8 / (1 - 0.13);

function url() {
  const q = new URLSearchParams({
    tiles: '/tests/e2e/fixtures/tiles/', peaks: '/tests/e2e/fixtures/peaks/', lakes: '/tests/e2e/fixtures/lakes/', q: 'high',
  });
  const h = new URLSearchParams({ lon: String(STAND.lon), lat: String(STAND.lat), alt: String(EYE), yaw: String(LAKE.bearing), pitch: '0', fov: '60' });
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

/** Mean RGB of the composited image in a window, top-down coordinates. */
async function rgb(page: Page, x0: number, y0: number, w: number, h: number): Promise<[number, number, number]> {
  return page.evaluate(async ([x0, y0, w, h]) => {
    const c = await (window as any).alp.renderer.capture();
    const s = [0, 0, 0];
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * c.width + x) * 4;
        s[0] += c.pixels[o]; s[1] += c.pixels[o + 1]; s[2] += c.pixels[o + 2];
      }
    }
    return s.map((v) => v / (w * h)) as [number, number, number];
  }, [x0, y0, w, h]);
}

const blue = (c: [number, number, number]) => c[2] > c[1] + 10 && c[2] > c[0] + 20;

test.describe('lakes', () => {
  test('the Testsee is water exactly where the formula puts it, ground around it is not', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    // Down the centre column: which rows land on the lake, by the formula.
    const rows: { y: number; wet: boolean }[] = [];
    for (let y = 420; y < H; y += 4) {
      const hit = terrainHit(LAKE.bearing, W / 2, y, EYE, 60, W, H);
      if (hit) rows.push({ y, wet: inLake(hit.lon, hit.lat) });
    }
    const wetRows = rows.filter((r) => r.wet).map((r) => r.y);
    expect(wetRows.length).toBeGreaterThan(10);                 // the lake spans a good band of the screen
    await expect.poll(async () => blue(await rgb(page, W / 2 - 3, wetRows[Math.floor(wetRows.length / 2)] - 3, 6, 6)),
      { timeout: 30_000 }).toBe(true);
    let wrong = 0;
    for (const r of rows) {
      const shore = rows.some((o) => o.wet !== r.wet && Math.abs(o.y - r.y) <= 4);
      if (shore) continue;                                      // the shoreline itself is a DEM post wide
      if (blue(await rgb(page, W / 2 - 2, r.y - 2, 4, 4)) !== r.wet) wrong++;
    }
    expect(wrong).toBe(0);
  });

  test('the Testsee is named on its surface, straight ahead', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    const drop = LAKE.range ** 2 / (2 * R_EFF_M);
    const elev = Math.atan2(LAKE.surface - EYE - drop, LAKE.range);
    const expectedY = H / 2 - (H / 2) * Math.tan(elev) / Math.tan(Math.PI / 6);
    const lake = async () => ((await page.evaluate(() => (window as any).alp.labels())) as { name: string; ax: number; ay: number }[])
      .find((l) => l.name === 'Testsee');
    await expect.poll(async () => (await lake())?.ay ?? -1000, { timeout: 30_000 }).toBeCloseTo(expectedY, -1);
    const l = (await lake())!;
    expect(Math.abs(l.ax - W / 2)).toBeLessThan(3);
    expect(Math.abs(l.ay - expectedY)).toBeLessThan(H * 0.01);
  });
});
