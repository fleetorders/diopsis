/**
 * Changed regions in a diff image.
 *
 * A diff image speaks a fixed vocabulary: a pixel that genuinely differs is pure red
 * (255, 0, 0), a difference that only exists because an edge came out anti-aliased
 * differently is pure yellow (255, 255, 0), and every other pixel is a greyed-out copy
 * of the baseline. This module turns that vocabulary into the rectangles a report can
 * show: where each change sits and how many pixels it covers. Only red counts — yellow
 * is displayed to a human but never treated as a change on its own.
 */

/** A rectangle of changed pixels in image coordinates. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Red pixels inside the rectangle; the box may also contain unchanged pixels. */
  pixels: number;
}

export interface RegionOptions {
  /**
   * Merge two regions whose bounding boxes, each padded by this many pixels, intersect.
   * Nearby boxes are usually one visual change broken apart by anti-aliasing or a thin
   * unchanged stripe, and merging keeps a long page from reporting hundreds of slivers.
   */
  gap?: number;
  /** Regions with fewer red pixels than this are noise and are dropped. */
  minPixels?: number;
  /** At most this many regions are returned; the rest are counted in `dropped`. */
  max?: number;
}

/** A component's bounding box while merging; `merged` marks boxes absorbed into another. */
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixels: number;
  merged: boolean;
}

export interface RegionResult {
  regions: Region[];
  /**
   * Regions that existed after merging but fell outside `max`. Regions discarded by
   * `minPixels` are deliberately not counted: they were judged noise, not hidden by a cap.
   */
  dropped: number;
}

const DEFAULT_GAP = 8;
const DEFAULT_MIN_PIXELS = 1;
const DEFAULT_MAX = 50;

/**
 * Locates the changed regions of a diff image.
 *
 * Labelling is a two-pass connected-component run over an Int32Array of pixel labels with
 * union-find resolving equivalences, because screenshot-sized images do not fit any
 * flood-fill queue gracefully and a report needs this answer in milliseconds, not seconds.
 */
