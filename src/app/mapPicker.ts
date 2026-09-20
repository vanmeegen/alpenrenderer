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

/**
 * Reads the device position once; rejects with a readable German message.
 *
 * The browser's own `timeout` only starts once permission is granted, so a
 * permission prompt left unanswered would hang forever; a watchdog turns
 * that into an error after `watchdogMs`.
 */
export function locateDevice(
  geo: Geolocation | undefined = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
  watchdogMs = 25000,
): Promise<PickedPosition> {
  return new Promise((resolve, reject) => {
    if (!geo) { reject(new Error('Standort nicht verfügbar: kein GPS in diesem Browser.')); return; }
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error('Standort nicht verfügbar: keine Antwort.'))), watchdogMs);
    geo.getCurrentPosition(
      (p) => finish(() => resolve({
        lon: p.coords.longitude, lat: p.coords.latitude, source: 'gps', accuracy: p.coords.accuracy,
      })),
      (e) => finish(() => {
        const why = e.code === e.PERMISSION_DENIED ? 'Zugriff verweigert'
          : e.code === e.TIMEOUT ? 'Zeitüberschreitung' : 'keine Position';
        reject(new Error(`Standort nicht verfügbar: ${why}.`));
      }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
