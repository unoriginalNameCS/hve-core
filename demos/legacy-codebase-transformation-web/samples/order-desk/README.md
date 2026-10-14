---
title: Order Desk Sample
description: A runnable multi-file Node.js sample with intentionally tangled order and catalog functions for refactoring demos.
---

## Run The Sample

Install the two pinned dependencies and run the sample from this folder:

```powershell
npm ci
npm start
```

`npm start` prints the daily order report and matching catalog products. `npm run build` runs the same app and writes `dist/daily-report.json`.

To use it in the transformation demo, select this `order-desk` folder. The main refactoring candidates are `buildOrderReport` in `src/order-report.js` and `searchCatalog` in `src/catalog-search.js`. They are intentionally verbose, deeply nested, and repetitive, while producing deterministic output for the sample data.

The direct dependencies are intentionally pinned to deprecated releases: `mkdirp@0.5.1` and `uuid@3.4.0`. The dependency review shows their deprecation notices and stable update candidates. The app handles the legacy and current package entry points, so the approved build exercises the selected updates. Its generated report is written under `dist`, which the demo excludes from upload.
