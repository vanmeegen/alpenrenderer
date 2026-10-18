#!/usr/bin/env node
/**
 * Adds the topographic prominence (Schartenhöhe) to the summit catalogue in
 * public/peaks/, computed from the Mapterhorn terrain itself: OpenStreetMap
 * tags it on 2.6 % of the Alpine peaks, and it is what decides which summits
 * get a label (the pointed 2500er, not the fourth bump of its ridge). Run by
 * hand after build_peaks.mjs and committed, like the catalogue.
 *
 *   node tools/build_prominence.mjs [--bbox 5,43,17,49] [--zoom 9] [--out public/peaks] [--force]
 *
 * Height grid: Mapterhorn tiles at pixel zoom 9 (212 m posts at 47°), the
 * bbox padded by a degree so that key cols at the edge are found; one mosaic
 * of some 30 M cells, prominence by union-find (tools/prominence.mjs). Each
 * catalogue peak takes the prominence of the highest grid cell within 1.5
 * cells (320 m) of its position, then 2.5 cells; an OSM `prominence` tag is
 * kept unless --force. Tiles come through curl into tile-cache/ (as
 * cache_tiles.mjs does) and are decoded by headless Chromium, the one WebP
 * decoder this repository already has.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { prominence, summitProminence } from './prominence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const [W, S, E, N] = opt('bbox', '5,43,17,49').split(',').map(Number);
const Z = Number(opt('zoom', '9'));          // pixel zoom; tiles are 512 px, one zoom lower
const out = resolve(root, opt('out', 'public/peaks'));
const force = flag('force');
const TILE = 512, TZ = Z - 1;
const PAD = 1;

const mercX = (lon) => ((lon + 180) / 360) * 256 * 2 ** Z;
const mercY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** Z;
};

// --- the tiles -------------------------------------------------------------
const tx0 = Math.floor(mercX(W - PAD) / TILE), tx1 = Math.floor(mercX(E + PAD) / TILE);
const ty0 = Math.floor(mercY(N + PAD) / TILE), ty1 = Math.floor(mercY(S - PAD) / TILE);
const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
const gw = cols * TILE, gh = rows * TILE;
console.log(`grid: tiles ${tx0}..${tx1} × ${ty0}..${ty1} at tile zoom ${TZ} → ${gw} × ${gh} cells (${((gw * gh) / 1e6).toFixed(1)} M)`);

const cache = join(root, 'tile-cache');
const tilePath = (tx, ty) => join(cache, String(TZ), String(tx), `${ty}.webp`);
let fetched = 0, failed = 0;
for (let ty = ty0; ty <= ty1; ty++) {
  for (let tx = tx0; tx <= tx1; tx++) {
    const file = tilePath(tx, ty);
    if (existsSync(file) && statSync(file).size > 1000) continue;
    mkdirSync(dirname(file), { recursive: true });
    try {
      execFileSync('curl', ['-sS', '-f', '-A', 'Mozilla/5.0 alpenrenderer-build', '-o', file,
        `https://tiles.mapterhorn.com/${TZ}/${tx}/${ty}.webp`], { stdio: 'pipe' });
      fetched++;
    } catch {
      failed++;
      console.error(`failed ${TZ}/${tx}/${ty}`);
    }
  }
}
console.log(`tiles: ${fetched} fetched, ${failed} failed`);

// --- decoding: a static server for tile-cache/ and a headless page --------
const port = 4190 + Math.floor(Math.random() * 50);
const server = spawn(process.execPath, [join(root, 'tools/serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const heights = new Int16Array(gw * gh).fill(0);
try {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/tools/prominence.mjs`);   // any same-origin document
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!existsSync(tilePath(tx, ty))) continue;
      // Terrarium: h = R·256 + G + B/256 − 32768, read byte-exact from a canvas.
      const buf = await page.evaluate(async ([url, size]) => {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const c = new OffscreenCanvas(size, size);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, size, size).data;
        const h = new Int16Array(size * size);
        for (let i = 0; i < size * size; i++) h[i] = Math.round(px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768);
        return Array.from(h);
      }, [`http://localhost:${port}/tile-cache/${TZ}/${tx}/${ty}.webp`, TILE]);
      if (!buf) { console.error(`undecodable ${TZ}/${tx}/${ty}`); continue; }
      const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
      for (let y = 0; y < TILE; y++) heights.set(buf.slice(y * TILE, (y + 1) * TILE), (oy + y) * gw + ox);
    }
  }
  await browser.close();
} finally {
  server.kill();
}

// --- prominence -------------------------------------------------------------
console.time('prominence');
const prom = prominence(heights, gw, gh);
console.timeEnd('prominence');

// --- into the catalogue -----------------------------------------------------
const px0 = tx0 * TILE, py0 = ty0 * TILE;
let total = 0, had = 0, set = 0, none = 0;
const hist = { '<50': 0, '50-100': 0, '100-300': 0, '300-1000': 0, '>=1000': 0 };
for (const f of readdirSync(out)) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const path = join(out, f);
  const recs = JSON.parse(readFileSync(path, 'utf8'));
  for (const r of recs) {
    total++;
    if (r.p !== undefined && !force) { had++; continue; }
    const x = Math.floor(mercX(r.o) - px0), y = Math.floor(mercY(r.a) - py0);
    if (x < 0 || y < 0 || x >= gw || y >= gh) { none++; continue; }
    const p = summitProminence(heights, prom, gw, gh, x, y, 1.5) ?? summitProminence(heights, prom, gw, gh, x, y, 2.5);
    if (p === undefined) { none++; delete r.p; continue; }
    r.p = Math.round(p);
    set++;
    hist[p < 50 ? '<50' : p < 100 ? '50-100' : p < 300 ? '100-300' : p < 1000 ? '300-1000' : '>=1000']++;
  }
  // Same compact shape build_peaks.mjs writes: `p` after `e`.
  const ordered = recs.map((r) => {
    const o = { i: r.i, n: r.n, o: r.o, a: r.a };
    if (r.e !== undefined) o.e = r.e;
    if (r.p !== undefined) o.p = r.p;
    for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];
    return o;
  });
  writeFileSync(path, JSON.stringify(ordered));
}
const indexPath = join(out, 'index.json');
if (existsSync(indexPath)) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.prominence = { generated: new Date().toISOString(), source: `Mapterhorn pixel zoom ${Z}, key-col union-find (tools/prominence.mjs)`, set, kept: had, none };
  writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');
}
console.log(`peaks ${total}: prominence set ${set}, kept from OSM ${had}, no summit in the grid ${none}`);
console.log('histogram of set values:', hist);
