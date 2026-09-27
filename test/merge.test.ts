import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { acceptCommand } from '../src/commands/accept.ts';
import { mergeCommand } from '../src/commands/merge.ts';
import {
  changedStoriesOf,
  totalsFor,
  type CaptureResult,
  type RunSummary,
} from '../src/report/summary.ts';

const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

function shardSummary(
  shard: { index: number; total: number },
  captures: CaptureResult[],
  over: Partial<RunSummary> = {},
): RunSummary {
  return {
    diopsis: 1,
    createdAt: `2026-01-01T00:00:0${shard.index}Z`,
    platform: 'linux',
    arch: 'x64',
    mode: 'run',
    shard,
    snapshotDir: '__screenshots__',
    totals: totalsFor(captures),
    changedStories: changedStoriesOf(captures),
    captures,
    ...over,
  };
}

/** A run directory holding the given shards, each with its summary and artifact files. */
async function project(
  shards: Array<{
    shard: { index: number; total: number };
    captures: CaptureResult[];
    summary?: Partial<RunSummary>;
  }>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'diopsis-merge-'));
  temporaries.push(root);
  for (const { shard, captures, summary } of shards) {
    const dir = path.join(root, '.diopsis', `shard-${shard.index}-of-${shard.total}`);
    await mkdir(path.join(dir, 'test-results'), { recursive: true });
    await writeFile(path.join(dir, 'summary.json'), JSON.stringify(shardSummary(shard, captures, summary)));
    for (const entry of captures) {
      for (const kind of ['expected', 'actual', 'diff'] as const) {
        const relative = entry.artifacts[kind];
        if (relative) await writeFile(path.join(dir, relative), 'png');
      }
    }
  }
  return root;
}

