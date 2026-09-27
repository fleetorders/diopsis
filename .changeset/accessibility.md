---
"diopsis": minor
---

Accessibility findings beside the pixels: `accessibility: 'report'` or `'fail'` audits each
story's render with the project's own `axe-core` (an optional peer dependency), records
accepted findings in an `accessibility.json` beside the baselines that `diopsis accept`
adopts, and adds an Accessibility filter and per-capture findings list to the report. A
`diopsis:a11y=off` tag opts a story out.
