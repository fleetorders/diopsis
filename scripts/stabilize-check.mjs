#!/usr/bin/env node
// Behavioural check for the capture runtime's waits — the determinism core no unit test reaches.
//
// Each wait decides whether a capture shows the finished story or something mid-load, and that
// is only observable in a real browser. This serves small pages shaped like a Storybook preview,
// opens each one through the same `openStory` the generated spec uses, and asserts what would
// have been photographed.
//
// Wire it into the moment it protects:
//   .githooks/pre-commit.local → runs only when src/runtime/ is staged
//   npm run check:stabilize    → by hand, any time
//
// Bypass is deliberate and loud: STABILIZE_CHECK_SKIP=1.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.env.STABILIZE_CHECK_SKIP === '1') {
  console.log('› stabilize-check: SKIPPED by STABILIZE_CHECK_SKIP=1');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  console.error('› stabilize-check: @playwright/test is not installed — run `npm install`.');
  process.exit(1);
}

const { openStory } = await import('../src/runtime/capture.ts');
const { serveStatic } = await import('../src/server.ts');
const { defaultConfig } = await import('../src/config.ts');

const work = await mkdtemp(path.join(os.tmpdir(), 'diopsis-stabilize-check-'));
const page = (script) => `<!doctype html><meta charset=utf-8>
<div id="storybook-root"><p id="out">waiting</p></div>
<script>${script}</script>`;

// A fetch behind a short timer: the case a fixed quiet window exists to catch.
await writeFile(path.join(work, 'data.json'), '{"ok":true}');
await writeFile(path.join(work, 'late-fetch.html'), page(`
  setTimeout(() => fetch('./data.json').then(r => r.json())
    .then(j => { document.getElementById('out').textContent = 'loaded ' + j.ok; }), 300);`));
// Nothing to wait for: the wait must not cost a fixed quiet window.
await writeFile(path.join(work, 'static.html'), page(`
  document.getElementById('out').textContent = 'static';`));
// A widget that re-arms its own timer forever must not hold the wait open until the deadline.
await writeFile(path.join(work, 'ticker.html'), page(`
  let n = 0; const tick = () => { n += 1; setTimeout(tick, 100); }; setTimeout(tick, 100);
  document.getElementById('out').textContent = 'ticking';`));
// A cancelled timer is no longer pending.
await writeFile(path.join(work, 'cleared.html'), page(`
  const t = setTimeout(() => {}, 400); clearTimeout(t);
  document.getElementById('out').textContent = 'cleared';`));

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

let browser;
const server = await serveStatic(work);
try {
  browser = await chromium.launch();
} catch (error) {
  console.error('› stabilize-check: could not launch Chromium — run `npx playwright install chromium`.');
  console.error('  ' + String(error).split('\n')[0]);
  await server.close();
  await rm(work, { recursive: true, force: true });
  process.exit(1);
}

async function open(file, options = defaultConfig.stabilize) {
  const context = await browser.newContext();
  const p = await context.newPage();
  const started = Date.now();
  await openStory(p, `${server.url}/${file}`, options);
  const elapsed = Date.now() - started;
  const text = await p.locator('#out').textContent();
  await context.close();
  return { text, elapsed };
}

try {
  const late = await open('late-fetch.html');
  check('a fetch behind a 300 ms timer is waited for', late.text === 'loaded true', late.text);

  // Costs are measured against the same page opened with the network wait switched off, so a
  // slow machine moves both sides and the check stays about the wait alone.
  const bare = { ...defaultConfig.stabilize, waitForNetworkIdle: false };
  const cost = async (file) => (await open(file)).elapsed - (await open(file, bare)).elapsed;

  const plain = await cost('static.html');
  check('a page with nothing pending is not held for a fixed window', plain < 300, `+${plain} ms`);

  const ticker = await cost('ticker.html');
  check('a self-rearming timer does not hold the wait open', ticker < 1000, `+${ticker} ms`);

  const cleared = await cost('cleared.html');
  check('a cleared timer is not waited for', cleared < 300, `+${cleared} ms`);
} finally {
  await browser.close();
  await server.close();
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
for (const r of failed) console.error(`  ✗ ${r.name} (${r.detail})`);
if (failed.length) {
  console.error(`› stabilize-check: ${failed.length} of ${results.length} checks failed.`);
  process.exit(1);
}
console.log(`› stabilize-check: ${results.length} checks passed.`);
