/**
 * Where each clipmap level lies in the height atlas.
 *
 * The levels are squares of the same size. Stacked in one column, ten of
 * them at 640 px made a texture 6400 px tall, and 4096 is the only size
 * every phone takes (most take 8192, some old Androids do not). Two abreast
 * they are 1280 × 3200. The shaders find a level's corner the same way
 * (gpu/glsl.ts and gpu/wgsl.ts `atlasOrigin`, with ATLAS_COLUMNS injected).
 */

/**
 * Levels the shaders hold: nine around the observer (pixel zoom 15 to 7)
 * and three telescope windows. At 640 px, two abreast, twelve are
 * 1280 × 3840.
 */
export const MAX_LEVELS = 12;
/**
 * How many of those may be the telescope's windows (clipmap.ts look). They
 * are listed first, the finest first (HeightField sorts by reach, and a
 * window has none), so the shaders look for windows in the first MAX_LOOK
 * levels only.
 */
export const MAX_LOOK = 3;

/** Levels side by side in the atlas. */
export const ATLAS_COLUMNS = 2;

export interface AtlasLayout {
  width: number;
  height: number;
  /** Top-left texel of level `i`. */
  origin(i: number): { x: number; y: number };
}

export function atlasLayout(levels: number, levelPx: number): AtlasLayout {
  return {
    width: ATLAS_COLUMNS * levelPx,
    height: Math.max(1, Math.ceil(levels / ATLAS_COLUMNS)) * levelPx,
    origin: (i) => ({ x: (i % ATLAS_COLUMNS) * levelPx, y: Math.floor(i / ATLAS_COLUMNS) * levelPx }),
  };
}
