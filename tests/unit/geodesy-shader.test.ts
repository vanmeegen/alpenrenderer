/**
 * Cross-check for the vertex shader's geometry.
 *
 * The shader's maths is mirrored here in JavaScript, evaluated in float32 the
 * way a GPU would, and compared against the double-precision routines the CPU
 * side uses for labels and the horizon test. If these two ever disagree, the
 * outline and the labels sit on different mountains.
 */
import { describe, expect, test } from 'bun:test';
import * as G from '../../src/engine/core/geodesy';

const f = Math.fround;
const D = Math.PI / 180;

/** The WGSL body, term for term, rounded to float32 at every step. */
function shaderOffsets(lat0: number, bearingDeg: number, r: number, R: number) {
  const s0 = f(Math.sin(lat0 * D));
  const c0 = f(Math.cos(lat0 * D));
  const alpha = f(bearingDeg * D);
  const sinA = f(Math.sin(alpha));
  const cosA = f(Math.cos(alpha));
  const delta = f(r / R);
  const sinD = f(Math.sin(delta));
  const cosD = f(Math.cos(delta));
  const hs = f(Math.sin(f(0.5 * delta)));
  const hav = f(hs * hs);
  const ds = f(f(f(c0 * sinD) * cosA) - f(f(2 * s0) * hav));
  const sinP = Math.max(-1, Math.min(1, f(s0 + ds)));
  const dLon = f(Math.atan2(f(f(sinA * sinD) * c0), f(cosD - f(s0 * sinP))));
  const log1p = (x: number) => f(x * f(1 - f(x * f(0.5 - f(x * f(0.3333333
    - f(x * f(0.25 - f(x * f(0.2 - f(x * 0.1666667)))))))))));
  const dIso = f(0.5 * f(log1p(f(ds / f(1 + s0))) - log1p(f(-ds / f(1 - s0)))));
  return { dLon, dIso, sinD, hav };
}

const lat0 = 45.98333, lon0 = 7.78472;
const R = G.localRadius(lat0);
const isoRef = G.isometricLat(lat0);

describe('shader geometry vs reference geodesy', () => {
  const bearings = [0, 17, 45, 91, 134, 180, 226, 271, 315, 359];
  const ranges = [10, 100, 1000, 8000, 30000, 120000, 270000];

  test('destination offsets agree to well under a metre out to 270 km', () => {
    let worstPos = 0;
    for (const b of bearings) {
      for (const r of ranges) {
        const ref = G.destination(lon0, lat0, b, r, R);
        const sh = shaderOffsets(lat0, b, r, R);
        const lonErr = Math.abs((sh.dLon / D) - (ref.lon - lon0)) * D * R * Math.cos(lat0 * D);
        const isoErr = Math.abs(sh.dIso - (G.isometricLat(ref.lat) - isoRef)) * R * Math.cos(lat0 * D);
        worstPos = Math.max(worstPos, Math.hypot(lonErr, isoErr));
      }
    }
    expect(worstPos).toBeLessThan(0.5);
  });

  test('clipmap pixel positions agree to a hundredth of a pixel at zoom 12', () => {
    const pxPerRad = (G.MERC_PX * 2 ** 12) / (2 * Math.PI);
    let worstPx = 0;
    for (const b of bearings) {
      for (const r of ranges) {
        const ref = G.destination(lon0, lat0, b, r, R);
        const sh = shaderOffsets(lat0, b, r, R);
        const du = (sh.dLon - (ref.lon - lon0) * D) * pxPerRad;
        const dv = (sh.dIso - (G.isometricLat(ref.lat) - isoRef)) * pxPerRad;
        worstPx = Math.max(worstPx, Math.hypot(du, dv));
      }
    }
    expect(worstPx).toBeLessThan(0.01);
  });

  test('the curvature drop term matches curvatureDrop()', () => {
    const rEff = G.effectiveRadiusAt(lat0);
    for (const r of ranges) {
      const s = f(Math.sin(f(r / f(2 * rEff))));
      const drop = f(f(2 * rEff) * f(s * s));
      expect(Math.abs(drop - G.curvatureDrop(r, R))).toBeLessThan(0.05);
    }
  });
});

describe('geodesy basics', () => {
  test('MERC_PX is the 256-px pixel grid', () => {
    expect(G.MERC_PX).toBe(256);
    expect(G.lonToMercX(0, 0)).toBe(128);
    expect(G.mercXToLon(G.lonToMercX(7.5, 12), 12)).toBeCloseTo(7.5, 9);
    expect(G.mercYToLat(G.latToMercY(46.5, 12), 12)).toBeCloseTo(46.5, 9);
  });

  test('resolution halves per zoom and scales with cos(lat)', () => {
    expect(G.mercResolution(0, 0)).toBeCloseTo(156543.03, 1);
    expect(G.mercResolution(60, 1) / G.mercResolution(0, 1)).toBeCloseTo(0.5, 6);
  });

  test('refraction lifts a distant summit by inflating the radius', () => {
    expect(G.effectiveRadius(0.13)).toBeCloseTo(G.R_MEAN / 0.87, 3);
    const noRefr = G.curvatureDrop(200000, G.R_MEAN, 0);
    const withRefr = G.curvatureDrop(200000, G.R_MEAN, 0.13);
    expect(noRefr).toBeGreaterThan(withRefr);
    expect(noRefr).toBeCloseTo(3139, -1);
  });
});
