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

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// The one diff that has to read as a diff: a comparator's vocabulary is pure red for a real
// change on a greyed-out backdrop, and Chromium renders solid integer-positioned blocks as
// exact pixels — so the geometry below survives into the PNG the assertions run against.
// The image is tall and wide on purpose: at fit-to-width it still scrolls inside its stage,
// at actual size it scrolls both ways, which is what the region jumps have to work through.
const regionBlocks = [
  { x: 400, y: 400, width: 160, height: 100, pixels: 16000 },
  { x: 1200, y: 780, width: 60, height: 40, pixels: 2400 },
];
const regionDiff = `<!doctype html><meta charset=utf-8><style>body{margin:0}
#d{position:relative;width:1600px;height:1200px;background:#808080}
#d div{position:absolute;background:#f00}</style>
<div id=d><div style="left:400px;top:400px;width:160px;height:100px"></div>
<div style="left:1200px;top:780px;width:60px;height:40px"></div></div>`;
await shot('e-base.png', fixture('Region card', 'A story whose change has a place, not just a size.', 18, ''), 1600);
await shot('e-act.png', fixture('Region card', 'A story whose change has a place, not just a size.', 30, ''), 1600);
await shot('d-diff.png', regionDiff, 1600);

const capture = (o) => ({
  storyTitle: o.t, storyName: o.n, storyId: o.id, width: o.w, status: o.s,
  snapshotPath: `${o.id}-${o.w}.png`, artifacts: o.a || {},
  ...(o.mode ? { mode: o.mode } : {}),
  ...(o.state ? { state: o.state } : {}),
  ...(o.ax ? { accessibility: o.ax } : {}),
  ...(o.px != null ? { diffPixels: o.px, diffRatio: o.r } : {}),
  ...(o.regions ? { regions: o.regions } : {}),
  ...(o.dropped != null ? { regionsDropped: o.dropped } : {}),
  ...(o.size ? { size: o.size } : {}),
  ...(o.err ? { error: o.err } : {}),
  ...(o.unstable ? { unstable: true, unstableStatus: o.us, unstableDiffPixels: o.upx } : {}),
});

const captures = [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 12840, r: 0.0412,
    a: { expected: 'shots/a-base.png', actual: 'shots/a-act.png', diff: 'shots/a-diff.png' } }),
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 320, s: 'unchanged' }),
  // Ratios deliberately disagree with the pixel counts here: by ratio card--long is the
  // bigger change, by pixels card--default is — the disagreement the one-measure meter is
  // checked against.
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'changed', px: 8000, r: 0.06,
    a: { expected: 'shots/b-base.png', actual: 'shots/b-act.png', diff: 'shots/b-diff.png' } }),
  // A change this small is the one Playwright's two-decimal ratio reports as "0.00%" — the
  // case the pixel-exact share exists for. The fixture's ratio is that rounded-away value.
  capture({ t: 'Card', n: 'Sliver', id: 'card--sliver', w: 380, s: 'changed', px: 8, r: 0.00004,
    a: { expected: 'shots/b-base.png', actual: 'shots/b-act.png', diff: 'shots/b-diff.png' } }),
  capture({ t: 'Card', n: 'Brand new', id: 'card--brand-new', w: 480, s: 'new',
    // Both references, as a real fresh result carries them: the "expected" is the baseline
    // the comparator just wrote from this render — the same bytes as the actual.
    a: { expected: 'shots/c-act.png', actual: 'shots/c-act.png' } }),
  capture({ t: 'Header', n: 'Sticky', id: 'header--sticky', w: 1280, s: 'render-failed',
    err: 'StoryRenderError: the story never left its loading state' }),
  capture({ t: 'Footer', n: 'Default', id: 'footer--default', w: 1280, s: 'unchanged' }),
  // The regions are the two blocks d-diff.png paints, as the reporter would record them;
  // the dropped count is synthetic, to exercise the "+M" the bar adds.
  capture({ t: 'Region', n: 'Blocks', id: 'region--blocks', w: 1600, s: 'changed', px: 4600, r: 0.0024,
    a: { expected: 'shots/e-base.png', actual: 'shots/e-act.png', diff: 'shots/d-diff.png' },
    regions: regionBlocks, dropped: 3, size: { width: 1600, height: 1200 } }),
  // The flake guard: this capture differed on one load of its story and matched on the next,
  // so it passed — no images, no review, no contact-sheet tile — but visible under its own
  // filter, with a badge and a row that say what the run saw.
  capture({ t: 'Widget', n: 'Flicker', id: 'widget--flicker', w: 380, s: 'unchanged',
    unstable: true, us: 'changed', upx: 1234 }),
];

const summary = {
  diopsis: 1, createdAt: '2026-01-01T00:00:00.000Z', platform: 'linux', arch: 'x64',
  mode: 'run', snapshotDir: '__screenshots__',
  totals: { stories: 7, captures: captures.length, unchanged: 3, unstable: 1, changed: 4,
    new: 1, renderFailed: 1, failed: 0 },
  changedStories: ['card--brand-new', 'card--default', 'card--long', 'card--sliver',
    'header--sticky', 'region--blocks'],
  captures,
};

await writeFile(path.join(work, 'report.html'), await renderReport(summary, work));
const url = 'file://' + path.join(work, 'report.html');

let page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const crashes = [];
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto(url);

// Filtering by story text, and the chip counts following it. The image tagged here has to be
// the very same element after two filter changes — hiding rows must not rebuild them.
await page.locator('#story-card--default img').first().evaluate((i) => { i.taggedByCheck = true; });
await page.fill('#q', 'long');
await page.waitForFunction(() => flat.length === 1 && flat[0].capture.storyId === 'card--long');
check('search narrows the list', (await page.locator('details.story:visible').count()) === 1);
check('chip counts follow the search', (await page.locator('.chip[data-key=all] .n').textContent()) === '1');
check('a filtered subset offers its own accept', (await page.locator('#acceptvisible button').count()) === 1);
// The command the filtered accept copies is one line naming every visible story: `accept`
// takes any number of ids, so one call adopts exactly what is on screen. The clipboard is
// stubbed and the argument captured, because a file:// page has no clipboard permission to
// grant.
await page.evaluate(() => {
  window.__copied = null;
  navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
});
await page.locator('#acceptvisible button').click();
check('the filtered accept is one command on one line',
  (await page.evaluate(() => window.__copied)) === 'npx diopsis accept card--long');
await page.fill('#q', '');
await page.waitForFunction(() => flat.length === 6);
check('no filtered accept when nothing is filtered', (await page.locator('#acceptvisible button').count()) === 0);
check('no reviewed-accept button before any tick',
  (await page.locator('#acceptreviewed button').count()) === 0);
check('a filter round trip keeps the drawn image',
  await page.locator('#story-card--default img').first().evaluate((i) => i.taggedByCheck === true));

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
await page.waitForFunction(() =>
  document.querySelector('.capture.current .modes button[aria-pressed=true]')?.textContent === 'Swipe');
check('a number key switches comparison mode',
  (await page.locator('.capture.current .modes button[aria-pressed=true]').textContent()) === 'Swipe');
check('the swipe control is named for assistive tech',
  (await page.locator('.capture.current input[type=range]').getAttribute('aria-label')) !== null);
const before = await page.locator('.capture.current input[type=range]').inputValue();
await page.keyboard.press('ArrowRight');
check('an arrow drives the swipe',
  before !== (await page.locator('.capture.current input[type=range]').inputValue()));

// Neither render is stretched onto the other's box when their heights differ (DECISIONS.md
// D-020). This names the story holding the mismatched pair rather than trusting wherever the
// cursor happened to stop.
await page.locator('#story-card--default').getByRole('button', { name: 'Swipe' }).first().click();
await page.waitForFunction(() => {
  const wrap = document.querySelector('#story-card--default .swipe');
  if (!wrap) return false;
  const imgs = wrap.querySelectorAll('img');
  return imgs.length === 2 && [...imgs].every((i) => i.complete && i.naturalWidth > 0);
});
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

