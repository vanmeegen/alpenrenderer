/**
 * The app in Chromium, against the synthetic test range. Every expectation
 * here is derived from tests/e2e/fixtures/terrain.ts, not read off a picture.
 */
import { expect, Page, test } from '@playwright/test';
import { FLANK, PLAIN_M, STAND, eyeAbove, skylineRow, summitScreenY, terrainHit } from './fixtures/terrain';
import { luminance as lumOf, terrainColor } from '../../src/engine/render/shading';

const TILES = '/tests/e2e/fixtures/tiles/';
const R_EFF_M = 6371008.8 / (1 - 0.13);
const W = 1000, H = 600;

function url(hash: Record<string, number | string> = {}, query: Record<string, string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, q: 'high', ...query });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon, lat: STAND.lat, yaw: 90, pitch: 0, fov: 60, ...hash })
    .map(([k, v]) => [k, String(v)]));
  return `/dist/?${q}#${h}`;
}

interface Status {
  tilesDone: number; tilesTotal: number; levelsReady: number; levels: number;
  ground: number; eyeAltitude: number; failed: number; fps: number;
  diagnostics: { framesDrawn: number; frameErrors: number; terrainReady: boolean; shadeReady: boolean;
    compositeReady: boolean; shaderErrors: string[]; vertices: number };
}

const status = (page: Page) => page.evaluate(() => (window as any).alp.status() as Status);

async function ready(page: Page) {
  await page.waitForFunction(() => {
    const v = (window as any).alp;
    if (!v) return false;
    const s = v.status();
    return s.levelsReady >= s.levels && s.diagnostics.framesDrawn > 3;
  }, null, { timeout: 120_000 });
  return status(page);
}

/**
 * Sky rows from the top in one screen column, from the range buffer: alpha 0
 * is sky, so the count of sky pixels is the row of the first terrain pixel.
 */
async function skyRows(page: Page, x: number): Promise<number> {
  return page.evaluate(async (col) => {
    const r = await (window as any).alp.renderer.readRange();
    let sky = 0;
    for (let y = 0; y < r.height; y++) if (r.pixels[(y * r.width + col) * 4 + 3] === 0) sky++;
    return sky;
  }, x);
}

/** Mean luminance of the composited image in a window, top-down coordinates. */
async function luminance(page: Page, x0: number, y0: number, w: number, h: number): Promise<number> {
  return page.evaluate(async ([x0, y0, w, h]) => {
    const c = await (window as any).alp.renderer.capture();
    let sum = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * c.width + x) * 4;
        sum += 0.2126 * c.pixels[o] + 0.7152 * c.pixels[o + 1] + 0.0722 * c.pixels[o + 2];
      }
    }
    return sum / (w * h);
  }, [x0, y0, w, h]);
}

const hashOf = (page: Page) => page.evaluate(() => location.hash);
const hashNum = (hash: string, key: string) => Number(new URLSearchParams(hash.slice(1)).get(key));

