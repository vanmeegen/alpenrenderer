/**
 * Which device this is, and what it is asked to draw.
 *
 * Three classes. A phone has a small screen at three device pixels per CSS
 * pixel and a GPU that pays for every one of them. A tablet has the screen
 * of a laptop and a GPU that is a good deal better than a phone's (an iPad
 * more so than its four reported cores suggest). A desktop draws everything.
 * What a class is asked for is a starting point: the renderer measures its
 * frames and goes down from there when they are slow (render/adapt.ts).
 */
import { ClipmapConfig, DEFAULT_CLIPMAP, LOW_CLIPMAP } from '../engine/sources/clipmap';
import { QUALITY_HIGH, QUALITY_LOW, QUALITY_MID, Quality } from '../engine/render/quality';
import { PIXEL_RATIO_CAP } from '../engine/render/resolution';

export type Tier = 'phone' | 'tablet' | 'desktop';

export interface DeviceInfo {
  userAgent: string;
  /** navigator.maxTouchPoints. */
  touchPoints: number;
  /** The screen's shorter side, CSS pixels. */
  shortSide: number;
  /** navigator.hardwareConcurrency. */
  cores: number;
}

export function deviceTier(d: DeviceInfo): Tier {
  const ua = d.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'phone';
  // iPadOS asks for the desktop site and says it is a Mac; a Mac has no touch screen.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && d.touchPoints > 1)) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) || d.shortSide < 600 ? 'phone' : 'tablet';
  if (d.touchPoints > 1 && d.shortSide < 600) return 'phone';
  // A desktop with few cores has a small GPU beside them.
  return d.cores <= 4 ? 'tablet' : 'desktop';
}

/** This browser's device. */
export function thisDevice(): DeviceInfo {
  return {
    userAgent: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints ?? 0,
    shortSide: Math.min(screen.width, screen.height) || Math.min(innerWidth, innerHeight),
    cores: navigator.hardwareConcurrency ?? 8,
  };
}

export interface Profile {
  tier: Tier;
  quality: 'low' | 'mid' | 'high';
  mesh: Quality;
  clipmap: ClipmapConfig;
  /** Most device pixels per CSS pixel the frame is rendered at. */
  pixelRatio: number;
  /** Decoded tiles kept in memory (512 px tiles: 1 MB each). */
  tiles: number;
  /** Whether the renderer adapts to its frame times while running. */
  adapt: boolean;
}

/**
 * What a device is asked to draw. `asked` is the ?q= of the URL: 'low' and
 * 'high' are taken as given on any device, with nothing adapted while
 * running, so a test or a comparison sees exactly that setting.
 */
export function profileFor(tier: Tier, asked: 'low' | 'high' | 'auto'): Profile {
  if (asked === 'low') {
    return { tier, quality: 'low', mesh: QUALITY_LOW, clipmap: LOW_CLIPMAP, pixelRatio: PIXEL_RATIO_CAP.low, tiles: 220, adapt: false };
  }
  if (asked === 'high') {
    return { tier, quality: 'high', mesh: QUALITY_HIGH, clipmap: DEFAULT_CLIPMAP, pixelRatio: PIXEL_RATIO_CAP.high, tiles: 220, adapt: false };
  }
  if (tier === 'phone') {
    return { tier, quality: 'low', mesh: QUALITY_LOW, clipmap: LOW_CLIPMAP, pixelRatio: PIXEL_RATIO_CAP.low, tiles: 48, adapt: true };
  }
  if (tier === 'tablet') {
    return { tier, quality: 'mid', mesh: QUALITY_MID, clipmap: DEFAULT_CLIPMAP, pixelRatio: PIXEL_RATIO_CAP.high, tiles: 110, adapt: true };
  }
  return { tier, quality: 'high', mesh: QUALITY_HIGH, clipmap: DEFAULT_CLIPMAP, pixelRatio: PIXEL_RATIO_CAP.high, tiles: 220, adapt: true };
}
