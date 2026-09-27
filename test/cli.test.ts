import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { main } from '../src/cli.ts';

async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
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
    const code = await main(argv);
    return { code, out: stdout.join(''), err: stderr.join('') };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

describe('main', () => {
  it('prints the package version for --version and -v', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    for (const flag of ['--version', '-v']) {
      const { code, out } = await runMain([flag]);
      assert.equal(code, 0);
      assert.equal(out.trim(), manifest.version);
    }
  });

  it('prints usage and exits 0 for help, --help and -h', async () => {
    for (const argv of [['help'], ['--help'], ['-h']]) {
      const { code, out } = await runMain(argv);
      assert.equal(code, 0);
      assert.match(out, /Usage/);
    }
  });

  it('refuses unknown commands', async () => {
    const { code, err } = await runMain(['frobnicate']);
    assert.equal(code, 1);
    assert.match(err, /Unknown command "frobnicate"/);
    assert.match(err, /Usage/);
  });

  it('refuses a flag that belongs to another command', async () => {
    const { code, err } = await runMain(['accept', '--grep', 'x']);
    assert.equal(code, 1);
    assert.match(err, /diopsis accept does not take --grep\./);
    assert.match(err, /Usage/);
  });

  it('refuses stray flags across the board', async () => {
    assert.match((await runMain(['run', '--force'])).err, /diopsis run does not take --force\./);
    assert.match((await runMain(['init', '--keep'])).err, /diopsis init does not take --keep\./);
    assert.match(
      (await runMain(['doctor', '--no-stage'])).err,
      /diopsis doctor does not take --no-stage\./,
    );
  });

  it('hints at the -- passthrough when a flag is unknown altogether', async () => {
    const { code, err } = await runMain(['run', '--frobnicate']);
    assert.equal(code, 1);
    assert.match(err, /diopsis run does not take --frobnicate\./);
    assert.match(err, /Playwright options go after --, e\.g\. diopsis run -- --workers=2/);
  });

  it('refuses Playwright’s own sharding, which would split by test not by story', async () => {
    for (const argv of [['run', '--', '--shard=1/2'], ['run', '--', '--shard', '1/2']]) {
      const { code, err } = await runMain(argv);
      assert.equal(code, 1, argv.join(' '));
      assert.match(err, /shards by test, not by story/);
      assert.match(err, /Use --shard <i>\/<n>\./);
    }
  });

  it('refuses a --shard that is not <i>/<n> between 1 and n', async () => {
    for (const bad of ['0/4', '5/4', '2', 'a/b']) {
      const { code, err } = await runMain(['run', '--shard', bad]);
      assert.equal(code, 1, bad);
      assert.match(err, new RegExp(`--shard takes <i>/<n> with 1 ≤ i ≤ n.*\\(got "${bad}"\\)`));
    }
  });

  it('documents the per-command options, version and passthrough in the usage text', async () => {
    const { out } = await runMain(['help']);
    assert.match(out, /--version \| -v/);
    assert.match(out, /accept \[story-id\.\.\.\]/);
    assert.match(out, /merge \[dir\.\.\.\]/);
    assert.match(out, /--shard <i>\/<n>/);
    assert.match(out, /accept +--from <dir>/);
    assert.match(out, /--workers=2/);
    assert.match(out, /doctor +--json/);
    assert.match(out, /--changed \[base\]/);
    assert.match(out, /diopsis trace <file\.\.\.>/);
  });

  it('refuses --changed on the commands it does not shape', async () => {
    assert.match(
      (await runMain(['update', '--changed'])).err,
      /diopsis update does not take --changed\./,
    );
    assert.match(
      (await runMain(['accept', '--changed', 'main'])).err,
      /diopsis accept does not take --changed\./,
    );
  });

  it('requires a file to trace', async () => {
    const { code, err } = await runMain(['trace']);
    assert.equal(code, 1);
    assert.match(err, /diopsis trace takes at least one file/);
    assert.match(err, /Usage/);
  });

  it('prints doctor’s audit as JSON for --json, with nothing else on stderr', async () => {
    const { code, out, err } = await runMain(['doctor', '--json']);
    assert.equal(err, '');
    // The test runner writes its own bookkeeping to stdout while the command awaits I/O;
    // the command's document is anchored on its first line, and ends at the only `}` that
    // sits at column zero.
    const start = out.indexOf('{\n  "diopsis": 1');
    const end = out.indexOf('\n}', start) + 2;
    const json = out.slice(start, end);
    const payload = JSON.parse(json) as { diopsis?: number; ok?: boolean; checks?: unknown[] };
    assert.equal(payload.diopsis, 1);
    assert.ok(Array.isArray(payload.checks));
    // The exit code carries the verdict, so a scripted doctor needs no text parsing.
    assert.equal(payload.ok, code === 0);
  });

  it('states the Node floor as 18.11 in the engines field and the README', async () => {
    // The flag handling reads the argument parser's token stream and its option defaults,
    // which arrived in Node 18.7 and 18.11 respectively — so 18.11 is the oldest release
    // the compiled CLI runs on, and the two surfaces must not drift apart.
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines?: { node?: string } };
    assert.equal(manifest.engines?.node, '>=18.11');
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    assert.doesNotMatch(readme, /Node 18\.\d\D/);
    assert.match(readme, /Node 18\.11/);
  });
});

