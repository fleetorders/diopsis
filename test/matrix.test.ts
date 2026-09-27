import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  effectiveCompare,
  loosenedStoryIds,
  platformToken,
  resolveMatrix,
  snapshotPathFor,
  toleranceForStory,
  widthsForStory,
} from '../src/matrix.ts';
import type { StoryEntry } from '../src/story-index.ts';

const viewports = { default: [320, 1280], mobile: [320, 480] };

function story(id: string, tags: string[] = []): StoryEntry {
  return { id, name: id, title: 'T', tags };
}

describe('platformToken', () => {
  it('joins platform and architecture', () => {
    assert.equal(platformToken('linux', 'x64'), 'linux-x64');
    assert.equal(platformToken('darwin', 'arm64'), 'darwin-arm64');
  });

  it('is what keeps a local run from overwriting the set CI reads', () => {
    assert.notEqual(
      snapshotPathFor('a--one', 320, platformToken('darwin', 'arm64')),
      snapshotPathFor('a--one', 320, platformToken('linux', 'x64')),
    );
  });
});

describe('snapshotPathFor', () => {
  it('puts the width and the platform in the filename', () => {
    assert.equal(snapshotPathFor('a--one', 320, 'linux-x64'), 'a--one/320w-linux-x64.png');
  });

  it('cannot be talked out of its directory', () => {
    assert.equal(
      snapshotPathFor('../../etc/passwd', 320, 'linux-x64'),
      '.._.._etc_passwd/320w-linux-x64.png',
    );
  });
});

describe('widthsForStory', () => {
  it('uses the default set when the story carries no directive', () => {
    assert.deepEqual(widthsForStory(story('a--one'), viewports).widths, [320, 1280]);
  });

  it('accepts a literal width', () => {
    assert.deepEqual(widthsForStory(story('a--one', ['diopsis:1280']), viewports).widths, [1280]);
  });

  it('accepts the name of a viewport set', () => {
    assert.deepEqual(widthsForStory(story('a--one', ['diopsis:mobile']), viewports).widths, [320, 480]);
  });

  it('unions several directives and sorts them', () => {
    const result = widthsForStory(story('a--one', ['diopsis:1280', 'diopsis:mobile']), viewports);
    assert.deepEqual(result.widths, [320, 480, 1280]);
  });

  it('honours diopsis:skip', () => {
    const result = widthsForStory(story('a--one', ['diopsis:skip']), viewports);
    assert.equal(result.skip, true);
    assert.deepEqual(result.widths, []);
  });

  it('warns about a directive that names nothing, and still captures', () => {
    const result = widthsForStory(story('a--one', ['diopsis:tablet']), viewports);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /diopsis:tablet/);
    // Falling back to the default set is the safe answer: skipping would hide a story silently.
    assert.deepEqual(result.widths, [320, 1280]);
  });

  it('ignores tags that are not directives', () => {
    assert.deepEqual(widthsForStory(story('a--one', ['dev', 'test']), viewports).widths, [320, 1280]);
  });
});

