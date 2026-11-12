/**
 * Which device this is and what it is asked to draw: a phone, a tablet or a
 * desktop, each with its own mesh, clipmap, resolution and tile cache. An
 * explicit ?q= is taken as given, for tests and for looking at one setting.
 */
import { describe, expect, test } from 'bun:test';
import { deviceTier, profileFor } from '../../src/app/device';
import { DEFAULT_CLIPMAP, LOW_CLIPMAP } from '../../src/engine/sources/clipmap';
import { QUALITY_HIGH, QUALITY_LOW, QUALITY_MID } from '../../src/engine/render/quality';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  // iPadOS asks for the desktop site by default: it says it is a Mac.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  androidPhone: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 15; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('deviceTier', () => {
  test('phones are phones: by name, and by a short screen side under 600 px', () => {
    expect(deviceTier({ userAgent: UA.iphone, touchPoints: 5, shortSide: 393, cores: 6 })).toBe('phone');
    expect(deviceTier({ userAgent: UA.androidPhone, touchPoints: 5, shortSide: 412, cores: 8 })).toBe('phone');
    // An Android tablet's browser set to "mobile site" on a small tablet, or a foldable shut.
    expect(deviceTier({ userAgent: UA.androidTablet, touchPoints: 5, shortSide: 540, cores: 8 })).toBe('phone');
  });

  test('an iPad is a tablet, also when it says it is a Mac: a Mac has no touch screen', () => {
    expect(deviceTier({ userAgent: UA.ipad, touchPoints: 5, shortSide: 820, cores: 8 })).toBe('tablet');
    expect(deviceTier({ userAgent: UA.ipadOld, touchPoints: 5, shortSide: 768, cores: 4 })).toBe('tablet');
    expect(deviceTier({ userAgent: UA.androidTablet, touchPoints: 10, shortSide: 800, cores: 8 })).toBe('tablet');
    expect(deviceTier({ userAgent: UA.mac, touchPoints: 0, shortSide: 900, cores: 8 })).toBe('desktop');
  });

  test('a desktop with four cores or fewer is asked for what a tablet is', () => {
    // The old rule sent it to the phone's setting, and with it every iPad that reports four cores.
    expect(deviceTier({ userAgent: UA.windows, touchPoints: 0, shortSide: 1080, cores: 12 })).toBe('desktop');
    expect(deviceTier({ userAgent: UA.windows, touchPoints: 0, shortSide: 768, cores: 4 })).toBe('tablet');
    expect(deviceTier({ userAgent: UA.windows, touchPoints: 0, shortSide: 768, cores: 2 })).toBe('tablet');
  });
});

describe('profileFor', () => {
  test('the phone draws the small mesh from six levels at 1.5 pixels and keeps 48 tiles decoded', () => {
    const p = profileFor('phone', 'auto');
    expect(p).toMatchObject({ quality: 'low', mesh: QUALITY_LOW, clipmap: LOW_CLIPMAP, pixelRatio: 1.5, tiles: 48, adapt: true });
  });

  test('the tablet draws a mesh between the two from all eight levels at 2 pixels', () => {
    const p = profileFor('tablet', 'auto');
    expect(p).toMatchObject({ quality: 'mid', mesh: QUALITY_MID, clipmap: DEFAULT_CLIPMAP, pixelRatio: 2, tiles: 110, adapt: true });
    expect(QUALITY_MID).toEqual({ azimuths: 800, rows: 1200, sectors: 32 });
    expect(QUALITY_MID.azimuths * QUALITY_MID.rows).toBeLessThan(QUALITY_HIGH.azimuths * QUALITY_HIGH.rows * 0.6);
  });

  test('the desktop draws everything', () => {
    expect(profileFor('desktop', 'auto')).toMatchObject({ quality: 'high', mesh: QUALITY_HIGH, clipmap: DEFAULT_CLIPMAP, pixelRatio: 2, tiles: 220, adapt: true });
  });

  test('?q=low and ?q=high are taken as given on any device, and nothing is adapted while running', () => {
    for (const tier of ['phone', 'tablet', 'desktop'] as const) {
      expect(profileFor(tier, 'low')).toMatchObject({ quality: 'low', mesh: QUALITY_LOW, clipmap: LOW_CLIPMAP, pixelRatio: 1.5, tiles: 220, adapt: false });
      expect(profileFor(tier, 'high')).toMatchObject({ quality: 'high', mesh: QUALITY_HIGH, clipmap: DEFAULT_CLIPMAP, pixelRatio: 2, tiles: 220, adapt: false });
    }
  });
});
