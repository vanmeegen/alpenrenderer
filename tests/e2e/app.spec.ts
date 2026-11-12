/**
 * The app in Chromium, against the synthetic test range. Every expectation
 * here is derived from tests/e2e/fixtures/terrain.ts, not read off a picture.
 */
import { expect, Page, test } from '@playwright/test';
import { BACK_RIDGE, BANK, EYE_HEIGHT, FLANK, PLAIN_M, RIDGE_RANGE, STAND, heightAt, skylineRow, spotAt, summitScreenY, terrainHit } from './fixtures/terrain';
import { HORIZON_COLOR, luminance as lumOf, terrainColor } from '../../src/engine/render/shading';
import { LogField, OUTLINE, rimAt } from '../../src/engine/render/outline';
import { DETAIL, detailAt, detailFade, detailFrame } from '../../src/engine/render/detail';

const TILES = '/tests/e2e/fixtures/tiles/';
const R_EFF_M = 6371008.8 / (1 - 0.13);
const W = 1000, H = 600;

function url(hash: Record<string, number | string> = {}, query: Record<string, string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, peaks: '/tests/e2e/fixtures/peaks/', lakes: '/tests/e2e/fixtures/lakes/', q: 'low', shade: '0', ...query });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon, lat: STAND.lat, yaw: 90, pitch: 0, fov: 60, ...hash })
    .map(([k, v]) => [k, String(v)]));
  return `/dist/?${q}#${h}`;
}

