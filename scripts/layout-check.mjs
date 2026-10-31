#!/usr/bin/env node
// Behavioural check for the layout audit — the walk no unit test reaches.
//
// The unit suite drives `analyzeLayout` over hand-written boxes; whether the page-side walk
// reports a real laid-out page as those boxes is only observable in a browser. This serves
// small pages shaped like a Storybook preview, opens each one through the same `openStory`
// the generated spec uses at the widths a run would set, and asserts the findings the whole
// pipeline (walk → analysis → failure line) produces. The planted case is the audit's reason
// to exist: a title an image grows over at one width only, invisible to any baseline.
//
// Wire it into the moment it protects:
//   .githooks/pre-commit.local → runs only when the audit's sources are staged
//   npm run check:layout       → by hand, any time
//
// Bypass is deliberate and loud: LAYOUT_CHECK_SKIP=1.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.env.LAYOUT_CHECK_SKIP === '1') {
  console.log('› layout-check: SKIPPED by LAYOUT_CHECK_SKIP=1');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  console.error('› layout-check: @playwright/test is not installed — run `npm install`.');
  process.exit(1);
}

const { measureLayout, openStory } = await import('../src/runtime/capture.ts');
const { analyzeLayout, layoutFailureOf } = await import('../src/layout.ts');
const { serveStatic } = await import('../src/server.ts');
const { defaultConfig } = await import('../src/config.ts');

const work = await mkdtemp(path.join(os.tmpdir(), 'diopsis-layout-check-'));

