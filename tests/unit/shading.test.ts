/**
 * The shading formula in TypeScript, the reference the shaders and the E2E
 * pixel tests share.
 */
import { describe, expect, test } from 'bun:test';
import { FOG_RANGE, HORIZON_COLOR, WATER_COLOR, shadeFactor, sunVector, terrainColor } from '../../src/engine/render/shading';

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
