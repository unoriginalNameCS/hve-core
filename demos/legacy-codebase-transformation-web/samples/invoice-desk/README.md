---
title: Invoice Desk Sample
description: A CommonJS invoice CLI with intentional technical debt and a pinned dependency update for the assessor demo.
---

## Run The Sample

From this folder, run:

```powershell
npm ci
npm start
```

The CLI prints two invoice summaries with generated invoice run IDs. Output totals are stable apart from the run ID.

## Use It In The Assessor

Select this `invoice-desk` folder in the technical debt assessor and run the local assessment. The project rates D. Select `calculateDiscount`, `buildInvoiceLines`, `formatLine`, and the top-level statement unit. Each finding shows its line and column, and the line-numbered source preview highlights the flagged lines. Ticking a unit approves all its findings; untick any finding you want left alone. Then approve the disclosed Foundry transfer, npm/OSV lookups, and local characterisation run once.

The three selected functions exercise nested branches, magic numbers, and a TODO comment; a long function with unclear local names; and seven parameters with the vague name `val`. The statement combines a `var` declaration, loose equality, and a magic number.

For each function, the app generates five JSON inputs, runs the original twice to keep only stable cases, and replays those cases against the rewrite. Each proposal shows:

* The approved findings targeted, with their positions.
* The before and proposed source span.
* Every static and behaviour gate.
* One tab per characterisation case with its input, the original's result, and the rewrite's result.
* A Test file tab with the `node:test` file exported under `__characterisation__/`.
* Remaining findings. `too-many-params` on `formatLine` stays because the signature is preserved.
* For rejected proposals, both attempts and the gates each one failed.

The top-level statement has no function inputs, so acknowledge it as not-checked before applying.

Next, select the `lodash@4.17.20` patch update. `uuid@3.4.0` is reported as deprecated and is only used for CLI invoice IDs. Before anything is applied, every stable baseline replays against the combined staged copy. The separate build checkpoint shows the package and lockfile diff and the exact commands. After you approve, the app installs and builds the upgraded copy, then replays every stable baseline again against it. Only a passing build and matching characterisation make the staged ZIP available.

The downloaded `TECH-DEBT-REPORT.md` records the before and after ratings (D towards B), each change, the post-update characterisation result, and the residual findings. The uploaded folder is never changed.
