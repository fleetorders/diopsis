import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import {
  doctorCommand,
  findCiImageReferences,
  findForeignIgnoreAttributes,
  runChecks,
  type Check,
} from '../src/commands/doctor.ts';
import { ciRecipe, gitattributesLines, initCommand } from '../src/commands/init.ts';
import { CONFIG_FILENAMES, loadConfig } from '../src/config.ts';

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

/**
 * An executable that answers like an installed oxipng, so the check runs the same on a
 * machine without the tool and on one that has it.
 */
async function fakeOxipng(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-oxipng-'));
  temporaries.push(dir);
  const script = path.join(dir, 'oxipng');
  await writeFile(script, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(script, 0o755);
  return script;
}

/** Commands print their report on stdout; capture it so it can be asserted on. */
async function captureStdout(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof write;
  try {
    const code = await run();
    return { code, out };
  } finally {
    process.stdout.write = write;
  }
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
    // Outside a repository there is no rule for git to name; the failure stands without one.
    assert.doesNotMatch(check?.detail ?? '', /line \d/);
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

  it('warns when compression is auto and oxipng is not installed', async () => {
    const root = await project();
    await writeFile(path.join(root, 'diopsis.config.mjs'), 'export default { compress: "auto" };');
    // A name that resolves nowhere stands in for a PATH without the tool.
    process.env.DIOPSIS_OXIPNG = 'oxipng-absent-for-this-test';
    try {
      const check = find(await runChecks({ root }), /oxipng is not installed/);
      assert.equal(check?.level, 'warn');
      assert.match(check?.detail ?? '', /written uncompressed/);
    } finally {
      delete process.env.DIOPSIS_OXIPNG;
    }
  });

  it('stays quiet about compression when the tool answers, and when it is off', { skip: process.platform === 'win32' && 'the stand-in tool is a POSIX shell script' }, async () => {
    const root = await project();
    await writeFile(path.join(root, 'diopsis.config.mjs'), 'export default { compress: "auto" };');
    process.env.DIOPSIS_OXIPNG = await fakeOxipng();
    try {
      const checks = await runChecks({ root });
      assert.equal(find(checks, /oxipng/), undefined);
    } finally {
      delete process.env.DIOPSIS_OXIPNG;
    }
  });
});

