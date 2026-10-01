# Design decisions

What was decided and why, for anyone changing the code. Code comments cite an entry as
`docs/decisions.md, D-023`. Numbers are stable; a gap is an entry deleted because it no
longer shapes the code.

## D-001 — What Diopsis is

**Decision:** A standalone Storybook visual-regression tool: it screenshots the already-built
static Storybook and diffs each story against baselines committed in the consuming repository,
running identically locally and in CI. No hosted service, no dashboard, no state outside the
repository. Accepting a change is committing a file; there is no accept/reject state machine.
Chromium only, because pixel parity across browser engines cannot hold without owning the
rendering environment. No machine-learned "ignore this" diffing, whose failure mode is a real
regression scored as noise. No automatic acceptance: a baseline changes only when someone
commits it.

**Why:** the parts that decide whether a visual suite survives are determinism and
reviewability, not the screenshot itself, and both are lost when the baselines and the review
surface live outside the repository under test. Reading the built output keeps the tool
independent of the builder and of the Storybook version beyond the index format, and lets CI
reuse a build it already produces.

## D-002 — Name

**Decision:** The tool is Diopsis (διόψις: sight that discerns the difference between two).
The package is `diopsis`, and every story tag it reads starts with `diopsis:`.

**Why:** it names what the tool does, seeing the difference between two renders.

## D-004 — Baselines are a Linux artifact

**Decision:** Authoritative baselines are generated in Linux, in a container locally or in the
CI image, so they match the runner that verifies them. Diff defaults stay strict, with
`compare.maxDiffPixelRatio` as the first lever if real parity problems appear. Trying the tool
needs no container: `run` works natively against platform-suffixed local baselines.

**Why:** screenshots are OS-specific; a baseline generated on a developer's machine will not
match a Linux CI runner, and the mismatch presents as a suite that fails on arrival. Cross-OS
compatibility and easy setup genuinely conflict, so the resolution is explicit rather than
blended.

