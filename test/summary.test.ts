import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { artifactsOf, stripAnsi } from '../src/reporter.ts';
import {
  changedStoriesOf,
  classify,
  needsReview,
  totalsFor,
  type CaptureResult,
} from '../src/report/summary.ts';

const MISSING =
  "Error: A snapshot doesn't exist at /repo/__screenshots__/a--one/320w-linux-x64.png, writing actual.";
const CHANGED =
  'Error: expect(page).toHaveScreenshot(expected) failed\n\n' +
  '  6,798 pixels (ratio 0.03 of all image pixels) are different.';

describe('classify', () => {
  it('calls a passing test unchanged', () => {
    assert.deepEqual(classify({ passed: true, errorText: '' }), { status: 'unchanged' });
  });

  it('separates a missing baseline from a real difference', () => {
    // Both present as a failing Playwright test, and they need opposite responses.
    assert.equal(classify({ passed: false, errorText: MISSING }).status, 'new');
    assert.equal(classify({ passed: false, errorText: CHANGED }).status, 'changed');
  });

  it('reads the pixel count and ratio out of the comparator message', () => {
    const verdict = classify({ passed: false, errorText: CHANGED });
    assert.equal(verdict.diffPixels, 6798);
    assert.equal(verdict.diffRatio, 0.03);
  });

  it('treats a story that would not render as its own state', () => {
    const verdict = classify({ passed: false, errorText: 'StoryRenderError: boom' });
    assert.equal(verdict.status, 'render-failed');
  });

  it('still calls a comparison failure changed when no pixel count was reported', () => {
    const verdict = classify({ passed: false, errorText: 'toHaveScreenshot: sizes differ' });
    assert.equal(verdict.status, 'changed');
  });

  it('falls back to a plain failure for anything else', () => {
    assert.equal(classify({ passed: false, errorText: 'Test timed out.' }).status, 'failed');
  });
});

describe('needsReview', () => {
  it('is true for everything a person has to look at', () => {
    assert.equal(needsReview('changed'), true);
    assert.equal(needsReview('new'), true);
    assert.equal(needsReview('render-failed'), true);
    assert.equal(needsReview('failed'), true);
    assert.equal(needsReview('unchanged'), false);
  });
});

function capture(over: Partial<CaptureResult>): CaptureResult {
  return {
    storyId: 'a--one',
    storyTitle: 'A',
    storyName: 'One',
    width: 320,
    status: 'unchanged',
    snapshotPath: 'a--one/320w-linux-x64.png',
    artifacts: {},
    ...over,
  };
}

describe('totalsFor', () => {
  it('counts captures and the distinct stories behind them', () => {
    const totals = totalsFor([
      capture({}),
      capture({ width: 1280 }),
      capture({ storyId: 'b--two', status: 'changed' }),
      capture({ storyId: 'c--three', status: 'new' }),
    ]);
    assert.equal(totals.captures, 4);
    assert.equal(totals.stories, 3);
    assert.equal(totals.unchanged, 2);
    assert.equal(totals.changed, 1);
    assert.equal(totals.new, 1);
  });
});

describe('changedStoriesOf', () => {
  it('lists each story needing review once, sorted', () => {
    assert.deepEqual(
      changedStoriesOf([
        capture({ storyId: 'z--one', status: 'changed' }),
        capture({ storyId: 'z--one', status: 'changed', width: 1280 }),
        capture({ storyId: 'a--one', status: 'new' }),
        capture({ storyId: 'm--one', status: 'unchanged' }),
      ]),
      ['a--one', 'z--one'],
    );
  });
});

describe('artifactsOf', () => {
  const outputDir = '/repo/.diopsis';
  const at = (name: string): string =>
    path.join(outputDir, 'test-results', 'diopsis-a--one-320-chromium', 'a--one', name);

  it('separates the three images by filename, not by attachment name', () => {
    // Playwright gives all three the same attachment name; only the path distinguishes them.
    const artifacts = artifactsOf(
      [
        { name: 'a--one/320w-linux-x64', path: at('320w-linux-x64-expected.png'), contentType: 'image/png' },
        { name: 'a--one/320w-linux-x64', path: at('320w-linux-x64-actual.png'), contentType: 'image/png' },
        { name: 'a--one/320w-linux-x64', path: at('320w-linux-x64-diff.png'), contentType: 'image/png' },
      ],
      outputDir,
    );
    assert.match(artifacts.expected ?? '', /-expected\.png$/);
    assert.match(artifacts.actual ?? '', /-actual\.png$/);
    assert.match(artifacts.diff ?? '', /-diff\.png$/);
  });

  it('treats an unsuffixed image as the actual, which is what a new baseline attaches', () => {
    const artifacts = artifactsOf(
      [{ name: 'a--one/320w', path: at('320w-linux-x64.png'), contentType: 'image/png' }],
      outputDir,
    );
    assert.match(artifacts.actual ?? '', /320w-linux-x64\.png$/);
    assert.equal(artifacts.diff, undefined);
  });

  it('records paths relative to the output directory, so the run stays portable', () => {
    const artifacts = artifactsOf(
      [{ name: 'x', path: at('320w-linux-x64-diff.png'), contentType: 'image/png' }],
      outputDir,
    );
    assert.ok(!path.isAbsolute(artifacts.actual ?? 'x'));
  });

  it('ignores attachments that are not images', () => {
    const artifacts = artifactsOf(
      [{ name: 'trace', path: '/repo/.diopsis/trace.zip', contentType: 'application/zip' }],
      outputDir,
    );
    assert.deepEqual(artifacts, {});
  });
});

