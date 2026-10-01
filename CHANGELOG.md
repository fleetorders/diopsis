# diopsis

## 0.3.1

### Patch Changes

- bf5f1ec: Public repository shape: the README is shorter with the configuration, command and summary.json reference under docs/, the design record moves to docs/decisions.md, and `init` formats its estimated weight the same way every other surface does.
- 3276a27: Accepting a merged sharded run now works: `accept --from .diopsis/merged` adopts the images
  kept in the shard directories beside it, and a single shard's report offers accept commands
  for that shard's own directory. The capture wait no longer photographs a story before a
  one-off timer scheduled late in the network quiet has fired. `run --changed` and `trace` now
  work for a project in a subdirectory of its repository, and `trace` reports the run's own
  output as ignored, the same way a run treats it. `init --force` keeps every value of the
  config it rewrites, and refuses to replace a config it cannot load. `accept` refuses an
  `accessibility.json` that is not valid JSON instead of rewriting it. `merge` refuses a
  malformed shard summary with a message instead of crashing, `--shard` rejects more than 1024
  shards, an oxipng batch that hangs is stopped after five minutes, and the report links an
  accessibility rule's help only when its address is a web address.

  The diff report no longer offers to accept reviewed captures, says when the filters alone
  empty the view, and names each capture's interaction state. `doctor` names the ignore rule,
  file and line, that hides the baselines.

## 0.3.0

Upgrading from 0.2: a config's `viewports` must now name a `default` set — write `default: []`
to keep capturing only tagged stories — and the supported Node floor is 18.11. Everything else
is additive.

### Minor Changes

- e79296e: The report copies one `accept` command for exactly the stories you ticked reviewed, warning
  when a story still has unticked changed captures; side-by-side panes scroll and zoom together.
- 238eafd: Accessibility findings beside the pixels: `accessibility: 'report'` or `'fail'` audits each
  story's render with the project's own `axe-core` (an optional peer dependency), records
  accepted findings in an `accessibility.json` beside the baselines that `diopsis accept`
  adopts, and adds an Accessibility filter and per-capture findings list to the report. A
  `diopsis:a11y=off` tag opts a story out.
- fe601ea: Captures wait for a story's play function to finish, and a play function that throws makes the
  capture `render-failed` with its own error message; render failures now show the story's
  error without stack frames.
- 2eaa3ce: `diopsis run --changed [base]` captures only the stories the changed files can reach through the
  build's module graph (`storybook build --stats-json`) and carries the rest; anything it cannot
  prove harmless runs everything. `diopsis trace <file>` shows the chain from a file to its stories.
- 04bc2d9: The report shows where a capture changed: changed regions are outlined on the overlay, `n` and
  `N` step through them, overview tiles crop to the largest one, and `summary.json` records them.
- 6e106e6: `run` counts the stories it actually captures and says exactly why there is nothing to capture;
  terminal numbers and story order no longer depend on the machine's locale; `doctor --json`
  prints the audit as JSON; doctor checks ignore rules the way git applies them, fails when a CI
  file runs a different Playwright image than the config pins, and warns when the installed
  Playwright does not match that image; `init --force` keeps the replaced config's paths, widths
  and image.
- 9cae37d: `capture: 'component'` (or the `diopsis:component` story tag) photographs just the rendered
  component, padded by 8 px, instead of the whole canvas; `diopsis:page` opts a story back out.
- fe9139d: The report opens with an overview: a thumbnail of every capture that needs review, in review
  order, following the filter and search; click one to jump to it, press `o` to hide it.
- 28b5d0b: `diopsis diff [base]` renders the report for the baseline changes a branch makes — changed,
  added and removed baselines against `origin/main` or a ref you name — straight from git,
  without a browser run.
- 7324ed5: A capture that differs is taken again from a fresh load; if it then matches it is reported as
  unstable rather than changed and does not fail the run (`stabilize.retries`, default 1).
- 7aba569: Interaction states: `diopsis:hover=`, `diopsis:focus=` and `diopsis:active=` story tags capture
  the story again with an element hovered, keyboard-focused or held pressed, each with its own
  baseline and a state filter in the report.
- ef0da3f: Modes: name sets of Storybook globals (a dark theme, a right-to-left locale) in `modes`, and
  every story is also captured in each, with its own baselines, a mode filter in the report and
  `diopsis:modes=` tags to restrict a story.
- fd990a8: Captures no longer pay a fixed half-second network-idle window each: the runtime watches the
  page's requests and short pending timers instead, which made a benchmark verify run of 208 simple
  captures about a quarter faster while still waiting for a fetch that starts after a short delay.
- c94b415: Each Playwright worker now reuses one page for all its captures, clearing every kind of stored
  state between stories, which cut a benchmark verify run of 208 simple captures from about 25 s to about 17 s.
- d83aa57: The report can switch every capture to one comparison mode at once, from the toolbar or with
  Shift+1–4, while each capture's own buttons still change just that capture. A capture that
  cannot show the chosen mode keeps its own view.
- 7ff2b8a: Per-story tolerance: `diopsis:threshold=`, `diopsis:max-diff-ratio=` and
  `diopsis:max-diff-pixels=` tags, plus a `compare.maxDiffPixels` config option. Stories that
  compare more loosely than the config are counted by `run`, named by `doctor` and recorded in
  `summary.json`.
- 166b9a3: `compress: 'auto'` recompresses baselines losslessly with oxipng when it is installed, after
  `update` and `accept`, and verifies every file's pixels are unchanged before keeping it.
- e727d15: Commands refuse flags that are not theirs instead of ignoring them, so `accept --grep` no
  longer adopts the whole run; the config is validated on load with every problem reported at
  once; `viewports.default` is required (an empty array captures only tagged stories); `accept`
  takes several story ids, adopts only changed and new captures, and copies nothing from an
  incomplete run artifact; new captures are recognised without reading Playwright's message
  wording; `diopsis --version` and `diopsis help` work.
- 3f4e292: The report embeds each distinct image once and, past its size budget, loads the remaining
  images from the files beside it instead of leaving them out, so large runs keep every image.
- b21efbd: `diopsis run --shard <i>/<n>` splits a run across machines by story, `diopsis merge` combines the
  shards into one report and verdict, and `accept --from <dir>` accepts from the merged run.
- 925d999: `budget: { weight, captures }` makes doctor fail when the baseline set outgrows it; `diopsis
prune` lists and, with `--yes`, deletes and stages baselines no capture would write any more,
  pointing out orphans that look like renamed stories.

### Patch Changes

- bf9e36b: The supported Node floor is now stated as 18.11. The CLI's flag handling reads both the
  argument parser's token stream (Node 18.7) and its option defaults (Node 18.11), so 18.3
  never actually ran the compiled CLI; CI exercises the compiled CLI on Node 18 and 20 and
  runs the suite on Windows.
- 0121c32: The run summary no longer prints two blank lines after its header.
- e3c5421: The report filters without rebuilding the page, so drawn comparisons and chosen modes survive a
  search; captures left out of an oversized report say where their images are; small changes no
  longer read as 0.00%; the change bar and the story order use the same measure; images, the
  slider and review progress are labelled for assistive technology, and the up and down arrows
  scroll the page again.

## 0.2.0

### Minor Changes

- Refreshed the report's visual style and documented the report's review
  surface.

## 0.1.0

### Minor Changes

- Initial release: render your stories, compare every pixel against the
  committed baseline, and review what moved in a single self-contained report,
  with the Diopsis reporter as the run's only reporter.