interface Status {
  tilesDone: number; tilesTotal: number; levelsReady: number; levels: number;
  ground: number; eyeAltitude: number; failed: number; fps: number; missing: number; pending: number; levelsShown: number; levelsEmpty: number;
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

/** Luminance 0..1 of every row of the composited image in one column, top-down, averaged over `halfWidth` columns each side. */
async function columnLuminance(page: Page, x: number, halfWidth = 1): Promise<number[]> {
  return page.evaluate(async ([x, hw]) => {
    const c = await (window as any).alp.renderer.capture();
    const out: number[] = [];
    for (let y = 0; y < c.height; y++) {
      let sum = 0;
      for (let xx = x - hw; xx <= x + hw; xx++) {
        const o = (y * c.width + xx) * 4;
        sum += 0.2126 * c.pixels[o] + 0.7152 * c.pixels[o + 1] + 0.0722 * c.pixels[o + 2];
      }
      out.push(sum / (2 * hw + 1) / 255);
    }
    return out;
  }, [x, halfWidth]);
}

/**
 * The range buffer as the composite pass reads it: the log of the ground
 * range per pixel, top-down, OUTLINE.logSky where nothing is drawn (the
 * packing of the range pass: 24 bits over ln 8 m .. ln 400 km).
 */
async function logField(page: Page): Promise<LogField> {
  const r = await page.evaluate(async () => {
    const b = await (window as any).alp.renderer.readRange();
    return { width: b.width as number, height: b.height as number, pixels: Array.from(b.pixels as Uint8Array) };
  });
  const LOG_MIN = Math.log(8), LOG_SPAN = Math.log(4e5) - Math.log(8);
  return (x, y) => {
    const px = Math.min(r.width - 1, Math.max(0, Math.floor(x)));
    const py = Math.min(r.height - 1, Math.max(0, Math.floor(y)));
    const o = ((r.height - 1 - py) * r.width + px) * 4;          // render targets read back bottom-up
    if (r.pixels[o + 3] < 128) return OUTLINE.logSky;
    return LOG_MIN + ((r.pixels[o] * 65536 + r.pixels[o + 1] * 256 + r.pixels[o + 2]) / 16777215) * LOG_SPAN;
  };
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
    // The low quality the E2E tests run at (see url): six levels around the
    // eye, the telescope's two windows not counted. The high quality's eight
    // are characterised in tests/unit/clipmap.test.ts.
    expect(s.levels).toBe(6);
    expect(s.tilesTotal).toBeGreaterThan(0);
    expect(s.tilesDone).toBe(s.tilesTotal);
    expect(s.failed).toBe(0);
    expect(s.diagnostics).toMatchObject({ terrainReady: true, shadeReady: true, compositeReady: true, frameErrors: 0 });
    expect(s.diagnostics.shaderErrors).toEqual([]);
    await expect(page.getByText('6 Level')).toBeVisible();
    // The eight levels (six and the telescope's two) lie two abreast in the
    // height atlas: no side over the 4096 px every phone takes. In one
    // column they were 640 × 5120.
    expect((s.diagnostics as any).atlas).toBe('1280×2560 rgba8');
  });

  test('the eye stands 1.7 m above the ground under it, ripple or not', async ({ page }) => {
    // Everyone else (udeuschle, HeyWhatsThat, PeakFinder) puts the eye a
    // fixed height over the ground at the standpoint; the highest point in
    // the area is an option there, not the default. At a lakeshore the old
    // 1 km search lifted the eye hundreds of metres up the slopes.
    await page.goto(url());
    const s = await ready(page);
    expect(Math.abs(s.ground - PLAIN_M)).toBeLessThan(10);   // the ripple is ±8 m
    expect(Math.abs(s.eyeAltitude - s.ground - EYE_HEIGHT)).toBeLessThan(0.01);
    await expect(page.getByText('(Boden + 1,7 m)')).toBeVisible();
  });

  test('on the Testhorn\'s flank the eye stands 1.7 m over the slope, not over the ground 1 km uphill', async ({ page }) => {
    // A cone rising 1 m per metre: the ground 1 km uphill is 1 km higher, and that is not where the eye goes.
    await page.goto(url({ lon: FLANK.lon, lat: FLANK.lat, yaw: 270 }));
    const s = await ready(page);
    expect(Math.abs(s.eyeAltitude - s.ground - EYE_HEIGHT)).toBeLessThan(0.01);
    // The ground is the formula's, within the bilinear sampling of 6 m posts on a 45° slope.
    expect(Math.abs(s.ground - heightAt(FLANK.lon, FLANK.lat))).toBeLessThan(3);
    await expect(page.getByText('(Boden + 1,7 m)')).toBeVisible();
  });

  test('with a bank in front of the standpoint the eye comes up until the ridges show over it: the view north is the ridge, not the bank', async ({ page }) => {
    // The DEM holds what stands right around a standpoint (an embankment, a
    // step between two posts) and the standpoint is only good to some
    // metres. A person looks over it; the eye, 1.7 m over one post, did not.
    await page.goto(url({ lon: BANK.lon, lat: BANK.lat, yaw: 0, fov: 20 }));
    const s = await ready(page);
    const above = s.eyeAltitude - s.ground;
    expect(above).toBeGreaterThan(EYE_HEIGHT + 1);                // lifted…
    expect(above).toBeLessThan(EYE_HEIGHT + BANK.rise + 0.5);     // …by no more than the bank
    await expect(page.getByText(/\(Boden \+ \d,\d m, freier Blick\)/)).toBeVisible();
    // In the picture the skyline is the ridges 20 and 22 km out, where the
    // march from that eye puts them: the bank in front hides none of them.
    for (const x of [300, 500, 700]) {
      const ridges = skylineRow(0, x, s.eyeAltitude, 20, W, H, 0, 275000, BANK, 200);
      expect(ridges).toBeLessThan(H / 2 - 80);                    // 3° up and more
      expect(Math.abs((await skyRows(page, x)) - ridges), `column ${x}`).toBeLessThan(H * 0.02);
    }
    // An altitude given in the URL is the altitude: no lift, and the bank is the view.
    const ground = s.ground;
    const alt = Math.round(ground + 1);
    await page.evaluate((h) => { location.hash = h; }, `#lon=${BANK.lon}&lat=${BANK.lat}&alt=${alt}&yaw=0&pitch=0&fov=20`);
    await expect.poll(async () => (await status(page)).eyeAltitude, { timeout: 30_000 }).toBe(alt);
    const ridge = skylineRow(0, 500, alt, 20, W, H, 0, 275000, BANK, 200);
    await expect.poll(() => skyRows(page, 500), { timeout: 30_000 }).toBeLessThan(ridge - H * 0.03);
  });

  test('the eye height is a logarithmic slider, 1.7 m to 500 m, and the device keeps it', async ({ page }) => {
    await page.goto(url({ lon: FLANK.lon, lat: FLANK.lat, yaw: 270 }));
    await ready(page);
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    const slider = page.getByRole('slider', { name: 'Augenhöhe' });
    await expect(slider).toHaveValue('0');
    await expect(page.getByText('Augenhöhe 1,7 m')).toBeVisible();
    const lifted = async () => page.evaluate(() => {
      const s = (window as any).alp.status();
      return s.eyeAltitude - s.ground;
    });
    // Half way along is the geometric middle: sqrt(1.7 · 500) = 29.2 m.
    await slider.fill('50');
    const middle = Math.sqrt(1.7 * 500);
    await expect(page.getByText(`Augenhöhe ${middle.toFixed(1).replace('.', ',')} m`)).toBeVisible();
    await expect.poll(lifted).toBeGreaterThan(20);
    expect(Math.abs((await lifted()) - middle)).toBeLessThan(0.1);
    await slider.fill('100');
    await expect(page.getByText('Augenhöhe 500 m')).toBeVisible();
    await expect.poll(lifted).toBeGreaterThan(400);
    expect(Math.abs((await lifted()) - 500)).toBeLessThan(0.1);
    // A reload keeps the choice.
    await page.reload();
    await ready(page);
    expect(Math.abs((await lifted()) - 500)).toBeLessThan(0.1);
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

  test('ridge lines always darken the silhouette; a slider sets how strongly, 70 % by default', async ({ page }) => {
    // PeakFinder's readability is its line drawing: ridges and silhouettes
    // from the range buffer's jumps, over the shading. The old switch did
    // nothing anyone could see, and 0.35 was too faint on a phone.
    await page.goto(url({}, { shade: '1' }));   // a colour test: the lit shade pass is what it measures
    const s = await ready(page);
    await expect(page.getByRole('button', { name: /Umrisse/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).alp.renderer.outline)).toBe(0.7);
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(page.getByRole('slider', { name: 'Konturen' })).toHaveValue('70');
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    const apex = summitScreenY(s.eyeAltitude, 60) * H;
    const on = await luminance(page, W / 2 - 60, Math.round(apex) - 4, 120, 40);
    // Taken out from the console, the silhouette gets lighter: the lines are really drawn.
    await page.evaluate(() => { (window as any).alp.renderer.outline = 0; });
    await page.waitForTimeout(500);
    const off = await luminance(page, W / 2 - 60, Math.round(apex) - 4, 120, 40);
    expect(on).toBeLessThan(off);
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

  test('a view that keeps changing reaches the URL while it changes, not only once it rests', async ({ page }) => {
    // The hash was written 300 ms after the last change of the view. With
    // the sensors on the view changes every frame, so the URL only followed
    // when the phone was put down, and a link shared while panning showed
    // the old view. Driven here through the viewer's own change handler, 20
    // times a second for two seconds.
    await page.goto(url());
    await ready(page);
    await page.evaluate(() => {
      const v = (window as any).alp, w = window as any;
      w.__yaw = 100;
      w.__turning = setInterval(() => { w.__yaw += 0.5; v.onView({ ...v.current, yaw: w.__yaw % 360 }); }, 50);
    });
    // It used to stay the 90 of the URL for as long as the view kept turning.
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 20_000 }).toBeGreaterThan(100);
    // And it is still turning: this was not the write after the last change.
    const a = await page.evaluate(() => (window as any).__yaw as number);
    await expect.poll(() => page.evaluate(() => (window as any).__yaw as number), { timeout: 10_000 }).toBeGreaterThan(a + 1);
    await page.evaluate(() => clearInterval((window as any).__turning));
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
  test('a hash change relocates and refills the clipmap; a hash without a standpoint keeps the one there is', async ({ page }) => {
    await page.goto(url());
    const before = await ready(page);
    // 3.5 km east, onto the Testhorn's flank: the fine windows follow (a few
    // hundred metres would stay inside them, clipmap.ts).
    await page.evaluate((h) => { location.hash = h; }, `#lon=${FLANK.lon}&lat=${FLANK.lat}&yaw=90&pitch=0&fov=60`);
    await expect.poll(async () => (await status(page)).tilesDone, { timeout: 60_000 }).toBeGreaterThan(0);
    const after = await ready(page);
    expect(after.diagnostics.frameErrors).toBe(0);
    expect(after.failed).toBe(0);
    expect(Math.abs(after.ground - heightAt(FLANK.lon, FLANK.lat))).toBeLessThan(10);
    expect(after.levelsReady).toBe(before.levels);
    // Only a direction in the hash: the view turns, the standpoint stays (it used to jump to the Gornergrat).
    await page.evaluate(() => { location.hash = '#yaw=180'; });
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 30_000 }).toBe(180);
    await expect.poll(async () => hashNum(await hashOf(page), 'lon'), { timeout: 30_000 }).toBeCloseTo(FLANK.lon, 4);
    expect(hashNum(await hashOf(page), 'lat')).toBeCloseTo(FLANK.lat, 4);
  });

  test('a hash set from outside is read from the event that announces it, not from an address the app has rewritten since', async ({ page }) => {
    // The app writes the view into the URL a moment after it changed. In a
    // full suite run that write once landed between a hash set from outside
    // and the app reading it: the app then read its own hash back and the
    // new one was lost (photo.spec, the widened field of view). The event
    // names the URL that was navigated to; that is the one to follow.
    await page.goto(url());
    await ready(page);
    await page.waitForTimeout(600);                             // nothing is waiting to be written
    await page.evaluate(() => {
      const asked = location.href.replace(/yaw=[^&]*/, 'yaw=77');
      const old = location.href;
      history.replaceState(null, '', location.href.replace(/yaw=[^&]*/, 'yaw=100'));   // the app's own late write
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: old, newURL: asked }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).alp.current.yaw as number), { timeout: 10_000 }).toBe(77);
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 10_000 }).toBe(77);
  });

  test('tiles that do not arrive leave their level out, not a pit; the HUD says so and "Erneut laden" brings them', async ({ page }) => {
    // The second-finest level's tiles (tile zoom 11) fail as on a mountain
    // with one bar of signal. They used to be blitted as nothing: a hole
    // 1000 m below sea level, for good.
    let down = true;
    await page.route('**/fixtures/tiles/11/**', (route) => (down ? route.abort() : route.continue()));
    await page.goto(url());
    const retry = page.getByRole('button', { name: 'Erneut laden' });
    await expect(retry).toBeVisible({ timeout: 120_000 });       // after three more tries, some seconds apart
    const s = await status(page);
    expect(s.missing).toBeGreaterThan(0);
    expect(s.pending).toBe(0);
    expect(s.levelsReady).toBe(s.levels - 1);
    expect(s.levelsShown).toBe(s.levels - 1);
    await expect(page.getByText(/\d+ Kacheln fehlen/)).toBeVisible();
    await expect(page.getByText(/Gelände lädt/)).toBeHidden();   // the picture stands, from the levels that came
    expect(Math.abs(s.ground - PLAIN_M)).toBeLessThan(10);
    // The Testhorn, 5 km out, is drawn from the level beyond the missing one: on its row, no pit in front of it.
    const expected = summitScreenY(s.eyeAltitude, 60) * H;
    expect(Math.abs((await skyRows(page, W / 2)) - expected)).toBeLessThan(H * 0.03);
    down = false;
    await retry.click();
    const after = await ready(page);
    expect(after.missing).toBe(0);
    expect(after.levelsShown).toBe(after.levels);
    await expect(retry).toHaveCount(0);
  });

  test('the standpoint menu writes the place into the URL', async ({ page }) => {
    await page.goto(url());
    await ready(page);
    await page.getByRole('button', { name: 'Standpunkt' }).click();
    await page.getByRole('button', { name: 'Zugspitze (DE/AT)' }).click();
    await expect.poll(async () => hashNum(await hashOf(page), 'lon'), { timeout: 30_000 }).toBeCloseTo(10.98527, 4);
    await expect.poll(async () => hashNum(await hashOf(page), 'yaw'), { timeout: 30_000 }).toBe(110);
    // No fixture tiles there (every request is answered "no such tile"). The
    // coarsest level still reaches the place from where it was cut, and the
    // two above it have the fixture's tiles in the west of their windows:
    // the rest of those is filled from the level below. The three finest
    // have no data at all, are left out rather than drawn as a pit, and the
    // app says so. Nothing failed, so there is nothing to retry.
    await expect(page.getByText(/\d Ebenen ohne Daten/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Erneut laden' })).toHaveCount(0);
    const s = await status(page);
    expect(s.missing).toBe(0);
    expect(s.levelsEmpty).toBeGreaterThanOrEqual(3);
    expect(s.levelsShown).toBeGreaterThanOrEqual(1);
    expect(s.levelsEmpty + s.levelsShown).toBe(s.levels);
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
    // What the device was taken for, and the setting the URL asks for.
    await expect(page.getByText(/Gerät (phone|tablet|desktop) · Qualität low/)).toBeVisible();
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
  test('the two flanks of the Testhorn are lit as the shading formula says: Lambert from over the viewer\'s left shoulder, over rock', async ({ page }) => {
    // The cone rises 1 m per metre all round. Looking east, the light stands
    // north-west (yaw − 135°): the flank left of the summit faces north-west,
    // into the light, the one right of it south-west, half away from it.
    // Their brightness ratio is set by the light formula alone; fog and
    // colour are the same at the same range and altitude.
    await page.goto(url({}, { shade: '1' }));   // a colour test: the lit shade pass is what it measures
    const s = await ready(page);
    const ys = summitScreenY(s.eyeAltitude, 60) * H;
    const probe = async (x: number, y: number) => {
      const hit = terrainHit(90, x, y, s.eyeAltitude, 60, W, H)!;
      expect(hit.range).toBeGreaterThan(2500);            // on the cone, not the plain
      const expected = lumOf(terrainColor(hit.h, hit.normal, hit.range, false, undefined, 90, s.eyeAltitude));
      const measured = (await luminance(page, x - 6, y - 6, 12, 12)) / 255;
      return { expected, measured };
    };
    // 200 px below the summit the rays land on the near face, well inside the silhouette.
    const yp = Math.round(ys + 200);
    const left = await probe(W / 2 - 100, yp);
    const right = await probe(W / 2 + 100, yp);
    // The formula itself separates the flanks: 200 px below the summit the
    // probes face the viewer as much as north or south, so by 1.16, not 1.56.
    expect(left.expected / right.expected).toBeGreaterThan(1.1);
    // The old light (a sky term over a 0.66 Lambert) read 0.028 too bright on
    // the shadow flank and 0.020 on the lit one; the tolerance sits below that.
    expect(Math.abs(left.measured - left.expected)).toBeLessThan(0.015);
    expect(Math.abs(right.measured - right.expected)).toBeLessThan(0.015);
    expect(Math.abs(left.measured / right.measured - left.expected / right.expected)).toBeLessThan(0.03);
  });

  test('through the telescope a face is one surface, not a chequerboard of DEM cells: no step in brightness from one pixel to the next', async ({ page }) => {
    // Under the summit the cone turns quickly, and zoomed to 8° a DEM cell
    // is some twenty pixels wide. With one normal per cell each cell had its
    // own shade: brightness jumped by 0.02 at every cell boundary. Across
    // the whole face it changes by a quarter over 500 px, 0.0005 a pixel;
    // the bound is two steps of the 8-bit image.
    await page.goto(url({ pitch: 25.5, fov: 8 }, { shade: '1' }));   // a colour test
    await ready(page);
    const rows = await page.evaluate(async () => {
      const r = (window as any).alp.renderer;
      const c = await r.capture(), range = await r.readRange();
      const lum = (x: number, y: number) => {
        const o = (y * c.width + x) * 4;
        return (0.2126 * c.pixels[o] + 0.7152 * c.pixels[o + 1] + 0.0722 * c.pixels[o + 2]) / 255;
      };
      const hit = (x: number, y: number) => range.pixels[((range.height - 1 - y) * range.width + x) * 4 + 3] > 128;
      return [300, 350, 400, 450].map((y) => {
        let first = -1, last = -1, step = 0;
        for (let x = 0; x < c.width; x++) if (hit(x, y)) { if (first < 0) first = x; last = x; }
        // 25 px inside the silhouette: its ink line is not the face.
        for (let x = first + 25; x < last - 25; x++) step = Math.max(step, Math.abs(lum(x + 1, y) - lum(x, y)));
        return { width: last - first, step };
      });
    });
    for (const row of rows) {
      expect(row.width).toBeGreaterThan(150);   // the row crosses the face
      expect(row.step).toBeLessThan(0.008);
    }
  });

  for (const [yaw, pitch] of [[180, -35], [215, -28]]) {
    test(`the ground below you has grain, and it lies on the ground: looking ${yaw}° and ${-pitch}° down, each spot is lit as the formula says for that spot`, async ({ page }) => {
      // The plain was one flat green from the feet to the horizon. The grain
      // (render/detail.ts) is a noise tile fixed to the ground: what a pixel
      // shows follows from the spot of ground behind it, whichever way the
      // camera looks. The spot comes from the range buffer, which holds
      // nothing under 8 m: so from 8 m up, the ground 10 to 70 m away.
      await page.goto(url({ yaw, pitch, alt: PLAIN_M + 8 }, { shade: '1' }));   // a colour test
      const s = await ready(page);
      // Brightness (3 × 3 px) and range at each probe, read in the page.
      const probes: [number, number][] = [];
      for (let y = 100; y <= 500; y += 50) for (let x = 100; x <= 900; x += 50) probes.push([x, y]);
      const seen = await page.evaluate(async (probes) => {
        const r = (window as any).alp.renderer;
        const c = await r.capture(), b = await r.readRange();
        return probes.map(([x, y]) => {
          let sum = 0;
          for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
            const o = (yy * c.width + xx) * 4;
            sum += 0.2126 * c.pixels[o] + 0.7152 * c.pixels[o + 1] + 0.0722 * c.pixels[o + 2];
          }
          const o = ((b.height - 1 - y) * b.width + x) * 4;          // render targets read back bottom-up
          const packed = b.pixels[o + 3] < 128 ? -1 : b.pixels[o] * 65536 + b.pixels[o + 1] * 256 + b.pixels[o + 2];
          return { lum: sum / 9 / 255, packed };
        });
      }, probes);
      const LOG_MIN = Math.log(8), LOG_SPAN = Math.log(4e5) - Math.log(8);
      const frame = detailFrame(STAND.lon, STAND.lat);
      const got: number[] = [], want: number[] = [], sharp: boolean[] = [];
      const pixel = (60 * Math.PI / 180) / H, up = 8;        // radians a pixel spans, metres the eye is up
      probes.forEach(([x, y], i) => {
        expect(seen[i].packed).toBeGreaterThan(0);             // ground, not sky
        const range = Math.exp(LOG_MIN + (seen[i].packed / 16777215) * LOG_SPAN);
        expect(range).toBeGreaterThan(9);
        expect(range).toBeLessThan(100);                       // the near ground
        const spot = spotAt(yaw, pitch, x, y, 60, W, H, range);
        const detail = { d: detailAt(frame, spot.east, spot.north), fade: detailFade(range) };
        want.push(lumOf(terrainColor(spot.h, spot.normal, range, false, undefined, yaw, s.eyeAltitude, 0.5, detail)));
        got.push(seen[i].lum);
        // Where a pixel covers less ground than a texel of the finest tile
        // (it lies range²/up long on the ground), the picture holds the tile
        // itself. Further out the sampler averages it, as it should.
        sharp.push((range * range / up) * pixel < DETAIL.fine / DETAIL.finer / DETAIL.size);
      });
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(mean(v.map((c) => (c - m) ** 2))); };
      // It is grain: the spots differ, by what the formula says they should.
      expect(sd(want)).toBeGreaterThan(0.01);
      expect(sd(got)).toBeGreaterThan(0.01);
      const g = got.filter((_, i) => sharp[i]), w = want.filter((_, i) => sharp[i]);
      expect(g.length).toBeGreaterThan(20);
      const mg = mean(g), mw = mean(w);
      const corr = mean(g.map((c, i) => (c - mg) * (w[i] - mw))) / (sd(g) * sd(w));
      expect(corr).toBeGreaterThan(0.9);
      for (let i = 0; i < got.length; i++) if (sharp[i]) expect(Math.abs(got[i] - want[i])).toBeLessThan(0.02);
    });
  }

  test('the Testhorn view matches the golden within tolerance', async ({ page }) => {
    // A page screenshot of a software-rendered WebGL canvas can take well
    // over ten seconds on a slow CI runner, and the matcher needs two of
    // them in a row before it compares: give it time.
    test.slow();
    // The test range's own summits and lake (url() sets them), not the Alpine
    // catalogues: the golden must not change when a catalogue does.
    await page.goto(url({}, { shade: '1' }));   // a colour test: the lit shade pass is what it measures
    await ready(page);
    await expect(page).toHaveScreenshot('testhorn.png', {
      mask: [page.locator('.pointer-events-auto'), page.locator('.alp-compass')],
      maxDiffPixelRatio: 0.05,
      timeout: 150_000,
    });
  });
});

