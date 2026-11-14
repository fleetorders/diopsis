/**
 * The layout audit's analysis: what the page-side walk measured, turned into findings a
 * review reads (docs/decisions.md, D-050).
 *
 * The split is deliberate: everything that decides a finding — thresholds, pair rules, the
 * intended marking — lives here, as pure functions over plain data, so it is unit-testable
 * and identical on every machine; `measureLayout` in `src/runtime/capture.ts` only walks the
 * DOM and reports boxes. A pixel comparison can only say "these pixels moved"; it cannot say
 * that a title now sits under an image at one width, which is the question this answers.
 */

/**
 * What Diopsis does with the layout audit's findings. `'off'` never measures; `'report'`
 * records findings and never touches the exit code; `'fail'` makes a finding fail the
 * capture like a change (docs/decisions.md, D-050).
 */
export type LayoutMode = 'off' | 'report' | 'fail';

/** What a measured element is, as the walk classifies it. */
export type LayoutElementKind = 'text' | 'control' | 'media' | 'container';

/** A box in viewport coordinates, whole CSS pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element as a finding names it: where it is and what it is, nothing more. */
export interface LayoutElementRef {
  selector: string;
  kind: LayoutElementKind;
  box: Box;
}

/** One element the walk collected, trimmed to what the analysis reads. */
export interface MeasuredElement extends LayoutElementRef {
  /**
   * Indices of this element's collected ancestors, outermost first. Overlap is judged
   * between unrelated elements only — a child inside its parent is layout, not collision —
   * and this is the whole ancestry the walk needs to say so.
   */
  ancestors: number[];
  /**
   * Where the element's own text sits: one box per line fragment of its text nodes, in the
   * same coordinates as `box`. A text element is judged by these rather than by its block,
   * so a paragraph wrapping round a float is not "under" the float. Present when the
   * element has text of its own.
   */
  text?: Box[];
  /**
   * How much of the element's own content its box hides, per axis, in CSS pixels, with
   * whether the hiding is a deliberate truncation style (ellipsis on the axis,
   * line clamping). Present only when the element clips something.
   */
  clip?: { x: number; y: number; ellipsis: boolean; lineClamp: boolean };
  /**
   * The axes on which the element's box cuts off what its content draws past it: overflow
   * `hidden` or `clip`, or `auto` or `scroll`, where the rest waits a scroll away. A
   * descendant shows only inside every such box around it. Present only when the element
   * cuts something off; an axis on which `clip` records hidden content is cut either way.
   */
  crop?: { x: boolean; y: boolean };
  /** The element, or an ancestor of it, carries `data-diopsis-overlap`. */
  intended?: true;
}

/** The page-level numbers the overflow finding is judged against. */
export interface PageGeometry {
  /** The layout viewport's width — `documentElement.clientWidth`, scrollbar excluded. */
  viewportWidth: number;
  /** The page's full scrollable width; larger than the viewport means it scrolls sideways. */
  scrollWidth: number;
}

/** Two content elements occupying the same pixels: the later one in document order covers the earlier. */
export interface OverlapFinding {
  kind: 'overlap';
  covered: LayoutElementRef;
  covering: LayoutElementRef;
  /** The intersection, in CSS pixels. */
  overlap: { width: number; height: number };
}

/** Content the element's own box hides: text or a control cut off by its container. */
export interface TextClipFinding {
  kind: 'text-clip';
  element: LayoutElementRef;
  axis: 'x' | 'y';
  /** Pixels of content hidden past the box on that axis. */
  hidden: number;
}

/** The page scrolls sideways; this element reaches furthest past the right edge. */
export interface HorizontalOverflowFinding {
  kind: 'horizontal-overflow';
  element: LayoutElementRef;
  /** Pixels the element reaches past the layout viewport's right edge. */
  beyond: number;
}

export type LayoutFinding = OverlapFinding | TextClipFinding | HorizontalOverflowFinding;

/**
 * The share of the smaller element's area an overlap must cover before it is a finding.
 * Glancing contact — a shadowed edge, a one-pixel seam — is layout noise; a title half under
 * an image is not, and 25% is the line between them.
 */