describe('runChecks on loosened tolerance', () => {
  function indexWith(ids: string[]): string {
    return JSON.stringify({
      v: 5,
      entries: Object.fromEntries(
        ids.map((id) => [
          id,
          { type: 'story', id, name: id, title: 'T', tags: ['diopsis:threshold=0.6'] },
        ]),
      ),
    });
  }

  it('warns, naming the story, when a tag compares more loosely than the config', async () => {
    const root = await project();
    await writeFile(path.join(root, 'storybook-static', 'index.json'), indexWith(['a--one']));
    const check = find(await runChecks({ root }), /more loosely than the config/);
    assert.equal(check?.level, 'warn');
    assert.match(check?.title ?? '', /^1 story compares/);
    assert.match(check?.detail ?? '', /a--one/);
  });

  it('caps the listed ids at ten and counts the rest', async () => {
    const root = await project();
    const ids = Array.from({ length: 12 }, (_, i) => `s--${i.toString().padStart(2, '0')}`);
    await writeFile(path.join(root, 'storybook-static', 'index.json'), indexWith(ids));
    const check = find(await runChecks({ root }), /more loosely than the config/);
    assert.match(check?.title ?? '', /^12 stories compare/);
    assert.match(check?.detail ?? '', /s--09, and 2 more/);
    assert.doesNotMatch(check?.detail ?? '', /s--10\b/);
  });

  it('stays quiet while every story compares within the config', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'storybook-static', 'index.json'),
      JSON.stringify({
        v: 5,
        entries: {
          'a--one': {
            type: 'story',
            id: 'a--one',
            name: 'One',
            title: 'A',
            tags: ['diopsis:threshold=0.1'],
          },
        },
      }),
    );
    assert.equal(find(await runChecks({ root }), /more loosely than the config/), undefined);
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

describe('runChecks against git’s own ignore rules', () => {
  it('fails on an anchored pattern the exact-line check cannot see', async () => {
    const root = await project();
    spawnSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    // `/__screenshots__/` ignores the baselines while matching no line the string check
    // compares; inside a real repository git itself is asked.
    await writeFile(path.join(root, '.gitignore'), '/__screenshots__/\n');
    const check = find(await runChecks({ root }), /excludes __screenshots__/);
    assert.equal(check?.level, 'fail');
  });

  it('names the file, line and pattern of the rule that ignores the baselines', async () => {
    const root = await project();
    spawnSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    // The rule is the file's third line: the address has to carry the number, not only
    // the file's name.
    await writeFile(path.join(root, '.gitignore'), 'node_modules\ndist\n/__screenshots__/\n');
    const check = find(await runChecks({ root }), /excludes __screenshots__/);
    assert.equal(check?.level, 'fail');
    assert.match(check?.detail ?? '', /ignored by \.gitignore line 3 \(`\/__screenshots__\/`\)/);
  });

  it('names a parent directory rule when the repository ignores the directory the project sits in', async () => {
    // The repository lives at the temporary directory's root and ignores /sandbox/; the
    // project inside it has no .gitignore of its own, so the rule that bites is the one
    // two directories up, and the check has to say so.
    const outer = await mkdtemp(path.join(tmpdir(), 'diopsis-outer-'));
    temporaries.push(outer);
    spawnSync('git', ['init'], { cwd: outer, stdio: 'ignore' });
    await writeFile(path.join(outer, '.gitignore'), '/sandbox/\n');
    const root = path.join(outer, 'sandbox', 'proj');
    await cp(fixture, path.join(root, 'storybook-static'), { recursive: true });
    const check = find(await runChecks({ root }), /excludes __screenshots__/);
    assert.equal(check?.level, 'fail');
    assert.match(check?.detail ?? '', /ignored by \.\.\/\.\.\/\.gitignore line 1 \(`\/sandbox\/`\)/);
  });

  it('keeps the exact-line check outside a repository, where git cannot be asked', async () => {
    const root = await project();
    await writeFile(path.join(root, '.gitignore'), '/__screenshots__/\n');
    // No repository here, so the anchored pattern is beyond the fallback's reach — the
    // known limit of the string check, and the reason the git path exists.
    assert.equal(find(await runChecks({ root }), /excludes __screenshots__/), undefined);
  });

  it('accepts an output directory git ignores without naming it literally', async () => {
    const root = await project();
    spawnSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    // `.*` ignores the dot-prefixed output directory without the string ".diopsis" ever
    // appearing in the file.
    await writeFile(path.join(root, '.gitignore'), '.*\n');
    assert.equal(find(await runChecks({ root }), /is not ignored/), undefined);
  });
});

describe('runChecks on the CI image', () => {
  it('fails, naming the file and both images, when a workflow pins a different tag', async () => {
    const root = await project();
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(
      path.join(root, '.github', 'workflows', 'visual.yml'),
      'jobs:\n  visual:\n    image: mcr.microsoft.com/playwright:v1.50.0-jammy\n',
    );
    const check = find(await runChecks({ root }), /different Playwright image/);
    assert.equal(check?.level, 'fail');
    assert.match(check?.detail ?? '', /\.github\/workflows\/visual\.yml runs mcr\.microsoft\.com\/playwright:v1\.50\.0-jammy/);
    assert.match(check?.detail ?? '', /the config pins mcr\.microsoft\.com\/playwright:v1\.62\.1-jammy/);
  });

  it('is satisfied when CI names the pinned image in any host’s file', async () => {
    const root = await project();
    await writeFile(
      path.join(root, '.gitlab-ci.yml'),
      'image: mcr.microsoft.com/playwright:v1.62.1-jammy\n',
    );
    const check = find(await runChecks({ root }), /CI runs the pinned image/);
    assert.equal(check?.level, 'ok');
    assert.match(check?.detail ?? '', /\.gitlab-ci\.yml/);
  });

  it('leaves a neutral note when no CI file names a Playwright image', async () => {
    const root = await project();
    const check = find(await runChecks({ root }), /No CI file names a Playwright image/);
    assert.equal(check?.level, 'ok');
    assert.match(
      check?.detail ?? '',
      /Make sure CI runs in mcr\.microsoft\.com\/playwright:v1\.62\.1-jammy\./,
    );
  });

  it('warns when the installed @playwright/test differs from the image’s browser build', async () => {
    const root = await project();
    await mkdir(path.join(root, 'node_modules', '@playwright', 'test'), { recursive: true });
    await writeFile(
      path.join(root, 'node_modules', '@playwright', 'test', 'package.json'),
      '{"version":"1.70.0"}',
    );
    const check = find(await runChecks({ root }), /does not match the pinned image/);
    assert.equal(check?.level, 'warn');
    assert.match(check?.title ?? '', /1\.70\.0/);
  });

  it('finds workflow files under either extension', async () => {
    const root = await project();
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(
      path.join(root, '.github', 'workflows', 'visual.yaml'),
      'image: mcr.microsoft.com/playwright:v1.50.0-jammy\n',
    );
    const references = await findCiImageReferences(root);
    assert.deepEqual(references, [
      { file: '.github/workflows/visual.yaml', image: 'mcr.microsoft.com/playwright:v1.50.0-jammy' },
    ]);
  });
});

describe('doctorCommand --json', () => {
  it('prints machine-readable JSON, and nothing else, with the usual exit code', async () => {
    const root = await project();
    const { code, out } = await captureStdout(() => doctorCommand({ root, json: true }));
    // The test runner's own stdout bookkeeping can interleave with an awaited command's
    // output; the document is anchored on its first line, and ends at the only `}` that
    // sits at column zero.
    const start = out.indexOf('{\n  "diopsis": 1');
    const end = out.indexOf('\n}', start) + 2;
    const json = out.slice(start, end);
    const payload = JSON.parse(json) as { diopsis?: number; ok?: boolean; checks?: Check[] };
    assert.equal(payload.diopsis, 1);
    assert.equal(typeof payload.ok, 'boolean');
    assert.ok(Array.isArray(payload.checks));
    for (const check of payload.checks ?? []) {
      assert.ok(['ok', 'warn', 'fail'].includes(check.level));
      assert.ok(typeof check.title === 'string');
    }
    assert.equal(payload.ok, code === 0);
  });
});

describe('initCommand --force with an existing config', () => {
  it('keeps the git settings, cost table and CI recipe on the config being replaced', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      'export default { snapshotDir: \'__baselines__\', outputDir: \'.visual\', ' +
        "image: 'registry.example/pw:v9.9.9-x', viewports: { default: [375, 1280] } };",
    );
    const { code, out } = await captureStdout(() => initCommand({ root, force: true }));
    assert.equal(code, 0);

    const attributes = await readFile(path.join(root, '.gitattributes'), 'utf8');
    assert.match(attributes, /__baselines__\/\*\*\/\*\.png binary -merge -diff/);
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\.visual\/$/m);

    // The recipe names the configured image, and "(configured)" marks the configured
    // widths — a row of their own, not whichever preset has two entries.
    assert.match(out, /registry\.example\/pw:v9\.9\.9-x/);
    assert.match(out, /375, 1280[^\n]*\(configured\)/);
    assert.doesNotMatch(out, /320, 1280[^\n]*\(configured\)/);
  });

  it('refuses, and leaves the file alone, when the config cannot load', async () => {
    const root = await project();
    const file = path.join(root, 'diopsis.config.mjs');
    await writeFile(file, 'export default 42;');
    assert.equal(await initCommand({ root, force: true }), 1);
    assert.equal(await readFile(file, 'utf8'), 'export default 42;');
    assert.equal(existsSync(path.join(root, '.gitattributes')), false);
  });

  it('rewrites a config that loads back to the same values', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      "export default { compare: { threshold: 0.4, maxDiffPixels: 12 }, accessibility: 'fail', " +
        "stabilize: { retries: 3, freezeClock: '2025-05-05T00:00:00Z' }, mask: ['.clock'], " +
        "modes: { dark: { theme: 'dark' } }, budget: { captures: 500 }, timeout: 45000, " +
        "compress: 'auto', capture: 'component', workers: 2 };",
    );
    const before = (await loadConfig(root)).config;
    assert.equal(await initCommand({ root, force: true }), 0);
    assert.deepEqual((await loadConfig(root)).config, before);
  });

  it("writes the replaced config's own values, not the defaults", async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      'export default { storybookDir: \'built-storybook\', snapshotDir: \'__baselines__\', ' +
        "outputDir: '.visual', viewportHeight: 1200, " +
        'viewports: { default: [375, 1280], mobile: [320, 480] } };',
    );
    assert.equal(await initCommand({ root, force: true }), 0);

    const rewritten = await readFile(path.join(root, 'diopsis.config.mjs'), 'utf8');
    // The written config agrees with the git settings and the CI recipe the same run
    // wrote; a default template here would contradict both on the next load.
    assert.match(rewritten, /storybookDir: 'built-storybook'/);
    assert.match(rewritten, /snapshotDir: '__baselines__'/);
    assert.match(rewritten, /outputDir: '\.visual'/);
    assert.match(rewritten, /viewportHeight: 1200/);
    assert.match(rewritten, /viewports: \{ default: \[375, 1280\], mobile: \[320, 480\] \}/);
    assert.doesNotMatch(rewritten, /__screenshots__/);
    // It is the template that carries them — the replaced file itself matched every value
    // assertion above, so the scaffold lines are what prove a rewrite happened.
    assert.match(rewritten, /stabilize: \{/);
  });

  it('rewrites the existing file rather than adding a second config beside it', async () => {
    const root = await project();
    await writeFile(path.join(root, 'diopsis.config.mjs'), 'export default {};');
    assert.equal(await initCommand({ root, force: true }), 0);
    // Exactly one config file — the one that was already there, its extension kept: a
    // second one beside it would leave the loader's discovery order deciding the setup.
    const present = CONFIG_FILENAMES.filter((name) => existsSync(path.join(root, name)));
    assert.deepEqual(present, ['diopsis.config.mjs']);
  });
});

