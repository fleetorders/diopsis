# Diopsis

<div align="center">
  <img src="https://raw.githubusercontent.com/fleetorders/diopsis/main/media/diopsis-logo.png" width="520" alt="Diopsis — a baseline render and the current one, and the lens between them showing the row that moved">
  <p>
    <a href="https://www.npmjs.com/package/diopsis"><img src="https://img.shields.io/npm/v/diopsis.svg?label=npm&color=cb3837" alt="npm version"></a>
    <a href="https://github.com/fleetorders/diopsis/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/fleetorders/diopsis/ci.yml?branch=main&label=CI" alt="CI"></a>
    <a href="https://github.com/fleetorders/diopsis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  </p>
</div>

**See every pixel your change moved, before anyone else does.**

You nudged a card's padding. Somewhere across two hundred stories, four of them shifted too —
and you will find out in review, or you will not find out at all. The screenshot part is easy;
what breaks is everything around it. A live clock, a font that loads late, an animation caught
mid-flight, and the suite fails for reasons nobody believes, so the team mutes it. Then when a
run does fail honestly, no git forge will render a pixel-level image diff, so the reviewer sees
"screenshot changed" and two files that tell them nothing.

Diopsis screenshots your built static Storybook and diffs each story against baselines committed
in your own repository.

```console
$ npx diopsis run
Diopsis · 7 stories → 13 captures · darwin-arm64
  config    diopsis.config.ts
  storybook storybook-static
  baselines __screenshots__

  8 unchanged · 5 changed

  ~ card--default @320  2,684 px differ
  ~ card--default @1280  3,150 px differ
  ~ card--long @320  6,328 px differ
  ~ card--long @1280  6,212 px differ
  ~ card--wide-only @1280  3,204 px differ

  report   .diopsis/report.html
  summary  .diopsis/summary.json

  Accept as the new baseline:  npx diopsis accept
```

And when something did change, the report shows you exactly what — baseline beside current
render, changed stories first:

<div align="center">
  <img src="https://raw.githubusercontent.com/fleetorders/diopsis/main/media/diopsis-report.png" width="920" alt="The Diopsis report: filter chips for changed and unchanged captures, above a story showing its committed baseline and current render side by side">
</div>

Needs Node 18+, a built static Storybook, and `@playwright/test` as a peer dependency; runs on
macOS, Windows and Linux, but baselines CI will agree with are generated in Linux via Docker.
Chromium only — no cross-browser matrix, no interaction testing, no accessibility audit, and no
hosted service of any kind.

## Your first run

Build your Storybook first — `npm run build-storybook` in a standard setup — then:

```bash
npm install --save-dev diopsis @playwright/test
npx playwright install chromium
npx diopsis init      # writes the config, git settings and a CI recipe
npx diopsis update    # generate the first baselines from the build
git add __screenshots__ && git commit -m "Add visual baselines"
```

From here `npx diopsis run` verifies every story against what you committed.

`@playwright/test` is a **peer** dependency deliberately: browsers are downloaded once, and
there is never a second copy on a different version. Diopsis itself has zero runtime
dependencies. Node 18 or newer; a TypeScript config file needs Node 22.18+, where Node can
strip types on its own — below that, `diopsis init` writes `diopsis.config.mjs` instead,
the same object without the annotations.

<details>
<summary>Setting up with an AI agent? Paste this prompt.</summary>

```
Set up diopsis, a visual regression tool, in this project. Install diopsis and
@playwright/test as dev dependencies, run `npx playwright install chromium`,
then `npx diopsis init`. Build the project's static Storybook (a standard setup
has a build-storybook script). Then run `npx diopsis update` to generate first
baselines, commit the __screenshots__ directory, and run `npx diopsis run` —
it should report every capture unchanged.

To demonstrate a real detection: make a small visible style change to any
component, rebuild the Storybook, and run `npx diopsis run` again — it should
list the changed captures with pixel counts and exit non-zero. Revert the
change afterwards.
# Human steps, not yours: open .diopsis/report.html in a browser to review
# the visual diff, and run `npx diopsis accept` only when a change is wanted.
```

</details>

## What you get

