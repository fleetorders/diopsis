---
"diopsis": minor
---

Commands refuse flags that are not theirs instead of ignoring them, so `accept --grep` no
longer adopts the whole run; the config is validated on load with every problem reported at
once; `viewports.default` is required (an empty array captures only tagged stories); `accept`
takes several story ids, adopts only changed and new captures, and copies nothing from an
incomplete run artifact; new captures are recognised without reading Playwright's message
wording; `diopsis --version` and `diopsis help` work.
