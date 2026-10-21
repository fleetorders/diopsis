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

  ~ card--default @320  2,092 px differ
  ~ card--default @1280  1,845 px differ
  ~ card--long @320  5,914 px differ
  ~ card--long @1280  5,377 px differ
  ~ card--wide-only @1280  1,964 px differ

  report   .diopsis/report.html
  summary  .diopsis/summary.json

  Accept as the new baseline:  npx diopsis accept
```

And when something did change, the report shows you exactly what — an overview of every
change, then each one with the changed region outlined, largest change first:

<div align="center">
  <img src="https://raw.githubusercontent.com/fleetorders/diopsis/main/media/diopsis-report.png" width="920" alt="The Diopsis report: filter chips and a page-wide comparison switch above an overview of five changed captures, then a changed card with the region that moved outlined over the diff">
</div>

Needs Node 18.11+, a built static Storybook, and `@playwright/test` as a peer dependency; runs on
macOS, Windows and Linux, but baselines CI will agree with are generated in Linux via Docker.
Chromium only — no cross-browser matrix and no interaction testing. An optional accessibility
audit reports axe-core findings beside the pixels when you install `axe-core`; everything runs
locally, with no hosted service of any kind.

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
dependencies. Node 18.11 or newer; a TypeScript config file needs Node 22.18+, where Node can
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
| **Captures that do not flake** | A frozen clock, settled fonts, images, network and play functions, animations disabled, locale and timezone pinned — [all on by default](https://github.com/fleetorders/diopsis/blob/main/docs/configuration.md) — and a capture that differs only once is retaken and reported unstable, not changed |
| **Baselines that cannot collide** | Platform and architecture in every snapshot path, so a local run can never overwrite what CI reads |
| **A diff you can actually review** | A self-contained HTML report that opens on an overview of every change, outlines where each capture changed, and offers [four ways to compare](#everyday-use) each pair — keyboard-driven, with one command to accept what you reviewed |
| **Every state you ship** | Widths, [modes](https://github.com/fleetorders/diopsis/blob/main/docs/configuration.md#modes) such as a dark theme or right-to-left, hover, focus and press states, and stories captured after their play functions, each with its own baselines |
| **Reviewable baselines** | [`diopsis diff`](#everyday-use) renders a branch's baseline changes straight from git, for the pull request that accepts them |
| **A machine-readable result** | `summary.json` with every capture and changed story id, for your existing CI bot |
| **Visible cost** | [`diopsis doctor`](#reference) reports capture count and baseline weight against a budget, and `diopsis prune` removes what no capture writes any more |
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

Every key, and the settings a story sets for itself with a tag (widths, modes, hover and focus
states, tolerance, skipping), are in
[docs/configuration.md](https://github.com/fleetorders/diopsis/blob/main/docs/configuration.md).

## Everyday use

**Verify** — `npx diopsis run`. Exits non-zero when anything changed, so CI fails.

**Review** — `npx diopsis report` opens the last report, pictured at the top of this page. It
is one self-contained HTML file, so it also opens straight from a CI artifact with nothing
beside it, and it follows whichever theme your system is set to. Every capture offers the same
pair four ways: **diff-highlight overlay** — the default, because it answers "what changed?"
with no interaction — plus side-by-side, swipe, and onion-skin. In the overlay each changed
region is outlined, and `n` and `N` step through them. The toolbar switches every
capture at once, and each capture can still be switched on its own. Click a capture to stop fitting
it to the page and see it at actual size, which is the only way a one-pixel shift survives
being looked at. Unchanged stories stay collapsed, the largest change leads, and each changed
story carries the exact command to accept it.

A few hundred captures are meant to be worked through rather than scrolled past, so the report
opens with an overview — a thumbnail of every capture that needs review, click one to jump to
it — and filters by story, remembers which captures you have already ticked off, and gives every story
its own link to paste into the review. From the keyboard: `/` filters, `j` and `k` move between
captures, `1`–`4` switch how the pair is compared, `Shift`+`1`–`4` switch every capture at
once, `o` shows or hides the overview, and `r` ticks one off. Once something is ticked, one
button copies a single `accept` command for exactly the stories you reviewed — and warns when
one of them still has a changed capture you have not ticked, because accepting a story adopts
all of it. Side by side, the two renders scroll and zoom together.

**Accept** — `npx diopsis accept` adopts the whole run, or `npx diopsis accept card--default`
adopts one story; name several to adopt them together. Only changed and new captures are
adopted — one that failed to render has nothing worth keeping — and nothing is copied unless
every image the run left behind is present. The new images replace the baselines and are
staged for review.

**Regenerate** — `npx diopsis update` rewrites baselines wholesale, for when you already know
everything changed.

**Capture only what a change affects** — build Storybook with `--stats-json` and run
`npx diopsis run --changed`. Diopsis reads the module graph the build wrote, walks it from the
files your branch changed (against `origin/main`, or a ref you name) to the stories that import
them, and captures only those; every other story is carried from its baseline and listed as
carried. Anything it cannot prove harmless — Storybook's config, a lockfile, a builder config, a
file outside the graph, a missing stats file — runs everything, and says why. Baselines and
run output are never counted as changes.
`npx diopsis trace <file>` shows the chain from a file to the stories it reaches.

**Split a large run across machines** — `npx diopsis run --shard 2/4` captures one quarter of
the matrix, split by story so a story's review is never divided, into its own directory. Download
every shard into one place and `npx diopsis merge` writes one report and gives the verdict a
single run would; `npx diopsis accept --from .diopsis/merged` accepts from it.

**Review a branch's baselines** — a pull request that accepts changes shows its reviewers two
opaque PNGs per file. `npx diopsis diff` renders the same report straight from git instead:
every baseline the branch changed, added or deleted against `origin/main` (or a ref you name),
with the same comparison views and changed regions, and no browser run at all. It always exits
0 — it is for looking, not gating.

Add `--grep <text>` to `run` or `update` to limit them to stories whose id contains `<text>`.
Anything after `--` goes to Playwright unchanged, e.g. `npx diopsis run -- --workers=2`.
Playwright's own `--shard` is refused — it splits by test, not by story, and would divide a
story's review across machines.

## Reference

| Command | What it does |
|---|---|
| `diopsis init` | Scaffold config, git settings and a CI recipe; print what the matrix costs |
| `diopsis run` | Verify against committed baselines *(default command)* |
| `diopsis update` | Regenerate baselines |
| `diopsis accept [story-id...]` | Adopt the last run's output, for the named stories or wholesale |
| `diopsis report` | Open the last report |
| `diopsis doctor` | Audit the setup |
| `diopsis prune` | List baselines no capture would write any more; `--yes` deletes and stages them |
| `diopsis merge [dir…]` | Merge sharded runs into one report and one verdict |
| `diopsis trace <file…>` | Show which stories a file reaches, or why it forces a full run |
| `diopsis diff [base]` | Report the baseline changes this branch makes against `base` (default `origin/main`) |
| `diopsis --version` | Print the installed version |

Every flag, every config key and the `doctor` output are in
[docs/reference.md](https://github.com/fleetorders/diopsis/blob/main/docs/reference.md) and
[docs/configuration.md](https://github.com/fleetorders/diopsis/blob/main/docs/configuration.md).
The exit code and `summary.json`, the contract a CI bot builds against, are in
[docs/summary-json.md](https://github.com/fleetorders/diopsis/blob/main/docs/summary-json.md).

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

## Development

`npm test` typechecks and runs the suites; `npm run check:report` and `npm run check:stabilize`
drive the report and the capture waits in a real browser. The git hooks under `.githooks/` and
the `.etymd/` config come from [etymd](https://www.npmjs.com/package/etymd) and do nothing
where it is not installed; `.githooks/*.local` runs a gitignored `local/` directory for
machine-specific checks. The design record is
[docs/decisions.md](https://github.com/fleetorders/diopsis/blob/main/docs/decisions.md).

## Roadmap

- A check on the pull request: the run's verdict and changed stories as a status check, with a
  link to the report, built from the summary Diopsis already writes.
- A second browser engine as a smoke pass, with its own baselines and coarse tolerances, for
  layout breakage rather than pixel parity, once the single-browser path has proven itself in
  many real projects.

## License

[MIT](LICENSE)
