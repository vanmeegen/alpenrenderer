/**
 * Finding a summit: by name among everything within range, hidden or not,
 * or in the list of what is in sight; and which way to turn for it.
 *
 * The labels in the picture are the few that fit. This is the other way
 * in: "where is the Großglockner from here?" has an answer whether or not
 * its label won a place, and whether or not a ridge stands in front of it.
 */

import { angleDelta } from './pose';
import { LabelTarget } from './labels';

/** A name as it is compared: lower case, without accents, ß as ss, outer blanks gone. */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase().trim();
}

export interface Found {
  target: LabelTarget;
  /** In sight from here, as far as the sightlines are decided. */
  visible: boolean;
  /** Whether its sightline has been checked yet. */
  decided: boolean;
}

/**
 * Without a query: what is in sight, the most striking first (the rank the
 * labels are handed out by). With one: every summit or lake within range
 * whose name holds it, hidden ones too; names that begin with it first,
 * then the visible, then the near. Each feature once, `limit` at most.
 */
export function searchTargets(targets: LabelTarget[], query: string, limit = 30): Found[] {
  const q = foldName(query);
  const main = targets.filter((t) => t.spot === 0);
  const found = (t: LabelTarget): Found => ({ target: t, visible: t.decided && t.visible, decided: t.decided });
  if (!q) {
    return main.filter((t) => t.decided && t.visible).sort((a, b) => b.rank - a.rank).slice(0, limit).map(found);
  }
  return main
    .map((t) => ({ t, name: foldName(t.peak.name) }))
    .filter((e) => e.name.includes(q))
    .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q))
      || Number(b.t.decided && b.t.visible) - Number(a.t.decided && a.t.visible)
      || a.t.range - b.t.range)
    .slice(0, limit)
    .map((e) => found(e.t));
}

export interface Pointer {
  /** Degrees to turn, right positive, the short way round. */
  turn: number;
  /** Degrees to tilt, up positive. */
  lift: number;
  /** Unit vector on screen toward the target: x right, y down. */
  dx: number;
  dy: number;
}

/**
 * Which way to turn for a target that is not in the frame, or null when it
 * is. `fov` is the vertical field of view, degrees. The frame is taken a
 * little smaller than it is: a summit at the very edge is still pointed at.
 */
export function pointerTo(cam: { yaw: number; pitch: number; fov: number; aspect: number }, t: LabelTarget): Pointer | null {
  const turn = angleDelta(t.bearing, cam.yaw), lift = t.elevation - cam.pitch;
  const halfV = cam.fov / 2;
  const halfH = (Math.atan(Math.tan((halfV * Math.PI) / 180) * cam.aspect) * 180) / Math.PI;
  if (Math.abs(turn) < halfH * 0.95 && Math.abs(lift) < halfV * 0.95) return null;
  const len = Math.hypot(turn, lift);
  return { turn, lift, dx: turn / len, dy: -lift / len };
}

/**
 * Where the arrow for a pointer is drawn in a picture of `w` × `h` CSS
 * pixels: on a circle round the middle, clear of the panels at the edges.
 */
export function pointerSpot(p: Pointer, w: number, h: number): { x: number; y: number } {
  const r = Math.min(w, h) / 2 - 48;
  return { x: w / 2 + p.dx * r, y: h / 2 + p.dy * r };
}
