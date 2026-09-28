/**
 * The view as a URL: `#lon=7.7847&lat=45.9835&alt=3135&yaw=225&pitch=0&fov=60`.
 *
 * Everything that decides what is on screen lives in the hash, so a view can
 * be shared, bookmarked, and reproduced in a headless check. `alt` is the
 * absolute eye altitude in metres; leave it out to stand on the ground.
 */

export interface ViewState {
  lon: number;
  lat: number;
  /** Absolute eye altitude, metres; undefined = DEM ground plus eye height. */
  alt?: number;
  yaw: number;
  pitch: number;
  fov: number;
}

export interface Place {
  id: string;
  name: string;
  lon: number;
  lat: number;
  yaw: number;
  /** Metres above the DEM ground; a lookout tower or a lifted view. */
  above?: number;
}

export const PLACES: Place[] = [
  { id: 'gornergrat', name: 'Gornergrat (CH)', lon: 7.78472, lat: 45.98333, yaw: 232 },
  { id: 'zugspitze', name: 'Zugspitze (DE/AT)', lon: 10.98527, lat: 47.42111, yaw: 110 },
  { id: 'wank', name: 'Wank bei Garmisch (DE)', lon: 11.1456, lat: 47.5069, yaw: 215 },
  { id: 'franzjosefshoehe', name: 'Kaiser-Franz-Josefs-Höhe (AT)', lon: 12.7519, lat: 47.0746, yaw: 250 },
  { id: 'jenner', name: 'Jenner am Königssee (DE)', lon: 13.0186, lat: 47.5896, yaw: 225 },
  { id: 'saentis', name: 'Säntis (CH)', lon: 9.3433, lat: 47.2494, yaw: 190 },
  { id: 'nebelhorn', name: 'Nebelhorn (DE)', lon: 10.3417, lat: 47.4211, yaw: 160 },
  { id: 'schilthorn', name: 'Schilthorn (CH)', lon: 7.8350, lat: 46.5583, yaw: 120 },
];

export const DEFAULT_VIEW: ViewState = {
  lon: PLACES[0].lon, lat: PLACES[0].lat, yaw: PLACES[0].yaw, pitch: 0, fov: 60,
};

/** 0 <= yaw < 360 without the rounding noise that (x % 360 + 360) % 360 adds. */
export const wrap360 = (deg: number): number => deg - 360 * Math.floor(deg / 360);

const num = (v: string | null, d: number): number => {
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

export function readHash(hash = location.hash): ViewState {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const place = PLACES.find((p) => p.id === q.get('p'));
  const base = place ? { ...DEFAULT_VIEW, lon: place.lon, lat: place.lat, yaw: place.yaw } : DEFAULT_VIEW;
  const alt = q.get('alt');
  return {
    lon: num(q.get('lon'), base.lon),
    lat: num(q.get('lat'), base.lat),
    alt: alt === null ? undefined : num(alt, NaN) || undefined,
    yaw: wrap360(num(q.get('yaw'), base.yaw)),
    pitch: Math.max(-89, Math.min(89, num(q.get('pitch'), base.pitch))),
    fov: Math.max(5, Math.min(110, num(q.get('fov'), base.fov))),
  };
}

export function formatHash(v: ViewState): string {
  const parts = [
    `lon=${v.lon.toFixed(5)}`, `lat=${v.lat.toFixed(5)}`,
    ...(v.alt !== undefined ? [`alt=${Math.round(v.alt)}`] : []),
    `yaw=${v.yaw.toFixed(1)}`, `pitch=${v.pitch.toFixed(1)}`, `fov=${v.fov.toFixed(0)}`,
  ];
  return '#' + parts.join('&');
}

/** Query parameters that configure the app rather than the view. */
export interface AppOptions {
  backend: 'webgl2' | 'webgpu';
  quality: 'high' | 'low' | 'auto';
  /** Tile URL template override, e.g. a local cache for offline checks. */
  tiles?: string;
  /** Summit catalogue cell template; by default the cells built next to the app. */
  peaks: string;
  /** Lake catalogue cell template, likewise. */
  lakes: string;
}

export function readOptions(search = location.search): AppOptions {
  const q = new URLSearchParams(search);
  const b = q.get('backend');
  const ql = q.get('q');
  const tiles = q.get('tiles');
  const peaks = q.get('peaks') || 'peaks';
  const lakes = q.get('lakes') || 'lakes';
  return {
    backend: b === 'webgpu' ? 'webgpu' : 'webgl2',
    quality: ql === 'high' || ql === 'low' ? ql : 'auto',
    tiles: tiles ? (tiles.endsWith('/') ? tiles : tiles + '/') + '{z}/{x}/{y}.webp' : undefined,
    peaks: (peaks.endsWith('/') ? peaks : peaks + '/') + '{x}_{y}.json',
    lakes: (lakes.endsWith('/') ? lakes : lakes + '/') + '{x}_{y}.json',
  };
}

/**
 * The eye stands 1.7 m above the highest ground within this many metres of
 * the standpoint. A DEM post every few metres rounds a slope into steps, so
 * an eye over its own post sits inside the hill next to it; a wider area
 * lifts it clear of the nearby ridge as well. Chosen per device on a slider.
 */
export const EYE_RADIUS = { min: 10, max: 2000, initial: 1000 };
const EYE_RADIUS_KEY = 'alp.eyeRadius';

const defaultStorage = (): Storage | undefined => {
  try { return typeof localStorage !== 'undefined' ? localStorage : undefined; } catch { return undefined; }
};

export function clampEyeRadius(m: number): number {
  if (!Number.isFinite(m)) return EYE_RADIUS.initial;
  return Math.max(EYE_RADIUS.min, Math.min(EYE_RADIUS.max, Math.round(m)));
}

export function readEyeRadius(storage = defaultStorage()): number {
  try {
    const v = storage?.getItem(EYE_RADIUS_KEY);
    return v == null ? EYE_RADIUS.initial : clampEyeRadius(parseFloat(v));
  } catch {
    return EYE_RADIUS.initial;
  }
}

export function writeEyeRadius(m: number, storage = defaultStorage()) {
  try { storage?.setItem(EYE_RADIUS_KEY, String(clampEyeRadius(m))); } catch { /* private mode: not remembered */ }
}
