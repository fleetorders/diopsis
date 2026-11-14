---
"diopsis": patch
---

A config file that sets `stabilize`, `compare` or `layout` to something other than an object
(`layout: 'fail'`, say) is now rejected with a message naming the key, instead of being
ignored while the defaults stayed in force.
