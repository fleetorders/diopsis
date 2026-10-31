import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeLayout,
  layoutFailureOf,
  MAX_LAYOUT_FINDINGS,
  MAX_OVERLAP_CANDIDATES,
  OVERLAP_MIN_AREA,
  type Box,
  type LayoutFinding,
  type MeasuredElement,
  type PageGeometry,
} from '../src/layout.ts';

/** A collected element with the defaults every finding is indifferent to. */
function element(selector: string, box: Box, over: Partial<MeasuredElement> = {}): MeasuredElement {
  return { selector, kind: 'text', box, ancestors: [], ...over };
}

/** A page whose viewport is what its content fills, unless a test says otherwise. */
const page = (over: Partial<PageGeometry> = {}): PageGeometry => ({ viewportWidth: 1280, scrollWidth: 1280, ...over });

describe('analyzeLayout — overlaps', () => {
  it('reports a title under an image, naming the covered and the covering', () => {
    const title = element('h1.title', { x: 0, y: 0, width: 200, height: 30 });
    const image = element('img.car', { x: 60, y: 0, width: 200, height: 120 }, { kind: 'media' });
    const [finding] = analyzeLayout([title, image], page());
    // Document order approximates paint order: the later element is the one on top.
    assert.equal(finding?.kind, 'overlap');
    assert.deepEqual(finding && finding.kind === 'overlap' ? finding.covered.selector : undefined, 'h1.title');
    assert.deepEqual(finding && finding.kind === 'overlap' ? finding.covering.selector : undefined, 'img.car');
    assert.deepEqual(finding && finding.kind === 'overlap' ? finding.overlap : undefined, { width: 140, height: 30 });
  });

  it('stays silent on glancing contact, a share of the smaller element below the line', () => {
    // The shared 20×20 patch is 400 px² of the tall element's 20 000 — layout noise.
    const tall = element('p.body', { x: 0, y: 0, width: 20, height: 1000 });
    const badge = element('span.badge', { x: 0, y: 980, width: 400, height: 20 });
    assert.deepEqual(analyzeLayout([tall, badge], page()), []);
  });

  it('stays silent below the minimum overlap area, whatever the share', () => {
    // Two 8×8 boxes sharing 8×7: 87.5% of the smaller one, but 56 px².
    assert.ok(8 * 7 < OVERLAP_MIN_AREA);
    const a = element('span.a', { x: 0, y: 0, width: 8, height: 8 });
    const b = element('span.b', { x: 1, y: 0, width: 8, height: 8 });
    assert.deepEqual(analyzeLayout([a, b], page()), []);
  });

  it('does not report a child inside its parent, only elements that collide', () => {
    const parent = element('div.card', { x: 0, y: 0, width: 300, height: 100 }, { kind: 'container' });
    const text = element('p.body', { x: 10, y: 10, width: 280, height: 80 }, { ancestors: [0] });
    assert.equal(analyzeLayout([parent, text], page()).length, 0);
  });

  it('never pairs two media elements — stacked images are a technique', () => {
    const back = element('img.back', { x: 0, y: 0, width: 200, height: 200 }, { kind: 'media' });
    const front = element('img.front', { x: 0, y: 0, width: 200, height: 200 }, { kind: 'media' });
    assert.deepEqual(analyzeLayout([back, front], page()), []);
  });

  it('pairs media with text, which is the finding the audit exists for', () => {
    const title = element('h1.title', { x: 0, y: 0, width: 200, height: 30 });
    const image = element('img.car', { x: 0, y: 0, width: 200, height: 120 }, { kind: 'media' });
    assert.equal(analyzeLayout([title, image], page()).length, 1);
  });

  it('stays silent on an overlap the page marked intended', () => {
    const title = element('h1.title', { x: 0, y: 0, width: 200, height: 30 });
    const image = element('img.car', { x: 0, y: 0, width: 200, height: 120 }, { kind: 'media', intended: true });
    assert.deepEqual(analyzeLayout([title, image], page()), []);
  });

  it('never pairs a container — only content elements collide', () => {
    // Two containers sharing every pixel, unrelated: not a finding, and not a crash.
    const a = element('div.a', { x: 0, y: 0, width: 100, height: 100 }, { kind: 'container' });
    const b = element('div.b', { x: 0, y: 0, width: 100, height: 100 }, { kind: 'container' });
    assert.deepEqual(analyzeLayout([a, b], page()), []);
  });
});

describe('analyzeLayout — text clips', () => {
  const clipping = (clip: MeasuredElement['clip']): MeasuredElement =>
    element('p.cut', { x: 0, y: 0, width: 100, height: 20 }, { clip });

  it('reports text the element\'s own box hides, on the axis that hides more', () => {
    const [finding] = analyzeLayout(
      [clipping({ x: 6, y: 40, ellipsis: false, lineClamp: false })],
      page(),
    );
    assert.equal(finding?.kind, 'text-clip');
    assert.deepEqual(
      finding && finding.kind === 'text-clip' ? { axis: finding.axis, hidden: finding.hidden } : undefined,
      { axis: 'y', hidden: 40 },
    );
  });

  it('treats an ellipsis on the axis as the design, not a cut-off', () => {
    assert.deepEqual(
      analyzeLayout([clipping({ x: 30, y: 0, ellipsis: true, lineClamp: false })], page()),
      [],
    );
  });

  it('treats a line clamp the same way on the vertical axis', () => {
    assert.deepEqual(
      analyzeLayout([clipping({ x: 0, y: 60, ellipsis: false, lineClamp: true })], page()),
      [],
    );
  });

  it('stays silent below the rounding threshold', () => {
    assert.deepEqual(analyzeLayout([clipping({ x: 3, y: 0, ellipsis: false, lineClamp: false })], page()), []);
  });

  it('reports a container that hides text below it, and not one hiding only media', () => {
    const container = (child: MeasuredElement): MeasuredElement[] => [
      element('div.frame', { x: 0, y: 0, width: 100, height: 50 }, { kind: 'container', clip: { x: 20, y: 0, ellipsis: false, lineClamp: false } }),
      { ...child, ancestors: [0] },
    ];
    // A thumbnail cropping its image is the design working.
    assert.deepEqual(
      analyzeLayout(
        container(element('img.thumb', { x: 0, y: 0, width: 80, height: 40 }, { kind: 'media' })),
        page(),
      ),
      [],
    );
    // The same box hiding a line of text is a cut-off.
    assert.equal(
      analyzeLayout(container(element('p.caption', { x: 0, y: 0, width: 80, height: 40 })), page()).length,
      1,
    );
  });
});

