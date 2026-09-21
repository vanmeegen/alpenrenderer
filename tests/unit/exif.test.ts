/**
 * Reading what a photo knows about itself: where it was taken (GPS), the
 * lens (focal length, 35 mm equivalent), when, and how the sensor was held.
 * JPEG carries it in an APP1 segment, PNG in an eXIf chunk; both wrap the
 * same TIFF structure, built here by hand so nothing depends on a library.
 */
import { describe, expect, test } from 'bun:test';
import { fovFromExif, readExif } from '../../src/app/exif';

// --- a tiny TIFF/EXIF writer ---------------------------------------------
type Entry = { tag: number; type: number; value: number[] | string | [number, number][] };

function ifd(entries: Entry[], offset: number, extra: { tag: number; ifdOffset: number }[] = []): { bytes: Buffer; end: number } {
  const all = [...entries, ...extra.map((e) => ({ tag: e.tag, type: 4, value: [e.ifdOffset] }))].sort((a, b) => a.tag - b.tag);
  const head = 2 + all.length * 12 + 4;
  let dataOff = offset + head;
  const dir = Buffer.alloc(head);
  const data: Buffer[] = [];
  dir.writeUInt16LE(all.length, 0);
  all.forEach((e, i) => {
    const o = 2 + i * 12;
    dir.writeUInt16LE(e.tag, o);
    dir.writeUInt16LE(e.type, o + 2);
    let payload: Buffer;
    let count: number;
    if (e.type === 1) { const v = e.value as number[]; count = v.length; payload = Buffer.from(v); }
    else if (e.type === 2) { payload = Buffer.from(e.value as string + '\0', 'ascii'); count = payload.length; }
    else if (e.type === 3) { const v = e.value as number[]; count = v.length; payload = Buffer.alloc(2 * count); v.forEach((x, k) => payload.writeUInt16LE(x, k * 2)); }
    else if (e.type === 4) { const v = e.value as number[]; count = v.length; payload = Buffer.alloc(4 * count); v.forEach((x, k) => payload.writeUInt32LE(x, k * 4)); }
    else { const v = e.value as [number, number][]; count = v.length; payload = Buffer.alloc(8 * count); v.forEach(([n, d], k) => { payload.writeUInt32LE(n, k * 8); payload.writeUInt32LE(d, k * 8 + 4); }); }
    dir.writeUInt32LE(count, o + 4);
    if (payload.length <= 4) payload.copy(dir, o + 8);
    else { dir.writeUInt32LE(dataOff, o + 8); data.push(payload); dataOff += payload.length; }
  });
  return { bytes: Buffer.concat([dir, ...data]), end: dataOff };
}

/** TIFF with IFD0 (orientation, pointers), Exif IFD (lens, time, size) and GPS IFD. */
function tiff(opt: { lon?: number; lat?: number; alt?: number; focal?: number; focal35?: number; taken?: string; orientation?: number; w?: number; h?: number; gpsNoFix?: boolean }): Buffer {
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);   // II, 42, IFD0 at 8
  const dms = (deg: number): [number, number][] => {
    const a = Math.abs(deg);
    const d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 1000);
    return [[d, 1], [m, 1], [s, 1000]];
  };
  const exifEntries: Entry[] = [];
  if (opt.focal !== undefined) exifEntries.push({ tag: 0x920a, type: 5, value: [[Math.round(opt.focal * 100), 100]] });
  if (opt.focal35 !== undefined) exifEntries.push({ tag: 0xa405, type: 3, value: [opt.focal35] });
  if (opt.taken) exifEntries.push({ tag: 0x9003, type: 2, value: opt.taken });
  if (opt.w) exifEntries.push({ tag: 0xa002, type: 4, value: [opt.w] });
  if (opt.h) exifEntries.push({ tag: 0xa003, type: 4, value: [opt.h] });
  const gpsEntries: Entry[] = [];
  if (opt.lat !== undefined && opt.lon !== undefined) {
    gpsEntries.push({ tag: 1, type: 2, value: opt.lat >= 0 ? 'N' : 'S' }, { tag: 2, type: 5, value: dms(opt.lat) });
    gpsEntries.push({ tag: 3, type: 2, value: opt.lon >= 0 ? 'E' : 'W' }, { tag: 4, type: 5, value: dms(opt.lon) });
  }
  if (opt.gpsNoFix) {
    // What a phone without a fix writes (OnePlus Open, 2026): a full GPS
    // block whose rationals are all 0/0.
    const zero: [number, number][] = [[0, 0], [0, 0], [0, 0]];
    gpsEntries.push({ tag: 1, type: 2, value: '\0' }, { tag: 2, type: 5, value: zero }, { tag: 3, type: 2, value: '\0' }, { tag: 4, type: 5, value: zero }, { tag: 6, type: 5, value: [[0, 0]] });
  }
  if (opt.alt !== undefined) gpsEntries.push({ tag: 5, type: 1, value: [opt.alt < 0 ? 1 : 0] }, { tag: 6, type: 5, value: [[Math.round(Math.abs(opt.alt) * 10), 10]] });
  // Lay out: IFD0 at 8, then Exif IFD, then GPS IFD.
  const ifd0Entries: Entry[] = opt.orientation ? [{ tag: 0x0112, type: 3, value: [opt.orientation] }] : [];
  const ifd0Size = 2 + (ifd0Entries.length + (exifEntries.length ? 1 : 0) + (gpsEntries.length ? 1 : 0)) * 12 + 4;
  const exifOff = 8 + ifd0Size;
  const exif = exifEntries.length ? ifd(exifEntries, exifOff) : null;
  const gpsOff = exif ? exif.end : exifOff;
  const gps = gpsEntries.length ? ifd(gpsEntries, gpsOff) : null;
  const ifd0 = ifd(ifd0Entries, 8, [
    ...(exif ? [{ tag: 0x8769, ifdOffset: exifOff }] : []),
    ...(gps ? [{ tag: 0x8825, ifdOffset: gpsOff }] : []),
  ]);
  return Buffer.concat([header, ifd0.bytes, ...(exif ? [exif.bytes] : []), ...(gps ? [gps.bytes] : [])]);
}

