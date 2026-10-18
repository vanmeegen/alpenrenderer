/**
 * The shading formula in TypeScript, the reference the shaders and the E2E
 * pixel tests share.
 */
import { describe, expect, test } from 'bun:test';
import { FOG_RANGE, HORIZON_COLOR, SUN, WATER_COLOR, luminance, shadeFactor, sunAzimuth, sunVector, terrainColor } from '../../src/engine/render/shading';

describe('terrainColor', () => {
  test('water takes the lake colour under the same sun and the same haze as the ground', () => {
    const up: [number, number, number] = [0, 0, 1];
    const range = 2000;
    const shade = shadeFactor(sunVector()[2]);
    const fog = (1 - Math.exp(-range / FOG_RANGE)) * 0.88;
    const want = WATER_COLOR.map((c, i) => c * shade + (HORIZON_COLOR[i] - c * shade) * fog);
    const got = terrainColor(1500, up, range, true);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 6);
    // Blue, and clearly not the meadow the same flat would be.
    expect(got[2]).toBeGreaterThan(got[1]);
    expect(got[1]).toBeGreaterThan(got[0]);
    const dry = terrainColor(1500, up, range);
    expect(dry[1]).toBeGreaterThan(dry[2]);
  });
});

describe('water shine: a little sky reflection and a sun glint, nothing that costs a pass', () => {
  const up: [number, number, number] = [0, 0, 1];
  const DEG = Math.PI / 180;
  /** Unit view vector from the eye down onto the water: bearing and depression in degrees. */
  const look = (bearing: number, down: number): [number, number, number] =>
    [Math.sin(bearing * DEG) * Math.cos(down * DEG), Math.cos(bearing * DEG) * Math.cos(down * DEG), -Math.sin(down * DEG)];
  const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const away = sunAzimuth(0) + 180;

  test('seen from straight above, the lake is its own blue, barely touched', () => {
    const plain = terrainColor(1500, up, 2000, true);
    const top = terrainColor(1500, up, 2000, true, [0, 0, -1]);
    expect(Math.abs(lum(top) - lum(plain))).toBeLessThan(0.02);
    expect(top[2]).toBeGreaterThan(top[1]);
  });

  test('at a grazing angle it takes on the sky (Fresnel), but stays a lake, not a mirror', () => {
    const steep = terrainColor(1500, up, 2000, true, look(away, 40));
    const grazing = terrainColor(1500, up, 2000, true, look(away, 3));
    expect(lum(grazing)).toBeGreaterThan(lum(steep) + 0.15);
    expect(lum(grazing)).toBeLessThan(lum(HORIZON_COLOR));
    expect(grazing[2]).toBeGreaterThan(grazing[0]);
  });

  test('where the sun mirrors in the water there is a glint, bounded, and none away from it', () => {
    const glint = terrainColor(1500, up, 2000, true, look(sunAzimuth(0), SUN.elevation));
    const beside = terrainColor(1500, up, 2000, true, look(sunAzimuth(0) + 40, SUN.elevation));
    const behind = terrainColor(1500, up, 2000, true, look(away, SUN.elevation));
    expect(lum(glint)).toBeGreaterThan(lum(behind) + 0.2);
    expect(Math.abs(lum(beside) - lum(behind))).toBeLessThan(0.02);
    for (const c of glint) expect(c).toBeLessThanOrEqual(1);
  });

  test('dry ground ignores the view', () => {
    expect(terrainColor(1500, up, 2000, false, look(SUN.azimuth, SUN.elevation))).toEqual(terrainColor(1500, up, 2000));
  });

  test('the light stands behind the viewer\'s left shoulder, 45° up, wherever they look (Imhof\'s convention, turned with the view)', () => {
    // Looking east (yaw 90) the sun is in the north-west: the north-west flank
    // of a cone is fully lit, the south-west one half, the east one in shadow.
    expect(sunAzimuth(90)).toBe(315);
    expect(sunAzimuth(0)).toBe(225);
    const s = sunVector(90);
    expect(s[0]).toBeCloseTo(-0.5, 6);
    expect(s[1]).toBeCloseTo(0.5, 6);
    expect(s[2]).toBeCloseTo(Math.SQRT1_2, 6);
    const nw: [number, number, number] = [-0.5, 0.5, Math.SQRT1_2];
    const sw: [number, number, number] = [-0.5, -0.5, Math.SQRT1_2];
    const e: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const lum = (n: [number, number, number]) => luminance(terrainColor(2500, n, 5000, false, undefined, 90));
    expect(lum(nw)).toBeGreaterThan(lum(sw) * 1.3);
    expect(lum(sw)).toBeGreaterThan(lum(e) * 1.3);
    // Turned to the north, the same relief is lit from the south-west instead.
    expect(luminance(terrainColor(2500, sw, 5000, false, undefined, 0))).toBeGreaterThan(luminance(terrainColor(2500, nw, 5000, false, undefined, 0)));
  });
});
