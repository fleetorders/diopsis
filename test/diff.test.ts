import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { diffCommand } from '../src/commands/diff.ts';
import { gitEnv } from '../src/git.ts';
import { encodePng } from '../src/png-encode.ts';
import { crc32, PNG_SIGNATURE } from '../src/png.ts';
import type { RunSummary } from '../src/report/summary.ts';

const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Git in a test: no signing, no hooks, no inherited GIT_* environment — the same stripped
 * environment the command itself uses, so what fails is the test's subject, never the
 * machine's git configuration.
 */
function git(root: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, env: gitEnv, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `git ${args.join(' ')}\n${run.stderr}`);
  return run.stdout.trim();
}

/** The command's console block; the test runner's own stdout bookkeeping is excluded by matching. */
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
    return { value, out, err };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

function filled(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at] = rgb[0];
    rgba[at + 1] = rgb[1];
    rgba[at + 2] = rgb[2];
    rgba[at + 3] = 255;
  }
  return rgba;
}

/** A grey image with one black block — a change with a place, not just a size. */
function blocked(
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const rgba = filled(width, height, [128, 128, 128]);
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const at = (yy * width + xx) * 4;
      rgba[at] = 0;
      rgba[at + 1] = 0;
      rgba[at + 2] = 0;
    }
  }
  return rgba;
}

/**
 * The same pixels encodePng writes, but with filter type 0 — different bytes, identical
 * image: exactly the case of a baseline re-encoded without anything visually changing.
 */
function pngFilterNone(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const stream = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    stream.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(new Uint8Array(out.subarray(4, 8 + data.length))), 8 + data.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(stream)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

interface DiffRepo {
  root: string;
  shots: string;
  /** The commit main and feature both grew from: what the diff must compare against. */
  mergeBase: string;
}

/**
 * A repository whose branch fates cover every status: one modified baseline, one deleted
 * (a mode capture), one renamed with identical content, one renamed and changed, one
 * re-encoded to identical pixels, and one untracked new arrival.
 */
async function repoWithBranch(): Promise<DiffRepo> {
  const root = await mkdtemp(path.join(tmpdir(), 'diopsis-diff-'));
  temporaries.push(root);
  const shots = path.join(root, '__screenshots__');
  const platform = 'linux-x64';
  const file = (story: string, mode?: string): string =>
    path.join(shots, story, `320w${mode ? `-${mode}` : ''}-${platform}.png`);
  const write = async (story: string, bytes: Uint8Array | Buffer, mode?: string): Promise<void> => {
    await mkdir(path.dirname(file(story, mode)), { recursive: true });
    await writeFile(file(story, mode), bytes);
  };

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'diff-test@diopsis.invalid');
  git(root, 'config', 'user.name', 'Diff test');

  await write('a--one', encodePng(320, 200, filled(320, 200, [128, 128, 128])));
  await write('b--two', encodePng(320, 200, filled(320, 200, [90, 90, 90])), 'dark');
  await write('c--moved', encodePng(320, 200, blocked(320, 200, 10, 10, 20, 12)));
  await write('d--four', encodePng(320, 200, filled(320, 200, [200, 210, 220])));
  await write('e--five', pngFilterNone(320, 200, filled(320, 200, [64, 72, 80])));
  git(root, 'add', '__screenshots__');
  git(root, 'commit', '-m', 'baselines on main');
  const mergeBase = git(root, 'rev-parse', 'HEAD');

  git(root, 'checkout', '-b', 'feature');
  await writeFile(file('a--one'), encodePng(320, 200, blocked(320, 200, 40, 30, 16, 8)));
  git(root, 'rm', '-q', '__screenshots__/b--two/320w-dark-linux-x64.png');
  await mkdir(path.join(shots, 'f--six'), { recursive: true });
  git(root, 'mv', '__screenshots__/c--moved/320w-linux-x64.png', '__screenshots__/f--six/320w-linux-x64.png');
  await mkdir(path.join(shots, 'g--seven'), { recursive: true });
  git(root, 'mv', '__screenshots__/d--four/320w-linux-x64.png', '__screenshots__/g--seven/320w-linux-x64.png');
  await writeFile(file('g--seven'), encodePng(320, 200, blocked(320, 200, 5, 5, 30, 20)));
  git(root, 'add', '__screenshots__');
  git(root, 'commit', '-m', 'the branch');

  // Deliberately uncommitted: a re-encoded baseline and an untracked new arrival, so the
  // diff proves it reads the working tree, not the last commit.
  await writeFile(file('e--five'), encodePng(320, 200, filled(320, 200, [64, 72, 80])));
  await write('h--untracked', encodePng(320, 200, filled(320, 200, [10, 10, 10])));

  return { root, shots, mergeBase };
}