test.describe('loading', () => {
  test('a loading overlay shows the tile progress until the terrain is in, then leaves the view alone', async ({ page }) => {
    await page.goto(url());
    const overlay = page.getByText(/Gelände lädt/);
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await ready(page);
    await expect(overlay).toBeHidden({ timeout: 30_000 });
  });

  test('renders the fixture terrain with every pipeline compiled and no errors', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    expect(s.levels).toBe(8);
    expect(s.tilesTotal).toBeGreaterThan(0);
    expect(s.tilesDone).toBe(s.tilesTotal);
    expect(s.failed).toBe(0);
    expect(s.diagnostics).toMatchObject({ terrainReady: true, shadeReady: true, compositeReady: true, frameErrors: 0 });
    expect(s.diagnostics.shaderErrors).toEqual([]);
    await expect(page.getByText('8 Level')).toBeVisible();
  });

  test('the eye stands 1.7 m above the highest ground within 25 m: a little more on the plain, whose ripple climbs half a metre', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    expect(Math.abs(s.ground - PLAIN_M)).toBeLessThan(10);   // the ripple is ±8 m
    const expected = eyeAbove(STAND.lon, STAND.lat);
    expect(expected).toBeGreaterThan(1.9);                   // the rule is doing something even here
    expect(expected).toBeLessThan(2.6);
    // The fixture tiles hold whole metres, so the highest post can round up by half a metre.
    expect(Math.abs(s.eyeAltitude - s.ground - expected)).toBeLessThan(0.75);
    // The HUD says how far above the ground the eye is, to a decimal.
    const hud = await page.getByText(/\(Boden \+ \d+,\d m\)/).textContent();
    const shown = Number(hud!.match(/Boden \+ (\d+,\d) m/)![1].replace(',', '.'));
    expect(Math.abs(shown - expected)).toBeLessThan(0.75);
  });

  test('on the Testhorn\'s flank the eye clears the slope: 25 m up, not inside the hill', async ({ page }) => {
    // A cone rising 1 m per metre: the ground 25 m uphill is 25 m higher, and
    // an eye 1.7 m above the standpoint would look out from inside it.
    await page.goto(url({ lon: FLANK.lon, lat: FLANK.lat, yaw: 270 }));
    const s = await ready(page);
    const expected = eyeAbove(FLANK.lon, FLANK.lat);
    expect(expected).toBeGreaterThan(25);
    expect(Math.abs(s.eyeAltitude - s.ground - expected)).toBeLessThan(4);   // DEM posts are 6 m apart
    await expect(page.getByText(/\(Boden \+ 2\d m, Hang\)/)).toBeVisible();
  });

  test('a given altitude puts the eye there', async ({ page }) => {
    await page.goto(url({ alt: 2500 }));
    const s = await ready(page);
    expect(s.eyeAltitude).toBe(2500);
    await expect(page.getByText('Auge 2500 m')).toBeVisible();
  });
});

test.describe('geometry on screen', () => {
  test('the Testhorn summit sits on the computed row, dead centre', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    const expected = summitScreenY(s.eyeAltitude, 60) * H;
    const centre = await skyRows(page, W / 2);
    expect(Math.abs(centre - expected)).toBeLessThan(H * 0.02);
    // The DEM march agrees with the closed form at the apex.
    expect(Math.abs(skylineRow(90, W / 2, s.eyeAltitude, 60, W, H) - expected)).toBeLessThan(2);
  });

  test('off the cone the skyline is where the DEM march puts it', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    // 1.7 m above the plain, the ripple's crests hide the true horizon by a
    // degree or two; the reference march sees the same crests.
    for (const x of [60, 250, 800]) {
      const expected = skylineRow(90, x, s.eyeAltitude, 60, W, H);
      expect(Math.abs((await skyRows(page, x)) - expected), `column ${x}`).toBeLessThan(H * 0.01);
    }
  });

  test('the summit is higher on screen with a narrower field of view', async ({ page }) => {
    await page.goto(url({ fov: 40 }));
    const s = await ready(page);
    const expected = summitScreenY(s.eyeAltitude, 40) * H;
    expect(expected).toBeLessThan(0);   // the apex is above the frame at 40°
    expect(await skyRows(page, W / 2)).toBe(0);
  });

  test('looking away from the Testhorn shows only the plain, with the march as reference', async ({ page }) => {
    await page.goto(url({ yaw: 270 }));
    const s = await ready(page);
    for (const x of [100, 500, 900]) {
      const expected = skylineRow(270, x, s.eyeAltitude, 60, W, H);
      // Nothing tall this way: the skyline stays within a few degrees of level...
      expect(Math.abs(expected - H / 2)).toBeLessThan(H * 0.05);
      // ...and the renderer agrees with the march.
      expect(Math.abs((await skyRows(page, x)) - expected), `column ${x}`).toBeLessThan(H * 0.01);
    }
  });

  test('from high above, the plain horizon is exactly where curvature puts it', async ({ page }) => {
    await page.goto(url({ yaw: 270, alt: 3000 }));
    const s = await ready(page);
    // 1500 m up, the ripple is irrelevant and the horizon dips by
    // sqrt(2h/R): about 1.2 degrees below level.
    const dip = Math.sqrt((2 * (s.eyeAltitude - PLAIN_M)) / R_EFF_M);
    const expectedRow = H / 2 + (H / 2) * Math.tan(dip) / Math.tan(Math.PI / 6);
    const got = await skyRows(page, W / 2);
    expect(Math.abs(got - expectedRow)).toBeLessThan(H * 0.01);
    expect(Math.abs(got - skylineRow(270, W / 2, s.eyeAltitude, 60, W, H))).toBeLessThan(H * 0.01);
  });

  test('ridge lines darken the silhouette and can be switched off', async ({ page }) => {
    await page.goto(url());
    const s = await ready(page);
    const apex = summitScreenY(s.eyeAltitude, 60) * H;
    const on = await luminance(page, W / 2 - 60, Math.round(apex) - 4, 120, 40);
    await page.getByRole('button', { name: 'Umrisse aus' }).click();
    await page.waitForFunction(() => (window as any).alp.renderer.outline === 0);
    const off = await luminance(page, W / 2 - 60, Math.round(apex) - 4, 120, 40);
    expect(on).toBeLessThan(off);
    await expect(page.getByRole('button', { name: 'Umrisse an' })).toBeVisible();
  });
});