describe('toleranceForStory', () => {
  it('reads the three tolerance tags into the compare options they name', () => {
    const { compare } = toleranceForStory(
      story('a--one', ['diopsis:threshold=0.4', 'diopsis:max-diff-ratio=0.02', 'diopsis:max-diff-pixels=120']),
    );
    assert.deepEqual(compare, { threshold: 0.4, maxDiffPixelRatio: 0.02, maxDiffPixels: 120 });
  });

  it('carries only the keys the story set', () => {
    assert.deepEqual(toleranceForStory(story('a--one', ['diopsis:max-diff-ratio=0.02'])).compare, {
      maxDiffPixelRatio: 0.02,
    });
    assert.equal(toleranceForStory(story('a--one', ['diopsis:1280'])).compare, undefined);
    assert.equal(toleranceForStory(story('a--one')).compare, undefined);
  });

  it('warns and ignores a value that is out of range or not a number', () => {
    for (const directive of [
      'diopsis:threshold=2',
      'diopsis:threshold=high',
      'diopsis:max-diff-ratio=-0.1',
      'diopsis:max-diff-pixels=1.5',
    ]) {
      const result = toleranceForStory(story('a--one', [directive]));
      assert.equal(result.compare, undefined, directive);
      assert.equal(result.warnings.length, 1, directive);
      assert.match(result.warnings[0] ?? '', new RegExp(`a--one: tag "${directive}"`));
    }
  });

  it('never touches width resolution — a tolerance-only story keeps the default widths', () => {
    const result = widthsForStory(story('a--one', ['diopsis:threshold=0.4']), viewports);
    assert.deepEqual(result.widths, [320, 1280]);
    assert.deepEqual(result.warnings, []);
  });

  it('keeps width directives working beside tolerance tags', () => {
    const result = widthsForStory(
      story('a--one', ['diopsis:mobile', 'diopsis:max-diff-pixels=50']),
      viewports,
    );
    assert.deepEqual(result.widths, [320, 480]);
    assert.deepEqual(result.warnings, []);
  });

  it('still warns about an unknown diopsis key, and only once', () => {
    const result = widthsForStory(story('a--one', ['diopsis:foo=1']), viewports);
    assert.deepEqual(result.widths, [320, 1280]);
    assert.equal(result.warnings.length, 1);
    // The tolerance parser does not add a second warning for the same tag.
    assert.deepEqual(toleranceForStory(story('a--one', ['diopsis:foo=1'])).warnings, []);
  });
});

describe('resolveMatrix', () => {
  const stories = [
    story('a--one'),
    story('b--wide', ['diopsis:1280']),
    story('c--gone', ['diopsis:skip']),
  ];
  const matrix = resolveMatrix(stories, { viewports, viewportHeight: 900 }, 'linux-x64');

  it('counts captures, not stories', () => {
    assert.equal(stories.length, 3);
    assert.equal(matrix.captures.length, 3); // 2 + 1 + 0
  });

  it('reports what it skipped rather than dropping it quietly', () => {
    assert.deepEqual(matrix.skipped, ['c--gone']);
  });

  it('returns the full set as plain data, so a v2 filter is all that is needed', () => {
    assert.deepEqual(
      matrix.captures.map((c) => c.snapshotPath),
      ['a--one/320w-linux-x64.png', 'a--one/1280w-linux-x64.png', 'b--wide/1280w-linux-x64.png'],
    );
  });

  it('carries the story metadata a report and a v2 resolver both need', () => {
    const first = matrix.captures[0];
    assert.equal(first?.storyId, 'a--one');
    assert.equal(first?.height, 900);
  });
});

describe('resolveMatrix with tolerance tags', () => {
  const matrix = resolveMatrix(
    [
      story('a--one', ['diopsis:threshold=0.4']),
      story('b--two', ['diopsis:mobile', 'diopsis:max-diff-pixels=120']),
    ],
    { viewports, viewportHeight: 900 },
    'linux-x64',
  );

  it('attaches the story overrides, and only those keys, to every capture', () => {
    assert.deepEqual(matrix.captures[0]?.compare, { threshold: 0.4 });
    assert.deepEqual(matrix.captures[2]?.compare, { maxDiffPixels: 120 });
  });

  it('leaves a malformed tag a warning rather than a broken run', () => {
    const warned = resolveMatrix(
      [story('c--three', ['diopsis:threshold=9'])],
      { viewports, viewportHeight: 900 },
      'linux-x64',
    );
    assert.equal(warned.captures[0]?.compare, undefined);
    assert.equal(warned.warnings.length, 1);
  });
});

