import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { comparePng } from '../src/compare.ts';
import { encodePng } from '../src/png-encode.ts';
import { decodePng } from '../src/png.ts';
import { findRegions } from '../src/regions.ts';

function solid(
  width: number,
  height: number,
  rgb: [number, number, number],
  alpha = 255,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at] = rgb[0];
    rgba[at + 1] = rgb[1];
    rgba[at + 2] = rgb[2];
    rgba[at + 3] = alpha;
  }
  return encodePng(width, height, rgba);
}

/** A grey image with one black block, and the same image without it. */
function pairWithBlock(width: number, height: number, x: number, y: number, w: number, h: number) {
  const grey = new Uint8Array(width * height * 4).fill(0);
  for (let at = 0; at < grey.length; at += 4) {
    grey[at] = 128;
    grey[at + 1] = 128;
    grey[at + 2] = 128;
    grey[at + 3] = 255;
  }
  const blocked = Uint8Array.from(grey);
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const at = (yy * width + xx) * 4;
      blocked[at] = 0;
      blocked[at + 1] = 0;
      blocked[at + 2] = 0;
    }
  }
  return [encodePng(width, height, grey), encodePng(width, height, blocked)] as const;
}

describe('comparePng', () => {
  it('reports nothing for identical images', () => {
    const image = solid(8, 6, [128, 128, 128]);
    const result = comparePng(image, image);
    assert.equal(result.diffPixels, 0);
    assert.equal(result.width, 8);
    assert.equal(result.height, 6);
  });

  it('counts one changed pixel and paints it red over the greyed base', () => {
    const [base, head] = pairWithBlock(6, 5, 2, 3, 1, 1);
    const result = comparePng(base, head);
    assert.equal(result.diffPixels, 1);
    const diff = decodePng(result.diff);
    const at = (3 * 6 + 2) * 4;
    assert.deepEqual(Array.from(diff.rgba.subarray(at, at + 4)), [255, 0, 0, 255]);
    // An unchanged pixel is the base's luma washed 90% toward white: grey 128 stays grey,
    // only paler — the backdrop the red stands out against.
    const washed = Array.from(diff.rgba.subarray(0, 4));
    assert.equal(washed[0], washed[1]);
    assert.equal(washed[1], washed[2]);
    assert.equal(washed[3], 255);
    assert.ok(washed[0] !== undefined && washed[0] > 128 && washed[0] < 255);
  });

  it('counts pixels beyond either image’s edge as differing', () => {
    const grown = comparePng(solid(4, 2, [10, 20, 30]), solid(4, 3, [10, 20, 30]));
    assert.equal(grown.diffPixels, 4); // one whole new row
    assert.deepEqual([grown.width, grown.height], [4, 3]);
    const widened = comparePng(solid(2, 2, [10, 20, 30]), solid(3, 2, [10, 20, 30]));
    assert.equal(widened.diffPixels, 2); // one whole new column
  });

  it('blends with white by alpha before comparing', () => {
    // A transparent black pixel and an opaque white one both sit on white: no difference.
    assert.equal(
      comparePng(solid(2, 2, [0, 0, 0], 0), solid(2, 2, [255, 255, 255])).diffPixels,
      0,
    );
    // At half alpha the same black pixel is a mid grey — a real difference from white.
    assert.equal(
      comparePng(solid(2, 2, [0, 0, 0], 128), solid(2, 2, [255, 255, 255])).diffPixels,
      4,
    );
  });

  it('honours the threshold', () => {
    const near = solid(1, 1, [100, 100, 100]);
    const nearer = solid(1, 1, [101, 100, 100]);
    assert.equal(comparePng(near, nearer, 0.1).diffPixels, 0);
    assert.equal(comparePng(near, nearer, 0.001).diffPixels, 1);
  });

  it('produces a diff the region finder reads', () => {
    const [base, head] = pairWithBlock(40, 30, 10, 8, 6, 4);
    const result = comparePng(base, head);
    const diff = decodePng(result.diff);
    const { regions } = findRegions(diff.rgba, diff.width, diff.height);
    assert.equal(regions.length, 1);
    assert.equal(regions[0]?.pixels, 24);
    assert.equal(regions[0]?.x, 10);
    assert.equal(regions[0]?.y, 8);
  });
});
