---
'diopsis': patch
---

Accepting a merged sharded run now works: `accept --from .diopsis/merged` adopts the images
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
