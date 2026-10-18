/**
 * The live camera's numbers: the lens field of view as it ends up on screen
 * once the frame is cover-cropped into the canvas, and the photo's file name.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LENS_FOV, captureFilename, coverFovY, lensFovY, renderLensFov } from '../../src/app/cameraFeed';
import { fovForAspect, longFovOf } from '../../src/engine/core/camera';

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

describe('the lens angle is the long side\'s: the same lens, held upright or sideways', () => {
  test('a phone camera sees about 66° along the long side of its frame; the short side follows the aspect', () => {
    expect(DEFAULT_LENS_FOV).toBe(66);
    // Landscape 16:9: the long side is the width, the vertical angle is narrower.
    expect(lensFovY(66, 1920, 1080)).toBeCloseTo(2 * Math.atan(Math.tan((33 * Math.PI) / 180) * (9 / 16)) * 180 / Math.PI, 6);
    expect(lensFovY(66, 1920, 1080)).toBeCloseTo(40.1, 1);
    // Portrait: the long side is the height, the vertical angle is the lens angle itself.
    expect(lensFovY(66, 1080, 1920)).toBe(66);
    // Unknown frame: the lens angle as is.
    expect(lensFovY(66, 0, 0)).toBe(66);
  });

  test('renderLensFov is the long-side angle turned into the frame\'s vertical and cover-cropped into the canvas', () => {
    expect(renderLensFov(66, 1920, 1080, 1000, 600)).toBeCloseTo(coverFovY(lensFovY(66, 1920, 1080), 1920, 1080, 1000, 600), 9);
    expect(renderLensFov(66, 1080, 1920, 600, 1000)).toBeCloseTo(coverFovY(66, 1080, 1920, 600, 1000), 9);
  });
});

describe('the panorama\'s default field of view is the long side\'s too: 60° across, upright or sideways', () => {
  test('a landscape screen gets 60° horizontally, a portrait one 60° vertically', () => {
    expect(fovForAspect(60, 1)).toBeCloseTo(60, 9);
    expect(fovForAspect(60, 0.5)).toBe(60);
    expect(fovForAspect(60, 1000 / 600)).toBeCloseTo(2 * Math.atan(Math.tan((30 * Math.PI) / 180) / (1000 / 600)) * 180 / Math.PI, 9);
    expect(fovForAspect(60, 1000 / 600)).toBeCloseTo(38.2, 1);
  });

  test('longFovOf inverts it, so a rotation keeps the long side\'s angle', () => {
    for (const aspect of [0.5, 1, 1.78]) expect(longFovOf(fovForAspect(60, aspect), aspect)).toBeCloseTo(60, 9);
    expect(longFovOf(60, 0.5)).toBe(60);
  });
});