| | |
|---|---|
| **Captures that do not flake** | A frozen clock, settled fonts and images, animations disabled, locale and timezone pinned — [all on by default](#configuration) |
| **Baselines that cannot collide** | Platform and architecture in every snapshot path, so a local run can never overwrite what CI reads |
| **A diff you can actually review** | A self-contained HTML report with [four ways to compare](#everyday-use) each pair, largest change first, filterable and keyboard-driven |
| **A machine-readable result** | `summary.json` with every capture and changed story id, for your existing CI bot |
| **Visible cost** | [`diopsis doctor`](#reference) reports capture count, baseline weight and orphans before they become a problem |
| **Nothing to sign up for** | Zero runtime dependencies, no uploads, no account, no dashboard |

## How it works, in plain words

Diopsis reads the *built output* of your Storybook, never your source. It takes the story index
the build already produced, expands each story across your configured widths, serves the folder
from a small built-in web server, and photographs each story in Chromium.

The unit that matters is the **capture**, not the story. Ninety stories across four widths is
360 captures, and every cost that matters — how long a run takes, how much your repository
weighs, how much there is to review — scales with captures. Diopsis counts them that way
everywhere, so the number you see is the number you pay.

Each capture is compared against a PNG committed in your repository at a path carrying the
platform that produced it. That is the whole model: your baselines are files in your repo,
reviewed in your pull request, with no state anywhere else. Accepting a change is copying a
file and committing it.

## Setup

`npx diopsis init` scaffolds everything and prints what your viewport matrix will cost, which is
the moment that decision is cheap:

```console
$ npx diopsis init

Cost of the matrix, for this Storybook:

  widths                     captures    estimated weight
  1280                            7    560 KB
  320, 1280                      13    1.0 MB   (configured)
  320, 768, 1024, 1280           25    2.0 MB
```

It writes `diopsis.config.ts`, marks baselines binary and unmergeable in `.gitattributes` so a
rebase conflicts loudly instead of silently producing a corrupt PNG, ignores the run output, and
prints a CI recipe pinned to the same image your config names.

### Configuration

```ts
import type { UserConfig } from 'diopsis';

export default {
  storybookDir: 'storybook-static',
  snapshotDir: '__screenshots__',
  viewports: { default: [320, 1280] },
  viewportHeight: 900,
  image: 'mcr.microsoft.com/playwright:v1.62.1-jammy',
  stabilize: {
    freezeClock: '2026-01-15T12:00:00Z',
    waitForNetworkIdle: true,
    disableAnimations: true,
  },
  mask: ['[data-diopsis-ignore]'],
  compare: { threshold: 0.2, maxDiffPixelRatio: 0.001 },
} satisfies UserConfig;
```

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

### Excluding genuinely random pixels

Mark the element with `data-diopsis-ignore` — a map tile, a video, a canvas. That is the only
ignore attribute Diopsis recognises.

Prefer deleting an annotation to renaming one. Because the clock is frozen, anything that
existed only to hide a date or a changing year does not need to be masked at all. And a mask is
weaker than it looks: it hides content from the reviewer, and it still fails the comparison when
the masked element's own bounding box moves.

## Everyday use

**Verify** — `npx diopsis run`. Exits non-zero when anything changed, so CI fails.

**Review** — `npx diopsis report` opens the last report, pictured at the top of this page. It
is one self-contained HTML file, so it also opens straight from a CI artifact with nothing
beside it, and it follows whichever theme your system is set to. Every capture offers the same
pair four ways: **diff-highlight overlay** — the default, because it answers "what changed?"
with no interaction — plus side-by-side, swipe, and onion-skin. Click a capture to stop fitting
it to the page and see it at actual size, which is the only way a one-pixel shift survives
being looked at. Unchanged stories stay collapsed, the largest change leads, and each changed
story carries the exact command to accept it.

A few hundred captures are meant to be worked through rather than scrolled past, so the report
filters by story, remembers which captures you have already ticked off, and gives every story
its own link to paste into the review. From the keyboard: `/` filters, `j` and `k` move between
captures, `1`–`4` switch how the pair is compared, and `r` ticks one off.

**Accept** — `npx diopsis accept` adopts the whole run, or `npx diopsis accept card--default`
adopts one story. Both copy the new images over the baselines and stage them for review.

**Regenerate** — `npx diopsis update` rewrites baselines wholesale, for when you already know
everything changed.

Add `--grep <text>` to any of these to limit the run to stories whose id contains `<text>`.

## Reference

| Command | What it does |
|---|---|
| `diopsis init` | Scaffold config, git settings and a CI recipe; print what the matrix costs |
| `diopsis run` | Verify against committed baselines *(default command)* |
| `diopsis update` | Regenerate baselines |
| `diopsis accept [story-id]` | Adopt the last run's output, per story or wholesale |
| `diopsis report` | Open the last report |
| `diopsis doctor` | Audit the setup |

| Flag | Applies to | Effect |
|---|---|---|
| `--grep <text>` | `run`, `update` | Only stories whose id contains `<text>` |
| `--keep` | `run`, `update` | Keep the generated Playwright project for inspection |
| `--force` | `init` | Overwrite an existing config |
| `--lfs` | `init` | Set the baselines up for Git LFS |
| `--no-stage` | `accept` | Write the files without staging them in git |

| Config key | Default | Meaning |
|---|---|---|
| `storybookDir` | `storybook-static` | The built Storybook to read |
| `snapshotDir` | `__screenshots__` | Where baselines are committed |
| `viewports` | `{ default: [320, 1280] }` | Named sets of widths; `default` applies to untagged stories |
| `viewportHeight` | `900` | Viewport height; captures are full-page |
| `fullPage` | `true` | Capture the whole scrollable page rather than the viewport |
| `image` | Playwright's Jammy image | The one image name baseline generation and CI must share |
| `stabilize.freezeClock` | `2026-01-15T12:00:00Z` | Fixed wall-clock time, or `false` |
| `stabilize.waitForNetworkIdle` | `true` | Wait for the network to settle |
| `stabilize.disableAnimations` | `true` | Zero out animations and transitions |
| `stabilize.waitForFonts` | `true` | Wait for `document.fonts.ready` |
| `stabilize.waitForImages` | `true` | Wait for every image to decode |
| `stabilize.waitForLoadingStates` | `true` | Wait for `aria-busy` and progressbars to clear |
| `stabilize.settleTimeout` | `15000` | Ceiling on the whole stabilization sequence, ms |
| `mask` | `['[data-diopsis-ignore]']` | Selectors painted over before comparison |
| `compare.threshold` | `0.2` | Per-pixel colour tolerance, 0–1 |
| `compare.maxDiffPixelRatio` | `0.001` | Share of differing pixels tolerated |
| `timeout` | `30000` | Per-capture timeout, ms |
| `workers` | Playwright's default | Parallel workers |
| `outputDir` | `.diopsis` | Where the report and summary are written |

`diopsis doctor` audits all of it:

```console
$ npx diopsis doctor

Diopsis doctor

  · Baseline image is pinned
      mcr.microsoft.com/playwright:v1.62.1-jammy — the CI job must name this exact image.
  · 7 stories → 13 captures
      Widths default: 320, 1280
  · 13 baselines, 116 KB
      Every intentional change adds another set to history permanently — this figure only grows.
  · Every baseline carries a platform and architecture
      This machine writes darwin-arm64.
  · No orphaned baselines for this platform
  · Baselines are marked unmergeable in .gitattributes

Everything checks out.
```

It also reports baselines for stories that no longer exist, baselines missing a platform suffix,
a `.gitignore` that excludes your baselines, and another tool's ignore attribute left behind by
a migration.

## Programmatic use

`diopsis run` exits `0` when every capture matched its baseline and `1` otherwise — a changed
capture, a missing baseline, a story that failed to render, or nothing to capture at all. That
single code is the whole CI contract; everything richer is in `summary.json`.

### `summary.json`

Written beside the report on every run. This is the contract to build against — a PR bot, a
dashboard, or an agent wiring Diopsis into something else reads this, not the terminal.

```json
{
  "diopsis": 1,
  "createdAt": "2026-08-06T20:22:16.947Z",
  "platform": "darwin",
  "arch": "arm64",
  "mode": "run",
  "snapshotDir": "__screenshots__",
  "totals": {
    "stories": 7, "captures": 13,
    "unchanged": 8, "changed": 5, "new": 0, "renderFailed": 0, "failed": 0
  },
  "changedStories": ["card--default", "card--long", "card--wide-only"],
  "captures": [
    {
      "storyId": "card--default",
      "storyTitle": "Card",
      "storyName": "Default",
      "width": 320,
      "status": "changed",
      "snapshotPath": "card--default/320w-darwin-arm64.png",
      "diffPixels": 2684,
      "diffRatio": 0.03,
      "error": "Error: expect(page).toHaveScreenshot(expected) failed\n\n  2684 pixels ...",
      "artifacts": {
        "actual": "test-results/diopsis-card--default-320-chromium/card--default/320w-darwin-arm64-actual.png",
        "diff": "test-results/diopsis-card--default-320-chromium/card--default/320w-darwin-arm64-diff.png",
        "expected": "../__screenshots__/card--default/320w-darwin-arm64.png"
      }
    },
    {
      "storyId": "nondeterminism--animation",
      "storyTitle": "Nondeterminism",
      "storyName": "Animation",
      "width": 320,
      "status": "unchanged",
      "snapshotPath": "nondeterminism--animation/320w-darwin-arm64.png",
      "artifacts": {
        "expected": "../__screenshots__/nondeterminism--animation/320w-darwin-arm64.png"
      }
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `diopsis` | `1` | Format version. Bumped only on a breaking change to this shape |
| `createdAt` | ISO-8601 string | When the run started |
| `platform` / `arch` | string | The `process.platform` and `process.arch` that produced the run — the same pair in every `snapshotPath` |
| `mode` | `"run"` \| `"update"` | Whether baselines were verified or regenerated |
| `snapshotDir` | string | The configured baseline directory, as written |
| `totals` | object | Counts per status, plus `captures` and the distinct `stories` behind them |
| `changedStories` | string[] | Story ids with at least one capture needing review, sorted. Usually all a bot needs |
| `captures` | object[] | **Every capture the run planned**, in plan order — not only the interesting ones |

Per capture: `status` is one of `unchanged`, `changed`, `new`, `render-failed`, `failed`.
`diffPixels` and `diffRatio` appear only when the comparator reported them, `error` only when
something failed, and `artifacts` holds whichever of `expected`, `actual` and `diff` exist, as
paths **relative to `outputDir`** so a run stays portable when the directory is moved or
downloaded from CI.

Two things are deliberate. `captures` lists the full set rather than only the changed ones, so a
consumer can diff one run's coverage against another's. And `status` is not Playwright's
pass/fail: "a baseline did not exist yet" and "this looks different" both present as a failing
test and call for opposite responses, so they are separate states here.

## Troubleshooting

**Every capture fails the first time you run in CI.** Your baselines were generated on a
different operating system. Screenshots are OS-specific; generate them in the image your CI job
uses. `diopsis doctor` prints which platforms your baseline sets were built on.

**Baselines match locally on an Apple Silicon Mac but differ slightly in CI.** `arm64` and
`amd64` renders are not identical
([playwright#13873](https://github.com/microsoft/playwright/issues/13873)). A container on an
ARM host gets you close, not exact. Generate the authoritative set on the same architecture CI
runs, and treat `compare.maxDiffPixelRatio` as the lever if a genuine parity gap remains.

**`Cannot read diopsis.config.ts on Node <version>`.** A TypeScript config is loaded by Node's
own type stripping, which needs Node 22.18 or newer. Upgrade Node, or rename the file to
`diopsis.config.mjs` and delete the type annotations.

**`Cannot find @playwright/test`.** It is a peer dependency and is not installed for you:
`npm install --save-dev @playwright/test`, then `npx playwright install chromium`.

**`No story index in storybook-static`.** `storybookDir` is not pointing at a Storybook build.
It must be the output directory of `storybook build`, containing `index.json` and `iframe.html`.

**A story is captured mid-skeleton.** Stabilization waits for `aria-busy`, progressbars, fonts
and images. A custom loading state with none of those markers is invisible to it — put
`aria-busy="true"` on the container while it loads.

## Roadmap

What's next lives in [ROADMAP.md](ROADMAP.md); every design decision, and what was
deliberately ruled out, is recorded in [DECISIONS.md](DECISIONS.md).

## License

[MIT](LICENSE)
