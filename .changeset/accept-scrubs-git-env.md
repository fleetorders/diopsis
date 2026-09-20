---
"diopsis": patch
---

`diopsis accept` scrubs `GIT_*` environment variables before its git calls, so accepting baselines stages into the project being tested even when the command runs from a context that exports them — a git hook, or a linked worktree.
