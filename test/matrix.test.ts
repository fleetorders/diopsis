import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiopsisConfig } from '../src/config.ts';
import {
  effectiveCompare,
  loosenedStoryIds,
  modesForStory,
  parseSnapshotPath,
  platformToken,
  resolveMatrix,
  scopeForStory,
  snapshotPathFor,
  statesForStory,
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

  it('treats the scope tags as directives that name no width', () => {
    const result = widthsForStory(story('a--one', ['diopsis:component']), viewports);
    assert.deepEqual(result.widths, [320, 1280]);
    assert.deepEqual(result.warnings, []);
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
  const matrix = resolveMatrix(stories, { viewports, viewportHeight: 900, capture: 'page' }, 'linux-x64');

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
    { viewports, viewportHeight: 900, capture: 'page' },
    'linux-x64',
  );

  it('attaches the story overrides, and only those keys, to every capture', () => {
    assert.deepEqual(matrix.captures[0]?.compare, { threshold: 0.4 });
    assert.deepEqual(matrix.captures[2]?.compare, { maxDiffPixels: 120 });
  });

  it('leaves a malformed tag a warning rather than a broken run', () => {
    const warned = resolveMatrix(
      [story('c--three', ['diopsis:threshold=9'])],
      { viewports, viewportHeight: 900, capture: 'page' },
      'linux-x64',
    );
    assert.equal(warned.captures[0]?.compare, undefined);
    assert.equal(warned.warnings.length, 1);
  });
});

describe('loosenedStoryIds', () => {
  const compare = { threshold: 0.2, maxDiffPixelRatio: 0.001 };
  const oneWidth: Pick<DiopsisConfig, 'viewports' | 'viewportHeight' | 'capture'> = {
    viewports: { default: [320] },
    viewportHeight: 900,
    capture: 'page',
  };

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
      { viewports: { default: [320, 1280] }, viewportHeight: 900, capture: 'page' },
      'linux-x64',
    );
    assert.equal(matrix.captures.length, 2);
    assert.deepEqual(loosenedStoryIds(matrix.captures, compare), ['a--loose']);
  });

  it('judges a component capture by its own knobs, not the viewport area', () => {
    // A component clip is far smaller than its viewport, so at the viewport's area a
    // max-diff-pixels of 200 sits under the configured ratio's allowance and reads as a
    // tightening — while on the clip itself the ratio is gone and 200 pixels is dozens of
    // times what the config would let through.
    const matrix = resolveMatrix(
      [story('c--small', ['diopsis:component', 'diopsis:max-diff-pixels=200'])],
      oneWidth,
      'linux-x64',
    );
    assert.equal(matrix.captures[0]?.scope, 'component');
    assert.deepEqual(loosenedStoryIds(matrix.captures, compare), ['c--small']);
  });
});

describe('scopeForStory', () => {
  it('follows the configured scope when the story carries no scope tag', () => {
    assert.equal(scopeForStory(story('a--one'), 'page').scope, 'page');
    assert.equal(scopeForStory(story('a--one'), 'component').scope, 'component');
  });

  it('lets a tag override the configured scope in either direction', () => {
    assert.equal(scopeForStory(story('a--one', ['diopsis:component']), 'page').scope, 'component');
    assert.equal(scopeForStory(story('a--one', ['diopsis:page']), 'component').scope, 'page');
  });

  it('resolves a story carrying both tags to the page, with a warning', () => {
    const result = scopeForStory(story('a--one', ['diopsis:component', 'diopsis:page']), 'component');
    assert.equal(result.scope, 'page');
    assert.equal(result.warnings.length, 1);
    assert.match(
      result.warnings[0] ?? '',
      /a--one: tags "diopsis:page" and "diopsis:component" both set — "page" wins\./,
    );
  });

  it('stays quiet when a tag agrees with the config or names no scope', () => {
    assert.deepEqual(scopeForStory(story('a--one', ['diopsis:component']), 'component').warnings, []);
    assert.deepEqual(scopeForStory(story('a--one', ['diopsis:1280']), 'page').warnings, []);
    assert.deepEqual(scopeForStory(story('a--one', ['diopsis:threshold=0.4']), 'page').warnings, []);
  });
});