// The planted overlap: below 800 px the image is drawn over the title; wide, it floats
// beside it. The title is inline-block so its box is its text, not the whole line —
// otherwise a block heading would "overlap" anything on the row.
await writeFile(path.join(work, 'car-over-title.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0}h1{display:inline-block;width:200px;margin:0}
#car{position:absolute;top:0;width:220px;height:120px}
@media (max-width:799px){#car{left:0}}
@media (min-width:800px){#car{left:260px}}</style>
<div id="storybook-root">
  <h1 id="title">Reserve a car</h1>
  <img id="car" alt="A car"
    src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">
</div>`);

// The same planted overlap inside a wrapper that marks it intended: an image partly over
// free space is a design, and `data-diopsis-overlap` is how a story says so.
await writeFile(path.join(work, 'intended-overlap.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0}h1{display:inline-block;width:200px;margin:0}
#badge{position:absolute;left:40px;top:0;width:180px;height:90px}</style>
<div id="storybook-root">
  <div data-diopsis-overlap>
    <h1 id="title">Reserve a car</h1>
    <img id="badge" alt="A badge"
      src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">
  </div>
</div>`);

// Text a container hides on its horizontal axis: the cut-off the audit reports where an
// ellipsis would be the design.
await writeFile(path.join(work, 'cut-off.html'), `<!doctype html><meta charset=utf-8>
<div id="storybook-root">
  <p id="cut" style="width:120px;margin:0;overflow:hidden;white-space:nowrap">
    The quick brown fox jumps over the lazy dog, again and again</p>
</div>`);

// The vertical twin, as a deliberate truncation: a line clamp hides text on purpose, and
// the walk must read the computed clamp rather than the hidden pixels alone.
await writeFile(path.join(work, 'clamped.html'), `<!doctype html><meta charset=utf-8>
<div id="storybook-root">
  <p id="clamped" style="width:200px;margin:0;display:-webkit-box;-webkit-box-orient:vertical;
    -webkit-line-clamp:2;overflow:hidden">
    First line of a caption that runs long.
    Second line, also long.
    Third line the clamp exists to hide.
    Fourth line, hidden the same way.</p>
</div>`);

// A page that scrolls sideways because an element reaches past the right edge: the audit
// names the element that reaches furthest.
// A page that scrolls sideways because an element reaches past the right edge: the audit
// names the element that reaches furthest. Body margin zeroed so the reach asserted below
// is exact.
await writeFile(path.join(work, 'sideways.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0}</style>
<div id="storybook-root">
  <p id="wide" style="width:1500px;margin:0">a row the viewport cannot hold</p>
</div>`);

// Nothing wrong anywhere: a paragraph and an image in normal flow.
await writeFile(path.join(work, 'clean.html'), `<!doctype html><meta charset=utf-8>
<div id="storybook-root">
  <h1 style="margin:0">Reserve a car</h1>
  <img alt="A car" width="60" height="40"
    src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">
</div>`);

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

let browser;
const server = await serveStatic(work);
try {
  browser = await chromium.launch();
} catch (error) {
  console.error('› layout-check: could not launch Chromium — run `npx playwright install chromium`.');
  console.error('  ' + String(error).split('\n')[0]);
  await server.close();
  await rm(work, { recursive: true, force: true });
  process.exit(1);
}

// One capture's worth of the pipeline, exactly as the generated spec runs it: open at the
// width, walk, analyse — and the line a 'fail' run would fail the capture with.
async function audit(file, storyId, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const p = await context.newPage();
  await openStory(p, `${server.url}/${file}`, defaultConfig.stabilize);
  const measurement = await measureLayout(p);
  const findings = analyzeLayout(measurement.elements, measurement.page);
  await context.close();
  return {
    findings,
    failure: layoutFailureOf(findings, storyId, width),
    measured: JSON.stringify(measurement),
  };
}

try {
  const broken = await audit('car-over-title.html', 'car--over-title', 600);
  const [overlap] = broken.findings;
  check(
    'a title under an image at the broken width is an overlap finding',
    broken.findings.length === 1 &&
      overlap?.kind === 'overlap' &&
      overlap.covered.selector === 'h1#title' &&
      overlap.covering.selector === 'img#car',
    JSON.stringify(broken.findings),
  );
  check(
    'the failure line names the story and the width',
    broken.failure === 'New layout findings: 1 in car--over-title @600 (overlap ×1)',
    broken.failure ?? 'none',
  );

  const clean = await audit('car-over-title.html', 'car--over-title', 1000);
  check(
    'the same story at the width where the layout holds reports nothing',
    clean.findings.length === 0,
    JSON.stringify(clean.findings),
  );

  const intended = await audit('intended-overlap.html', 'intended-overlap', 600);
  check(
    'an overlap marked data-diopsis-overlap stays silent',
    intended.findings.length === 0,
    JSON.stringify(intended.findings),
  );

  const cut = await audit('cut-off.html', 'cut-off', 600);
  const [clip] = cut.findings;
  check(
    'text a container hides past its box is a text-clip finding',
    cut.findings.length === 1 &&
      clip?.kind === 'text-clip' &&
      clip.element.selector === 'p#cut' &&
      clip.axis === 'x',
    JSON.stringify(cut.findings),
  );

  const clamped = await audit('clamped.html', 'clamped', 600);
  check(
    'a line clamp hides text on purpose and is not a finding',
    clamped.findings.length === 0,
    JSON.stringify(clamped.findings),
  );

  const sideways = await audit('sideways.html', 'sideways', 600);
  const [overflow] = sideways.findings;
  check(
    'a page that scrolls sideways names the element reaching furthest past the edge',
    sideways.findings.length === 1 &&
      overflow?.kind === 'horizontal-overflow' &&
      overflow.element.selector === 'p#wide' &&
      overflow.beyond === 900,
    JSON.stringify(sideways.findings),
  );

  const plain = await audit('clean.html', 'clean', 600);
  check('a page with nothing wrong reports nothing', plain.findings.length === 0,
    JSON.stringify(plain.findings));

  const again = await audit('car-over-title.html', 'car--over-title', 600);
  check(
    'the same page at the same width measures byte-identically',
    again.measured === broken.measured,
    'measurements differ between runs',
  );
} finally {
  await browser.close();
  await server.close();
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
for (const r of failed) console.error(`  ✗ ${r.name} (${r.detail})`);
if (failed.length) {
  console.error(`› layout-check: ${failed.length} of ${results.length} checks failed.`);
  process.exit(1);
}
console.log(`› layout-check: ${results.length} checks passed.`);
