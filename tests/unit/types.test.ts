import { describe, expect, test } from 'bun:test';
import { normaliseTile, tileId, tileZoom, zoomShift } from '../../src/engine/sources/types';

describe('tile zoom vs pixel zoom', () => {
  test('256-px tiles sit at the pixel zoom', () => {
    expect(zoomShift(256)).toBe(0);
    expect(tileZoom(14, 256)).toBe(14);
  });

  test('512-px tiles sit one zoom below the pixels they hold', () => {
    expect(zoomShift(512)).toBe(1);
    expect(tileZoom(14, 512)).toBe(13);
    expect(tileZoom(7, 512)).toBe(6);
  });

  test('tileId is z/x/y', () => {
    expect(tileId({ z: 12, x: 2135, y: 1457 })).toBe('12/2135/1457');
  });
});

describe('normaliseTile', () => {
  test('wraps x around the date line', () => {
    expect(normaliseTile({ z: 3, x: -1, y: 2 })).toEqual({ z: 3, x: 7, y: 2 });
    expect(normaliseTile({ z: 3, x: 8, y: 2 })).toEqual({ z: 3, x: 0, y: 2 });
  });

  test('rejects y outside the projection', () => {
    expect(normaliseTile({ z: 3, x: 1, y: -1 })).toBeNull();
    expect(normaliseTile({ z: 3, x: 1, y: 8 })).toBeNull();
  });
});
