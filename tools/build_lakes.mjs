#!/usr/bin/env node
/**
 * Builds the static lake catalogue: every named standing water in the Alps
 * from OpenStreetMap via Overpass (natural=water ways and multipolygons,
 * rivers and canals excluded, at least MIN_AREA), one JSON file per 1°×1°
 * cell in public/lakes/, in the record format
 * src/engine/sources/lakecatalog.ts reads. Each lake is filed under the cell
 * of its label point, so a lake across a cell edge is stored once.
 *
 *   node tools/build_lakes.mjs [--bbox 5,43,17,49] [--out public/lakes] [--refresh] [--cells 11_47] [--budget-minutes 100]
 *
 * Same habits as build_peaks.mjs: existing cells are kept unless --refresh,
 * a cell that fails every attempt is listed as missing in index.json, and a
 * time budget ends the run before a CI job limit would.
 *
 * Data © OpenStreetMap contributors, ODbL.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assembleRings, labelPoint, ringArea, simplifyRing } from './lakegeom.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const [W, S, E, N] = opt('bbox', '5,43,17,49').split(',').map(Number);
const out = opt('out', 'public/lakes');
const only = opt('cells', '') ? new Set(opt('cells', '').split(',')) : null;
const budgetMs = Number(opt('budget-minutes', '100')) * 60_000;
const startedAt = Date.now();
mkdirSync(out, { recursive: true });

/** Square metres; a one-hectare tarn is about the smallest the panorama can show. */
const MIN_AREA = 10_000;
/** `water=*` values that are not a lake to name. */
const NOT_A_LAKE = new Set(['river', 'canal', 'stream', 'ditch', 'drain', 'wastewater', 'moat', 'fish_pass', 'lock', 'stream_pool', 'basin', 'fountain', 'pool']);

const ENDPOINTS = process.env.OVERPASS_ENDPOINTS?.split(',') ?? [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'alpenrenderer-build/0.1 (+https://github.com/vanmeegen/alpenrenderer)';
const MAX_ATTEMPTS = Number(process.env.OVERPASS_ATTEMPTS ?? 15);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => {
  if (!s) return undefined;
  const v = parseFloat(String(s).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(v) ? Math.round(v) : undefined;
};
const r5 = (v) => Math.round(v * 1e5) / 1e5;

async function fetchCell(x, y) {
  const bb = `${y},${x},${y + 1},${x + 1}`;
  const q = `[out:json][timeout:120][maxsize:536870912];(way["natural"="water"]["name"](${bb});relation["natural"="water"]["name"]["type"="multipolygon"](${bb}););out body geom;`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > budgetMs) return null;
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text).elements;
      const err = new Error(`HTTP ${res.status}: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 120)}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      const wait = e.status === 429 ? Math.max(60_000, Math.min(90_000, 5000 * 1.6 ** attempt))
        : Math.min(90_000, 5000 * 1.6 ** attempt);
      console.error(`  ${x}_${y} via ${new URL(ep).host}: ${e.message} — retry ${attempt + 1}/${MAX_ATTEMPTS} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  return null;
}

/** One lake record, or null when it is not a lake, too small, or has no closed shore. */
function toRecord(e, x, y) {
  const t = e.tags ?? {};
  if (NOT_A_LAKE.has(t.water)) return null;
  const name = t.name ?? t['name:de'] ?? t['name:it'] ?? t['name:fr'] ?? t['name:sl'];
  if (!name) return null;
  const ways = e.type === 'way'
    ? [e.geometry ?? []]
    : (e.members ?? []).filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry);
  const rings = assembleRings(ways);
  if (!rings.length) return null;
  // Outer shores minus islands; even-odd, so sum outer and subtract inner by size order.
  const areas = rings.map(ringArea).sort((a, b) => b - a);
  const area = areas[0] - areas.slice(1).reduce((s, a) => s + a, 0) * (e.type === 'way' ? 0 : 1);
  if (area < MIN_AREA) return null;
  const lp = labelPoint(rings);
  if (Math.floor(lp.lon) !== x || Math.floor(lp.lat) !== y) return null;   // filed under its own cell
  const tol = Math.max(5, Math.min(25, Math.sqrt(area) / 100));
  const g = rings
    .map((r) => simplifyRing(r, tol))
    .filter((r) => r.length >= 6)
    .map((r) => r.map(r5));
  const rec = { i: `${e.type === 'way' ? 'w' : 'r'}${e.id}`, n: name, o: r5(lp.lon), a: r5(lp.lat), ar: Math.round(area), g };
  const ele = num(t.ele);
  if (ele !== undefined && ele > 0 && ele < 5000) rec.e = ele;
  if (t.wikidata) rec.w = t.wikidata;
  if (t.wikipedia) rec.k = t.wikipedia;
  return rec;
}

const index = {
  generated: new Date().toISOString(),
  source: `OpenStreetMap via Overpass, natural=water with name, not rivers or canals, at least ${MIN_AREA} m²`,
  license: 'ODbL 1.0',
  bbox: [W, S, E, N],
  cells: {},
  missing: [],
};
let total = 0;
for (let y = S; y < N; y++) {
  for (let x = W; x < E; x++) {
    const key = `${x}_${y}`;
    if (only && !only.has(key)) continue;
    const file = join(out, `${key}.json`);
    if (!flag('refresh') && existsSync(file)) {
      const n = JSON.parse(readFileSync(file, 'utf8')).length;
      index.cells[key] = n; total += n;
      console.error(`${key}: ${n} (kept)`);
      continue;
    }
    if (Date.now() - startedAt > budgetMs) { index.missing.push(key); continue; }
    const elements = await fetchCell(x, y);
    if (!elements) {
      index.missing.push(key);
      console.error(`${key}: MISSING`);
      continue;
    }
    const seen = new Set();
    const records = [];
    for (const e of elements) {
      const r = toRecord(e, x, y);
      if (r && !seen.has(r.i)) { seen.add(r.i); records.push(r); }
    }
    records.sort((a, b) => b.ar - a.ar);
    if (records.length) writeFileSync(file, JSON.stringify(records));
    index.cells[key] = records.length;
    total += records.length;
    console.error(`${key}: ${records.length}`);
    await sleep(1500);
  }
}
index.total = total;
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
console.error(`${total} lakes in ${Object.values(index.cells).filter(Boolean).length} cells -> ${out}`
  + ` in ${Math.round((Date.now() - startedAt) / 60_000)} min`
  + (index.missing.length ? `; MISSING ${index.missing.length}: ${index.missing.join(' ')} (run again to fill)` : ''));