describe('resolveMatrix with scope tags', () => {
  const matrix = resolveMatrix(
    [
      story('a--plain'),
      story('b--chip', ['diopsis:component']),
      story('c--pinned', ['diopsis:page']),
      story('d--both', ['diopsis:page', 'diopsis:component']),
    ],
    { viewports: { default: [320] }, viewportHeight: 900, capture: 'page' },
    'linux-x64',
  );

  it('stamps every capture with the scope it will run at', () => {
    assert.deepEqual(matrix.captures.map((c) => c.scope), ['page', 'component', 'page', 'page']);
  });

  it('defaults to the configured component scope', () => {
    const componentRun = resolveMatrix(
      [story('a--one'), story('b--pinned', ['diopsis:page'])],
      { viewports: { default: [320] }, viewportHeight: 900, capture: 'component' },
      'linux-x64',
    );
    assert.deepEqual(componentRun.captures.map((c) => c.scope), ['component', 'page']);
  });

  it('warns about the story carrying both scope tags, once', () => {
    assert.equal(matrix.warnings.length, 1);
    assert.match(matrix.warnings[0] ?? '', /d--both: tags/);
  });
});

describe('resolveMatrix with an empty default set', () => {
  it('lists stories with no widths as unwatched instead of dropping them quietly', () => {
    const matrix = resolveMatrix(
      [story('a--one'), story('b--tagged', ['diopsis:mobile']), story('c--gone', ['diopsis:skip'])],
      { viewports: { default: [], mobile: [320] }, viewportHeight: 900, capture: 'page' },
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
          { viewports, viewportHeight: 900, capture: 'page' },
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

describe('snapshotPathFor with a mode', () => {
  it('puts the mode between the width and the platform', () => {
    assert.equal(snapshotPathFor('a--one', 320, 'linux-x64', 'dark'), 'a--one/320w-dark-linux-x64.png');
  });

  it('leaves the base path exactly as it was', () => {
    assert.equal(snapshotPathFor('a--one', 320, 'linux-x64'), 'a--one/320w-linux-x64.png');
    assert.equal(
      snapshotPathFor('a--one', 320, 'linux-x64', undefined),
      'a--one/320w-linux-x64.png',
    );
  });
});

describe('modesForStory', () => {
  const modes = { dark: { theme: 'dark' }, rtl: { direction: 'rtl', locale: 'ar' } };

  it('captures every configured mode when the story carries no restriction', () => {
    assert.deepEqual(modesForStory(story('a--one'), modes), { modes: ['dark', 'rtl'], warnings: [] });
  });

  it('restricts a story to the modes its tag names', () => {
    const result = modesForStory(story('a--one', ['diopsis:modes=rtl']), modes);
    assert.deepEqual(result.modes, ['rtl']);
    assert.deepEqual(result.warnings, []);
  });

  it('captures only the base for diopsis:modes=none', () => {
    const result = modesForStory(story('a--one', ['diopsis:modes=none']), modes);
    assert.deepEqual(result.modes, []);
    assert.deepEqual(result.warnings, []);
  });

  it('warns about a mode the config does not carry, and ignores it', () => {
    const result = modesForStory(story('a--one', ['diopsis:modes=dark,print']), modes);
    assert.deepEqual(result.modes, ['dark']);
    assert.equal(result.warnings.length, 1);
    assert.match(
      result.warnings[0] ?? '',
      /a--one: tag "diopsis:modes=dark,print" names a mode not configured: print \(known: dark, rtl\)\./,
    );
  });

  it('keeps the configured order however the tag lists them', () => {
    assert.deepEqual(modesForStory(story('a--one', ['diopsis:modes=rtl,dark']), modes).modes, [
      'dark',
      'rtl',
    ]);
  });

  it('says the config carries no modes when a story tags for them anyway', () => {
    const result = modesForStory(story('a--one', ['diopsis:modes=dark']), undefined);
    assert.deepEqual(result.modes, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /a--one: tag "diopsis:modes=dark" names modes but none/);
  });

  it('never touches width resolution — a modes-only story keeps the default widths', () => {
    const result = widthsForStory(story('a--one', ['diopsis:modes=dark']), viewports);
    assert.deepEqual(result.widths, [320, 1280]);
    assert.deepEqual(result.warnings, []);
  });
});

describe('statesForStory', () => {
  it('reads one state per tag, in tag order, with the action the tag names', () => {
    const result = statesForStory(story('a--one', ['diopsis:hover=button', 'diopsis:focus=input']));
    assert.deepEqual(result.states, [
      { name: 'hover', action: 'hover', selector: 'button' },
      { name: 'focus', action: 'focus', selector: 'input' },
    ]);
    assert.deepEqual(result.warnings, []);
  });

  it('keeps everything after the first equals — spaces and further equals included', () => {
    const result = statesForStory(
      story('a--one', ['diopsis:active=button[type=submit] .label=x']),
    );
    assert.deepEqual(result.states, [
      { name: 'active', action: 'active', selector: 'button[type=submit] .label=x' },
    ]);
  });

  it('numbers a kind beyond its first tag: hover, hover-2, hover-3', () => {
    const result = statesForStory(
      story('a--one', ['diopsis:hover=a', 'diopsis:hover=b', 'diopsis:hover=c', 'diopsis:focus=d']),
    );
    assert.deepEqual(
      result.states.map((state) => state.name),
      ['hover', 'hover-2', 'hover-3', 'focus'],
    );
  });

  it('warns about a tag whose selector names nothing, and captures no state for it', () => {
    const result = statesForStory(story('a--one', ['diopsis:hover=', 'diopsis:focus= ']));
    assert.deepEqual(result.states, []);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0] ?? '', /a--one: tag "diopsis:hover=" names no selector — ignored\./);
  });

  it('never touches width resolution — a state-only story keeps the default widths', () => {
    const result = widthsForStory(story('a--one', ['diopsis:hover=button']), viewports);
    assert.deepEqual(result.widths, [320, 1280]);
    assert.deepEqual(result.warnings, []);
  });
});

describe('resolveMatrix with modes', () => {
  const modes = { dark: { theme: 'dark' }, rtl: { direction: 'rtl' } };
  const withModes: Pick<DiopsisConfig, 'viewports' | 'viewportHeight' | 'capture' | 'modes'> = {
    viewports: { default: [320] },
    viewportHeight: 900,
    capture: 'page',
    modes,
  };

  it('captures the base plus every mode, base first', () => {
    const matrix = resolveMatrix([story('a--one')], withModes, 'linux-x64');
    assert.deepEqual(
      matrix.captures.map((c) => [c.snapshotPath, c.mode]),
      [
        ['a--one/320w-linux-x64.png', undefined],
        ['a--one/320w-dark-linux-x64.png', 'dark'],
        ['a--one/320w-rtl-linux-x64.png', 'rtl'],
      ],
    );
  });

  it('keeps the base path and the absent mode key what they were without modes', () => {
    const without = resolveMatrix(
      [story('a--one')],
      { viewports: { default: [320] }, viewportHeight: 900, capture: 'page' },
      'linux-x64',
    );
    const matrix = resolveMatrix([story('a--one')], withModes, 'linux-x64');
    assert.equal(matrix.captures[0]?.snapshotPath, without.captures[0]?.snapshotPath);
    assert.equal('mode' in (matrix.captures[0] ?? {}), false);
  });

  it('honours a story restriction and a modes=none tag', () => {
    const matrix = resolveMatrix(
      [story('a--only-dark', ['diopsis:modes=dark']), story('b--base', ['diopsis:modes=none'])],
      withModes,
      'linux-x64',
    );
    assert.deepEqual(
      matrix.captures.map((c) => c.snapshotPath),
      [
        'a--only-dark/320w-linux-x64.png',
        'a--only-dark/320w-dark-linux-x64.png',
        'b--base/320w-linux-x64.png',
      ],
    );
  });

  it('carries the story tags through every mode capture, and warns once', () => {
    const matrix = resolveMatrix(
      [story('a--one', ['diopsis:threshold=0.4', 'diopsis:modes=print'])],
      withModes,
      'linux-x64',
    );
    assert.equal(matrix.warnings.length, 1);
    assert.match(matrix.warnings[0] ?? '', /print/);
    for (const capture of matrix.captures) {
      assert.deepEqual(capture.compare, { threshold: 0.4 });
    }
  });

  it('still refuses two story ids that would share a baseline directory', () => {
    assert.throws(
      () => resolveMatrix([story('a b--c'), story('a:b--c')], withModes, 'linux-x64'),
      /baseline/,
    );
  });
});

describe('resolveMatrix with states', () => {
  const plain: Pick<DiopsisConfig, 'viewports' | 'viewportHeight' | 'capture'> = {
    viewports: { default: [320] },
    viewportHeight: 900,
    capture: 'page',
  };
  const withStates: Pick<DiopsisConfig, 'viewports' | 'viewportHeight' | 'capture' | 'modes'> = {
    ...plain,
    modes: { dark: { theme: 'dark' } },
  };

  it('adds one capture per state beside the plain one, which always remains', () => {
    const matrix = resolveMatrix([story('a--one', ['diopsis:hover=button'])], plain, 'linux-x64');
    assert.deepEqual(
      matrix.captures.map((c) => [c.snapshotPath, c.state?.name]),
      [
        ['a--one/320w-linux-x64.png', undefined],
        ['a--one/320w-hover-linux-x64.png', 'hover'],
      ],
    );
    assert.deepEqual(matrix.captures[1]?.state, {
      name: 'hover',
      action: 'hover',
      selector: 'button',
    });
    // The plain capture carries no state key at all, so it stays byte-identical to before.
    assert.equal('state' in (matrix.captures[0] ?? {}), false);
  });

  it('captures every state in every mode, the state after the mode in the path', () => {
    const matrix = resolveMatrix([story('a--one', ['diopsis:focus=input'])], withStates, 'linux-x64');
    assert.deepEqual(
      matrix.captures.map((c) => c.snapshotPath),
      [
        'a--one/320w-linux-x64.png',
        'a--one/320w-focus-linux-x64.png',
        'a--one/320w-dark-linux-x64.png',
        'a--one/320w-dark-focus-linux-x64.png',
      ],
    );
  });

  it('numbers repeated tags of a kind in tag order, one baseline each', () => {
    const matrix = resolveMatrix(
      [story('a--one', ['diopsis:hover=a', 'diopsis:hover=b'])],
      { viewports: { default: [320] }, viewportHeight: 900, capture: 'page' },
      'linux-x64',
    );
    assert.deepEqual(
      matrix.captures.map((c) => c.snapshotPath),
      ['a--one/320w-linux-x64.png', 'a--one/320w-hover-linux-x64.png', 'a--one/320w-hover-2-linux-x64.png'],
    );
  });

  it('carries the story metadata into every state capture, and warns once for a malformed tag', () => {
    const matrix = resolveMatrix(
      [story('a--one', ['diopsis:threshold=0.4', 'diopsis:hover='])],
      { viewports: { default: [320] }, viewportHeight: 900, capture: 'page' },
      'linux-x64',
    );
    assert.equal(matrix.warnings.length, 1);
    assert.match(matrix.warnings[0] ?? '', /diopsis:hover=/);
    assert.deepEqual(
      matrix.captures.map((c) => c.snapshotPath),
      ['a--one/320w-linux-x64.png'],
    );
    assert.deepEqual(matrix.captures[0]?.compare, { threshold: 0.4 });
  });

  it('leaves a story without state tags exactly as it was', () => {
    const matrix = resolveMatrix([story('a--one')], withStates, 'linux-x64');
    assert.deepEqual(matrix.captures.map((c) => 'state' in c), [false, false]);
  });
});

describe('snapshotPathFor with a state', () => {
  it('puts the state after the mode, before the platform', () => {
    assert.equal(
      snapshotPathFor('a--one', 320, 'linux-x64', 'dark', 'hover-2'),
      'a--one/320w-dark-hover-2-linux-x64.png',
    );
  });

  it('writes a state with no mode directly after the width', () => {
    assert.equal(
      snapshotPathFor('a--one', 320, 'linux-x64', undefined, 'focus'),
      'a--one/320w-focus-linux-x64.png',
    );
  });

  it('leaves the plain and mode paths exactly as they were', () => {
    assert.equal(snapshotPathFor('a--one', 320, 'linux-x64'), 'a--one/320w-linux-x64.png');
    assert.equal(snapshotPathFor('a--one', 320, 'linux-x64', 'dark'), 'a--one/320w-dark-linux-x64.png');
  });
});

describe('parseSnapshotPath', () => {
  it('reads a base path back into what it names', () => {
    assert.deepEqual(parseSnapshotPath(snapshotPathFor('a--one', 320, 'linux-x64')), {
      storyId: 'a--one',
      width: 320,
      platform: 'linux-x64',
    });
  });

  it('reads a mode path back, mode included', () => {
    assert.deepEqual(parseSnapshotPath(snapshotPathFor('a--one', 1280, 'linux-x64', 'dark')), {
      storyId: 'a--one',
      width: 1280,
      mode: 'dark',
      platform: 'linux-x64',
    });
  });

  it('keeps a mode whose name holds a dash apart from the platform token', () => {
    assert.deepEqual(
      parseSnapshotPath(snapshotPathFor('a--one', 320, 'linux-x64', 'right-to-left')),
      {
        storyId: 'a--one',
        width: 320,
        mode: 'right-to-left',
        platform: 'linux-x64',
      },
    );
  });

  it('round-trips through the safe segment, not the id that was folded into it', () => {
    // A parse cannot unfold what safeSegment never wrote; the segment is the honest answer.
    assert.equal(parseSnapshotPath(snapshotPathFor('a b--c', 320, 'linux-x64'))?.storyId, 'a_b--c');
  });

  it('reads a state path back, state included beside its mode', () => {
    assert.deepEqual(parseSnapshotPath(snapshotPathFor('a--one', 1280, 'linux-x64', 'dark', 'hover')), {
      storyId: 'a--one',
      width: 1280,
      mode: 'dark',
      state: 'hover',
      platform: 'linux-x64',
    });
  });

  it('reads a state with no mode directly after the width', () => {
    assert.deepEqual(parseSnapshotPath(snapshotPathFor('a--one', 320, 'linux-x64', undefined, 'focus')), {
      storyId: 'a--one',
      width: 320,
      state: 'focus',
      platform: 'linux-x64',
    });
  });

  it('reads a numbered state as one name', () => {
    assert.deepEqual(parseSnapshotPath('a--one/320w-dark-hover-2-linux-x64.png'), {
      storyId: 'a--one',
      width: 320,
      mode: 'dark',
      state: 'hover-2',
      platform: 'linux-x64',
    });
  });

  it('keeps a mode out of the state vocabulary untouched', () => {
    // "hovering" only starts like a state, and the numbering begins at 2, so neither is one.
    assert.equal(parseSnapshotPath('a--one/320w-hovering-linux-x64.png')?.mode, 'hovering');
    assert.equal(parseSnapshotPath('a--one/320w-hover-1-linux-x64.png')?.mode, 'hover-1');
    assert.equal(parseSnapshotPath('a--one/320w-hover-dark-linux-x64.png')?.mode, 'hover-dark');
  });

  it('refuses what the matrix would never write', () => {
    assert.equal(parseSnapshotPath('320w-linux-x64.png'), undefined); // no story directory
    assert.equal(parseSnapshotPath('a--one/readme.md'), undefined); // not a PNG
    assert.equal(parseSnapshotPath('a--one/320w'), undefined); // neither suffix nor platform
    assert.equal(parseSnapshotPath('a--one/320w-linux'), undefined); // platform token halved
    assert.equal(parseSnapshotPath('a--one/notes-320w-linux-x64.png'), undefined); // not a width
  });
});

describe('the accessibility audit slot', () => {
  const config = (over: Partial<DiopsisConfig> = {}): Parameters<typeof resolveMatrix>[1] => ({
    viewports,
    viewportHeight: 900,
    capture: 'page',
    ...over,
  });

  it('marks the first width of each story and mode, and no state capture', () => {
    const matrix = resolveMatrix(
      [
        story('a--one', ['diopsis:hover=button', 'diopsis:focus=button']),
        story('b--two'),
      ],
      config({ modes: { dark: { theme: 'dark' } }, viewports: { default: [320, 480, 1280] } }),
      'linux-x64',
    );
    // One slot per story and mode: the base capture at the smallest width, plus one per
    // mode at its smallest width. Everything else — wider widths, every state capture —
    // carries nothing.
    const slots = matrix.captures.filter((capture) => capture.a11y).map((capture) => capture.snapshotPath);
    assert.deepEqual(slots, [
      'a--one/320w-linux-x64.png',
      'a--one/320w-dark-linux-x64.png',
      'b--two/320w-linux-x64.png',
      'b--two/320w-dark-linux-x64.png',
    ]);
  });

  it('excludes a story tagged diopsis:a11y=off', () => {
    const matrix = resolveMatrix(
      [story('a--quiet', ['diopsis:a11y=off']), story('b--two')],
      config(),
      'linux-x64',
    );
    // The one with the tag carries no slot; the other keeps its own.
    assert.deepEqual(
      matrix.captures.filter((capture) => capture.a11y).map((capture) => capture.storyId),
      ['b--two'],
    );
  });

  it('treats the a11y tag as a directive that names no width', () => {
    const result = widthsForStory(story('a--one', ['diopsis:a11y=off']), viewports);
    assert.deepEqual(result.widths, [320, 1280]);
    assert.deepEqual(result.warnings, []);
  });

  it('warns about an a11y tag naming any other value, and audits anyway', () => {
    const matrix = resolveMatrix([story('a--one', ['diopsis:a11y=quiet'])], config(), 'linux-x64');
    assert.equal(matrix.warnings.length, 1);
    assert.match(matrix.warnings[0] ?? '', /diopsis:a11y=quiet.*ignored/);
    assert.equal(matrix.captures[0]?.a11y, true);
  });
});
