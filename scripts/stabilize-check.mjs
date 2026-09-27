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

const { applyState, componentClip, openStory, releaseState, StoryRenderError } = await import('../src/runtime/capture.ts');
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
// The same at animation-frame pace: re-arming every 16 ms must not keep the wait busy either.
await writeFile(path.join(work, 'fast-ticker.html'), page(`
  const tick = () => setTimeout(tick, 16); setTimeout(tick, 16);
  document.getElementById('out').textContent = 'ticking fast';`));
// Re-arming through a scheduler that runs outside any timer callback — a microtask, a
// message port — is what the depth guard cannot see (it only recognises a timer callback),
// so the probe counts every tick of these; the network-quiet horizon is what bounds them.
await writeFile(path.join(work, 'microtask-ticker.html'), page(`
  let n = 0;
  const tick = () => { n += 1; queueMicrotask(() => setTimeout(tick, 100)); };
  setTimeout(tick, 100);
  document.getElementById('out').textContent = 'microtask ticking';`));
await writeFile(path.join(work, 'messagechannel-ticker.html'), page(`
  let n = 0;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { n += 1; setTimeout(() => channel.port2.postMessage(1), 100); };
  setTimeout(() => channel.port2.postMessage(1), 100);
  document.getElementById('out').textContent = 'messageport ticking';`));
// A cancelled timer is no longer pending.
await writeFile(path.join(work, 'cleared.html'), page(`
  const t = setTimeout(() => {}, 400); clearTimeout(t);
  document.getElementById('out').textContent = 'cleared';`));

// A play function in flight, from the preview's point of view: nothing is pending on the
// network, and only the render phase says the story is still being acted on. The flip is
// scheduled one timer deep, inside another timer's callback, so the network wait's probe
// cannot count it; the check then fails if the phase alone stops being waited for.
await writeFile(path.join(work, 'play-completes.html'), page(`
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'playing' } };
  setTimeout(() => setTimeout(() => {
    window.__STORYBOOK_PREVIEW__.currentRender.phase = 'completed';
    document.getElementById('out').textContent = 'played';
  }, 400), 0);`));
// Current Storybook ends every render in 'finished' and reports a thrown play function only as
// a storyFinished event with an error status — unless a failed addon report explains it.
const finishing = (payload) => page(`
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'playing' } };
  const handlers = {};
  window.__STORYBOOK_ADDONS_CHANNEL__ = { on: (event, fn) => { handlers[event] = fn; } };
  setTimeout(() => {
    (handlers.storyFinished || (() => {}))(${payload});
    window.__STORYBOOK_PREVIEW__.currentRender.phase = 'finished';
    document.getElementById('out').textContent = 'finished';
  }, 150);`);
await writeFile(path.join(work, 'finished-error.html'),
  finishing(`{ status: 'error', reporters: [] }`));
await writeFile(path.join(work, 'finished-report.html'),
  finishing(`{ status: 'error', reporters: [{ type: 'a11y', status: 'failed' }] }`));

// A play function that throws: the phase ends in 'errored', and the error display says why.
await writeFile(path.join(work, 'play-errored.html'), page(`
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'playing' } };
  setTimeout(() => {
    window.__STORYBOOK_PREVIEW__.currentRender.phase = 'errored';
    document.getElementById('storybook-root').innerHTML =
      '<pre id="error-message">play blew up</pre><pre id="error-stack">at the story</pre>';
  }, 400);`));
// A play function that never ends: the settle budget, not the story, closes the wait.
await writeFile(path.join(work, 'play-stuck.html'), page(`
  window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'playing' } };
  document.getElementById('out').textContent = 'stuck';`));

