import { decodePng } from './png.ts';
import { encodePng } from './png-encode.ts';

/**
 * Pixel comparison, in house.
 *
 * A run delegates its comparison to the test runner's comparator; the diff command holds
 * two PNGs as bytes and compares them here. The result's diff image speaks the fixed
 * vocabulary the report and the region finder already read: pure red where a pixel
 * genuinely differs, the baseline greyed out everywhere else.
 */

export interface CompareResult {
  /** The union of the two images' sizes: what the comparison covered. */
  width: number;
  height: number;
  /** Pixels that differ — counting the ones only one of the two images holds. */
  diffPixels: number;
  /** The diff image as PNG bytes. */
  diff: Uint8Array;
}

// The standard perceptual metric: colour distance in YIQ space, where the eye's luma
// sensitivity outranks its chroma sensitivity. The 35215 scale is what turns a 0–1
// threshold into that distance's cut-off.
const Y_R = 0.29889531;
const Y_G = 0.58662247;
const Y_B = 0.11448685;
const I_R = 0.59597799;
const I_G = -0.27417610;
const I_B = -0.32180189;
const Q_R = 0.21147017;
const Q_G = -0.52261711;
const Q_B = 0.31114694;

/**
 * One pixel as it looks on the page: each channel blended toward white by its alpha, so a
 * transparent pixel compares as the white behind it rather than as whatever RGB it carries.
 */
function onWhite(rgba: Uint8Array, at: number): { r: number; g: number; b: number } {
  const alpha = (rgba[at + 3] ?? 0) / 255;
  const white = 1 - alpha;
  return {
    r: 255 * white + (rgba[at] ?? 0) * alpha,
    g: 255 * white + (rgba[at + 1] ?? 0) * alpha,
    b: 255 * white + (rgba[at + 2] ?? 0) * alpha,
  };
}

export function comparePng(a: Uint8Array, b: Uint8Array, threshold = 0.1): CompareResult {
  const base = decodePng(a);
  const head = decodePng(b);
  // Compared on the union size: a pixel one image holds and the other does not is a
  // difference by definition, so a grown or shrunk render reports its new edge rather than
  // a quietly truncated comparison.
  const width = Math.max(base.width, head.width);
  const height = Math.max(base.height, head.height);
  const limit = 35215 * threshold * threshold;
  const rgba = new Uint8Array(width * height * 4);
  let diffPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const inBase = x < base.width && y < base.height;
      const inHead = x < head.width && y < head.height;
      let differs = true;
      let grey = 255;
      if (inBase && inHead) {
        const from = onWhite(base.rgba, (y * base.width + x) * 4);
        const to = onWhite(head.rgba, (y * head.width + x) * 4);
        const y1 = Y_R * from.r + Y_G * from.g + Y_B * from.b;
        const i1 = I_R * from.r + I_G * from.g + I_B * from.b;
        const q1 = Q_R * from.r + Q_G * from.g + Q_B * from.b;
        const y2 = Y_R * to.r + Y_G * to.g + Y_B * to.b;
        const i2 = I_R * to.r + I_G * to.g + I_B * to.b;
        const q2 = Q_R * to.r + Q_G * to.g + Q_B * to.b;
        const dY = y1 - y2;
        const dI = i1 - i2;
        const dQ = q1 - q2;
        differs = 0.5053 * dY * dY + 0.299 * dI * dI + 0.1957 * dQ * dQ > limit;
        // The unchanged backdrop is the baseline's own luma washed out toward white — the
        // grey the region finder's red stands out against.
        grey = y1 + (255 - y1) * 0.9;
      }
      if (differs) {
        diffPixels += 1;
        rgba[at] = 255;
        rgba[at + 1] = 0;
        rgba[at + 2] = 0;
        rgba[at + 3] = 255;
      } else {
        const washed = Math.round(grey);
        rgba[at] = washed;
        rgba[at + 1] = washed;
        rgba[at + 2] = washed;
        rgba[at + 3] = 255;
      }
    }
  }

  return { width, height, diffPixels, diff: encodePng(width, height, rgba) };
}
