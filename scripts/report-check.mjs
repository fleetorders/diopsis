#!/usr/bin/env node
// Behavioural check for the HTML report — the one part of Diopsis that no unit test can reach.
//
// The report's behaviour lives in a string of client-side JavaScript that only runs once a
// browser has parsed it, so `node --test` can assert that the string was emitted and nothing
// more. This renders a report from a synthetic run, opens it, and drives it.
//
// Wire it into the moment it protects:
//   .githooks/pre-commit.local → runs only when src/report/ is staged
//   npm run check:report       → by hand, any time
//
// Bypass is deliberate and loud: REPORT_CHECK_SKIP=1.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.env.REPORT_CHECK_SKIP === '1') {
  console.log('› report-check: SKIPPED by REPORT_CHECK_SKIP=1');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  console.error('› report-check: @playwright/test is not installed — run `npm install`.');
  process.exit(1);
}

const { renderReport } = await import('../src/report/html.ts');

const work = await mkdtemp(path.join(os.tmpdir(), 'diopsis-report-check-'));
await mkdir(path.join(work, 'shots'), { recursive: true });

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const fixture = (title, body, pad, extra) => `<!doctype html><meta charset=utf-8>
<style>body{margin:0;font:16px/1.5 system-ui;background:#fff;color:#111;padding:24px}
.card{border:1px solid #d0d7de;border-radius:12px;padding:${pad}px;max-width:520px}
h2{margin:0 0 8px;font-size:20px}p{margin:0;color:#555}</style>
<div class=card><h2>${title}</h2><p>${body}</p>${extra}</div>`;

let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  console.error('› report-check: could not launch Chromium — run `npx playwright install chromium`.');
  console.error('  ' + String(error).split('\n')[0]);
  await rm(work, { recursive: true, force: true });
  process.exit(1);
}

async function shot(file, html, width) {
  const page = await browser.newPage({ viewport: { width, height: 400 } });
  await page.setContent(html);
  await page.screenshot({ path: path.join(work, 'shots', file), fullPage: true });
  await page.close();
}

// The pair that matters most: a current render TALLER than its baseline. A comparison that
// scales by height understates exactly this case, so the fixture has to contain one.
// The extra block has to clear the viewport floor, or both full-page screenshots come out the
// same height and the geometry assertions below pass without ever exercising a mismatch.
const grown = '<p style="margin-top:10px">And now an extra line the baseline never had.</p>' +
  '<div style="height:320px"></div>';
await shot('a-base.png', fixture('A card', 'Renders identically at every configured width.', 18, ''), 640);
await shot('a-act.png', fixture('A card', 'Renders identically at every configured width.', 30, grown), 640);
await shot('a-diff.png', fixture('A card', 'Renders identically at every configured width.', 30,
  grown.replace('margin-top:10px', 'margin-top:10px;background:#f0c')), 640);
await shot('b-base.png', fixture('Long card', 'A second story, unchanged in width.', 18, ''), 380);
await shot('b-act.png', fixture('Long card', 'A second story, unchanged in width.', 22, ''), 380);
await shot('b-diff.png', fixture('Long card', 'A second story, unchanged in width.', 22,
  '<p style="background:#f0c;height:6px;margin-top:6px"></p>'), 380);
await shot('c-act.png', fixture('Brand new', 'No baseline exists for this one yet.', 18, ''), 480);

const capture = (o) => ({
  storyTitle: o.t, storyName: o.n, storyId: o.id, width: o.w, status: o.s,
  snapshotPath: `${o.id}-${o.w}.png`, artifacts: o.a || {},
  ...(o.px != null ? { diffPixels: o.px, diffRatio: o.r } : {}),
  ...(o.err ? { error: o.err } : {}),
});

const captures = [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 12840, r: 0.0412,
    a: { expected: 'shots/a-base.png', actual: 'shots/a-act.png', diff: 'shots/a-diff.png' } }),
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 320, s: 'unchanged' }),
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'changed', px: 2684, r: 0.0088,
    a: { expected: 'shots/b-base.png', actual: 'shots/b-act.png', diff: 'shots/b-diff.png' } }),
  capture({ t: 'Card', n: 'Brand new', id: 'card--brand-new', w: 480, s: 'new',
    // Both references, as a real fresh result carries them: the "expected" is the baseline
    // the comparator just wrote from this render — the same bytes as the actual.
    a: { expected: 'shots/c-act.png', actual: 'shots/c-act.png' } }),
  capture({ t: 'Header', n: 'Sticky', id: 'header--sticky', w: 1280, s: 'render-failed',
    err: 'StoryRenderError: the story never left its loading state' }),
  capture({ t: 'Footer', n: 'Default', id: 'footer--default', w: 1280, s: 'unchanged' }),
];

const summary = {
  diopsis: 1, createdAt: '2026-01-01T00:00:00.000Z', platform: 'linux', arch: 'x64',
  mode: 'run', snapshotDir: '__screenshots__',
  totals: { stories: 4, captures: captures.length, unchanged: 2, changed: 2, new: 1, renderFailed: 1, failed: 0 },
  changedStories: ['card--brand-new', 'card--default', 'card--long', 'header--sticky'],
  captures,
};

await writeFile(path.join(work, 'report.html'), await renderReport(summary, work));
const url = 'file://' + path.join(work, 'report.html');

let page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const crashes = [];
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto(url);

