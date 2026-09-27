---
"diopsis": minor
---

Per-story tolerance: `diopsis:threshold=`, `diopsis:max-diff-ratio=` and
`diopsis:max-diff-pixels=` tags, plus a `compare.maxDiffPixels` config option. Stories that
compare more loosely than the config are counted by `run`, named by `doctor` and recorded in
`summary.json`.