async function summaryAt(root: string): Promise<RunSummary> {
  return JSON.parse(
    await readFile(path.join(root, '.diopsis', 'diff', 'summary.json'), 'utf8'),
  ) as RunSummary;
}

describe('diffCommand', () => {
  it('reviews the baseline changes a branch makes', async () => {
    const { root, mergeBase } = await repoWithBranch();
    const { value: code, out } = await withCapturedStdout(() => diffCommand({ root }));

    assert.equal(code, 0);
    // No remote exists here, so the default base fell back from origin/main to main.
    assert.match(out, /diff against main \([0-9a-f]{7}\)/);
    assert.ok(existsSync(path.join(root, '.diopsis', 'diff', 'report.html')));

    const summary = await summaryAt(root);
    assert.equal(summary.mode, 'diff');
    assert.equal(summary.base, 'main');
    assert.equal(summary.mergeBase, mergeBase);

    const key = (capture: { storyId: string; width: number; mode?: string }): string =>
      `${capture.storyId}@${capture.width}${capture.mode ? `[${capture.mode}]` : ''}`;
    const byKey = new Map(summary.captures.map((capture) => [key(capture), capture]));

    const changed = byKey.get('a--one@320');
    assert.equal(changed?.status, 'changed');
    assert.equal(changed?.diffPixels, 16 * 8);
    assert.equal(changed?.mode, undefined);
    assert.equal(changed?.regions?.length, 1);
    assert.equal(changed?.regions?.[0]?.pixels, 128);
    for (const kind of ['expected', 'actual', 'diff'] as const) {
      const relative = changed?.artifacts[kind];
      assert.ok(relative, kind);
      assert.ok(
        existsSync(path.join(root, '.diopsis', 'diff', relative)),
        `${kind} artifact on disk`,
      );
    }

    const removed = byKey.get('b--two@320[dark]');
    assert.equal(removed?.status, 'removed');
    assert.equal(removed?.mode, 'dark');
    assert.ok(existsSync(path.join(root, '.diopsis', 'diff', removed?.artifacts.expected ?? '')));

    // A rename with identical content is a move — nothing to review on either side.
    assert.equal(byKey.has('c--moved@320'), false);
    assert.equal(byKey.has('f--six@320'), false);

    // A rename that changed content is the old baseline gone and a new one arrived.
    assert.equal(byKey.get('d--four@320')?.status, 'removed');
    assert.equal(byKey.get('g--seven@320')?.status, 'new');

    // Re-encoded bytes over identical pixels are bookkeeping, not a change.
    const unchanged = byKey.get('e--five@320');
    assert.equal(unchanged?.status, 'unchanged');
    assert.deepEqual(unchanged?.artifacts, {});

    // An untracked PNG under the snapshot directory is a baseline about to exist.
    assert.equal(byKey.get('h--untracked@320')?.status, 'new');

    assert.deepEqual(summary.totals, {
      stories: 6,
      captures: 6,
      unchanged: 1,
      unstable: 0,
      changed: 1,
      new: 2,
      removed: 2,
      renderFailed: 0,
      failed: 0,
      notRun: 0,
    });
    assert.deepEqual(summary.changedStories, [
      'a--one',
      'b--two',
      'd--four',
      'g--seven',
      'h--untracked',
    ]);

    // The terminal mirrors the run's: counts, one line per non-unchanged entry, the paths.
    assert.match(out, /1 unchanged · 1 changed · 2 new · 2 removed/);
    assert.match(out, /~ a--one @320 +128 px differ/);
    assert.match(out, /- b--two @320 \[dark\] +removed/);
    assert.match(out, /\+ h--untracked @320 +new/);
    assert.match(out, /report +\.diopsis\/diff\/report\.html/);
    assert.match(out, /summary +\.diopsis\/diff\/summary\.json/);
  });

  it('limits the review to one platform token', async () => {
    const { root } = await repoWithBranch();
    const { value: code, out } = await withCapturedStdout(() =>
      diffCommand({ root, platform: 'darwin-arm64' }),
    );
    assert.equal(code, 0);
    assert.match(out, /platform +darwin-arm64/);
    assert.match(out, /No baseline changes against this base\./);
    assert.equal((await summaryAt(root)).totals.captures, 0);
  });

  it('refuses to diff outside a git repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'diopsis-nogit-'));
    temporaries.push(root);
    const { value: code, err } = await withCapturedStdout(() => diffCommand({ root }));
    assert.equal(code, 1);
    assert.match(err, /Not a git repository/);
  });

  it('names a base git does not know', async () => {
    const { root } = await repoWithBranch();
    const { value: code, err } = await withCapturedStdout(() => diffCommand({ root, base: 'nope' }));
    assert.equal(code, 1);
    assert.match(err, /Unknown base "nope"/);
  });
});

