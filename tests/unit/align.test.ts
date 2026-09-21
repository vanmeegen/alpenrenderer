/**
 * Characterisation of the skyline alignment from peakviewer (port of
 * tools/check_align.mjs): a synthetic world of Gaussian peaks, a frame
 * rendered from a known pose with the brightness cue deliberately unhelpful
 * (snow brighter than the sky), and the matcher told a wrong pose. It must
 * recover the difference, and decline when the frame cannot support a match.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALIGN, DEFAULT_PROFILE, HorizonProfile, PHOTO_SKYLINE, alignPhoto, extractSkyline, horizonProfile, matchSkyline, profileAt,
} from '../../src/engine/core/align';
import { HeightField } from '../../src/engine/core/heightfield';

const DEG = Math.PI / 180;
const OBS = { lon: 7.7845, lat: 45.9835 };
const PEAKS = [
  { bear: 5, km: 9.0, top: 3600, sig: 0.9 },
  { bear: 18, km: 14.0, top: 4100, sig: 1.6 },
  { bear: 33, km: 7.5, top: 2900, sig: 0.7 },
  { bear: 47, km: 18.0, top: 3900, sig: 2.0 },
  { bear: -14, km: 11.0, top: 3300, sig: 1.1 },
  { bear: -28, km: 6.0, top: 2600, sig: 0.8 },
];
const FLOOR = 1500;

function heightAt(lon: number, lat: number): number {
  const dx = (lon - OBS.lon) * 111.32 * Math.cos(lat * DEG);
  const dy = (lat - OBS.lat) * 111.32;
  let h = FLOOR;
  for (const p of PEAKS) {
    const px = p.km * Math.sin(p.bear * DEG), py = p.km * Math.cos(p.bear * DEG);
    const d2 = (dx - px) ** 2 + (dy - py) ** 2;
    h = Math.max(h, FLOOR + (p.top - FLOOR) * Math.exp(-d2 / (2 * p.sig ** 2)));
  }
  return h;
}

function makeField(z: number, size: number): HeightField {
  const hf = new HeightField(OBS.lon, OBS.lat);
  const n = 256 * (1 << z);
  const cx = ((OBS.lon + 180) / 360) * n;
  const s = Math.sin(OBS.lat * DEG);
  const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const px0 = Math.round(cx - size / 2), py0 = Math.round(cy - size / 2);
  const raw = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lon = ((px0 + x + 0.5) / n) * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (py0 + y + 0.5) / n))) / DEG;
      raw[y * size + x] = Math.round(heightAt(lon, lat) + 1000);
    }
  }
  hf.addLevel({ z, px0, py0, w: size, h: size, quant: 1, bias: -1000 }, raw);
  return hf;
}

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

interface Pose { yaw: number; pitch: number; roll: number; fovY: number }

/** What a camera at this pose sees: textured terrain below the model skyline, smooth sky above. */
function renderFrame(profile: HorizonProfile, pose: Pose, w: number, h: number, opts: { snow?: boolean; fogTop?: number } = {}) {
  const { snow = true, fogTop = 0 } = opts;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const tanY = Math.tan(pose.fovY * DEG / 2), tanX = tanY * (w / h);
  const cy = Math.cos(pose.yaw * DEG), sy = Math.sin(pose.yaw * DEG);
  const cp = Math.cos(pose.pitch * DEG), sp = Math.sin(pose.pitch * DEG);
  const cr = Math.cos(pose.roll * DEG), sr = Math.sin(pose.roll * DEG);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = ((px + 0.5) / w) * 2 - 1, v = 1 - ((py + 0.5) / h) * 2;
      const cx0 = u * tanX, cz0 = v * tanY;
      const cxr = cx0 * cr - cz0 * sr, czr = cx0 * sr + cz0 * cr;
      const ry = cp - czr * sp, rz = sp + czr * cp;
      const east = cxr * cy + ry * sy, north = -cxr * sy + ry * cy;
      const bearing = Math.atan2(east, north) / DEG;
      const elev = Math.atan2(rz, Math.hypot(east, north)) / DEG;
      const model = profileAt(profile, bearing);
      const isSky = Number.isNaN(model) || elev > model;
      let lum: number;
      if (isSky) {
        lum = 148 + 42 * (1 - py / h) + 2 * (rnd() - 0.5);
      } else {
        const depth = Math.max(0, model - elev);
        const base = snow && depth < 2.2 ? 205 : 96;
        lum = base + 46 * (rnd() - 0.5) + 26 * Math.sin(px * 0.7) * Math.cos(py * 0.5);
      }
      if (fogTop > 0 && py < h * fogTop) lum = 170 + 2 * (rnd() - 0.5);
      const i = (py * w + px) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.max(0, Math.min(255, lum));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const hf = makeField(10, 512);
const eye = hf.groundAt(OBS.lon, OBS.lat) + 2;
const TRUE: Pose = { yaw: 20, pitch: 8, roll: 0, fovY: 51 };
const W = 640, H = 480;
const profile = horizonProfile(hf, eye, { ...DEFAULT_PROFILE, from: TRUE.yaw - 100, span: 200 });
const frame = renderFrame(profile, TRUE, W, H);
const sky = extractSkyline(frame, W, H);

/** The boundary row the fixture drew, in working-image coordinates. */
function trueRow(pose: Pose, w: number, h: number, col: number): number {
  const tanY = Math.tan(pose.fovY * DEG / 2), tanX = tanY * (W / H);
  const cy = Math.cos(pose.yaw * DEG), sy = Math.sin(pose.yaw * DEG);
  const cp = Math.cos(pose.pitch * DEG), sp = Math.sin(pose.pitch * DEG);
  const u = ((col + 0.5) / w) * 2 - 1;
  for (let y = 0; y < h; y++) {
    const v = 1 - ((y + 0.5) / h) * 2;
    const cxr = u * tanX, czr = v * tanY;
    const ry = cp - czr * sp, rz = sp + czr * cp;
    const east = cxr * cy + ry * sy, north = -cxr * sy + ry * cy;
    const model = profileAt(profile, Math.atan2(east, north) / DEG);
    if (!Number.isNaN(model) && Math.atan2(rz, Math.hypot(east, north)) / DEG <= model) return y;
  }
  return NaN;
}

describe('extractSkyline', () => {
  test('finds the drawn boundary to within a pixel in most columns, despite snow brighter than the sky', () => {
    expect(sky.coverage).toBeGreaterThan(0.8);
    const errs: number[] = [];
    for (let x = 0; x < sky.width; x++) {
      const t = trueRow(TRUE, sky.width, sky.height, x);
      if (!Number.isNaN(t) && sky.strength[x] > 0.05) errs.push(sky.row[x] - t);
    }
    errs.sort((a, b) => a - b);
    const med = errs[errs.length >> 1];
    expect(Math.abs(med)).toBeLessThan(1.5);
    expect(errs[(errs.length * 0.9) | 0] - errs[(errs.length * 0.1) | 0]).toBeLessThan(6);
  });
});

describe('matchSkyline', () => {
  for (const [eYaw, ePitch] of [[0, 0], [4, 0], [-6.5, 0], [0, 2.5], [3.2, -1.8], [-9, 3]]) {
    test(`recovers a pose error of ${eYaw}° yaw / ${ePitch}° pitch`, () => {
      const believed = { ...TRUE, yaw: TRUE.yaw + eYaw, pitch: TRUE.pitch + ePitch, aspect: W / H };
      const r = matchSkyline(sky, profile, believed);
      expect(r.ok).toBe(true);
      // Yaw is fixed by the shape of the skyline; pitch inherits the
      // extractor's row accuracy, so it is the looser of the two.
      expect(Math.abs(r.dYaw + eYaw)).toBeLessThan(0.35);
      expect(Math.abs(r.dPitch + ePitch)).toBeLessThan(0.8);
    });
  }

  test('declines a frame that is entirely fog', () => {
    const fog = extractSkyline(renderFrame(profile, TRUE, W, H, { fogTop: 1 }), W, H);
    expect(matchSkyline(fog, profile, { ...TRUE, aspect: W / H }).ok).toBe(false);
  });

  test('declines, or pitches far off, a skyline from 2.6 km higher up', () => {
    const elsewhere = horizonProfile(hf, eye + 2600, { ...DEFAULT_PROFILE, from: TRUE.yaw - 100, span: 200 });
    const wrong = extractSkyline(renderFrame(elsewhere, TRUE, W, H), W, H);
    const r = matchSkyline(wrong, profile, { ...TRUE, aspect: W / H });
    expect(!r.ok || Math.abs(r.dPitch) > 1).toBe(true);
  });

  test('five noise seeds agree within a third of a degree', () => {
    const spread: number[] = [];
    for (let i = 0; i < 5; i++) {
      seed = 999 + i * 7919;
      const s = extractSkyline(renderFrame(profile, TRUE, W, H), W, H);
      spread.push(matchSkyline(s, profile, { ...TRUE, yaw: TRUE.yaw + 5, aspect: W / H }).dYaw);
    }
    const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
    expect(Math.max(...spread.map((v) => Math.abs(v - mean)))).toBeLessThan(0.3);
    expect(mean).toBeCloseTo(-5, 0);
  });
});

describe('matchSkyline with roll and field of view unknown (photos)', () => {
  // Photos are matched on a larger working image than the live view: at the
  // default 192 px the ridge detail that pins the roll is lost at the edges.
  const ROLLED: Pose = { ...TRUE, roll: 3 };
  const rolledSky = extractSkyline(renderFrame(profile, ROLLED, W, H), W, H, PHOTO_SKYLINE);

  test('a rolled photo is matched by searching the roll too', () => {
    const believed = { ...ROLLED, roll: 0, yaw: TRUE.yaw + 2, aspect: W / H };
    const r = matchSkyline(rolledSky, profile, believed, { ...DEFAULT_ALIGN, rollRange: 6, rollStep: 0.5 });
    expect(r.ok).toBe(true);
    expect(Math.abs(r.dRoll - 3)).toBeLessThan(0.6);
    expect(Math.abs(r.dYaw + 2)).toBeLessThan(0.5);
  });

  test('without a roll search the same photo fits worse', () => {
    const believed = { ...ROLLED, roll: 0, yaw: TRUE.yaw + 2, aspect: W / H };
    const flat = matchSkyline(rolledSky, profile, believed);
    const rolled = matchSkyline(rolledSky, profile, believed, { ...DEFAULT_ALIGN, rollRange: 6, rollStep: 0.5 });
    expect(rolled.fit).toBeGreaterThan(flat.fit + 0.05);
  });

  test('a photo with an unknown lens: the field of view is searched from 30° to 80°', () => {
    const believed = { ...TRUE, fovY: 60, yaw: TRUE.yaw + 3, aspect: W / H };
    const r = matchSkyline(sky, profile, believed, { ...DEFAULT_ALIGN, fovRange: [30, 80], fovStep: 3 });
    expect(r.ok).toBe(true);
    expect(Math.abs(r.fovY - TRUE.fovY)).toBeLessThan(3);
    expect(Math.abs(r.dYaw + 3)).toBeLessThan(0.5);
  });

  test('with the lens known the result carries it unchanged and no roll', () => {
    const r = matchSkyline(sky, profile, { ...TRUE, aspect: W / H });
    expect(r.fovY).toBe(TRUE.fovY);
    expect(r.dRoll).toBe(0);
  });
});

describe('alignPhoto: the staged search for a photo', () => {
  // Yaw and pitch first, then the roll, then the lens when unknown, then yaw
  // and pitch again: a few hundred evaluations instead of a full 4-D grid.
  const TILTED: Pose = { ...TRUE, roll: -2.5 };
  const tiltedSky = extractSkyline(renderFrame(profile, TILTED, W, H), W, H, PHOTO_SKYLINE);

  test('with the lens known: yaw, pitch and roll within tolerance, in under two seconds', () => {
    const t0 = performance.now();
    const r = alignPhoto(tiltedSky, profile, { ...TILTED, roll: 0, yaw: TRUE.yaw + 5, pitch: TRUE.pitch - 1.5, aspect: W / H }, true);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.dYaw + 5)).toBeLessThan(0.5);
    expect(Math.abs(r.dPitch - 1.5)).toBeLessThan(0.8);
    expect(Math.abs(r.dRoll + 2.5)).toBeLessThan(0.6);
    expect(r.fovY).toBe(TRUE.fovY);
  });

  test('with the lens unknown: the field of view is found too', () => {
    const r = alignPhoto(tiltedSky, profile, { ...TILTED, roll: 0, fovY: 65, yaw: TRUE.yaw + 5, aspect: W / H }, false);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.fovY - TRUE.fovY)).toBeLessThan(3);
    expect(Math.abs(r.dYaw + 5)).toBeLessThan(0.6);
    expect(Math.abs(r.dRoll + 2.5)).toBeLessThan(0.8);
  });

  test('declines fog like the plain match does', () => {
    const fog = extractSkyline(renderFrame(profile, TRUE, W, H, { fogTop: 1 }), W, H, PHOTO_SKYLINE);
    expect(alignPhoto(fog, profile, { ...TRUE, aspect: W / H }, true).ok).toBe(false);
  });
});
