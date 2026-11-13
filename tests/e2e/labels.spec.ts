/**
 * Summit labels over the panorama. The catalogue is the fixture's own
 * (tests/e2e/fixtures/peaks), served next to the tiles; expectations for
 * where a label sits come from the terrain formula, not from a picture.
 */
import { expect, Page, test } from '@playwright/test';
import { FLANK, PEAKS, RIDGE_CREST, SHOULDER, STAND, TESTHORN, TESTHORN_RANGE, heightAt, skylineRow, summitScreenY } from './fixtures/terrain';

const TILES = '/tests/e2e/fixtures/tiles/';
const PEAK_CELLS = '/tests/e2e/fixtures/peaks/';
const W = 1000, H = 600;
const R_EFF_M = 6371008.8 / (1 - 0.13);

function url(hash: Record<string, number | string> = {}, query: Record<string, string> = {}) {
  const q = new URLSearchParams({ tiles: TILES, peaks: PEAK_CELLS, lakes: '/tests/e2e/fixtures/lakes/', cover: '/tests/e2e/fixtures/cover/', imagery: '/tests/e2e/fixtures/imagery/', q: 'low', shade: '0', fade: '0', ...query });
  const h = new URLSearchParams(Object.entries({ lon: STAND.lon, lat: STAND.lat, yaw: 90, pitch: 0, fov: 60, ...hash })
    .map(([k, v]) => [k, String(v)]));
  return `/dist/?${q}#${h}`;
}

interface Placed { name: string; ax: number; ay: number; bx: number; by: number; bw: number; bh: number }

/**
 * Terrain loaded and the labels final: a label from a rebuild on half-loaded
 * levels sits on the coarse mesh until the last rebuild replaces it.
 */
