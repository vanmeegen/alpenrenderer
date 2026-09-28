/**
 * Lakes: the Testsee of the synthetic range is drawn as water where the
 * formula puts it, and named on its surface. Seen from 2500 m, a kilometre
 * above the plain, so the ripple hides none of it.
 */
import { expect, Page, test } from '@playwright/test';
import { LAKE, STAND, inLake, terrainHit } from './fixtures/terrain';
import { luminance, terrainColor } from '../../src/engine/render/shading';

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

type Win = [number, number, number, number];

/** Mean RGB of the composited image in several windows (x, y, w, h, top-down), from one capture. */
async function rgbs(page: Page, wins: Win[]): Promise<[number, number, number][]> {
  return page.evaluate(async (wins) => {
    const c = await (window as any).alp.renderer.capture();
    return wins.map(([x0, y0, w, h]) => {
      const s = [0, 0, 0];
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const o = (y * c.width + x) * 4;
          s[0] += c.pixels[o]; s[1] += c.pixels[o + 1]; s[2] += c.pixels[o + 2];
        }
      }
      return s.map((v) => v / (w * h)) as [number, number, number];
    });
  }, wins);
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
    const mid = wetRows[Math.floor(wetRows.length / 2)];
    await expect.poll(async () => blue((await rgbs(page, [[W / 2 - 3, mid - 3, 6, 6]]))[0]), { timeout: 30_000 }).toBe(true);
    // Away from the shoreline itself (a DEM post wide), every row is water or not as the formula says.
    const clear = rows.filter((r) => !rows.some((o) => o.wet !== r.wet && Math.abs(o.y - r.y) <= 4));
    const seen = await rgbs(page, clear.map((r) => [W / 2 - 2, r.y - 2, 4, 4] as Win));
    const wrong = clear.filter((r, i) => blue(seen[i]) !== r.wet).length;
    expect(wrong).toBe(0);
  });

  test('the water shines as the formula says: more sky toward its far shore, where the view grazes it', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    const probe = (y: number) => {
      const hit = terrainHit(LAKE.bearing, W / 2, y, EYE, 60, W, H)!;
      expect(inLake(hit.lon, hit.lat)).toBe(true);
      const b = (LAKE.bearing * Math.PI) / 180, dz = hit.h - EYE;
      const len = Math.hypot(hit.range, dz);
      const view: [number, number, number] = [(Math.sin(b) * hit.range) / len, (Math.cos(b) * hit.range) / len, dz / len];
      return luminance(terrainColor(hit.h, [0, 0, 1], hit.range, true, view));
    };
    // Rows well inside the lake: near shore (steeper view) and far shore (flatter view).
    const rows: number[] = [];
    for (let y = 420; y < H; y += 2) {
      const hit = terrainHit(LAKE.bearing, W / 2, y, EYE, 60, W, H);
      if (hit && inLake(hit.lon, hit.lat)) rows.push(y);
    }
    const far = rows[3], near = rows[rows.length - 4];
    const expected = { far: probe(far), near: probe(near) };
    expect(expected.far).toBeGreaterThan(expected.near + 0.02);      // the Fresnel term itself separates them
    const [f, n] = await rgbs(page, [[W / 2 - 3, far - 1, 6, 3], [W / 2 - 3, near - 1, 6, 3]]);
    const lum = (c: [number, number, number]) => luminance([c[0] / 255, c[1] / 255, c[2] / 255]);
    expect(Math.abs(lum(f) - expected.far)).toBeLessThan(0.015);
    expect(Math.abs(lum(n) - expected.near)).toBeLessThan(0.015);
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
