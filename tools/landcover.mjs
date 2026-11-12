/**
 * The pure parts of the land cover build (tools/build_landcover.mjs): the
 * classes, the tile grid, the majority pyramid and the PNG writer. Plain ES
 * module, unit-tested in tests/unit/landcover.test.ts and used by the E2E
 * fixture generator for its own little world.
 *
 * Source: ESA WorldCover 10 m 2021 v200 (CC BY 4.0). Its eleven classes are
 * stored as an index 1..11, 0 for no data, four bits a pixel.
 */
import { deflateSync } from 'node:zlib';

/** WorldCover's class codes in the order of our index (1-based). */
export const CLASSES = [
  { code: 10, name: 'tree' },
  { code: 20, name: 'shrub' },
  { code: 30, name: 'grass' },
  { code: 40, name: 'crop' },
  { code: 50, name: 'built' },
  { code: 60, name: 'bare' },
  { code: 70, name: 'snow' },
  { code: 80, name: 'water' },
  { code: 90, name: 'wetland' },
  { code: 95, name: 'mangrove' },
  { code: 100, name: 'moss' },
];

const INDEX = new Uint8Array(256);
CLASSES.forEach((c, i) => { INDEX[c.code] = i + 1; });

/** Our index for a WorldCover code; 0 for no data or anything unknown. */
export const classIndex = (code) => INDEX[code & 255];

/** Pixels per tile, and the pixel zooms the tiles are written at (tile zoom is one lower). */
export const TILE = 512;
export const PIXEL_ZOOMS = { max: 10, min: 7 };

const worldPx = (z, tile = TILE) => tile * 2 ** z;
export const mercX = (lon, z, tile = TILE) => ((lon + 180) / 360) * worldPx(z, tile);
export const mercY = (lat, z, tile = TILE) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z, tile);
};
export const lonOf = (x, z, tile = TILE) => (x / worldPx(z, tile)) * 360 - 180;
export const latOf = (y, z, tile = TILE) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldPx(z, tile)))) * 180) / Math.PI;

/** The tiles of tile zoom `z` that touch a box [west, south, east, north]; y runs south. */
export function tileRange([west, south, east, north], z) {
  return {
    x0: Math.floor(mercX(west, z, 1)), x1: Math.floor(mercX(east, z, 1)),
    y0: Math.floor(mercY(north, z, 1)), y1: Math.floor(mercY(south, z, 1)),
  };
}

/**
 * One tile, `size`² class indices, row-major from the north-west corner:
 * `sample(lon, lat)` is asked for the class at each pixel's centre.
 */
export function mercatorTile(sample, z, x, y, size = TILE) {
  const out = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const lat = latOf(y * size + j + 0.5, z, size);
    for (let i = 0; i < size; i++) out[j * size + i] = sample(lonOf(x * size + i + 0.5, z, size), lat);
  }
  return out;
}

/**
 * The next coarser zoom: every pixel takes the class most of its four
 * children have. A tie goes to the first of the tied (row-major); no data
 * loses to any class, so coasts and the edge of the survey do not eat in.
 */
export function majority(src, w, h) {
  const W = w >> 1, H = h >> 1, out = new Uint8Array(W * H);
  const count = new Uint8Array(16);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const kids = [src[2 * y * w + 2 * x], src[2 * y * w + 2 * x + 1], src[(2 * y + 1) * w + 2 * x], src[(2 * y + 1) * w + 2 * x + 1]];
      count.fill(0);
      for (const k of kids) count[k]++;
      let best = 0, n = 0;
      for (const k of kids) if (k && count[k] > n) { best = k; n = count[k]; }
      out[y * W + x] = best;
    }
  }
  return out;
}

/**
 * Takes single pixels out: a pixel none of whose eight neighbours shares
 * its class takes the class most of them have. At 53 m a lone pixel is a
 * barn or a misread, and in the picture it is a speck; a line one pixel
 * wide (a river, a road through forest) and every edge stay as they are.
 * No data is neither filled in nor spread.
 */
export function despeckle(src, w, h) {
  const out = Uint8Array.from(src);
  const count = new Uint8Array(16);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = src[y * w + x];
      if (!c) continue;
      count.fill(0);
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) {
        for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) if (i !== x || j !== y) count[src[j * w + i]]++;
      }
      if (count[c]) continue;
      let best = 0, n = 0;
      for (let k = 1; k < 16; k++) if (count[k] > n) { best = k; n = count[k]; }
      if (best) out[y * w + x] = best;
    }
  }
  return out;
}

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/**
 * A greyscale PNG of bit depth 4: one class index (0..15) a pixel, two to
 * the byte. A browser's decoder hands it back as index × 17 in every
 * colour channel.
 */
export function encodeGray4(px, w, h) {
  const stride = Math.ceil(w / 2) + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x] & 15;
      raw[y * stride + 1 + (x >> 1)] |= x & 1 ? v : v << 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 4;   // bit depth
  ihdr[9] = 0;   // greyscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