test.describe('controls', () => {
  test('dragging turns the view against the finger and the URL follows', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    const hfov = await page.evaluate(() => (window as any).alp.camera.hfov as number);
    await page.mouse.move(500, 300);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 5 });
    await page.waitForTimeout(200);   // a deliberate release, not a flick
    await page.mouse.up();
    // Dragging left by 200 px brings the world from the right: yaw grows by a fifth of the hfov.
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 30_000 })
      .toBeCloseTo(90 + hfov * 0.2, 0);
  });

  test('the wheel zooms and the URL follows', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => hashNum(await hashOf(page), 'fov'), { timeout: 30_000 }).toBeLessThan(50);
    await page.mouse.wheel(0, 600);
    await expect.poll(async () => hashNum(await hashOf(page), 'fov'), { timeout: 30_000 }).toBe(60);
  });

  test('arrow keys turn the view', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 30_000 }).toBeCloseTo(90 + 60 * 0.08, 0);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => hashNum(await hashOf(page), 'pitch'), { timeout: 30_000 }).toBeCloseTo(60 * 0.08, 0);
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true });

    test('a pinch changes the field of view in proportion to the spread', async ({ page }) => {
      await page.goto(url());
      await ready(page);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 400, y: 300 }, { x: 600, y: 300 }] });
      for (let i = 1; i <= 4; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
          touchPoints: [{ x: 400 - 25 * i, y: 300 }, { x: 600 + 25 * i, y: 300 }] });
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(700);   // let a frame apply the last positions
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // 200 px apart to 400 px apart: half the field of view.
      await expect.poll(async () => hashNum(await hashOf(page), 'fov'), { timeout: 30_000 }).toBe(30);
    });

    test('one finger drags the view', async ({ page }) => {
      await page.goto(url());
      await ready(page);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 300 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y: 200 }] });
      await page.waitForTimeout(1500);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // Dragging up by 100 px looks down by a sixth of the vertical fov.
      await expect.poll(async () => hashNum(await hashOf(page), 'pitch'), { timeout: 30_000 }).toBeCloseTo(-10, 0);
    });
  });
});

