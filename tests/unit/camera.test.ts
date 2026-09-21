/**
 * The live camera's numbers: the lens field of view as it ends up on screen
 * once the frame is cover-cropped into the canvas, and the photo's file name.
 */
import { describe, expect, test } from 'bun:test';
import { captureFilename, coverFovY } from '../../src/app/cameraFeed';

describe('coverFovY', () => {
  test('a frame wider than the canvas is not cropped vertically: the lens angle stays', () => {
    expect(coverFovY(51, 1920, 1080, 600, 1000)).toBeCloseTo(51, 6);
    expect(coverFovY(51, 1920, 1080, 1920, 1080)).toBeCloseTo(51, 6);
  });

  test('a canvas wider than the frame crops top and bottom, narrowing the vertical angle', () => {
    // 4:3 frame in a 5:3 canvas: the visible half-angle shrinks by 0.8.
    const expected = 2 * Math.atan(Math.tan((51 * Math.PI) / 360) * (4 / 3) / (5 / 3)) * 180 / Math.PI;
    expect(coverFovY(51, 640, 480, 1000, 600)).toBeCloseTo(expected, 6);
    expect(expected).toBeCloseTo(41.77, 1);
  });

  test('without frame or canvas dimensions the lens angle is returned as is', () => {
    expect(coverFovY(51, 0, 0, 1000, 600)).toBe(51);
    expect(coverFovY(51, 640, 480, 0, 0)).toBe(51);
  });
});

describe('captureFilename', () => {
  test('carries date, time, position and bearing', () => {
    const at = new Date(2026, 8, 20, 14, 5, 9);
    expect(captureFilename(10.98527, 47.42111, 109.6, at)).toBe('alpen-20260920-140509-47.4211_10.9853-110deg.png');
  });
});
