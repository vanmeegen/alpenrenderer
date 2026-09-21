/**
 * What a photo knows about itself: where it was taken, with which lens, when,
 * and how the sensor was held. JPEG carries the EXIF block in an APP1
 * segment, PNG in an eXIf chunk; both wrap the same little TIFF structure.
 * Only the handful of tags the photo mode needs are read, and nothing here
 * throws: a file without the information yields an empty record.
 */

export interface ExifInfo {
  lon?: number;
  lat?: number;
  /** Metres above sea level. */
  alt?: number;
  /** Focal length in millimetres, and its 35 mm equivalent. */
  focalLength?: number;
  focal35?: number;
  /** `YYYY:MM:DD HH:MM:SS`, as EXIF writes it. */
  taken?: string;
  /** EXIF orientation, 1..8. */
  orientation?: number;
  width?: number;
  height?: number;
}

const TAG = {
  orientation: 0x0112, exifIfd: 0x8769, gpsIfd: 0x8825,
  focalLength: 0x920a, focal35: 0xa405, taken: 0x9003, width: 0xa002, height: 0xa003,
  latRef: 1, lat: 2, lonRef: 3, lon: 4, altRef: 5, alt: 6,
};

/** Locates the TIFF block inside a JPEG (APP1 "Exif") or PNG (eXIf chunk). */
function findTiff(b: Uint8Array): Uint8Array | null {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      const marker = b[p + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      if (marker === 0xe1 && len >= 8 && String.fromCharCode(...b.subarray(p + 4, p + 8)) === 'Exif') {
        return b.subarray(p + 10, p + 2 + len);
      }
      p += 2 + len;
    }
    return null;
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (type === 'eXIf') return b.subarray(p + 8, p + 8 + len);
      if (type === 'IEND') break;
      p += 12 + len;
    }
  }
  return null;
}

export function readExif(input: Uint8Array | ArrayBuffer): ExifInfo {
  const out: ExifInfo = {};
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const t = findTiff(bytes);
    if (!t || t.length < 8) return out;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const le = t[0] === 0x49 && t[1] === 0x49;
    if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return out;
    if (dv.getUint16(2, le) !== 42) return out;
    const u16 = (o: number) => dv.getUint16(o, le);
    const u32 = (o: number) => dv.getUint32(o, le);
    const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

    type Value = number | string | number[];
    const readIfd = (off: number): Map<number, Value> => {
      const m = new Map<number, Value>();
      if (off + 2 > t.length) return m;
      const n = u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > t.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = (SIZE[type] ?? 1) * count;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        if (at + size > t.length) continue;
        if (type === 2) {
          m.set(tag, String.fromCharCode(...t.subarray(at, at + count)).replace(/\0+$/, ''));
        } else if (type === 3) {
          m.set(tag, count === 1 ? u16(at) : Array.from({ length: count }, (_, k) => u16(at + 2 * k)));
        } else if (type === 4) {
          m.set(tag, count === 1 ? u32(at) : Array.from({ length: count }, (_, k) => u32(at + 4 * k)));
        } else if (type === 5 || type === 10) {
          const r = Array.from({ length: count }, (_, k) => {
            const num = type === 5 ? u32(at + 8 * k) : dv.getInt32(at + 8 * k, le);
            const den = type === 5 ? u32(at + 8 * k + 4) : dv.getInt32(at + 8 * k + 4, le);
            return den ? num / den : NaN;     // 0/0 is what a phone without a GPS fix writes
          });
          m.set(tag, count === 1 ? r[0] : r);
        } else if (type === 1) {
          m.set(tag, count === 1 ? t[at] : Array.from(t.subarray(at, at + count)));
        }
      }
      return m;
    };

    const ifd0 = readIfd(u32(4));
    const num = (v: Value | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const orientation = num(ifd0.get(TAG.orientation));
    if (orientation) out.orientation = orientation;

    const exifOff = num(ifd0.get(TAG.exifIfd));
    if (exifOff) {
      const ex = readIfd(exifOff);
      const fl = num(ex.get(TAG.focalLength));
      if (fl) out.focalLength = fl;
      const f35 = num(ex.get(TAG.focal35));
      if (f35) out.focal35 = f35;
      const taken = ex.get(TAG.taken);
      if (typeof taken === 'string' && taken) out.taken = taken;
      const w = num(ex.get(TAG.width)), h = num(ex.get(TAG.height));
      if (w) out.width = w;
      if (h) out.height = h;
    }

    const gpsOff = num(ifd0.get(TAG.gpsIfd));
    if (gpsOff) {
      const g = readIfd(gpsOff);
      const dms = (v: Value | undefined) => {
        if (!Array.isArray(v) || v.length !== 3) return undefined;
        const deg = (v[0] as number) + (v[1] as number) / 60 + (v[2] as number) / 3600;
        return Number.isFinite(deg) ? deg : undefined;
      };
      const lat = dms(g.get(TAG.lat)), lon = dms(g.get(TAG.lon));
      if (lat !== undefined && lon !== undefined) {
        out.lat = g.get(TAG.latRef) === 'S' ? -lat : lat;
        out.lon = g.get(TAG.lonRef) === 'W' ? -lon : lon;
      }
      const alt = num(g.get(TAG.alt));
      if (alt !== undefined) out.alt = g.get(TAG.altRef) === 1 ? -alt : alt;
    }
  } catch {
    /* a damaged block reads as nothing */
  }
  return out;
}

/**
 * Vertical field of view of the photo, degrees, for a frame of `width` by
 * `height` pixels. A 35 mm equivalent focal length is read with the frame's
 * long side as the 36 mm of a 36×24 mm frame; the short side follows from the
 * aspect. On a 3:2 frame that is the classic 24 mm short side. A phone's
 * 20:9 wide shot is a crop of its 4:3 sensor that keeps the full width, so
 * it is a much flatter frame under the same equivalent: reading its short
 * side as 24 mm would draw the terrain a third too tall (53° instead of
 * 37°). Without an equivalent, the bare focal length assumes a phone-sized
 * 1/2.55" sensor (6.3 mm along the long side); with neither, unknown.
 */
export function fovFromExif(x: Pick<ExifInfo, 'focal35' | 'focalLength'>, width: number, height: number): number | undefined {
  const share = height / Math.max(width, height);       // the long side's share that is vertical
  if (x.focal35) return (2 * Math.atan((18 * share) / x.focal35) * 180) / Math.PI;
  if (x.focalLength) return (2 * Math.atan((3.15 * share) / x.focalLength) * 180) / Math.PI;
  return undefined;
}