async function runMerge(
  root: string,
  dirs?: string[],
): Promise<{ code: number; out: string; err: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof writeOut;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof writeErr;
  try {
    const code = await mergeCommand({ root, ...(dirs ? { dirs } : {}) });
    return { code, out: stdout.join(''), err: stderr.join('') };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

async function mergedSummary(root: string): Promise<RunSummary> {
  return JSON.parse(
    await readFile(path.join(root, '.diopsis', 'merged', 'summary.json'), 'utf8'),
  ) as RunSummary;
}

describe('mergeCommand', () => {
  it('merges complete shards into one summary with recomputed totals and no shard field', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [
          capture({ status: 'changed', diffPixels: 40, artifacts: { expected: 'test-results/a-expected.png', actual: 'test-results/a-actual.png', diff: 'test-results/a-diff.png' } }),
          capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' }),
        ],
      },
      {
        shard: { index: 2, total: 2 },
        captures: [
          capture({ storyId: 'c--three', storyTitle: 'C', storyName: 'Three', status: 'new', snapshotPath: 'c--three/320w-linux-x64.png', artifacts: { actual: 'test-results/c-actual.png' } }),
        ],
      },
    ]);

    const { code, out } = await runMerge(root);
    assert.equal(code, 1);
    assert.match(out, /2 shards merged · 3 stories → 3 captures · linux-x64/);
    assert.match(out, /1 unchanged · 1 changed · 1 new/);
    assert.match(out, /Accept as the new baseline:  npx diopsis accept --from \.diopsis\/merged/);

    const summary = await mergedSummary(root);
    assert.equal(summary.shard, undefined);
    assert.equal(summary.acceptFrom, '.diopsis/merged');
    // The newest shard is when the run finished; a re-merge of the same shards is identical.
    assert.equal(summary.createdAt, '2026-01-01T00:00:02Z');
    assert.deepEqual(summary.totals, {
      stories: 3,
      captures: 3,
      unchanged: 1,
      unstable: 0,
      changed: 1,
      new: 1,
      removed: 0,
      renderFailed: 0,
      failed: 0,
      notRun: 0,
    });
    assert.deepEqual(summary.changedStories, ['a--one', 'c--three']);
  });

  it('rewrites artifact paths relative to the merged directory, where the files are', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [
          capture({ status: 'changed', diffPixels: 40, artifacts: { expected: 'test-results/a-expected.png', actual: 'test-results/a-actual.png' } }),
        ],
      },
      { shard: { index: 2, total: 2 }, captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })] },
    ]);

    await runMerge(root);
    const summary = await mergedSummary(root);
    const artifacts = summary.captures.find((entry) => entry.status === 'changed')?.artifacts;
    // Recorded with forward slashes on every platform, like every path in a summary.
    assert.equal(artifacts?.actual, '../shard-1-of-2/test-results/a-actual.png');
    assert.equal(artifacts?.expected, '../shard-1-of-2/test-results/a-expected.png');
    assert.equal(artifacts?.diff, undefined);
    // The rewritten path resolves, from the merged directory, onto the shard's real file.
    for (const relative of [artifacts?.actual, artifacts?.expected]) {
      assert.equal(
        existsSync(path.resolve(root, '.diopsis', 'merged', relative!)),
        true,
        relative,
      );
    }
  });

  it('orders captures as a whole run would list them: story, width, then mode', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [
          capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', width: 1280, snapshotPath: 'b--two/1280w-linux-x64.png' }),
          capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', mode: 'dark', snapshotPath: 'b--two/320w-dark-linux-x64.png' }),
          capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' }),
        ],
      },
      {
        shard: { index: 2, total: 2 },
        captures: [
          capture({ storyId: 'a--one', width: 1280, snapshotPath: 'a--one/1280w-linux-x64.png' }),
          capture({}),
        ],
      },
    ]);

    await runMerge(root);
    const summary = await mergedSummary(root);
    assert.deepEqual(
      summary.captures.map((entry) => `${entry.storyId}@${entry.width}${entry.mode ? `[${entry.mode}]` : ''}`),
      ['a--one@320', 'a--one@1280', 'b--two@320', 'b--two@320[dark]', 'b--two@1280'],
    );
  });

  it('exits 0 when every capture in every shard passed', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      { shard: { index: 2, total: 2 }, captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })] },
    ]);
    const { code, out } = await runMerge(root);
    assert.equal(code, 0);
    assert.doesNotMatch(out, /Accept as the new baseline/);
  });

  it('fails on the run’s verdict: an interrupted shard keeps its not-run captures', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [capture({ status: 'failed', error: 'Not run: the run was interrupted.' })],
        summary: { interrupted: true },
      },
      { shard: { index: 2, total: 2 }, captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })] },
    ]);
    const { code, out } = await runMerge(root);
    assert.equal(code, 1);
    assert.match(out, /run interrupted — 1 captures did not run/);
    const summary = await mergedSummary(root);
    assert.equal(summary.interrupted, true);
    assert.equal(summary.totals.notRun, 1);
  });

  it('names the missing index and refuses to merge', async () => {
    const root = await project([
      { shard: { index: 1, total: 3 }, captures: [capture({})] },
      { shard: { index: 3, total: 3 }, captures: [capture({})] },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /Missing shard 2 of 3 — found 1, 3/);
    assert.equal(existsSync(path.join(root, '.diopsis', 'merged')), false);
  });

  it('names both directories when an index appears twice', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      { shard: { index: 2, total: 2 }, captures: [capture({})] },
    ]);
    // The duplicate sits under another parent, as a second download would.
    const stray = path.join(root, 'downloads', 'shard-2-of-2');
    await mkdir(stray, { recursive: true });
    await writeFile(
      path.join(stray, 'summary.json'),
      JSON.stringify(shardSummary({ index: 2, total: 2 }, [capture({})])),
    );

    const { code, err } = await runMerge(root, ['.diopsis', 'downloads']);
    assert.equal(code, 2);
    assert.match(err, /Shard 2 of 2 appears more than once/);
    assert.match(err, /shard-2-of-2/);
  });

  it('refuses shards taken on different platforms', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })],
        summary: { platform: 'darwin', arch: 'arm64' },
      },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /disagree about platform: linux-x64 \(shard-1-of-2\); darwin-arm64 \(shard-2-of-2\)/);
  });

  it('refuses shards that disagree about the total', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      {
        shard: { index: 2, total: 3 },
        captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })],
      },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /disagree about how many shards there are/);
    assert.match(err, /shard-2-of-3 \(shard 2 of 3\)/);
  });

  it('refuses shards whose summaries name a different index than their directory', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })],
        summary: { shard: { index: 1, total: 2 } },
      },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /shard-2-of-2\/summary\.json says shard 1 of 2/);
  });

  it('refuses a capture that appears in two shards, naming both', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      { shard: { index: 2, total: 2 }, captures: [capture({})] },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /a--one @320 is in both .*shard-1-of-2 and .*shard-2-of-2/);
    assert.match(err, /not taken from the same plan/);
  });

  it('refuses shards of different run kinds', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })],
        summary: { mode: 'update' },
      },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /disagree about run mode: run \(shard-1-of-2\); update \(shard-2-of-2\)/);
  });

  it('says so and exits 2 when there is nothing to merge', async () => {
    const root = await project([{ shard: { index: 1, total: 2 }, captures: [capture({})] }]);
    const { code, err } = await runMerge(root, ['nowhere']);
    assert.equal(code, 2);
    assert.match(err, /No shard runs under nowhere/);
  });

  it('lists a change-aware run’s carried captures once, and keeps its affected decision', async () => {
    // Both shards of a --changed run carry the whole not-shot set — it is narrowed by the
    // change, not by the shard — so the merged run lists each carried capture once.
    const carried = [
      { storyId: 'b--two', width: 320 },
      { storyId: 'b--two', width: 320, state: 'hover' },
      { storyId: 'b--two', width: 320, mode: 'dark' },
      { storyId: 'c--three', width: 1280 },
    ];
    const affected = { base: 'main', mergeBase: '0a1b2c3d4e5f6a7b8c9d', changedFiles: 3 };
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [capture({ status: 'changed', diffPixels: 40 })],
        summary: { carried, affected },
      },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'd--four', storyTitle: 'D', storyName: 'Four', snapshotPath: 'd--four/320w-linux-x64.png' })],
        summary: { carried, affected },
      },
    ]);

    const { code } = await runMerge(root);
    assert.equal(code, 1);
    const summary = await mergedSummary(root);
    assert.equal(summary.totals.carried, 4);
    assert.deepEqual(summary.carried, carried);
    assert.deepEqual(summary.affected, affected);
  });

  it('refuses shards that disagree about the affected set they narrowed against', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [capture({})],
        summary: { affected: { base: 'main', mergeBase: 'a1b2c3d4e5f6a7b8c9d', changedFiles: 2 } },
      },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })],
        summary: { affected: { base: 'develop', mergeBase: '00fff0ee000000000000', changedFiles: 1 } },
      },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(
      err,
      /disagree about the affected set: main \(a1b2c3d, 2 files\) \(shard-1-of-2\); develop \(00fff0e, 1 file\) \(shard-2-of-2\)/,
    );
  });

  it('refuses a change-aware shard merged beside a plain one', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [capture({})],
        summary: { affected: { base: 'main', mergeBase: 'a1b2c3d4e5f6a7b8c9d', changedFiles: 2 } },
      },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })],
      },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /the affected set: .* \(shard-1-of-2\); no --changed decision \(shard-2-of-2\)/);
  });

  it('finds shards nested deeper than the output directory, and the shard dir itself', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'diopsis-merge-'));
    temporaries.push(root);
    const nested = path.join(root, 'artifacts', 'deep', 'shard-1-of-2');
    const direct = path.join(root, 'artifacts', 'shard-2-of-2');
    const one = [capture({})];
    const two = [capture({ storyId: 'b--two', storyTitle: 'B', storyName: 'Two', snapshotPath: 'b--two/320w-linux-x64.png' })];
    for (const [dir, shard, captures] of [
      [nested, { index: 1, total: 2 }, one],
      [direct, { index: 2, total: 2 }, two],
    ] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'summary.json'), JSON.stringify(shardSummary(shard, [...captures])));
    }

    const { code } = await runMerge(root, ['artifacts/deep', 'artifacts/shard-2-of-2']);
    assert.equal(code, 0);
    assert.equal((await mergedSummary(root)).captures.length, 2);
  });

  it('refuses a shard summary whose captures are not captures, naming it', async () => {
    const root = await project([
      { shard: { index: 1, total: 2 }, captures: [capture({})] },
      { shard: { index: 2, total: 2 }, captures: [capture({ storyId: 'b--two', snapshotPath: 'b--two/320w-linux-x64.png' })] },
    ]);
    const second = path.join(root, '.diopsis', 'shard-2-of-2', 'summary.json');
    const summary = JSON.parse(await readFile(second, 'utf8')) as RunSummary;
    await writeFile(second, JSON.stringify({ ...summary, captures: [null], affected: {} }));
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /shard-2-of-2\/summary\.json is not a run summary — capture 1/);
  });

  it('refuses an affected set without a merge base instead of crashing', async () => {
    const root = await project([
      { shard: { index: 1, total: 1 }, captures: [capture({})], summary: { affected: {} as RunSummary['affected'] } },
    ]);
    const { code, err } = await runMerge(root);
    assert.equal(code, 2);
    assert.match(err, /names no merge base/);
  });
});

describe('accepting a merged run', () => {
  it('adopts images that live in the shard directories beside the merged one', async () => {
    const root = await project([
      {
        shard: { index: 1, total: 2 },
        captures: [capture({ status: 'changed', artifacts: { actual: 'test-results/a-actual.png' } })],
      },
      {
        shard: { index: 2, total: 2 },
        captures: [capture({ storyId: 'c--three', status: 'new', snapshotPath: 'c--three/320w-linux-x64.png', artifacts: { actual: 'test-results/c-actual.png' } })],
      },
    ]);
    assert.equal((await runMerge(root)).code, 1);

    const writeOut = process.stdout.write;
    const writeErr = process.stderr.write;
    const said: string[] = [];
    process.stdout.write = ((chunk: unknown) => said.push(String(chunk)) > 0) as typeof writeOut;
    process.stderr.write = ((chunk: unknown) => said.push(String(chunk)) > 0) as typeof writeErr;
    let code: number;
    try {
      code = await acceptCommand({ root, from: '.diopsis/merged', noStage: true });
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    }
    assert.equal(code, 0, said.join(''));
    assert.ok(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')));
    assert.ok(existsSync(path.join(root, '__screenshots__', 'c--three', '320w-linux-x64.png')));
  });
});
