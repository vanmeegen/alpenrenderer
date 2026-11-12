/**
 * The view as a URL: `#lon=7.7847&lat=45.9835&alt=3135&yaw=225&pitch=0&fov=60`.
 *
 * Everything that decides what is on screen lives in the hash, so a view can
 * be shared, bookmarked, and reproduced in a headless check. `alt` is the
 * absolute eye altitude in metres; leave it out to stand on the ground.
 */

import { fovForAspect } from '../engine/core/camera';

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
  { id: 'sonnenspitz', name: 'Kochelsee vom Sonnenspitz (DE)', lon: 11.37606, lat: 47.63938, yaw: 290 },
  // Above the Rofan top station (Erfurter Hütte): over the Achensee to Sonnjoch and Lamsenspitze.
  { id: 'mauritzalm', name: 'Mauritzalm am Rofan (AT)', lon: 11.76411, lat: 47.44379, yaw: 250 },
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

/** Whether the hash says where to stand: a standpoint, or a named place. */
export function hasStandpoint(hash: string): boolean {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  return (q.has('lon') && q.has('lat')) || PLACES.some((p) => p.id === q.get('p'));
}

/** The view the hash describes; what it leaves out comes from `fallback`. */
export function readHash(hash = location.hash, fallback = DEFAULT_VIEW): ViewState {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const place = PLACES.find((p) => p.id === q.get('p'));
  const base = place ? { ...fallback, lon: place.lon, lat: place.lat, yaw: place.yaw } : fallback;
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

/**
 * The view a hash asks for while the app shows `here`. What the hash leaves
 * out stays as it is ("#yaw=180" turns the view, it does not move the
 * standpoint), and a standpoint that is `here`'s to the five decimals a hash
 * holds is `here`'s: the app's own hash, read back, is not a move.
 */
export function viewFromHash(hash: string, here: ViewState): ViewState {
  const v = readHash(hash, here);
  const same = Math.abs(v.lon - here.lon) < 6e-6 && Math.abs(v.lat - here.lat) < 6e-6;
  return same ? { ...v, lon: here.lon, lat: here.lat } : v;
}

const defaultStorage = (): Storage | undefined => {
  try { return typeof localStorage !== 'undefined' ? localStorage : undefined; } catch { return undefined; }
};

const LAST_VIEW_KEY = 'alp.lastView';

/** The view last shown on this device, or null. */
export function readLastView(storage = defaultStorage()): ViewState | null {
  try {
    const raw = storage?.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ViewState>;
    const keys = ['lon', 'lat', 'yaw', 'pitch', 'fov'] as const;
    if (!keys.every((k) => Number.isFinite(v[k]))) return null;
    const out: ViewState = { lon: v.lon!, lat: v.lat!, yaw: v.yaw!, pitch: v.pitch!, fov: v.fov! };
    if (Number.isFinite(v.alt)) out.alt = v.alt;
    return out;
  } catch {
    return null;
  }
}

export function writeLastView(v: ViewState, storage = defaultStorage()) {
  const out: Partial<ViewState> = { lon: v.lon, lat: v.lat, yaw: v.yaw, pitch: v.pitch, fov: v.fov };
  if (v.alt !== undefined) out.alt = v.alt;
  try { storage?.setItem(LAST_VIEW_KEY, JSON.stringify(out)); } catch { /* private mode: not remembered */ }
}

/** How the standpoint came about. */
export type StandSource = 'url' | 'map' | 'gps' | 'place' | 'photo';

const defaultSession = (): Storage | undefined => {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined; } catch { return undefined; }
};

const STAND_SOURCE_KEY = 'alp.standSource';
const sameSpot = (a: number, b: number) => Math.abs(a - b) < 1e-5;   // the hash carries five decimals

/**
 * Remembers, for this tab, how the standpoint came about and which one it
 * was. The app writes the standpoint into the URL itself, so on a reload the
 * URL alone cannot tell "I started where I stood" from "somebody sent me
 * this place"; this can.
 */
export function writeStandSource(source: StandSource, at: { lon: number; lat: number }, session = defaultSession()) {
  try { session?.setItem(STAND_SOURCE_KEY, JSON.stringify({ source, lon: at.lon, lat: at.lat })); } catch { /* not remembered */ }
}

