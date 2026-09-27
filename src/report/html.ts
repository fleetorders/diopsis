import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { needsReview, type CaptureResult, type RunSummary } from './summary.ts';

/** Total embedded-image budget. Past this the report links to files instead of inlining. */
const EMBED_BUDGET_BYTES = 40 * 1024 * 1024;

/** A PNG's header carries its size: width at byte 16, height at 20, both big endian. */
function pngSizeOf(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

interface EmbeddedCapture extends CaptureResult {
  images: { expected?: string; actual?: string; diff?: string };
  /** Pixel size of the actual render, so the report can state a share Playwright rounded away. */
  size?: { width: number; height: number };
  /** Set when artifacts exist on disk but stayed out to keep the report inside its budget. */
  truncated?: true;
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
  budget: number,
): Promise<{ captures: EmbeddedCapture[]; truncated: number }> {
  let spent = 0;
  let truncatedCaptures = 0;
  const captures: EmbeddedCapture[] = [];

  for (const capture of summary.captures) {
    if (!needsReview(capture.status)) {
      captures.push({ ...capture, images: {} });
      continue;
    }

    const images: EmbeddedCapture['images'] = {};
    let size: EmbeddedCapture['size'];
    let truncated = false;
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
      let bytes: Buffer;
      try {
        bytes = await readFile(path.resolve(outputDir, relative));
      } catch {
        continue;
      }
      // The cost is accounted before embedding, in the base64 form the report actually
      // carries: counting only after an image is in would let one large image push the file
      // far past a budget every later image is then refused for.
      const cost = 'data:image/png;base64,'.length + Math.ceil(bytes.length / 3) * 4;
      if (spent + cost > budget) {
        truncated = true;
        continue;
      }
      if (kind === 'actual') size = pngSizeOf(bytes);
      images[kind] = `data:image/png;base64,${bytes.toString('base64')}`;
      spent += cost;
    }
    captures.push({
      ...capture,
      images,
      ...(size ? { size } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
    if (truncated) truncatedCaptures += 1;
  }

  return { captures, truncated: truncatedCaptures };
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

export async function renderReport(
  summary: RunSummary,
  outputDir: string,
  /** Budget override, so the truncation path can be exercised with a value small enough to bite. */
  budget: number = EMBED_BUDGET_BYTES,
): Promise<string> {
  const { captures, truncated } = await embed(summary, outputDir, budget);
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

/* The overview is a contact sheet: one tile per capture needing review, so a run too large
   to scroll through can be taken in at a glance before one capture fills the screen. A
   thumbnail scales by width only and clips what hangs below — the width rule the
   comparisons follow — so a tall render reads as tall, never squashed. */
.overview { margin-bottom: 14px; }
.overview[hidden] { display: none; }
.ov-toggle { display: inline-flex; align-items: center; gap: 6px; background: transparent;
  border: 0; padding: 0; color: var(--ink); font: inherit; font-size: 13px; font-weight: 600;
  cursor: pointer; }
.ov-toggle::before { content: "\\25B8"; color: var(--muted); font-size: 11px; }
.ov-toggle[aria-expanded="true"]::before { content: "\\25BE"; }
.ov-toggle:hover { color: var(--accent); }
.sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px; margin-top: 9px; }
.sheet[hidden] { display: none; }
.tile { display: flex; flex-direction: column; gap: 6px; padding: 8px; text-align: left;
  background: var(--surface); color: var(--ink); border: 1px solid var(--line);
  border-radius: 8px; font: inherit; cursor: pointer; }
.tile:hover { background: var(--raised); border-color: var(--accent); }
.tile.done { opacity: 0.5; }
.thumb { display: block; height: 160px; overflow: hidden; border-radius: 5px;
  background: var(--matte-alt); }
.thumb img { display: block; width: 100%; height: auto; }
.thumb.text { display: flex; align-items: center; justify-content: center; }
.tile-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tile-title { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.tile-sub { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px;
  font-variant-numeric: tabular-nums; }
.tile-dims { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.story { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px;
  background: var(--surface); overflow: hidden; position: relative; }
.story > summary { cursor: pointer; padding: 9px 12px; display: flex; gap: 10px;
  align-items: center; list-style: none; }
.story > summary::-webkit-details-marker { display: none; }
.story > summary::before { content: "\\25B8"; color: var(--muted); font-size: 11px; }
.story[open] > summary::before { content: "\\25BE"; }
.title { font-weight: 600; font-size: 14px; }
.sub { color: var(--muted); font-size: 12px; }
.anchor { position: absolute; top: 8px; right: 12px; background: transparent; border: 0;
  color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px;
  border-radius: 4px; }
.anchor:hover { color: var(--accent); background: var(--raised); }
/* The copy-link button sits over the summary's right end but is not inside it: a control
   nested in <summary> hijacks its toggling and is unreachable for assistive tech. The
   badge keeps the right edge clear of it. */
.story > summary .badge { margin-left: auto; margin-right: 26px; }

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
/* One control sets the comparison for every capture on the page; each capture's own buttons
   still override just that capture until the next page-wide choice. */
.viewall { display: flex; gap: 4px; align-items: center; margin-left: auto; }
.viewall > span { color: var(--muted); font-size: 12px; margin-right: 2px; }
.viewall[hidden] { display: none; }
.modes button, .viewall button, .mark { background: transparent; border: 1px solid var(--line);
  color: var(--muted); border-radius: 5px; padding: 3px 9px; font: inherit; font-size: 12px;
  cursor: pointer; }
.modes button[aria-pressed="true"], .viewall button[aria-pressed="true"],
.mark[aria-pressed="true"] { border-color: var(--accent);
  color: var(--accent); }
.modes button:hover, .viewall button:hover, .mark:hover { background: var(--raised); }

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
      &middot; <b>&#8679;1&ndash;4</b> all &middot; <b>r</b> reviewed &middot; <b>o</b>
      overview</div>
  </div>
  <div class="tools">
    <div class="totals" id="filters"></div>
    <input class="search" id="q" type="search" placeholder="Filter stories" autocomplete="off"
      spellcheck="false" aria-label="Filter stories">
    <span class="progress" id="progress" aria-live="polite"></span>
    <span id="acceptvisible"></span>
    <div class="viewall" id="viewall" role="group" aria-label="Comparison mode for every capture"
      hidden></div>
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

/* The comparison mode chosen for the whole page. A capture that cannot show it — one with no
   diff image, or no baseline to compare against — keeps its own default instead of going blank. */
const ALL_MODES = ['Overlay', 'Side by side', 'Swipe', 'Onion-skin'];
let preferred = ALL_MODES[0];

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

// One measure for the ordering and the meters: differing pixels. Ranking captures by ratio
// instead left the two disagreeing — a story led the list while its meter sat below another's.
const maxDiffPixels = data.captures.reduce((m, c) => Math.max(m, c.diffPixels || 0), 0);

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
  b.onclick = () => { active = key; applyFilter(); };
  return b;
}
filters.appendChild(chip('review', 'Needs review'));
for (const s of order) if (counts[s]) filters.appendChild(chip(s, LABEL[s], s));
filters.appendChild(chip('all', 'All'));

searchEl.oninput = () => { query = searchEl.value.trim().toLowerCase(); applyFilter(); };

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

/* Past the embed budget the artifacts exist as files but never made it into the report.
   "No image artifacts" would be false — the line says why they are absent and where they
   are, relative to the report itself. */
function truncatedNote(capture, parent) {
  const p = document.createElement('p');
  p.className = 'note';
  const where = capture.artifacts.actual || capture.artifacts.expected || capture.artifacts.diff;
  p.append('Images not embedded to keep this report openable — see ');
  const code = document.createElement('code');
  code.textContent = where || '';
  p.appendChild(code);
  parent.appendChild(p);
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
    box.appendChild(picture(img.actual || img.expected, 'This run'));
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
    // matrix reads as a fault report. Only an absence that needs explaining gets a line —
    // and images left unembedded are files that exist, so the line points at them rather
    // than claiming they are missing.
    if (capture.truncated) truncatedNote(capture, el);
    else if (REVIEW.has(capture.status)) {
      el.className = 'note';
      el.textContent = 'No image artifacts for this capture.';
    }
    return { el, modes: null, setMode: null, nudge: null };
  }

  const body = document.createElement('div');
  let current = modes.includes(preferred) ? preferred : modes[0];
  let slider = null;
  // Alt text names what a tool that cannot see the image is reading out; the baseline also
  // names the story and width, because that pair is what a reviewer quotes back.
  const baselineAlt = 'Baseline of ' + capture.storyId + ' at ' + capture.width + 'px';

  function picture(src, alt) {
    const i = document.createElement('img');
    i.loading = 'lazy';
    i.decoding = 'async';
    i.alt = alt;
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
      box.appendChild(picture(current === 'Overlay' ? img.diff : img.actual,
        current === 'Overlay' ? 'Difference highlight' : 'This run'));
      body.appendChild(box);
    } else if (current === 'Side by side') {
      const pair = document.createElement('div');
      pair.className = 'pair';
      for (const [src, cap, alt] of [[img.expected, 'Baseline', baselineAlt], [img.actual, 'This run', 'This run']]) {
        const f = document.createElement('figure');
        const c = document.createElement('figcaption');
        c.textContent = cap;
        const s = document.createElement('div');
        s.className = 'stage';
        s.appendChild(picture(src, alt));
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
      const base = picture(img.expected, baselineAlt);
      const top = picture(img.actual, 'This run');
      top.className = 'top';
      wrap.append(base, top);
      box.appendChild(wrap);
      slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = '50';
      slider.setAttribute('aria-label', current === 'Swipe' ? 'Swipe divider position' : 'Overlay opacity');
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
  // Some of the capture's images may have fit the budget while the rest did not; what was
  // shown still deserves the pointer to the files next to it.
  if (capture.truncated) truncatedNote(capture, el);

  return {
    el,
    modes: bar,
    setMode: (i) => select(modes[i]),
    follow: (m) => select(modes.includes(m) ? m : modes[0]),
    nudge: (step) => {
      if (!slider) return;
      slider.value = String(Math.min(100, Math.max(0, Number(slider.value) + step)));
      slider.oninput();
    },
  };
}

/** Every capture entry, built once; filtering after that only shows and hides them. */
const entries = [];
const storyEls = [];
/** Overview tiles, one per capture needing review — built once and hidden, never rebuilt. */
const tiles = [];
/** The visible captures in reading order — the target list for j/k. */
let flat = [];

const viewAllEl = document.getElementById('viewall');
function setPreferred(m) {
  preferred = m;
  for (const b of viewAllEl.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.textContent === m));
  }
  // Only captures already drawn need redrawing; the rest read the choice when they are built.
  // Every entry, not just the visible ones: a capture hidden by a filter keeps the choice
  // for when it is shown again.
  for (const entry of entries) if (entry.built && entry.built.follow) entry.built.follow(m);
}
// The page-wide control is offered only when some capture has two renders to compare; a run of
// new captures alone has nothing it could switch between.
if (data.captures.some(c => c.status !== 'new' && c.images && c.images.expected && c.images.actual)) {
  const label = document.createElement('span');
  label.textContent = 'All:';
  viewAllEl.appendChild(label);
  for (const m of ALL_MODES) {
    const b = document.createElement('button');
    b.textContent = m;
    b.setAttribute('aria-pressed', String(m === preferred));
    b.onclick = () => setPreferred(m);
    viewAllEl.appendChild(b);
  }
  viewAllEl.hidden = false;
}

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
  if (entry.tile) entry.tile.classList.toggle('done', reviewed.has(key));
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

const out = document.getElementById('out');
// Everything filterable lives in the list; the empty-state line sits beside it, with one of
// the two always hidden.
const listEl = document.createElement('div');
const emptyEl = document.createElement('p');
emptyEl.className = 'empty';
emptyEl.hidden = true;

/* The overview is a contact sheet above the list: one tile per capture needing review, so a
   run too large to scroll capture by capture can still be taken in at a glance. Unlike
   triage — remembered per run, because it describes that run's pixels — collapsed or
   expanded is a preference about the interface, so it is kept per browser. */
const overviewEl = document.createElement('section');
overviewEl.className = 'overview';
overviewEl.setAttribute('aria-label', 'Captures needing review');
const ovToggle = document.createElement('button');
ovToggle.className = 'ov-toggle';
ovToggle.id = 'ov-toggle';
ovToggle.textContent = 'Overview';
ovToggle.setAttribute('aria-expanded', 'false');
ovToggle.setAttribute('aria-controls', 'ov-sheet');
const sheetEl = document.createElement('div');
sheetEl.className = 'sheet';
sheetEl.id = 'ov-sheet';
overviewEl.append(ovToggle, sheetEl);
out.append(overviewEl, listEl, emptyEl);

const OV_STORE = 'diopsis:overview';
// Expanded only once there are enough captures to be worth a glance over; a small run reads
// faster starting at the captures themselves.
let overviewCollapsed = data.captures.filter(c => REVIEW.has(c.status)).length <= 3;
try {
  const stored = localStorage.getItem(OV_STORE);
  if (stored !== null) overviewCollapsed = stored === 'collapsed';
} catch (e) { /* private mode */ }
function applyOverview() {
  ovToggle.setAttribute('aria-expanded', String(!overviewCollapsed));
  sheetEl.hidden = overviewCollapsed;
}
function setOverviewCollapsed(collapsed) {
  overviewCollapsed = collapsed;
  try { localStorage.setItem(OV_STORE, collapsed ? 'collapsed' : 'expanded'); } catch (e) { /* private mode */ }
  applyOverview();
}
ovToggle.onclick = () => setOverviewCollapsed(!overviewCollapsed);

/* Filtering hides and shows what was built once. Rebuilding on every keystroke threw away
   every drawn image stage — and with it the comparison mode and zoom a reviewer had already
   chosen — to change nothing but which rows are on screen. */
function applyFilter() {
  for (const b of filters.children) {
    const key = b.dataset.key;
    b.setAttribute('aria-pressed', String(key === active));
    b.querySelector('.n').textContent =
      data.captures.filter(c => inSearch(c) && inFilter(c, key)).length;
  }

  for (const entry of entries) {
    entry.box.hidden = !inSearch(entry.capture) || !inFilter(entry.capture, active);
  }
  // A story stays on the page while any of its captures does; its other rows hide with it.
  for (const story of storyEls) story.el.hidden = story.entries.every(e => e.box.hidden);
  flat = entries.filter(e => !e.box.hidden && !e.story.hidden);
  cursor = -1;

  // The sheet mirrors the list capture by capture: the same filter and search decide which
  // tiles show, and with none left the overview steps aside entirely.
  let shownTiles = 0;
  for (const tile of tiles) {
    tile.el.hidden = tile.entry.box.hidden;
    if (!tile.el.hidden) shownTiles += 1;
  }
  overviewEl.hidden = shownTiles === 0;
  ovToggle.textContent = 'Overview · ' + shownTiles;

  // With nothing to show, the whole list — its accept-everything footer included — steps
  // aside for one line that says so.
  const empty = flat.length === 0;
  listEl.hidden = empty;
  emptyEl.hidden = !empty;
  emptyEl.textContent = query
    ? 'No story matches "' + query + '".'
    : 'Nothing here. Every capture matched its baseline.';
  drawAcceptVisible(empty ? [] : storyEls.filter(s => !s.el.hidden).map(s => s.id));
}

function buildAll() {
  const byStory = new Map();
  for (const c of data.captures) {
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
    const storyEntry = { el: det, id: storyId, entries: [] };

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
    // A reviewer's finding has to survive the trip into a pull-request comment. The button
    // sits over the summary's right end but is a sibling of it — see the .anchor style — so
    // a click needs no defending against the summary's own toggling.
    const anchor = document.createElement('button');
    anchor.className = 'anchor';
    anchor.textContent = '#';
    anchor.title = 'Copy a link to this story';
    anchor.setAttribute('aria-label', 'Copy a link to this story');
    anchor.onclick = async () => {
      location.hash = det.id;
      try { await navigator.clipboard.writeText(location.href); anchor.textContent = 'copied'; }
      catch (err) { anchor.textContent = location.hash; }
      setTimeout(() => (anchor.textContent = '#'), 1600);
    };
    sum.append(t, s, badge);
    det.append(sum, anchor);

    for (const c of captures) {
      const box = document.createElement('div');
      box.className = 'capture' + (reviewed.has(keyOf(c)) ? ' done' : '');

      const bar = document.createElement('div');
      bar.className = 'bar';
      const w = document.createElement('span');
      w.className = 'w';
      // Playwright states its ratio rounded to two decimals, so a small change can arrive as
      // "0.00%" — a number that says nothing moved. Where the actual image's pixel size is
      // known the share is recomputed from the pixels; where it is not, a share that would
      // print as zero is left out rather than shown as one.
      let share = null;
      if (c.diffPixels != null) {
        const pixels = c.size ? c.size.width * c.size.height : 0;
        if (pixels > 0) share = (c.diffPixels / pixels) * 100;
        else if (c.diffRatio != null && c.diffRatio * 100 >= 0.005) share = c.diffRatio * 100;
      }
      w.textContent = c.width + 'px' + (c.diffPixels == null
        ? ''
        : ', ' + c.diffPixels.toLocaleString() + ' px differ' +
          (share == null ? '' : ' (' + Number(share.toPrecision(2)) + '%)'));
      bar.appendChild(w);

      if (c.diffPixels != null && maxDiffPixels > 0) {
        const meter = document.createElement('div');
        meter.className = 'meter';
        meter.title = "Share of this run's largest pixel difference";
        const fill = document.createElement('i');
        fill.style.width = Math.max(4, (c.diffPixels / maxDiffPixels) * 100) + '%';
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
      entries.push(entry);
      storyEntry.entries.push(entry);
    }

    const build = () => { for (const e of storyEntry.entries) e.build(); };
    det.addEventListener('toggle', () => { if (det.open) build(); });
    if (det.open) build();

    if (captures.some(c => REVIEW.has(c.status))) {
      const foot = document.createElement('div');
      foot.className = 'capture';
      foot.appendChild(copyButton('npx diopsis accept ' + storyId));
      det.appendChild(foot);
    }
    storyEls.push(storyEntry);
    listEl.appendChild(det);
  }

  if (data.changedStories.length) {
    const all = document.createElement('div');
    all.style.marginTop = '18px';
    all.appendChild(copyButton('npx diopsis accept'));
    listEl.appendChild(all);
  }
  if (data.truncated) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = data.truncated + ' capture(s) had images omitted to keep this file openable.';
    listEl.appendChild(n);
  }
}

/* One tile per capture needing review, in the list's own order — worst story first, largest
   change first. Each thumbnail reuses a data URI the report already carries: the sheet
   multiplies what there is to see, not the size of the file. */
function buildOverview() {
  for (const entry of entries) {
    const c = entry.capture;
    if (!REVIEW.has(c.status)) continue;
    const tile = document.createElement('button');
    tile.className = 'tile' + (reviewed.has(keyOf(c)) ? ' done' : '');
    tile.dataset.key = keyOf(c);

    // A tile shows the one image that says why the capture is here — the highlight for a
    // change, the single render for a new capture — and the status as text when there is no
    // image to show: nothing rendered, or images the embed budget left out.
    const img = c.images || {};
    const src = c.status === 'changed' ? img.diff
      : c.status === 'new' ? (img.actual || img.expected) : null;
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    if (src) {
      const i = document.createElement('img');
      i.loading = 'lazy';
      i.decoding = 'async';
      i.alt = (c.status === 'changed' ? 'Difference thumbnail of ' : 'First render of ') +
        c.storyTitle + ' › ' + c.storyName + ' at ' + c.width + 'px';
      i.src = src;
      thumb.appendChild(i);
    } else {
      thumb.classList.add('text');
      const st = document.createElement('span');
      st.className = 'badge s-' + c.status;
      st.textContent = LABEL[c.status];
      thumb.appendChild(st);
    }

    const meta = document.createElement('span');
    meta.className = 'tile-meta';
    const titleEl = document.createElement('span');
    titleEl.className = 'tile-title';
    const name = c.storyTitle + ' › ' + c.storyName;
    titleEl.textContent = name;
    titleEl.title = name;
    const sub = document.createElement('span');
    sub.className = 'tile-sub';
    const dot = document.createElement('span');
    dot.className = 'dot c-' + c.status;
    const dims = document.createElement('span');
    dims.className = 'tile-dims';
    dims.textContent = c.width + 'px' +
      (c.status === 'changed' && c.diffPixels != null
        ? ' · ' + c.diffPixels.toLocaleString() + ' px differ' : '');
    sub.append(dot, dims);
    meta.append(titleEl, sub);
    tile.append(thumb, meta);

    // Landing from the sheet behaves like arriving by j/k: the story opens, the capture
    // scrolls into view and the cursor sits on it.
    tile.onclick = () => {
      const at = flat.indexOf(entry);
      if (at >= 0) setCursor(at);
    };

    sheetEl.appendChild(tile);
    tiles.push({ el: tile, entry });
    entry.tile = tile;
  }
}

/* A link into the report has to land even when the current filter excludes its target. Every
   story is built — a filtered-out one is hidden, not absent — so a hidden target widens the
   view once and tries again rather than scrolling nowhere. */
function focusHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id.startsWith('story-')) return;
  const target = document.getElementById(id);
  if (target && target.hidden) {
    active = 'all';
    query = '';
    searchEl.value = '';
    applyFilter();
  }
  if (!target) return;
  target.open = true;
  target.scrollIntoView({ block: 'start' });
}

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLElement &&
    (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  if (e.key === 'Escape') {
    if (typing) { searchEl.value = ''; query = ''; searchEl.blur(); applyFilter(); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
  // Only the horizontal arrows are ours, and only for the current capture's slider; the
  // vertical ones stay with the page, so a keyboard user can still scroll a long report.
  if (e.key === 'j') { e.preventDefault(); setCursor(cursor + 1); return; }
  if (e.key === 'k') { e.preventDefault(); setCursor(cursor - 1); return; }
  if (e.key === 'o') { e.preventDefault(); setOverviewCollapsed(!overviewCollapsed); return; }
  // Shift turns a number into a page-wide choice. The code, not the key, identifies the digit:
  // with Shift held the key reads as whatever symbol the layout puts above it.
  const digit = /^Digit([1-4])$/.exec(e.code);
  if (digit && e.shiftKey) {
    if (viewAllEl.hidden) return;
    e.preventDefault();
    setPreferred(ALL_MODES[Number(digit[1]) - 1]);
    return;
  }
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

buildAll();
buildOverview();
applyFilter();
applyOverview();
drawProgress();
focusHash();
`;