describe('runChecks with modes', () => {
  it('counts the mode captures in the cost line', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      "export default { modes: { dark: { theme: 'dark' } } };",
    );
    const checks = await runChecks({ root });
    // 7 base captures from the fixture, each joined by one dark twin.
    assert.match(find(checks, /stories/)?.title ?? '', /5 stories → 14 captures/);
  });

  it('treats a baseline for a mode the config no longer carries as an orphan', async () => {
    const root = await project();
    await mkdir(path.join(root, '__screenshots__', 'button--primary'), { recursive: true });
    await writeFile(
      path.join(root, '__screenshots__', 'button--primary', `320w-dark-${process.platform}-${process.arch}.png`),
      'x',
    );
    const check = find(await runChecks({ root }), /no longer exist/);
    assert.equal(check?.level, 'warn');
    assert.match(check?.detail ?? '', /320w-dark-/);
  });

  it('keeps a baseline for a configured mode out of the orphans', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      "export default { modes: { dark: { theme: 'dark' } } };",
    );
    await mkdir(path.join(root, '__screenshots__', 'button--primary'), { recursive: true });
    await writeFile(
      path.join(root, '__screenshots__', 'button--primary', `320w-dark-${process.platform}-${process.arch}.png`),
      'x',
    );
    assert.equal(find(await runChecks({ root }), /no longer exist/), undefined);
  });
});

