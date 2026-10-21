import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { pruneCommand } from '../src/commands/prune.ts';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'storybook-static',
);

const token = `${process.platform}-${process.arch}`;

// A token that is never this machine's own: a hard-coded one collides with it wherever the
// suite happens to run on that platform, and the cross-platform cases stop testing crossing.
const other = token === 'linux-x64' ? 'darwin-arm64' : 'linux-x64';

const temporaries: string[] = [];

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-prune-'));
  temporaries.push(dir);
  await cp(fixture, path.join(dir, 'storybook-static'), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function baseline(root: string, relative: string, content = 'png'): Promise<string> {
  const file = path.join(root, '__screenshots__', relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function capture(
  run: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
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
    const code = await run();
    return { code, out, err };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

describe('pruneCommand dry run', () => {
  it('lists the orphans with their bytes, and frees nothing', async () => {
    const root = await project();
    const orphan = await baseline(root, `gone--story/320w-${token}.png`, 'x'.repeat(2048));
    await baseline(root, `button--primary/320w-${token}.png`, 'kept');

    const { code, out } = await capture(() => pruneCommand({ root }));
    assert.equal(code, 0);
    assert.match(out, /1 orphaned baseline, 2 KB \(dry run\)/);
    assert.match(out, /__screenshots__\/gone--story\/320w-[^ ]+\.png {2,}2 KB/);
    assert.match(out, /Would free 2 KB — re-run with --yes to delete\./);
    assert.doesNotMatch(out, /button--primary/);
    assert.ok(existsSync(orphan));
  });

  it('keeps another platform\'s baseline for a story the matrix still writes', async () => {
    const root = await project();
    await baseline(root, `button--primary/320w-${other}.png`, 'other platform');
    const { out } = await capture(() => pruneCommand({ root }));
    assert.doesNotMatch(out, new RegExp(other));
    assert.ok(existsSync(path.join(root, '__screenshots__', `button--primary/320w-${other}.png`)));
  });

  it('prunes a story the index lost on every platform it was captured for', async () => {
    const root = await project();
    await baseline(root, `gone--story/320w-${token}.png`, 'one');
    await baseline(root, `gone--story/320w-${other}.png`, 'two');
    const { out } = await capture(() => pruneCommand({ root }));
    assert.match(out, /2 orphaned baselines/);
    assert.match(out, new RegExp(`gone--story/320w-${other}\\.png`));
  });

  it('says so plainly when nothing is orphaned', async () => {
    const root = await project();
    await baseline(root, `button--primary/320w-${token}.png`, 'kept');
    const { code, out } = await capture(() => pruneCommand({ root }));
    assert.equal(code, 0);
    assert.match(out, /No orphaned baselines\./);
  });

  it('limits the list to one platform token', async () => {
    const root = await project();
    await baseline(root, `gone--story/320w-${token}.png`, 'one');
    await baseline(root, `gone--story/320w-${other}.png`, 'two');
    const { out } = await capture(() => pruneCommand({ root, platform: other }));
    assert.match(out, new RegExp(`platform  ${other}`));
    assert.match(out, new RegExp(`320w-${other}\\.png`));
    assert.doesNotMatch(out, new RegExp(`gone--story/320w-${token}\\.png`));
  });

  it('says a rename when an orphan\'s bytes match a baseline the last run called new', async () => {
    const root = await project();
    await baseline(root, `old--story/320w-${token}.png`, 'identical-bytes');
    await baseline(root, `button--primary/320w-${token}.png`, 'identical-bytes');
    await mkdir(path.join(root, '.diopsis'), { recursive: true });
    await writeFile(
      path.join(root, '.diopsis', 'summary.json'),
      JSON.stringify({
        diopsis: 1,
        captures: [
          {
            storyId: 'button--primary',
            status: 'new',
            snapshotPath: `button--primary/320w-${token}.png`,
            artifacts: {},
          },
        ],
      }),
    );
    const { out } = await capture(() => pruneCommand({ root }));
    assert.match(out, /looks renamed: old--story → button--primary/);
  });

  it('hints at nothing when there is no last run to read', async () => {
    const root = await project();
    await baseline(root, `old--story/320w-${token}.png`, 'orphan');
    const { out } = await capture(() => pruneCommand({ root }));
    assert.doesNotMatch(out, /looks renamed/);
  });
});

describe('pruneCommand --yes', () => {
  it('deletes only the orphans and removes the directories left empty', async () => {
    const root = await project();
    await baseline(root, `gone--story/320w-${token}.png`, 'one');
    await baseline(root, `gone--story/1280w-${token}.png`, 'two');
    const kept = await baseline(root, `button--primary/320w-${token}.png`, 'kept');

    const { code, out } = await capture(() => pruneCommand({ root, yes: true }));
    assert.equal(code, 0);
    assert.match(out, /Deleted 2 baselines, freed /);
    assert.match(out, /Not a git repository — the deletions are not staged\./);
    assert.ok(!existsSync(path.join(root, '__screenshots__', 'gone--story')));
    assert.ok(existsSync(kept));
    assert.ok(existsSync(path.join(root, '__screenshots__')), 'the snapshot directory stays');
  });

  it('stages the deletions in a repository, and only the deletions', async () => {
    const root = await project();
    await baseline(root, `gone--story/320w-${token}.png`, 'one');
    await baseline(root, `button--primary/320w-${token}.png`, 'kept');
    for (const args of [
      ['init'],
      ['config', 'user.email', 'diopsis@example.com'],
      ['config', 'user.name', 'Diopsis Tests'],
    ] as const) {
      spawnSync('git', [...args], { cwd: root, stdio: 'ignore' });
    }
    spawnSync('git', ['add', '--', '__screenshots__'], { cwd: root, stdio: 'ignore' });
    spawnSync('git', ['commit', '--quiet', '-m', 'baselines'], { cwd: root, stdio: 'ignore' });

    const { code, out } = await capture(() => pruneCommand({ root, yes: true }));
    assert.equal(code, 0);
    assert.match(out, /Staged the deletions — review, then commit\./);

    const status = spawnSync('git', ['status', '--porcelain', '--', '__screenshots__'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.match(status.stdout, /^D  __screenshots__\/gone--story\/320w-/m);
    assert.doesNotMatch(status.stdout, /button--primary/);
  });
});

describe('pruneCommand refusing what it must not touch', () => {
  it('refuses a symlink that resolves outside the snapshot directory', async () => {
    const root = await project();
    const kept = await baseline(root, `button--primary/320w-${token}.png`, 'kept');
    const outside = path.join(root, 'elsewhere.png');
    await writeFile(outside, 'not a baseline');
    const link = path.join(root, '__screenshots__', `esc--story/320w-${token}.png`);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(outside, link);

    const { code, out, err } = await capture(() => pruneCommand({ root }));
    assert.equal(code, 1);
    assert.match(err, /Refusing to prune — a symlink under __screenshots__ resolves outside it/);
    assert.match(err, /esc--story\/320w-/);
    assert.ok(existsSync(link), 'the symlink itself is left alone');
    assert.ok(existsSync(outside));
    assert.ok(existsSync(kept), 'a refused prune deletes nothing at all');
  });
});
