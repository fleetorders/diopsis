import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseShard, resolveMatrix, shardCaptures } from '../src/matrix.ts';
import { resolveConfig } from '../src/config.ts';
import type { StoryEntry } from '../src/story-index.ts';

const stories = (ids: string[], tags: string[] = []): StoryEntry[] =>
  ids.map((id) => ({ id, name: id, title: id, tags }));

/** A plan of `perStory` captures per story, ids chosen so their sort order is fixed. */
function planOf(count: number, perStory = 2) {
  const ids = Array.from({ length: count }, (_, at) => `s${String(at + 1).padStart(3, '0')}--x`);
  const config = resolveConfig({ viewports: { default: perStory === 2 ? [320, 1280] : [320] } });
  return resolveMatrix(stories(ids), config).captures;
}

describe('parseShard', () => {
  it('reads <i>/<n> as two integers', () => {
    assert.deepEqual(parseShard('2/4'), { index: 2, total: 4 });
    assert.deepEqual(parseShard('4/4'), { index: 4, total: 4 });
    assert.deepEqual(parseShard('1/1'), { index: 1, total: 1 });
    assert.deepEqual(parseShard('1/1024'), { index: 1, total: 1024 });
    // An allocation the size of a typo is refused, not attempted.
    assert.equal(parseShard('1/2000000000'), undefined);
    assert.deepEqual(parseShard(' 2/4 '), { index: 2, total: 4 });
  });

  it('refuses anything that is not 1 ≤ i ≤ n over integers', () => {
    for (const bad of ['0/4', '5/4', '1/0', '2', 'a/b', '1.5/4', '', '/3', '3/']) {
      assert.equal(parseShard(bad), undefined, bad);
    }
  });
});

describe('shardCaptures', () => {
  it('gives the same split for the same plan, whatever calls it', () => {
    const captures = planOf(12);
    for (let index = 1; index <= 3; index++) {
      assert.deepEqual(
        shardCaptures(captures, index, 3),
        shardCaptures(captures, index, 3),
      );
    }
  });

  it('assigns the same stories whatever order the plan lists them in', () => {
    const captures = planOf(8);
    const reversed = [...captures].reverse();
    for (let index = 1; index <= 3; index++) {
      assert.deepEqual(
        shardCaptures(captures, index, 3).map((capture) => capture.storyId).sort(),
        shardCaptures(reversed, index, 3).map((capture) => capture.storyId).sort(),
      );
    }
  });

  it('keeps every story whole: no story appears in two shards', () => {
    const captures = planOf(12);
    const homes = new Map<string, number>();
    for (let index = 1; index <= 3; index++) {
      for (const capture of shardCaptures(captures, index, 3)) {
        const home = homes.get(capture.storyId);
        if (home !== undefined) assert.equal(home, index, capture.storyId);
        homes.set(capture.storyId, index);
      }
    }
  });

  it('covers every capture exactly once across the shards', () => {
    const captures = planOf(15, 3);
    const keys = (list: typeof captures) =>
      list.map((capture) => `${capture.storyId}@${capture.width}:${capture.mode ?? ''}`).sort();
    const gathered = keys(
      Array.from({ length: 4 }, (_, at) => at + 1).flatMap((index) =>
        shardCaptures(captures, index, 4),
      ),
    );
    assert.deepEqual(gathered, keys(captures));
  });

  it('balances capture counts within one story’s size', () => {
    // Six stories of very different weight — 1, 2, 3, 4, 5 and 6 captures — over three
    // shards. Greedy assignment over id order cannot beat the largest story's spread.
    const ids = ['a--one', 'b--two', 'c--three', 'd--four', 'e--five', 'f--six'];
    const captures: ReturnType<typeof planOf> = [];
    for (const [at, id] of ids.entries()) {
      const config = resolveConfig({
        viewports: { default: Array.from({ length: at + 1 }, (_, w) => 320 + w) },
      });
      captures.push(...resolveMatrix(stories([id]), config).captures);
    }

    const loads = Array.from({ length: 3 }, (_, at) => shardCaptures(captures, at + 1, 3).length);
    const spread = Math.max(...loads) - Math.min(...loads);
    assert.ok(spread <= 6, `spread ${spread} over [${loads}] beats the largest story`);
    assert.equal(loads.reduce((sum, load) => sum + load, 0), captures.length);
  });

  it('keeps the plan’s own order inside the shard', () => {
    const config = resolveConfig({ viewports: { default: [320, 1280] } });
    const matrix = resolveMatrix(
      [...stories(['b--two']), ...stories(['a--one']), ...stories(['c--three'])],
      config,
    );
    const shard = shardCaptures(matrix.captures, 1, 2);
    const mine = new Set(shard.map((capture) => capture.storyId));
    assert.deepEqual(shard, matrix.captures.filter((capture) => mine.has(capture.storyId)));
  });

  it('yields nothing for a shard past the story count, rather than borrowing', () => {
    assert.deepEqual(shardCaptures(planOf(3), 4, 4), []);
  });
});
