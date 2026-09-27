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
      changed: 0,
      new: 0,
      renderFailed: 0,
      failed: 0,
      notRun: 0,
    },
    changedStories: [],
    captures,
  };
}

async function project(captures: CaptureResult[], artifacts: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-accept-'));
  temporaries.push(dir);
  await mkdir(path.join(dir, '.diopsis'), { recursive: true });
  await writeFile(path.join(dir, '.diopsis', 'summary.json'), JSON.stringify(summaryOf(captures)));
  for (const artifact of artifacts) {
    const file = path.join(dir, '.diopsis', artifact);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'png');
  }
  return dir;
}

async function runAccept(
  root: string,
  storyIds?: string[],
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
    const code = await acceptCommand({ root, ...(storyIds ? { storyIds } : {}), noStage: true });
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
    assert.match(err, /must include \.diopsis\/test-results/);
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