describe('initCommand --force with modes configured', () => {
  it('multiplies the cost table and says so in the note', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      "export default { modes: { dark: { theme: 'dark' }, rtl: { direction: 'rtl' } } };",
    );
    const { code, out } = await captureStdout(() => initCommand({ root, force: true }));
    assert.equal(code, 0);
    // Two modes triple every row — 4 base captures at one width become 12. The rows
    // stay widths, as ever — the note is where the multiplier is said out loud.
    assert.match(out, /1280\s+12\s+960 KB/);
    assert.match(out, /320, 1280\s+21\s+1\.6 MB\s+\(configured\)/);
    assert.match(out, /Counts include the configured modes \(dark, rtl\)/);
  });

  it('prints no modes note when the config carries none', async () => {
    const root = await project();
    const { out } = await captureStdout(() => initCommand({ root, force: true }));
    assert.doesNotMatch(out, /Counts include the configured modes/);
    assert.match(out, /320, 1280\s+7\s+560 KB\s+\(configured\)/);
  });
});

describe('runChecks on the weight budget', () => {
  async function baselineAt(root: string, relative: string, bytes: number): Promise<void> {
    await mkdir(path.join(root, '__screenshots__', path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, '__screenshots__', relative), 'x'.repeat(bytes));
  }

  it('fails, naming both numbers, when the baselines outweigh the budget', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      "export default { budget: { weight: '1 KB' } };",
    );
    await baselineAt(root, `button--primary/320w-${process.platform}-${process.arch}.png`, 2048);
    const check = find(await runChecks({ root }), /over the .* budget/);
    assert.equal(check?.level, 'fail');
    assert.match(check?.title ?? '', /2 KB, over the 1 KB budget/);
  });

  it('warns within 10% of the budget, and reads ok under it', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      "export default { budget: { weight: '2 KB' } };",
    );
    // 1900 B is 93% of 2048 B: the warning zone, without crossing it.
    await baselineAt(root, `button--primary/320w-${process.platform}-${process.arch}.png`, 1900);
    const near = find(await runChecks({ root }), /within 10% of the .* budget/);
    assert.equal(near?.level, 'warn');

    const other = await project();
    await writeFile(
      path.join(other, 'diopsis.config.mjs'),
      "export default { budget: { weight: '2 KB' } };",
    );
    await baselineAt(other, `button--primary/320w-${process.platform}-${process.arch}.png`, 500);
    const under = find(await runChecks({ root: other }), /budget/);
    assert.equal(under?.level, 'ok');
    assert.match(under?.title ?? '', /500 B of the 2 KB budget/);
  });

  it('reports this platform\'s share beside the total in the inventory', async () => {
    const root = await project();
    await baselineAt(root, `button--primary/320w-${process.platform}-${process.arch}.png`, 1024);
    // Another platform's set — any token but this machine's, or the two would be one file.
    const other = `${process.platform}-${process.arch}` === 'linux-x64' ? 'darwin-arm64' : 'linux-x64';
    await baselineAt(root, `button--primary/320w-${other}.png`, 2048);
    const check = find(await runChecks({ root }), /baselines, /);
    assert.match(check?.detail ?? '', /1 KB on this platform/);
    assert.match(check?.detail ?? '', /3 KB in total/);
  });

  it('prints no budget line when none is configured', async () => {
    const root = await project();
    await baselineAt(root, `button--primary/320w-${process.platform}-${process.arch}.png`, 1024);
    assert.equal(find(await runChecks({ root }), /budget/), undefined);
  });
});

