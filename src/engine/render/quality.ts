/**
 * How finely the terrain is meshed. The mesh is a wedge over the view
 * (mesh.ts `wedge`), all of it drawn: the columns are shared out over the
 * field of view, the rows over the range at a constant fraction.
 */
export interface Quality {
  /** Rays across the wedge. */
  azimuths: number;
  /** Samples along each ray. */
  rows: number;
  /** Azimuth sectors the mesh is cut into. */
  sectors: number;
}

/** 1.6 M vertices, a row every 1/190 of the range: a desktop GPU. */
export const QUALITY_HIGH: Quality = { azimuths: 1024, rows: 1600, sectors: 32 };
/** 0.96 M vertices: a tablet. */
export const QUALITY_MID: Quality = { azimuths: 800, rows: 1200, sectors: 32 };
/** 0.58 M vertices, a row every 1/120 of the range: a phone, and what the E2E tests render. */
export const QUALITY_LOW: Quality = { azimuths: 640, rows: 900, sectors: 32 };