describe('analyzeLayout — horizontal overflow', () => {
  it('names the element reaching furthest past the right edge', () => {
    const near = element('table.rows', { x: 300, y: 0, width: 240, height: 20 }, { kind: 'container' });
    const far = element('img.hero', { x: 310, y: 40, width: 260, height: 20 }, { kind: 'media' });
    const [finding] = analyzeLayout([near, far], page({ viewportWidth: 320, scrollWidth: 570 }));
    assert.equal(finding?.kind, 'horizontal-overflow');
    assert.deepEqual(
      finding && finding.kind === 'horizontal-overflow'
        ? { selector: finding.element.selector, beyond: finding.beyond }
        : undefined,
      { selector: 'img.hero', beyond: 250 },
    );
  });

  it('stays silent on a page that does not scroll sideways', () => {
    const wide = element('div.wide', { x: 0, y: 0, width: 400, height: 20 }, { kind: 'container' });
    assert.deepEqual(analyzeLayout([wide], page({ viewportWidth: 400, scrollWidth: 400 })), []);
  });

  it('reports nothing when no collected element reaches past the edge', () => {
    // A scroll with nothing to point at — a walk that hit its limit, say — points at nothing
    // rather than at an element that sits inside the viewport.
    const inside = element('p.body', { x: 0, y: 0, width: 100, height: 20 });
    assert.deepEqual(analyzeLayout([inside], page({ viewportWidth: 320, scrollWidth: 500 })), []);
  });
});

describe('analyzeLayout — order and caps', () => {
  /** `n` disjoint pairs of fully overlapping text elements, sizes shrinking with the index. */
  const pairs = (n: number): MeasuredElement[] =>
    Array.from({ length: n }, (_, i) => {
      const box = { x: 0, y: i * 100, width: 120 - i, height: 40 };
      return [
        element(`span.a${i}`, box),
        element(`span.b${i}`, box),
      ];
    }).flat();

  it('leads with overlaps, largest first, and caps the list', () => {
    assert.ok(pairs(MAX_LAYOUT_FINDINGS + 5).length / 2 > MAX_LAYOUT_FINDINGS);
    const findings = analyzeLayout(pairs(MAX_LAYOUT_FINDINGS + 5), page());
    assert.equal(findings.length, MAX_LAYOUT_FINDINGS);
    assert.ok(findings.every((finding) => finding.kind === 'overlap'));
    // Largest first: every following overlap is no larger than the one before it.
    const sizes = findings.map((f) => (f.kind === 'overlap' ? f.overlap.width * f.overlap.height : 0));
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  });

  it('never pairs an element beyond the walk\'s candidate cap', () => {
    // The first MAX_OVERLAP_CANDIDATES candidates sit far apart; the colliding pair comes
    // after them, so the cap excludes it — the same page yields the same findings on every
    // machine precisely because the cut is by document order, not by luck.
    const filler = Array.from({ length: MAX_OVERLAP_CANDIDATES }, (_, i) =>
      element(`span.f${i}`, { x: 0, y: i * 50, width: 100, height: 20 }),
    );
    const box = { x: 0, y: 100000, width: 200, height: 30 };
    const findings = analyzeLayout([...filler, element('span.late-a', box), element('span.late-b', box)], page());
    assert.equal(findings.filter((f) => f.kind === 'overlap').length, 0);
  });

  it('yields byte-identical findings for the same measurements', () => {
    const measurements = pairs(8);
    const first = JSON.stringify(analyzeLayout(measurements, page()));
    const second = JSON.stringify(analyzeLayout(measurements, page()));
    assert.equal(first, second);
  });
});

describe('layoutFailureOf', () => {
  const findings: LayoutFinding[] = [
    {
      kind: 'overlap',
      covered: { selector: 'h1.title', kind: 'text', box: { x: 0, y: 0, width: 200, height: 30 } },
      covering: { selector: 'img.car', kind: 'media', box: { x: 0, y: 0, width: 200, height: 120 } },
      overlap: { width: 200, height: 30 },
    },
    {
      kind: 'text-clip',
      element: { selector: 'p.body', kind: 'text', box: { x: 0, y: 40, width: 100, height: 20 } },
      axis: 'x',
      hidden: 30,
    },
  ];

  it('names the story, the width and the kinds, in the classifier\'s marker words', () => {
    assert.equal(
      layoutFailureOf(findings, 'card--default', 320),
      'New layout findings: 2 in card--default @320 (overlap ×1, text-clip ×1)',
    );
  });

  it('keys the story by mode, the way the terminal line it becomes does', () => {
    assert.equal(
      layoutFailureOf(findings, 'card--default', 320, 'dark'),
      'New layout findings: 2 in card--default[@dark] @320 (overlap ×1, text-clip ×1)',
    );
  });

  it('passes a capture the audit found nothing in', () => {
    assert.equal(layoutFailureOf([], 'card--default', 320), undefined);
  });
});
