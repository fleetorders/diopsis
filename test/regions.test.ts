import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';

import { findRegions, regionSummary } from '../src/regions.ts';

const RED = [255, 0, 0] as const;
const YELLOW = [255, 255, 0] as const;

/** The greyed-out backdrop of a diff image: every pixel grey, fully opaque. */
function greyImage(width: number, height: number, shade = 128): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = shade;
    rgba[i + 1] = shade;
    rgba[i + 2] = shade;
    rgba[i + 3] = 255;
  }
  return rgba;
}

function paint(rgba: Uint8Array, width: number, x: number, y: number, pixel: readonly [number, number, number]): void {
  const i = (y * width + x) * 4;
  rgba[i] = pixel[0];
  rgba[i + 1] = pixel[1];
  rgba[i + 2] = pixel[2];
  rgba[i + 3] = 255;
}

function paintRect(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
  pixel: readonly [number, number, number] = RED,
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      paint(rgba, width, x + dx, y + dy, pixel);
    }
  }
}

describe('findRegions', () => {
  it('finds a single pixel as a 1x1 region', () => {
    const image = greyImage(20, 10);
    paint(image, 20, 7, 3, RED);
    assert.deepEqual(findRegions(image, 20, 10).regions, [{ x: 7, y: 3, width: 1, height: 1, pixels: 1 }]);
  });

  it('keeps distant blobs apart and orders them by size', () => {
    const image = greyImage(100, 100);
    paintRect(image, 100, 5, 5, 4, 4); // 16 pixels
    paintRect(image, 100, 60, 50, 2, 3); // 6 pixels, far outside the merge gap
    const { regions, dropped } = findRegions(image, 100, 100);
    assert.deepEqual(regions, [
      { x: 5, y: 5, width: 4, height: 4, pixels: 16 },
      { x: 60, y: 50, width: 2, height: 3, pixels: 6 },
    ]);
    assert.equal(dropped, 0);
  });

  it('merges blobs whose padded boxes intersect', () => {
    // The boxes span rows 5..7 and 15..17: 7 empty rows apart, well within the default
    // gap of 8, which pads each box and so bridges up to 15 empty rows.
    const image = greyImage(20, 25);
    paintRect(image, 20, 5, 5, 3, 3);
    paintRect(image, 20, 5, 15, 3, 3);
    assert.deepEqual(findRegions(image, 20, 25).regions, [
      { x: 5, y: 5, width: 3, height: 13, pixels: 18 },
    ]);
  });

  it('honours an explicit gap', () => {
    // Two single pixels 20 rows apart: 9 empty rows are too many for gap 5 but not for 20.
    const image = greyImage(30, 40);
    paint(image, 30, 10, 10, RED);
    paint(image, 30, 10, 31, RED);
    assert.equal(findRegions(image, 30, 40, { gap: 5 }).regions.length, 2);
    assert.deepEqual(findRegions(image, 30, 40, { gap: 20 }).regions, [
      { x: 10, y: 10, width: 1, height: 22, pixels: 2 },
    ]);
  });

  it('connects diagonally touching pixels into one region', () => {
    const image = greyImage(20, 20);
    paint(image, 20, 4, 4, RED);
    paint(image, 20, 5, 5, RED);
    assert.deepEqual(findRegions(image, 20, 20).regions, [
      { x: 4, y: 4, width: 2, height: 2, pixels: 2 },
    ]);
  });

  it('ignores yellow anti-aliasing pixels, even surrounding a real change', () => {
    const image = greyImage(20, 20);
    paintRect(image, 20, 1, 1, 3, 3, YELLOW);
    paint(image, 20, 2, 2, RED);
    assert.deepEqual(findRegions(image, 20, 20).regions, [
      { x: 2, y: 2, width: 1, height: 1, pixels: 1 },
    ]);
  });

  it('ignores a yellow blob entirely', () => {
    const image = greyImage(20, 20);
    paintRect(image, 20, 5, 5, 4, 4, YELLOW);
    assert.deepEqual(findRegions(image, 20, 20), { regions: [], dropped: 0 });
  });

  it('finds nothing in a fully grey image', () => {
    assert.deepEqual(findRegions(greyImage(16, 16), 16, 16), { regions: [], dropped: 0 });
  });

  it('returns an empty result for a zero-sized image', () => {
    assert.deepEqual(findRegions(new Uint8Array(0), 0, 0), { regions: [], dropped: 0 });
  });

  it('drops regions below minPixels without counting them as dropped', () => {
    const image = greyImage(60, 10);
    paintRect(image, 60, 5, 3, 3, 1); // 3 pixels
    paint(image, 60, 40, 3, RED); // 1 pixel, noise at this threshold
    const result = findRegions(image, 60, 10, { minPixels: 3 });
    assert.deepEqual(result, { regions: [{ x: 5, y: 3, width: 3, height: 1, pixels: 3 }], dropped: 0 });
  });

  it('caps the list, reports what fell below the cap, and merges nothing into the dropped', () => {
    const image = greyImage(120, 20);
    paintRect(image, 120, 2, 2, 4, 4); // 16
    paintRect(image, 120, 30, 2, 3, 3); // 9
    paintRect(image, 120, 60, 2, 2, 2); // 4
    paint(image, 120, 90, 2, RED); // 1
    const result = findRegions(image, 120, 20, { max: 2 });
    assert.deepEqual(result.regions, [
      { x: 2, y: 2, width: 4, height: 4, pixels: 16 },
      { x: 30, y: 2, width: 3, height: 3, pixels: 9 },
    ]);
    assert.equal(result.dropped, 2);
    assert.equal(regionSummary(result), '2 changed regions, 2 more dropped');
  });

  it('sorts by pixels, then by top edge, then by left edge', () => {
    const image = greyImage(100, 100);
    paintRect(image, 100, 0, 90, 2, 3); // 6 pixels, lowest on the page but largest
    paintRect(image, 100, 70, 10, 2, 2); // 4 pixels, highest
    paintRect(image, 100, 40, 30, 2, 2); // 4 pixels
    paintRect(image, 100, 10, 30, 2, 2); // 4 pixels, same row, further left
    const { regions } = findRegions(image, 100, 100);
    assert.deepEqual(
      regions.map((region) => [region.x, region.y, region.pixels]),
      [
        [0, 90, 6],
        [70, 10, 4],
        [10, 30, 4],
        [40, 30, 4],
      ],
    );
  });

  it('refuses a pixel buffer smaller than the image it claims', () => {
    assert.throws(() => findRegions(new Uint8Array(4), 2, 2), /needs 16/);
  });

  it('handles a screenshot-sized noisy image in well under a second', () => {
    const width = 1280;
    const height = 4000;
    const limit = 1000; // generous next to the sub-200 ms target, so timing noise cannot flake

    // Dense noise stresses the merge phase: thousands of pixels chain into few, huge boxes.
    const dense = greyImage(width, height);
    let seed = 123456789;
    for (let k = 0; k < 20000; k++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      const pixel = seed % (width * height);
      dense[pixel * 4] = 255;
      dense[pixel * 4 + 1] = 0;
      dense[pixel * 4 + 2] = 0;
    }
    let started = performance.now();
    const denseResult = findRegions(dense, width, height);
    let elapsed = performance.now() - started;
    assert.ok(elapsed < limit, `dense noise took ${elapsed.toFixed(1)} ms`);
    assert.ok(denseResult.regions.length > 0, 'noise must yield regions');

    // Isolated pixels spaced past the merge gap stress everything else: no component ever
    // merges, so labelling, accumulation and the cap all run at their worst case.
    const sparse = greyImage(width, height);
    // Pixels sit on a 48 px grid with 0..28 px of jitter: nearest neighbours stay at least
    // 20 px apart, beyond the default gap's 16, and the jitter never leaves the canvas —
    // a negative coordinate would silently wrap to the end of the previous row.
    const grid = 48;
    for (let row = 0; row * grid + 28 < height; row++) {
      for (let column = 0; column * grid + 28 < width; column++) {
        const x = column * grid + ((row * 7 + column * 13) % 29);
        const y = row * grid + ((row * 13 + column * 5) % 29);
        paint(sparse, width, x, y, RED);
      }
    }
    started = performance.now();
    const sparseResult = findRegions(sparse, width, height);
    elapsed = performance.now() - started;
    assert.ok(elapsed < limit, `isolated noise took ${elapsed.toFixed(1)} ms`);
    // Thousands of isolated pixels stay isolated, so the cap is what trims the list.
    assert.equal(sparseResult.regions.length, 50);
    assert.ok(sparseResult.regions.every((region) => region.width === 1 && region.height === 1));
    assert.ok(sparseResult.dropped > 1000, 'almost every isolated pixel must fall below the cap');
  });
});

describe('regionSummary', () => {
  it('describes a single region without plurals or drop counts', () => {
    const image = greyImage(10, 10);
    paint(image, 10, 4, 4, RED);
    assert.equal(regionSummary(findRegions(image, 10, 10)), '1 changed region');
  });

  it('says no changed regions for a clean image', () => {
    assert.equal(regionSummary(findRegions(greyImage(10, 10), 10, 10)), 'no changed regions');
  });

  it('reports dropped regions when the cap bites', () => {
    const image = greyImage(60, 10);
    paintRect(image, 60, 5, 3, 2, 2);
    paintRect(image, 60, 40, 3, 2, 2);
    assert.equal(regionSummary(findRegions(image, 60, 10, { max: 1 })), '1 changed region, 1 more dropped');
  });
});