describe('stripAnsi', () => {
  it('removes the colouring Playwright puts in its error messages', () => {
    assert.equal(stripAnsi('\u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m)'), 'expect(page)');
  });

  it('leaves plain text alone', () => {
    assert.equal(stripAnsi('6798 pixels are different'), '6798 pixels are different');
  });
});

import { NOT_RUN } from '../src/report/summary.ts';

describe('classify with the baseline annotation', () => {
  const NONE_VARIANT =
    "A snapshot doesn't exist at /repo/__screenshots__/a--one/320w-linux-x64.png.";

  it('calls a missing baseline new whatever the message says', () => {
    assert.equal(classify({ passed: false, errorText: 'boom', baseline: 'missing' }).status, 'new');
  });

  it('fixes the --update-snapshots=none wording, which carries no ", writing actual"', () => {
    assert.equal(
      classify({ passed: false, errorText: NONE_VARIANT, baseline: 'missing' }).status,
      'new',
    );
  });

  it('keeps a timeout a failure even when no baseline exists', () => {
    assert.equal(
      classify({ passed: false, errorText: 'Test timed out.', timedOut: true, baseline: 'missing' })
        .status,
      'failed',
    );
  });

  it('keeps a story that never rendered out of "new"', () => {
    assert.equal(
      classify({ passed: false, errorText: 'StoryRenderError: boom', baseline: 'missing' }).status,
      'render-failed',
    );
  });

  it('falls back to the message regexes when no annotation is present', () => {
    assert.equal(classify({ passed: false, errorText: MISSING }).status, 'new');
  });
});

describe('interrupted runs', () => {
  it('counts not-run captures separately from real failures', () => {
    const totals = totalsFor([
      capture({}),
      capture({ status: 'failed', error: NOT_RUN }),
      capture({ storyId: 'b--two', status: 'failed', error: 'expect(page) failed' }),
    ]);
    assert.equal(totals.captures, 3);
    assert.equal(totals.notRun, 1);
    assert.equal(totals.failed, 1);
  });

  it('does not advertise a not-run story as needing review', () => {
    assert.deepEqual(
      changedStoriesOf([
        capture({ status: 'failed', error: NOT_RUN }),
        capture({ storyId: 'b--two', status: 'changed' }),
      ]),
      ['b--two'],
    );
  });
});

describe('accessibility findings in the summary', () => {
  it('classifies a capture the audit failed as changed — the response is accept', () => {
    // The comparison passed and the findings failed the test; the story needs a review
    // exactly like a pixel change, so it lands in the status whose response is accept.
    const verdict = classify({
      passed: false,
      errorText: 'Error: New accessibility findings: 2 in card--default (image-alt, button-name)',
    });
    assert.equal(verdict.status, 'changed');
  });

  it('totals new findings across the run, and only when the run audited', () => {
    const findings = { violations: [], new: 2 };
    const totals = totalsFor([
      capture({ accessibility: findings }),
      capture({ width: 1280 }),
      capture({ storyId: 'b--two', accessibility: { violations: [], new: 1 } }),
    ]);
    assert.equal(totals.a11yNew, 3);
    // A zero on a run that never looked is not a clean bill of health — the audit being
    // off is reported by the key's absence, not by a zero.
    assert.equal('a11yNew' in totalsFor([capture({})]), false);
  });

  it('counts a story failed on findings among the changed stories', () => {
    assert.deepEqual(
      changedStoriesOf([
        capture({ status: 'changed', error: 'New accessibility findings: 1 in a--one (image-alt)', accessibility: { violations: [], new: 1 } }),
        capture({ storyId: 'b--two' }),
      ]),
      ['a--one'],
    );
  });
});
