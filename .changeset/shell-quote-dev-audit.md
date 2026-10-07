---
"diopsis": patch
---

Bumped the dev-only `shell-quote` transitive dependency to 1.12.0 to clear a
critical audit advisory (GHSA-pqg4-j6r4-53mv). The package has no runtime
dependencies, so the advisory never reached published installs; this keeps
development installs clean.
