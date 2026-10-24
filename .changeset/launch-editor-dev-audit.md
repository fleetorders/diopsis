---
"diopsis": patch
---

Bumped the dev-only `launch-editor` transitive dependency to 2.14.2 to clear
its high audit advisories (GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv,
GHSA-r825-w8mm-5pxw). The package is pulled only through `@changesets/cli`,
so published installs are unaffected; this keeps development installs clean.
