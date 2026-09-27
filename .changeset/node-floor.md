---
"diopsis": patch
---

The supported Node floor is now stated as 18.11. The CLI's flag handling reads both the
argument parser's token stream (Node 18.7) and its option defaults (Node 18.11), so 18.3
never actually ran the compiled CLI; CI exercises the compiled CLI on Node 18 and 20 and
runs the suite on Windows.
