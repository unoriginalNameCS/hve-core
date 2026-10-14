---
title: Dispatch Desk Sample
description: A runnable Node.js sample with one intentionally overgrown, deeply nested readiness function for before-and-after refactoring demos.
---

## Run The Sample

From this folder, run:

```powershell
npm start
```

The app uses only Node.js built-ins and prints readiness summaries for two valid dispatches and one rejected request. No dependency installation is required.

To use it in the transformation demo, select this `dispatch-desk` folder. The intended target is the roughly 25-line `summarizeDispatch` function in `src/dispatch-quote.js`. It deliberately nests request, status, destination, package-list, and package-validity checks. The web scan prompt prioritizes a whole-function simplification for this kind of deeply nested target; review the before/after span in the report to see whether the model produces the shorter guard-clause version.
