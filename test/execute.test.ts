import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runPlaywright } from '../src/runner/execute.ts';

/** This repo's root, whose `node_modules` holds the peer `@playwright/test`. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The exit code of `run` is Playwright's own, and the flake guard leans on one property of
 * it: a test that fails and then passes on a retry is flaky, and Playwright does not fail a
 * run over a flaky test — so unstable captures leave the exit code at 0. That property is
 * Playwright's, not Diopsis's, which is why it is pinned against the real CLI rather than
 * asserted of our own code.
 *
 * The throwaway project lives under the repo's `node_modules` for the same reason the
 * generated one does: the peer `@playwright/test` resolves by ordinary upward lookup
 * (DECISIONS.md D-012). Its test touches no Playwright fixture, so no browser is launched —
 * the check costs a second, not a browser download.
 */
describe('runPlaywright exit code', () => {
  it('keeps a run green over a test that differed once and matched when taken again', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'diopsis-exit-'));
    const dir = path.join(repoRoot, 'node_modules', '.diopsis', 'exit-code-check');
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n');
      await writeFile(
        path.join(dir, 'playwright.config.js'),
        [
          "import { defineConfig } from '@playwright/test';",
          "export default defineConfig({ testDir: '.', retries: 1, outputDir: './out', reporter: 'dot' });",
          '',
        ].join('\n'),
      );
      // Attempts are counted across processes: a Playwright retry runs in a fresh worker,
      // which is the same property that makes a retry a fresh load of the story.
      await writeFile(
        path.join(dir, 'flaky.spec.js'),
        [
          "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
          "import { test } from '@playwright/test';",
          "const marker = process.env.DIOPSIS_FLAKY_MARKER ?? '/dev/null';",
          "const attempts = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;",
          "writeFileSync(marker, String(attempts + 1));",
          "test('differed once, matched when taken again', async () => {",
          "  if (attempts === 0) throw new Error('first load of the story differed');",
          '});',
          "test('always differs', async () => { throw new Error('a real change never matches'); });",
          '',
        ].join('\n'),
      );

      const marker = path.join(work, 'attempts');
      const env = { DIOPSIS_FLAKY_MARKER: marker };
      const configPath = path.join(dir, 'playwright.config.js');

      const flakyOnly = await runPlaywright({
        root: repoRoot,
        configPath,
        args: ['--grep=differed once, matched'],
        env,
      });
      assert.equal(flakyOnly, 0);

      const withRealChange = await runPlaywright({ root: repoRoot, configPath, env });
      assert.notEqual(withRealChange, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});