export function findRegions(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: RegionOptions = {},
): RegionResult {
  const gap = options.gap ?? DEFAULT_GAP;
  const minPixels = options.minPixels ?? DEFAULT_MIN_PIXELS;
  const max = options.max ?? DEFAULT_MAX;
  if (!Number.isInteger(gap) || gap < 0) {
    throw new Error(`gap must be a non-negative integer, got ${gap}`);
  }
  if (!Number.isInteger(minPixels) || minPixels < 1) {
    throw new Error(`minPixels must be a positive integer, got ${minPixels}`);
  }
  if (!Number.isInteger(max) || max < 0) {
    throw new Error(`max must be a non-negative integer, got ${max}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error(`image dimensions must be non-negative integers, got ${width}x${height}`);
  }
  const pixelBytes = width * height * 4;
  if (rgba.length < pixelBytes) {
    throw new Error(
      `pixel buffer holds ${rgba.length} bytes, but a ${width}x${height} image needs ${pixelBytes}`,
    );
  }
  if (pixelBytes === 0) return { regions: [], dropped: 0 };

  // Counting the red pixels first sizes the union-find parent array exactly; the extra
  // sweep costs one pass and buys an allocation that never has to grow.
  let redCount = 0;
  for (let i = 0; i < pixelBytes; i += 4) {
    if (rgba[i] === 255 && rgba[i + 1] === 0 && rgba[i + 2] === 0) redCount++;
  }
  if (redCount === 0) return { regions: [], dropped: 0 };

  const labels = new Int32Array(width * height);
  const parent = new Int32Array(redCount + 1);
  for (let i = 0; i <= redCount; i++) parent[i] = i;

  // First pass: give every red pixel a provisional label and union it with the labels of
  // the already-scanned neighbours — the pixel to the left and the three above it, which
  // is what makes this 8-connectivity: diagonal neighbours are one region, not two.
  let nextLabel = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const above = row - width;
    for (let x = 0; x < width; x++) {
      const p = (row + x) * 4;
      if (rgba[p] !== 255 || rgba[p + 1] !== 0 || rgba[p + 2] !== 0) continue;
      let label = 0;
      label = adoptLabel(parent, label, x > 0 ? (labels[row + x - 1] ?? 0) : 0);
      label = adoptLabel(parent, label, y > 0 && x > 0 ? (labels[above + x - 1] ?? 0) : 0);
      label = adoptLabel(parent, label, y > 0 ? (labels[above + x] ?? 0) : 0);
      label = adoptLabel(parent, label, y > 0 && x + 1 < width ? (labels[above + x + 1] ?? 0) : 0);
      if (label === 0) {
        nextLabel++;
        label = nextLabel;
      }
      labels[row + x] = label;
    }
  }

  // Second pass: resolve each label to its root and accumulate the region's extent there.
  const pixels = new Int32Array(nextLabel + 1);
  const minX = new Int32Array(nextLabel + 1).fill(width);
  const minY = new Int32Array(nextLabel + 1).fill(height);
  const maxX = new Int32Array(nextLabel + 1).fill(-1);
  const maxY = new Int32Array(nextLabel + 1).fill(-1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const label = labels[row + x] ?? 0;
      if (label === 0) continue;
      const root = findRoot(parent, label);
      const count = (pixels[root] ?? 0) + 1;
      pixels[root] = count;
      if (count === 1) {
        minX[root] = x;
        maxX[root] = x;
        minY[root] = y;
        maxY[root] = y;
      } else {
        if (x < (minX[root] ?? x)) minX[root] = x;
        if (x > (maxX[root] ?? x)) maxX[root] = x;
        if (y > (maxY[root] ?? y)) maxY[root] = y;
      }
    }
  }

  // One box per surviving component: a label is a root exactly when it is its own parent.
  const boxes: Box[] = [];
  for (let label = 1; label <= nextLabel; label++) {
    if ((parent[label] ?? label) !== label) continue;
    const count = pixels[label] ?? 0;
    if (count === 0) continue;
    boxes.push({ minX: minX[label] ?? 0, minY: minY[label] ?? 0, maxX: maxX[label] ?? 0, maxY: maxY[label] ?? 0, pixels: count, merged: false });
  }

  mergeBoxes(boxes, gap);

  const regions: Region[] = [];
  for (const box of boxes) {
    if (box.merged || box.pixels < minPixels) continue;
    regions.push({
      x: box.minX,
      y: box.minY,
      width: box.maxX - box.minX + 1,
      height: box.maxY - box.minY + 1,
      pixels: box.pixels,
    });
  }
  // Biggest first; among equals, the region higher up the page, then the one further left.
  regions.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
  const dropped = Math.max(0, regions.length - max);
  if (dropped > 0) regions.length = max;
  return { regions, dropped };
}

/** Unions a neighbouring label into the label being built for the current pixel. */
function adoptLabel(parent: Int32Array, current: number, neighbour: number): number {
  if (neighbour === 0) return current;
  const root = findRoot(parent, neighbour);
  if (current === 0) return root;
  if (root === current) return current;
  // Keeping the smaller id as the root is arbitrary but deterministic, which is worth
  // more than union-by-rank here: identical input must yield identical output.
  const lo = root < current ? root : current;
  const hi = root < current ? current : root;
  parent[hi] = lo;
  return lo;
}

function findRoot(parent: Int32Array, label: number): number {
  let root = label;
  while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
  // Path compression: every node on the way down now points straight at the root, so the
  // second pass stays near constant time even on long diagonal chains of merges.
  let node = label;
  while ((parent[node] ?? node) !== root) {
    const next = parent[node] ?? node;
    parent[node] = root;
    node = next;
  }
  return root;
}

/**
 * Merges boxes whose gap-padded rectangles intersect, repeating until a full pass merges
 * nothing. Repeating matters because absorbing a box grows its rectangle, which can make
 * it newly touch boxes that neither half touched before — a single pass would leave such
 * chains split, and which chains form depends on the sort order rather than the image.
 */
function mergeBoxes(boxes: Box[], gap: number): void {
  let merged = true;
  while (merged) {
    merged = false;
    // Sorting by the left edge lets the inner loop stop as soon as it reaches a box that
    // starts beyond the current box's (growing) right edge plus the gap.
    boxes.sort((a, b) => a.minX - b.minX);
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a === undefined || a.merged) continue;
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        if (b === undefined || b.merged) continue;
        if (b.minX - gap > a.maxX + gap) break;
        if (b.minY - gap > a.maxY + gap || a.minY - gap > b.maxY + gap) continue;
        a.minX = Math.min(a.minX, b.minX);
        a.minY = Math.min(a.minY, b.minY);
        a.maxX = Math.max(a.maxX, b.maxX);
        a.maxY = Math.max(a.maxY, b.maxY);
        a.pixels += b.pixels;
        b.merged = true;
        merged = true;
      }
    }
  }
}

/** A one-line digest of a region result, for wherever a caption is wanted instead of boxes. */
export function regionSummary(result: RegionResult): string {
  const { regions, dropped } = result;
  if (regions.length === 0 && dropped === 0) return 'no changed regions';
  const head = `${regions.length} changed ${regions.length === 1 ? 'region' : 'regions'}`;
  return dropped > 0 ? `${head}, ${dropped} more dropped` : head;
}
