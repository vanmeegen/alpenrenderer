#!/usr/bin/env node
/**
 * Builds the static summit catalogue: every named `natural=peak` node in the
 * Alps from OpenStreetMap via Overpass, one JSON file per 1°×1° cell in
 * public/peaks/, in the compact record format src/engine/sources/peakcatalog.ts
 * reads. Run by hand (or the "Build peak catalogue" workflow) and committed;
 * the app never talks to Overpass itself.
 *
 *   node tools/build_peaks.mjs [--bbox 5,43,17,49] [--out public/peaks]
 *
 * Data © OpenStreetMap contributors, ODbL.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter((x) => x.length));
const [W, S, E, N] = (args.bbox ?? '5,43,17,49').split(',').map(Number);
const out = args.out ?? 'public/peaks';
mkdirSync(out, { recursive: true });

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = 'Mozilla/5.0 (compatible; alpenrenderer-build/0.1; +https://github.com/vanmeegen/alpenrenderer)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (s) => {
  if (!s) return undefined;
  const v = parseFloat(String(s).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(v) ? Math.round(v) : undefined;
};

/** One cell, with retries across endpoints: the public servers answer 429/504 under load. */
async function fetchCell(x, y) {
  const q = `[out:json][timeout:120];node["natural"="peak"]["name"](${y},${x},${y + 1},${x + 1});out body;`;
  let attempt = 0;
  for (;;) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text).elements;
      throw new Error(`HTTP ${res.status}: ${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`);
    } catch (e) {
      attempt++;
      if (attempt > 8) throw e;
      const wait = Math.min(120_000, 5000 * 2 ** attempt);
      console.error(`  ${x}_${y}: ${e.message} — retry ${attempt} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

function toRecord(e) {
  const t = e.tags ?? {};
  const name = t.name ?? t['name:de'] ?? t['name:it'] ?? t['name:fr'] ?? t['name:sl'];
  if (!name || e.lat === undefined) return null;
  const r = { i: e.id, n: name, o: +e.lon.toFixed(5), a: +e.lat.toFixed(5) };
  const ele = num(t.ele ?? t['ele:m']);
  if (ele !== undefined && ele > 0 && ele < 5000) r.e = ele;
  const prom = num(t.prominence ?? t['prominence:m']);
  if (prom !== undefined && prom > 0) r.p = prom;
  if (t.wikidata) r.w = t.wikidata;
  if (t.wikipedia) r.k = t.wikipedia;
  return r;
}

const index = { generated: new Date().toISOString(), source: 'OpenStreetMap via Overpass, natural=peak with name', license: 'ODbL 1.0', bbox: [W, S, E, N], cells: {} };
let total = 0;
for (let y = S; y < N; y++) {
  for (let x = W; x < E; x++) {
    const file = join(out, `${x}_${y}.json`);
    if (args.resume && existsSync(file)) {
      const n = JSON.parse(readFileSync(file, 'utf8')).length;
      index.cells[`${x}_${y}`] = n; total += n;
      continue;
    }
    const elements = await fetchCell(x, y);
    const records = elements.map(toRecord).filter(Boolean).sort((a, b) => (b.e ?? 0) - (a.e ?? 0));
    if (records.length) writeFileSync(file, JSON.stringify(records));
    index.cells[`${x}_${y}`] = records.length;
    total += records.length;
    console.error(`${x}_${y}: ${records.length}`);
    await sleep(1500);
  }
}
index.total = total;
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
console.error(`${total} summits in ${Object.values(index.cells).filter(Boolean).length} cells -> ${out}`);
