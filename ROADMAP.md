# Roadmap

What's next for Diopsis, in order of intent. This list is pruned, reordered and rewritten
freely — the *decisions* behind deferrals, and everything ruled out, live in
[DECISIONS.md](DECISIONS.md).

## Next

- **A check on the pull request** — the run's verdict and changed stories as a status check on
  the pull request, with a link to the report, built from the summary Diopsis already writes.

## Later

- **A second browser engine as a smoke pass** — its own baselines and coarse tolerances, for
  layout breakage rather than pixel parity, only once the single-browser path has proven itself
  in many real projects.

## Not planned

- A hosted service, dashboard, or any state outside the consuming repository — a design
  goal, not a gap (D-001).
- An accept/reject review state machine; accepting a change is committing a file.
- Pixel-exact comparison across browser engines, which cannot hold without owning the rendering
  environment.
- Machine-learned "ignore this" diffing, whose failure mode is a real regression scored as
  noise.
- Accepting baselines automatically; a baseline changes only when someone commits it.
