import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';

import { decodePng, PNG_SIGNATURE } from '../src/png.ts';
import { encodePng } from '../src/png-encode.ts';

/** A pattern that varies with x, y and channel, so a fixed filter cannot hide behind flat rows. */
function pixels(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = (x * 29 + y * 7) & 0xff;
      rgba[at + 1] = (x * 3 + y * 41) & 0xff;
      rgba[at + 2] = (x * 11 + y * 13) & 0xff;
      rgba[at + 3] = (x * 17 + y * 5) & 0xff;
    }
  }
  return rgba;
}

describe('encodePng', () => {
  it('round-trips through the decoder', () => {
    // The decoder verifies every chunk's CRC and reverses the row filters, so a byte that
    // survives this round trip is proven, not assumed.
    const sizes: [number, number][] = [
      [1, 1],
      [3, 2],
      [17, 9],
      [64, 32],
    ];
    for (const [width, height] of sizes) {
      const rgba = pixels(width, height);
      const image = decodePng(encodePng(width, height, rgba));
      assert.equal(image.width, width);
      assert.equal(image.height, height);
      assert.deepEqual(image.rgba, rgba);
    }
  });

  it('keeps the alpha channel it was given, not an opaque one', () => {
    const rgba = pixels(5, 4);
    assert.ok(rgba.some((byte, i) => i % 4 === 3 && byte !== 255 && byte !== 0));
    assert.deepEqual(decodePng(encodePng(5, 4, rgba)).rgba, rgba);
  });

  it('writes 8-bit RGBA with the Sub filter on every row', () => {
    const width = 6;
    const height = 3;
    const bytes = encodePng(width, height, pixels(width, height));
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), Array.from(PNG_SIGNATURE));

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    let header: Uint8Array | undefined;
    const idat: Uint8Array[] = [];
    while (offset < bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') header = data;
      if (type === 'IDAT') idat.push(data);
      offset += 12 + length;
    }
    assert.ok(header);
    assert.equal(header?.[8], 8); // bit depth
    assert.equal(header?.[9], 6); // colour type: truecolour with alpha
    assert.equal(header?.[12], 0); // no interlace

    const stream = inflateSync(
      idat.length === 1
        ? idat[0]!
        : Buffer.concat(idat.map((part) => Buffer.from(part))),
    );
    const stride = width * 4;
    assert.equal(stream.length, height * (stride + 1));
    for (let y = 0; y < height; y++) {
      assert.equal(stream[y * (stride + 1)], 1, `row ${y}`);
    }
  });

  it('refuses dimensions and buffers that disagree', () => {
    assert.throws(() => encodePng(0, 3, new Uint8Array(0)), /positive integer dimensions/);
    assert.throws(() => encodePng(2, 2, new Uint8Array(7)), /needs exactly 16/);
  });
});
