/**
 * The shading formula in TypeScript, the reference the shaders and the E2E
 * pixel tests share.
 */
import { describe, expect, test } from 'bun:test';
import { FOG, HORIZON_COLOR, SUN, WATER_COLOR, haze, luminance, shadeFactor, sunAzimuth, sunVector, terrainColor, transmittance } from '../../src/engine/render/shading';

describe('terrainColor', () => {
  test('water takes the lake colour under the same sun and the same haze as the ground', () => {
    const up: [number, number, number] = [0, 0, 1];
    const range = 2000;
    const shade = shadeFactor(sunVector()[2]);
    const want = haze(WATER_COLOR.map((c) => c * shade) as [number, number, number], range, 1500, 1500);
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
    expect(terrainColor(1500, up, 2000, false, look(sunAzimuth(0), SUN.elevation))).toEqual(terrainColor(1500, up, 2000));
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

describe('aerial perspective: haze that lies in the valleys and turns the distance blue', () => {
  const up: [number, number, number] = [0, 0, 1];
  /** How far a colour has gone towards the haze, per channel, 0..1. */
  const towards = (lit: [number, number, number], seen: [number, number, number]) =>
    lit.map((c, i) => (seen[i] - c) / (HORIZON_COLOR[i] - c));

  test('at the same range a valley floor is hazier than a summit: the air is thicker low down', () => {
    const eye = 2000, range = 30000;
    const low = transmittance(range, 600, eye), high = transmittance(range, 3500, eye);
    for (let i = 0; i < 3; i++) expect(low[i]).toBeLessThan(high[i]);
    // Looking along at one's own height, the air is that of the height: e^(-h/H) of sea level's.
    const level = transmittance(range, eye, eye);
    expect(level[0]).toBeCloseTo(Math.exp(-(range / FOG.range) * Math.exp(-eye / FOG.height)), 6);
  });

  test('the distance turns blue: blue goes to the haze first, red last', () => {
    const lit: [number, number, number] = [0.3, 0.3, 0.3];
    const t = towards(lit, haze(lit, 25000, 2000, 2000));
    expect(t[2]).toBeGreaterThan(t[1]);
    expect(t[1]).toBeGreaterThan(t[0]);
    expect(t[2] - t[0]).toBeGreaterThan(0.05);
  });

  test('nothing vanishes into the haze: far ridges keep a floor of their own colour, so the skyline stays a skyline', () => {
    const t = transmittance(400000, 1000, 1000);
    for (const c of t) expect(c).toBe(FOG.floor);
    const near = transmittance(100, 1500, 1500);
    for (const c of near) expect(c).toBeGreaterThan(0.99);
  });

  test('terrainColor takes the eye\'s altitude for the haze; without one the point\'s own', () => {
    const a = terrainColor(1500, up, 20000, false, undefined, 0, 3000);
    const b = terrainColor(1500, up, 20000, false, undefined, 0, 600);
    expect(luminance(a)).toBeLessThan(luminance(b));        // from high up there is less air on the way
    expect(terrainColor(1500, up, 20000)).toEqual(terrainColor(1500, up, 20000, false, undefined, 0, 1500));
  });
});

describe('what the ground is made of, from height and slope alone', () => {
  const DEG = Math.PI / 180;
  /** Unit normal of a face tilted `deg` from the horizontal, facing the light when looking north. */
  const face = (deg: number): [number, number, number] => {
    const s = sunVector(0), hz = Math.hypot(s[0], s[1]);
    return [(s[0] / hz) * Math.sin(deg * DEG), (s[1] / hz) * Math.sin(deg * DEG), Math.cos(deg * DEG)];
  };
  const greenness = (c: [number, number, number]) => c[1] - Math.max(c[0], c[2]);
  const spread = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);

  test('a 45° face at 2000 m is rock, not meadow; a 20° slope there is meadow', () => {
    // The Haidachstellwand read as a green hill: rock only began at 49° and was full at 66°.
    const wall = terrainColor(2000, face(45), 100);
    const slope = terrainColor(2000, face(20), 100);
    expect(greenness(wall)).toBeLessThan(0);
    expect(greenness(slope)).toBeGreaterThan(0.01);
  });

  test('a 55° face at 3500 m is rock, not snow; a 25° slope there is snow', () => {
    // The Matterhorn read as all white: snow only left faces steeper than 63–73°.
    const wall = terrainColor(3500, face(55), 100);
    const field = terrainColor(3500, face(25), 100);
    expect(luminance(field)).toBeGreaterThan(0.8);
    expect(luminance(wall)).toBeLessThan(0.62);
    expect(spread(wall)).toBeLessThan(0.08);
  });
});


describe('occlusion: gullies darker, ridges lighter', () => {
  const n: [number, number, number] = [0, 0, 1];

  test('neutral occlusion is the plain light; a hole is darker and a point lighter by SURFACE.strength', async () => {
    const { SURFACE } = await import('../../src/engine/core/surface');
    const plain = terrainColor(2000, n, 3000, false, undefined, 0, 2000);
    const neutral = terrainColor(2000, n, 3000, false, undefined, 0, 2000, 0.5);
    for (let i = 0; i < 3; i++) expect(neutral[i]).toBeCloseTo(plain[i], 9);
    // Unhazed, the light alone: the factor is 1 ± strength.
    expect(shadeFactor(0.5, 0) / shadeFactor(0.5)).toBeCloseTo(1 - SURFACE.strength, 9);
    expect(shadeFactor(0.5, 1) / shadeFactor(0.5)).toBeCloseTo(1 + SURFACE.strength, 9);
    const gully = terrainColor(2000, n, 3000, false, undefined, 0, 2000, 0.2);
    const ridge = terrainColor(2000, n, 3000, false, undefined, 0, 2000, 0.8);
    expect(luminance(gully)).toBeLessThan(luminance(plain) - 0.02);
    expect(luminance(ridge)).toBeGreaterThan(luminance(plain) + 0.02);
  });
});

describe('the grain of the near ground', () => {
  test('grain changes the light, not what the ground is made of; without fade it changes nothing', async () => {
    const { DETAIL, lit } = await import('../../src/engine/render/detail');
    // A 30° slope at 2000 m, facing east: meadow with some rock, and it must stay that.
    const n: [number, number, number] = [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)];
    const d: [number, number, number] = [0.7, -0.4, 0.8];
    const plain = terrainColor(2000, n, 100, false, undefined, 0, 2000);
    const off = terrainColor(2000, n, 100, false, undefined, 0, 2000, 0.5, { d, fade: 0 });
    for (let i = 0; i < 3; i++) expect(off[i]).toBeCloseTo(plain[i], 9);
    // With it: the colour of the smooth normal, lit by the bumped one, times the grain.
    const g = lit(n, d, 1);
    const s = sunVector(0);
    const want = shadeFactor(g.normal[0] * s[0] + g.normal[1] * s[1] + g.normal[2] * s[2]) * g.grain
      / shadeFactor(n[0] * s[0] + n[1] * s[1] + n[2] * s[2]);
    const on = terrainColor(2000, n, 100, false, undefined, 0, 2000, 0.5, { d, fade: 1 });
    // Range 100 m: the haze takes next to nothing, the ratio is the light's.
    for (let i = 0; i < 3; i++) expect(on[i] / plain[i]).toBeCloseTo(want, 2);
    expect(Math.abs(want - 1)).toBeGreaterThan(0.02);
    expect(DETAIL.grain).toBeLessThan(0.2);
  });
});

describe('land cover: what the ground is, where a survey says so', () => {
  const up: [number, number, number] = [0, 0, 1];
  const at = (h: number, cover: number, n = up) => terrainColor(h, n, 500, false, undefined, 0, h, 0.5, undefined, cover);
  const idx = async (name: string) => (await import('../../src/engine/render/shading')).COVER_CLASSES.indexOf(name as never);

  test('without a class the ground is the height\'s own tint, as before', () => {
    const plain = terrainColor(1500, up, 500, false, undefined, 0, 1500);
    const none = at(1500, 0);
    for (let i = 0; i < 3; i++) expect(none[i]).toBeCloseTo(plain[i], 9);
  });

  test('forest is darker and greener than the meadow beside it; a village is grey; a field lighter than the forest', async () => {
    const forest = at(1000, await idx('tree')), grass = at(1000, await idx('grass')), built = at(1000, await idx('built')), crop = at(1000, await idx('crop'));
    expect(luminance(forest)).toBeLessThan(luminance(grass) - 0.05);
    expect(forest[1]).toBeGreaterThan(forest[0] * 1.3);                 // green
    expect(Math.abs(built[0] - built[1])).toBeLessThan(0.04);           // grey
    expect(luminance(crop)).toBeGreaterThan(luminance(forest) + 0.1);
  });

  test('grass turns from valley green to the paler alpine meadow with height', async () => {
    const g = await idx('grass');
    const low = at(800, g), high = at(2300, g);
    expect(high[0] / high[1]).toBeGreaterThan(low[0] / low[1] + 0.1);   // less green, more yellow
  });

  test('ice is white well below the snow line, where the height alone would paint meadow; a steep icefall shows rock', async () => {
    const ice = await idx('snow');
    const glacier = at(2300, ice), meadow = at(2300, 0);
    expect(luminance(glacier)).toBeGreaterThan(luminance(meadow) + 0.2);
    const steep: [number, number, number] = [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];
    const fall = terrainColor(2300, steep, 500, false, undefined, 90, 2300, 0.5, undefined, ice);
    const flat = terrainColor(2300, up, 500, false, undefined, 90, 2300, 0.5, undefined, ice);
    expect(fall[2] / fall[0]).toBeLessThan(flat[2] / flat[0]);          // rock is warmer than ice
  });

  test('above the snow line the survey decides: ice is white, ground it calls bare keeps only a share of the height\'s snow, ground without a class all of it', async () => {
    const { COVER } = await import('../../src/engine/render/shading');
    const bare = await idx('bare'), ice = await idx('snow');
    const rock = at(3300, bare), glacier = at(3300, ice), unknown = at(3300, 0), lowRock = at(2400, bare);
    expect(luminance(rock)).toBeLessThan(luminance(glacier) - 0.15);     // the Gornergrat is not a snowfield
    expect(luminance(rock)).toBeGreaterThan(luminance(lowRock) + 0.02);  // but lighter than rock below the line
    expect(luminance(unknown)).toBeGreaterThan(luminance(rock) + 0.15);  // no survey: the height's snow, as before
    expect(COVER.snowOnLand).toBeGreaterThan(0.1);
    expect(COVER.snowOnLand).toBeLessThan(0.5);
  });

  test('the water class is the lake\'s colour: rivers and lakes the catalogue does not name', async () => {
    const w = at(600, await idx('water'));
    expect(w[2]).toBeGreaterThan(w[1]);
    expect(w[1]).toBeGreaterThan(w[0]);
  });

  test('bare ground is rock at any height, and a class the palette does not know changes nothing', async () => {
    const bare = at(900, await idx('bare')), rockHigh = at(2400, 0);
    // The same grey: rock is what the height's tint ends in.
    expect(Math.abs(bare[0] / bare[1] - rockHigh[0] / rockHigh[1])).toBeLessThan(0.03);
    const odd = at(1500, 15), none = at(1500, 0);
    for (let i = 0; i < 3; i++) expect(odd[i]).toBeCloseTo(none[i], 9);
  });

  test('the grain frays the edge between two classes: where a class is read moves with the grain, by COVER.jitter metres at most per unit', async () => {
    const { COVER, coverJitter } = await import('../../src/engine/render/shading');
    expect(coverJitter([0, 0, 0], [0, 0, 0])).toEqual([0, 0]);
    const j = coverJitter([1, -1, 0], [0, 0, 0]);
    expect(j[0]).toBeCloseTo(COVER.jitter, 9);
    expect(j[1]).toBeCloseTo(-COVER.jitter, 9);
    // The fine grain adds half as much again.
    expect(coverJitter([1, 0, 0], [1, 0, 0])[0]).toBeCloseTo(COVER.jitter * 1.5, 9);
    expect(COVER.jitter).toBeGreaterThan(10);
    expect(COVER.jitter).toBeLessThan(60);
  });
});