export const OVERLAP_SHARE = 0.25;

/** An overlap smaller than this, in px², is never a finding whatever its share. */
export const OVERLAP_MIN_AREA = 64;

/** Clipped content below this many pixels is box-model rounding, not a cut-off. */
export const CLIP_MIN_PX = 4;

/** Page scroll wider than the viewport by more than this scrolls sideways. */
export const OVERFLOW_MIN_PX = 1;

/** Findings kept per capture: enough to see every problem, few enough to stay a list. */
export const MAX_LAYOUT_FINDINGS = 20;

/**
 * Elements the overlap check pairs up, at most: the walk's document order decides which
 * make the cut, so the same page yields the same findings on every machine.
 */
export const MAX_OVERLAP_CANDIDATES = 250;

function area(box: Box): number {
  return box.width * box.height;
}

function refOf(element: MeasuredElement): LayoutElementRef {
  return { selector: element.selector, kind: element.kind, box: element.box };
}

/**
 * Whether two elements are ancestor and descendant, by the walk's ancestry records. A
 * container's children sit inside it by design; only unrelated elements can collide.
 */
function related(elements: MeasuredElement[], a: number, b: number): boolean {
  return elements[b]!.ancestors.includes(a) || elements[a]!.ancestors.includes(b);
}

/** The intersection of two boxes, or undefined when they do not touch. */
function intersection(a: Box, b: Box): Box | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** The smallest box holding every one given; the list is never empty. */
function bounds(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The boxes an element occupies for the overlap check: a text element's line boxes, where
 * its words actually are, and every other element's box. A block heading's box runs the
 * width of its row, and a paragraph's box runs under a float its lines wrap round; judging
 * either by its box reads ordinary layout as a collision.
 */
function shapeOf(element: MeasuredElement): Box[] {
  return element.kind === 'text' && element.text && element.text.length > 0
    ? element.text
    : [element.box];
}

/** The boxes a clipping element's readable content occupies: words for text, boxes for controls. */
function readableShapeOf(element: MeasuredElement): Box[] {
  if (element.kind === 'control') return [element.box];
  return element.kind === 'text' ? shapeOf(element) : [];
}

/** A box's extent on one axis, as start and end. */
function span(box: Box, axis: 'x' | 'y'): [number, number] {
  return axis === 'x' ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
}

/** Whether an element's box cuts off what its content draws past it on one axis. */
function cuts(element: MeasuredElement, axis: 'x' | 'y'): boolean {
  if (element.crop?.[axis]) return true;
  return element.clip !== undefined && (axis === 'x' ? element.clip.x : element.clip.y) > 0;
}

/**
 * What of some boxes is in view: each one trimmed, on every axis a cropping element cuts,
 * to that element's box, and dropped once nothing of it is left. A card's tall image shows
 * only inside the card, a truncated label only up to its ellipsis, and a carousel's slides
 * only inside the strip that scrolls them — none of them reaches anything past those edges.
 */
function inView(boxes: Box[], croppers: number[], elements: MeasuredElement[]): Box[] {
  const kept: Box[] = [];
  for (const box of boxes) {
    let [left, right] = span(box, 'x');
    let [top, bottom] = span(box, 'y');
    for (const index of croppers) {
      const cropper = elements[index]!;
      if (cuts(cropper, 'x')) {
        const [from, to] = span(cropper.box, 'x');
        left = Math.max(left, from);
        right = Math.min(right, to);
      }
      if (cuts(cropper, 'y')) {
        const [from, to] = span(cropper.box, 'y');
        top = Math.max(top, from);
        bottom = Math.min(bottom, to);
      }
    }
    if (right > left && bottom > top) kept.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return kept;
}

/** The elements whose boxes can cut this one off: its collected ancestors, and itself. */
function croppersOf(element: MeasuredElement, index: number): number[] {
  return [...element.ancestors, index];
}

/**
 * How far readable content reaches past a clipping element's edges on one axis: its own
 * words, and the text and controls collected below it, each first cut to any nearer box
 * that cuts the same axis — one between them, or the descendant's own — since that box
 * hides or scrolls the overflow before this one can. Media is not counted on purpose — a
 * card cropping a tall image while its caption sits in full view is the design working,
 * where cut-off text is the design broken.
 */
function readableReach(
  element: MeasuredElement,
  index: number,
  elements: MeasuredElement[],
  axis: 'x' | 'y',
): number {
  const [start, end] = span(element.box, axis);
  let reach = 0;
  const measure = (boxes: Box[], nearer: number[]): void => {
    for (const box of boxes) {
      let [from, to] = span(box, axis);
      for (const ancestor of nearer) {
        if (!cuts(elements[ancestor]!, axis)) continue;
        const [clipFrom, clipTo] = span(elements[ancestor]!.box, axis);
        from = Math.max(from, clipFrom);
        to = Math.min(to, clipTo);
      }
      if (to > from) reach = Math.max(reach, start - from, to - end);
    }
  };
  if (element.text) measure(element.text, []);
  for (let other = index + 1; other < elements.length; other++) {
    const ancestors = elements[other]!.ancestors;
    const at = ancestors.indexOf(index);
    if (at === -1) continue;
    measure(readableShapeOf(elements[other]!), [...ancestors.slice(at + 1), other]);
  }
  return reach;
}

/**
 * Turn one width's measurements into its findings.
 *
 * Deterministic by construction: the walk's order decides pair order and candidate caps, and
 * the result is sorted, so the same page at the same width yields the same findings on every
 * machine. Overlaps lead (they are the most likely to hide content), each kind sorted by
 * size, and the whole list is capped at `MAX_LAYOUT_FINDINGS`.
 */
export function analyzeLayout(elements: MeasuredElement[], page: PageGeometry): LayoutFinding[] {
  const overlaps: OverlapFinding[] = [];
  const clips: TextClipFinding[] = [];
  const overflows: HorizontalOverflowFinding[] = [];

  // Sideways scrolling: the page scrolls because something reaches past its right edge, and
  // the element that reaches furthest is the one to name. Each element reaches only as far
  // as it shows: what a box around it cuts off — a carousel's later slides, say — adds
  // nothing to the page's width. A scroll with no collected element past the edge (a walk
  // that hit its limit, say) reports nothing rather than a finding that points at nothing.
  if (page.scrollWidth > page.viewportWidth + OVERFLOW_MIN_PX) {
    let worst: { element: MeasuredElement; beyond: number } | undefined;
    for (const [index, element] of elements.entries()) {
      const [shown] = inView([element.box], croppersOf(element, index), elements);
      if (!shown) continue;
      const beyond = shown.x + shown.width - page.viewportWidth;
      if (beyond > OVERFLOW_MIN_PX && (!worst || beyond > worst.beyond)) worst = { element, beyond };
    }
    if (worst) {
      overflows.push({
        kind: 'horizontal-overflow',
        element: refOf(worst.element),
        beyond: Math.round(worst.beyond),
      });
    }
  }

  // Cut-off content: a box hiding overflow while its text or controls reach past its edge.
  // The hidden amount is the smaller of how far that content reaches and how much the box
  // hides — content positioned out of the box's clipping reaches without being hidden, and
  // a cropped image is hidden without being content. An ellipsis on the horizontal axis is
  // a deliberate truncation, and a line clamp is the vertical equivalent; neither is a
  // finding even though both hide text.
  for (const [index, element] of elements.entries()) {
    const clip = element.clip;
    if (!clip) continue;
    const hiddenOn = (axis: 'x' | 'y'): number => {
      const amount = axis === 'x' ? clip.x : clip.y;
      if (amount <= CLIP_MIN_PX || (axis === 'x' ? clip.ellipsis : clip.lineClamp)) return 0;
      const hidden = Math.min(amount, readableReach(element, index, elements, axis));
      return hidden > CLIP_MIN_PX ? hidden : 0;
    };
    const xHidden = hiddenOn('x');
    const yHidden = hiddenOn('y');
    const axis: 'x' | 'y' | undefined =
      xHidden >= yHidden && xHidden > 0 ? 'x' : yHidden > 0 ? 'y' : undefined;
    if (axis) {
      clips.push({
        kind: 'text-clip',
        element: refOf(element),
        axis,
        hidden: Math.round(axis === 'x' ? xHidden : yHidden),
      });
    }
  }

  // Overlaps: pairs of unrelated, visible content elements sharing enough of the smaller
  // one's area. Two media elements are excluded — stacked images are a technique, not a
  // lost reading — while any pair involving text or a control is exactly what the audit
  // exists to catch. Marked elements never take part.
  // Each element is judged by its shape — a text element by its line boxes — cut to what
  // the boxes around it leave in view, so the shared area is the sum over what shows, and
  // the overlap reported is the extent of what they share. An image a card crops collides
  // with nothing below the card, and a label truncated by an ellipsis with nothing past it.
  const candidates: Array<{ element: MeasuredElement; index: number; shape: Box[]; extent: Box; area: number }> = [];
  for (const [index, element] of elements.entries()) {
    if (candidates.length === MAX_OVERLAP_CANDIDATES) break;
    if (element.kind === 'container' || element.intended) continue;
    const shape = inView(shapeOf(element), croppersOf(element, index), elements);
    if (shape.length === 0) continue;
    candidates.push({
      element,
      index,
      shape,
      extent: bounds(shape),
      area: shape.reduce((sum, box) => sum + area(box), 0),
    });
  }
  for (let i = 0; i < candidates.length; i++) {
    const first = candidates[i]!;
    for (let j = i + 1; j < candidates.length; j++) {
      const second = candidates[j]!;
      if (first.element.kind === 'media' && second.element.kind === 'media') continue;
      if (related(elements, first.index, second.index)) continue;
      if (!intersection(first.extent, second.extent)) continue;
      const cuts: Box[] = [];
      for (const a of first.shape) {
        for (const b of second.shape) {
          const cut = intersection(a, b);
          if (cut) cuts.push(cut);
        }
      }
      if (cuts.length === 0) continue;
      const shared = cuts.reduce((sum, cut) => sum + area(cut), 0);
      if (shared < OVERLAP_MIN_AREA) continue;
      if (shared / Math.min(first.area, second.area) < OVERLAP_SHARE) continue;
      const extent = bounds(cuts);
      overlaps.push({
        kind: 'overlap',
        // Document order approximates paint order: the later element is the one on top.
        covered: refOf(first.element),
        covering: refOf(second.element),
        overlap: { width: Math.round(extent.width), height: Math.round(extent.height) },
      });
    }
  }

  const size = (finding: LayoutFinding): number =>
    finding.kind === 'overlap'
      ? finding.overlap.width * finding.overlap.height
      : finding.kind === 'text-clip'
        ? finding.hidden
        : finding.beyond;
  // The tie-break keeps two equally sized findings in one stable order, so a page that did
  // not change produces byte-identical findings.
  const selectorOf = (finding: LayoutFinding): string =>
    finding.kind === 'overlap' ? finding.covered.selector : finding.element.selector;

  return [...overlaps, ...clips, ...overflows]
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || size(b) - size(a) ||
        selectorOf(a).localeCompare(selectorOf(b)),
    )
    .slice(0, MAX_LAYOUT_FINDINGS);
}

/**
 * The error a `'fail'` run fails the capture with, or undefined when the audit found nothing.
 * The opening words are the classifier's marker, so they are load-bearing.
 */
export function layoutFailureOf(
  findings: LayoutFinding[],
  storyId: string,
  width: number,
  mode?: string,
): string | undefined {
  if (findings.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  const kinds = [...counts.entries()].map(([kind, n]) => `${kind} ×${n}`).join(', ');
  return (
    `New layout findings: ${findings.length} in ` +
    `${mode === undefined ? storyId : `${storyId}[@${mode}]`} @${width} (${kinds})`
  );
}
