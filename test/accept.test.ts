import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { acceptCommand } from '../src/commands/accept.ts';
import type { CaptureResult, RunSummary } from '../src/report/summary.ts';

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
    status: 'changed',
    snapshotPath: 'a--one/320w-linux-x64.png',
    artifacts: { actual: 'test-results/a--one-320-actual.png' },
    ...over,
  };
}

function summaryOf(captures: CaptureResult[]): RunSummary {
  return {
    diopsis: 1,
    createdAt: '2026-01-01T00:00:00Z',
    platform: 'linux',
    arch: 'x64',
    mode: 'run',
    snapshotDir: '__screenshots__',
    totals: {
      stories: 0,
      captures: captures.length,
      unchanged: 0,
      unstable: 0,
      changed: 0,
      new: 0,
      removed: 0,
      renderFailed: 0,
      failed: 0,
      notRun: 0,
    },
    changedStories: [],
    captures,
  };
}

async function project(
  captures: CaptureResult[],
  artifacts: string[],
  runDir = '.diopsis',
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-accept-'));
  temporaries.push(dir);
  await mkdir(path.join(dir, runDir), { recursive: true });
  await writeFile(path.join(dir, runDir, 'summary.json'), JSON.stringify(summaryOf(captures)));
  for (const artifact of artifacts) {
    const file = path.join(dir, runDir, artifact);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'png');
  }
  return dir;
}

async function runAccept(
  root: string,
  storyIds?: string[],
  from?: string,
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
    const code = await acceptCommand({
      root,
      ...(storyIds ? { storyIds } : {}),
      ...(from ? { from } : {}),
      noStage: true,
    });
    return { code, out: stdout.join(''), err: stderr.join('') };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

describe('acceptCommand', () => {
  it('adopts only changed and new captures, and never failed ones', async () => {
    const root = await project(
      [
        capture({}),
        capture({ storyId: 'b--new', status: 'new', snapshotPath: 'b--new/320w-linux-x64.png', artifacts: { actual: 'test-results/b--new-320.png' } }),
        capture({ storyId: 'c--bad', status: 'render-failed', snapshotPath: 'c--bad/320w-linux-x64.png', artifacts: { actual: 'test-results/c--bad-320.png' } }),
        capture({ storyId: 'd--failed', status: 'failed', snapshotPath: 'd--failed/320w-linux-x64.png', artifacts: { actual: 'test-results/d--failed-320.png' } }),
      ],
      [
        'test-results/a--one-320-actual.png',
        'test-results/b--new-320.png',
        'test-results/c--bad-320.png',
        'test-results/d--failed-320.png',
      ],
    );

    const { code, out } = await runAccept(root);
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')), true);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'b--new', '320w-linux-x64.png')), true);
    // A story that failed to render produced nothing worth keeping as a baseline.
    assert.equal(existsSync(path.join(root, '__screenshots__', 'c--bad')), false);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'd--failed')), false);
    assert.match(out, /skipped c--bad @320: render-failed/);
    assert.match(out, /skipped d--failed @320: failed/);
  });

  it('never adopts an unstable capture, which is a pass — even with an image reference', async () => {
    const root = await project(
      [
        capture({
          status: 'unchanged',
          unstable: true,
          unstableStatus: 'changed',
          unstableDiffPixels: 12,
          // A pass has no image of its own; the reference is here so the guard is proven
          // to be the capture's status, not a missing artifact.
          artifacts: { actual: 'test-results/a--one-320-actual.png' },
        }),
      ],
      ['test-results/a--one-320-actual.png'],
    );

    const { code, out } = await runAccept(root);
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(root, '__screenshots__')), false);
    assert.match(out, /every capture already matched its baseline/);
  });

  it('accepts the union of several story ids', async () => {
    const root = await project(
      [
        capture({}),
        capture({ width: 1280, snapshotPath: 'a--one/1280w-linux-x64.png', artifacts: { actual: 'test-results/a--one-1280.png' } }),
        capture({ storyId: 'b--two', snapshotPath: 'b--two/320w-linux-x64.png', artifacts: { actual: 'test-results/b--two-320.png' } }),
      ],
      ['test-results/a--one-320-actual.png', 'test-results/a--one-1280.png', 'test-results/b--two-320.png'],
    );

    const { code } = await runAccept(root, ['a--one', 'b--two']);
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')), true);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'b--two', '320w-linux-x64.png')), true);
  });

  it('keeps story ids out of scope untouched', async () => {
    const root = await project(
      [
        capture({}),
        capture({ storyId: 'b--two', snapshotPath: 'b--two/320w-linux-x64.png', artifacts: { actual: 'test-results/b--two-320.png' } }),
      ],
      ['test-results/a--one-320-actual.png', 'test-results/b--two-320.png'],
    );

    await runAccept(root, ['a--one']);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')), true);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'b--two', '320w-linux-x64.png')), false);
  });

  it('reports an unknown id by name, still accepts the rest, and exits 1', async () => {
    const root = await project(
      [capture({})],
      ['test-results/a--one-320-actual.png'],
    );

    const { code, err } = await runAccept(root, ['a--one', 'nope--id']);
    assert.equal(code, 1);
    assert.match(err, /nope--id/);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')), true);
  });

  it('copies nothing when a run image is missing, and says what the artifact needs', async () => {
    const root = await project(
      [
        capture({}),
        capture({ width: 1280, snapshotPath: 'a--one/1280w-linux-x64.png', artifacts: { actual: 'test-results/a--one-1280-missing.png' } }),
      ],
      ['test-results/a--one-320-actual.png'],
    );

    const { code, err } = await runAccept(root);
    assert.equal(code, 1);
    // The existing source was not copied either: a half-accepted baseline set is worse
    // than a refused one.
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one')), false);
    assert.match(err, /\.diopsis\/test-results\/a--one-1280-missing\.png/);
    assert.match(err, /must include its test-results images/);
  });

  it('exits 0 when the wanted stories simply have nothing to accept', async () => {
    const root = await project(
      [capture({ status: 'unchanged' })],
      [],
    );

    const { code, out } = await runAccept(root, ['a--one']);
    assert.equal(code, 0);
    assert.match(out, /Nothing to accept for a--one\./);
  });
});