describe('loosenedStoryIds', () => {
  const compare = { threshold: 0.2, maxDiffPixelRatio: 0.001 };
  const oneWidth = { viewports: { default: [320] }, viewportHeight: 900 };

  it('names the stories whose tags widen any tolerance beyond the config', () => {
    const matrix = resolveMatrix(
      [
        story('a--loose', ['diopsis:threshold=0.6']),
        story('b--ratio', ['diopsis:max-diff-ratio=0.002']),
        story('c--pixels', ['diopsis:max-diff-pixels=1000']),
        story('f--fewer-pixels', ['diopsis:max-diff-pixels=10']),
        story('d--strict', ['diopsis:threshold=0.1']),
        story('e--plain'),
      ],
      oneWidth,
      'linux-x64',
    );
    assert.deepEqual(loosenedStoryIds(matrix.captures, compare), [
      'a--loose',
      'b--ratio',
      'c--pixels',
    ]);
  });

  it('measures a pixel override by what the config lets through at that viewport', () => {
    // 320 × 900 at a 0.001 ratio lets 288 pixels through.
    const matrix = resolveMatrix(
      [
        story('a--within', ['diopsis:max-diff-pixels=100']),
        story('b--beyond', ['diopsis:max-diff-pixels=500']),
      ],
      oneWidth,
      'linux-x64',
    );
    assert.deepEqual(loosenedStoryIds(matrix.captures, compare), ['b--beyond']);
    assert.deepEqual(loosenedStoryIds(matrix.captures, { ...compare, maxDiffPixelRatio: 1 }), []);
  });

  it('lists each story once, however many widths it captures', () => {
    const matrix = resolveMatrix(
      [story('a--loose', ['diopsis:threshold=0.6'])],
      { viewports: { default: [320, 1280] }, viewportHeight: 900 },
      'linux-x64',
    );
    assert.equal(matrix.captures.length, 2);
    assert.deepEqual(loosenedStoryIds(matrix.captures, compare), ['a--loose']);
  });
});

describe('resolveMatrix with an empty default set', () => {
  it('lists stories with no widths as unwatched instead of dropping them quietly', () => {
    const matrix = resolveMatrix(
      [story('a--one'), story('b--tagged', ['diopsis:mobile']), story('c--gone', ['diopsis:skip'])],
      { viewports: { default: [], mobile: [320] }, viewportHeight: 900 },
      'linux-x64',
    );
    // A story tagged with a width is still watched; only the untagged ones lose everything.
    assert.deepEqual(matrix.captures.map((c) => c.snapshotPath), ['b--tagged/320w-linux-x64.png']);
    assert.deepEqual(matrix.unwatched, ['a--one']);
    assert.deepEqual(matrix.skipped, ['c--gone']);
  });
});

describe('baseline path collisions', () => {
  it('refuses two story ids that would silently share one baseline', () => {
    // Both ids collapse onto the same safe directory segment.
    assert.equal(
      snapshotPathFor('a b--c', 320, 'linux-x64'),
      snapshotPathFor('a:b--c', 320, 'linux-x64'),
    );
    assert.throws(
      () =>
        resolveMatrix(
          [story('a b--c'), story('a:b--c')],
          { viewports, viewportHeight: 900 },
          'linux-x64',
        ),
      /"a b--c".*"a:b--c".*baseline/,
    );
  });
});

describe('effectiveCompare', () => {
  const base = { threshold: 0.2, maxDiffPixelRatio: 0.001 };

  it('returns the configured comparison when a story sets nothing', () => {
    assert.deepEqual(effectiveCompare(base, undefined), base);
  });

  it('lets a story pixel count replace the configured ratio, so it can loosen as well as tighten', () => {
    assert.deepEqual(effectiveCompare(base, { maxDiffPixels: 500 }), {
      threshold: 0.2,
      maxDiffPixels: 500,
    });
  });

  it('lets a story ratio replace a configured pixel count too', () => {
    assert.deepEqual(effectiveCompare({ ...base, maxDiffPixels: 40 }, { maxDiffPixelRatio: 0.01 }), {
      threshold: 0.2,
      maxDiffPixelRatio: 0.01,
    });
  });

  it('keeps the configured limits when a story changes only the threshold', () => {
    assert.deepEqual(effectiveCompare({ ...base, maxDiffPixels: 40 }, { threshold: 0.4 }), {
      threshold: 0.4,
      maxDiffPixelRatio: 0.001,
      maxDiffPixels: 40,
    });
  });
});
