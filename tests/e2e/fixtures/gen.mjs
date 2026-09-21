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
function png(rgb, w, h, extra = []) {
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
    chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- a minimal EXIF (TIFF) writer: GPS, lens, time ---------------------------
function tiff({ lon, lat, focal35, taken }) {
  const entries = (list) => {
    const all = list.sort((a, b) => a.tag - b.tag);
    return (offset) => {
      const head = 2 + all.length * 12 + 4;
      const dir = Buffer.alloc(head);
      const data = [];
      let dataOff = offset + head;
      dir.writeUInt16LE(all.length, 0);
      all.forEach((e, i) => {
        const o = 2 + i * 12;
        dir.writeUInt16LE(e.tag, o); dir.writeUInt16LE(e.type, o + 2);
        let payload;
        if (e.type === 2) payload = Buffer.from(e.value + '\0', 'ascii');
        else if (e.type === 3) { payload = Buffer.alloc(2 * e.value.length); e.value.forEach((x, k) => payload.writeUInt16LE(x, k * 2)); }
        else if (e.type === 4) { payload = Buffer.alloc(4 * e.value.length); e.value.forEach((x, k) => payload.writeUInt32LE(x, k * 4)); }
        else { payload = Buffer.alloc(8 * e.value.length); e.value.forEach(([n, d], k) => { payload.writeUInt32LE(n, k * 8); payload.writeUInt32LE(d, k * 8 + 4); }); }
        const count = e.type === 2 ? payload.length : e.value.length;
        dir.writeUInt32LE(count, o + 4);
        if (payload.length <= 4) payload.copy(dir, o + 8);
        else { dir.writeUInt32LE(dataOff, o + 8); data.push(payload); dataOff += payload.length; }
      });
      return { bytes: Buffer.concat([dir, ...data]), end: dataOff };
    };
  };
  const dms = (deg) => {
    const a = Math.abs(deg), d = Math.floor(a), m = Math.floor((a - d) * 60);
    return [[d, 1], [m, 1], [Math.round(((a - d) * 60 - m) * 60 * 10000), 10000]];
  };
  const exifIfd = entries([{ tag: 0xa405, type: 3, value: [focal35] }, { tag: 0x9003, type: 2, value: taken }]);
  const gpsIfd = entries([
    { tag: 1, type: 2, value: lat >= 0 ? 'N' : 'S' }, { tag: 2, type: 5, value: dms(lat) },
    { tag: 3, type: 2, value: lon >= 0 ? 'E' : 'W' }, { tag: 4, type: 5, value: dms(lon) },
  ]);
  const ifd0Size = 2 + 2 * 12 + 4;
  const exif = exifIfd(8 + ifd0Size);
  const gps = gpsIfd(exif.end);
  const ifd0 = entries([{ tag: 0x8769, type: 4, value: [8 + ifd0Size] }, { tag: 0x8825, type: 4, value: [exif.end] }])(8);
  return Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), ifd0.bytes, exif.bytes, gps.bytes]);
}

// --- the fixture photo: the range as a camera at PHOTO would see it ---------
{
  const P = T.PHOTO;
  const DEG = Math.PI / 180;
  const R_EFF = 6371008.8 / (1 - 0.13);
  // The skyline per bearing, the same DEM march skylineRow uses.
  const from = P.yaw - 45, span = 90, step = 0.25;
  const prof = [];
  for (let b = 0; b <= span / step; b++) {
    const bearing = from + b * step;
    let maxTan = -Infinity;
    const steps = 6000, r0 = 1, r1 = 275000, k = Math.log(r1 / r0) / (steps - 1);
    for (let i = 0; i < steps; i++) {
      const r = r0 * Math.exp(i * k);
      const up = T.heightAlong(bearing, r) - (T.PLAIN_M + 1.7) - (r * r) / (2 * R_EFF);
      maxTan = Math.max(maxTan, up / r);
    }
    prof.push(Math.atan(maxTan) / DEG);
  }
  const profAt = (bearing) => {
    const t = (bearing - from) / step;
    const i = Math.floor(t);
    if (i < 0 || i + 1 >= prof.length) return NaN;
    return prof[i] * (1 - (t - i)) + prof[i + 1] * (t - i);
  };
  let seed = 4711;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const w = P.width, h = P.height;
  const rgb = Buffer.alloc(w * h * 3);
  const tanY = Math.tan(P.fovY * DEG / 2), tanX = tanY * (w / h);
  const cy = Math.cos(P.yaw * DEG), sy = Math.sin(P.yaw * DEG);
  const cp = Math.cos(P.pitch * DEG), sp = Math.sin(P.pitch * DEG);
  const cr = Math.cos(P.roll * DEG), sr = Math.sin(P.roll * DEG);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = ((px + 0.5) / w) * 2 - 1, v = 1 - ((py + 0.5) / h) * 2;
      const cx0 = u * tanX, cz0 = v * tanY;
      const cxr = cx0 * cr - cz0 * sr, czr = cx0 * sr + cz0 * cr;
      const ry = cp - czr * sp, rz = sp + czr * cp;
      const east = cxr * cy + ry * sy, north = -cxr * sy + ry * cy;
      const bearing = Math.atan2(east, north) / DEG;
      const elev = Math.atan2(rz, Math.hypot(east, north)) / DEG;
      const model = profAt(bearing);
      const isSky = Number.isNaN(model) || elev > model;
      let lum;
      if (isSky) lum = 148 + 42 * (1 - py / h) + 2 * (rnd() - 0.5);
      else {
        const depth = Math.max(0, model - elev);
        lum = (depth < 2.2 ? 205 : 96) + 46 * (rnd() - 0.5) + 26 * Math.sin(px * 0.7) * Math.cos(py * 0.5);
      }
      const i = (py * w + px) * 3;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = Math.max(0, Math.min(255, Math.round(lum)));
    }
  }
  const exif = chunk('eXIf', tiff({ lon: T.STAND.lon, lat: T.STAND.lat, focal35: P.focal35, taken: P.taken }));
  writeFileSync(join(here, 'photo.png'), png(rgb, w, h, [exif]));
  // And a photo that is nothing but fog, without any EXIF.
  const fog = Buffer.alloc(w * h * 3);
  for (let i = 0; i < fog.length; i++) fog[i] = 170 + Math.round(2 * (rnd() - 0.5));
  writeFileSync(join(here, 'photo-fog.png'), png(fog, w, h));
  console.log(`fixture photo: ${join(here, 'photo.png')} (${w}x${h}, yaw ${P.yaw}, pitch ${P.pitch}) and photo-fog.png`);
}

// --- tiles -------------------------------------------------------------------
let written = 0, kept = 0;
for (const centre of [T.STAND, T.FLANK]) for (const z of LEVELS) {
  const tz = z - 1;
  const px0 = Math.round(mercX(centre.lon, z)) - SIZE / 2;
  const py0 = Math.round(mercY(centre.lat, z)) - SIZE / 2;
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
