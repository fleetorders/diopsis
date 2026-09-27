import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { findForeignIgnoreAttributes, runChecks, type Check } from '../src/commands/doctor.ts';
import { ciRecipe, gitattributesLines, initCommand } from '../src/commands/init.ts';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'storybook-static',
);

const temporaries: string[] = [];

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-doctor-'));
  temporaries.push(dir);
  await cp(fixture, path.join(dir, 'storybook-static'), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function find(checks: Check[], pattern: RegExp): Check | undefined {
  return checks.find((check) => pattern.test(check.title));
}

describe('findForeignIgnoreAttributes', () => {
  it('spots another tool’s ignore attribute left over from a migration', () => {
    assert.deepEqual(
      findForeignIgnoreAttributes('<div data-something-ignore>x</div>'),
      ['data-something-ignore'],
    );
  });

  it('does not report our own attribute', () => {
    assert.deepEqual(findForeignIgnoreAttributes('<div data-diopsis-ignore>x</div>'), []);
  });

  it('reports each distinct attribute once, sorted', () => {
    const found = findForeignIgnoreAttributes(
      'data-zeta-ignore data-alpha-ignore data-alpha-ignore data-diopsis-ignore',
    );
    assert.deepEqual(found, ['data-alpha-ignore', 'data-zeta-ignore']);
  });
});

describe('gitattributesLines', () => {
  it('marks baselines binary and unmergeable by default', () => {
    const [line] = gitattributesLines('__screenshots__', false);
    assert.match(line ?? '', /binary -merge -diff/);
  });

  it('switches to LFS tracking when asked', () => {
    const [line] = gitattributesLines('__screenshots__', true);
    assert.match(line ?? '', /filter=lfs/);
  });
});

describe('ciRecipe', () => {
  it('names the pinned image, so CI and baseline generation cannot drift', () => {
    assert.match(ciRecipe('some/image:tag', '__screenshots__'), /image: some\/image:tag/);
  });
});

describe('runChecks', () => {
  it('counts captures from a real index and reports the pinned image', async () => {
    const root = await project();
    const checks = await runChecks({ root });
    // 5 stories: two at both widths, one pinned to 1280, one whose unknown tag falls back to
    // both widths, and one skipped outright. 2 + 2 + 1 + 2 + 0 = 7.
    assert.match(find(checks, /stories/)?.title ?? '', /5 stories → 7 captures/);
    assert.equal(find(checks, /image is pinned/)?.level, 'ok');
  });

  it('warns when there are no baselines yet', async () => {
    const checks = await runChecks({ root: await project() });
    assert.equal(find(checks, /No baselines/)?.level, 'warn');
  });

  it('fails when a baseline carries no platform suffix', async () => {
    const root = await project();
    await mkdir(path.join(root, '__screenshots__', 'button--primary'), { recursive: true });
    await writeFile(path.join(root, '__screenshots__', 'button--primary', '320w.png'), 'x');
    const check = find(await runChecks({ root }), /no platform suffix/);
    assert.equal(check?.level, 'fail');
  });

  it('flags a baseline for a story that no longer exists', async () => {
    const root = await project();
    await mkdir(path.join(root, '__screenshots__', 'gone--story'), { recursive: true });
    await writeFile(
      path.join(root, '__screenshots__', 'gone--story', `320w-${process.platform}-${process.arch}.png`),
      'x',
    );
    const check = find(await runChecks({ root }), /no longer exist/);
    assert.equal(check?.level, 'warn');
  });

  it('fails outright when .gitignore excludes the baselines', async () => {
    const root = await project();
    await writeFile(path.join(root, '.gitignore'), '__screenshots__/\n');
    const check = find(await runChecks({ root }), /excludes __screenshots__/);
    assert.equal(check?.level, 'fail');
  });

  it('warns when the baselines are not protected from auto-merge', async () => {
    const checks = await runChecks({ root: await project() });
    assert.equal(find(checks, /not marked unmergeable/)?.level, 'warn');
  });

  it('reports an unrecognised diopsis tag rather than silently capturing nothing', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'storybook-static', 'index.json'),
      JSON.stringify({
        v: 5,
        entries: {
          'a--one': { type: 'story', id: 'a--one', name: 'One', title: 'A', tags: ['diopsis:huge'] },
        },
      }),
    );
    const check = find(await runChecks({ root }), /Unrecognised story tag/);
    assert.equal(check?.level, 'warn');
  });
});

describe('initCommand', () => {
  it('writes a config, git settings, and refuses to clobber an existing one', async () => {
    const root = await project();
    assert.equal(await initCommand({ root }), 0);

    const second = await initCommand({ root });
    assert.equal(second, 1, 'expected init to refuse without --force');

    assert.equal(await initCommand({ root, force: true }), 0);
  });

  it('leaves a setup that doctor is happy with', async () => {
    const root = await project();
    await initCommand({ root });
    const checks = await runChecks({ root });
    assert.equal(find(checks, /not marked unmergeable/), undefined);
    assert.equal(find(checks, /is not ignored/), undefined);
    assert.equal(
      checks.filter((check) => check.level === 'fail').length,
      0,
      JSON.stringify(checks.filter((check) => check.level === 'fail')),
    );
  });
});

describe('runChecks with an empty default set', () => {
  it('warns, with the count, when stories are captured at no width', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      'export default { viewports: { default: [], mobile: [320] } };',
    );
    const check = find(await runChecks({ root }), /captured at no width/);
    assert.equal(check?.level, 'warn');
    // The two untagged Button stories; the tagged Banner stories still capture.
    assert.match(check?.title ?? '', /2 stories/);
  });
});
