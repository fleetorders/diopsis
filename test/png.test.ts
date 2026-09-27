import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { decodePng, pngSize } from '../src/png.ts';

/**
 * A tiny PNG *encoder*, private to these tests. The decoder is never fed bytes it built
 * itself: filters are applied forward here, and every chunk's CRC comes from a bitwise
 * routine deliberately unlike the table-driven one in src/png.ts, so a shared mistake
 * cannot make both sides agree. The standard check value below pins this oracle to the
 * spec, and the decoder is then pinned to the oracle.
 */
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] ?? 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distLeft = Math.abs(estimate - left);
  const distUp = Math.abs(estimate - up);
  const distUpLeft = Math.abs(estimate - upLeft);
  if (distLeft <= distUp && distLeft <= distUpLeft) return left;
  if (distUp <= distUpLeft) return up;
  return upLeft;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

interface PngSpec {
  width: number;
  height: number;
  colourType: number;
  bitDepth: number;
  /** Unfiltered pixel bytes: `width * height` pixels of `channels * sampleBytes` bytes each. */
  raw: Uint8Array;
  /** One filter type for every scanline, or one per scanline. */
  filters: number | number[];
  palette?: Uint8Array;
  trns?: Uint8Array;
  interlace?: number;
  /** Split the compressed stream across this many IDAT chunks to exercise reassembly. */
  idatParts?: number;
  /** Leave the last N scanlines out of the stream, while IHDR still claims the full height. */
  dropRows?: number;
}

function encodePng(spec: PngSpec): Uint8Array {
  const channels = CHANNELS[spec.colourType] ?? 1;
  const sampleBytes = spec.bitDepth === 16 ? 2 : 1;
  const bytesPerPixel = channels * sampleBytes;
  const stride = spec.width * bytesPerPixel;
  const rows = spec.height - (spec.dropRows ?? 0);
  const stream = new Uint8Array(rows * (stride + 1));
  for (let y = 0; y < rows; y++) {
    const filter = typeof spec.filters === 'number' ? spec.filters : (spec.filters[y] ?? 0);
    const dst = y * (stride + 1);
    stream[dst] = filter;
    const src = y * stride;
    // Forward filtering always predicts from the *original* neighbour bytes, which is why
    // this reads `spec.raw` and never the half-filtered output.
    for (let i = 0; i < stride; i++) {
      const here = spec.raw[src + i] ?? 0;
      const left = i >= bytesPerPixel ? (spec.raw[src + i - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (spec.raw[src - stride + i] ?? 0) : 0;
      const upLeft = i >= bytesPerPixel && y > 0 ? (spec.raw[src - stride + i - bytesPerPixel] ?? 0) : 0;
      let out: number;
      switch (filter) {
        case 0: out = here; break;
        case 1: out = here - left; break;
        case 2: out = here - up; break;
        case 3: out = here - ((left + up) >> 1); break;
        case 4: out = here - paeth(left, up, upLeft); break;
        default: throw new Error(`the test encoder cannot apply filter ${filter}`);
      }
      stream[dst + 1 + i] = out & 0xff;
    }
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, spec.width);
  headerView.setUint32(4, spec.height);
  header[8] = spec.bitDepth;
  header[9] = spec.colourType;
  header[12] = spec.interlace ?? 0;

  const compressed = deflateSync(stream);
  const parts = spec.idatParts && spec.idatParts > 1 ? splitAcross(compressed, spec.idatParts) : [compressed];
  const chunks = [chunk('IHDR', header)];
  if (spec.palette) chunks.push(chunk('PLTE', spec.palette));
  if (spec.trns) chunks.push(chunk('tRNS', spec.trns));
  for (const part of parts) chunks.push(chunk('IDAT', part));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return concat([SIGNATURE, ...chunks]);
}

function splitAcross(bytes: Uint8Array, parts: number): Uint8Array[] {
  const size = Math.ceil(bytes.length / parts);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  return out;
}

/**
 * A pattern that varies with x, y and channel: uniform data would make every filter
 * produce identical bytes, and the filter tests would prove nothing.
 */
function rgbaPattern(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(width * height * 4);
  let at = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        raw[at++] = (x * 37 + y * 61 + c * 17) % 251;
      }
    }
  }
  return raw;
}

function sample16(x: number, y: number, c: number): number {
  return (x * 97 + y * 131 + c * 53) % 65536;
}

describe('crc32 (test oracle)', () => {
  it('matches the standard check value', () => {
    assert.equal(crc32(ascii('123456789')), 0xcbf43926);
  });
});