export function readStandSource(session = defaultSession()): { source: StandSource; lon: number; lat: number } | null {
  try {
    const raw = session?.getItem(STAND_SOURCE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { source?: StandSource; lon?: number; lat?: number };
    if (typeof v.source !== 'string' || !Number.isFinite(v.lon) || !Number.isFinite(v.lat)) return null;
    return { source: v.source, lon: v.lon!, lat: v.lat! };
  } catch {
    return null;
  }
}

/**
 * Where the app opens. A standpoint in the URL is the standpoint (a shared
 * link, a place chosen on the map and reloaded). Without one, the device's
 * position is what a person on a mountain wants (PeakFinder and PeakVisor
 * open on the GPS), so the caller asks for it; until it arrives, and when it
 * is refused, the view last shown here stands, or the default place. And a
 * standpoint in the URL that this tab took from the device itself is asked
 * for again: reloaded on the next mountain, the app is on the next mountain.
 */
export function startView(
  hash: string, storage = defaultStorage(), aspect = 1, session = defaultSession(),
): { view: ViewState; locate: boolean } {
  // No field of view anywhere: 60° along the screen's long side (camera.ts fovForAspect).
  const fallback = { ...DEFAULT_VIEW, fov: fovForAspect(DEFAULT_VIEW.fov, aspect) };
  if (hasStandpoint(hash)) {
    const view = readHash(hash, fallback);
    const src = readStandSource(session);
    const own = src?.source === 'gps' && sameSpot(src.lon, view.lon) && sameSpot(src.lat, view.lat);
    return { view, locate: own };
  }
  return { view: readHash(hash, readLastView(storage) ?? fallback), locate: true };
}

/** Metres: a fix coarser than this is a guess at the standpoint, and the whole view hangs on it. */
export const COARSE_FIX_M = 100;

/** What to tell the user about a fix of this accuracy (metres); null when it is good enough to stand on. */
export function coarseFixNote(accuracy: number | null | undefined): string | null {
  if (accuracy == null || !(accuracy > COARSE_FIX_M)) return null;
  const size = accuracy < 1000 ? `${Math.round(accuracy)} m` : `${(accuracy / 1000).toFixed(1).replace('.', ',')} km`;
  return `Standort nur auf ± ${size} genau, der Blick kann abweichen. Auf der Karte nachsetzen.`;
}

interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (id) => clearTimeout(id),
};

/**
 * `fn` with the latest value, `ms` after the first one not yet passed on:
 * at most once per interval, and always in the end. A debounce would hold a
 * stream of values back until it stops; in sensor mode the view changes
 * every frame and never does.
 */
export function trailing<T>(fn: (v: T) => void, ms: number, timers: Timers = realTimers): ((v: T) => void) & { cancel(): void } {
  let latest: T, timer: number | null = null;
  const push = (v: T) => {
    latest = v;
    if (timer !== null) return;
    timer = timers.set(() => { timer = null; fn(latest); }, ms);
  };
  push.cancel = () => { if (timer !== null) { timers.clear(timer); timer = null; } };
  return push;
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
  /** Land cover tile template (sources/landcover.ts), likewise. */
  cover: string;
  /**
   * Draw the lit shade pass (`shade=0` turns it off): without it the range
   * pass and the composite still run and the view is the outline over white
   * that the AR view shows without a camera. For tests and weak GPUs.
   */
  shade: boolean;
  /**
   * Forces the adaptation to slow frames on (`adapt=1`) or off (`adapt=0`);
   * without it the device class decides, and an explicit `q` switches it off.
   */
  adapt?: boolean;
}

export function readOptions(search = location.search): AppOptions {
  const q = new URLSearchParams(search);
  const b = q.get('backend');
  const ql = q.get('q');
  const tiles = q.get('tiles');
  const peaks = q.get('peaks') || 'peaks';
  const lakes = q.get('lakes') || 'lakes';
  const cover = q.get('cover') || 'landcover';
  return {
    backend: b === 'webgpu' ? 'webgpu' : 'webgl2',
    quality: ql === 'high' || ql === 'low' ? ql : 'auto',
    tiles: tiles ? (tiles.endsWith('/') ? tiles : tiles + '/') + '{z}/{x}/{y}.webp' : undefined,
    peaks: (peaks.endsWith('/') ? peaks : peaks + '/') + '{x}_{y}.json',
    lakes: (lakes.endsWith('/') ? lakes : lakes + '/') + '{x}_{y}.json',
    cover: (cover.endsWith('/') ? cover : cover + '/') + '{z}/{x}/{y}.png',
    shade: q.get('shade') !== '0',
    ...(q.get('adapt') === '1' ? { adapt: true } : q.get('adapt') === '0' ? { adapt: false } : {}),
  };
}

