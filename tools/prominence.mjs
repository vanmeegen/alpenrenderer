/**
 * Topographic prominence of every summit in a height grid, for the summit
 * catalogue build (build_prominence.mjs). Plain ES module, shared with the
 * unit tests.
 *
 * Prominence (Schartenhöhe) is the drop from a summit to its key col: the
 * highest saddle from which higher ground can be reached. Cells are visited
 * from the highest down and joined to their visited neighbours with a
 * union-find. Each region remembers its highest cell. When a cell joins two
 * regions, the lower region's summit has met higher ground for the first
 * time, and at the highest possible saddle, because every higher cell was
 * visited before: that cell's height is its key col. The highest cell of
 * the grid never meets higher ground and counts its height.
 */

/**
 * Prominence per cell as a Float32Array: NaN where the cell is no summit,
 * the drop in metres where it is. A flat top is one summit; one of its cells
 * carries the value, the others NaN. `heights` are whole metres.
 */
export function prominence(heights, w, h) {
  const n = w * h;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = heights[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Counting sort by height, highest first.
  const span = max - min + 1;
  const counts = new Int32Array(span + 1);
  for (let i = 0; i < n; i++) counts[max - heights[i] + 1]++;
  for (let k = 1; k <= span; k++) counts[k] += counts[k - 1];
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[counts[max - heights[i]]++] = i;

  const parent = new Int32Array(n).fill(-1);   // -1: not visited yet
  const peak = new Int32Array(n);              // for a root: the region's highest cell
  const prom = new Float32Array(n).fill(NaN);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };

  for (let k = 0; k < n; k++) {
    const i = order[k];
    parent[i] = i;
    peak[i] = i;
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((!dx && !dy) || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (parent[j] < 0) continue;
        const ri = find(i), rj = find(j);
        if (ri === rj) continue;
        // The older region keeps its summit on a tie, so a flat top settles on its first cell.
        const [hi, lo] = heights[peak[rj]] >= heights[peak[ri]] ? [rj, ri] : [ri, rj];
        const drop = heights[peak[lo]] - heights[i];
        prom[peak[lo]] = drop > 0 ? drop : NaN;
        parent[lo] = hi;
      }
    }
  }
  for (let i = 0; i < n; i++) if (parent[i] === i) prom[peak[i]] = heights[peak[i]];
  return prom;
}

/**
 * The prominence a catalogue point at grid position (x, y) names: that of
 * the highest cell within `radius` cells (the summit the point stands for,
 * which the grid may hold a cell away). Undefined when no summit is in
 * reach: the point is on a slope of this grid.
 */
export function summitProminence(heights, prom, w, h, x, y, radius) {
  const r = Math.ceil(radius);
  let best = -Infinity, bestProm;
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w || dx * dx + dy * dy > radius * radius) continue;
      const i = yy * w + xx;
      const hv = heights[i];
      if (hv > best || (hv === best && Number.isNaN(bestProm) && !Number.isNaN(prom[i]))) {
        best = hv;
        bestProm = prom[i];
      }
    }
  }
  return bestProm === undefined || Number.isNaN(bestProm) ? undefined : bestProm;
}

/**
 * The catalogue's surveyed heights burned into the grid: a copy of `heights`
 * where each listed cell (x, y, ele) is raised to `ele` when the grid holds
 * less. A coarse grid rounds a sharp summit off more than a broad one and
 * can hand a massif's prominence to the lower of two neighbours; with the
 * surveyed heights in place the order between summits is the surveyed one,
 * and each catalogue point is the highest cell at its own position.
 */
export function burn(heights, w, h, cells) {
  const out = heights.slice();
  for (const [x, y, ele] of cells) {
    if (x < 0 || y < 0 || x >= w || y >= h || !Number.isFinite(ele)) continue;
    const i = y * w + x;
    if (ele > out[i]) out[i] = ele;
  }
  return out;
}
