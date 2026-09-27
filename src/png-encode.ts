import { deflateSync } from 'node:zlib';

import { crc32, PNG_SIGNATURE } from './png.ts';

/**
 * A minimal PNG encoder — the decoder's mirror image.
 *
 * The diff command renders images of its own making, and an encoder dependency would be
 * this package's only runtime one. This writes the one layout every consumer here reads:
 * 8-bit RGBA, one Sub-filtered scanline per row, a single IDAT.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng needs positive integer dimensions, got ${width}x${height}`);
  }
  const bytes = width * height * 4;
  if (rgba.length !== bytes) {
    throw new Error(
      `pixel buffer holds ${rgba.length} bytes, but a ${width}x${height} image needs exactly ${bytes}`,
    );
  }

  // Filter type 1 (Sub) on every row: the pixel to the left is a good predictor for the
  // flat UI colours screenshots consist of, and one fixed type spares a second pass over
  // the pixels choosing per row.
  const stride = width * 4;
  const stream = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const src = y * stride;
    stream[row] = 1;
    for (let i = 0; i < stride; i++) {
      const here = rgba[src + i] ?? 0;
      const left = i >= 4 ? (rgba[src + i - 4] ?? 0) : 0;
      stream[row + 1 + i] = (here - left) & 0xff;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  // Bytes 10–12 stay zero: deflate compression, per-scanline filtering, no interlace.

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(stream)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A length-prefixed, CRC-suffixed chunk — the same shape `readChunk` in png.ts verifies. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < type.length; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, 8 + data.length)));
  return out;
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