test.describe('ink lines and haze', () => {
  test('two ridges 10 % apart are separated by one line, drawn on the near ridge', async ({ page }) => {
    // The Hintergrat looks over the ridge in front of it from 22 km against
    // 20: a staffing as the far Alps show it. The old detector (a Laplacian
    // that wanted a 38 % jump for a full line) left 13 % of a line there, on
    // both ridges; now the near ridge carries one full line and the far one none.
    const YAW = 350, FOV = 10;
    await page.goto(url({ yaw: YAW, fov: FOV }));
    const s = await ready(page);
    const x = W / 2;
    const back = skylineRow(YAW, x, s.eyeAltitude, FOV, W, H);                              // the Hintergrat's crest: the skyline
    const front = skylineRow(YAW, x, s.eyeAltitude, FOV, W, H, 0, (RIDGE_RANGE + BACK_RIDGE.range) / 2);   // the near ridge's crest
    expect(front - back).toBeGreaterThan(25);                                              // the far ridge shows a good band
    const lum = await columnLuminance(page, x);
    // The line: the darkest row near the computed crest.
    let line = Math.round(front) - 8;
    for (let y = line; y <= Math.round(front) + 8; y++) if (lum[y] < lum[line]) line = y;
    expect(lum[line]).toBeLessThan(0.2);                                                    // full ink (0.04 over white)
    // On the far ridge right above it: white. No second line, no halo.
    for (let y = line - 10; y <= line - 3; y++) expect(lum[y], `row ${y}, above the line`).toBeGreaterThan(0.9);
    // Between the skyline and the near ridge's face the line is the only ink, one or two pixels of it.
    const inked = lum.slice(Math.round(back) + 8, line + 20).filter((v) => v < 0.5).length;
    expect(inked).toBeGreaterThanOrEqual(1);
    expect(inked).toBeLessThanOrEqual(2);
    // The skyline itself is a line too, on the Hintergrat's crest.
    expect(Math.min(...lum.slice(Math.round(back) - 8, Math.round(back) + 9))).toBeLessThan(0.2);
  });

  test('the ground right behind a nearer mountain is lightened towards the haze, as the formula says; away from it, not', async ({ page }) => {
    // From 3000 m the Testhorn's flank stands 5 km away in front of the plain
    // 15 km out. The plain right next to the silhouette gets the haze rim
    // (outline.ts, computed here from the frame's own range buffer); 40 px
    // away it is the shading formula's colour and nothing else.
    await page.goto(url({ alt: 3000 }, { shade: '1' }));   // a colour test: the lit shade pass is what it measures
    const s = await ready(page);
    const L = await logField(page);
    const y = 352;                                         // 5.7° down: the plain 15 km out
    // The silhouette in this row, from the left: where the range falls from the plain's to the cone's.
    let edge = 100;
    while (edge < W / 2 && L(edge + 0.5, y + 0.5) - L(edge - 0.5, y + 0.5) > -0.3) edge++;
    expect(edge).toBeGreaterThan(200);
    expect(edge).toBeLessThan(W / 2 - 50);
    const probe = async (x: number) => {
      const hit = terrainHit(90, x, y, s.eyeAltitude, 60, W, H)!;
      expect(hit.range).toBeGreaterThan(9000);            // on the plain behind the cone
      const lit = terrainColor(hit.h, hit.normal, hit.range, false, undefined, 90, s.eyeAltitude);
      const rim = rimAt(L, x + 0.5, y + 0.5);
      const expected = lumOf(lit.map((c, i) => c + (HORIZON_COLOR[i] - c) * rim) as [number, number, number]);
      const measured = (await luminance(page, x, y - 2, 1, 5)) / 255;
      return { rim, expected, measured };
    };
    const near = await probe(edge - 3), far = await probe(edge - 40);
    expect(far.rim).toBe(0);
    expect(near.rim).toBeGreaterThan(0.2);
    expect(Math.abs(far.measured - far.expected)).toBeLessThan(0.02);
    expect(Math.abs(near.measured - near.expected)).toBeLessThan(0.03);
    expect(near.measured - far.measured).toBeGreaterThan(0.05);
  });
});