test.describe('standpoint', () => {
  test('a hash change relocates and refills the clipmap', async ({ page }) => {
    await page.goto(url());
    const before = await ready(page);
    await page.evaluate((h) => { location.hash = h; }, `#lon=${STAND.lon + 0.01}&lat=${STAND.lat}&yaw=90&pitch=0&fov=60`);
    await expect.poll(async () => (await status(page)).tilesDone, { timeout: 60_000 }).toBeGreaterThan(0);
    const after = await ready(page);
    expect(after.diagnostics.frameErrors).toBe(0);
    expect(after.failed).toBe(0);
    expect(Math.abs(after.ground - PLAIN_M)).toBeLessThan(10);
    expect(after.levelsReady).toBe(before.levels);
  });

  test('the standpoint menu writes the place into the URL', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Standpunkt' }).click();
    await page.getByRole('button', { name: 'Zugspitze (DE/AT)' }).click();
    await expect.poll(async () => hashNum(await hashOf(page), 'lon'), { timeout: 30_000 }).toBeCloseTo(10.98527, 4);
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 30_000 }).toBe(110);
    // No fixture tiles there: the app reports it instead of failing.
    await expect(page.getByText(/fehlgeschlagen/)).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('panels', () => {
  test('credits name the aggregator and the engine origin', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Quellen' }).click();
    await expect(page.getByRole('link', { name: 'Mapterhorn' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'peakviewer' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'OpenStreetMap contributors' })).toBeVisible();
  });

  test('the check panel reports compiled pipelines', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('Pipelines: terrain ok · shade ok · composite ok')).toBeVisible();
    await expect(page.getByText(/Fehler: 0 Frames/)).toBeVisible();
    // Which build is this? The commit, so a report from a phone can be matched to the code.
    await expect(page.getByText(/Build [0-9a-f]{7,}( |$)/)).toBeVisible();
    // The device's limits and the GL error state after the atlas upload, for reports from tablets.
    await expect(page.getByText(/Limits: Textur \d{4,} · Vertex-Texturen \d+ · Vertex-Uniforms \d+ · highp Vertex \d+ Bit · GL-Fehler 0( |$)/)).toBeVisible();
    // The tile decoder proved itself on a probe tile before the first tile was decoded.
    await expect(page.getByText(/Tile-Dekoder: exakt \((bitmap|image)\)/)).toBeVisible();
  });
});

test.describe('appearance', () => {
  test('the two flanks of the Testhorn are lit as the shading formula says: Lambert from the south-south-east over rock', async ({ page }) => {
    // The cone rises 1 m per metre all round. Seen from the west, the flank
    // right of the summit faces south-west, towards the sun, the one left of
    // it north-west, away from it. Their brightness ratio is set by the light
    // formula alone; fog and colour are the same at the same range and altitude.
    await page.goto(url());
    const s = await ready(page);
    const ys = summitScreenY(s.eyeAltitude, 60) * H;
    const probe = async (x: number, y: number) => {
      const hit = terrainHit(90, x, y, s.eyeAltitude, 60, W, H)!;
      expect(hit.range).toBeGreaterThan(2500);            // on the cone, not the plain
      const expected = lumOf(terrainColor(hit.h, hit.normal, hit.range));
      const measured = (await luminance(page, x - 6, y - 6, 12, 12)) / 255;
      return { expected, measured };
    };
    // 200 px below the summit the rays land on the near face, well inside the silhouette.
    const yp = Math.round(ys + 200);
    const left = await probe(W / 2 - 100, yp);
    const right = await probe(W / 2 + 100, yp);
    expect(right.expected / left.expected).toBeGreaterThan(1.3);   // the formula itself separates the flanks
    // The old light (a sky term over a 0.66 Lambert) read 0.028 too bright on
    // the shadow flank and 0.020 on the lit one; the tolerance sits below that.
    expect(Math.abs(left.measured - left.expected)).toBeLessThan(0.015);
    expect(Math.abs(right.measured - right.expected)).toBeLessThan(0.015);
    expect(Math.abs(left.measured / right.measured - left.expected / right.expected)).toBeLessThan(0.03);
  });

  test('the Testhorn view matches the golden within tolerance', async ({ page }) => {
    // A page screenshot of a software-rendered WebGL canvas can take well
    // over ten seconds on a slow CI runner, and the matcher needs two of
    // them in a row before it compares: give it time.
    test.slow();
    await page.goto(url());
    await ready(page);
    await expect(page).toHaveScreenshot('testhorn.png', {
      mask: [page.locator('.pointer-events-auto'), page.locator('.alp-compass')],
      maxDiffPixelRatio: 0.05,
      timeout: 150_000,
    });
  });
});
