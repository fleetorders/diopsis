import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { traceCommand } from '../src/commands/trace.ts';

const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

/** A project with a built Storybook carrying a deep chain and an orphan module. */
async function traceRoot(withStats = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'diopsis-trace-'));
  temporaries.push(root);
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

  if (withStats) {
    await writeFile(
      path.join(build, 'preview-stats.json'),
      JSON.stringify({
        modules: [
          {
            name: './src/Button.stories.tsx',
            reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/vite-app.js' }],
          },
          { name: './src/Button.tsx', reasons: [{ moduleName: './src/Button.stories.tsx' }] },
          {
            name: './src/Input.stories.tsx',
            reasons: [{ moduleName: '/virtual:/@storybook/builder-vite/vite-app.js' }],
          },
          { name: './src/Input.tsx', reasons: [{ moduleName: './src/Input.stories.tsx' }] },
          { name: './src/lib/deep.ts', reasons: [{ moduleName: './src/Button.tsx' }] },
          { name: './src/lib/theme.ts', reasons: [] },
        ],
      }),
    );
  }
  return root;
}

describe('traceCommand', () => {
  it('prints the chain from a file to the stories it reaches', async () => {
    const root = await traceRoot();
    const { value: code, out } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['src/lib/deep.ts'] }),
    );
    assert.equal(code, 0);
    assert.match(
      out,
      /src\/lib\/deep\.ts → src\/Button\.tsx → src\/Button\.stories\.tsx → example-button--primary/,
    );
    assert.doesNotMatch(out, /example-input/);
  });

  it('answers for several files in one call', async () => {
    const root = await traceRoot();
    const { out } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['src/lib/deep.ts', 'src/lib/theme.ts'] }),
    );
    assert.match(out, /src\/lib\/deep\.ts:\n/);
    assert.match(out, /src\/lib\/theme\.ts:\n  no story reaches this file\n/);
  });

  it('states the full-run reason a trigger file would force', async () => {
    const root = await traceRoot();
    const { out } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['package.json'] }),
    );
    assert.match(out, /package\.json:\n  full run — .*package manifest or lockfile/);
  });

  it('states the full-run reason an unknown file would force', async () => {
    const root = await traceRoot();
    const { out } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['src/nope.ts'] }),
    );
    assert.match(out, /src\/nope\.ts:\n  full run — .*not in the module graph/);
  });

  it('says a run ignores its own output, as run --changed does', async () => {
    const root = await traceRoot();
    const { out } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['.diopsis/summary.json', '__screenshots__/a/320w.png'] }),
    );
    assert.match(out, /\.diopsis\/summary\.json:\n  ignored by a run \(\.diopsis\/\*\*\)/);
    assert.match(out, /__screenshots__\/a\/320w\.png:\n  ignored by a run \(__screenshots__\/\*\*\)/);
  });

  it('reports the missing stats file as the full-run reason it is', async () => {
    const root = await traceRoot(false);
    const { value: code, out } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['src/Button.tsx'] }),
    );
    assert.equal(code, 0);
    assert.match(out, /full run — no preview-stats\.json/);
  });

  it('refuses to trace without a Storybook build', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'diopsis-empty-'));
    temporaries.push(root);
    const { value: code, err } = await withCapturedStdout(() =>
      traceCommand({ root, files: ['src/x.ts'] }),
    );
    assert.equal(code, 1);
    assert.match(err, /No Storybook build at storybook-static/);
  });
});