async function ready(page: Page) {
  await page.waitForFunction(() => {
    const v = (window as any).alp;
    if (!v) return false;
    const s = v.status();
    return s.levelsReady >= s.levels && s.diagnostics.framesDrawn > 3 && s.peaks.settled;
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
    // All but the Hinterhorn: the Schulterkopf counts, seen as its own edge (below).
    expect((await ready(page)).peaks).toMatchObject({ total: PEAKS.length, visible: PEAKS.length - 1 });
    const [t] = await labels(page);
    expect(Math.abs(t.ax - W / 2)).toBeLessThan(3);
    expect(Math.abs(t.ay - summitScreenY(s.eyeAltitude, 60) * H)).toBeLessThan(H * 0.02);
    expect(t.by + t.bh).toBeLessThan(t.ay);
    expect(await inkIn(page, t)).toBeGreaterThan(50);
    await expect(page.getByText(`Gipfel ${PEAKS.length - 1}/${PEAKS.length}`)).toBeVisible();
  });

  test('a new standpoint drops the labels of the old one at once; a turn of the head keeps them', async ({ page }) => {
    // The targets hold bearings and ranges from the standpoint. Until the
    // catalogue for the new one arrived, the old ones were drawn from there.
    await page.goto(url());
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toContain('Testhorn');
    const turned = await page.evaluate(() => {
      const v = (window as any).alp;
      void v.relocate({ yaw: 95 });
      return { targets: v.targets.length as number };
    });
    expect(turned.targets).toBeGreaterThan(0);                  // kept
    const moved = await page.evaluate(([lon, lat]) => {
      const v = (window as any).alp;
      void v.relocate({ lon, lat });
      return { targets: v.targets.length as number, placed: v.placed.length as number, settled: v.status().peaks.settled as boolean };
    }, [FLANK.lon, FLANK.lat]);
    expect(moved).toEqual({ targets: 0, placed: 0, settled: false });
    // And they come back, computed from the new standpoint.
    await expect.poll(() => page.evaluate(() => {
      const v = (window as any).alp;
      return v.status().peaks.settled && v.targets.length > 0;
    }), { timeout: 60_000 }).toBe(true);
  });

  test('labels keep clear of the menu, the status panel and the compass; a summit under a panel is named once the panel is gone', async ({ page }) => {
    // Turned 20° to the right, the Testhorn's summit lies under the status
    // panel at the top left. Its name used to be painted there, under the panel.
    await page.goto(url({ yaw: 110 }));
    await ready(page);
    await expect.poll(() => page.evaluate(() => (window as any).alp.status().peaks.settled), { timeout: 30_000 }).toBe(true);
    const over = async () => page.evaluate(() => {
      const c = document.querySelector('canvas.labels')!.getBoundingClientRect();
      return [...document.querySelectorAll('[data-over-view]')].map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
      }).filter((r) => r.w > 0 && r.h > 0);
    });
    const panels = await over();
    expect(panels.length).toBeGreaterThanOrEqual(3);            // rail, status, compass
    const summit = { x: W / 2 - (Math.tan((20 * Math.PI) / 180) / (Math.tan(Math.PI / 6) * (W / H))) * (W / 2), y: summitScreenY((await ready(page)).eyeAltitude, 60) * H };
    expect(panels.some((r) => summit.x > r.x && summit.x < r.x + r.w && summit.y > r.y && summit.y < r.y + r.h)).toBe(true);
    const clear = async () => {
      const rects = await over();
      for (const l of await labels(page)) {
        for (const r of rects) {
          expect(l.bx < r.x + r.w && l.bx + l.bw > r.x && l.by < r.y + r.h && l.by + l.bh > r.y, `${l.name} under a panel`).toBe(false);
          expect(l.ax >= r.x && l.ax <= r.x + r.w && l.ay >= r.y && l.ay <= r.y + r.h, `${l.name}'s pin under a panel`).toBe(false);
        }
      }
    };
    await clear();
    expect((await labels(page)).map((l) => l.name)).not.toContain('Testhorn');
    // The menu folded away: the summit is free, and named.
    await page.getByRole('button', { name: 'Menü ausblenden' }).click();
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toContain('Testhorn');
    await clear();
  });

  test('a summit behind its own shoulder is labelled on its visible edge, the card says how far the summit is', async ({ page }) => {
    // The Schulterkopf's top is 1.2° behind the edge of its own wall (fixture
    // SHOULDER): what you see is that wall, so its name goes on the edge, the
    // skyline row of the column (horizon.ts ownCrest). The hash fov is the
    // vertical angle; 30° stays under the telescope.
    const W = 1000, H = 600, FOV = 30, PITCH = 10;
    await page.goto(url({ yaw: SHOULDER.bearing, pitch: PITCH, fov: FOV }));
    const s = await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Schulterkopf']);
    const [t] = await labels(page);
    expect(Math.abs(t.ax - W / 2)).toBeLessThan(4);
    // The pin on the drawn edge: the column's skyline row from the formula.
    const edgeRow = skylineRow(SHOULDER.bearing, t.ax, s.eyeAltitude, FOV, W, H, PITCH);
    expect(Math.abs(t.ay - edgeRow)).toBeLessThan(H * 0.015);
    // And well above where the hidden top would sit.
    const R_EFF = 6371008.8 / (1 - 0.13);
    const topElev = Math.atan2(heightAt(SHOULDER.lon, SHOULDER.lat) - s.eyeAltitude - SHOULDER.top ** 2 / (2 * R_EFF), SHOULDER.top);
    const topRow = H / 2 - (H / 2) * Math.tan(topElev - (PITCH * Math.PI) / 180) / Math.tan((FOV * Math.PI) / 360);
    expect(t.ay).toBeLessThan(topRow - H * 0.015);
    await page.mouse.click(t.bx + t.bw / 2, t.by + t.bh / 2);
    const card = page.locator('.alp-peak-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Schulterkopf');
    await expect(card).toContainText('3.4 km');
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
    await page.goto(url({ pitch: 26, fov: 5 }));
    await ready(page);
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Testhorn']);
    await expect.poll(() => pinOffApex(page), { timeout: 30_000 }).toBeLessThan(1);
  });

  test('zoomed in, the telescope cuts its fine windows around the Testhorn and draws the apex where the formula puts it', async ({ page }) => {
    // Below 30° the three look levels (z14, z13 and z12; z13, z12 and z11 at
    // the low quality the tests run at) are cut around the point the centre
    // of the view meets, and a dense band of rings sits there: the apex is
    // drawn from 13 m posts on rings 9 m apart, instead of from 26 m posts
    // on rings 42 m apart (1/120 of 5 km). The windows lie in one another;
    // the picture is read when all are in (weight 1: at once here, fade=0).
    await page.goto(url({ pitch: 26, fov: 5 }));
    const s = await ready(page);
    const looks = () => page.evaluate(() => (window as any).alp.streamer.heightField.levels
      .filter((l: any) => l.role === 'look' && l.filled && l.weight === 1).map((l: any) => ({ z: l.z, px0: l.px0, py0: l.py0, w: l.w })));
    await expect.poll(async () => (await looks()).map((l: any) => l.z).sort(), { timeout: 60_000 }).toEqual([11, 12, 13]);
    const fine = (await looks()).sort((a: any, b: any) => b.z - a.z)[0];
    expect(fine.z).toBe(13);
    // Cut around the Testhorn, not around the standpoint: its centre within a quarter window of the summit.
    const merc = (lon: number, z: number) => ((lon + 180) / 360) * 256 * 2 ** z;
    expect(Math.abs(fine.px0 + fine.w / 2 - merc(TESTHORN.lon, fine.z))).toBeLessThan(fine.w / 4);
    expect(Math.abs(fine.px0 + fine.w / 2 - merc(STAND.lon, fine.z))).toBeGreaterThan(fine.w / 2);
    // The apex on screen, from the formula: elevation of the summit, less the pitch, in a 5° frame.
    const elev = Math.atan2(TESTHORN.summit - s.eyeAltitude, TESTHORN_RANGE);
    const expectedY = H / 2 - (H / 2) * Math.tan(elev - (26 * Math.PI) / 180) / Math.tan((2.5 * Math.PI) / 180);
    // 13 m posts round the cone's apex by up to 9 m: 0.1° here, 13 px of 600.
    // Without the telescope the apex comes 30–40 m low: 0.4°, 48 px.
    await expect.poll(async () => Math.abs((await drawnApex(page)).y - expectedY), { timeout: 30_000 }).toBeLessThan(H * 0.025);
  });

  test('a window of the telescope rises into the picture instead of jumping: its weight goes from nothing to all over the frames of a third of a second', async ({ page }) => {
    // The fine window holds crests the eye's coarser level averages away,
    // tens of metres at 15 km and tens of pixels at 2.7°: shown at once, the
    // ridge jumps. The other tests switch the rise off (fade=0 in url): it
    // is some twenty frames a page under the software rasterizer.
    await page.goto(url({ pitch: 26, fov: 5 }, { fade: '1' }));
    // Every look window's weight at every animation frame, from its first filled frame on.
    const seen = await page.evaluate(() => new Promise<Record<number, number[]>>((resolve) => {
      const out: Record<number, number[]> = {};
      const t0 = performance.now();
      const tick = () => {
        const v = (window as any).alp;
        const looks = v ? v.streamer.heightField.levels.filter((l: any) => l.role === 'look') : [];
        for (const l of looks) if (l.filled) (out[l.z] ??= []).push(l.weight ?? 1);
        const done = looks.length === 3 && looks.every((l: any) => l.filled && l.weight === 1);
        if (done || performance.now() - t0 > 90_000) resolve(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    expect(Object.keys(seen).map(Number).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    for (const z of [11, 12, 13]) {
      const w = seen[z];
      // The frame it arrives in may be sampled before the viewer has seen
      // it, and a window cut anew while the terrain loads starts over: from
      // the last time it was at its lowest on. However slow the frames, a
      // window comes up a quarter at most in each (lookfade.ts LOOK_FADE_STEP).
      const rise = w.slice(w.lastIndexOf(Math.min(...w)));
      expect(rise[0]).toBeLessThan(0.2);
      expect(rise.filter((x) => x > 0.05 && x < 0.95).length).toBeGreaterThanOrEqual(2);
      expect(rise.every((x, i) => i === 0 || x >= rise[i - 1])).toBe(true);
      expect(rise[rise.length - 1]).toBe(1);
    }
  });

  test('the wheel zooms in to 2.7°, three times closer than it used to; the Testhorn label sits on the apex as drawn, and a reload shows the same picture', async ({ page }) => {
    await page.goto(url({ pitch: 26.4, fov: 8 }));
    await ready(page);
    const hash = async () => new URLSearchParams((await page.evaluate(() => location.hash)).slice(1));
    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, -3000);                      // far more than it takes: the zoom stops at its end
    await expect.poll(async () => (await hash()).get('fov'), { timeout: 30_000 }).toBe('2.7');
    // A pixel is now 0.0045°, 40 cm on the summit 5 km off; the pin is on the apex the mesh draws.
    await expect.poll(() => labels(page).then((l) => l.map((p) => p.name)), { timeout: 30_000 }).toEqual(['Testhorn']);
    await expect.poll(() => pinOffApex(page), { timeout: 30_000 }).toBeLessThan(1);

    // Turned a little by hand, so that direction and tilt are no round numbers; then the same link, loaded anew.
    await page.mouse.down();
    await page.mouse.move(537, 277, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number((await hash()).get('yaw')), { timeout: 30_000 }).not.toBe(90);
    await page.waitForTimeout(700);                        // the URL follows the view within 400 ms
    const before = { apex: await drawnApex(page), yaw: (await hash()).get('yaw'), pitch: (await hash()).get('pitch') };
    expect(before.yaw).toMatch(/^\d+\.\d\d$/);             // hundredths of a degree
    await page.reload();
    await ready(page);
    expect((await hash()).get('fov')).toBe('2.7');
    await expect.poll(async () => {
      const apex = await drawnApex(page);
      return Math.max(Math.abs(apex.x - before.apex.x), Math.abs(apex.y - before.apex.y));
    }, { timeout: 30_000 }).toBeLessThan(3);
  });

  test('a summit catalogued on its flank gets its pin on the drawn top, not in the air beside it or in the slope', async ({ page }) => {
    // OSM points often sit some tens of metres off the top. Here the Testhorn
    // is catalogued 60 m north of its apex, on the flank: the pin belongs on
    // the apex as drawn (Schynige Platte, 2026: pins in the slope).
    await page.route(/fixtures\/peaks\/10_47\.json/, (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(PEAKS.map((p) => (p.n === 'Testhorn' ? { ...p, a: p.a + 60 / 111320 } : p))),
    }));
    await page.goto(url({ pitch: 26, fov: 5 }));
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
    await expect.poll(async () => Math.abs(((await labels(page))[0]?.ay ?? Infinity) - expectedY), { timeout: 30_000 }).toBeLessThan(H * 0.01);
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

test.describe('finding a summit', () => {
  test('the panel lists what is in sight; a hidden summit is found by name and marked hidden; a tap looks at it, and once the view has turned away an arrow points back', async ({ page }) => {
    await page.goto(url({ yaw: 0 }));                       // looking north, the Testhorn out of the frame to the right
    await ready(page);
    await page.getByRole('button', { name: 'Gipfel suchen' }).click();
    const list = page.getByRole('list', { name: 'Gipfel' });
    // In sight from here: the Testhorn and the Gratspitze on the northern ridge. Not the Hinterhorn, behind the Testhorn.
    await expect(list.getByRole('button', { name: /Testhorn/ })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('button', { name: /Gratspitze/ })).toBeVisible();
    await expect(list.getByRole('button', { name: /Hinterhorn/ })).toHaveCount(0);

    // By name it is found, whatever case, and marked as hidden; the others are gone from the list.
    await page.getByRole('searchbox', { name: 'Gipfel suchen' }).fill('HINTER');
    const hit = list.getByRole('button', { name: /Hinterhorn/ });
    await expect(hit).toContainText('verdeckt');
    await expect(list.getByRole('button', { name: /Testhorn/ })).toHaveCount(0);

    // A tap looks at it: the view turns east, onto its bearing and elevation, and the card says what it is.
    await hit.click();
    const sought = () => page.evaluate(() => (window as any).alp.status().sought as { name: string; visible: boolean; inFrame: boolean; turn: number } | null);
    await expect.poll(async () => (await sought())?.inFrame, { timeout: 15_000 }).toBe(true);
    const hash = async () => new URLSearchParams((await page.evaluate(() => location.hash)).slice(1));
    await expect.poll(async () => Number((await hash()).get('yaw')), { timeout: 15_000 }).toBeCloseTo(90, 0);
    expect((await sought())!.name).toBe('Hinterhorn');
    expect((await sought())!.visible).toBe(false);
    await expect(page.locator('.alp-peak-card')).toContainText('Hinterhorn');
    await expect(page.locator('.alp-peak-card')).toContainText('verdeckt');
    // It has no label (it is hidden), but it is marked where it stands: in the middle of the picture.
    expect((await labels(page)).some((l) => l.name === 'Hinterhorn')).toBe(false);
    await expect.poll(() => inkIn(page, { bx: 440, by: 240, bw: 120, bh: 100 })).toBeGreaterThan(50);

    // Turned to the south, it is a quarter turn to the left: the arrow stands left of the middle.
    await page.evaluate(() => { const h = new URLSearchParams(location.hash.slice(1)); h.set('yaw', '180'); h.set('pitch', '0'); location.hash = h.toString(); });
    await expect.poll(async () => (await sought())?.inFrame, { timeout: 15_000 }).toBe(false);
    expect((await sought())!.turn).toBeCloseTo(-90, 0);
    // (The overlay is painted with the next frame: polled, not read at once.)
    await expect.poll(() => inkIn(page, { bx: 200, by: 250, bw: 110, bh: 100 })).toBeGreaterThan(50);
    expect(await inkIn(page, { bx: 700, by: 250, bw: 110, bh: 100 })).toBe(0);

    // Closing the card ends the search.
    await page.locator('.alp-peak-card').getByRole('button', { name: 'Schließen' }).click();
    await expect.poll(sought).toBeNull();
    await expect.poll(() => inkIn(page, { bx: 200, by: 250, bw: 110, bh: 100 })).toBe(0);
  });
});
