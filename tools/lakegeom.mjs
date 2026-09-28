/**
 * Geometry for the lake catalogue build: closed rings from OSM segments,
 * area, a lighter shore, and a label point on open water. Plain ES module,
 * run by node in tools/build_lakes.mjs and unit-tested in
 * tests/unit/lakegeom.test.ts. Coordinates are flat lon,lat lists.
 */

const M_LAT = 111320;
const mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

const key = (p) => `${p[0]},${p[1]}`;

/**
 * Closed rings from way geometries ({lon, lat} lists). Closed ways stand on
 * their own; open ones are chained end to end, reversed where needed. A
 * chain that never closes (a member missing from the extract) is dropped.
 */
export function assembleRings(ways) {
  const open = [];
  const rings = [];
  for (const w of ways) {
    const pts = w.map((p) => [p.lon, p.lat]);
    if (pts.length < 2) continue;
    if (key(pts[0]) === key(pts[pts.length - 1])) {
      if (pts.length >= 4) rings.push(pts.slice(0, -1));
    } else open.push(pts);
  }
  while (open.length) {
    let chain = open.shift();
    let grown = true;
    while (key(chain[0]) !== key(chain[chain.length - 1]) && grown) {
      grown = false;
      const end = key(chain[chain.length - 1]);
      for (let i = 0; i < open.length; i++) {
        const s = open[i];
        if (key(s[0]) === end) chain = chain.concat(s.slice(1));
        else if (key(s[s.length - 1]) === end) chain = chain.concat(s.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (key(chain[0]) === key(chain[chain.length - 1]) && chain.length >= 4) rings.push(chain.slice(0, -1));
  }
  return rings.map((r) => r.flat());
}

/** Area of a ring, square metres (local flat projection; fine for a lake). */
export function ringArea(ring) {
  const n = ring.length / 2;
  const lat0 = ring[1], kx = mLon(lat0);
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (ring[2 * j] * kx) * (ring[2 * i + 1] * M_LAT) - (ring[2 * i] * kx) * (ring[2 * j + 1] * M_LAT);
  }
  return Math.abs(a) / 2;
}

/** Douglas–Peucker on a closed ring, tolerance in metres; keeps at least a triangle. */
export function simplifyRing(ring, tolM) {
  const n = ring.length / 2;
  if (n <= 3) return ring.slice();
  const kx = mLon(ring[1]);
  const x = (i) => ring[2 * i] * kx, y = (i) => ring[2 * i + 1] * M_LAT;
  const dist = (i, a, b) => {
    const dx = x(b) - x(a), dy = y(b) - y(a);
    const len = Math.hypot(dx, dy);
    if (len === 0) return Math.hypot(x(i) - x(a), y(i) - y(a));
    return Math.abs(dx * (y(a) - y(i)) - dy * (x(a) - x(i))) / len;
  };
  // Split the ring at the vertex farthest from the first one.
  let far = 1, best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(x(i) - x(0), y(i) - y(0));
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]];            // n stands for vertex 0 again
  const idx = (i) => i % n;
  while (stack.length) {
    const [a, b] = stack.pop();
    let m = -1, md = -1;
    for (let i = a + 1; i < b; i++) {
      const d = dist(idx(i), idx(a), idx(b));
      if (d > md) { md = d; m = i; }
    }
    if (m >= 0 && md > tolM) {
      keep[idx(m)] = 1;
      stack.push([a, m], [m, b]);
    }
  }
  let out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[2 * i], ring[2 * i + 1]);
  if (out.length / 2 < 3) {
    // Tolerance ate the ring: keep the first vertex, the farthest, and the one farthest from both.
    let third = -1, td = -1;
    for (let i = 0; i < n; i++) {
      const d = dist(i, 0, far);
      if (d > td && i !== 0 && i !== far) { td = d; third = i; }
    }
    out = [0, far, third].sort((p, q) => p - q).flatMap((i) => [ring[2 * i], ring[2 * i + 1]]);
  }
  return out;
}

function inside(rings, lon, lat) {
  let c = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function shoreDistance(rings, lon, lat, kx) {
  let best = Infinity;
  const px = lon * kx, py = lat * M_LAT;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[2 * j] * kx, ay = r[2 * j + 1] * M_LAT, bx = r[2 * i] * kx, by = r[2 * i + 1] * M_LAT;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * A label point on open water: the grid point farthest from any shore,
 * refined twice around the best one. Where a centroid would land in a bay
 * or on an island, this stays on the lake.
 */
export function labelPoint(rings) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]);
      minY = Math.min(minY, r[i + 1]); maxY = Math.max(maxY, r[i + 1]);
    }
  }
  const kx = mLon((minY + maxY) / 2);
  let best = { lon: (minX + maxX) / 2, lat: (minY + maxY) / 2, d: -1 };
  let cx = best.lon, cy = best.lat, sx = (maxX - minX) / 2, sy = (maxY - minY) / 2;
  const N = 24;
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const lon = cx - sx + (2 * sx * i) / N, lat = cy - sy + (2 * sy * j) / N;
        if (!inside(rings, lon, lat)) continue;
        const d = shoreDistance(rings, lon, lat, kx);
        if (d > best.d) best = { lon, lat, d };
      }
    }
    cx = best.lon; cy = best.lat; sx /= N / 4; sy /= N / 4;
  }
  return { lon: best.lon, lat: best.lat };
}