// Filtering by story text, and the chip counts following it.
await page.fill('#q', 'long');
await page.waitForTimeout(150);
check('search narrows the list', (await page.locator('details.story').count()) === 1);
check('chip counts follow the search', (await page.locator('.chip[data-key=all] .n').textContent()) === '1');
check('a filtered subset offers its own accept', (await page.locator('#acceptvisible button').count()) === 1);
await page.fill('#q', '');
await page.waitForTimeout(150);
check('no filtered accept when nothing is filtered', (await page.locator('#acceptvisible button').count()) === 0);

// Keyboard review.
await page.locator('body').click({ position: { x: 5, y: 300 } });
await page.keyboard.press('/');
check('slash focuses the filter', (await page.evaluate(() => document.activeElement.id)) === 'q');
await page.keyboard.press('Escape');
await page.keyboard.press('j');
check('j places a cursor', (await page.locator('.capture.current').count()) === 1);
await page.keyboard.press('j');
check('the cursor stays single', (await page.locator('.capture.current').count()) === 1);
await page.keyboard.press('3');
await page.waitForTimeout(150);
check('a number key switches comparison mode',
  (await page.locator('.capture.current .modes button[aria-pressed=true]').textContent()) === 'Swipe');
const before = await page.locator('.capture.current input[type=range]').inputValue();
await page.keyboard.press('ArrowRight');
check('an arrow drives the swipe',
  before !== (await page.locator('.capture.current input[type=range]').inputValue()));

// Neither render is stretched onto the other's box when their heights differ (DECISIONS.md
// D-020). This names the story holding the mismatched pair rather than trusting wherever the
// cursor happened to stop.
await page.locator('#story-card--default').getByRole('button', { name: 'Swipe' }).first().click();
await page.waitForTimeout(150);
const geometry = await page.locator('#story-card--default .swipe').evaluate((wrap) => {
  const [base, top] = wrap.querySelectorAll('img');
  return {
    sameScale: Math.abs(base.clientWidth - top.clientWidth) <= 1,
    keepsOwnHeight: Math.abs(top.clientHeight / top.naturalHeight - 1) < 0.01,
    wrapsTaller: wrap.clientHeight >= Math.max(base.clientHeight, top.clientHeight) - 1,
    grew: top.naturalHeight > base.naturalHeight,
  };
});
check('the fixture really does have a taller current render', geometry.grew);
check('both renders share one scale', geometry.sameScale);
check('the current render keeps its own height', geometry.keepsOwnHeight);
check('the frame takes the height of the taller render', geometry.wrapsTaller);

// A new capture is one column, not a comparison (DECISIONS.md D-021). Its result carries both
// an actual and a freshly written baseline reference, and showing the two — identical — images
// side by side read as a difference that does not exist.
const newStory = page.locator('#story-card--brand-new');
check('a new capture shows exactly one image',
  (await newStory.locator('img').count()) === 1);
check('a new capture offers no comparison modes',
  (await newStory.locator('.modes button').count()) === 0);
check('a new capture is labelled as what it is',
  (await newStory.locator('figcaption').first().textContent()).startsWith('New —'));
check('a missing baseline is not dressed up as an assertion failure',
  !(await newStory.textContent()).includes("doesn't exist"));
// The control: a capture with a real baseline keeps its comparison.
const changedStory = page.locator('#story-card--default');
check('a changed capture still shows both renders',
  (await changedStory.locator('.capture').first().locator('img').count()) === 2);
check('a changed capture still offers the comparison modes',
  (await changedStory.locator('.modes button').count()) === 4);

// Triage, and its survival across a reload.
await page.keyboard.press('r');
await page.waitForTimeout(100);
check('r ticks a capture off', (await page.locator('#progress').textContent()).startsWith('1 of'));
await page.reload();
await page.waitForTimeout(250);
check('triage survives a reload', (await page.locator('#progress').textContent()).startsWith('1 of'));

// Actual-size inspection.
await page.locator('.stage.zoom').first().click();
check('a capture opens to actual size', (await page.locator('.stage.actual').count()) >= 1);

// Noise that used to be printed on every row of a full matrix.
await page.locator('.chip[data-key=all]').click();
await page.waitForTimeout(200);
check('an unchanged capture reports no missing artifacts',
  !(await page.locator('#story-card--default').textContent()).includes('No image artifacts'));
// The control: the same note must still fire where an absence genuinely needs explaining.
check('a review capture with no images still says so',
  (await page.locator('#story-header--sticky').textContent()).includes('No image artifacts'));
check('a quantified change is not dressed up as an error',
  !(await page.locator('main').textContent()).includes('toHaveScreenshot'));
await page.close();

// A link into the report lands even when the active filter excludes its target.
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url + '#story-footer--default');
await page.waitForTimeout(250);
check('a deep link widens the filter to reach its story',
  (await page.locator('#story-footer--default').count()) === 1);
check('a deep link opens the story it names',
  (await page.locator('#story-footer--default').getAttribute('open')) !== null);
await page.close();

await browser.close();
await rm(work, { recursive: true, force: true });

for (const crash of crashes) check('no script error: ' + crash, false);

const failed = results.filter((r) => !r.pass);
for (const r of results) if (!r.pass) console.error('  ✗ ' + r.name);
if (failed.length) {
  console.error(`› report-check: ${failed.length} of ${results.length} checks failed.`);
  process.exit(1);
}
console.log(`› report-check: ${results.length} checks passed.`);
