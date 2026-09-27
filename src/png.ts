import { inflateSync } from 'node:zlib';

/**
 * A minimal PNG decoder.
 *
 * The report engine needs the pixels of images it already holds as bytes, and a full PNG
 * stack would be this package's only runtime dependency. So this module reads the subset
 * of the format that non-interlaced screenshot encoders emit, and rejects everything else
 * with a specific error: an input it cannot represent exactly is never half-decoded.
 */

/** A decoded image: `rgba` packs one byte per channel, row-major, `width * height * 4` bytes. */
export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Channels per colour type; a type missing from this map is rejected outright. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * CRC-32 as PNG defines it (polynomial 0xEDB88320, reflected input and output). A table
 * of per-byte remainders keeps verification cheap on multi-megabyte IDAT streams, which
 * is the only place where a per-bit loop would be felt.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `0x1a2b3c4d` — CRC values are unreadable in decimal, and a mismatch report needs both. */
function hex32(n: number): string {
  return `0x${n.toString(16).padStart(8, '0')}`;
}

interface Chunk {
  type: string;
  data: Uint8Array;
  /** Offset of the next chunk header; points past the CRC. */
  next: number;
}

/**
 * Reads one chunk and verifies its CRC before handing anything back. A wrong CRC means
 * the file was corrupted in transit or by a bad write, and decoding it anyway would
 * produce confident-looking pixels that were never encoded.
 */
function readChunk(view: DataView, bytes: Uint8Array, offset: number): Chunk {
  if (offset + 8 > bytes.length) {
    throw new Error(`PNG is truncated: a chunk header at byte ${offset} runs past the end of the file`);
  }
  const length = view.getUint32(offset);
  if (length > 0x7fffffff) {
    throw new Error(`PNG chunk at byte ${offset} declares an impossible length of ${length} bytes`);
  }
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  if (dataEnd + 4 > bytes.length) {
    throw new Error(`PNG is truncated: the ${length}-byte chunk at byte ${offset} runs past the end of the file`);
  }
  const type = String.fromCharCode(...bytes.subarray(offset + 4, dataStart));
  const stored = view.getUint32(dataEnd);
  const computed = crc32(bytes.subarray(offset + 4, dataEnd));
  if (computed !== stored) {
    throw new Error(
      `CRC mismatch in ${type} chunk at byte ${offset}: stored ${hex32(stored)}, computed ${hex32(computed)}`,
    );
  }
  return { type, data: bytes.subarray(dataStart, dataEnd), next: dataEnd + 4 };
}

function checkSignature(bytes: Uint8Array): void {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new Error('not a PNG file: the leading signature does not match');
    }
  }
}

interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