describe('decodePng', () => {
  const width = 5;
  const height = 4;

  it('round-trips an RGBA pattern through each of the five filter types', () => {
    const raw = rgbaPattern(width, height);
    for (let filter = 0; filter <= 4; filter++) {
      const decoded = decodePng(encodePng({ width, height, colourType: 6, bitDepth: 8, raw, filters: filter }));
      assert.equal(decoded.width, width, `filter ${filter}`);
      assert.equal(decoded.height, height, `filter ${filter}`);
      assert.deepEqual(decoded.rgba, raw, `filter ${filter}`);
    }
  });

  it('mixes filter types freely across the rows of one image', () => {
    const raw = rgbaPattern(width, 6);
    const png = encodePng({ width, height: 6, colourType: 6, bitDepth: 8, raw, filters: [4, 1, 0, 3, 2, 4] });
    assert.deepEqual(decodePng(png).rgba, raw);
  });

  it('decodes RGB as opaque RGBA', () => {
    const raw = new Uint8Array(width * height * 3);
    const expected = new Uint8Array(width * height * 4);
    let r = 0;
    let e = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          const value = (x * 41 + y * 89 + c * 15) % 256;
          raw[r++] = value;
          expected[e++] = value;
        }
        expected[e++] = 255;
      }
    }
    const decoded = decodePng(encodePng({ width, height, colourType: 2, bitDepth: 8, raw, filters: 3 }));
    assert.deepEqual(decoded.rgba, expected);
  });

  it('decodes greyscale by triplication', () => {
    const raw = new Uint8Array(width * height);
    const expected = new Uint8Array(width * height * 4);
    for (let i = 0; i < raw.length; i++) {
      const grey = (i * 7 + 13) % 256;
      raw[i] = grey;
      expected[i * 4] = grey;
      expected[i * 4 + 1] = grey;
      expected[i * 4 + 2] = grey;
      expected[i * 4 + 3] = 255;
    }
    const decoded = decodePng(encodePng({ width, height, colourType: 0, bitDepth: 8, raw, filters: 4 }));
    assert.deepEqual(decoded.rgba, expected);
  });

  it('decodes greyscale with its own alpha channel', () => {
    const raw = new Uint8Array(width * height * 2);
    const expected = new Uint8Array(width * height * 4);
    let r = 0;
    let e = 0;
    for (let i = 0; i < width * height; i++) {
      const grey = (i * 11 + 5) % 256;
      const alpha = (i * 3 + 29) % 256;
      raw[r++] = grey;
      raw[r++] = alpha;
      expected[e++] = grey;
      expected[e++] = grey;
      expected[e++] = grey;
      expected[e++] = alpha;
    }
    const decoded = decodePng(encodePng({ width, height, colourType: 4, bitDepth: 8, raw, filters: 1 }));
    assert.deepEqual(decoded.rgba, expected);
  });

  it('maps palette indices through PLTE and takes alpha from tRNS', () => {
    const palette = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255);
    // Only the first two entries have an alpha in tRNS; the rest must default to opaque.
    const trns = Uint8Array.of(200, 100);
    const indices = new Uint8Array(width * height);
    const expected = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const index = i % 4;
      indices[i] = index;
      expected[i * 4] = palette[index * 3] ?? 0;
      expected[i * 4 + 1] = palette[index * 3 + 1] ?? 0;
      expected[i * 4 + 2] = palette[index * 3 + 2] ?? 0;
      expected[i * 4 + 3] = index < trns.length ? (trns[index] ?? 255) : 255;
    }
    const decoded = decodePng(
      encodePng({ width, height, colourType: 3, bitDepth: 8, raw: indices, filters: 2, palette, trns }),
    );
    assert.deepEqual(decoded.rgba, expected);
  });

  it('decodes a palette image without tRNS as fully opaque', () => {
    const palette = Uint8Array.of(10, 20, 30, 40, 50, 60);
    const indices = Uint8Array.of(0, 1, 1, 0);
    const decoded = decodePng(
      encodePng({ width: 2, height: 2, colourType: 3, bitDepth: 8, raw: indices, filters: 0, palette }),
    );
    assert.deepEqual(decoded.rgba, Uint8Array.of(10, 20, 30, 255, 40, 50, 60, 255, 40, 50, 60, 255, 10, 20, 30, 255));
  });

  it('keeps only the high byte of 16-bit RGBA', () => {
    const raw = new Uint8Array(width * height * 8);
    const expected = new Uint8Array(width * height * 4);
    let r = 0;
    let e = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          const sample = sample16(x, y, c);
          raw[r++] = sample >>> 8;
          raw[r++] = sample & 0xff;
          expected[e++] = sample >>> 8;
        }
      }
    }
    const decoded = decodePng(encodePng({ width, height, colourType: 6, bitDepth: 16, raw, filters: 4 }));
    assert.deepEqual(decoded.rgba, expected);
  });

  it('keeps only the high byte of 16-bit RGB, opaque', () => {
    const raw = new Uint8Array(width * height * 6);
    const expected = new Uint8Array(width * height * 4);
    let r = 0;
    let e = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          const sample = sample16(x, y, c);
          raw[r++] = sample >>> 8;
          raw[r++] = sample & 0xff;
          expected[e++] = sample >>> 8;
        }
        expected[e++] = 255;
      }
    }
    const decoded = decodePng(encodePng({ width, height, colourType: 2, bitDepth: 16, raw, filters: 3 }));
    assert.deepEqual(decoded.rgba, expected);
  });

  it('reassembles image data split across several IDAT chunks', () => {
    const raw = rgbaPattern(width, height);
    const png = encodePng({ width, height, colourType: 6, bitDepth: 8, raw, filters: 2, idatParts: 3 });
    assert.deepEqual(decodePng(png).rgba, raw);
  });

  it('rejects a corrupted CRC in the image data', () => {
    const png = encodePng({ width, height, colourType: 6, bitDepth: 8, raw: rgbaPattern(width, height), filters: 0 });
    const idat = indexOfBytes(png, ascii('IDAT'));
    assert.notEqual(idat, -1);
    png[idat + 10] = (png[idat + 10] ?? 0) ^ 0xff;
    assert.throws(() => decodePng(png), /CRC mismatch in IDAT/);
  });

  it('verifies the CRC of structural chunks too, not just the image data', () => {
    const png = encodePng({ width, height, colourType: 6, bitDepth: 8, raw: rgbaPattern(width, height), filters: 0 });
    const iend = indexOfBytes(png, ascii('IEND'));
    assert.notEqual(iend, -1);
    png[iend + 3] = (png[iend + 3] ?? 0) ^ 0x01;
    assert.throws(() => decodePng(png), /CRC mismatch in IENE/);
  });

  it('rejects a truncated file', () => {
    const png = encodePng({ width, height, colourType: 6, bitDepth: 8, raw: rgbaPattern(width, height), filters: 1 });
    assert.throws(() => decodePng(png.subarray(0, png.length - 7)), /truncated/);
  });

  it('rejects interlaced images', () => {
    const raw = rgbaPattern(width, height);
    assert.throws(
      () => decodePng(encodePng({ width, height, colourType: 6, bitDepth: 8, raw, filters: 0, interlace: 1 })),
      /interlac/,
    );
  });

  it('rejects a file that is not a PNG', () => {
    const png = encodePng({ width: 1, height: 1, colourType: 6, bitDepth: 8, raw: new Uint8Array(4), filters: 0 });
    png[0] = (png[0] ?? 0) ^ 0x01;
    assert.throws(() => decodePng(png), /signature/);
  });

  it('rejects bit depths outside the supported set', () => {
    // Depth 1 greyscale and 16-bit greyscale+alpha are legal PNG but outside the subset.
    assert.throws(
      () => encodeAndDecode({ width: 2, height: 2, colourType: 0, bitDepth: 1, raw: new Uint8Array(4), filters: 0 }),
      /bit depth 1 for colour type 0/,
    );
    assert.throws(
      () => encodeAndDecode({ width: 2, height: 2, colourType: 4, bitDepth: 16, raw: new Uint8Array(8), filters: 0 }),
      /bit depth 16 for colour type 4/,
    );
  });

  it('rejects unsupported colour types', () => {
    assert.throws(
      () => encodeAndDecode({ width: 2, height: 2, colourType: 5, bitDepth: 8, raw: new Uint8Array(8), filters: 0 }),
      /colour type 5/,
    );
  });

  it('rejects a palette image with no PLTE chunk', () => {
    assert.throws(
      () => encodeAndDecode({ width: 2, height: 2, colourType: 3, bitDepth: 8, raw: Uint8Array.of(0, 0, 0, 0), filters: 0 }),
      /PLTE/,
    );
  });

  it('rejects image data that decompresses to the wrong size', () => {
    const raw = rgbaPattern(width, 4);
    const png = encodePng({ width, height: 4, colourType: 6, bitDepth: 8, raw, filters: 0, dropRows: 1 });
    assert.throws(() => decodePng(png), /decompresses to .* but a 5x4 image needs exactly/);
  });
});

function encodeAndDecode(spec: PngSpec): ReturnType<typeof decodePng> {
  return decodePng(encodePng(spec));
}

describe('pngSize', () => {
  it('reads the dimensions from the header of a full file', () => {
    const raw = rgbaPattern(7, 3);
    const png = encodePng({ width: 7, height: 3, colourType: 6, bitDepth: 8, raw, filters: 0 });
    assert.deepEqual(pngSize(png), { width: 7, height: 3 });
  });

  it('reads dimensions from a header whose image data is missing entirely', () => {
    const raw = rgbaPattern(4, 2);
    const png = encodePng({ width: 4, height: 2, colourType: 6, bitDepth: 8, raw, filters: 0 });
    // Signature (8 bytes) plus the IHDR chunk (12 + 13 bytes) and nothing after it.
    const headerOnly = png.subarray(0, 8 + 25);
    assert.deepEqual(pngSize(headerOnly), { width: 4, height: 2 });
    assert.throws(() => decodePng(headerOnly), /truncated/);
  });

  it('rejects a file that is not a PNG', () => {
    assert.throws(() => pngSize(new Uint8Array(64).fill(0)), /signature/);
  });
});