// One measure everywhere. The story list ranks card--default above card--long by differing
// pixels, so the meters must agree with that order — with the fixture's ratios they would
// not, which is exactly what is being asserted against.
const meterOf = (id) => page.locator('#story-' + id + ' .meter').first();
const meterShare = (id) => meterOf(id).locator('i').evaluate((fill) => parseInt(fill.style.width, 10));
check('the meter ranks by differing pixels, like the list',
  (await meterShare('card--default')) > (await meterShare('card--long')));
check('the meter says what it measures',
  (await meterOf('card--default').getAttribute('title')) === "Share of this run's largest pixel difference");

// A change Playwright's two-decimal ratio would report as 0.00%: the actual image's size is
// known, so the share is computed from pixels and stays non-zero.
const sliverBar = await page.locator('#story-card--sliver .w').textContent();
check('a sub-hundredth change keeps a non-zero share',
  sliverBar.includes('%') && !sliverBar.includes('0.00%'));

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

// One comparison mode for every capture at once, with each capture still free to differ.
// Hidden captures keep their controls in the page, so counting pressed buttons looks at the
// visible rows only.
const pressed = (scope) => page.locator(scope + ' .capture:not([hidden]) .modes button[aria-pressed=true]').allTextContents();
// A page-wide step is done when the pressed buttons say so — a count and a label, never a
// clock — so each wait states the very condition the check after it asserts.
const settledOn = (scope, mode, count) => page.waitForFunction(
  (want) => {
    const bs = document.querySelectorAll(want.scope + ' .capture:not([hidden]) .modes button[aria-pressed=true]');
    return bs.length === want.count && [...bs].every((b) => b.textContent === want.mode);
  }, { scope, mode, count });
check('the page-wide mode control is offered', await page.locator('#viewall').isVisible());
await page.evaluate(() => document.activeElement.blur());
await page.keyboard.press('Shift+Digit2');
await settledOn('main', 'Side by side', 4);
check('shift and a number set every capture',
  (await pressed('main')).every((m) => m === 'Side by side') && (await pressed('main')).length === 4);
check('the page-wide control shows the choice',
  (await page.locator('#viewall button[aria-pressed=true]').textContent()) === 'Side by side');
check('a capture that cannot compare keeps its one image',
  (await newStory.locator('img').count()) === 1);
await page.locator('#story-card--long').getByRole('button', { name: 'Onion-skin' }).click();
await settledOn('#story-card--long', 'Onion-skin', 1);
check('a capture can still differ from the page-wide choice',
  (await pressed('#story-card--long')).join() === 'Onion-skin' &&
  (await pressed('#story-card--default')).join() === 'Side by side');
await page.locator('#viewall').getByRole('button', { name: 'Swipe' }).click();
await settledOn('main', 'Swipe', 4);
check('a page-wide choice overrides every capture again',
  (await pressed('main')).every((m) => m === 'Swipe'));
// Captures shown again after the choice — a filter change now only hides rows, their drawn
// state survives — still carry it.
await page.locator('.chip[data-key=changed]').click();
await settledOn('main', 'Swipe', 4);
check('a capture shown again keeps the page-wide mode',
  (await pressed('main')).length === 4 && (await pressed('main')).every((m) => m === 'Swipe'));

// Triage, and its survival across a reload. The cursor is placed on one named capture
// through its tile, so what follows holds whatever the steps above left showing or filtered.
await page.locator('.tile[data-key="card--default@640"]').click();
await page.keyboard.press('r');
await page.waitForFunction(() => document.getElementById('progress').textContent.startsWith('1 of'));
check('r ticks a capture off', (await page.locator('#progress').textContent()).startsWith('1 of'));
await page.reload();
// The rebuilt page has to read its ticks back before it can claim they survived it.
await page.waitForFunction(() => document.getElementById('progress').textContent.startsWith('1 of'));
check('triage survives a reload', (await page.locator('#progress').textContent()).startsWith('1 of'));

// The bridge from ticks to a command: what was reviewed becomes one accept call, holding
// only the stories accept would act on. card--default's other capture is unchanged — not
// adoptable — so a fully-reviewed-as-far-as-accept-goes story carries no warning.
check('a tick brings up the reviewed-accept button',
  (await page.locator('#acceptreviewed button').textContent()) === 'Copy accept for 1 reviewed story');
check('a story with no adoptable capture unticked carries no warning',
  (await page.locator('#acceptreviewed button').getAttribute('title')) === null);
// The reload took the page's window state with it; the stub is installed again for this click.
await page.evaluate(() => {
  window.__copied = null;
  navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
});
await page.locator('#acceptreviewed button').click();
check('the reviewed accept copies one command',
  (await page.evaluate(() => window.__copied)) === 'npx diopsis accept card--default');
// A render-failure is reviewable but not adoptable: its tick counts as reviewed progress
// and still joins no command.
await page.locator('#story-header--sticky .mark').click();
await page.waitForFunction(() =>
  document.querySelector('#acceptreviewed button')?.textContent === 'Copy accept for 1 reviewed story');
check('a ticked render-failure joins no accept command',
  (await page.locator('#acceptreviewed button').textContent()) === 'Copy accept for 1 reviewed story');
await page.locator('#story-card--long .mark').click();
await page.waitForFunction(() =>
  document.querySelector('#acceptreviewed button')?.textContent === 'Copy accept for 2 reviewed stories');
check('ticks across stories collect into one label',
  (await page.locator('#acceptreviewed button').textContent()) === 'Copy accept for 2 reviewed stories');
await page.locator('#acceptreviewed button').click();
check('the one command lists the ticked stories, sorted',
  (await page.evaluate(() => window.__copied)) === 'npx diopsis accept card--default card--long');

// Actual-size inspection.
await page.locator('.stage.zoom').first().click();
check('a capture opens to actual size', (await page.locator('.stage.actual').count()) >= 1);

// Side by side moves as one: scrolling or zooming either pane applies to both, so the same
// pixel stays under the eye in each. The region story's renders are wider than their panes,
// which is what gives the scroll something to carry.
await page.locator('#story-region--blocks').getByRole('button', { name: 'Side by side' }).click();
await page.waitForFunction(() =>
  document.querySelectorAll('#story-region--blocks .pair .stage').length === 2);
const panes = page.locator('#story-region--blocks .pair .stage');
check('side by side is two panes', (await panes.count()) === 2);
await panes.nth(0).click();
await page.waitForFunction(() =>
  document.querySelectorAll('#story-region--blocks .pair .stage.actual').length === 2);
check('clicking either pane toggles actual size for both',
  (await page.locator('#story-region--blocks .pair .stage.actual').count()) === 2);
await panes.nth(0).evaluate((s) => { s.scrollLeft = 400; });
await page.waitForFunction(() =>
  [...document.querySelectorAll('#story-region--blocks .pair .stage')].every((s) => s.scrollLeft === 400));
check('scrolling one pane carries the other to the same offset',
  (await panes.evaluateAll((els) => els.map((s) => s.scrollLeft).join('|'))) === '400|400');
await panes.nth(1).evaluate((s) => { s.scrollLeft = 200; });
await page.waitForFunction(() =>
  [...document.querySelectorAll('#story-region--blocks .pair .stage')].every((s) => s.scrollLeft === 200));
check('the scroll sync runs from either pane',
  (await panes.evaluateAll((els) => els.map((s) => s.scrollLeft).join('|'))) === '200|200');
await panes.nth(1).click();
await page.waitForFunction(() =>
  document.querySelectorAll('#story-region--blocks .pair .stage.actual').length === 0);
check('clicking the other pane stands both down from actual size',
  (await page.locator('#story-region--blocks .pair .stage.actual').count()) === 0);