function parseIhdr(data: Uint8Array): Ihdr {
  if (data.length !== 13) {
    throw new Error(`IHDR must be 13 bytes of data, got ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  if (width === 0 || height === 0) {
    throw new Error(`PNG declares a ${width}x${height} image, which has no pixels`);
  }
  const compression = data[10] ?? 0;
  const filterMethod = data[11] ?? 0;
  if (compression !== 0) {
    throw new Error(`unknown compression method ${compression}; only method 0 (zlib/deflate) exists in PNG`);
  }
  if (filterMethod !== 0) {
    throw new Error(`unknown filter method ${filterMethod}; only method 0 (per-scanline adaptive) exists in PNG`);
  }
  return {
    width,
    height,
    bitDepth: data[8] ?? 0,
    colourType: data[9] ?? 0,
    interlace: data[12] ?? 0,
  };
}

/** The header plus the offset of the chunk that follows it. */
function readIhdr(view: DataView, bytes: Uint8Array): { header: Ihdr; next: number } {
  checkSignature(bytes);
  const first = readChunk(view, bytes, 8);
  if (first.type !== 'IHDR') {
    throw new Error(`the first PNG chunk is ${first.type}, not IHDR`);
  }
  return { header: parseIhdr(first.data), next: first.next };
}

/** Width and height from IHDR alone: no decompression, no walk past the first chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { header } = readIhdr(view, bytes);
  return { width: header.width, height: header.height };
}

/**
 * Validates the sample layout and returns its channel count.
 *
 * Eight bits per sample covers every colour type; sixteen is only worth carrying for
 * truecolour, where encoders actually emit it, and the high byte is all a byte-per-channel
 * pipeline can keep anyway. Interlacing is ruled out by the caller because it reshapes the
 * whole scanline loop for a mode screenshots are simply never encoded in.
 */
function channelsFor(colourType: number, bitDepth: number): number {
  const channels = CHANNELS[colourType];
  if (channels === undefined) {
    throw new Error(`unsupported colour type ${colourType}; expected one of 0, 2, 3, 4, 6`);
  }
  const legalDepths = colourType === 2 || colourType === 6 ? [8, 16] : [8];
  if (!legalDepths.includes(bitDepth)) {
    throw new Error(`unsupported bit depth ${bitDepth} for colour type ${colourType}; expected ${legalDepths.join(' or ')}`);
  }
  return channels;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { header, next: afterIhdr } = readIhdr(view, bytes);
  const { width, height, bitDepth, colourType, interlace } = header;
  if (interlace !== 0) {
    throw new Error('interlaced PNG (Adam7) is not supported; the image must be re-encoded without interlacing');
  }
  const channels = channelsFor(colourType, bitDepth);
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const stride = width * channels * sampleBytes;
  const bytesPerPixel = channels * sampleBytes;

  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  for (let offset = afterIhdr; ; ) {
    const chunk = readChunk(view, bytes, offset);
    if (chunk.type === 'IEND') break;
    // Ancillary and unrecognised chunks are skipped, but every one of them was still
    // CRC-checked inside readChunk, so corruption anywhere in the file is caught.
    if (chunk.type === 'IDAT') idat.push(chunk.data);
    else if (chunk.type === 'PLTE') palette = chunk.data;
    else if (chunk.type === 'tRNS') transparency = chunk.data;
    offset = chunk.next;
  }

  if (colourType === 3) {
    if (palette === undefined) {
      throw new Error('palette image is missing its PLTE chunk');
    }
    if (palette.length === 0 || palette.length % 3 !== 0) {
      throw new Error(`PLTE holds ${palette.length} bytes, which is not a positive whole number of RGB entries`);
    }
    if (transparency !== undefined && transparency.length > palette.length / 3) {
      throw new Error('tRNS holds more alpha entries than the palette has colours');
    }
  }

  if (idat.length === 0) {
    throw new Error('PNG has no IDAT chunk, so it carries no image data');
  }
  const single = idat.length === 1 ? idat[0] : undefined;
  const compressed = single ?? concatBytes(idat);
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(compressed);
  } catch (cause) {
    throw new Error('PNG image data does not decompress', { cause });
  }
  // The declared dimensions decide how many bytes the stream must hold, which also
  // guarantees every later allocation is proportionate to the actual file.
  const expected = height * (stride + 1);
  if (inflated.length !== expected) {
    throw new Error(
      `PNG image data decompresses to ${inflated.length} bytes, but a ${width}x${height} image needs exactly ${expected}`,
    );
  }

  unfilter(inflated, height, stride, bytesPerPixel);
  const rgba = toRgba(inflated, width, height, stride, bytesPerPixel, colourType, palette, transparency);
  return { width, height, rgba };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Reverses the per-scanline filters, in place.
 *
 * Each filtered byte is the original minus a predictor built from neighbouring bytes that
 * have already been reconstructed, so reconstruction is the same addition run forward,
 * which is why one in-place pass suffices. `bpp` is a whole number of pixels because the
 * supported depths are all byte-aligned.
 */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): void {
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const start = row + 1;
    const above = start - (stride + 1);
    switch (raw[row] ?? 0) {
      case 0: // None: the scanline was stored as is.
        break;
      case 1: // Sub: predictor is the byte one pixel (bpp bytes) to the left.
        for (let i = bpp; i < stride; i++) {
          raw[start + i] = ((raw[start + i] ?? 0) + (raw[start + i - bpp] ?? 0)) & 0xff;
        }
        break;
      case 2: // Up: predictor is the byte directly above; the first row predicts against zero.
        if (y > 0) {
          for (let i = 0; i < stride; i++) {
            raw[start + i] = ((raw[start + i] ?? 0) + (raw[above + i] ?? 0)) & 0xff;
          }
        }
        break;
      case 3: // Average: predictor is floor((left + above) / 2).
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? (raw[start + i - bpp] ?? 0) : 0;
          const up = y > 0 ? (raw[above + i] ?? 0) : 0;
          raw[start + i] = ((raw[start + i] ?? 0) + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth: the nearest of left, above, above-left, ties broken in that order.
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? (raw[start + i - bpp] ?? 0) : 0;
          const up = y > 0 ? (raw[above + i] ?? 0) : 0;
          const upLeft = i >= bpp && y > 0 ? (raw[above + i - bpp] ?? 0) : 0;
          raw[start + i] = ((raw[start + i] ?? 0) + paethPredictor(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new Error(`unknown filter type ${raw[row] ?? 0} on scanline ${y}`);
    }
  }
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  // The predictor is left + up - upLeft; picking whichever of the three neighbours is
  // nearest to it minimises the stored remainder, which is the filter's whole purpose.
  const estimate = left + up - upLeft;
  const distLeft = Math.abs(estimate - left);
  const distUp = Math.abs(estimate - up);
  const distUpLeft = Math.abs(estimate - upLeft);
  if (distLeft <= distUp && distLeft <= distUpLeft) return left;
  if (distUp <= distUpLeft) return up;
  return upLeft;
}

/**
 * Expands the unfiltered scanlines into RGBA, one byte per channel. Sixteen-bit samples
 * are big-endian pairs of which only the high byte survives: a byte-per-channel pipeline
 * cannot represent more, and the low byte is where sensor noise lives anyway.
 */
function toRgba(
  raw: Uint8Array,
  width: number,
  height: number,
  stride: number,
  bytesPerPixel: number,
  colourType: number,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);

  if (colourType === 6 && bytesPerPixel === 4) {
    // One byte per sample: the scanline bytes are already RGBA, so each row is one copy.
    for (let y = 0; y < height; y++) {
      rgba.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * width * 4);
    }
    return rgba;
  }

  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1) + 1;
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = src + x * bytesPerPixel;
      const d = dst + x * 4;
      switch (colourType) {
        case 6:
          rgba[d] = raw[s] ?? 0;
          rgba[d + 1] = raw[s + 2] ?? 0;
          rgba[d + 2] = raw[s + 4] ?? 0;
          rgba[d + 3] = raw[s + 6] ?? 0;
          break;
        case 2:
          if (bytesPerPixel === 6) { // 16-bit RGB: three big-endian pairs.
            rgba[d] = raw[s] ?? 0;
            rgba[d + 1] = raw[s + 2] ?? 0;
            rgba[d + 2] = raw[s + 4] ?? 0;
          } else {
            rgba[d] = raw[s] ?? 0;
            rgba[d + 1] = raw[s + 1] ?? 0;
            rgba[d + 2] = raw[s + 2] ?? 0;
          }
          rgba[d + 3] = 255;
          break;
        case 0: {
          const grey = raw[s] ?? 0;
          rgba[d] = grey;
          rgba[d + 1] = grey;
          rgba[d + 2] = grey;
          rgba[d + 3] = 255;
          break;
        }
        case 4:
          rgba[d] = raw[s] ?? 0;
          rgba[d + 1] = raw[s] ?? 0;
          rgba[d + 2] = raw[s] ?? 0;
          rgba[d + 3] = raw[s + 1] ?? 0;
          break;
        case 3: {
          if (palette === undefined) {
            throw new Error('palette image is missing its PLTE chunk');
          }
          const index = raw[s] ?? 0;
          const entries = palette.length / 3;
          if (index >= entries) {
            throw new Error(`palette index ${index} falls outside the ${entries}-entry palette`);
          }
          const entry = index * 3;
          rgba[d] = palette[entry] ?? 0;
          rgba[d + 1] = palette[entry + 1] ?? 0;
          rgba[d + 2] = palette[entry + 2] ?? 0;
          // Entries beyond tRNS were never given an alpha, and an omitted chunk means
          // every entry is opaque.
          rgba[d + 3] = transparency !== undefined && index < transparency.length ? (transparency[index] ?? 255) : 255;
          break;
        }
      }
    }
  }
  return rgba;
}
