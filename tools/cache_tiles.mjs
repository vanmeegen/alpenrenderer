#!/usr/bin/env node
/**
 * Fills tile-cache/ with the Mapterhorn tiles the clipmap needs around one or
 * more standpoints, so the app can run offline or in a headless check with
 * `?tiles=/tile-cache/`. Uses curl: the sandbox and most laptops have it, and
 * it honours proxies that Node's fetch does not.
 *
 *   node tools/cache_tiles.mjs [lon,lat ...]      default: Gornergrat, Zugspitze
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tile-cache');
const LEVELS = [14, 13, 12, 11, 10, 9, 8, 7];   // pixel zooms of DEFAULT_CLIPMAP
const SIZE = 640;
const TILE = 512;

const points = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => s.split(',').map(Number))
  : [[7.78472, 45.98333], [10.98527, 47.42111]];

const mercX = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const mercY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};

let fetched = 0, kept = 0, failed = 0;
for (const [lon, lat] of points) {
  for (const z of LEVELS) {
    const tz = z - 1;                               // 512-px tiles sit one zoom lower
    const px0 = Math.round(mercX(lon, z)) - SIZE / 2;
    const py0 = Math.round(mercY(lat, z)) - SIZE / 2;
    for (let ty = Math.floor(py0 / TILE); ty <= Math.floor((py0 + SIZE - 1) / TILE); ty++) {
      for (let tx = Math.floor(px0 / TILE); tx <= Math.floor((px0 + SIZE - 1) / TILE); tx++) {
        const dir = join(out, String(tz), String(tx));
        const file = join(dir, `${ty}.webp`);
        if (existsSync(file) && statSync(file).size > 1000) { kept++; continue; }
        mkdirSync(dir, { recursive: true });
        try {
          execFileSync('curl', ['-sS', '-f', '-A', 'Mozilla/5.0 alpenrenderer-cache', '-o', file,
            `https://tiles.mapterhorn.com/${tz}/${tx}/${ty}.webp`], { stdio: 'pipe' });
          fetched++;
        } catch {
          failed++;
          console.error(`failed ${tz}/${tx}/${ty}`);
        }
      }
    }
  }
}
console.log(`tile-cache: ${fetched} fetched, ${kept} already present, ${failed} failed`);
