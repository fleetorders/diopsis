# diopsis

## 0.2.1

### Patch Changes

- A new capture renders as one labelled image instead of a before/after comparison of two identical pictures, and its "a snapshot doesn't exist" assertion text is no longer shown as a failure.
- `diopsis accept` scrubs `GIT_*` environment variables before its git calls, so accepting baselines stages into the project being tested even when the command runs from a context that exports them — a git hook, or a linked worktree.

## 0.2.0

### Minor Changes

- Refreshed the report's visual style and documented the report's review
  surface.

## 0.1.0

### Minor Changes

- Initial release: render your stories, compare every pixel against the
  committed baseline, and review what moved in a single self-contained report,
  with the Diopsis reporter as the run's only reporter.
