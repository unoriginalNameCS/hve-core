---
title: Invoice Desk Sample
description: A CommonJS invoice CLI with intentional technical debt and a pinned dependency update for the legacy code transformer demo.
---

## Run The Sample

From this folder, run:

```powershell
npm ci
npm test
npm start
```

The CLI prints two invoice summaries with status labels, due dates, and totals. The project test checks the due dates produced through `date-fns`.

## Use It In The Transformer

Select this `invoice-desk` folder in the legacy code transformer and run the local assessment. The project rates D. Select `calculateDiscount`, `buildInvoiceLines`, `formatLine`, `formatInvoiceStatus`, and the top-level statement unit.
Each finding shows its line and column; the source preview highlights flagged lines. Ticking a unit approves its findings, which you can adjust individually. Then approve the disclosed Foundry transfer, npm/OSV lookups, and local characterisation run.

The selected functions exercise nested branches, magic numbers, and a TODO comment; a long function with unclear local names; seven parameters with the vague name `val`; and six invoice-status branches that can become a lookup table. The statement combines a `var` declaration, loose equality, and a magic number.

For each function, the app generates five JSON inputs, runs the original twice to keep only stable cases, and replays those cases against the rewrite. Each proposal shows:

* The approved findings targeted, with their positions.
* The before and proposed source span.
* Every static and behaviour gate.
* One tab per characterisation case with its input, the original's result, and the rewrite's result.
* A Test file tab with the `node:test` file exported under `__characterisation__/`.
* Remaining findings. `too-many-params` on `formatLine` stays because the signature is preserved.
* For rejected proposals, both attempts and the gates each one failed.

The top-level statement has no function inputs, so acknowledge it as not-checked before applying.

Next, change Allowed update level to Up to major. The `date-fns` major update from `1.28.4` is marked Source migration supported. Select it; before anything is applied, every stable baseline replays against the combined staged copy.
The separate build checkpoint shows the package and lockfile diff, the exact commands, and that a curated source migration is available. After you approve, the app runs the project test on the original upload, then installs, builds, and tests the upgraded copy. Version 2.0 and later reject the `YYYY-MM-DD` format and do not convert date strings, so the project test fails on the upgraded copy.
Approve the migration to have Foundry propose a `src/due-date.js` change. The app reruns the build, project test, and characterisation on the migrated copy; accept it only after every check passes.

For a lower-risk run, keep Patch only and select the `lodash@4.17.20` patch update instead; it passes without code changes.

The downloaded `CODE-TRANSFORMATION-REPORT.md` records the before and after ratings (D towards B) and each source change. Its Dependency Updates section states whether code changes were needed for compatibility, shows the applied migration edit, and lists the build, project test, and characterisation results. The uploaded folder is never changed.