// Accessibility: images name what they show, the slider says what it drives, review progress
// announces itself, nothing interactive hides inside a summary, and the vertical arrows keep
// scrolling the page.
check('every image says what it shows',
  await page.evaluate(() => [...document.querySelectorAll('img')]
    .every((i) => i.hasAttribute('alt') && i.alt.trim() !== '')));
check('review progress announces itself',
  (await page.locator('#progress').getAttribute('aria-live')) === 'polite');
check('no interactive control sits inside a summary',
  (await page.locator('.story > summary button').count()) === 0);
check('ArrowDown is left to scroll the page',
  await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  }) === false);

// The contact sheet above the list — the overview D-020 deferred. One tile per capture
// needing review, in the list's own order and under the same filter and search.
check('a tile per capture needing review',
  (await page.locator('.tile:not([hidden])').count()) === 6);
check('the overview header counts its tiles',
  (await page.locator('#ov-toggle').textContent()) === 'Overview · 6');
check('a new capture tiles as its one render',
  (await page.locator('.tile[data-key="card--brand-new@480"] img').count()) === 1);
check('a tile reuses the embedded image, not a second copy',
  (await page.locator('.tile[data-key="card--brand-new@480"] img').getAttribute('src')) ===
  (await page.locator('#story-card--brand-new img').first().getAttribute('src')));
check('a capture with no image tiles its status as text',
  (await page.locator('.tile[data-key="header--sticky@1280"] img').count()) === 0 &&
  (await page.locator('.tile[data-key="header--sticky@1280"]').textContent()).includes('Render failed'));
check('every tile image says what it shows',
  await page.evaluate(() => [...document.querySelectorAll('.tile img')]
    .every((i) => i.hasAttribute('alt') && i.alt.trim() !== '')));
check('tiles follow the list order',
  await page.evaluate(() => JSON.stringify(
    [...document.querySelectorAll('.tile:not([hidden])')].map((t) => t.dataset.key)) ===
    JSON.stringify(flat.filter((e) => REVIEW.has(e.capture.status)).map((e) => keyOf(e.capture)))));

// Clicking through: the story was closed first, so the check knows the tile is what opened it.
await page.locator('#story-card--long > summary').click();
await page.waitForFunction(() => !document.getElementById('story-card--long').open);
check('the story starts closed',
  (await page.locator('#story-card--long').getAttribute('open')) === null);
await page.locator('.tile[data-key="card--long@380"]').click();
await page.waitForFunction(() => {
  const story = document.getElementById('story-card--long');
  return story.open && flat[cursor] && flat[cursor].capture.storyId === 'card--long';
});
const landed = page.locator('.capture.current');
check('a tile opens its story',
  (await page.locator('#story-card--long').getAttribute('open')) !== null);
check('a tile lands the cursor on its capture',
  (await landed.count()) === 1 &&
  (await landed.locator('.w').textContent()).startsWith('380px') &&
  (await page.evaluate(() => flat[cursor] && flat[cursor].capture.storyId)) === 'card--long');

// Triage state reaches the sheet: dimmed on load for what was already ticked, dimmed at once
// for what gets ticked under it.
check('a reviewed capture is dimmed in the sheet',
  (await page.locator('.tile[data-key="card--default@640"]').getAttribute('class')).includes('done'));
await page.locator('#story-card--sliver .mark').click();
await page.waitForFunction(() =>
  document.querySelector('.tile[data-key="card--sliver@380"]')?.classList.contains('done'));
check('ticking in the list dims the tile at once',
  (await page.locator('.tile[data-key="card--sliver@380"]').getAttribute('class')).includes('done'));

// The sheet follows the filter and the search; with nothing left to review it steps aside.
await page.fill('#q', 'header');
await page.waitForFunction(() =>
  document.querySelectorAll('.tile:not([hidden])').length === 1 &&
  document.getElementById('ov-toggle').textContent === 'Overview · 1');
check('the search narrows the sheet with the list',
  (await page.locator('.tile:not([hidden])').count()) === 1 &&
  (await page.locator('#ov-toggle').textContent()) === 'Overview · 1');
await page.fill('#q', '');
await page.waitForFunction(() => document.querySelectorAll('.tile:not([hidden])').length === 6);
await page.locator('.chip[data-key=unchanged]').click();
await page.waitForFunction(() => document.querySelector('.overview')?.hidden === true);
check('a filter with nothing to review hides the overview',
  (await page.locator('.overview[hidden]').count()) === 1);
await page.locator('.chip[data-key=review]').click();
await page.waitForFunction(() => document.querySelectorAll('.tile:not([hidden])').length === 6);

// The flake guard. An unstable capture passed, so it is not a change and not reviewable:
// kept out of the review count and off the contact sheet, but offered under its own filter
// with a badge and a row that say what the run saw.
check('an unstable chip is offered when a run saw flake',
  (await page.locator('.chip[data-key=unstable]').count()) === 1);
check('the needs-review count leaves unstable captures out',
  (await page.locator('.chip[data-key=review] .n').textContent()) === '6');
check('the contact sheet keeps unstable captures out',
  (await page.locator('.tile[data-key="widget--flicker@380"]').count()) === 0);
await page.locator('.chip[data-key=unstable]').click();
await page.waitForFunction(() => flat.length === 1 && flat[0].capture.unstable === true);
check('the unstable filter shows the unstable capture alone',
  (await page.locator('details.story:visible').count()) === 1);
const unstableRow = await page.locator('#story-widget--flicker .capture .w').textContent();
check('the unstable capture says what happened',
  unstableRow.startsWith('380px · Differed on one load (') &&
  unstableRow.includes('px) and matched on the next.'));
check('the unstable badge is outlined and carries no status colour',
  (await page.locator('#story-widget--flicker .badge.unstable').textContent()) === 'unstable' &&
  (await page.locator('#story-widget--flicker .badge.unstable').getAttribute('class')) ===
    'badge unstable');
check('an unstable capture offers nothing to accept',
  (await page.locator('#story-widget--flicker .accept').count()) === 0 &&
  !(await page.locator('#story-widget--flicker').textContent()).includes('diopsis accept'));
await page.locator('.chip[data-key=review]').click();
await page.waitForFunction(() => flat.length === 6);

// Collapse: the key, the header toggle, and the choice outliving a reload.
await page.locator('body').click({ position: { x: 5, y: 300 } });
await page.keyboard.press('o');
check('o collapses the overview',
  (await page.locator('#ov-sheet[hidden]').count()) === 1 &&
  (await page.locator('#ov-toggle').getAttribute('aria-expanded')) === 'false');
await page.keyboard.press('o');
check('o expands the overview again',
  (await page.locator('#ov-sheet[hidden]').count()) === 0 &&
  (await page.locator('#ov-toggle').getAttribute('aria-expanded')) === 'true');
await page.locator('#ov-toggle').click();
check('the header toggle collapses the overview',
  (await page.locator('#ov-sheet[hidden]').count()) === 1);
await page.reload();
await page.waitForFunction(() => document.getElementById('ov-sheet')?.hidden === true);
check('the collapsed choice survives a reload',
  (await page.locator('#ov-sheet[hidden]').count()) === 1);
await page.keyboard.press('o');
check('the overview opens again after the reload',
  (await page.locator('#ov-sheet[hidden]').count()) === 0);

// Noise that used to be printed on every row of a full matrix.
await page.locator('.chip[data-key=all]').click();
await page.waitForFunction(() => document.querySelectorAll('details.story:not([hidden])').length === 8);
check('an unchanged capture reports no missing artifacts',
  !(await page.locator('#story-card--default').textContent()).includes('No image artifacts'));
// The control: the same note must still fire where an absence genuinely needs explaining.
check('a review capture with no images still says so',
  (await page.locator('#story-header--sticky').textContent()).includes('No image artifacts'));
check('a quantified change is not dressed up as an error',
  !(await page.locator('main').textContent()).includes('toHaveScreenshot'));
await page.close();

