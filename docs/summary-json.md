# Exit codes and `summary.json`

What a CI step or a bot reads after a run.

`diopsis run` exits `0` when every capture matched its baseline and `1` otherwise — a changed
capture, a missing baseline, a story that failed to render, or nothing to capture at all. That
single code is the whole CI contract; everything richer is in `summary.json`.

## `summary.json`

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
`diffPixels` and `diffRatio` appear only when the comparator reported them. A changed capture
also carries `regions` — up to 20 boxes `{ x, y, width, height, pixels }` in image pixels,
largest first, with `regionsDropped` counting any beyond that — and `size`, the dimensions of
its render. `error` appears only when something failed, and `artifacts` holds whichever of `expected`, `actual` and `diff` exist, as
paths **relative to `outputDir`** so a run stays portable when the directory is moved or
downloaded from CI.

Two things are deliberate. `captures` lists the full set rather than only the changed ones, so a
consumer can diff one run's coverage against another's. And `status` is not Playwright's
pass/fail: "a baseline did not exist yet" and "this looks different" both present as a failing
test and call for opposite responses, so they are separate states here.

