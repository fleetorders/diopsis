import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseStoryIndex, readStoryIndex } from '../src/story-index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('parseStoryIndex', () => {
  it('reads the v5 shape: entries keyed by id, docs excluded', () => {
    const stories = parseStoryIndex({
      v: 5,
      entries: {
        'a--one': { type: 'story', id: 'a--one', name: 'One', title: 'A', tags: ['dev'] },
        'a--docs': { type: 'docs', id: 'a--docs', name: 'Docs', title: 'A', tags: [] },
      },
    });
    assert.deepEqual(
      stories.map((s) => s.id),
      ['a--one'],
    );
  });

  it('tolerates an array of entries', () => {
    const stories = parseStoryIndex({
      v: 4,
      entries: [{ type: 'story', id: 'a--one', name: 'One', title: 'A' }],
    });
    assert.equal(stories.length, 1);
    assert.deepEqual(stories[0]?.tags, []);
  });

  it('tolerates the older "stories" key with no type field', () => {
    const stories = parseStoryIndex({
      v: 3,
      stories: { 'a--one': { id: 'a--one', name: 'One', title: 'A' } },
    });
    assert.deepEqual(
      stories.map((s) => s.id),
      ['a--one'],
    );
  });

  it('keeps unknown extra fields from newer Storybook versions out of the way', () => {
    const stories = parseStoryIndex({
      v: 5,
      entries: {
        'a--one': {
          type: 'story',
          subtype: 'story',
          exportName: 'One',
          id: 'a--one',
          name: 'One',
          title: 'A',
          importPath: './a.stories.tsx',
        },
      },
    });
    assert.equal(stories[0]?.importPath, './a.stories.tsx');
    assert.equal(stories[0]?.componentPath, undefined);
  });

  it('sorts by id so a run order never depends on object insertion order', () => {
    const stories = parseStoryIndex({
      entries: {
        'z--one': { type: 'story', id: 'z--one', name: 'One', title: 'Z' },
        'a--one': { type: 'story', id: 'a--one', name: 'One', title: 'A' },
      },
    });
    assert.deepEqual(
      stories.map((s) => s.id),
      ['a--one', 'z--one'],
    );
  });

  it('rejects an index it cannot recognise', () => {
    assert.throws(() => parseStoryIndex({ v: 5 }), /entries.*stories/);
    assert.throws(() => parseStoryIndex('nope'), /not an object/);
  });
});

describe('readStoryIndex', () => {
  it('reads a built index from disk', async () => {
    const stories = await readStoryIndex(path.join(fixtures, 'storybook-static'));
    assert.deepEqual(
      stories.map((s) => s.id),
      [
        'banner--handheld',
        'banner--unsupported',
        'banner--wide',
        'button--primary',
        'button--secondary',
      ],
    );
  });

  it('explains itself when the directory is not a Storybook build', async () => {
    await assert.rejects(() => readStoryIndex(fixtures), /No story index/);
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach } from 'node:test';

const invalidTemporaries: string[] = [];

afterEach(async () => {
  await Promise.all(
    invalidTemporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('readStoryIndex with a broken index', () => {
  it('names the file when the index is not valid JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-index-'));
    invalidTemporaries.push(dir);
    await writeFile(path.join(dir, 'index.json'), '{ not json');
    await assert.rejects(
      () => readStoryIndex(dir),
      /is not valid JSON \(.*\)\. Rebuild the Storybook\./,
    );
  });
});