// Changed regions: where a capture changed, not only how much. The boxes over the overlay,
// the n/N jumps between them, and the sheet's tile cropped to the largest region.
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => {
  const i = document.querySelector('#story-region--blocks .diffwrap img');
  return i && i.complete && i.naturalWidth > 0;
});

const regionBar = await page.locator('#story-region--blocks .capture .bar').first().textContent();
check('the bar counts the regions, with the dropped ones summed',
  regionBar.includes('2 regions') && regionBar.includes('+3'));
check('the overlay outlines every region',
  (await page.locator('#story-region--blocks .stage .region').count()) === 2);

// A box's placing is checked against the region it stands for, as shares of the image's
// natural size — the same arithmetic at every scale, which is the point of the percentages.
const boxGeometry = () => page.locator('#story-region--blocks .diffwrap').evaluate((wrap) => {
  const img = wrap.querySelector('img');
  const ir = img.getBoundingClientRect();
  const boxes = [...wrap.querySelectorAll('.region')].map((b) => {
    const r = b.getBoundingClientRect();
    return {
      x: (r.x - ir.x) / ir.width, y: (r.y - ir.y) / ir.height,
      width: r.width / ir.width, height: r.height / ir.height,
    };
  });
  return { boxes, natural: { width: img.naturalWidth, height: img.naturalHeight } };
});
const onTheRegion = (geo) => geo.boxes.length === regionBlocks.length &&
  geo.boxes.every((b, i) => {
    const r = regionBlocks[i];
    return Math.abs(b.x - r.x / 1600) < 0.01 && Math.abs(b.y - r.y / 1200) < 0.01 &&
      Math.abs(b.width - r.width / 1600) < 0.01 && Math.abs(b.height - r.height / 1200) < 0.01;
  });
const geoFit = await boxGeometry();
check('the fixture image really is the size the data claims',
  geoFit.natural.width === 1600 && geoFit.natural.height === 1200);
check('each box sits on its region at fit-to-width', onTheRegion(geoFit));

// The jumps. The capture is left in Side by side first, so n has to switch it back.
const flashState = () => page.locator('#story-region--blocks').evaluate((story) => {
  const stage = story.querySelector('.capture.current .stage');
  const box = story.querySelector('.region.flash');
  if (!stage || !box) return { at: -1, visible: false };
  const sr = stage.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  return {
    at: Number(box.dataset.i),
    visible: br.left >= sr.left - 2 && br.right <= sr.right + 2 &&
      br.top >= sr.top - 2 && br.bottom <= sr.bottom + 2,
  };
});
const flashAt = (i) => page.waitForFunction((want) => {
  const b = document.querySelector('#story-region--blocks .region.flash');
  return b && b.dataset.i === String(want);
}, i);
await page.locator('.tile[data-key="region--blocks@1600"]').click();
await page.locator('body').click({ position: { x: 5, y: 300 } });
await page.keyboard.press('2');
await page.waitForFunction(() =>
  document.querySelector('#story-region--blocks .capture.current .modes button[aria-pressed=true]')
    ?.textContent === 'Side by side');
check('the boxes belong to the overlay, not the capture',
  (await page.locator('#story-region--blocks .stage .region').count()) === 0 &&
  (await page.locator('#story-region--blocks .capture.current .modes button[aria-pressed=true]')
    .textContent()) === 'Side by side');
await page.keyboard.press('n');
await flashAt(0);
const firstJump = await flashState();
check('n switches the capture to the overlay and centres the first region',
  firstJump.at === 0 && firstJump.visible);
await page.keyboard.press('n');
await flashAt(1);
check('n again reaches the next region',
  (await flashState()).at === 1 && (await flashState()).visible);
await page.keyboard.press('N');
await flashAt(0);
check('N goes back to the previous region', (await flashState()).at === 0);
// The emphasis is on a timer of its own: the wait ends when the box has handed itself back.
await page.waitForFunction(() => !document.querySelector('#story-region--blocks .region.flash'));
check('the emphasis hands the box back after a moment',
  (await page.locator('#story-region--blocks .region.flash').count()) === 0);

// The same jumps with the stage at actual size: the boxes are placed in percentages, so
// they must stay on their pixels when the image stops being scaled down.
await page.locator('#story-region--blocks .capture.current .stage').click({ position: { x: 30, y: 30 } });
check('the stage shows actual pixels',
  (await page.locator('#story-region--blocks .stage.actual').count()) === 1);
await page.keyboard.press('n');
await flashAt(1);
const actualJump = await flashState();
check('the jump works at actual size too', actualJump.at === 1 && actualJump.visible);
check('each box still sits on its region at actual size', onTheRegion(await boxGeometry()));
await page.close();

// The sheet's crop: a changed capture with regions shows its largest region, not the top
// of the whole image — by width-scaled CSS, so no second image is embedded.
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url);
await page.waitForFunction(() => [...document.querySelectorAll('.tile img')]
  .every((i) => i.complete && i.naturalWidth > 0));
const cropped = await page.locator('.tile[data-key="region--blocks@1600"] .thumb').evaluate((t) => {
  const img = t.querySelector('img');
  return { tile: t.clientWidth, img: img.clientWidth };
});
check('a tile with regions crops to the largest one, scaled past the tile',
  cropped.tile > 0 && cropped.img > cropped.tile * 3);
check('a tile without regions keeps the whole-image view',
  await page.locator('.tile[data-key="card--long@380"] .thumb').evaluate(
    (t) => t.querySelector('img').clientWidth === t.clientWidth));
await page.close();

// A diff that cannot be decoded — the reporter records no regions for such a capture, and
// the report has to render anyway: the boxes are an aid, never a load-bearing feature.
await writeFile(path.join(work, 'not-a-png.txt'), 'this file is not a PNG, whatever its name says');
const brokenCapture = capture({ t: 'Broken', n: 'Undecodable', id: 'broken--undecodable', w: 380,
  s: 'changed', px: 512, r: 0.002,
  a: { expected: 'shots/b-base.png', actual: 'shots/b-act.png', diff: 'shots/not-a-png.txt' } });
const brokenSummary = {
  ...summary,
  captures: [captures[0], brokenCapture],
  totals: { ...summary.totals, stories: 2, captures: 2, unchanged: 0, changed: 2, new: 0, renderFailed: 0 },
  changedStories: ['broken--undecodable', 'card--default'],
};
await writeFile(path.join(work, 'broken.html'), await renderReport(brokenSummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'broken.html'));
await page.waitForFunction(() =>
  (document.getElementById('meta')?.textContent ?? '').includes('captures across'));
check('a run with an undecodable diff still renders the report',
  (await page.locator('#meta').textContent()).includes('captures across'));
check('an undecodable diff reports no regions',
  !(await page.locator('#story-broken--undecodable').textContent()).includes('region'));
check('no boxes are drawn for it',
  (await page.locator('#story-broken--undecodable .region').count()) === 0);
await page.close();

// A link into the report lands even when the active filter excludes its target.
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url + '#story-footer--default');
await page.waitForFunction(() => document.getElementById('story-footer--default') &&
  !document.getElementById('story-footer--default').hidden);
check('a deep link widens the filter to reach its story',
  (await page.locator('#story-footer--default:visible').count()) === 1);
check('a deep link opens the story it names',
  (await page.locator('#story-footer--default').getAttribute('open')) !== null);
await page.close();

