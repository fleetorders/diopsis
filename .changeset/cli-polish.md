---
"diopsis": minor
---

`run` counts the stories it actually captures and says exactly why there is nothing to capture;
terminal numbers and story order no longer depend on the machine's locale; `doctor --json`
prints the audit as JSON; doctor checks ignore rules the way git applies them, fails when a CI
file runs a different Playwright image than the config pins, and warns when the installed
Playwright does not match that image; `init --force` keeps the replaced config's paths, widths
and image.
