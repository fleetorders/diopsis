import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'verify-doctor.mjs',
);

const temporaries: string[] = [];

async function document(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-verify-doctor-'));
  temporaries.push(dir);
  const file = path.join(dir, 'doctor.json');
  await writeFile(file, body, 'utf8');
  return file;
}

/** The document a green fixture run produces: one counts-carrying check, some warns. */
const green = JSON.stringify({
  diopsis: 1,
  ok: true,
  checks: [
    { level: 'ok', title: 'Baseline image is pinned' },
    { level: 'ok', title: '5 stories → 7 captures', counts: { stories: 5, captures: 7 } },
    { level: 'warn', title: 'No baselines yet at __screenshots__' },
  ],
});

function verify(file: string, stories = 5, captures = 7) {
  return spawnSync(process.execPath, [script, file, String(stories), String(captures)], {
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verify-doctor', () => {
  it('passes a green document with the expected counts', async () => {
    const result = verify(await document(green));
    assert.equal(result.status, 0, result.stderr);
  });

  it('names the failing checks when doctor was not ok', async () => {
    const red = JSON.parse(green);
    red.ok = false;
    red.checks.push({ level: 'fail', title: 'No image pinned', detail: 'Pin one in the config.' });
    const result = verify(await document(JSON.stringify(red)));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No image pinned/);
    assert.match(result.stderr, /failing checks/);
  });

  it('reports the counts it received when the numbers differ', async () => {
    const result = verify(await document(green), 4, 6);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /counted 5 stories → 7 captures, expected 4 → 6/);
  });

  it('distinguishes a changed schema from wrong counts', async () => {
    const drifted = JSON.stringify({ diopsis: 1, ok: true, results: [] });
    const result = verify(await document(drifted));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a diopsis doctor document/);
  });

  it('quotes the stray line when stdout was not pure JSON', async () => {
    const polluted = `npm warn deprecated something\n${green}\n`;
    const result = verify(await document(polluted));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not one JSON document/);
    assert.match(result.stderr, /npm warn deprecated/);
  });

  it('refuses to run without the expected counts', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: verify-doctor/);
  });
});
