import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Locate the Playwright test CLI installed in the project under test.
 *
 * `@playwright/test` is a peer dependency (docs/decisions.md, D-015), so it is resolved from the
 * project rather than bundled — one browser download, one version, no duplicate.
 */
export function resolvePlaywrightCli(root: string): string {
  const require = createRequire(path.join(root, 'noop.js'));
  try {
    const manifestPath = require.resolve('@playwright/test/package.json');
    const manifest = require('@playwright/test/package.json') as { bin?: Record<string, string> | string };
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['playwright'];
    if (bin) {
      const cli = path.join(path.dirname(manifestPath), bin);
      if (existsSync(cli)) return cli;
    }
  } catch {
    // Fall through to the bin shim.
  }

  const shim = path.join(root, 'node_modules', '.bin', 'playwright');
  if (existsSync(shim)) return shim;

  throw new Error(
    'Cannot find @playwright/test. Diopsis takes it as a peer dependency so that browsers ' +
      'are downloaded once: install it in this project with `npm install -D @playwright/test`.',
  );
}

export interface ExecuteOptions {
  root: string;
  configPath: string;
  /** Extra arguments appended to `playwright test`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

/** Run `playwright test` against the generated project and resolve with its exit code. */
export async function runPlaywright(options: ExecuteOptions): Promise<number> {
  const cli = resolvePlaywrightCli(options.root);
  const args = [cli, 'test', `--config=${options.configPath}`, ...(options.args ?? [])];

  const env = { ...process.env, ...options.env };
  // Editor-integrated terminals can export this to reuse the editor binary as Node. It makes
  // Chromium's launcher reject its own arguments, so it is cleared for the child.
  delete env['ELECTRON_RUN_AS_NODE'];

  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.root,
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