// A run with little to review opens with the sheet collapsed: the expanded default is for
// runs large enough to need taking in at a glance.
const fewSummary = {
  ...summary,
  captures: [captures[0], captures[4]],
  totals: { ...summary.totals, stories: 2, captures: 2, unchanged: 0, changed: 1, new: 1,
    renderFailed: 0 },
  changedStories: ['card--brand-new', 'card--default'],
};
await writeFile(path.join(work, 'few.html'), await renderReport(fewSummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('file://' + path.join(work, 'few.html'));
await page.waitForFunction(() => document.getElementById('ov-sheet')?.hidden === true);
check('a small run starts with the overview collapsed',
  (await page.locator('#ov-sheet[hidden]').count()) === 1);
check('the collapsed header still counts its tiles',
  (await page.locator('#ov-toggle').textContent()) === 'Overview · 2');
await page.close();

// Modes: a run under named sets of globals. The mode rides every surface that names a
// capture — the bar, the tiles — and chips beside the status ones filter by it, composing
// with the status filter and the search.
const modeCaptures = [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 12840, r: 0.0412,
    a: { expected: 'shots/a-base.png', actual: 'shots/a-act.png', diff: 'shots/a-diff.png' } }),
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 8000, r: 0.03,
    mode: 'dark',
    a: { expected: 'shots/b-base.png', actual: 'shots/b-act.png', diff: 'shots/b-diff.png' } }),
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'unchanged' }),
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'new', mode: 'rtl',
    a: { expected: 'shots/c-act.png', actual: 'shots/c-act.png' } }),
  capture({ t: 'Header', n: 'Sticky', id: 'header--sticky', w: 1280, s: 'render-failed', mode: 'dark',
    err: 'StoryRenderError: the story never left its loading state' }),
];
const modesSummary = {
  ...summary,
  captures: modeCaptures,
  totals: { ...summary.totals, stories: 3, captures: 5, unchanged: 1, changed: 2, new: 1,
    renderFailed: 1, failed: 0 },
  changedStories: ['card--default', 'card--long', 'header--sticky'],
};
await writeFile(path.join(work, 'modes.html'), await renderReport(modesSummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'modes.html'));
await page.waitForFunction(() => document.querySelectorAll('#modefilters .chip').length === 4);

// The run opens on "Needs review", so the counts on the mode chips are of what a click
// would show from here — composed with the status filter, like the status chips' own
// counts compose with the search.
check('a run with modes offers the mode chips beside the status chips',
  (await page.locator('#modefilters .chip').allTextContents()).join('|') === 'All modes4|Base1|dark2|rtl1');
check('the bar shows the mode after the width',
  (await page.locator('#story-card--default .capture').nth(1).locator('.w').textContent())
    .startsWith('640px [dark]'));
check('a base bar carries no mode bracket',
  !(await page.locator('#story-card--default .capture').first().locator('.w').textContent())
    .includes('['));
check('a tile names the mode after the width',
  (await page.locator('.tile[data-key="card--default@640[dark]"] .tile-dims').textContent())
    .startsWith('640px [dark]'));

await page.locator('.chip[data-key=all]').click();
await page.waitForFunction(() => flat.length === 5);
await page.locator('.chip[data-key="mode:base"]').click();
await page.waitForFunction(() =>
  flat.map((e) => keyOf(e.capture)).join() === 'card--default@640,card--long@380');
check('Base narrows the list to the base captures',
  (await page.evaluate(() => flat.map((e) => keyOf(e.capture)).join())) ===
  'card--default@640,card--long@380');
await page.locator('.chip[data-key=changed]').click();
await page.waitForFunction(() => flat.length === 1 && !flat[0].capture.mode);
check('the mode filter composes with the status filter',
  (await page.evaluate(() => flat.length)) === 1 &&
  (await page.evaluate(() => !flat[0].capture.mode)) === true);
check('the mode chip counts reflect the status filter',
  (await page.locator('.chip[data-key="mode:dark"] .n').textContent()) === '1');
await page.locator('.chip[data-key="mode:dark"]').click();
await page.fill('#q', 'long');
await page.waitForFunction(() => flat.length === 0);
check('the mode filter composes with the search',
  (await page.evaluate(() => flat.length)) === 0);
await page.fill('#q', '');
await page.locator('.chip[data-key=all]').click();
await page.waitForFunction(() =>
  flat.map((e) => keyOf(e.capture)).join() === 'card--default@640[dark],header--sticky@1280[dark]');
check('a mode chip narrows to that mode’s captures',
  (await page.evaluate(() => flat.map((e) => keyOf(e.capture)).join())) ===
  'card--default@640[dark],header--sticky@1280[dark]');

// A mode capture shares its story and width with the base capture; ticking one off must
// not tick off its twin. The status filter is widened again first, so the row is there.
await page.locator('.chip[data-key=all]').click();
await page.locator('.chip[data-key="mode:all"]').click();
await page.waitForFunction(() => flat.length === 5);
await page.locator('#story-card--default .capture').nth(0).locator('.mark').click();
await page.waitForFunction(() =>
  document.querySelector('.tile[data-key="card--default@640"]').classList.contains('done') &&
  !document.querySelector('.tile[data-key="card--default@640[dark]"]').classList.contains('done'));
check('ticking the base capture leaves its mode twin unticked',
  (await page.locator('.tile[data-key="card--default@640"]').getAttribute('class')).includes('done') &&
  !(await page.locator('.tile[data-key="card--default@640[dark]"]').getAttribute('class')).includes('done'));
// A partly ticked story is the trap the reviewed-accept button exists to catch: the command
// adopts the story, and with it every changed capture of it — the unticked dark twin too.
check('a partly ticked story warns in the button label',
  (await page.locator('#acceptreviewed button').textContent()) ===
    'Copy accept for 1 reviewed story (1 includes unticked captures)');
check('the warning title says what accepting a story does',
  (await page.locator('#acceptreviewed button').getAttribute('title')) ===
    'accepting a story adopts all of its changed captures');
await page.locator('#story-card--default .capture').nth(1).locator('.mark').click();
await page.waitForFunction(() =>
  document.querySelector('#acceptreviewed button')?.textContent === 'Copy accept for 1 reviewed story' &&
  !document.querySelector('#acceptreviewed button').title);
check('ticking the rest of the story clears the warning',
  (await page.locator('#acceptreviewed button').textContent()) === 'Copy accept for 1 reviewed story' &&
  (await page.locator('#acceptreviewed button').getAttribute('title')) === null);
await page.evaluate(() => {
  window.__copied = null;
  navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
});
await page.locator('#acceptreviewed button').click();
check('two ticks on one story copy one id, not two',
  (await page.evaluate(() => window.__copied)) === 'npx diopsis accept card--default');
await page.close();

// Interaction states: a capture taken with an element hovered, focused or pressed. The
// state rides the bar and the tiles like a mode, and its chips compose with every other
// filter beside the mode ones — a mode and a state can sit on the same capture, so this
// run carries both chip groups at once.
const stateCaptures = [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 12840, r: 0.0412,
    a: { expected: 'shots/a-base.png', actual: 'shots/a-act.png', diff: 'shots/a-diff.png' } }),
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 8000, r: 0.03,
    mode: 'dark', state: 'hover',
    a: { expected: 'shots/b-base.png', actual: 'shots/b-act.png', diff: 'shots/b-diff.png' } }),
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'unchanged' }),
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'new', state: 'focus',
    a: { expected: 'shots/c-act.png', actual: 'shots/c-act.png' } }),
  capture({ t: 'Header', n: 'Sticky', id: 'header--sticky', w: 1280, s: 'render-failed', mode: 'dark',
    err: 'StoryRenderError: the story never left its loading state' }),
];
const statesSummary = {
  ...summary,
  captures: stateCaptures,
  totals: { ...summary.totals, stories: 3, captures: 5, unchanged: 1, changed: 2, new: 1,
    renderFailed: 1, failed: 0 },
  changedStories: ['card--default', 'card--long', 'header--sticky'],
};
await writeFile(path.join(work, 'states.html'), await renderReport(statesSummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'states.html'));
await page.waitForFunction(() => document.querySelectorAll('#modefilters .chip').length === 7);

// The run opens on "Needs review", which hides the unchanged plain capture, so every chip
// count below is of what a click would show from there.
check('a run with states offers the state chips beside the mode chips',
  (await page.locator('#modefilters .chip').allTextContents()).join('|') ===
  'All modes4|Base2|dark2|All states4|Plain2|hover1|focus1');
