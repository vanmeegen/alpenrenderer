#!/usr/bin/env node
/**
 * Does the clipmap fill correctly from 512-px tiles?
 *
 * A synthetic source hands back tiles whose every pixel encodes its own global
 * pixel coordinate at the level's pixel zoom. After a fill, every raster cell
 * of every level must hold exactly the value of the pixel it claims to be —
 * which catches an off-by-one in the tile-zoom mapping, a wrong tile origin,
 * or a blit that reads the tile with the wrong stride. Run for 256 and 512.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(root, 'node_modules', '.cache-wgsl');
mkdirSync(tmp, { recursive: true });

const out = await build({
  entryPoints: [join(root, 'src', 'engine', 'sources', 'clipmap.ts')],
  bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'error',
});
writeFileSync(join(tmp, 'clipmap.mjs'), out.outputFiles[0].text);
const C = await import(`file://${join(tmp, 'clipmap.mjs')}`);

let failures = 0;

for (const tileSize of [256, 512]) {
  const shift = Math.round(Math.log2(tileSize / 256));
  const asked = [];
  const source = {
    name: `synthetic ${tileSize}`, tileSize, minZoom: 0, maxZoom: 20,
    async load(k) {
      asked.push(k);
      const pz = k.z + shift;                    // pixel zoom of this tile's pixels
      const h = new Float32Array(tileSize * tileSize);
      for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
          // A value unique per (pixel zoom, global px, global py), kept small
          // enough to survive the level's 1 m quantisation and the -1000 bias.
          const gx = k.x * tileSize + x, gy = k.y * tileSize + y;
          h[y * tileSize + x] = ((pz * 7919 + gx * 31 + gy * 17) % 50000);
        }
      }
      return h;
    },
  };

  const cfg = { size: 640, levels: [{ z: 14 }, { z: 13 }, { z: 10 }, { z: 7 }] };
  const lon = 10.98527, lat = 47.42111;
  const streamer = new C.ClipmapStreamer(source, cfg, lon, lat);
  await streamer.setCenter(lon, lat);

  for (const lv of streamer.heightField.levels) {
    let bad = 0, checked = 0;
    for (let y = 0; y < lv.h; y += 7) {
      for (let x = 0; x < lv.w; x += 5) {
        const gx = lv.px0 + x, gy = lv.py0 + y;
        const expect = ((lv.z * 7919 + gx * 31 + gy * 17) % 50000);
        const got = lv.raw[y * lv.w + x] * lv.quant + lv.bias;
        checked++;
        if (Math.abs(got - expect) > 0.5) bad++;
      }
    }
    const tilesForLevel = asked.filter((k) => k.z === lv.z - shift).length;
    const status = bad === 0 && lv.filled ? 'ok ' : 'BAD';
    if (bad || !lv.filled) failures++;
    console.log(`${status} tiles=${tileSize} pixel zoom ${lv.z} -> tile zoom ${lv.z - shift}: `
      + `${tilesForLevel} tiles, ${checked} cells checked, ${bad} wrong`);
  }
}

if (failures) {
  console.error(`\nclipmap fill FAILED in ${failures} level(s)`);
  process.exit(1);
}
console.log('\nclipmap fills correctly from 256- and 512-px tiles.');
