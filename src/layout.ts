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
   * Indices of this element's collected ancestors, closest first. Overlap is judged between
   * unrelated elements only — a child inside its parent is layout, not collision — and this
   * is the whole ancestry the walk needs to say so.
   */
  ancestors: number[];
  /**
   * How much of the element's own content its box hides, per axis, in CSS pixels, with
   * whether the hiding is a deliberate truncation style (ellipsis on the axis,
   * line clamping). Present only when the element clips something.
   */
  clip?: { x: number; y: number; ellipsis: boolean; lineClamp: boolean };
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
function intersection(a: Box, b: Box): { width: number; height: number } | undefined {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Whether a clipping element holds something the review cares about: its own text, or text
 * or a control anywhere below it. Media crops are excluded on purpose — a thumbnail that
 * crops its image is the design working, where cut-off text is the design broken.
 */
function clipsReadableContent(
  element: MeasuredElement,
  index: number,
  elements: MeasuredElement[],
): boolean {
  if (element.kind === 'text' || element.kind === 'control') return true;
  return elements.some(
    (other) =>
      (other.kind === 'text' || other.kind === 'control') && other.ancestors.includes(index),
  );
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
  // the element that reaches furthest is the one to name. A scroll with no collected element
  // past the edge (a walk that hit its limit, say) reports nothing rather than a finding
  // that points at nothing.
  if (page.scrollWidth > page.viewportWidth + OVERFLOW_MIN_PX) {
    let worst: MeasuredElement | undefined;
    for (const element of elements) {
      const beyond = element.box.x + element.box.width - page.viewportWidth;
      if (beyond > OVERFLOW_MIN_PX && (!worst || beyond > worst.box.x + worst.box.width - page.viewportWidth)) {
        worst = element;
      }
    }
    if (worst) {
      overflows.push({
        kind: 'horizontal-overflow',
        element: refOf(worst),
        beyond: Math.round(worst.box.x + worst.box.width - page.viewportWidth),
      });
    }
  }

  // Cut-off content: hidden overflow with more content than the box shows. An ellipsis on
  // the horizontal axis is a deliberate truncation, and a line clamp is the vertical
  // equivalent; neither is a finding even though both hide text.
  for (const [index, element] of elements.entries()) {
    const clip = element.clip;
    if (!clip || !clipsReadableContent(element, index, elements)) continue;
    const xHidden = clip.x > CLIP_MIN_PX && !clip.ellipsis ? clip.x : 0;
    const yHidden = clip.y > CLIP_MIN_PX && !clip.lineClamp ? clip.y : 0;
    const axis: 'x' | 'y' | undefined =
      xHidden >= yHidden && xHidden > 0 ? 'x' : yHidden > 0 ? 'y' : undefined;
    if (axis) {
      clips.push({
        kind: 'text-clip',
        element: refOf(element),
        axis,
        hidden: Math.round(axis === 'x' ? clip.x : clip.y),
      });
    }
  }

  // Overlaps: pairs of unrelated, visible content elements sharing enough of the smaller
  // one's area. Two media elements are excluded — stacked images are a technique, not a
  // lost reading — while any pair involving text or a control is exactly what the audit
  // exists to catch. Marked elements never take part.
  const candidates = elements
    .map((element, index) => ({ element, index }))
    .filter(
      ({ element }) =>
        element.kind !== 'container' && !element.intended && area(element.box) > 0,
    )
    .slice(0, MAX_OVERLAP_CANDIDATES);
  for (let i = 0; i < candidates.length; i++) {
    const first = candidates[i]!;
    for (let j = i + 1; j < candidates.length; j++) {
      const second = candidates[j]!;
      if (first.element.kind === 'media' && second.element.kind === 'media') continue;
      if (related(elements, first.index, second.index)) continue;
      const overlap = intersection(first.element.box, second.element.box);
      if (!overlap) continue;
      const shared = overlap.width * overlap.height;
      if (shared < OVERLAP_MIN_AREA) continue;
      if (
        shared / Math.min(area(first.element.box), area(second.element.box)) <
        OVERLAP_SHARE
      )
        continue;
      overlaps.push({
        kind: 'overlap',
        // Document order approximates paint order: the later element is the one on top.
        covered: refOf(first.element),
        covering: refOf(second.element),
        overlap: { width: Math.round(overlap.width), height: Math.round(overlap.height) },
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