test.describe('device pixels', () => {
  test.use({ deviceScaleFactor: 3 });

  test('a screen with a pixel ratio of 3 is rendered at 1.5: a quarter of the fragments, the summit on the same spot', async ({ page }) => {
    // Three passes per pixel: a phone at its full ratio of 3 pays nine
    // fragments per CSS pixel. Low quality caps the ratio at 1.5.
    await page.goto(url());
    const s = await ready(page);
    const size = await page.evaluate(async () => {
      const r = await (window as any).alp.renderer.readRange();
      return { width: r.width as number, height: r.height as number };
    });
    expect(size).toEqual({ width: W * 1.5, height: H * 1.5 });
    const expected = summitScreenY(s.eyeAltitude, 60) * H;
    expect(Math.abs((await skyRows(page, (W * 1.5) / 2)) / 1.5 - expected)).toBeLessThan(H * 0.02);
  });
});

test.describe('the style of the picture', () => {
  test('"Linien" in the settings draws the outline alone, the device keeps it, "Relief" brings the lit terrain back', async ({ page }) => {
    // The line drawing is a style of its own (PeakFinder's look) and what a
    // weak GPU falls back to: range pass and composite, no lit pass.
    await page.goto(url({}, { shade: '1' }));   // a colour test: the lit shade pass is what it measures
    await ready(page);
    const sky = () => luminance(page, 100, 100, 40, 20);
    expect(await sky()).toBeLessThan(235);                       // blue sky
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    const style = page.getByRole('radiogroup', { name: 'Darstellung' });
    await expect(style.getByRole('radio', { name: 'Relief' })).toBeChecked();
    await style.getByRole('radio', { name: 'Linien' }).click();
    await expect.poll(sky, { timeout: 30_000 }).toBeGreaterThan(250);   // white paper
    expect(await page.evaluate(() => (window as any).alp.renderer.shaded)).toBe(false);
    await page.reload();
    await ready(page);
    expect(await page.evaluate(() => (window as any).alp.renderer.shaded)).toBe(false);
    expect(await sky()).toBeGreaterThan(250);
    await page.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(page.getByRole('radio', { name: 'Linien' })).toBeChecked();
    await page.getByRole('radio', { name: 'Relief' }).click();
    await expect.poll(sky, { timeout: 60_000 }).toBeLessThan(235);
  });
});

