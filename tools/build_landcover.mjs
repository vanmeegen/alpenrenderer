#!/usr/bin/env node
/**
 * Bakes the land cover the app colours the ground by: ESA WorldCover 10 m
 * 2021 v200 (CC BY 4.0), read from its public bucket, cut into our own
 * small tiles under public/landcover/.
 *
 *   node tools/build_landcover.mjs [--bbox 5,43,17,49] [--out public/landcover]
 *
 * WorldCover comes as 3° × 3° cloud-optimised GeoTIFFs with overviews. The
 * 40 m overview is read whole (a few megabytes over the wire each), sampled
 * four times as fine as the finest tiles and reduced by majority, twice, to
 * pixel zoom 10: 106 m pixels at 47° north, with single stray pixels taken
 * out. (At 53 m the Alps were 35 MB of tiles, at 106 m they are ten.) The
 * coarser zooms down to 7 are majorities of the finer. A
 * tile is a 4-bit greyscale PNG of class indices (tools/landcover.mjs);
 * tiles without any class are not written. index.json names the source.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import { PIXEL_ZOOMS, TILE, classIndex, despeckle, encodeGray4, majority, mercatorTile, tileRange } from './landcover.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const bbox = opt('bbox', '5,43,17,49').split(',').map(Number);
const out = resolve(root, opt('out', 'public/landcover'));
const SOURCE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map';
const OVERVIEW = 2;                       // 40 m: 9000 px across 3°
const KEEP = 6;                           // source rasters in memory, 81 MB each

/** The 40 m raster of the 3° cell whose south-west corner is (lon0, lat0), as class indices; null where WorldCover has no file (open sea). */
const rasters = new Map();
async function raster(lon0, lat0) {
  const key = `${lat0}_${lon0}`;
  if (rasters.has(key)) {
    const r = rasters.get(key);
    rasters.delete(key);
    rasters.set(key, r);
    return r;
  }
  const name = `ESA_WorldCover_10m_2021_v200_${lat0 < 0 ? 'S' : 'N'}${String(Math.abs(lat0)).padStart(2, '0')}${lon0 < 0 ? 'W' : 'E'}${String(Math.abs(lon0)).padStart(3, '0')}_Map.tif`;
  let r = null;
  for (let attempt = 0; attempt < 4 && !r; attempt++) {
    try {
      const tiff = await fromUrl(`${SOURCE}/${name}`);
      const image = await tiff.getImage(OVERVIEW);
      const data = await image.readRasters({ interleave: true });
      for (let i = 0; i < data.length; i++) data[i] = classIndex(data[i]);
      r = { data, size: image.getWidth() };
    } catch (e) {
      if (/404|403|Not Found/i.test(String(e))) break;
      await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
      if (attempt === 3) throw e;
    }
  }
  console.log(`${name}: ${r ? `${r.size} px` : 'not there'}`);
  rasters.set(key, r);
  if (rasters.size > KEEP) rasters.delete(rasters.keys().next().value);
  return r;
}

rmSync(out, { recursive: true, force: true });
const write = (tz, x, y, px) => {
  if (!px.some((c) => c > 0)) return 0;
  mkdirSync(join(out, String(tz), String(x)), { recursive: true });
  const png = encodeGray4(px, TILE, TILE);
  writeFileSync(join(out, String(tz), String(x), `${y}.png`), png);
  return png.length;
};

const counts = {};
let bytes = 0;
const top = PIXEL_ZOOMS.max - 1;                       // tile zoom of the finest tiles
let level = new Map();
const range = tileRange(bbox, top);
for (let ty = range.y0; ty <= range.y1; ty++) {
  for (let tx = range.x0; tx <= range.x1; tx++) {
    // The source cells this tile touches, loaded before the samples are taken.
    const n = 2 ** top, west = (tx / n) * 360 - 180, east = ((tx + 1) / n) * 360 - 180;
    const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
    const cells = new Map();
    for (const lon0 of new Set([west, east - 1e-9].map((v) => Math.floor(v / 3) * 3))) {
      for (const lat0 of new Set([lat(ty), lat(ty + 1) + 1e-9].map((v) => Math.floor(v / 3) * 3))) {
        cells.set(`${lat0}_${lon0}`, await raster(lon0, lat0));
      }
    }
    const sample = (lon, la) => {
      const lon0 = Math.floor(lon / 3) * 3, lat0 = Math.floor(la / 3) * 3;
      const r = cells.get(`${lat0}_${lon0}`);
      if (!r) return 0;
      const px = Math.min(r.size - 1, Math.floor(((lon - lon0) / 3) * r.size));
      const py = Math.min(r.size - 1, Math.floor(((lat0 + 3 - la) / 3) * r.size));
      return r.data[py * r.size + px];
    };
    const fine = mercatorTile(sample, top, tx, ty, 4 * TILE);
    const px = despeckle(majority(majority(fine, 4 * TILE, 4 * TILE), 2 * TILE, 2 * TILE), TILE, TILE);
    level.set(`${tx}/${ty}`, px);
    const size = write(top, tx, ty, px);
    if (size) { bytes += size; counts[top] = (counts[top] ?? 0) + 1; }
  }
  console.log(`zoom ${top}: row ${ty - range.y0 + 1} of ${range.y1 - range.y0 + 1}`);
}

// The coarser zooms: each tile the majority of its four children.
for (let tz = top - 1; tz >= PIXEL_ZOOMS.min - 1; tz--) {
  const next = new Map();
  const parents = new Set([...level.keys()].map((k) => { const [x, y] = k.split('/').map(Number); return `${x >> 1}/${y >> 1}`; }));
  for (const key of parents) {
    const [x, y] = key.split('/').map(Number);
    const big = new Uint8Array(4 * TILE * TILE);
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const child = level.get(`${2 * x + i}/${2 * y + j}`);
      if (!child) continue;
      for (let r = 0; r < TILE; r++) big.set(child.subarray(r * TILE, (r + 1) * TILE), (j * TILE + r) * 2 * TILE + i * TILE);
    }
    const px = majority(big, 2 * TILE, 2 * TILE);
    next.set(key, px);
    const size = write(tz, x, y, px);
    if (size) { bytes += size; counts[tz] = (counts[tz] ?? 0) + 1; }
  }
  level = next;
}

writeFileSync(join(out, 'index.json'), `${JSON.stringify({
  source: 'ESA WorldCover 10 m 2021 v200',
  attribution: '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
  license: 'CC BY 4.0',
  url: 'https://esa-worldcover.org',
  bbox,
  tile: TILE,
  pixelZooms: PIXEL_ZOOMS,
  classes: ['none', 'tree', 'shrub', 'grass', 'crop', 'built', 'bare', 'snow', 'water', 'wetland', 'mangrove', 'moss'],
  tiles: counts,
}, null, 2)}\n`);
console.log(`land cover: ${Object.values(counts).reduce((a, b) => a + b, 0)} tiles, ${(bytes / 1e6).toFixed(1)} MB in ${out}`);
