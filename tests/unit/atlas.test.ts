/**
 * Where each clipmap level lies in the height atlas. Stacked in one column,
 * ten levels of 640 px were 6400 px tall; 4096 is the only texture size
 * every phone takes.
 */
import { describe, expect, test } from 'bun:test';
import { ATLAS_COLUMNS, atlasLayout } from '../../src/engine/render/atlas';

describe('atlasLayout', () => {
  test('ten levels of 640 px lie two abreast: 1280 × 3200, inside 4096 either way', () => {
    const a = atlasLayout(10, 640);
    expect(ATLAS_COLUMNS).toBe(2);
    expect([a.width, a.height]).toEqual([1280, 3200]);
    expect(Math.max(a.width, a.height)).toBeLessThanOrEqual(4096);
  });

  test('a level\'s corner: left to right, then down', () => {
    const a = atlasLayout(8, 640);
    expect([a.width, a.height]).toEqual([1280, 2560]);
    expect(a.origin(0)).toEqual({ x: 0, y: 0 });
    expect(a.origin(1)).toEqual({ x: 640, y: 0 });
    expect(a.origin(2)).toEqual({ x: 0, y: 640 });
    expect(a.origin(7)).toEqual({ x: 640, y: 1920 });
  });

  test('an odd count leaves the last cell empty; one level is still two cells wide', () => {
    expect(atlasLayout(7, 640).height).toBe(2560);
    const one = atlasLayout(1, 640);
    expect([one.width, one.height]).toEqual([1280, 640]);
  });
});
