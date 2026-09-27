---
"diopsis": minor
---

`diopsis run --changed [base]` captures only the stories the changed files can reach through the
build's module graph (`storybook build --stats-json`) and carries the rest; anything it cannot
prove harmless runs everything. `diopsis trace <file>` shows the chain from a file to its stories.
