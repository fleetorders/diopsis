---
"diopsis": minor
---

Each Playwright worker now reuses one page for all its captures, clearing every kind of stored
state between stories, which cut a benchmark verify run of 208 simple captures from about 25 s to about 17 s.
