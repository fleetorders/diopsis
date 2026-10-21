# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). Each change that
should affect the published version adds a markdown file here describing it.

- Add one: `npx changeset`.
- Version and write the changelog: `npm run version:packages`.
- Publish: `npm publish` (the build runs first).