describe('runChecks on the capture budget', () => {
  it('fails, naming the count, when the matrix outgrows the budget', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      'export default { budget: { captures: 6 } };',
    );
    const check = find(await runChecks({ root }), /captures, over the/);
    assert.equal(check?.level, 'fail');
    assert.match(check?.title ?? '', /7 captures, over the 6 budget/);
  });

  it('warns when the matrix sits within 10% of the budget', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'diopsis.config.mjs'),
      'export default { budget: { captures: 7 } };',
    );
    const check = find(await runChecks({ root }), /captures, within 10%/);
    assert.equal(check?.level, 'warn');
  });
});

describe('runChecks rename hints', () => {
  it('names the move when an orphan\'s bytes match a baseline the last run called new', async () => {
    const root = await project();
    const token = `${process.platform}-${process.arch}`;
    for (const relative of [`button--primary/320w-${token}.png`, `old--story/320w-${token}.png`]) {
      await mkdir(path.join(root, '__screenshots__', path.dirname(relative)), { recursive: true });
      await writeFile(path.join(root, '__screenshots__', relative), 'identical-bytes');
    }
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
    const check = find(await runChecks({ root }), /no longer exist/);
    assert.match(check?.detail ?? '', /looks renamed: old--story → button--primary/);
  });
});