function jpegWith(t: Buffer): Uint8Array {
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), t]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]));
}

function pngWith(t: Buffer): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);   // CRC not checked
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(6, 4);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('eXIf', t), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const GORNERGRAT = { lon: 7.78472, lat: 45.98333, alt: 3135, focal: 4.25, focal35: 26, taken: '2026:08:14 10:22:31', orientation: 1, w: 4032, h: 3024 };

describe('readExif', () => {
  test('reads position, altitude, lens, time and size from a JPEG', () => {
    const x = readExif(jpegWith(tiff(GORNERGRAT)));
    expect(x.lat).toBeCloseTo(45.98333, 4);
    expect(x.lon).toBeCloseTo(7.78472, 4);
    expect(x.alt).toBeCloseTo(3135, 0);
    expect(x.focalLength).toBeCloseTo(4.25, 2);
    expect(x.focal35).toBe(26);
    expect(x.taken).toBe('2026:08:14 10:22:31');
    expect(x.orientation).toBe(1);
    expect(x.width).toBe(4032);
    expect(x.height).toBe(3024);
  });

  test('southern and western hemispheres are negative, altitude below sea level too', () => {
    const x = readExif(jpegWith(tiff({ lon: -70.5, lat: -33.25, alt: -12 })));
    expect(x.lat).toBeCloseTo(-33.25, 4);
    expect(x.lon).toBeCloseTo(-70.5, 4);
    expect(x.alt).toBeCloseTo(-12, 0);
  });

  test('the same block inside a PNG eXIf chunk reads the same', () => {
    const x = readExif(pngWith(tiff(GORNERGRAT)));
    expect(x.lat).toBeCloseTo(45.98333, 4);
    expect(x.focal35).toBe(26);
  });

  test('a GPS block of 0/0 rationals (a phone that had no fix) gives no position, not Null Island', () => {
    const x = readExif(jpegWith(tiff({ gpsNoFix: true, focal: 6.06, focal35: 47 })));
    expect(x.lat).toBeUndefined();
    expect(x.lon).toBeUndefined();
    expect(x.alt).toBeUndefined();
    expect(x.focal35).toBe(47);
  });

  test('a photo without EXIF, or a file that is not an image, yields nothing and no error', () => {
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({});
    expect(readExif(new Uint8Array([1, 2, 3]))).toEqual({});
    expect(readExif(jpegWith(tiff({})))).toEqual({});
  });
});

describe('fovFromExif', () => {
  const deg = (x: number) => (x * 180) / Math.PI;
  test('a 26 mm equivalent lens on a 3:2 frame sees 49.5° vertically in landscape and 69.4° in portrait', () => {
    expect(fovFromExif({ focal35: 26 }, 3000, 2000)).toBeCloseTo(deg(2 * Math.atan(12 / 26)), 2);
    expect(fovFromExif({ focal35: 26 }, 2000, 3000)).toBeCloseTo(deg(2 * Math.atan(18 / 26)), 2);
  });

  test('the equivalence is by the diagonal: a 24 mm lens on a 20:9 phone frame sees 40.5° vertically, not 53°', () => {
    // A 4000×1800 photo from a phone in its wide mode. The short side of a
    // 36×24 mm frame would give 53°, and the drawn terrain would be a third
    // too tall for the photo. CIPA defines the 35 mm equivalent over the
    // diagonal (43.27 mm), which puts the vertical field at 40.5°.
    const f = fovFromExif({ focal35: 24 }, 4000, 1800)!;
    expect(f).toBeCloseTo(deg(2 * Math.atan((21.63 * (1800 / Math.hypot(4000, 1800))) / 24)), 1);
    expect(f).toBeLessThan(42);
    // The same lens on a 4:3 frame: 57.5° vertically.
    expect(fovFromExif({ focal35: 24 }, 4000, 3000)!).toBeCloseTo(deg(2 * Math.atan((21.63 * 0.6) / 24)), 1);
  });

  test('without a 35 mm equivalent, a bare focal length assumes a phone sensor; nothing gives undefined', () => {
    const f = fovFromExif({ focalLength: 4.25 }, 4000, 3000)!;
    expect(f).toBeGreaterThan(40);
    expect(f).toBeLessThan(65);
    expect(fovFromExif({}, 4000, 3000)).toBeUndefined();
  });
});