check('the bar shows the state in braces after the mode',
  (await page.locator('#story-card--default .capture').nth(1).locator('.w').textContent())
    .startsWith('640px [dark] {hover}'));
check('a plain bar carries no state brace',
  !(await page.locator('#story-card--default .capture').first().locator('.w').textContent())
    .includes('{'));
check('a tile names the mode and the state after the width',
  (await page.locator('.tile[data-key="card--default@640[dark]{hover}"] .tile-dims').textContent())
    .startsWith('640px [dark] {hover}'));

await page.locator('.chip[data-key=all]').click();
await page.waitForFunction(() => flat.length === 5);
await page.locator('.chip[data-key="state:plain"]').click();
await page.waitForFunction(() =>
  flat.map((e) => keyOf(e.capture)).join() ===
  'card--default@640,card--long@380,header--sticky@1280[dark]');
check('Plain narrows the list to the captures no state asked for',
  (await page.evaluate(() => flat.map((e) => keyOf(e.capture)).join())) ===
  'card--default@640,card--long@380,header--sticky@1280[dark]');
await page.locator('.chip[data-key=changed]').click();
await page.waitForFunction(() => flat.length === 1 && !flat[0].capture.state);
check('the state filter composes with the status filter',
  (await page.evaluate(() => flat.length)) === 1 &&
  (await page.evaluate(() => !flat[0].capture.state)) === true);
check('the state chip counts reflect the status filter',
  (await page.locator('.chip[data-key="state:hover"] .n').textContent()) === '1');
// The only dark change is a hover capture, so dark counts nothing under Plain — the mode
// counts carry the state filter exactly as the state counts carry the status one.
check('the mode chip counts reflect the state filter',
  (await page.locator('.chip[data-key="mode:dark"] .n').textContent()) === '0');
// A run with captures, every one hidden by the chips: the empty line names the filters as
// the reason — never "every capture matched its baseline".
await page.locator('.chip[data-key="mode:dark"]').click();
await page.waitForFunction(() => flat.length === 0 && !document.querySelector('.empty').hidden);
check('filters that hide every capture say the filters did it',
  (await page.locator('.empty').textContent()) === 'No captures match the current filters.');
await page.locator('.chip[data-key="mode:all"]').click();
await page.waitForFunction(() => flat.length === 1);

await page.locator('.chip[data-key=all]').click();
await page.locator('.chip[data-key="state:all"]').click();
await page.locator('.chip[data-key="mode:dark"]').click();
await page.waitForFunction(() =>
  flat.map((e) => keyOf(e.capture)).join() ===
  'card--default@640[dark]{hover},header--sticky@1280[dark]');
check('the mode filter composes with the state filter',
  (await page.evaluate(() => flat.map((e) => keyOf(e.capture)).join())) ===
  'card--default@640[dark]{hover},header--sticky@1280[dark]');

// A state capture shares its story and width with the plain capture; ticking one off must
// not tick off its twin, so the key names the state too.
await page.locator('.chip[data-key="mode:all"]').click();
await page.waitForFunction(() => flat.length === 5);
await page.locator('#story-card--default .capture').nth(0).locator('.mark').click();
await page.waitForFunction(() =>
  document.querySelector('.tile[data-key="card--default@640"]').classList.contains('done') &&
  !document.querySelector('.tile[data-key="card--default@640[dark]{hover}"]').classList.contains('done'));
check('ticking the plain capture leaves its state twin unticked',
  (await page.locator('.tile[data-key="card--default@640"]').getAttribute('class')).includes('done') &&
  !(await page.locator('.tile[data-key="card--default@640[dark]{hover}"]').getAttribute('class'))
    .includes('done'));
await page.close();

// Accessibility findings beside the pixels. A chip — offered only when a run has findings —
// filters to the audited captures that carry them, and the capture lists each rule with
// its impact as text, its help as a link, and every element it failed on, the new ones
// marked. No colour anywhere in it: colour still means status alone (D-020).
const a11yFindings = (rules) => {
  let fresh = 0;
  const violations = Object.entries(rules).map(([id, targets]) => {
    fresh += targets.filter((t) => t.new).length;
    return {
      id,
      impact: id === 'image-alt' ? 'serious' : 'critical',
      help: id === 'image-alt' ? 'Images must have alternate text' : 'Buttons must have discernible text',
      // The summary may be a downloaded artifact: a script address must never become a link.
      helpUrl: id === 'image-alt' ? 'https://example.com/rules/' + id : 'javascript:void 0',
      targets,
    };
  });
  return { violations, new: fresh };
};
const a11yCaptures = [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'unchanged',
    ax: a11yFindings({
      'image-alt': [{ target: 'img.hero' }, { target: 'img.logo', new: true }],
      'button-name': [{ target: 'button.save', new: true }],
    }) }),
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 320, s: 'unchanged' }),
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'unchanged', mode: 'dark',
    // Audited and clean: present in the data, invisible in the report.
    ax: { violations: [], new: 0 } }),
];
const a11ySummary = {
  ...summary,
  captures: a11yCaptures,
  totals: { ...summary.totals, stories: 2, captures: 3, unchanged: 3, changed: 0, new: 0,
    renderFailed: 0, a11yNew: 2 },
  changedStories: [],
};
await writeFile(path.join(work, 'a11y.html'), await renderReport(a11ySummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'a11y.html'));
await page.waitForFunction(() => document.querySelector('.chip[data-key=a11y]') !== null);

check('a run with findings offers the Accessibility chip',
  (await page.locator('.chip[data-key=a11y]').count()) === 1 &&
  (await page.locator('.chip[data-key=a11y]').textContent()) === 'Accessibility1');
await page.locator('.chip[data-key=a11y]').click();
await page.waitForFunction(() => flat.map((e) => keyOf(e.capture)).join() === 'card--default@640');
check('the Accessibility view shows the one audited capture with findings',
  (await page.evaluate(() => flat.map((e) => keyOf(e.capture)).join())) === 'card--default@640');
const rules = page.locator('#story-card--default .a11y .a11y-rule');
check('each rule is listed with its id and impact as text',
  (await rules.count()) === 2 &&
  (await page.locator('#story-card--default .a11y code').first().textContent()) === 'image-alt' &&
  (await page.locator('#story-card--default .a11y .impact').first().textContent()) === 'serious');
check('the help text links to the rule',
  (await page.locator('#story-card--default .a11y a').first().getAttribute('href')) ===
    'https://example.com/rules/image-alt');
check('a help address that is not a web address stays plain text',
  (await rules.nth(1).locator('a').count()) === 0 &&
  (await rules.nth(1).textContent()).includes('Buttons must have discernible text'));
check('every target is listed, and only the new ones are marked',
  (await page.locator('#story-card--default .a11y .a11y-targets li').count()) === 3 &&
  (await page.locator('#story-card--default .a11y-new').count()) === 2 &&
  (await page.locator('#story-card--default .a11y-targets li').first().locator('.a11y-new').count()) === 0);
check('a clean audit leaves nothing on the page',
  (await page.locator('#story-card--long .a11y').count()) === 0);
await page.close();

// The control: the run without findings shows no chip at all.
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#filters .chip[data-key=all]') !== null);
check('a run without findings shows no Accessibility chip',
  (await page.locator('.chip[data-key=a11y]').count()) === 0);
await page.close();

// The control: a run without modes shows no mode chips at all.
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#filters .chip[data-key=all]') !== null);
check('a run without modes shows no mode chips',
  (await page.locator('#modefilters .chip').count()) === 0);
await page.close();

