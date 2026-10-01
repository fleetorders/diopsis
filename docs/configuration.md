# Configuration reference

Every config key, and the settings a story sets for itself with a `diopsis:` tag. The
[README](../README.md#setup) shows the first config; this page is the whole of it.

## Config keys

| Config key | Default | Meaning |
|---|---|---|
| `storybookDir` | `storybook-static` | The built Storybook to read |
| `snapshotDir` | `__screenshots__` | Where baselines are committed |
| `viewports` | `{ default: [320, 1280] }` | Named sets of widths; `default` applies to untagged stories |
| `viewportHeight` | `900` | Viewport height; captures are full-page |
| `fullPage` | `true` | Capture the whole scrollable page rather than the viewport |
| `image` | Playwright's Jammy image | The one image name baseline generation and CI must share |
| `stabilize.freezeClock` | `2026-01-15T12:00:00Z` | Fixed wall-clock time, or `false` |
| `stabilize.waitForNetworkIdle` | `true` | Wait until no request is in flight and no short timer that could start one is pending |
| `stabilize.waitForPlay` | `true` | Capture after the story's play function finishes; a play function that fails is a render failure |
| `stabilize.retries` | `1` | Take a differing capture again from a fresh load; one that then matches is reported unstable and does not fail the run |
| `stabilize.disableAnimations` | `true` | Zero out animations and transitions |
| `stabilize.waitForFonts` | `true` | Wait for `document.fonts.ready` |
| `stabilize.waitForImages` | `true` | Wait for every image to decode |
| `stabilize.waitForLoadingStates` | `true` | Wait for `aria-busy` and progressbars to clear |
| `stabilize.settleTimeout` | `15000` | Ceiling on the whole stabilization sequence, ms |
| `mask` | `['[data-diopsis-ignore]']` | Selectors painted over before comparison |
| `capture` | `page` | `component` photographs the rendered component instead of the whole canvas |
| `modes` | none | Named sets of Storybook globals; each story is also captured in each set |
| `accessibility` | `off` | `report` lists axe-core findings beside the pixels; `fail` fails a run on new findings |
| `budget` | none | `{ weight: '25 MB', captures: 800 }` — doctor fails past either, and warns at 90% |
| `compress` | `off` | `auto` recompresses every baseline `update` and `accept` write, losslessly and verified pixel by pixel, when [oxipng](https://github.com/oxipng/oxipng) is installed |
| `compare.threshold` | `0.2` | Per-pixel colour tolerance, 0–1 |
| `compare.maxDiffPixelRatio` | `0.001` | Share of differing pixels tolerated |
| `compare.maxDiffPixels` | unset | Number of differing pixels tolerated; with the ratio, the stricter applies |
| `timeout` | `30000` | Per-capture timeout, ms |
| `workers` | Playwright's default | Parallel workers |
| `outputDir` | `.diopsis` | Where the report and summary are written |


## Per-story settings

A setting a story carries for itself is a `diopsis:` tag in its `tags`, read from the built
index.

### Per-story viewports

Override widths with a story tag rather than a map kept somewhere else — the story index
serialises `tags` but not `parameters`, so an external map drifts silently and nobody notices.

```ts
export const WideOnly = { tags: ['diopsis:1280'] };      // this story, at 1280 only
export const Handheld = { tags: ['diopsis:mobile'] };    // a named set from your config
export const Untestable = { tags: ['diopsis:skip'] };    // never captured
```

A tag naming neither a width nor a configured set warns and falls back to the default widths. A
typo should not quietly stop watching a story.

### Component or page

By default a capture is the whole canvas at the configured width. With `capture: 'component'`
it is the rendered component instead — the box around everything the story drew, padded by
8 px — so the empty canvas around a button is neither stored nor compared. A story can choose
for itself with `diopsis:component` or `diopsis:page`. Switching regenerates those baselines.

### Modes

A theme, a text direction or a locale is a Storybook global. Name the combinations you ship and
every story is captured in each of them as well as in its plain form, each with its own
baselines:

```ts
modes: {
  dark: { theme: 'dark' },
  rtl: { direction: 'rtl', locale: 'ar' },
},
```

Globals reach the story through its URL, so whatever your decorators do with them is what gets
captured. `diopsis:modes=dark` limits a story to the modes it names and `diopsis:modes=none` to
its plain form. A mode multiplies captures like a width does, and `init` and `doctor` count it.
Plain captures keep the paths they always had, so adding a mode leaves existing baselines valid.

### Hover, focus and press

A pointer or keyboard state is captured by naming the element it applies to:

```ts
export const Primary = {
  tags: ['diopsis:hover=button', 'diopsis:focus=button', 'diopsis:active=button'],
};
```

Each state is its own capture and baseline, at every width and mode. Focus arrives the way a
keyboard user's does, so `:focus-visible` styles show.

### Per-story tolerance

The occasional story that cannot be made deterministic — a gradient that dithers, a chart that
anti-aliases differently by a pixel — gets its own tolerance through the same channel:

```ts
export const Gradient = { tags: ['diopsis:threshold=0.3'] };        // per-pixel colour tolerance
export const Chart = { tags: ['diopsis:max-diff-pixels=400'] };     // this many pixels may differ
export const Hero = { tags: ['diopsis:max-diff-ratio=0.005'] };     // this share may differ
```

A story's pixel count or ratio replaces both configured limits for that story, so it can loosen
as well as tighten. Loosening is never silent: `run` counts the stories that compare more
loosely than the config, `doctor` names them, and `summary.json` records the comparison each
of those captures ran with.

### Excluding genuinely random pixels

Mark the element with `data-diopsis-ignore` — a map tile, a video, a canvas. That is the only
ignore attribute Diopsis recognises.

Prefer deleting an annotation to renaming one. Because the clock is frozen, anything that
existed only to hide a date or a changing year does not need to be masked at all. And a mask is
weaker than it looks: it hides content from the reviewer, and it still fails the comparison when
the masked element's own bounding box moves.

