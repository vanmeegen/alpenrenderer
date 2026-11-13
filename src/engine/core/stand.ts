/**
 * Where one stands, from the device's fixes.
 *
 * Two things a single "Mein Standort" does not do. On a summit, the fix is
 * a few metres beside the top, and from beside the top half the view is
 * behind the summit's own cap: within what the fix is good for, one stands
 * on the summit. And walking, the standpoint should come along, without
 * jumping at every wobble of the GPS and reloading terrain for it.
 */

import { groundRange } from './geodesy';
import { Peak } from './peaks';

export const SNAP = {
  /** Metres: a perfect fix is still a person somewhere on the cairn. */
  minRadius: 15,
  /** Metres: beyond this a summit is a place one walks to. */
  maxRadius: 60,
  /** Metres: a fix worse than this is a guess, and puts nobody on a summit. */
  maxAccuracy: 100,
};

export interface Fix {
  lon: number;
  lat: number;
  /** Metres, as the device reports it. */
  accuracy?: number | null;
}

/** How far from a summit a fix of this accuracy still counts as standing on it, metres. */
export function snapRadius(accuracy: number | null | undefined): number {
  return Math.min(SNAP.maxRadius, Math.max(SNAP.minRadius, accuracy ?? 0));
}

/**
 * The catalogued summit a fix stands on: the nearest within the fix's
 * radius, or null. Lakes are not stood on, and a coarse fix stands nowhere
 * in particular.
 */
export function summitUnder(fix: Fix, peaks: Peak[]): { peak: Peak; distance: number } | null {
  if ((fix.accuracy ?? 0) > SNAP.maxAccuracy) return null;
  const radius = snapRadius(fix.accuracy);
  let best: { peak: Peak; distance: number } | null = null;
  for (const peak of peaks) {
    if (peak.kind === 'lake') continue;
    const distance = groundRange(fix.lon, fix.lat, peak.lon, peak.lat);
    if (distance <= radius && (!best || distance < best.distance)) best = { peak, distance };
  }
  return best;
}

export const FOLLOW = {
  /** Metres the device has to have moved from the standpoint before it follows. */
  minMove: 10,
  /** Milliseconds between two moves of the standpoint at least. */
  minInterval: 2000,
};

/**
 * Decides which of a stream of fixes moves the standpoint. The first does.
 * After that one that lies farther from where the standpoint was put than
 * ten metres and than half its own accuracy (a coarse fix a little off is
 * the same place, seen worse), and not sooner than two seconds after the
 * last: each move recuts the eye's height and the labels.
 */
export class FollowFilter {
  private held: { lon: number; lat: number; at: number } | null = null;

  /**
   * What to do with a fix: take it (the standpoint goes there), or not. A
   * move that comes too soon after the last is to be offered `again` after
   * so many milliseconds: a device that then stands still sends no other.
   */
  judge(fix: Fix, now: number): { take: boolean; again?: number } {
    const h = this.held;
    if (h) {
      const moved = groundRange(h.lon, h.lat, fix.lon, fix.lat);
      if (moved <= Math.max(FOLLOW.minMove, (fix.accuracy ?? 0) / 2)) return { take: false };
      if (now - h.at < FOLLOW.minInterval) return { take: false, again: FOLLOW.minInterval - (now - h.at) };
    }
    this.held = { lon: fix.lon, lat: fix.lat, at: now };
    return { take: true };
  }

  /** Whether a fix moves the standpoint now (judge, without the "again"). */
  accept(fix: Fix, now: number): boolean {
    return this.judge(fix, now).take;
  }

  reset() { this.held = null; }
}
