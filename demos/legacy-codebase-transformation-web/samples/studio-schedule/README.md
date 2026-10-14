---
title: Studio Schedule Sample
description: A multi-file fitness studio sample with simple source-refactoring targets and intentionally deprecated dependencies.
---

## Run The Sample

From this folder, install the locked dependencies and run:

```powershell
npm.cmd ci
npm.cmd start
npm.cmd run build
```

The sample has six source files: an entry point, sample data, booking validation, class search, attendance summary, and report writer. Startup and build both print the report and write `dist/studio-report.json`. The fixed data produces two accepted bookings, two rejected bookings, $40 in revenue, and one matching class. Only the generated report's run ID varies.

To try it in the transformation demo, select this `studio-schedule` folder. The primary target is `summarizeBooking` in `src/booking-summary.js`, which validates a booking through several nested checks. A second target is `findOpenClasses` in `src/class-search.js`, which applies several optional filters in sequence. Both functions have small inputs and deterministic output so their before-and-after changes are easy to compare.

`summarizeAttendance` in `src/attendance-summary.js` adds a third small target with nested counting and repeated assignments.

## Dependency Review

The sample intentionally pins deprecated `mkdirp@0.5.1` and `uuid@3.4.0` for the demo, not for production use. The report writer uses both dependencies and supports their legacy and current entry points so the build can exercise selected updates.

Select the `studio-schedule` folder in the web UI and approve combined source and dependency analysis. Source proposals come from Foundry; dependency deprecation and update evidence comes from npm Registry and OSV, not the model. Review and select source findings and dependency candidates, resolve the updates, inspect the package/lockfile diff, and explicitly approve the build before downloading.

The upload excludes `node_modules` and generated `dist` output. The original sample is unchanged by the web workflow. The model's findings still need your review; this sample does not guarantee a particular transformation.
