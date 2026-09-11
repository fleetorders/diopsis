import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { needsReview, type CaptureResult, type RunSummary } from './summary.ts';

/** Total embedded-image budget. Past this the report links to files instead of inlining. */
const EMBED_BUDGET_BYTES = 40 * 1024 * 1024;

async function dataUri(file: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(file);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

interface EmbeddedCapture extends CaptureResult {
  images: { expected?: string; actual?: string; diff?: string };
}

/**
 * Inline the images a reviewer needs.
 *
 * Only captures that need review carry images: an unchanged capture has nothing to look at,
 * and embedding the whole matrix would make the report too heavy to open from a CI artifact —
 * which is the one place it has to work.
 */
async function embed(
  summary: RunSummary,
  outputDir: string,
): Promise<{ captures: EmbeddedCapture[]; truncated: number }> {
  let spent = 0;
  let truncated = 0;
  const captures: EmbeddedCapture[] = [];

  for (const capture of summary.captures) {
    if (!needsReview(capture.status)) {
      captures.push({ ...capture, images: {} });
      continue;
    }

    const images: EmbeddedCapture['images'] = {};
    // A new capture's "expected" is the baseline the comparator just wrote from this very
    // render — the same bytes as the actual — and no diff exists, because nothing was
    // compared. Embedding the duplicate would double a first-run report, the one run that
    // is all new captures, for images the single-column presentation never shows.
    const kinds = capture.status === 'new'
      ? (['actual'] as const)
      : (['expected', 'actual', 'diff'] as const);
    for (const kind of kinds) {
      const relative = capture.artifacts[kind];
      if (!relative) continue;
      if (spent >= EMBED_BUDGET_BYTES) {
        truncated += 1;
        continue;
      }
      const uri = await dataUri(path.resolve(outputDir, relative));
      if (!uri) continue;
      spent += uri.length;
      images[kind] = uri;
    }
    captures.push({ ...capture, images });
  }

  return { captures, truncated };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Safe to sit inside a `<script>` element: `</script>` and U+2028/9 cannot terminate it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export async function renderReport(summary: RunSummary, outputDir: string): Promise<string> {
  const { captures, truncated } = await embed(summary, outputDir);
  const payload = { ...summary, captures, truncated };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diopsis · ${escapeHtml(String(summary.totals.captures))} captures</title>
<style>
/* Two palettes from one set of names. A report is read wherever CI dropped it, and a reviewer
   judging a light interface against a near-black page misjudges its contrast. */
:root {
  color-scheme: dark light;
  --bg: #0f1418; --surface: #161c22; --raised: #1c242c; --line: #232c35;
  --ink: #e6edf3; --muted: #8d99a6; --accent: #4cc9c0;
  --changed: #d98a2b; --new: #4d8fd6; --failed: #d9534f; --ok: #46a35e;
  --matte: #2b3138; --matte-alt: #23282e;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f7f8; --surface: #ffffff; --raised: #eef2f4; --line: #d9e0e5;
    --ink: #1b2229; --muted: #5b6975; --accent: #0f7b74;
    --changed: #97590a; --new: #1f5da8; --failed: #b03430; --ok: #2b7a46;
    --matte: #c9ced2; --matte-alt: #dadfe2;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }

/* The toolbar is the only way back to a different filter, and a matrix scrolls past it
   within one capture — so it travels with the reader. */
header { position: sticky; top: 0; z-index: 3; background: var(--bg);
  border-bottom: 1px solid var(--line); padding: 10px 18px; }
.top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.keys { margin-left: auto; color: var(--muted); font-size: 11px; }
.keys b { color: var(--ink); font-weight: 600; }
.tools { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 9px; }
.totals { display: flex; flex-wrap: wrap; gap: 6px; }

/* Accent means "you selected this" and nothing else; a status colour means a status and
   nothing else. Mixing the two left every control competing for the same attention. */
.chip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); border-radius: 6px; padding: 4px 9px;
  font: inherit; font-size: 12px; cursor: pointer; }
.chip:hover { background: var(--raised); }
.chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.chip .n { color: var(--muted); font-variant-numeric: tabular-nums; }
.chip[aria-pressed="true"] .n { color: inherit; }
.chip .dot { width: 7px; height: 7px; border-radius: 2px; }
.dot.c-changed { background: var(--changed); } .dot.c-new { background: var(--new); }
.dot.c-failed, .dot.c-render-failed { background: var(--failed); }
.dot.c-unchanged { background: var(--ok); }

.search { flex: 1 1 180px; min-width: 130px; max-width: 300px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 6px; color: var(--ink); padding: 5px 9px;
  font: inherit; font-size: 12px; }
.search::placeholder { color: var(--muted); }
.search:focus { outline: none; border-color: var(--accent); }
.progress { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

main { padding: 14px 18px 56px; }
.story { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px;
  background: var(--surface); overflow: hidden; }
.story > summary { cursor: pointer; padding: 9px 12px; display: flex; gap: 10px;
  align-items: center; list-style: none; }
.story > summary::-webkit-details-marker { display: none; }
.story > summary::before { content: "\\25B8"; color: var(--muted); font-size: 11px; }
.story[open] > summary::before { content: "\\25BE"; }
.title { font-weight: 600; font-size: 14px; }
.sub { color: var(--muted); font-size: 12px; }
.anchor { margin-left: auto; background: transparent; border: 0; color: var(--muted);
  font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.anchor:hover { color: var(--accent); background: var(--raised); }

/* Status reads as a coloured word, not an outlined pill: the pill drew a box around every
   label and left the page looking like a form. */
.badge { font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 2px;
  background: currentColor; }
.s-changed { color: var(--changed); } .s-new { color: var(--new); }
.s-failed, .s-render-failed { color: var(--failed); } .s-unchanged { color: var(--ok); }

.capture { border-top: 1px solid var(--line); padding: 12px; }
.capture.current { box-shadow: inset 2px 0 0 var(--accent); }
.capture.done { opacity: 0.5; }
.bar { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.bar .w { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; }
/* A count answers "how much", a bar answers "compared to the rest of this run" — which is
   the question being asked while scrolling past forty of them. */
.meter { width: 56px; height: 5px; border-radius: 3px; background: var(--raised);
  overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--changed); }
.modes { display: flex; gap: 4px; margin-left: auto; }
.modes button, .mark { background: transparent; border: 1px solid var(--line);
  color: var(--muted); border-radius: 5px; padding: 3px 9px; font: inherit; font-size: 12px;
  cursor: pointer; }
.modes button[aria-pressed="true"], .mark[aria-pressed="true"] { border-color: var(--accent);
  color: var(--accent); }
.modes button:hover, .mark:hover { background: var(--raised); }

/* The stage shrink-wraps its image: a narrow capture must not sit in a full-width void.
   Its backdrop is a neutral chequerboard so a transparent region reads as transparent
   rather than as a black one, and so the surround does not tint what is being judged. */
.stage { border: 1px solid var(--line); border-radius: 6px; width: fit-content;
  max-width: 100%; margin: 0 auto; max-height: 70vh; overflow: auto;
  background-color: var(--matte-alt);
  background-image:
    linear-gradient(45deg, var(--matte) 25%, transparent 25%, transparent 75%, var(--matte) 75%),
    linear-gradient(45deg, var(--matte) 25%, transparent 25%, transparent 75%, var(--matte) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 8px 8px; }
/* Height is never used to fit an image. Two renders of the same story share a natural width,
   so constraining width alone scales both by the same factor — constraining height scales a
   taller render more, which is the comparison quietly lying about how much moved. */
.stage img { display: block; max-width: 100%; height: auto; }
.stage.zoom img { cursor: zoom-in; }
.stage.actual { max-height: 80vh; }
.stage.actual img { max-width: none; image-rendering: pixelated; }
.stage.zoom.actual img { cursor: zoom-out; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start;
  max-height: 70vh; overflow: auto; }
.pair figure { margin: 0; min-width: 0; }
.pair figcaption { color: var(--muted); font-size: 12px; padding: 3px 2px; }
.pair .stage { max-height: none; overflow: visible; }
/* A new capture is one labelled image, not half a comparison: the caption says what "new"
   means, so the absence of a second column reads as nothing-to-compare, not a missing panel. */
.solo { margin: 0; }
.solo figcaption { color: var(--muted); font-size: 12px; padding: 3px 2px; }
/* Both renders occupy one grid cell, so the cell takes the size of the larger and neither is
   stretched to the other's box. */
.overlaywrap, .swipe { display: grid; line-height: 0; }
.overlaywrap > img, .swipe > img { grid-area: 1 / 1; place-self: start; }
.swipe > img.top { clip-path: inset(0 50% 0 0); }
/* The slider tracks the width of the image it drives, not the width of the row. */
.stagewrap { width: fit-content; max-width: 100%; margin: 0 auto; }
input[type=range] { display: block; width: 100%; margin-top: 9px; accent-color: var(--accent); }

.err { white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace; color: var(--failed);
  background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 9px;
  margin-top: 10px; }
.accept { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg);
  border: 1px solid var(--line); border-radius: 5px; padding: 4px 8px; color: var(--ink);
  white-space: pre; }
button.copy { background: transparent; border: 1px solid var(--line); color: var(--muted);
  border-radius: 5px; padding: 4px 9px; font: inherit; font-size: 12px; cursor: pointer; }
button.copy:hover { background: var(--raised); }
.empty { color: var(--muted); padding: 36px 0; text-align: center; }
.note { color: var(--muted); font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <div class="top">
    <h1>Diopsis</h1>
    <div class="meta" id="meta"></div>
    <div class="keys"><b>/</b> search &middot; <b>j k</b> move &middot; <b>1&ndash;4</b> mode
      &middot; <b>r</b> reviewed</div>
  </div>
  <div class="tools">
    <div class="totals" id="filters"></div>
    <input class="search" id="q" type="search" placeholder="Filter stories" autocomplete="off"
      spellcheck="false" aria-label="Filter stories">
    <span class="progress" id="progress"></span>
    <span id="acceptvisible"></span>
  </div>
</header>
<main id="out"></main>
<script type="application/json" id="data">${embedJson(payload)}</script>
<script>
${CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}

/** Client behaviour. Kept as one string so the report stays a single file with no assets. */
const CLIENT_SCRIPT = String.raw`
const data = JSON.parse(document.getElementById('data').textContent);
const REVIEW = new Set(['changed', 'new', 'render-failed', 'failed']);
const LABEL = { changed: 'Changed', new: 'New', 'render-failed': 'Render failed',
  failed: 'Failed', unchanged: 'Unchanged' };
const order = ['changed', 'new', 'render-failed', 'failed', 'unchanged'];

document.getElementById('meta').textContent =
  data.totals.captures + ' captures across ' + data.totals.stories + ' stories, ' +
  data.platform + '-' + data.arch + ', ' + data.mode + ', ' + data.createdAt;

const counts = {};
for (const c of data.captures) counts[c.status] = (counts[c.status] || 0) + 1;

// Anything needing review leads; unchanged is available but never the default view.
let active = order.find(s => REVIEW.has(s) && counts[s]) ? 'review' : 'all';
let query = '';
let cursor = -1;

/* Triage is remembered per run, not per file: the same report reopened after a fresh run
   describes different pixels, so a stale tick would claim a capture was seen that never was. */
const STORE = 'diopsis:reviewed:' + data.createdAt;
function keyOf(c) { return c.storyId + '@' + c.width; }
function loadReviewed() {
  try { return new Set(JSON.parse(localStorage.getItem(STORE) || '[]')); }
  catch { return new Set(); }
}
function saveReviewed() {
  try { localStorage.setItem(STORE, JSON.stringify([...reviewed])); } catch (e) { /* private mode */ }
}
const reviewed = loadReviewed();

const searchEl = document.getElementById('q');
const filters = document.getElementById('filters');
const progressEl = document.getElementById('progress');
const acceptVisibleEl = document.getElementById('acceptvisible');

const maxRatio = data.captures.reduce((m, c) => Math.max(m, c.diffRatio || 0), 0);

function chip(key, label, status) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.dataset.key = key;
  if (status) {
    const dot = document.createElement('span');
    dot.className = 'dot c-' + status;
    b.appendChild(dot);
  }
  const text = document.createElement('span');
  text.textContent = label;
  const n = document.createElement('span');
  n.className = 'n';
  b.append(text, n);
  b.onclick = () => { active = key; render(); };
  return b;
}
filters.appendChild(chip('review', 'Needs review'));
for (const s of order) if (counts[s]) filters.appendChild(chip(s, LABEL[s], s));
filters.appendChild(chip('all', 'All'));

searchEl.oninput = () => { query = searchEl.value.trim().toLowerCase(); render(); };

function textOf(c) {
  return (c.storyId + ' ' + c.storyTitle + ' ' + c.storyName).toLowerCase();
}
function inSearch(c) { return !query || textOf(c).includes(query); }
function inFilter(c, key) {
  return key === 'all' ? true : key === 'review' ? REVIEW.has(c.status) : c.status === key;
}

function copyButton(text, label) {
  const wrap = document.createElement('div');
  wrap.className = 'accept';
  const code = document.createElement('code');
  code.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'copy';
  btn.textContent = label || 'Copy';
  btn.onclick = async () => {
    const was = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch (e) { btn.textContent = 'Select it manually'; }
    setTimeout(() => (btn.textContent = was), 1600);
  };
  wrap.append(code, btn);
  return wrap;
}

/* One image is drawn at a time and only once its story is open: every capture needing review
   carries three inlined PNGs, and decoding the whole matrix up front is what made a large
   report slow to become interactive. */
function stage(capture) {
  const el = document.createElement('div');
  const img = capture.images || {};
  // A new capture has no baseline to compare against: the "expected" a run leaves behind is
  // the baseline written from this very render, so a two-column presentation would show one
  // image twice and read as a difference that does not exist. One column, labelled as new —
  // also when both artifact references are present, which a fresh result always carries.
  if (capture.status === 'new' && (img.actual || img.expected)) {
    const fig = document.createElement('figure');
    fig.className = 'solo';
    const cap = document.createElement('figcaption');
    cap.textContent = 'New — no baseline yet; this image becomes the baseline when accepted.';
    const box = document.createElement('div');
    box.className = 'stage';
    zoomable(box);
    box.appendChild(picture(img.actual || img.expected));
    fig.append(cap, box);
    el.appendChild(fig);
    return { el, modes: null, setMode: null, nudge: null };
  }
  // The highlight overlay is the default: it answers "what changed?" without any interaction.
  const modes = [];
  if (img.diff) modes.push('Overlay');
  if (img.expected && img.actual) modes.push('Side by side', 'Swipe', 'Onion-skin');
  if (!modes.length && img.actual) modes.push('Actual');
  if (!modes.length) {
    // An unchanged capture is meant to have no images; saying so on every row of a full
    // matrix reads as a fault report. Only an absence that needs explaining gets a line.
    if (REVIEW.has(capture.status)) {
      el.className = 'note';
      el.textContent = 'No image artifacts for this capture.';
    }
    return { el, modes: null, setMode: null, nudge: null };
  }

  const body = document.createElement('div');
  let current = modes[0];
  let slider = null;

  function picture(src) {
    const i = document.createElement('img');
    i.loading = 'lazy';
    i.decoding = 'async';
    i.src = src;
    return i;
  }
  // Fit is for "did anything move", actual size is for "by how much" — a downscaled diff can
  // filter a one-pixel shift out of visibility entirely.
  function zoomable(box) {
    box.classList.add('zoom');
    box.onclick = () => box.classList.toggle('actual');
    return box;
  }

  function draw() {
    body.innerHTML = '';
    slider = null;
    if (current === 'Overlay' || current === 'Actual') {
      const box = document.createElement('div');
      box.className = 'stage';
      zoomable(box);
      box.appendChild(picture(current === 'Overlay' ? img.diff : img.actual));
      body.appendChild(box);
    } else if (current === 'Side by side') {
      const pair = document.createElement('div');
      pair.className = 'pair';
      for (const [src, cap] of [[img.expected, 'Baseline'], [img.actual, 'This run']]) {
        const f = document.createElement('figure');
        const c = document.createElement('figcaption');
        c.textContent = cap;
        const s = document.createElement('div');
        s.className = 'stage';
        s.appendChild(picture(src));
        f.append(c, s);
        pair.appendChild(f);
      }
      body.appendChild(pair);
    } else {
      const box = document.createElement('div');
      box.className = 'stage';
      zoomable(box);
      const wrap = document.createElement('div');
      wrap.className = current === 'Swipe' ? 'swipe' : 'overlaywrap';
      const base = picture(img.expected);
      const top = picture(img.actual);
      top.className = 'top';
      wrap.append(base, top);
      box.appendChild(wrap);
      slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = '50';
      slider.onclick = (e) => e.stopPropagation();
      slider.oninput = () => {
        if (current === 'Swipe') top.style.clipPath = 'inset(0 ' + (100 - slider.value) + '% 0 0)';
        else top.style.opacity = String(slider.value / 100);
      };
      const holder = document.createElement('div');
      holder.className = 'stagewrap';
      holder.append(box, slider);
      body.appendChild(holder);
      slider.oninput();
    }
  }

  const bar = document.createElement('div');
  bar.className = 'modes';
  function select(m) {
    if (!modes.includes(m)) return;
    current = m;
    for (const b of bar.children) b.setAttribute('aria-pressed', String(b.textContent === m));
    draw();
  }
  for (const m of modes) {
    const b = document.createElement('button');
    b.textContent = m;
    b.setAttribute('aria-pressed', String(m === current));
    b.onclick = () => select(m);
    bar.appendChild(b);
  }
  draw();
  el.appendChild(body);

  return {
    el,
    modes: bar,
    setMode: (i) => select(modes[i]),
    nudge: (step) => {
      if (!slider) return;
      slider.value = String(Math.min(100, Math.max(0, Number(slider.value) + step)));
      slider.oninput();
    },
  };
}

/** Every capture currently on the page, in reading order — the target list for j/k. */
let flat = [];

function setCursor(next) {
  if (!flat.length) return;
  const at = Math.min(flat.length - 1, Math.max(0, next));
  for (const entry of flat) entry.box.classList.remove('current');
  cursor = at;
  const entry = flat[at];
  // Navigating into a collapsed story opens it, which is also what builds its images.
  if (entry.story && !entry.story.open) entry.story.open = true;
  entry.box.classList.add('current');
  entry.box.scrollIntoView({ block: 'center' });
}

function toggleReviewed(entry) {
  if (!REVIEW.has(entry.capture.status)) return;
  const key = keyOf(entry.capture);
  if (reviewed.has(key)) reviewed.delete(key);
  else reviewed.add(key);
  saveReviewed();
  entry.box.classList.toggle('done', reviewed.has(key));
  entry.mark.setAttribute('aria-pressed', String(reviewed.has(key)));
  entry.mark.textContent = reviewed.has(key) ? 'Reviewed' : 'Mark reviewed';
  drawProgress();
}

function drawProgress() {
  const all = data.captures.filter(c => REVIEW.has(c.status));
  if (!all.length) { progressEl.textContent = ''; return; }
  const done = all.filter(c => reviewed.has(keyOf(c))).length;
  progressEl.textContent = done + ' of ' + all.length + ' reviewed';
}

/* The accept command takes one story id at a time, so a filtered set is offered as one command
   per line rather than as a single call that would silently adopt only the first. */
function drawAcceptVisible(stories) {
  acceptVisibleEl.innerHTML = '';
  const ids = stories.filter(id => data.changedStories.includes(id));
  if (!ids.length || ids.length === data.changedStories.length) return;
  const cmd = ids.map(id => 'npx diopsis accept ' + id).join('\n');
  const holder = copyButton(cmd, 'Copy accept for these ' + ids.length);
  holder.querySelector('code').remove();
  acceptVisibleEl.appendChild(holder);
}

function render() {
  for (const b of filters.children) {
    const key = b.dataset.key;
    b.setAttribute('aria-pressed', String(key === active));
    b.querySelector('.n').textContent =
      data.captures.filter(c => inSearch(c) && inFilter(c, key)).length;
  }

  const visible = data.captures.filter(c => inSearch(c) && inFilter(c, active));
  const out = document.getElementById('out');
  out.innerHTML = '';
  flat = [];
  cursor = -1;

  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = query
      ? 'No story matches "' + query + '".'
      : 'Nothing here. Every capture matched its baseline.';
    out.appendChild(p);
    drawProgress();
    drawAcceptVisible([]);
    return;
  }

  const byStory = new Map();
  for (const c of visible) {
    if (!byStory.has(c.storyId)) byStory.set(c.storyId, []);
    byStory.get(c.storyId).push(c);
  }

  // Worst first: what needs review leads, and within it the largest change is the one most
  // likely to be the reason the run failed.
  const stories = [...byStory.entries()].sort((a, b) => {
    const rank = (cs) => (cs.some(c => REVIEW.has(c.status)) ? 0 : 1);
    const size = (cs) => cs.reduce((m, c) => Math.max(m, c.diffPixels || 0), 0);
    return rank(a[1]) - rank(b[1]) || size(b[1]) - size(a[1]) || a[0].localeCompare(b[0]);
  });

  for (const [storyId, captures] of stories) {
    const worst = order.find(s => captures.some(c => c.status === s)) || 'unchanged';
    const det = document.createElement('details');
    det.className = 'story';
    det.id = 'story-' + storyId;
    det.open = REVIEW.has(worst);

    const sum = document.createElement('summary');
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = captures[0].storyTitle + ' › ' + captures[0].storyName;
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = storyId + ', ' + captures.length +
      (captures.length === 1 ? ' capture' : ' captures');
    const badge = document.createElement('span');
    badge.className = 'badge s-' + worst;
    badge.textContent = LABEL[worst];
    // A reviewer's finding has to survive the trip into a pull-request comment.
    const anchor = document.createElement('button');
    anchor.className = 'anchor';
    anchor.textContent = '#';
    anchor.title = 'Copy a link to this story';
    anchor.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      location.hash = det.id;
      try { await navigator.clipboard.writeText(location.href); anchor.textContent = 'copied'; }
      catch (err) { anchor.textContent = location.hash; }
      setTimeout(() => (anchor.textContent = '#'), 1600);
    };
    sum.append(t, s, anchor, badge);
    det.appendChild(sum);

    for (const c of captures) {
      const box = document.createElement('div');
      box.className = 'capture' + (reviewed.has(keyOf(c)) ? ' done' : '');

      const bar = document.createElement('div');
      bar.className = 'bar';
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = c.width + 'px' +
        (c.diffPixels != null ? ', ' + c.diffPixels.toLocaleString() + ' px differ (' +
          (c.diffRatio * 100).toFixed(2) + '%)' : '');
      bar.appendChild(w);

      if (c.diffRatio != null && maxRatio > 0) {
        const meter = document.createElement('div');
        meter.className = 'meter';
        meter.title = 'Relative to the largest change in this run';
        const fill = document.createElement('i');
        fill.style.width = Math.max(4, (c.diffRatio / maxRatio) * 100) + '%';
        meter.appendChild(fill);
        bar.appendChild(meter);
      }

      // The story row already carries this status; repeating it is only worth the space when
      // this capture disagrees with it.
      if (c.status !== worst) {
        const st = document.createElement('span');
        st.className = 'badge s-' + c.status;
        st.textContent = LABEL[c.status];
        bar.appendChild(st);
      }

      const mark = document.createElement('button');
      mark.className = 'mark';
      mark.setAttribute('aria-pressed', String(reviewed.has(keyOf(c))));
      mark.textContent = reviewed.has(keyOf(c)) ? 'Reviewed' : 'Mark reviewed';
      box.appendChild(bar);

      const entry = { box, capture: c, story: det, mark, built: null };
      mark.onclick = () => toggleReviewed(entry);

      const slot = document.createElement('div');
      box.appendChild(slot);
      entry.build = () => {
        if (entry.built) return;
        entry.built = stage(c);
        if (entry.built.modes) bar.appendChild(entry.built.modes);
        // Progress counts only what needs review, so only those rows offer to be ticked off.
        if (REVIEW.has(c.status)) bar.appendChild(mark);
        slot.appendChild(entry.built.el);
      };

      // A changed capture already states its own size in the bar, and a new capture's whole
      // story — "a snapshot doesn't exist … writing actual" — is told by its single column;
      // repeating either as a red assertion failure dresses the ordinary outcome up as a
      // broken one. The text is kept wherever it is the only thing there is to read.
      const explained =
        (c.status === 'changed' && c.diffPixels != null) || c.status === 'new';
      if (c.error && !explained) {
        const e = document.createElement('pre');
        e.className = 'err';
        e.textContent = c.error;
        box.appendChild(e);
      }
      det.appendChild(box);
      flat.push(entry);
    }

    const build = () => { for (const e of flat) if (e.story === det) e.build(); };
    det.addEventListener('toggle', () => { if (det.open) build(); });
    if (det.open) build();

    if (captures.some(c => REVIEW.has(c.status))) {
      const foot = document.createElement('div');
      foot.className = 'capture';
      foot.appendChild(copyButton('npx diopsis accept ' + storyId));
      det.appendChild(foot);
    }
    out.appendChild(det);
  }

  if (data.changedStories.length) {
    const all = document.createElement('div');
    all.style.marginTop = '18px';
    all.appendChild(copyButton('npx diopsis accept'));
    out.appendChild(all);
  }
  if (data.truncated) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = data.truncated + ' capture(s) had images omitted to keep this file openable.';
    out.appendChild(n);
  }

  drawProgress();
  drawAcceptVisible([...byStory.keys()]);
}

/* A link into the report has to land even when the current filter excludes its target, so a
   miss widens the view once and tries again rather than scrolling nowhere. */
function focusHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id.startsWith('story-')) return;
  if (!document.getElementById(id)) {
    active = 'all';
    query = '';
    searchEl.value = '';
    render();
  }
  const target = document.getElementById(id);
  if (!target) return;
  target.open = true;
  target.scrollIntoView({ block: 'start' });
}

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLElement &&
    (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  if (e.key === 'Escape') {
    if (typing) { searchEl.value = ''; query = ''; searchEl.blur(); render(); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setCursor(cursor + 1); return; }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setCursor(cursor - 1); return; }
  if (cursor < 0 || !flat[cursor]) return;
  const entry = flat[cursor];
  if (e.key === 'r') { e.preventDefault(); toggleReviewed(entry); return; }
  if (e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    if (entry.built && entry.built.setMode) entry.built.setMode(Number(e.key) - 1);
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (!entry.built || !entry.built.nudge) return;
    e.preventDefault();
    entry.built.nudge((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 2));
  }
});

window.addEventListener('hashchange', focusHash);

render();
focusHash();
`;
