---
"diopsis": minor
---

A layout audit beside the pixels: `layout: { mode: 'report' | 'fail', widths: [...] }` measures
where text, controls and images sit at every capture's width — and at any widths you name,
such as your design system's breakpoints, where no baseline is ever written — and reports
overlapping elements, text cut off by its container, and sideways scrolling as text in
`summary.json` and the report, with a screenshot kept only of a flagged capture. `fail` fails
the capture like a change; a story opts out with `diopsis:layout=off` and an intended overlap
is marked with `data-diopsis-overlap`.
