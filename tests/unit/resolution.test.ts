/**
 * How many device pixels per CSS pixel a frame is rendered at: the screen's
 * own ratio, up to a cap by device class.
 */
import { describe, expect, test } from 'bun:test';
import { PIXEL_RATIO_CAP, renderPixelRatio } from '../../src/engine/render/resolution';

describe('renderPixelRatio', () => {
  test('a phone screen with a ratio of 3 is rendered at the cap, a quarter of the fragments', () => {
    expect(renderPixelRatio(3, PIXEL_RATIO_CAP.low)).toBe(1.5);
    expect(renderPixelRatio(3, PIXEL_RATIO_CAP.high)).toBe(2);
  });

  test('a screen below the cap keeps its own ratio; nothing is ever rendered above the screen', () => {
    expect(renderPixelRatio(1, PIXEL_RATIO_CAP.low)).toBe(1);
    expect(renderPixelRatio(1.25, PIXEL_RATIO_CAP.high)).toBe(1.25);
    expect(renderPixelRatio(2.625, Infinity)).toBe(2.625);
  });

  test('a ratio that is missing or nonsense counts as 1', () => {
    expect(renderPixelRatio(0, 2)).toBe(1);
    expect(renderPixelRatio(NaN, 2)).toBe(1);
  });
});