// A diff report: what a branch did to the baseline set, read from git without a run. A
// removed baseline is its one last image, labelled as deleted, in the muted treatment — a
// deletion is a fact to check, not a failure.
const diffCaptures = [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 12840, r: 0.0412,
    a: { expected: 'shots/a-base.png', actual: 'shots/a-act.png', diff: 'shots/a-diff.png' } }),
  capture({ t: 'Card', n: 'Gone', id: 'card--gone', w: 380, s: 'removed',
    a: { expected: 'shots/b-base.png' } }),
  capture({ t: 'Header', n: 'Default', id: 'header--default', w: 1280, s: 'unchanged', mode: 'dark' }),
];
const diffSummary = {
  ...summary,
  mode: 'diff', base: 'origin/main',
  mergeBase: 'e0f1e2d3c4b5a6978695a4b3c2d1e0f1e2d3c4b5',
  totals: { stories: 3, captures: 3, unchanged: 1, unstable: 0, changed: 1, new: 0,
    removed: 1, renderFailed: 0, failed: 0 },
  changedStories: ['card--default', 'card--gone'],
  captures: diffCaptures,
};
await writeFile(path.join(work, 'diff.html'), await renderReport(diffSummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'diff.html'));
await page.waitForFunction(() =>
  (document.getElementById('meta')?.textContent ?? '').includes('diff against'));

check('the meta names what the diff is against',
  (await page.locator('#meta').textContent()).includes('diff against origin/main (e0f1e2d)'));
const removedStory = page.locator('#story-card--gone');
check('a removed baseline shows exactly its one last image',
  (await removedStory.locator('img').count()) === 1);
check('a removed capture is labelled as deleted by the branch',
  (await removedStory.locator('figcaption').first().textContent()).startsWith('Removed —'));
check('a removed capture offers no comparison modes',
  (await removedStory.locator('.modes button').count()) === 0);
check('the removed badge is the muted outlined one',
  (await removedStory.locator('.badge.s-removed').getAttribute('class')) === 'badge s-removed');
check('a removed capture is offered under its own chip',
  (await page.locator('.chip[data-key=removed] .n').textContent()) === '1');
check('a deleted baseline counts as needing review',
  (await page.locator('.chip[data-key=review] .n').textContent()) === '2');
check('a removed capture tiles as its status, not as its image',
  (await page.locator('.tile[data-key="card--gone@380"] img').count()) === 0 &&
  (await page.locator('.tile[data-key="card--gone@380"]').textContent()).includes('Removed'));
check('a diff report offers nothing to accept',
  (await page.locator('.accept').count()) === 0 &&
  !(await page.locator('main').textContent()).includes('diopsis accept'));
check('a changed capture in a diff keeps its full comparison',
  (await page.locator('#story-card--default .modes button').count()) === 4);
// The unchanged capture carries a mode, so composing the status and mode chips empties the
// diff: the empty line has to blame the filters — a diff with changes is not "no baseline
// changes against this base".
await page.locator('.chip[data-key=unchanged]').click();
await page.waitForFunction(() => flat.length === 1);
await page.locator('.chip[data-key="mode:base"]').click();
await page.waitForFunction(() => flat.length === 0 && !document.querySelector('.empty').hidden);
check('a diff emptied by filters says the filters did it',
  (await page.locator('.empty').textContent()) === 'No captures match the current filters.');
await page.locator('.chip[data-key=review]').click();
await page.waitForFunction(() => flat.length === 2);
// Ticks still count in a diff — it is a review aid — but no command comes of them: accept
// adopts a run's renders, and a diff has none to adopt.
await page.locator('#story-card--default .mark').click();
await page.waitForFunction(() => document.getElementById('progress').textContent.startsWith('1 of'));
check('ticking in a diff still counts progress',
  (await page.locator('#progress').textContent()).startsWith('1 of 2'));
check('a diff report offers no reviewed-accept command',
  (await page.locator('#acceptreviewed button').count()) === 0);
await page.close();

// A merged run: shards written by separate jobs, one review. Every artifact path in the
// merged summary points back into a shard directory, and only a browser can prove the
// report finds every image through them. The accept commands it offers must name the
// merged directory too, or a copied command would adopt whatever older run sits in the
// output directory.
const mergeRoot = path.join(work, 'merged-project');
for (const [dir, files] of [
  ['shard-1-of-2', [['test-results/a-base.png', 'a-base.png'], ['test-results/a-act.png', 'a-act.png'], ['test-results/a-diff.png', 'a-diff.png']]],
  ['shard-2-of-2', [['test-results/b-base.png', 'b-base.png'], ['test-results/b-act.png', 'b-act.png'], ['test-results/b-diff.png', 'b-diff.png'], ['test-results/c-act.png', 'c-act.png']]],
]) {
  await mkdir(path.join(mergeRoot, '.diopsis', dir, 'test-results'), { recursive: true });
  for (const [to, from] of files) {
    await copyFile(path.join(work, 'shots', from), path.join(mergeRoot, '.diopsis', dir, to));
  }
}
// The shard summaries carry no totals of their own that anyone reads; the merge recomputes.
const shardSummary = (index, captures) => ({
  diopsis: 1, createdAt: `2026-01-01T00:00:0${index}Z`, platform: 'linux', arch: 'x64',
  mode: 'run', shard: { index, total: 2 }, snapshotDir: '__screenshots__',
  totals: {}, changedStories: [], captures,
});
await writeFile(path.join(mergeRoot, '.diopsis', 'shard-1-of-2', 'summary.json'), JSON.stringify(shardSummary(1, [
  capture({ t: 'Card', n: 'Default', id: 'card--default', w: 640, s: 'changed', px: 12840, r: 0.0412,
    a: { expected: 'test-results/a-base.png', actual: 'test-results/a-act.png', diff: 'test-results/a-diff.png' } }),
  capture({ t: 'Footer', n: 'Default', id: 'footer--default', w: 1280, s: 'unchanged' }),
])));
await writeFile(path.join(mergeRoot, '.diopsis', 'shard-2-of-2', 'summary.json'), JSON.stringify(shardSummary(2, [
  capture({ t: 'Card', n: 'Long', id: 'card--long', w: 380, s: 'changed', px: 8000, r: 0.06,
    a: { expected: 'test-results/b-base.png', actual: 'test-results/b-act.png', diff: 'test-results/b-diff.png' } }),
  capture({ t: 'Card', n: 'Brand new', id: 'card--brand-new', w: 480, s: 'new',
    a: { actual: 'test-results/c-act.png' } }),
])));

const { mergeCommand } = await import('../src/commands/merge.ts');
const mergeCode = await mergeCommand({ root: mergeRoot });
check('merge exits 1 when the merged run needs review', mergeCode === 1);
const merged = JSON.parse(await readFile(path.join(mergeRoot, '.diopsis', 'merged', 'summary.json'), 'utf8'));
check('the merged summary keeps every capture, in plan order',
  JSON.stringify(merged.captures.map((c) => c.storyId + '@' + c.width)) ===
    JSON.stringify(['card--brand-new@480', 'card--default@640', 'card--long@380', 'footer--default@1280']));
check('the merged summary retotals across the shards',
  merged.totals.captures === 4 && merged.totals.changed === 2 &&
    merged.totals.new === 1 && merged.totals.unchanged === 1);
check('the merged summary points its artifacts back into the shards',
  merged.captures[1].artifacts.actual === '../shard-1-of-2/test-results/a-act.png');

page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(mergeRoot, '.diopsis', 'merged', 'report.html'));
await page.waitForFunction(() => document.querySelectorAll('details.story').length === 4);
// Capture views build when their story opens; open them all so every image the run carried
// is on the page and loadable through the shard directories the paths point into.
await page.locator('details.story').evaluateAll((els) => els.forEach((el) => { el.open = true; }));
// The sheet's tiles sit in the collapsed overview, where a lazy image never finishes
// loading: known dimensions are the proof the bytes came through, complete is not.
await page.waitForFunction(() => {
  const imgs = [...document.querySelectorAll('img')];
  return imgs.length === 6 && imgs.every((i) => i.naturalWidth > 0);
});
check('the merged report renders every image, from both shards',
  await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    // Six: a tile and a stage image for each of the three captures needing review. The
    // widths tie each render to the fixture of the shard that captured it — 640 from
    // shard 1, 380 and 480 from shard 2 — so an unresolved or crossed path fails here.
    return imgs.length === 6 && imgs.every((i) => i.naturalWidth > 0);
  }));
