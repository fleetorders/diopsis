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

// The planted overlap: below 800 px the image is drawn over the title; wide, it sits
// beside it. The title is a plain block heading: text is judged by its line boxes, so the
// rest of its row is free space, not title.
await writeFile(path.join(work, 'car-over-title.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0}h1{width:200px;margin:0;font-size:24px}
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
// names the element that reaches furthest. Body margin zeroed so the reach asserted below
// is exact.
await writeFile(path.join(work, 'sideways.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0}</style>
<div id="storybook-root">
  <p id="wide" style="width:1500px;margin:0">a row the viewport cannot hold</p>
</div>`);

// Ordinary layouts a block box would misread, every one clean: an icon button labelled by
// screen-reader-only text, a paragraph wrapping round a floated image, a close button laid
// at the end of a heading's row, and a card that crops its tall image under a caption in
// full view.
const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await writeFile(path.join(work, 'ordinary.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0;font:16px/20px sans-serif}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}
section{margin-bottom:24px}</style>
<div id="storybook-root">
  <section><button id="icon" style="width:32px;height:32px;padding:0">
    <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2l12 12M14 2L2 14" stroke="#000"/></svg>
    <span class="sr-only">Close the dialog</span></button></section>
  <section style="width:400px"><img id="float" alt="" src="${pixel}"
    style="float:left;width:100px;height:100px;margin-right:8px">
    <p id="wrap" style="margin:0">A paragraph long enough to wrap beside the floated image and
    then carry on underneath it, line after line, the way an article body sits next to its
    picture. Its block runs under the float; its words never do. One more sentence to make
    sure the text reaches below the image.</p></section>
  <section style="position:relative;width:400px"><h2 id="heading" style="margin:0;font-size:20px;line-height:32px">Dialog title</h2>
    <button id="close" style="position:absolute;top:0;right:0;width:32px;height:32px">×</button></section>
  <section id="card" style="width:200px;height:120px;overflow:hidden">
    <p style="margin:0">Caption</p>
    <img alt="" src="${pixel}" style="display:block;width:200px;height:160px"></section>
</div>`);

// The card's true positive: the same crop with the caption under the image, past the edge.
await writeFile(path.join(work, 'card-cuts-caption.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0;font:16px/20px sans-serif}</style>
<div id="storybook-root">
  <div id="card" style="width:200px;height:120px;overflow:hidden">
    <img alt="" src="${pixel}" style="display:block;width:200px;height:110px">
    <p style="margin:0;white-space:nowrap">Cut caption</p></div>
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

  const ordinary = await audit('ordinary.html', 'ordinary', 600);
  check(
    'screen-reader text, a float, a close button on a heading row and a cropped image are not findings',
    ordinary.findings.length === 0,
    JSON.stringify(ordinary.findings),
  );

  const caption = await audit('card-cuts-caption.html', 'card-cuts-caption', 600);
  const [cutCaption] = caption.findings;
  check(
    'a card cutting off its caption is a text-clip finding, sized by the text past the edge',
    // The line reaches 10 px past the edge at its line height; its glyph box ends a pixel
    // or two sooner, depending on the font, so the reach is a range rather than one number.
    caption.findings.length === 1 &&
      cutCaption?.kind === 'text-clip' &&
      cutCaption.element.selector === 'div#card' &&
      cutCaption.axis === 'y' &&
      cutCaption.hidden > 4 &&
      cutCaption.hidden <= 10,
    JSON.stringify(caption.findings),
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