describe('acceptCommand with modes', () => {
  it('accepts a mode capture to its own baseline path, not the base one', async () => {
    const root = await project(
      [
        capture({ status: 'unchanged' }),
        capture({
          status: 'changed',
          mode: 'dark',
          snapshotPath: 'a--one/320w-dark-linux-x64.png',
          artifacts: { actual: 'test-results/a--one-320-dark-actual.png' },
        }),
      ],
      ['test-results/a--one-320-dark-actual.png'],
    );

    const { code } = await runAccept(root);
    assert.equal(code, 0);
    // Accept works per capture through the snapshot path, so a mode lands on its own file
    // and the base baseline next to it is untouched.
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-dark-linux-x64.png')), true);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')), false);
  });

  it('names the mode when it says why a capture was skipped', async () => {
    const root = await project(
      [
        capture({
          status: 'render-failed',
          mode: 'rtl',
          snapshotPath: 'a--one/320w-rtl-linux-x64.png',
          artifacts: {},
        }),
      ],
      [],
    );

    const { out } = await runAccept(root);
    assert.match(out, /skipped a--one @320 \[rtl\]: render-failed/);
  });
});

describe('acceptCommand --from', () => {
  it('accepts a run from another directory than the output one', async () => {
    const root = await project(
      [capture({})],
      ['test-results/a--one-320-actual.png'],
      '.ci-run',
    );

    const { code } = await runAccept(root, undefined, '.ci-run');
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(root, '__screenshots__', 'a--one', '320w-linux-x64.png')), true);
  });

  it('says which directory had no summary, when --from points somewhere empty', async () => {
    const root = await project([capture({})], ['test-results/a--one-320-actual.png']);
    const { code, err } = await runAccept(root, undefined, 'nowhere');
    assert.equal(code, 1);
    assert.match(err, /nowhere\/summary\.json is missing/);
    assert.equal(existsSync(path.join(root, '__screenshots__')), false);
  });
});
