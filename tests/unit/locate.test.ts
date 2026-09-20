import { describe, expect, test } from 'bun:test';
import { locateDevice } from '../../src/app/mapPicker';

type Success = (p: GeolocationPosition) => void;
type Failure = (e: GeolocationPositionError) => void;

/** A Geolocation that answers the way the test says. */
function geo(behaviour: (ok: Success, fail: Failure) => void): Geolocation {
  return { getCurrentPosition: (ok, fail) => behaviour(ok, fail!) } as unknown as Geolocation;
}

const positionError = (code: number): GeolocationPositionError => ({
  code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
});

describe('locateDevice', () => {
  test('resolves with the fix, marked as GPS, with its accuracy', async () => {
    const g = geo((ok) => ok({ coords: { latitude: 47.5, longitude: 11.1, accuracy: 6 } } as GeolocationPosition));
    expect(await locateDevice(g)).toEqual({ lon: 11.1, lat: 47.5, source: 'gps', accuracy: 6 });
  });

  test('a refusal is a readable error', async () => {
    const g = geo((_ok, fail) => fail(positionError(1)));
    await expect(locateDevice(g)).rejects.toThrow('Standort nicht verfügbar: Zugriff verweigert.');
  });

  test('no geolocation at all is a readable error', async () => {
    await expect(locateDevice(undefined)).rejects.toThrow('Standort nicht verfügbar');
  });

  test('a browser that never answers (permission prompt left open) is not waited on forever', async () => {
    const g = geo(() => { /* never calls back */ });
    const t0 = Date.now();
    await expect(locateDevice(g, 50)).rejects.toThrow('Standort nicht verfügbar: keine Antwort.');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a late answer after the watchdog is ignored, not a second resolution', async () => {
    let late: Success | null = null;
    const g = geo((ok) => { late = ok; });
    await expect(locateDevice(g, 20)).rejects.toThrow();
    // Calling back now must not throw or do anything.
    late!({ coords: { latitude: 1, longitude: 2, accuracy: 3 } } as GeolocationPosition);
  });
});
