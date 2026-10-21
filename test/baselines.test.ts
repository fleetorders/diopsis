import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expectedBaselines, orphanedBaselines, type BaselineFile } from '../src/baselines.ts';
import { resolveMatrix } from '../src/matrix.ts';
import type { DiopsisConfig } from '../src/config.ts';
import type { StoryEntry } from '../src/story-index.ts';

const oneWidth: Pick<DiopsisConfig, 'viewports' | 'viewportHeight' | 'capture'> = {
  viewports: { default: [320] },
  viewportHeight: 900,
  capture: 'page',
};

function story(id: string, tags: string[] = []): StoryEntry {
  return { id, name: id, title: 'T', tags };
}

function file(relative: string): BaselineFile {
  return {
    absolute: `/repo/__screenshots__/${relative}`,
    relative,
    bytes: 8,
    ...(relative.includes('linux-x64') ? { platform: 'linux-x64' } : {}),
  };
}

describe('expected baselines with states', () => {
  const matrix = resolveMatrix(
    [story('a--one', ['diopsis:hover=button', 'diopsis:hover=button.icon'])],
    oneWidth,
    'linux-x64',
  );

  it('expects a baseline for every state beside the plain one', () => {
    const expected = expectedBaselines(matrix.captures, ['linux-x64']);
    assert.ok(expected.has('a--one/320w-linux-x64.png'));
    assert.ok(expected.has('a--one/320w-hover-linux-x64.png'));
    assert.ok(expected.has('a--one/320w-hover-2-linux-x64.png'));
  });

  it('treats a state baseline nothing captures any more as an orphan', () => {
    // The story dropped both tags, so only its plain baseline is expected again.
    const without = resolveMatrix([story('a--one')], oneWidth, 'linux-x64');
    const orphans = orphanedBaselines(
      [
        file('a--one/320w-linux-x64.png'),
        file('a--one/320w-hover-linux-x64.png'),
        file('a--one/320w-hover-2-linux-x64.png'),
      ],
      expectedBaselines(without.captures, ['linux-x64']),
    );
    assert.deepEqual(
      orphans.map((entry) => entry.relative),
      ['a--one/320w-hover-linux-x64.png', 'a--one/320w-hover-2-linux-x64.png'],
    );
  });

  it('keeps a state baseline that the matrix still writes', () => {
    const expected = expectedBaselines(matrix.captures, ['linux-x64']);
    const orphans = orphanedBaselines(
      [file('a--one/320w-hover-linux-x64.png')],
      expected,
    );
    assert.deepEqual(orphans, []);
  });
});