**Consequences:** `arm64` and `amd64` renders also differ slightly
([playwright#13873](https://github.com/microsoft/playwright/issues/13873)), so a container on an
ARM host gives near-parity, not guaranteed parity. Diopsis records platform and architecture
per baseline set and warns on mismatch rather than claiming an equivalence that does not hold.

## D-005 — The report is the review surface

**Decision:** Diopsis ships a self-contained HTML report: a gallery of the captures that need
review, four comparison modes per pair (diff-highlight overlay by default, side by side, swipe,
onion-skin), status filters, and a copy-paste accept command per story and for the run.
`summary.json` sits beside it for CI bots.

**Why:** no git forge renders a pixel-level image diff. GitLab offers 2-up, swipe and
onion-skin but no diff highlight
([gitlab#503214](https://gitlab.com/gitlab-org/gitlab/-/issues/503214)); GitHub is comparable.
Without its own report the tool gives a reviewer no way to see what changed, which is the whole
point of a failing visual test. One file with no server and no adjacent assets opens straight
from a CI artifact.

## D-008 — One ignore attribute: `data-diopsis-ignore`

**Decision:** Regions excluded from comparison are marked with `data-diopsis-ignore`. This is
the only recognised attribute; the API carries no aliases for other tools' attributes.

**Why:** an API that recognises another tool's vocabulary inherits that tool's conventions
permanently, and every alias is a second thing to document and keep working.

**Consequences:** a project adopting Diopsis renames its existing annotations, a one-line
search-and-replace. `diopsis doctor` reports elements still carrying another tool's ignore
attribute so the migration can be finished, and because the clock is frozen by default (D-046),
annotations that existed only to hide dates can usually be deleted rather than renamed.

## D-011 — TypeScript config, no transpiler

**Decision:** `diopsis.config.ts` is loaded by Node's own type stripping. `.mjs` and `.js`
configs are accepted on any supported Node, and the runtime dependency count stays at zero.

**Why:** a TypeScript config and zero dependencies (D-015) are both wanted. A bundler or a
transpile dependency satisfies the first at the cost of the second; type stripping satisfies
both.

**Consequences:** the `.ts` form needs Node 22.18 or newer, where type stripping is unflagged;
below that the loader says so and names the `.mjs` alternative rather than failing obscurely.
Type stripping erases types but generates no code, so enums, namespaces and parameter
properties are unusable, in a user's config and in this codebase alike. `erasableSyntaxOnly` in
`tsconfig.json` turns that from a runtime surprise into a compile error.

## D-012 — The generated project lives under the tested project

**Decision:** The generated Playwright project is written to `node_modules/.diopsis/project`
inside the project under test, not to the operating system's temporary directory.

**Why:** `@playwright/test` is a peer dependency, so the generated config and spec must be able
to resolve it. Node's module resolution skips ancestors already named `node_modules`, which
puts the project's own `node_modules` on the search path from that location; a temporary
directory elsewhere on disk has no path back to it.

**Consequences:** the directory is rewritten on every run and removed afterwards, so it holds
no state between runs. Two concurrent runs in one project would contend for it.

## D-013 — Two fixtures, only one of them committed

**Decision:** Tests run against a committed Storybook-shaped fixture: a story index and a
preview document, no Storybook involved. End-to-end validation runs against a real Storybook
build that is reproduced locally from instructions and never committed. The index parser
tolerates unknown fields rather than asserting a shape, because Storybook versions add and drop
fields (`subtype`, `exportName`, `componentPath`).

**Why:** these are different jobs. The committed fixture has to be fast, deterministic and
free of installs so the suite runs anywhere; validation has to be real enough to disagree with
the design, which only a genuine build does. Committing the real one would put a framework's
full dependency tree in a repository that has none.

**Consequences:** the committed fixture cannot catch what only a real build reveals, so it is
never the sole evidence that something works.

## D-014 — `diopsis:skip` excludes a story

**Decision:** A story tagged `diopsis:skip` is not captured. A `diopsis:` tag that names
neither a width nor a configured viewport set produces a warning and falls back to the default
set.

**Why:** tags are the per-story channel (D-047), and some stories cannot be usefully
photographed. The fallback direction matters more than the tag: silently capturing nothing
because a tag was misspelled reads as "all green" when a story is simply unwatched.

## D-015 — Zero runtime dependencies

**Decision:** Diopsis ships with no runtime dependencies at all. `@playwright/test` is a peer
dependency, so browsers are downloaded once and never on a second version.

**Why:** Node's own `parseArgs` covers the CLI, and no image is decoded by a library: the
comparator is Playwright's, the report embeds the PNGs it produced, and the tool's own PNG
decoder and encoder cover regions (D-030), `diff` (D-035) and recompression (D-043).

**Consequences:** adding a dependency is a decision rather than a default. A capability that
needs a library takes it from the tested project (D-041).

## D-016 — A scaffolded config must load before anything is installed

**Decision:** The `diopsis.config.ts` written by `diopsis init` types itself with an
`import type`, not a runtime `defineConfig` import. `defineConfig` remains exported for those
who prefer it.

**Why:** a config that imports `defineConfig` at runtime cannot be loaded until the package
resolves from the project, which breaks the `npx diopsis init` path it exists to serve. A
type-only import is erased by the same type stripping that loads the file, so the config is
typed in an editor and free of imports at run time.

## D-017 — The report embeds only what needs looking at

**Decision:** The HTML report inlines images for captures that need review and none for
unchanged ones, under a total embedding budget (D-040 says what happens past it).

**Why:** the report has to open from a CI artifact with no server, which means every image it
shows is carried inside it. Embedding a whole matrix would make the file too heavy to open, and
an unchanged capture has nothing to look at.

**Consequences:** a report is not a complete archive of a run. `summary.json` beside it still
records every capture, including the unchanged ones.

## D-019 — A 0.x version line until the config shape has met real projects

**Decision:** Releases stay on a 0.x line, so a breaking change to the config shape or to
`summary.json` costs a minor bump. `summary.json` carries its own format version field
(`diopsis`), so consumers of the data have a stability signal that does not depend on the
package version. 1.0.0 is cut once the config shape has survived contact with real projects
unchanged.

**Why:** the config shape and `summary.json` are the surfaces most likely to need a breaking
change once they meet unfamiliar setups.

## D-020 — The report compares by width, and colour means one thing at a time

**Decision:** Comparison modes constrain a render's width and never its height. A colour means
exactly one kind of thing: the accent marks what the reader selected, and the status palette
marks a status, never both. A capture classified `changed` is not rendered as an error when its
own pixel count is already shown. Triage marks (the per-capture "reviewed" tick and its
progress count) are browser-local, keyed to a single run, and advisory only.

**Why:** two renders of a story share a natural width, so scaling both by width applies one
factor to both; scaling by height applies a larger reduction to whichever render grew, and a
comparison that silently resizes one side understates exactly the change it exists to reveal.
With the accent also used for status, a filter, a badge and a selected button would render
identically, and nothing on the page would have priority. A changed capture whose diff is
already quantified gains nothing from the raw assertion text, and printing it in the failure
colour dresses the ordinary outcome up as a broken one.

**Consequences:** a tall pair scrolls inside its own frame instead of being shrunk to fit; the
actual-size toggle, not a height cap, answers "show me the pixels". Triage state is not a
review state machine: it cannot travel, cannot be shared, and `accept` neither reads nor writes
it. Committing a baseline is the only durable record that a change was reviewed (D-001), and a
reopened report after a fresh run starts empty rather than carrying ticks that describe
different pixels.

## D-021 — A new capture renders as one column, not a comparison

**Decision:** A capture classified `new` (no baseline existed when it was taken) is shown as a
single labelled column holding its one render, with no comparison modes, no expected and diff
panels, and no assertion text. Its "expected" artifact is not embedded: the comparator writes
the baseline from the very render being reviewed, so the reference is byte-identical to the
actual. Captures with a real baseline keep the full comparison surface, and failures that are
not missing baselines keep their error text.

**Why:** a fresh result for a new capture carries both an actual and a just-written baseline
reference. Presented as a before and after, that shows one image twice and invites the reader
to find a difference that does not exist, and the comparator's "a snapshot doesn't exist"
message in the failure colour reads as an alarm about identical content. "New" is a
bookkeeping state, not a visual finding. Not embedding the duplicate halves the image weight of
a first run, which is the run that consists almost entirely of new captures.

**Consequences:** the rendering branches on the capture's status rather than on which
artifacts happen to be present, so a result carrying both references still shows one column.

## D-022 — One comparison mode for the whole report, overridable per capture

**Decision:** The report offers a page-wide comparison control, in the toolbar and on
Shift+1 to 4, that sets every capture to the same mode. Each capture's own mode buttons and the
unshifted 1 to 4 keys still change only that capture, until the next page-wide choice resets
all of them. A capture that cannot show the chosen mode keeps its own default rather than going
blank, and captures drawn after the choice open in it. The choice lasts for the open page only.

**Why:** reviewing a large run is usually one question asked of every pair ("show me each one
side by side"), and a per-capture control makes that question cost one click per capture.
Keeping the per-capture override means an outlier can still be inspected differently.

**Consequences:** the page-wide control is offered only when some capture has two renders to
compare; a run made entirely of new captures shows none.

## D-023 — Network idle is observed, not waited out

**Decision:** `stabilize.waitForNetworkIdle` does not use Playwright's `networkidle` load
state. The capture runtime counts the page's requests in flight and, through a probe installed
before any page script runs, the `setTimeout` timers of up to 500 ms that page code has
pending. The network counts as idle when neither is pending and nothing has changed for 50 ms.
A timer scheduled from inside another timer's callback is not counted. `settleTimeout` still
bounds the wait, which gives up rather than failing.

**Why:** `networkidle` waits for 500 ms of silence after every navigation. On a build served
from the local disk that silence is the largest single cost of a capture: on a generated
benchmark Storybook (104 simple stories at two widths, 208 captures) a full verify took 32 s
with it, 24 to 25 s with the observed wait, and 22 s with no network wait at all. Counting
requests alone is nearly as fast but misses a fetch started by a short timer after mount, so
pending short timers are counted too. Not counting timers armed by other timers keeps a ticking
widget from holding every capture open until the deadline.

**Consequences:** the probe wraps `window.setTimeout` and `window.clearTimeout` in the page; it
calls through to the originals and is invisible to story code except by identity. Work deferred
by something other than a timer (an observer callback, an animation frame chain) is covered by
the loading-state and image waits, not by this one. `scripts/stabilize-check.mjs` drives these
waits in a real browser.

## D-024 — One page per worker, isolated between stories

**Decision:** The generated spec reuses one browser page per Playwright worker for every
capture that worker takes. Before each navigation the runtime clears the previous story's state
for the preview's origin through the browser (local storage, IndexedDB, cache storage, service
workers and cookies) and clears session storage in the page. A page that crashed is replaced by
a fresh one for the next capture.

**Why:** creating a context per capture is the largest fixed cost per capture. On the
benchmark Storybook of D-023 a verify run went from 24 to 25 s down to 16 to 18 s, with every
capture identical to baselines taken with fresh contexts. Reuse without clearing would be a
determinism regression (a story could read what the previous one stored), so the clearing is
part of the decision, not an option: a browser check writes all four kinds of state in one
story and asserts the next one sees none of it.

**Consequences:** the clearing uses Chromium's own storage protocol, which the single-browser
design (D-001) permits; a cross-browser matrix would need its own isolation. Playwright still
replaces a worker after a failing test, so a run with many changed captures gains less than a
clean one. The context options in the generated spec mirror the project's `use` block, because
worker-scoped fixtures do not receive it; the two are written side by side in the generator.

## D-025 — Refuse what would silently do the wrong thing

**Decision:** Each command accepts only its own flags and refuses any other. The config is
validated on load and every problem is reported together, naming the key and its value;
`viewports.default` must exist, and an explicitly empty one is the way to capture only tagged
stories, which `run` and `doctor` then count as unwatched. Whether a capture is new is decided
by the generated spec checking the baseline file before comparing, recorded as a test
annotation, never by matching Playwright's message wording. `accept` adopts only changed and
new captures, takes any number of story ids, reports an id it cannot find, and copies nothing
unless every source image is present. Two story ids that would share a baseline path are an
error. An interrupted run lists the captures it never reached and does not offer them for
acceptance.

**Why:** each of these otherwise produces a green or plausible result from a wrong state. An
ignored flag on `accept` adopts and stages the whole run. A config without a `default` set
captures nothing for untagged stories and still passes. Matching the comparator's message
wording holds on one Playwright version and breaks on a snapshot mode that words a missing
baseline differently, and the peer range has no upper bound.

**Consequences:** a config that relies on capturing only tagged stories says so with
`default: []`. The pixel count is still read from the comparator's message, because nothing
else reports it; a wording change there degrades to a changed capture without a count, not to a
wrong status.

## D-026 — Doctor reads the CI files it makes promises about

**Decision:** `diopsis doctor` scans the project's CI definitions (GitHub workflow files and the
fixed-name files of the other common hosts) for Playwright container images, and fails when one
names a different image than the config's `image`, naming the file and both values. It also
warns when the installed `@playwright/test` version differs from the version in the pinned
image's tag. Ignore checks use `git check-ignore` inside a repository, so anchored and globbed
patterns are judged the way git judges them.

**Why:** the CI recipe `init` prints says doctor fails when CI's image and the config drift
apart, so doctor has to read the CI files for that to be true. Image drift presents as every
baseline differing at once, the most expensive failure the tool can have. An exact-line ignore
check misses `/__screenshots__` while git ignores the baselines.

**Consequences:** a repository whose other jobs run a different Playwright image for unrelated
tests will see doctor fail on that file; the message names it, and aligning the images is the
remedy the rest of the design assumes anyway. Doctor output is also available as JSON with
`--json`.

## D-027 — The report opens with a contact sheet

**Decision:** Above the story list the report shows an overview: one thumbnail per capture that
needs review, in the list's order, following the same filter and search. A changed capture
shows its diff image, a new one its single render, and one with no image a text tile. Tiles are
scaled by width only and clipped from the top, reuse the images already embedded, and jump to
their capture when clicked. The overview collapses with `o`; the choice is remembered in the
browser.

**Why:** one capture occupies about a screen, so a run with dozens of changes could only be
understood by scrolling through all of it. A grid answers "how much changed, and where" first,
and makes the list a place to go deep rather than the only way in.

**Consequences:** the report file grows by markup only, because tiles point at the same data as
the detail views. A wide capture is small in a tile; the tile shows where the change is, and
the detail view is where it is inspected.

## D-028 — Per-story tolerance through tags, and never silently

**Decision:** A story can set its own comparison with `diopsis:threshold=<0–1>`,
`diopsis:max-diff-ratio=<0–1>` and `diopsis:max-diff-pixels=<n>`, and the config has
`compare.maxDiffPixels`. A story that sets either count-based limit replaces both configured
ones for that story; its threshold replaces the configured threshold on its own. The effective
comparison is resolved once when the plan is written, so the spec runs exactly what
`summary.json` records. `run` counts, and `doctor` names, every story that compares more
loosely than the config, judged by what each lets through at that capture's viewport.

**Why:** per-story settings come from tags (D-047). Playwright applies the stricter of a pixel
count and a ratio when both are given, and the configured ratio is always set, so merging a
story's pixel count over it could only ever tighten the check, and a tag meant to tolerate a
noisy chart would do nothing. Tolerance is also where a suite rots quietly: a loosened story
nobody can see becomes the default, so every loosening is reported where the run and the audit
are read.

**Consequences:** a malformed tolerance value warns and is ignored rather than failing the run.
A story that sets only a pixel count is no longer bounded by the configured ratio, which is the
point; `doctor` is where that is seen.

## D-029 — Component-scoped capture, opt-in

**Decision:** `capture: 'component'` (or a story's `diopsis:component` tag) photographs the
union of the boxes of everything under the render root, children and their descendants so an
overflowing popover is included, padded by 8 px, instead of the whole canvas. `diopsis:page`
restores the canvas for one story; conflicting tags warn and the page wins. When nothing under
the root has a box, the capture falls back to the page and says so in an annotation. The
default stays `page`.

**Why:** most component stories draw a small thing in a large canvas, and every empty pixel is
stored in history, compared on every run and scrolled past in review. Measuring the drawn box
at capture time needs no configuration per story. It stays opt-in because switching changes
every baseline's dimensions, which must be a deliberate regeneration rather than a surprise
after an upgrade.

**Consequences:** the saving depends on how stories lay themselves out; a story that wraps
itself in a full-width, full-height container gains little. Descendants are walked up to 5000
elements to bound the cost on very large stories.

## D-030 — The report says where a capture changed

**Decision:** For every changed capture the reporter decodes the comparator's diff image,
groups its changed pixels into regions (connected pixels, merged when their boxes lie within
8 px) and records up to 20 of them, largest first, in `summary.json`. The report outlines each
region over the overlay, `n` and `N` step through them, and a contact-sheet tile crops to its
capture's largest region. Decoding runs while later captures are still being taken, and a diff
that cannot be decoded leaves the capture without regions rather than failing the run. The
decoder and the region finder are part of Diopsis, with no dependency.

**Why:** a pixel count says how much changed and nothing about where. On a tall or wide
capture the reader has to scan the whole image for the red, and a thumbnail of a 1280-wide
render shows the change as a smudge. Regions turn "4,864 px differ" into "these three places",
which is the question a reviewer is actually asking.

**Consequences:** region outlines use the status colour, and the one being stepped to flashes
in the accent, keeping D-020's rule that colour means one thing at a time. Only pure-red diff
pixels count; anti-aliasing differences, which the comparator marks yellow, are not regions.

## D-031 — Capture after the play function, and fail when it fails

**Decision:** Before capturing, the runtime waits for Storybook's render of the story to reach
its final phase (`finished` in current Storybook, `completed` before it), so a story's play
function has run to the end. A play function that throws, or leaves unhandled errors, makes the
capture `render-failed` with the story's own error message. The signal is read from Storybook's
event channel, which a probe installed before the page loads subscribes to the moment it exists;
an error status explained by a failed addon report, such as an accessibility check, is not a
broken story. Storybooks without these signals skip the wait at no cost.
`stabilize.waitForPlay: false` turns it off.

**Why:** the preview runs play functions on its own, so every capture of a story with one
races it otherwise. A story whose play function opens a panel after a short delay is captured
closed, and a story whose play function throws is captured and passes as unchanged: a baseline
that records the story broken, reported as fine.

**Consequences:** a story whose play function never finishes spends the settle budget before it
is captured. Render failures carry the story's own error text, and error text in `summary.json`
and the terminal excludes stack frames, which would name local paths and Diopsis internals.

## D-032 — A capture that differs once is retaken, and reported unstable

**Decision:** In `run`, a capture that fails is taken again from a fresh page load, up to
`stabilize.retries` times (default 1). One that then matches its baseline is `unchanged` with
`unstable: true`, the first attempt's pixel count and status recorded, a line in the terminal
summary and an Unstable filter in the report, and it does not fail the run. A capture whose
first attempt had no baseline keeps that verdict, because the retry would compare against the
baseline the first attempt just wrote. `update` never retries. Unstable carries no status colour
and does not count as needing review.

**Why:** within one page the comparator already waits for two identical screenshots, so the
flake that survives is between loads: a font that wins a race, data that differs per load.
Failing the run on it is how a suite gets muted; hiding it is how a real problem stays unseen.
Retrying once and naming the result keeps the run trustworthy and the instability visible.

**Consequences:** a genuinely changed capture is taken twice before it is reported, which costs
one extra capture per real change and nothing for unchanged ones. A story that is random on
every load is still reported changed about as often as both loads disagree with the baseline;
the fix for that is in the story, and the Unstable filter is where it shows up first.

## D-033 — Modes: named sets of Storybook globals, each with its own baselines

**Decision:** `modes` in the config names sets of Storybook globals. Every story is captured in
its plain form and in each mode, the globals passed through the story URL's `globals`
parameter, so the story's own decorators apply them. A mode capture's baseline is
`<story>/<width>w-<mode>-<platform>.png`; plain captures keep their path exactly.
`diopsis:modes=<names>` restricts a story and `diopsis:modes=none` leaves it plain. The report
filters by mode alongside status and search; `doctor` counts mode captures and treats a
baseline for a mode no longer configured as an orphan.

**Why:** a dark theme, a right-to-left layout and a second locale are where component
libraries break unseen, because nobody looks at every story in every combination. Globals are
Storybook's own mechanism for exactly these, so driving them from the URL needs nothing from the
story and captures what the story really renders in that mode. Keeping plain paths unchanged
means adding the first mode costs new baselines, not a regeneration of the old ones.

**Consequences:** each mode multiplies the capture count like a width, which `init` and the run
header make visible. Mode names are limited to lower-case letters, digits and hyphens because
they appear in file names; global keys and values cannot contain the URL separators `:` and `;`.

## D-034 — Review ticks become one accept command; side by side moves as one

**Decision:** When captures are ticked reviewed, the report offers one command,
`npx diopsis accept <ids…>`, naming the ticked stories whose captures accept would adopt:
changed or new, not failed, not unstable. Because accept works per story, a story ticked only
in part is called out in the button's label and title. The filtered-accept command becomes one
line with every id. In side-by-side mode the two panes share scroll position and actual-size
zoom. Ticks stay browser-local and advisory (D-020); the command is still something the
reviewer runs and commits.

**Why:** ticking captures off and then typing out which stories to accept is the review's last
manual step, and the step where a story gets accepted by accident. Since `accept` takes several
ids (D-025), the ticks can produce the command directly. Comparing two renders pixel by pixel
needs the same pixel under the eye in both, which independent scrolling makes impossible past
the first screen.

**Consequences:** the button counts stories, since stories are what the command adopts, while
the progress beside it counts captures. No tick is transmitted or stored beyond the browser.

## D-035 — `diopsis diff`: review baseline changes from git, without a browser

**Decision:** `diopsis diff [base]` finds every baseline under the snapshot directory that the
working tree changes, adds or deletes against the merge base with `base` (default
`origin/main`, falling back to `main`), reads the old versions from git, compares them in-house,
and writes the usual self-contained report and a `summary.json` with `mode: "diff"` under
`<outputDir>/diff/`. A deleted baseline has its own `removed` status, shown as the base image
alone. It never runs a browser and always exits 0 unless git itself cannot answer. The pixel
comparison, the PNG encoder and the path parser are part of Diopsis, with no dependency.

**Why:** accepting a change puts new PNGs in a pull request, and no forge shows a reviewer
more than two images per file (D-005). The run report shows what changed on the machine that
ran it; the reviewer of the pull request needs what the branch changes, which git alone can
answer, so the review surface must not require rebuilding the Storybook or a browser.

**Consequences:** the in-house comparison is a plain perceptual colour distance without the
comparator's anti-aliasing allowance, so its pixel counts can run higher than a `run`'s for the
same change; it reports, it never gates. `removed` joins the status vocabulary with the
neutral, outlined treatment unstable uses; it is not a failure.

## D-036 — Change-aware capture: a proven filter, or a full run

**Decision:** `diopsis run --changed [base]` captures only the stories that the files changed
since the merge base with `base` can reach through the module graph the Storybook build writes
with `--stats-json`, and carries every other capture from its baseline, listed as carried in the
summary and the report. The resolver walks importers from each changed file to story files;
anything it cannot prove harmless forces a full run with the reason printed: Storybook's config
directory, the Diopsis config, package manifests and lockfiles, builder and styling configs,
static directories, a changed file absent from the graph, a missing or inconsistent stats file.
Stories whose import path is virtual are always captured. `diopsis trace <file…>` prints the
same resolver's answer for any file. The matrix resolver returns the full capture set as plain
data and `summary.json` records it, so this is a filter over that list rather than a second
resolver.

**Why:** on a pull request that touches one component, capturing the whole matrix spends
minutes proving that nothing else moved. On a test Storybook, changing one shared component
captured the 3 stories that import it (6 of 214 captures) in 5 seconds instead of about 18,
and still caught the change. The failure direction matters more than the saving: a filter that
silently skips a story that did change is worse than no filter, so every doubt becomes a full
run, never a skip.

**Consequences:** the saving depends on the import graph; a change to a file every story
imports, such as a barrel file or shared tokens, reaches every story. `update` and `accept`
refuse `--changed`, because baselines are always generated whole.

## D-037 — A weight budget, and pruning what nothing captures

**Decision:** The config can set `budget: { weight, captures }`. `doctor` reports the baselines'
weight for this platform and in total, fails past a budget and warns within 10% of it; `run`
prints a budget line only when it is over or close. `diopsis prune` lists every baseline no
capture of the current matrix would write, for any platform present, across widths and modes,
and deletes and stages them with `--yes`, refusing anything that resolves outside the snapshot
directory. When an orphan is byte-identical to a baseline the last run recorded as new, doctor
and prune say it looks renamed.

**Why:** baseline weight is the cost that only grows: every accepted change adds a full set to
history, and a figure that is reported but never enforced drifts until someone notices the
clone time. A renamed story is the commonest source of orphans: a new baseline plus an orphan
of the same bytes.

**Consequences:** the weight budget is judged against the total across platforms, with this
platform's share shown beside it. Prune is a dry run unless told otherwise, and deleting is
staged rather than committed, so the removal is reviewed like any other baseline change.

## D-038 — Interaction states: hover, focus and press, each with a baseline

**Decision:** A story tagged `diopsis:hover=<selector>`, `diopsis:focus=<selector>` or
`diopsis:active=<selector>` is also captured with the first matching element in its render root
hovered, keyboard-focused or held pressed, each state at every width and mode, with its own
baseline at `<story>/<width>w[-<mode>]-<state>-<platform>.png`. Several tags of one kind are
numbered (`hover-2`). Focus is applied after a keyboard press so `:focus-visible` styling shows;
a press is held through the screenshot and released afterwards, so the next capture on the
reused page starts clean. A selector that matches nothing is a render failure. The report
filters by state beside mode.

**Why:** hover, focus rings and pressed styles are where component libraries regress most and
are seen least, and a play function cannot hold a pointer state still for a screenshot: it runs
to completion first (D-031). Tags keep the setting next to the story (D-047).

**Consequences:** each state is a capture, so it costs like a width and is counted as one. A mode
whose name ends in a state word would read as that state in a baseline path; mode and state
names are chosen by the project, and the writer's order is the one the parser assumes.

## D-039 — Sharded runs split by story, merged into one review

**Decision:** `diopsis run --shard <i>/<n>` captures one deterministic shard of the plan, split by
story (every width, mode and state of a story in the same shard), balanced greedily by capture
count, into `<outputDir>/shard-<i>-of-<n>/`. `diopsis merge` finds the shard summaries, refuses a
missing or duplicated shard or a platform mismatch, and writes one summary and report with
artifact paths rewritten, exiting as a single unsharded run would. `accept --from <dir>` accepts
from the merged run. Playwright's own `--shard` is refused, because it splits by test.

**Why:** a matrix of thousands of captures is a wall-clock problem one machine cannot solve,
and the answer every CI offers is parallel jobs. What must not change is the review: one report,
one verdict, and never half a story in each of two places.

**Consequences:** a shard alone is not a verdict on the change; the merge is. Shard directories
are separate so that downloading every job's artifact into one place cannot overwrite anything.

## D-040 — The report embeds each image once, and references the rest

**Decision:** The report embeds identical images once (identity by size, then SHA-256) and
every capture that uses them points at the one copy. Embedding follows review order, worst
first, up to the budget; past it, images are referenced by their path relative to the report
instead of being left out. A referenced image that cannot load, because the report was opened
without the files beside it, turns into a note naming where the image is.

**Why:** a run with several hundred changes is the run that most needs its images, and a fixed
budget with nothing past it leaves most of those captures without one. The artifacts sit next
to the report in the output directory and in the CI artifact, so a relative reference costs
nothing and keeps every capture reviewable. Identical images are common (a new story's baseline
written from its render, one baseline shared across modes), and a benchmark whose captures
shared their images went from 28 MB to 0.5 MB.

**Consequences:** the first captures in review order are always self-contained; later ones need
the files beside the report. The report still opens and works on its own, with a note in place of
each image it cannot reach.

## D-041 — Optional capabilities use a library only when the project installs it

**Decision:** Diopsis keeps its zero runtime dependencies (D-015). A capability that needs a
third-party library declares it as an optional peer dependency and loads it resolved from
the tested project. When the capability is switched on and the library is missing, the run
stops with one line saying exactly what to install. Nothing is downloaded or installed by
Diopsis itself.

**Why:** the tested project, not the tool, owns the dependency tree: versions, audits and
licence review all happen where the project already does them, and a tool that installs
behind its user's back breaks the no-runtime-dependencies property the package is trusted
for. An optional peer dependency states the need without imposing it, and resolving from
the project means the version a story is audited with is the one the project chose.

**Consequences:** the first use of such a capability stops with an install instruction
rather than working out of the box, and the library's version can differ between projects.
The first capability under this policy is the accessibility audit (D-042).

## D-042 — Accessibility findings beside the pixels, accepted like baselines

**Decision:** `accessibility: 'off' | 'report' | 'fail'` (default `'off'`, validated; a
`diopsis:a11y=off` tag opts a story out) audits each story's render with the tested
project's axe-core, an optional peer dependency under D-041, once per story and mode, on
the first width, after the screenshot so nothing the audit does can touch the compared
pixels, and never on an interaction-state capture. Findings are recorded per capture and
totalled as new in `summary.json`; `'report'` never affects the exit code, `'fail'` fails
a run with new findings like a change and lists the story among the changed. Accepted
findings live in `<snapshotDir>/accessibility.json`, keyed `<storyId>[@<mode>]` with each
rule's target selectors, committed like baselines; a finding is new when its rule and
target are not listed for its story. `diopsis accept` adopts the current findings for the
stories it accepts and drops ones that disappeared, so the file never grows stale. The
report offers an Accessibility chip when a run has findings, and the capture lists each
rule with its impact, its help and its targets, new findings marked.

**Why:** pixels are not the only way a component regresses, and an accessibility failure
is invisible to a pixel diff that renders exactly what it rendered before. axe-core is the
engine the ecosystem already ships, so the audit's vocabulary is one a team recognises;
keeping acceptance in the repository, the same review a baseline gets, is what makes the
findings reviewable in a pull request rather than in a report nobody reopens. Auditing
once per story and mode, after the comparison, keeps the cost bounded and the screenshot
authoritative.

**Consequences:** the audit runs only on a capture whose comparison passed, so a story
with both a pixel change and findings reports the pixels first and the findings on the
next run. `update` audits and records but never fails, matching a regeneration that passes
by construction. Impact is shown as text and "new" as an outlined marker, so the report's
colour keeps meaning status alone (D-020).

## D-043 — Lossless baseline recompression, only when oxipng is there

**Decision:** The config can set `compress: 'auto'` (default `'off'`, validated). With it,
every baseline that `update` and `accept` write is recompressed by running the `oxipng`
executable (`oxipng -o 4 --strip safe --quiet`, in batches of at most 100 files per
invocation, spawned with no shell), but only after `oxipng --version` proves the tool is
installed. Every recompressed file is then decoded by Diopsis's own PNG decoder and its RGBA
bytes compared against the original; any file that differs, or fails to decode, is restored
to its original bytes with a warning naming it. The tool's alpha optimisation is never
requested, because it is the one oxipng mode that changes pixels. A missing tool prints one
line and never fails the run; `doctor` warns when `compress` is `'auto'` and the tool is
absent. `DIOPSIS_OXIPNG` names the executable for environments where it is not `oxipng` on
the PATH.

**Why:** baseline weight is the cost that only grows (D-037), and the browser's PNG encoder
leaves every file larger than the same pixels need to be, savings that compound on every
clone for zero pixel change. None of that is worth a new required tool or a trusted claim of
losslessness: the tool is detected, not configured; the check that makes "lossless" a
guarantee is Diopsis's own decode-and-compare, not the optimiser's promise; and a failure
anywhere in recompression falls back to the bytes the browser wrote rather than failing a run
whose captures were already good.

**Consequences:** no dependency is added; the executable is invoked, never bundled (D-015).
Recompression leaves either smaller-but-identical pixels or the original bytes, never a
corrupted baseline.

## D-044 — A timer loop is released by the network quiet; a first timer is not

**Decision:** This adds to D-023. A timer re-armed from a microtask or a message port, rather
than from inside a timer callback, is not recognised by the timer-inside-timer rule, so it
could hold every capture open until `settleTimeout`. Once no request has been in flight or
settled for 500 ms, pending timers stop holding the wait only when their callback's source
text has already been scheduled at least once before on that page. A callback scheduled for
the first time still holds the wait, however late in the quiet it was scheduled, and a first
callback that has just fired still earns the 50 ms grace for a request it may have started.

**Why:** releasing every pending timer after 500 ms of network quiet would also release a
one-off reveal or debounce timer scheduled late in the quiet, so the capture would be taken
before the change it is about to make. The source text tells the two cases apart without
knowing any framework: a loop schedules the same code again and again, while a one-off reveal
schedules its code once.

**Consequences:** two callbacks with identical source text count as one, so a helper that
wraps `setTimeout` for unrelated one-off work can be treated as a loop after its second use.
Only the time after 500 ms of network quiet is affected, and `settleTimeout` still bounds the
wait. `scripts/stabilize-check.mjs` covers a late one-off reveal, beside the tickers re-armed
from a microtask and from a message port.

## D-045 — Delegate the runner to Playwright; own the reporter and the server

**Decision:** Diopsis generates a Playwright project (D-012) and runs it with `playwright test`,
inheriting parallelism, retries, timeouts and the pixel comparator. It owns the parts that make
the review: a custom Playwright reporter that writes the report and `summary.json`, and a small
built-in static server for the Storybook build.

**Why:** parallelism, sharding, retries, timeouts and the comparator are solved and maintained
upstream. Delegating them is the smallest footprint that still serves the performance target,
and it keeps the maintenance tail short. A reporter is a small, stable extension point, and a
static server is a few dozen lines against a dependency.

## D-046 — Determinism is on by default, and the unit is the capture

**Decision:** Every guarantee a hand-rolled setup gets wrong is a default rather than advice:
the platform and architecture are in every snapshot path, so a native macOS run can never
overwrite the Linux set CI reads; one pinned container image in the config is consumed by both
baseline generation and the CI recipe, and `doctor` fails when CI names a different one
(D-026); stabilization waits for network idle (D-023), loading states, fonts, images and the
play function (D-031), not just first paint; the clock is frozen, so dates and relative times
are deterministic and masking is reserved for genuinely nondeterministic pixels; a small
non-zero `maxDiffPixelRatio` ships beside the per-pixel threshold so one stray anti-aliased
pixel cannot block a pipeline. Every count the tool prints is captures, not stories.

**Why:** the same story must produce the same pixels on every machine, or the suite becomes
noise and gets muted. A mask hides content from review and still fails the diff when its
bounding box moves, so freezing time beats masking it. A four-viewport matrix over 90 stories
is 360 captures, and runtime, repository weight and review effort all scale with captures, so
that is the number a user must see.

## D-047 — Per-story settings come from story tags

**Decision:** Everything a story sets for itself (widths, skip, component or page capture,
modes, tolerance, interaction states, opting out of the audit) is a `diopsis:` tag in the
story's `tags`, read from the built index.

**Why:** the story index serialises `tags` but not `parameters`, so any map of "which story
renders how", kept anywhere else, has to be maintained by hand and drifts silently. A tag
lives next to the story and travels with the build.

## D-048 — Review states are the tool's own, and accepting is committing a file

**Decision:** A capture's status is one of `unchanged`, `changed`, `new`, `render-failed`,
`failed` (plus `removed` in `diff`, D-035, and the `unstable` mark, D-032), decided by Diopsis
rather than taken from Playwright's pass or fail. `accept` copies the run's images over the
baselines and stages them; committing them is the review's durable record.

**Why:** "a baseline did not exist yet" and "this looks different" both present as a failing
test and call for opposite responses, so they must be separate states. Keeping acceptance as a
committed file is what makes the baseline set reviewable in the pull request, with no state
anywhere else (D-001).
