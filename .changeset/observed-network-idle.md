---
"diopsis": minor
---

Captures no longer pay a fixed half-second network-idle window each: the runtime watches the
page's requests and short pending timers instead, which made a 208-capture verify run about a
quarter faster while still waiting for a fetch that starts after a short delay.
