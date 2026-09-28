/**
 * Constants for the standpoint map, shared with the tests so expectations are
 * computed rather than read off the screen.
 */

/** Initial zoom of the picker map (256-px OSM tiles: ~38 m/px at the equator). */
export const MAP_ZOOM = 12;

/** OpenStreetMap's standard raster tiles. Low volume here; attribution below. */
export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';

export interface PickedPosition {
  lon: number;
  lat: number;
  source: 'map' | 'gps';
  /** GPS accuracy in metres, when known. */
  accuracy?: number;
}

/** A failed position request; `code` is the Geolocation error code, 0 for "no API" or "no answer". */
export class LocateError extends Error {
  constructor(message: string, readonly code: number) { super(message); this.name = 'LocateError'; }
}

/**
 * Reads the device position once; rejects with a readable German message.
 *
 * The browser's own `timeout` only starts once permission is granted, so a
 * permission prompt left unanswered would hang forever; a watchdog turns
 * that into an error after `watchdogMs`. When the precise fix is unavailable
 * or slow (location service without GNSS, indoors), a coarse one is asked
 * for once before giving up; a refusal is final.
 */
export function locateDevice(
  geo: Geolocation | undefined = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
  watchdogMs = 25000,
): Promise<PickedPosition> {
  return new Promise((resolve, reject) => {
    if (!geo) { reject(new LocateError('Standort nicht verfügbar: kein GPS in diesem Browser.', 0)); return; }
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => reject(new LocateError('Standort nicht verfügbar: keine Antwort.', 0))), watchdogMs);
    const ask = (precise: boolean) => geo.getCurrentPosition(
      (p) => finish(() => resolve({
        lon: p.coords.longitude, lat: p.coords.latitude, source: 'gps', accuracy: p.coords.accuracy,
      })),
      (e) => {
        if (done) return;
        if (precise && e.code !== e.PERMISSION_DENIED) { ask(false); return; }
        finish(() => {
          const why = e.code === e.PERMISSION_DENIED ? 'Zugriff verweigert'
            : e.code === e.TIMEOUT ? 'Zeitüberschreitung' : 'keine Position';
          reject(new LocateError(`Standort nicht verfügbar: ${why}.`, e.code));
        });
      },
      precise ? { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
        : { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 },
    );
    ask(true);
  });
}

export interface LocationHelp {
  title: string;
  steps: string[];
  /** Whether "Mein Standort" can work again once the steps are done. */
  retry: boolean;
}

/**
 * What the user can do about a failed position request. A web page cannot
 * switch location on or open the phone's settings itself, so this names the
 * exact places. `permission` is the site permission as the Permissions API
 * reports it ('unknown' where the API is missing, as in older Safari).
 */
export function locationHelp(o: {
  code: number;
  permission: PermissionState | 'unknown';
  secure: boolean;
}): LocationHelp {
  if (!o.secure) {
    return {
      title: 'Nur über https',
      steps: ['Browser geben den Standort nur an Seiten mit https heraus. Die Seite über https://… öffnen.'],
      retry: false,
    };
  }
  const site = [
    'Chrome: links neben der Adresse auf das Schloss- bzw. Regler-Symbol tippen → Berechtigungen → Standort → Zulassen.',
    'Safari (iPhone/iPad): „aA“ in der Adressleiste → Website-Einstellungen → Standort → Erlauben.',
  ];
  const device = [
    'Android: Einstellungen → Standort → „Standort verwenden“ einschalten.',
    'Android: Einstellungen → Apps → Chrome → Berechtigungen → Standort → „Nur während der Nutzung zulassen“, „Genaue Position“ an.',
    'iPhone/iPad: Einstellungen → Datenschutz & Sicherheit → Ortungsdienste an, darunter Safari-Websites → „Beim Verwenden der App“.',
  ];
  if (o.code === 1) {
    if (o.permission === 'denied') {
      return { title: 'Standort für diese Seite blockiert', steps: [...site, 'Danach die Seite neu laden und „Mein Standort“ erneut antippen.'], retry: true };
    }
    if (o.permission === 'granted') {
      return { title: 'Standort am Gerät aus', steps: [...device, 'Danach „Mein Standort“ erneut antippen.'], retry: true };
    }
    return {
      title: 'Standort nicht freigegeben',
      steps: [...site, ...device, 'Danach die Seite neu laden und „Mein Standort“ erneut antippen.'],
      retry: true,
    };
  }
  if (o.code === 2 || o.code === 3) {
    return {
      title: o.code === 2 ? 'Keine Position gefunden' : 'Position kam nicht rechtzeitig',
      steps: [
        'Standort am Gerät einschalten (Android: Einstellungen → Standort; iPhone: Ortungsdienste).',
        'Unter freiem Himmel dauert der erste GPS-Fix bis zu einer Minute; drinnen oft gar nicht.',
        'Oder den Standpunkt auf der Karte antippen und „Panorama von hier“.',
      ],
      retry: true,
    };
  }
  return {
    title: 'Keine Antwort vom Browser',
    steps: ['Wurde die Standort-Abfrage des Browsers übersehen? „Mein Standort“ erneut antippen und „Zulassen“ wählen.', ...site],
    retry: true,
  };
}

export type LocateResult =
  | { ok: true; position: PickedPosition }
  | { ok: false; message: string; help: LocationHelp };

/**
 * "Mein Standort" with the checks around it: a page that is not https, or a
 * site the browser has already blocked, gets the steps to fix that straight
 * away instead of a request that can only fail; otherwise the device is
 * asked, and a failure is explained with the permission as it stands after
 * the prompt (a "Nicht erlauben" just now reads as blocked).
 */
export async function locateChecked(o: {
  geo?: Geolocation;
  secure: boolean;
  permission: () => Promise<PermissionState | 'unknown'>;
}): Promise<LocateResult> {
  if (!o.secure) {
    return { ok: false, message: 'Standort nicht verfügbar: Seite nicht über https.', help: locationHelp({ code: 1, permission: 'unknown', secure: false }) };
  }
  if ((await o.permission()) === 'denied') {
    return {
      ok: false,
      message: 'Standort für diese Seite blockiert.',
      help: locationHelp({ code: 1, permission: 'denied', secure: true }),
    };
  }
  try {
    return { ok: true, position: await locateDevice(o.geo) };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      help: locationHelp({ code: e instanceof LocateError ? e.code : 0, permission: await o.permission(), secure: true }),
    };
  }
}

/** The site's geolocation permission, where the browser tells. */
export async function sitePermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    return 'unknown';
  }
}
