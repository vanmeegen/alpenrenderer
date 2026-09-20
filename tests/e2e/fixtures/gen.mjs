#!/usr/bin/env node
/**
 * Writes the synthetic test range as Terrarium tiles, 512 px, for every
 * clipmap level around the standpoint. PNG data under a .webp name: the app's
 * decoder sniffs the format, and PNG needs no library to write.
 *
 *   node tests/e2e/fixtures/gen.mjs            -> tests/e2e/fixtures/tiles/{z}/{x}/{y}.webp
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'tiles');
// The fixture formula lives in TypeScript for the tests; Bun runs it as is.
const T = await import('./terrain.ts');

const TILE = 512;
const SIZE = 640;
const LEVELS = [14, 13, 12, 11, 10, 9, 8, 7];

const n = (z) => 256 * 2 ** z;
const mercX = (lon, z) => ((lon + 180) / 360) * n(z);
const mercY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n(z);
};
const lonOf = (x, z) => (x / n(z)) * 360 - 180;
const latOf = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n(z)))) * 180 / Math.PI;

// --- minimal PNG writer -----------------------------------------------------
const CRC = new Int32Array(256).map((_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- tiles -------------------------------------------------------------------
let written = 0, kept = 0;
for (const z of LEVELS) {
  const tz = z - 1;
  const px0 = Math.round(mercX(T.STAND.lon, z)) - SIZE / 2;
  const py0 = Math.round(mercY(T.STAND.lat, z)) - SIZE / 2;
  for (let ty = Math.floor(py0 / TILE); ty <= Math.floor((py0 + SIZE - 1) / TILE); ty++) {
    for (let tx = Math.floor(px0 / TILE); tx <= Math.floor((px0 + SIZE - 1) / TILE); tx++) {
      const dir = join(out, String(tz), String(tx));
      const file = join(dir, `${ty}.webp`);
      if (existsSync(file)) { kept++; continue; }
      mkdirSync(dir, { recursive: true });
      const rgb = Buffer.alloc(TILE * TILE * 3);
      for (let y = 0; y < TILE; y++) {
        const lat = latOf(ty * TILE + y + 0.5, z);
        for (let x = 0; x < TILE; x++) {
          const lon = lonOf(tx * TILE + x + 0.5, z);
          const v = Math.round((T.heightAt(lon, lat) + 32768) * 256);
          const o = (y * TILE + x) * 3;
          rgb[o] = (v >> 16) & 255; rgb[o + 1] = (v >> 8) & 255; rgb[o + 2] = v & 255;
        }
      }
      writeFileSync(file, png(rgb, TILE, TILE));
      written++;
    }
  }
}
console.log(`fixture tiles: ${written} written, ${kept} kept in ${out}`);

// The summit catalogue for the range: one cell file, in the app's own format.
const peaksDir = join(here, 'peaks');
mkdirSync(peaksDir, { recursive: true });
writeFileSync(join(peaksDir, '10_47.json'), JSON.stringify(T.PEAKS));
console.log(`fixture peaks: ${T.PEAKS.length} in ${peaksDir}/10_47.json`);

// The fake camera: one 640x480 frame, light grey above, dark grey below (Y4M
// 4:2:0, no chroma, so no colour-matrix ambiguity). Chromium plays it as the
// device camera with --use-file-for-fake-video-capture.
{
  const w = 640, h = 480;
  const Y = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) Y.fill(y < h / 2 ? T.CAMERA_TOP_Y : T.CAMERA_BOTTOM_Y, y * w, (y + 1) * w);
  const C = Buffer.alloc((w / 2) * (h / 2), 128);
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`, 'ascii');
  const frame = Buffer.concat([Buffer.from('FRAME\n', 'ascii'), Y, C, C]);
  writeFileSync(join(here, 'camera.y4m'), Buffer.concat([header, frame, frame, frame]));
  console.log(`fixture camera: ${join(here, 'camera.y4m')}`);
}
