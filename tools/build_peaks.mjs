#!/usr/bin/env node
/**
 * Builds the static summit catalogue: every named `natural=peak` node in the
 * Alps from OpenStreetMap via Overpass, one JSON file per 1°×1° cell in
 * public/peaks/, in the compact record format src/engine/sources/peakcatalog.ts
 * reads. Run by hand (or the "Build peak catalogue" workflow) and committed;
 * the app never talks to Overpass itself.
 *
 *   node tools/build_peaks.mjs [--bbox 5,43,17,49] [--out public/peaks] [--refresh] [--cells 10_47,11_47] [--budget-minutes 100]
 *
 * Cells that already exist in --out are kept unless --refresh is given, so a
 * run that the public servers cut short can simply be repeated. A cell that
 * fails every attempt is listed as missing in index.json and the run goes on:
 * a catalogue with a gap is worth more than none, and the next run fills it.
 * The time budget stops the run before a CI job limit would kill it and lose
 * everything fetched so far; the rest is marked missing likewise.
 *
 * Overpass treats the declared [timeout] as the price of a request and turns
 * expensive ones away first under load (504 "dispatcher timeout"), so each
 * cell asks for little: a 1° cell holds a few hundred nodes and takes seconds.
 *
 * Data © OpenStreetMap contributors, ODbL.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const [W, S, E, N] = opt('bbox', '5,43,17,49').split(',').map(Number);
const out = opt('out', 'public/peaks');
const only = opt('cells', '') ? new Set(opt('cells', '').split(',')) : null;
const budgetMs = Number(opt('budget-minutes', '100')) * 60_000;
const startedAt = Date.now();
mkdirSync(out, { recursive: true });

// The public servers rate-limit hard and answer 429, 504 or, in front of
// overpass-api.de, a plain 406 from Apache under load; each attempt goes to
// the next one in the ring.
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

/** One cell, with retries across endpoints; null when every attempt failed. */
async function fetchCell(x, y) {
  const q = `[out:json][timeout:25][maxsize:16777216];node["natural"="peak"]["name"](${y},${x},${y + 1},${x + 1});out body;`;
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
      // 429 is the per-IP quota: nothing to do but leave it alone for a while.
      const wait = e.status === 429 ? Math.max(60_000, Math.min(90_000, 5000 * 1.6 ** attempt))
        : Math.min(90_000, 5000 * 1.6 ** attempt);
      console.error(`  ${x}_${y} via ${new URL(ep).host}: ${e.message} — retry ${attempt + 1}/${MAX_ATTEMPTS} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  return null;
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

const index = {
  generated: new Date().toISOString(),
  source: 'OpenStreetMap via Overpass, natural=peak with name',
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
    if (Date.now() - startedAt > budgetMs) {
      index.missing.push(key);
      continue;
    }
    const elements = await fetchCell(x, y);
    if (!elements) {
      index.missing.push(key);
      console.error(`${key}: MISSING (${Date.now() - startedAt > budgetMs ? 'time budget spent' : `${MAX_ATTEMPTS} attempts failed`})`);
      continue;
    }
    const records = elements.map(toRecord).filter(Boolean).sort((a, b) => (b.e ?? 0) - (a.e ?? 0));
    if (records.length) writeFileSync(file, JSON.stringify(records));
    index.cells[key] = records.length;
    total += records.length;
    console.error(`${key}: ${records.length}`);
    await sleep(1500);
  }
}
index.total = total;
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
console.error(`${total} summits in ${Object.values(index.cells).filter(Boolean).length} cells -> ${out}`
  + ` in ${Math.round((Date.now() - startedAt) / 60_000)} min`
  + (index.missing.length ? `; MISSING ${index.missing.length}: ${index.missing.join(' ')} (run again to fill)` : ''));
