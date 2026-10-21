import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { mergeCommand } from '../src/commands/merge.ts';
import { changedFilesSince, changedLine, runCommand, splitByAffected } from '../src/commands/run.ts';
import { shardCaptures, type Capture } from '../src/matrix.ts';
import { gitEnv } from '../src/git.ts';
import type { RunSummary } from '../src/report/summary.ts';

const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Git in a test: no signing, no hooks, no inherited GIT_* environment. */
function git(root: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, env: gitEnv, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `git ${args.join(' ')}\n${run.stderr}`);
  return run.stdout.trim();
}

async function withCapturedStdout<T>(
  run: () => Promise<T>,
): Promise<{ value: T; out: string; err: string }> {
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof writeOut;
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof writeErr;
  try {
    const value = await run();
    return { value: value, out, err };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

/**
 * A repository with a built Storybook: an index listing two stories in two files, and a
 * stats file whose graph contains every story file (the sanity check demands it) plus one
 * module no story imports — a change there must leave the whole matrix carried.
 */
async function repoWithBuild(subdir = ''): Promise<{ root: string; mergeBase: string }> {
  const top = await mkdtemp(path.join(tmpdir(), 'diopsis-changed-'));
  temporaries.push(top);
  // The project may sit in a directory of a larger repository; git runs from the top.
  const root = path.join(top, subdir);
  const build = path.join(root, 'storybook-static');
  await mkdir(build, { recursive: true });

  await writeFile(
    path.join(build, 'index.json'),
    JSON.stringify({
      entries: {
        'example-button--primary': {
          type: 'story',
          id: 'example-button--primary',
          name: 'Primary',
          title: 'Example/Button',
          importPath: './src/Button.stories.tsx',
          tags: ['story'],
        },
        'example-input--filled': {
          type: 'story',
          id: 'example-input--filled',
          name: 'Filled',
          title: 'Example/Input',
          importPath: './src/Input.stories.tsx',
          tags: ['story'],
        },
      },
    }),
  );

  await writeFile(
    path.join(build, 'preview-stats.json'),
    JSON.stringify({
      modules: [
        {
          name: './src/Button.stories.tsx',
          reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/vite-app.js' }],
        },
        {
          name: './src/Input.stories.tsx',
          reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/vite-app.js' }],
        },
        { name: './src/lib/theme.ts', reasons: [] },
      ],
    }),
  );

  for (const file of ['src/Button.stories.tsx', 'src/Input.stories.tsx', 'src/lib/theme.ts']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'export {};\n');
  }

  git(top, 'init', '-b', 'main');
  git(top, 'config', 'user.email', 'changed-test@diopsis.invalid');
  git(top, 'config', 'user.name', 'Changed test');
  git(top, 'add', '.');
  git(top, 'commit', '-m', 'build and sources');
  const mergeBase = git(top, 'rev-parse', 'HEAD');

  // Deliberately uncommitted: the module no story imports.
  await writeFile(path.join(root, 'src/lib/theme.ts'), 'export const theme = "dark";\n');
  return { root, mergeBase };
}

describe('runCommand --changed', () => {
  it('exits 0 with a carried summary when nothing is affected', async () => {
    const { root, mergeBase } = await repoWithBuild();
    const { value: code, out } = await withCapturedStdout(() => runCommand({ root, changed: true }));

    assert.equal(code, 0);
    assert.match(out, /Diopsis · 0 stories → 0 captures · /);
    assert.match(out, /  changed   nothing affected since main\n/);
    assert.match(out, /report +\.diopsis\/report\.html/);

    const summary = JSON.parse(
      await readFile(path.join(root, '.diopsis', 'summary.json'), 'utf8'),
    ) as RunSummary;
    assert.equal(summary.mode, 'run');
    assert.equal(summary.diopsis, 1);
    assert.deepEqual(summary.captures, []);
    assert.deepEqual(summary.changedStories, []);
    // Two stories at the two default widths each: all four captures planned, none shot.
    assert.equal(summary.totals.captures, 0);
    assert.equal(summary.totals.carried, 4);
    assert.deepEqual(
      summary.carried?.map((capture) => `${capture.storyId}@${capture.width}`),
      [
        'example-button--primary@320',
        'example-button--primary@1280',
        'example-input--filled@320',
        'example-input--filled@1280',
      ],
    );
    assert.equal(summary.affected?.base, 'main');
    assert.equal(summary.affected?.mergeBase, mergeBase);
    assert.equal(summary.affected?.changedFiles, 1);
    assert.equal(summary.affected?.full, undefined);
    assert.ok(existsSync(path.join(root, '.diopsis', 'report.html')));
  });
});

describe('runCommand --changed with --shard', () => {
  it('lists the same carried set in every shard, and the merge lists it once', async () => {
    const { root, mergeBase } = await repoWithBuild();
    // Nothing the branch changed reaches a story, so each shard bypasses the browser and
    // writes its own summary — carried in full, because --changed narrows the plan, not
    // the carried set — with both the shard and the changed line in its header.
    for (const index of [1, 2]) {
      const { value: code, out } = await withCapturedStdout(() =>
        runCommand({ root, changed: true, shard: { index, total: 2 } }),
      );
      assert.equal(code, 0, `shard ${index}`);
      assert.match(out, /Diopsis · 0 stories → 0 captures · /);
      assert.match(out, new RegExp(`  shard     ${index} of 2 · 0 stories, 0 captures\n`));
      assert.match(out, /  changed   nothing affected since main\n/);
      assert.match(out, new RegExp(`report +\\.diopsis/shard-${index}-of-2/report\\.html`));

      const shard = JSON.parse(
        await readFile(path.join(root, '.diopsis', `shard-${index}-of-2`, 'summary.json'), 'utf8'),
      ) as RunSummary;
      assert.deepEqual(shard.shard, { index, total: 2 });
      assert.equal(shard.totals.carried, 4);
      assert.deepEqual(
        shard.carried?.map((entry) => `${entry.storyId}@${entry.width}`),
        [
          'example-button--primary@320',
          'example-button--primary@1280',
          'example-input--filled@320',
          'example-input--filled@1280',
        ],
      );
      assert.equal(shard.affected?.mergeBase, mergeBase);
    }
    // A shard run leaves the plain output directory alone; the merge is what unites them.
    assert.equal(existsSync(path.join(root, '.diopsis', 'summary.json')), false);

    const { value: code } = await withCapturedStdout(() => mergeCommand({ root }));
    assert.equal(code, 0);
    const merged = JSON.parse(
      await readFile(path.join(root, '.diopsis', 'merged', 'summary.json'), 'utf8'),
    ) as RunSummary;
    assert.equal(merged.shard, undefined);
    assert.deepEqual(merged.captures, []);
    // Both shards listed the same four carried captures; the merged run lists them once.
    assert.equal(merged.totals.carried, 4);
    assert.equal(merged.carried?.length, 4);
    assert.equal(merged.affected?.mergeBase, mergeBase);
    assert.equal(merged.affected?.base, 'main');
  });
});

describe('changedFilesSince', () => {
  it('collects committed, staged, working-tree and untracked files as one set', async () => {
    const { root, mergeBase } = await repoWithBuild();
    git(root, 'checkout', '-b', 'feature');

    await writeFile(path.join(root, 'src/Button.stories.tsx'), 'export const touched = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'committed on the branch');
    await writeFile(path.join(root, 'src/Input.stories.tsx'), 'export const edited = true;\n');
    await writeFile(path.join(root, 'src/New.stories.tsx'), 'export {};\n');

    const set = changedFilesSince(root);
    assert.equal(set.base, 'main');
    assert.equal(set.mergeBase, mergeBase);
    assert.deepEqual(set.files, [
      'src/Button.stories.tsx',
      'src/Input.stories.tsx',
      'src/New.stories.tsx',
      'src/lib/theme.ts',
    ]);
  });

  it('names an unknown base the way diff does', async () => {
    const { root } = await repoWithBuild();
    assert.throws(() => changedFilesSince(root, 'nope'), /Unknown base "nope"/);
  });
});

describe('splitByAffected', () => {
  const capture = (storyId: string, width: number, mode?: string): Capture => ({
    storyId,
    storyName: storyId,
    storyTitle: storyId,
    width,
    height: 900,
    scope: 'page',
    ...(mode ? { mode } : {}),
    snapshotPath: `${storyId}/${width}w${mode ? `-${mode}` : ''}-linux-x64.png`,
  });

  it('keeps the width and mode of carried captures', () => {
    const captures = [
      capture('a--one', 320),
      capture('a--one', 320, 'dark'),
      capture('b--two', 1280),
    ];
    const out = splitByAffected(captures, ['b--two']);
    assert.deepEqual(
      out.captures.map((shot) => shot.storyId),
      ['b--two'],
    );
    assert.deepEqual(out.carried, [
      { storyId: 'a--one', width: 320 },
      { storyId: 'a--one', width: 320, mode: 'dark' },
    ]);
  });
});

describe('a --changed plan under --shard', () => {
  const capture = (storyId: string, width: number): Capture => ({
    storyId,
    storyName: storyId,
    storyTitle: storyId,
    width,
    height: 900,
    scope: 'page',
    snapshotPath: `${storyId}/${width}w-linux-x64.png`,
  });

  it('narrows the plan first, then splits what is left to capture', () => {
    const captures = [
      capture('a--one', 320),
      capture('a--one', 1280),
      capture('b--two', 320),
      capture('b--two', 1280),
      capture('c--three', 320),
    ];
    // The change reaches two stories; --shard divides those two stories' captures between
    // jobs, and b--two is carried whole — it appears in no shard.
    const narrowed = splitByAffected(captures, ['a--one', 'c--three']);
    const shards = [1, 2].map((index) => shardCaptures(narrowed.captures, index, 2));
    const key = (shot: Capture) => `${shot.storyId}@${shot.width}`;
    assert.deepEqual(
      shards.flat().map(key).sort(),
      narrowed.captures.map(key).sort(),
    );
    for (const shard of shards) {
      assert.equal(shard.some((shot) => shot.storyId === 'b--two'), false);
    }
    assert.deepEqual(narrowed.carried, [
      { storyId: 'b--two', width: 320 },
      { storyId: 'b--two', width: 1280 },
    ]);
  });
});

describe('changedLine', () => {
  it('states the reason a full run ran', () => {
    assert.equal(
      changedLine({ kind: 'full', reason: 'package.json is a package manifest or lockfile' }),
      'full run — package.json is a package manifest or lockfile',
    );
  });

  it('counts affected stories against the matrix', () => {
    assert.equal(
      changedLine({ kind: 'set', affected: 3, of: 10, base: 'origin/main', shortSha: 'abc1234' }),
      '3 of 10 stories affected since origin/main (abc1234)',
    );
  });

  it('states a bypass plainly', () => {
    assert.equal(changedLine({ kind: 'nothing', base: 'main' }), 'nothing affected since main');
  });
});

describe('runCommand --changed and baselines', () => {
  it('does not let changed or new baselines force a full run', async () => {
    const { root } = await repoWithBuild();
    // A branch that accepted a change carries new and modified baselines, and the run leaves
    // its output behind; neither can change how a story renders.
    await mkdir(path.join(root, '__screenshots__', 'example-button--primary'), { recursive: true });
    await writeFile(
      path.join(root, '__screenshots__', 'example-button--primary', '320w-linux-x64.png'),
      'not really a png',
    );
    await mkdir(path.join(root, '.diopsis'), { recursive: true });
    await writeFile(path.join(root, '.diopsis', 'summary.json'), '{}');
    const { value: code, out } = await withCapturedStdout(() => runCommand({ root, changed: true }));

    assert.equal(code, 0);
    assert.match(out, /  changed   nothing affected since main\n/);
    assert.doesNotMatch(out, /full run/);
  });
});

describe('runCommand --changed in a directory of a larger repository', () => {
  it('matches git’s top-level paths to the project’s graph, output ignored', async () => {
    const { root } = await repoWithBuild('packages/app');
    // Run output inside the project is untracked; it must be ignored under its real path.
    await mkdir(path.join(root, '.diopsis'), { recursive: true });
    await writeFile(path.join(root, '.diopsis', 'summary.json'), '{}');
    const { value: code, out } = await withCapturedStdout(() => runCommand({ root, changed: true }));

    assert.equal(code, 0);
    assert.match(out, /  changed   nothing affected since main\n/);
    assert.doesNotMatch(out, /full run/);
  });

  it('still sees an untracked file outside the project', async () => {
    const { root } = await repoWithBuild('packages/app');
    await writeFile(path.join(root, '..', 'shared.ts'), 'export {};\n');
    assert.deepEqual(changedFilesSince(root).files, [
      'packages/app/src/lib/theme.ts',
      'packages/shared.ts',
    ]);
  });
});
