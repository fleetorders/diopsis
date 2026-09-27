import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainEmptyRun, headerBlock, headerLine } from '../src/commands/run.ts';
import { resolveConfig } from '../src/config.ts';
import { loosenedStoryIds, resolveMatrix, shardCaptures } from '../src/matrix.ts';
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

describe('headerBlock', () => {
  const config = resolveConfig({ viewports: { default: [320] } });

  function blockFor(all: StoryEntry[], capture: 'page' | 'component' = config.capture): string {
    const matrix = resolveMatrix(all, { ...config, capture });
    return headerBlock({
      captures: matrix.captures,
      capture,
      configSource: 'diopsis.config.mjs',
      storybookDir: 'storybook-static',
      snapshotDir: '__screenshots__',
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: loosenedStoryIds(matrix.captures, config.compare),
    });
  }

  it('counts the stories whose tags loosened tolerance beyond the config', () => {
    const out = blockFor([...stories(['a--loose'], ['diopsis:threshold=0.6']), ...stories(['b--plain'])]);
    assert.match(out, /Diopsis · 2 stories → 2 captures · /);
    assert.match(out, /  loosened  1 story \(diopsis:threshold \/ max-diff-\* tags\)\n/);
  });

  it('prints no loosened line while nothing compares more loosely than the config', () => {
    const out = blockFor([...stories(['a--strict'], ['diopsis:threshold=0.1']), ...stories(['b--plain'])]);
    assert.doesNotMatch(out, /loosened/);
  });

  it('prints no scope line while everything is captured as the whole page', () => {
    const out = blockFor([...stories(['a--one']), ...stories(['b--pin'], ['diopsis:page'])]);
    assert.doesNotMatch(out, /scope/);
  });

  it('counts the stories that pull a component run back to the page', () => {
    const out = blockFor(
      [...stories(['a--pin'], ['diopsis:page']), ...stories(['b--pin'], ['diopsis:page']), ...stories(['c--comp'])],
      'component',
    );
    assert.match(out, /  scope     component \(2 stories page\)\n/);
  });

  it('counts component-tagged stories in a page-configured run', () => {
    const out = blockFor([...stories(['a--chip'], ['diopsis:component']), ...stories(['b--plain'])]);
    assert.match(out, /  scope     page \(1 story component\)\n/);
  });

  it('states the component scope even when no story overrides it', () => {
    const out = blockFor([...stories(['a--one'])], 'component');
    assert.match(out, /  scope     component\n/);
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

describe('headerBlock shard line', () => {
  const config = resolveConfig({ viewports: { default: [320, 1280] } });

  function blockFor(all: StoryEntry[], shard?: { index: number; total: number }): string {
    const matrix = resolveMatrix(all, config);
    const captures = shard
      ? shardCaptures(matrix.captures, shard.index, shard.total)
      : matrix.captures;
    return headerBlock({
      captures,
      ...(shard ? { shard } : {}),
      capture: config.capture,
      configSource: 'diopsis.config.mjs',
      storybookDir: 'storybook-static',
      snapshotDir: '__screenshots__',
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: [],
    });
  }

  it('says which shard of how many, with the shard’s own counts', () => {
    // Three stories over three shards give each one story of two captures; the header
    // counts what this job will capture, not the plan it was split from.
    const out = blockFor(stories(['a--one', 'b--two', 'c--three']), { index: 2, total: 3 });
    assert.match(out, /^Diopsis · 1 stories → 2 captures · /);
    assert.match(out, /  shard     2 of 3 · 1 story, 2 captures\n/);
  });

  it('counts a many-story shard in the plural', () => {
    const out = blockFor(stories(['a--one', 'b--two', 'c--three', 'd--four']), { index: 2, total: 2 });
    assert.match(out, /  shard     2 of 2 · 2 stories, 4 captures\n/);
  });

  it('prints no shard line for a whole-plan run', () => {
    assert.doesNotMatch(blockFor(stories(['a--one'])), /shard/);
  });
});

describe('headerBlock modes', () => {
  const modes = { dark: { theme: 'dark' }, rtl: { direction: 'rtl' } };
  const config = resolveConfig({ viewports: { default: [320] }, modes });

  it('lists the configured modes where the cost of the matrix is read', () => {
    const matrix = resolveMatrix(stories(['a--one']), config);
    const out = headerBlock({
      captures: matrix.captures,
      capture: config.capture,
      configSource: 'diopsis.config.mjs',
      storybookDir: 'storybook-static',
      snapshotDir: '__screenshots__',
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: [],
      modes: Object.keys(modes),
    });
    assert.match(out, /Diopsis · 1 stories → 3 captures · /);
    assert.match(out, /  modes     dark, rtl\n/);
  });

  it('prints no modes line when none are configured', () => {
    const plain = resolveConfig({ viewports: { default: [320] } });
    const matrix = resolveMatrix(stories(['a--one']), plain);
    const out = headerBlock({
      captures: matrix.captures,
      capture: plain.capture,
      configSource: 'diopsis.config.mjs',
      storybookDir: 'storybook-static',
      snapshotDir: '__screenshots__',
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: [],
    });
    assert.doesNotMatch(out, /modes/);
  });
});

describe('headerBlock budget line', () => {
  const plain = resolveConfig({ viewports: { default: [320] } });
  const matrix = resolveMatrix(stories(['a--one']), plain);
  const MB = 1024 * 1024;

  function blockWith(budget?: {
    weight?: { used: number; cap: number };
    captures?: { used: number; cap: number };
  }): string {
    return headerBlock({
      captures: matrix.captures,
      capture: plain.capture,
      configSource: 'diopsis.config.mjs',
      storybookDir: 'storybook-static',
      snapshotDir: '__screenshots__',
      skipped: matrix.skipped,
      unwatched: matrix.unwatched,
      loosened: [],
      ...(budget ? { budget } : {}),
    });
  }

  it('says over, naming both numbers, when the weight budget is exceeded', () => {
    const out = blockWith({ weight: { used: 31.2 * MB, cap: 25 * MB } });
    assert.match(out, /  budget    31\.2 MB of 25 MB — over\n/);
  });

  it('says near when the set sits within 10% of the weight budget', () => {
    const out = blockWith({ weight: { used: 23.5 * MB, cap: 25 * MB } });
    assert.match(out, /  budget    23\.5 MB of 25 MB — near\n/);
  });

  it('stays quiet with no budget, and while one is comfortably met', () => {
    assert.doesNotMatch(blockWith(), /budget/);
    assert.doesNotMatch(blockWith({ weight: { used: 10 * MB, cap: 25 * MB } }), /budget/);
  });

  it('reports a capture budget beside the weight one', () => {
    const out = blockWith({
      weight: { used: 30 * MB, cap: 25 * MB },
      captures: { used: 8, cap: 7 },
    });
    assert.match(out, /  budget    30 MB of 25 MB — over\n/);
    assert.match(out, /  budget    8 of 7 captures — over\n/);
  });
});
