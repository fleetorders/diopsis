---
"diopsis": minor
---

Captures no longer pay a fixed half-second network-idle window each: the runtime watches the
page's requests and short pending timers instead, which made a benchmark verify run of 208 simple
captures about a quarter faster while still waiting for a fetch that starts after a short delay.