test.describe('slow frames', () => {
  test('a view that moves too slowly is drawn with fewer pixels while it moves, and sharp again once it rests', async ({ page }) => {
    // ?adapt=1 switches the adaptation on under the fixed low quality the
    // tests run at (it is off there otherwise, so that tests see one
    // setting). The slow frames are told to it directly: two windows of 60 ms.
    await page.goto(url({}, { adapt: '1' }));
    await ready(page);
    const width = () => page.evaluate(async () => (await (window as any).alp.renderer.readRange()).width as number);
    expect(await width()).toBe(W);
    const scale = await page.evaluate(() => {
      const a = (window as any).alp.adaptation;
      let t = performance.now();
      for (let i = 0; i < 40; i++) { t += 60; a.frame(60, t); }
      return a.scale as number;
    });
    expect(scale).toBe(1.5);
    // Turned, and read back before the next animation frame: the moving frame.
    const moving = await page.evaluate(async () => {
      const v = (window as any).alp;
      void v.relocate({ yaw: 95 });
      return (await v.renderer.readRange()).width as number;
    });
    expect(Math.abs(moving - W / 1.5)).toBeLessThan(2);
    // At rest the frame is drawn once more, at every pixel.
    await expect.poll(width, { timeout: 15_000 }).toBe(W);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText(/In Bewegung: Auflösung ÷ 1,5/)).toBeVisible();
    // Without ?adapt=1 the same slow frames change nothing.
    await page.goto(url());
    await ready(page);
    expect(await page.evaluate(() => {
      const a = (window as any).alp.adaptation;
      let t = performance.now();
      for (let i = 0; i < 80; i++) { t += 60; a.frame(60, t); }
      return a.scale as number;
    })).toBe(1);
  });
});