/**
 * How far above the ground under the standpoint the eye stands, metres.
 * 1.7 m is a person standing there, which is what every panorama service
 * does by default (HeyWhatsThat six feet, udeuschle 10 m, PeakFinder the DEM
 * plus an offset); more lifts the view over the woods or the knoll in front,
 * up to a drone's height. The highest ground within a kilometre, the old
 * default, put the eye hundreds of metres up the slopes at a lakeshore and
 * turned the view into one from above.
 */
export const EYE_HEIGHT = { min: 1.7, max: 500, initial: 1.7 };
const EYE_HEIGHT_KEY = 'alp.eyeHeight';

/** Clamped to the slider, to a tenth of a metre. */
export function clampEyeHeight(m: number): number {
  if (!Number.isFinite(m)) return EYE_HEIGHT.initial;
  return Math.round(Math.max(EYE_HEIGHT.min, Math.min(EYE_HEIGHT.max, m)) * 10) / 10;
}

export function readEyeHeight(storage = defaultStorage()): number {
  try {
    const v = storage?.getItem(EYE_HEIGHT_KEY);
    return v == null ? EYE_HEIGHT.initial : clampEyeHeight(parseFloat(v));
  } catch {
    return EYE_HEIGHT.initial;
  }
}

export function writeEyeHeight(m: number, storage = defaultStorage()) {
  try { storage?.setItem(EYE_HEIGHT_KEY, String(clampEyeHeight(m))); } catch { /* private mode: not remembered */ }
}

/** How strongly the ridge lines are drawn over the shaded view, 0..1 (renderer.outline). */
export const OUTLINE = { min: 0, max: 1, initial: 0.7 };
const OUTLINE_KEY = 'alp.outline';

export function clampOutline(v: number): number {
  if (!Number.isFinite(v)) return OUTLINE.initial;
  return Math.round(Math.max(OUTLINE.min, Math.min(OUTLINE.max, v)) * 100) / 100;
}

export function readOutline(storage = defaultStorage()): number {
  try {
    const v = storage?.getItem(OUTLINE_KEY);
    return v == null ? OUTLINE.initial : clampOutline(parseFloat(v));
  } catch {
    return OUTLINE.initial;
  }
}

export function writeOutline(v: number, storage = defaultStorage()) {
  try { storage?.setItem(OUTLINE_KEY, String(clampOutline(v))); } catch { /* private mode: not remembered */ }
}

/**
 * How the terrain is drawn. `relief`: lit and coloured, lines over it.
 * `lines`: the outline alone on white, the look of a drawn panorama, and
 * what is left when the lit pass is too much for a GPU.
 */
export type Style = 'relief' | 'lines';
export const STYLES: { id: Style; name: string }[] = [
  { id: 'relief', name: 'Relief' },
  { id: 'lines', name: 'Linien' },
];
const STYLE_KEY = 'alp.style';

export function readStyle(storage = defaultStorage()): Style {
  try {
    const v = storage?.getItem(STYLE_KEY);
    return STYLES.some((s) => s.id === v) ? (v as Style) : 'relief';
  } catch {
    return 'relief';
  }
}

export function writeStyle(style: Style, storage = defaultStorage()) {
  try { storage?.setItem(STYLE_KEY, style); } catch { /* private mode: not remembered */ }
}

/**
 * The slider runs 0..100 and is logarithmic: the first metres matter (1.7 m
 * standing, 3 m on a rock, 10 m up a tower) and the last hundred hardly do.
 */
export function eyeHeightFromSlider(t: number): number {
  const f = Math.min(1, Math.max(0, t / 100));
  return EYE_HEIGHT.min * (EYE_HEIGHT.max / EYE_HEIGHT.min) ** f;
}

export function sliderFromEyeHeight(m: number): number {
  const h = Math.min(EYE_HEIGHT.max, Math.max(EYE_HEIGHT.min, m));
  return (100 * Math.log(h / EYE_HEIGHT.min)) / Math.log(EYE_HEIGHT.max / EYE_HEIGHT.min);
}
