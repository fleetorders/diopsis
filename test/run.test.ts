import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainEmptyRun, headerLine } from '../src/commands/run.ts';
import { resolveConfig } from '../src/config.ts';
import { resolveMatrix } from '../src/matrix.ts';
import type { StoryEntry } from '../src/story-index.ts';

const stories = (ids: string[], tags: string[] = []): StoryEntry[] =>
  ids.map((id) => ({ id, name: id, title: id, tags }));

describe('headerLine', () => {
  it('counts the stories actually captured, not the whole index', () => {
    const config = resolveConfig({ viewports: { default: [320, 1280] } });
    // One of three stories is tagged diopsis:skip, so only two are captured, at two
    // widths each — the header must not promise the skipped story's work.
    const matrix = resolveMatrix(
      [...stories(['a--one', 'a--two']), ...stories(['a--gone'], ['diopsis:skip'])],
      config,
    );
    assert.match(headerLine(matrix.captures, undefined), /^Diopsis · 2 stories → 4 captures · /);
  });

  it('names the --grep text next to the counts', () => {
    const config = resolveConfig({ viewports: { default: [320, 1280] } });
    const matrix = resolveMatrix(stories(['card--a', 'card--b', 'modal--a']), config);
    const captures = matrix.captures.filter((capture) => capture.storyId.includes('card'));
    assert.match(
      headerLine(captures, 'card'),
      /^Diopsis · 2 stories → 4 captures \(matched "card"\) · [a-z0-9]+-[a-z0-9]+$/,
    );
  });
});

describe('explainEmptyRun', () => {
  const config = resolveConfig();

  it('says rebuild when the index lists no stories at all', () => {
    assert.deepEqual(
      explainEmptyRun({ stories: [], matrix: resolveMatrix([], config), storybookDir: 'dist' }),
      ['The story index in dist lists no stories. Rebuild the Storybook.'],
    );
  });

  it('names the --grep text and the index size when it matched nothing', () => {
    const all = stories(['a--one', 'a--two', 'b--one']);
    assert.deepEqual(
      explainEmptyRun({
        stories: all,
        matrix: resolveMatrix(all, config),
        storybookDir: 'dist',
        grep: 'zzz',
      }),
      ['No story id contains "zzz" (3 stories in the index).'],
    );
  });

  it('says every story is skipped when the tag excludes them all', () => {
    const all = stories(['a--one', 'a--two', 'a--three'], ['diopsis:skip']);
    assert.deepEqual(
      explainEmptyRun({ stories: all, matrix: resolveMatrix(all, config), storybookDir: 'dist' }),
      ['All 3 stories are tagged diopsis:skip.'],
    );
  });

  it('keeps the unwatched message for stories no width watches', () => {
    const noWidths = resolveConfig({ viewports: { default: [] } });
    const all = stories(['a--one', 'a--two']);
    assert.deepEqual(
      explainEmptyRun({ stories: all, matrix: resolveMatrix(all, noWidths), storybookDir: 'dist' }),
      ['Nothing to capture.', '  unwatched 2 stories (no widths: viewports.default is empty)'],
    );
  });

  it('counts the matching stories when --grep selects only skipped ones', () => {
    const all = [...stories(['card--one'], ['diopsis:skip']), ...stories(['modal--one'])];
    assert.deepEqual(
      explainEmptyRun({
        stories: all,
        matrix: resolveMatrix(all, config),
        storybookDir: 'dist',
        grep: 'card',
      }),
      ['All 1 story is tagged diopsis:skip.'],
    );
  });
});