test.describe('without the shade pass', () => {
  test('shade=0 leaves the lit pass out: outline over a white sky, every pipeline still compiled, the Testhorn where the formula puts it', async ({ page }) => {
    // SwiftShader spends ~10 s compiling the shade pipeline and ~1 s per
    // frame drawing it; the range pass that the geometry, label and HUD
    // tests read is untouched by it, so every spec renders this way unless
    // it looks at colours. Without the pass the composite shows its AR
    // branch: white where there is no camera image, the ink of the outline
    // over it; the shade program is still compiled (the Check panel polls it).
    await page.goto(url({}, { shade: '0' }));
    const s = await ready(page);
    expect(await page.evaluate(() => (window as any).alp.renderer.shaded)).toBe(false);
    expect(await luminance(page, 100, 20, 40, 20)).toBeGreaterThan(250);   // blue sky reads ~140
    expect(s.diagnostics).toMatchObject({ terrainReady: true, shadeReady: true, compositeReady: true, frameErrors: 0 });
    expect(s.diagnostics.shaderErrors).toEqual([]);
    const expected = summitScreenY(s.eyeAltitude, 60) * H;
    expect(Math.abs((await skyRows(page, W / 2)) - expected)).toBeLessThan(H * 0.02);
  });
});

test.describe('drawing only what changed', () => {
  test('a view nobody moves draws no further frames; a turn draws, then quiet again', async ({ page }) => {
    // The loop ticks every animation frame, but a frame nobody changed is the
    // last one again: drawn, it costs a phone its battery and a software
    // rasterizer a whole core per page (render/redraw.ts).
    await page.goto(url());
    await ready(page);
    const drawn = () => page.evaluate(() => (window as any).alp.status().diagnostics.framesDrawn as number);
    // Frames drawn over 30 animation frames, counted in the page: headless
    // Chromium only runs requestAnimationFrame while something asks for frames.
    const quiet = () => page.evaluate(() => new Promise<number>((resolve) => {
      const a = (window as any).alp.status().diagnostics.framesDrawn as number;
      let n = 0;
      const tick = () => { if (++n < 30) requestAnimationFrame(tick); else resolve((window as any).alp.status().diagnostics.framesDrawn - a); };
      requestAnimationFrame(tick);
    }));
    await expect.poll(quiet, { timeout: 30_000 }).toBe(0);
    // The labels likewise: laid out and painted when the view, the targets
    // or what is known to be visible changed, not sixty times a second.
    const layouts = () => page.evaluate(() => (window as any).alp.status().peaks.layouts as number);
    const stillLayouts = () => page.evaluate(() => new Promise<number>((resolve) => {
      const a = (window as any).alp.status().peaks.layouts as number;
      let n = 0;
      const tick = () => { if (++n < 30) requestAnimationFrame(tick); else resolve((window as any).alp.status().peaks.layouts - a); };
      requestAnimationFrame(tick);
    }));
    await expect.poll(() => page.evaluate(() => (window as any).alp.status().peaks.settled as boolean), { timeout: 30_000 }).toBe(true);
    await expect.poll(stillLayouts, { timeout: 30_000 }).toBe(0);
    expect(await layouts()).toBeGreaterThan(0);
    const before = await drawn(), laidOut = await layouts();
    await page.keyboard.press('ArrowRight');
    await expect.poll(drawn, { timeout: 10_000 }).toBeGreaterThan(before);
    await expect.poll(layouts, { timeout: 10_000 }).toBeGreaterThan(laidOut);
    await expect.poll(quiet, { timeout: 30_000 }).toBe(0);
    await expect.poll(stillLayouts, { timeout: 30_000 }).toBe(0);
  });
});