/**
 * A monorepo package: the repository root is two levels up, and the command runs from the
 * package. Git reports paths relative to the repository root and reads revision paths from
 * it too, so both ends of the comparison must be made package-relative here.
 */
async function monorepoPackage(snapshotDir: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'diopsis-monorepo-'));
  temporaries.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'diff-test@diopsis.invalid');
  git(root, 'config', 'user.name', 'Diff test');

  const pkg = path.join(root, 'packages', 'web');
  const file = path.join(pkg, snapshotDir, 'a--one', '320w-linux-x64.png');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encodePng(320, 200, filled(320, 200, [128, 128, 128])));
  await writeFile(
    path.join(pkg, 'diopsis.config.mjs'),
    `export default { snapshotDir: '${snapshotDir}' };`,
  );
  git(root, 'add', 'packages');
  git(root, 'commit', '-m', 'baselines on main');
  // Deliberately uncommitted, so the diff reads the working tree against main.
  await writeFile(file, encodePng(320, 200, blocked(320, 200, 8, 8, 12, 6)));
  return pkg;
}

describe('diffCommand from a subdirectory', () => {
  it('reads and compares baselines relative to the package, not the repository root', async () => {
    const pkg = await monorepoPackage('__screenshots__');
    const { value: code, out } = await withCapturedStdout(() => diffCommand({ root: pkg }));
    assert.equal(code, 0);
    assert.match(out, /~ a--one @320 +72 px differ/);

    const summary = await summaryAt(pkg);
    const changed = summary.captures.find((capture) => capture.storyId === 'a--one');
    assert.equal(changed?.status, 'changed');
    assert.equal(changed?.diffPixels, 12 * 6);
  });

  it("treats a './'-prefixed snapshot directory as the same directory", async () => {
    const pkg = await monorepoPackage('./__screenshots__');
    const { value: code, out } = await withCapturedStdout(() => diffCommand({ root: pkg }));
    assert.equal(code, 0);
    assert.match(out, /~ a--one @320/);
    assert.ok(existsSync(path.join(pkg, '.diopsis', 'diff', 'report.html')));
  });
});