// componentClip pages: body margin zeroed so the coordinates asserted below are exact.
const clipPage = (body) => `<!doctype html><meta charset=utf-8>
<style>body{margin:0}</style>
<div id="storybook-root">${body}</div>`;
// A small component, offset well inside a page much larger than it.
await writeFile(
  path.join(work, 'component-small.html'),
  clipPage(
    '<button style="position:absolute;left:300px;top:200px;width:120px;height:40px;box-sizing:border-box">small</button>',
  ),
);
// A child whose absolutely positioned descendant overflows it, on a page tall enough to
// scroll — the clip must be in document coordinates and include the descendant.
await writeFile(
  path.join(work, 'component-overflow.html'),
  `<!doctype html><meta charset=utf-8>
<style>body{margin:0}</style>
<div style="position:absolute;top:0;left:0;width:0;height:2000px"></div>
<div id="storybook-root"><div style="position:absolute;left:40px;top:30px;width:100px;height:50px"><span style="position:absolute;left:150px;top:70px;width:60px;height:20px">far</span></div></div>`,
);
// A render root with nothing in it.
await writeFile(path.join(work, 'component-empty.html'), clipPage(''));

// Interaction states: applyState holds a pointer or keyboard state for the shutter, and the
// page's own styles answer — the colour after the state is what the screenshot would show.
// The button sits away from the origin, because the cleanup parks the pointer there.
await writeFile(path.join(work, 'states.html'), `<!doctype html><meta charset=utf-8>
<style>body{margin:0}button{display:block;margin:60px;border:0;width:120px;height:40px;
background:#eeeeee}button:hover{background:#ff8800}button:focus-visible{background:#0088ff}
button:active{background:#ff00ff}</style>
<div id="storybook-root"><button id="b">go</button></div>`);

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

  const fast = await cost('fast-ticker.html');
  check('a 16 ms self-rearming timer does not hold the wait open', fast < 1000, `+${fast} ms`);

  const microtask = await cost('microtask-ticker.html');
  check('a timer re-armed from a microtask does not hold the wait open', microtask < 1000, `+${microtask} ms`);

  const messageport = await cost('messagechannel-ticker.html');
  check('a timer re-armed from a message port does not hold the wait open', messageport < 1000, `+${messageport} ms`);

  const cleared = await cost('cleared.html');
  check('a cleared timer is not waited for', cleared < 300, `+${cleared} ms`);

  const played = await open('play-completes.html');
  check('a capture waits for the story to finish playing', played.text === 'played', played.text);

  let failure;
  try {
    await open('play-errored.html');
  } catch (error) {
    failure = error;
  }
  check(
    'a failing play function is a render failure',
    failure instanceof StoryRenderError &&
      failure.message.includes('play function') &&
      failure.detail === 'play blew up\nat the story',
    failure ? `${failure.name}: ${failure.message} (${failure.detail})` : 'resolved',
  );

  let finishedFailure;
  try {
    await open('finished-error.html');
  } catch (error) {
    finishedFailure = error;
  }
  check('a storyFinished error status is a render failure',
    finishedFailure instanceof StoryRenderError, finishedFailure ? finishedFailure.message : 'resolved');

  const reportOnly = await open('finished-report.html').catch((error) => ({ text: String(error) }));
  check('a failed addon report alone is not a broken story', reportOnly.text === 'finished',
    reportOnly.text);

  // The play wait must cost a preview-less page nothing, measured like the waits above: the
  // same page twice, once with the wait switched off.
  const noPlay = { ...defaultConfig.stabilize, waitForPlay: false };
  const previewless =
    (await open('static.html')).elapsed - (await open('static.html', noPlay)).elapsed;
  check('a page without a preview object pays nothing for the play wait', previewless < 300, `+${previewless} ms`);

  const stuck = await open('play-stuck.html', { ...defaultConfig.stabilize, settleTimeout: 1500 });
  check(
    'a story still playing gives up at the settle budget',
    stuck.text === 'stuck' && stuck.elapsed >= 1200 && stuck.elapsed < 4000,
    `${stuck.text} after ${stuck.elapsed} ms`,
  );

  // A reused page must not carry one story's state into the next.
  await writeFile(path.join(work, 'writes.html'), page(`
    localStorage.setItem('k', 'leaked'); sessionStorage.setItem('k', 'leaked');
    document.cookie = 'k=leaked; path=/';
    indexedDB.open('db').onupgradeneeded = (e) => e.target.result.createObjectStore('s');
    document.getElementById('out').textContent = 'wrote';`));
  await writeFile(path.join(work, 'reads.html'), page(`
    indexedDB.databases().then((dbs) => {
      document.getElementById('out').textContent = [localStorage.getItem('k'),
        sessionStorage.getItem('k'), document.cookie || null, dbs.length || null].join(',');
    });`));
  const context = await browser.newContext();
  const shared = await context.newPage();
  await openStory(shared, `${server.url}/writes.html`, defaultConfig.stabilize);
  await openStory(shared, `${server.url}/reads.html`, defaultConfig.stabilize);
  const seen = await shared.locator('#out').textContent();
  check('a reused page starts each story with empty storage', seen === ',,,', seen);
  await context.close();

  // componentClip: the geometry a component-scoped capture photographs.
  {
    const context = await browser.newContext();
    const p = await context.newPage();
    await openStory(p, `${server.url}/component-small.html`, defaultConfig.stabilize);
    const clip = await componentClip(p);
    check(
      'a small offset component clips to its padded box',
      clip != null &&
        clip.x === 292 && clip.y === 192 && clip.width === 136 && clip.height === 56,
      JSON.stringify(clip),
    );
    await context.close();
  }
  {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.goto(`${server.url}/component-overflow.html`);
    await p.evaluate(() => window.scrollTo(0, 40));
    const clip = await componentClip(p);
    // (40,30)-(250,120) padded by 8: the overflow included, the scroll offset added back.
    check(
      'a clip includes a descendant overflowing its parent, in document coordinates',
      clip != null &&
        clip.x === 32 && clip.y === 22 && clip.width === 226 && clip.height === 106,
      JSON.stringify(clip),
    );
    await context.close();
  }
  {
    const context = await browser.newContext();
    const p = await context.newPage();
    // Not through openStory: an empty root is exactly what its waits would reject.
    await p.goto(`${server.url}/component-empty.html`);
    const clip = await componentClip(p);
    check('an empty render root has no clip to take', clip === undefined, JSON.stringify(clip));
    await context.close();
  }
  // applyState, against a page whose styles say which state is held.
  {
    const context = await browser.newContext();
    const p = await context.newPage();
    const open = async () => {
      await openStory(p, `${server.url}/states.html`, defaultConfig.stabilize);
    };
    const colour = () => p.locator('#b').evaluate((el) => getComputedStyle(el).backgroundColor);

    await open();
    await applyState(p, { name: 'hover', action: 'hover', selector: '#b' });
    const hovered = await colour();
    check('hover styles the target after applyState', hovered === 'rgb(255, 136, 0)', hovered);

    await open();
    await applyState(p, { name: 'focus', action: 'focus', selector: '#b' });
    const focused = await colour();
    check('a scripted focus shows the keyboard-focus styling', focused === 'rgb(0, 136, 255)', focused);

    await open();
    await applyState(p, { name: 'active', action: 'active', selector: '#b' });
    const pressed = await colour();
    check('a pressed target shows its active styling', pressed === 'rgb(255, 0, 255)', pressed);
    await releaseState(p);
    const released = await colour();
    check('the cleanup releases the press and parks the pointer clear',
      released === 'rgb(238, 238, 238)', released);

    await open();
    let missing;
    try {
      await applyState(p, { name: 'hover', action: 'hover', selector: '#absent' });
    } catch (error) {
      missing = error;
    }
    check('a selector naming nothing is a render failure',
      missing instanceof StoryRenderError && missing.message === 'State target not found: #absent',
      missing ? `${missing.name}: ${missing.message}` : 'resolved');
    await context.close();
  }
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
