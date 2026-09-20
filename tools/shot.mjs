#!/usr/bin/env node
/**
 * Renders the built app headless and saves a screenshot.
 *
 *   node tools/shot.mjs <url> <out.png> [width height]
 *
 * Waits until every clipmap level has landed and a few frames were drawn,
 * then reports the viewer's status and any page errors. Needs a served build:
 * `python3 -m http.server 8765` in the repo root and a URL such as
 * http://localhost:8765/dist/?tiles=/tile-cache/#lon=7.78&lat=45.98&yaw=232
 */
import { chromium } from 'playwright';

const [url, out = 'shots/shot.png', w = '1280', h = '800'] = process.argv.slice(2);
if (!url) { console.error('usage: shot.mjs <url> [out.png] [w h]'); process.exit(2); }

const exe = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
const ok = await page.waitForFunction(() => {
  const v = window.alp;
  if (!v) return false;
  const s = v.status();
  return s.levelsReady >= s.levels && s.diagnostics.framesDrawn > 5;
}, null, { timeout: 180000 }).then(() => true).catch(() => false);
await page.waitForTimeout(800);

const status = await page.evaluate(() => {
  const v = window.alp;
  if (!v) return null;
  const s = v.status();
  const d = s.diagnostics;
  return {
    tiles: `${s.tilesDone}/${s.tilesTotal}`, levels: `${s.levelsReady}/${s.levels}`,
    ground: Math.round(s.ground), eye: Math.round(s.eyeAltitude), failed: s.failed,
    backend: s.backend, quality: s.quality, frames: d.framesDrawn, frameErrors: d.frameErrors,
    pipelines: `${d.terrainReady}/${d.shadeReady}/${d.compositeReady}`,
    vertices: d.vertices, sectors: d.sectorsDrawn, shaderErrors: d.shaderErrors,
    surveys: s.surveys.map((x) => x.producerShort),
  };
});
await page.screenshot({ path: out });
console.log(JSON.stringify({ ready: ok, status, errors: errors.slice(0, 10) }, null, 1));
await browser.close();
if (!ok || !status || status.frameErrors > 0 || (status.shaderErrors?.length ?? 0) > 0) process.exit(1);
