# Roadmap

What's next for Diopsis, in order of intent. This list is pruned, reordered and rewritten
freely — the *decisions* behind deferrals, and everything ruled out, live in
[DECISIONS.md](DECISIONS.md).

## Next

- **Change-aware capture** (D-006): shoot only the stories a change can reach through the
  build's module graph, carry the rest from their baselines, and run everything whenever a
  change cannot be proven harmless — with a `trace` command that explains why a file does or
  does not reach a story.
- **Sharded runs with one review**: split a large matrix across CI machines by story, then merge
  the shards back into a single report and verdict.
- **Interaction states**: capture a story again with an element hovered, focused or pressed —
  the states a play function cannot hold still for a screenshot — each with its own baseline.

## Later

- **Accessibility findings beside the pixels** — checks run in the page just before capture,
  reported per story in the same summary and report, with accepted findings recorded as files
  like baselines, so only new ones fail.
- **Lighter baselines** — lossless recompression when baselines are written, so the pixels are
  identical and the repository grows more slowly.
- **A check on the pull request** — the run's verdict and changed stories as a status check
  with a link to the report, from the summary Diopsis already writes.
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
