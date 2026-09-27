import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { serveStatic, storyUrlFor, type StaticServer } from '../src/server.ts';

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'storybook-static',
);

describe('serveStatic', () => {
  let server: StaticServer;

  before(async () => {
    server = await serveStatic(root);
  });
  after(async () => {
    await server.close();
  });

  it('serves the preview with an HTML content type', async () => {
    const response = await fetch(`${server.url}/iframe.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /storybook-root/);
  });

  it('serves the story index as JSON', async () => {
    const response = await fetch(`${server.url}/index.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = (await response.json()) as { v: number };
    assert.equal(body.v, 5);
  });

  it('never serves a cached response, so a rebuilt Storybook is the one captured', async () => {
    const response = await fetch(`${server.url}/index.json`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('404s on a path that is not there', async () => {
    assert.equal((await fetch(`${server.url}/nope.html`)).status, 404);
  });

  it('refuses to serve outside the build directory', async () => {
    const response = await fetch(`${server.url}/../../../package.json`);
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  });

  it('refuses an encoded traversal too', async () => {
    const response = await fetch(`${server.url}/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  });

  it('picks a free port when asked for any', () => {
    assert.ok(server.port > 0);
  });
});

describe('storyUrlFor', () => {
  it('addresses the preview directly, without the manager UI', () => {
    assert.equal(
      storyUrlFor('http://127.0.0.1:1234', 'button--primary'),
      'http://127.0.0.1:1234/iframe.html?viewMode=story&id=button--primary',
    );
  });

  it('tolerates a trailing slash on the base', () => {
    assert.equal(
      storyUrlFor('http://127.0.0.1:1234/', 'a--b'),
      'http://127.0.0.1:1234/iframe.html?viewMode=story&id=a--b',
    );
  });

  it('encodes the story id', () => {
    assert.match(storyUrlFor('http://x', 'a b&c'), /id=a%20b%26c$/);
  });
});

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach } from 'node:test';

const errorTemporaries: string[] = [];

afterEach(async () => {
  await Promise.all(
    errorTemporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('serveStatic error handling', () => {
  let errorServer: StaticServer;

  before(async () => {
    errorServer = await serveStatic(root);
  });
  after(async () => {
    await errorServer.close();
  });

  it('answers 400, not 500, on a malformed percent-escape', async () => {
    const response = await fetch(`${errorServer.url}/%zz`);
    assert.equal(response.status, 400);
  });

  it('ends with 500 instead of crashing when the file cannot be read', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return t.skip('root can read a mode-000 file');
    }
    // Windows has no read-permission bits for chmod to take away.
    if (process.platform === 'win32') return t.skip('file modes do not deny reads on Windows');
    const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-server-'));
    errorTemporaries.push(dir);
    // stat succeeds without read permission; opening the stream then fails, which is the
    // window an unhandled stream error used to crash the process in.
    await writeFile(path.join(dir, 'denied.png'), 'x');
    await chmod(path.join(dir, 'denied.png'), 0o000);
    const server = await serveStatic(dir);
    try {
      const response = await fetch(`${server.url}/denied.png`);
      assert.equal(response.status, 500);
    } finally {
      await server.close();
    }
  });
});

describe('storyUrlFor with globals', () => {
  it('appends the globals parameter in the format the preview reads', () => {
    assert.equal(
      storyUrlFor('http://127.0.0.1:1234', 'button--primary', { theme: 'dark' }),
      'http://127.0.0.1:1234/iframe.html?viewMode=story&id=button--primary&globals=theme:dark',
    );
  });

  it('joins pairs with ; and each key and value with :', () => {
    assert.equal(
      storyUrlFor('http://x', 'a--b', { direction: 'rtl', locale: 'ar' }),
      'http://x/iframe.html?viewMode=story&id=a--b&globals=direction:rtl;locale:ar',
    );
  });

  it('percent-encodes keys and values, never the separators', () => {
    assert.equal(
      storyUrlFor('http://x', 'a--b', { 'a key': 'a value&more' }),
      'http://x/iframe.html?viewMode=story&id=a--b&globals=a%20key:a%20value%26more',
    );
  });

  it('omits the parameter entirely when there are no globals', () => {
    assert.equal(
      storyUrlFor('http://x', 'a--b', {}),
      'http://x/iframe.html?viewMode=story&id=a--b',
    );
  });
});