check('each tile carries its own capture’s width',
  JSON.stringify(await page.locator('.tile img').evaluateAll((els) => els.map((i) => i.naturalWidth).sort((a, b) => a - b))) ===
    JSON.stringify([380, 480, 640]));
// The overlay shows the diff alone; switching to the side-by-side view pulls the baseline
// and the render through their rewritten paths too.
await page.locator('#story-card--default').getByRole('button', { name: 'Side by side' }).click();
await page.waitForFunction(() => {
  const imgs = document.querySelectorAll('#story-card--default .capture img');
  return imgs.length === 2 && [...imgs].every((i) => i.complete && i.naturalWidth === 640);
});
check('a changed capture shows both its renders, at its shard’s width',
  JSON.stringify(await page.locator('#story-card--default .capture img')
    .evaluateAll((els) => els.map((i) => i.naturalWidth))) === JSON.stringify([640, 640]));
check('the other shard’s changed capture renders beside it',
  JSON.stringify(await page.locator('#story-card--long .capture img')
    .evaluateAll((els) => els.map((i) => i.naturalWidth))) === JSON.stringify([380]));
check('a new capture shows its one render, at its shard’s width',
  JSON.stringify(await page.locator('#story-card--brand-new .capture img')
    .evaluateAll((els) => els.map((i) => i.naturalWidth))) === JSON.stringify([480]));
check('the merged report numbers the whole run',
  (await page.locator('#meta').textContent()).includes('4 captures across 4 stories'));
check('every accept command the merged report offers names the merged directory',
  (await page.locator('.accept').count()) === 4 &&
  await page.evaluate(() => [...document.querySelectorAll('.accept code')]
    .every((c) => c.textContent.includes('--from .diopsis/merged'))));
check('a story’s accept command names the story after the directory',
  (await page.locator('#story-card--default .accept code').textContent()) ===
    'npx diopsis accept --from .diopsis/merged card--default');
await page.close();

// Past the embed budget an image is referenced from the file beside the report rather than
// dropped — the artifacts are written next to it in the same directory — so a run too large
// to inline still reviews with its images. The budget itself stays, and an image's cost is
// still counted before it goes in, so one image cannot overshoot on its own.
const tiny = await renderReport(summary, work, 1024);
check('a small budget embeds no image at all', !tiny.includes('data:image/png'));
await writeFile(path.join(work, 'tiny.html'), tiny);
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'tiny.html'));
await page.locator('#story-card--default').scrollIntoViewIfNeeded();
await page.waitForFunction(() => {
  const i = document.querySelector('#story-card--default .capture img');
  return i && i.complete && i.naturalWidth > 0;
});
check('a capture past the budget renders its image from the file beside the report',
  (await page.locator('#story-card--default .capture img').first().evaluate((i) =>
    i.getAttribute('src'))) === 'shots/a-diff.png');
check('a capture that renders from its files claims no missing images',
  (await page.locator('#story-card--default .note').count()) === 0);
check('truncation is not reported as missing artifacts',
  !(await page.locator('#story-card--default').textContent()).includes('No image artifacts'));
// The pixel size is read from a referenced image too, so a share the comparator's
// two-decimal ratio would print as 0.00% still computes from the actual's own pixels.
const sliverTiny = await page.locator('#story-card--sliver .w').textContent();
check('a referenced image still computes a share from its own pixels',
  sliverTiny.includes('px differ') && sliverTiny.includes('%') && !sliverTiny.includes('0.00%'));
check('the footer counts the captures reading images from files',
  (await page.locator('#out > div > .note').textContent())
    .startsWith('5 capture(s) show images from the files beside this report'));
await page.close();

// Identical images are embedded once. card--long and card--sliver carry the very same
// three artifact files, so the report holds one copy of each — ten distinct images across
// the whole run: three for card--default, the three shared ones, one for the new capture,
// three for the region story — and both captures render those shared bytes.
const fullHtml = await readFile(path.join(work, 'report.html'), 'utf8');
check('identical images are embedded once',
  (fullHtml.match(/data:image\/png;base64,/g) || []).length === 10);
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto(url);
await page.locator('#story-card--sliver').scrollIntoViewIfNeeded();
await page.waitForFunction(() => {
  const long = document.querySelector('#story-card--long .capture img');
  const sliver = document.querySelector('#story-card--sliver .capture img');
  return long && sliver && long.complete && sliver.complete && long.naturalWidth > 0;
});
const shared = await page.evaluate(() => {
  const long = document.querySelector('#story-card--long .capture img');
  const sliver = document.querySelector('#story-card--sliver .capture img');
  return {
    src: long.getAttribute('src'),
    same: long.getAttribute('src') === sliver.getAttribute('src'),
    bothShown: long.naturalWidth > 0 && sliver.naturalWidth > 0,
  };
});
check('a shared image renders in every capture that uses it',
  shared.same && shared.bothShown && shared.src.startsWith('data:image/png'));
await page.close();

// The report opened without its files — moved out of the CI artifact it shipped in. A
// referenced image that fails to load steps aside for the pointer to the files, once per
// capture, and the rest of the page carries on. The browser's own complaint about files
// that are not there is the scenario, not a fault, so this page watches script errors only.
const lonely = path.join(work, 'lonely');
await mkdir(lonely);
await writeFile(path.join(lonely, 'report.html'), tiny);
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
await page.goto('file://' + path.join(lonely, 'report.html'));
await page.locator('#story-card--default').scrollIntoViewIfNeeded();
await page.waitForFunction(() =>
  document.querySelector('#story-card--default .note') &&
  !document.querySelector('.tile[data-key="card--default@640"] img'));
check('a referenced image that cannot load says where the files are',
  (await page.locator('#story-card--default .note').textContent())
    .includes('Images not embedded to keep this report openable'));
check('the pointer names the artifact file',
  (await page.locator('#story-card--default .note').textContent()).includes('shots/a-act.png'));
check('a missing file leaves no broken image behind',
  (await page.locator('#story-card--default img').count()) === 0);
check('the note appears once per capture',
  (await page.locator('#story-card--default .note').count()) === 1);
check('the tile falls back to its status as text',
  (await page.locator('.tile[data-key="card--default@640"]').textContent()).includes('Changed'));
check('the rest of the page carries on',
  (await page.locator('#meta').textContent()).includes('captures across'));
await page.close();

// A capture whose artifacts never existed when the report was written has no file to
// reference and no size to compute a share from: the row says what is true, and a share
// that would print as a flat zero is left out rather than shown.
const ghostCapture = capture({ t: 'Ghost', n: 'Vanished', id: 'ghost--vanished', w: 380,
  s: 'changed', px: 8, r: 0.00004,
  a: { expected: 'shots/gone-base.png', actual: 'shots/gone-act.png', diff: 'shots/gone-diff.png' } });
const ghostSummary = {
  ...summary,
  captures: [captures[0], ghostCapture],
  totals: { ...summary.totals, stories: 2, captures: 2, unchanged: 0, changed: 2, new: 0,
    renderFailed: 0 },
  changedStories: ['card--default', 'ghost--vanished'],
};
await writeFile(path.join(work, 'ghost.html'), await renderReport(ghostSummary, work));
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => crashes.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') crashes.push(m.text()); });
await page.goto('file://' + path.join(work, 'ghost.html'));
await page.waitForFunction(() =>
  (document.getElementById('story-ghost--vanished')?.textContent ?? '').includes('No image artifacts'));
check('a capture whose artifacts never existed says so',
  (await page.locator('#story-ghost--vanished').textContent()).includes('No image artifacts'));
const ghostBar = await page.locator('#story-ghost--vanished .w').textContent();
check('a share with no size to compute from is left out',
  ghostBar.includes('px differ') && !ghostBar.includes('%'));
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
