---
title: Legacy Codebase Transformation Demo
description: Setup and safety boundaries for resumable source discovery and report suggestions applied with one exact-write approval.
---

## Overview

This standalone VS Code extension contributes the **Codebase-Level Legacy Code Transformation Agent**. It is separate from the [Targeted Legacy Code Transformation demo](../legacy-code-transformation/README.md), which retains its fixture-focused workflow.

The codebase-level agent scans eligible C#, JavaScript, and TypeScript source under an exact open workspace root in separately approved, resumable batches. It identifies local readability and maintainability opportunities and includes exact before/after suggestions in a Markdown report.
Select the changes you want, review one exact-write preview per file, then approve once to apply. Existing suggestions need no second model request or report. Custom refactors retain separate proposal source-sharing approval.

If model coordinates do not match a proposed snippet, the scanner derives corrected coordinates only when that exact snippet occurs once inside the declared function, allowing LF/CRLF differences. Altered snippets, ambiguous matches, and invalid ranges remain rejected. A report with failed chunks and no findings is an incomplete scan, not evidence that no refactoring opportunities exist.

## Run A Demo

Use a disposable copy of the Node fixture so any optional apply step leaves the repository source untouched. You need VS Code 1.140 or later, GitHub Copilot Chat, and an available model that supports the agent's tools.

From the repository root, copy the fixture and launch the extension development host:

```powershell
$demoRoot = Join-Path $env:TEMP ("legacy-codebase-demo-" + [guid]::NewGuid().ToString("N"))
Copy-Item "demos/legacy-code-transformation/fixtures/node" $demoRoot -Recurse
$extensionPath = (Resolve-Path "demos/legacy-codebase-transformation/extension").Path
code --extensionDevelopmentPath="$extensionPath" "$demoRoot"
```

In the new VS Code window, select **Codebase-Level Legacy Code Transformation Agent** from the agent picker. Use this sequence to show the review gates:

1. Ask: `Scan this exact workspace for readability and maintainability findings; show the source-sharing preview first.` The preview names the exact root, eligible files and bytes, total projected requests, `batchRequests`, `batchSourceBytes`, remaining chunks, model, destination, and limits.
Review it in Copilot Chat, then approve or reject in a later reply. Approval sends at most 30 requests for this batch, without stopping at 30 findings. Rejection sends no source. The extension displays progress during scanning.
2. Review the Markdown report that opens in the editor. It lists proposed files and lines with exact before snippets and unverified after suggestions, plus coverage, unsupported paths, and skipped paths with reasons.
Chat returns the `scanId`, `batchNumber`, cumulative requests, `filesReviewed`, `chunksReviewed`, `remainingChunks`, `canContinue`, `findingCount`, and `reportPath`/`reportOpened`. If the report could not open, use its saved path. Findings are model-dependent; do not promise a particular result.
3. When `canContinue` is true, ask: `Continue scan <scan-id> for the same exact workspace root; prepare the next source-sharing preview and wait.` Continuation uses `prepare` with the exact `projectRoot` and current `scanId`. Review and approve each new one-use preview separately before confirmation.
Earlier approval does not cover another batch. Repeat while continuation is available; do not treat remaining or failed chunks as reviewed. Cancellation retains completed findings and remaining chunks. A fresh scan without `scanId` replaces the current queue; continuation preserves finding dispositions.
4. For a review-only demo, stop at the report. To apply existing suggestions, ask: `Apply report findings <finding-id-1> and <finding-id-2> in <file-path>; show the exact-write preview and wait.` The agent prepares with a `findingIds` array of 1 to 30 unique same-file IDs. No separate finding approval, proposal generation, model request, or second report is needed. Selection authorizes preparing the preview, not writing. You can also reject findings through the review tool.
5. Review the path, `sourceHash`, and every change's exact original, replacement, range, proposal hash, and report hash in the write preview. Approve or reject in a later reply. Confirmation sends only the issued `previewId` and decision alongside `phase: confirm`. Mixed-file, overlapping, dismissed, stale, or dirty-source selections are rejected without writing.
6. After `applied`, refresh remaining findings. The extension performs one write/save for the file batch, not a transaction across files. Changed source needs a fresh scan before further edits. Repeat separately for another file. Apply itself runs no project commands or tests; the optional banking check below has its own execution approval.
7. To redo the full lifecycle, close the demo window and rerun the PowerShell setup above from the repository root. This creates a fresh, unmodified disposable sample and launches the current extension without overwriting your previous run. Select the agent, start a new chat, and repeat steps 1 through 6, then approve or decline the optional behavior check. Do not reload between applying and checking: reloading clears the original-source snapshot needed for comparison.

For a different refactor, request a custom proposal instead of applying the existing after snippet. Approve the finding, then review and approve the proposal's source-sharing preview before another model request. Review the generated replacement and prepare an exact-write preview using `proposalId` or same-file `proposalIds`, instead of `findingIds`. Confirm that write preview separately. Draft all desired custom proposals for a file before any writes; their behavior remains unverified.

Each preview expires after five minutes and can be used once. Chat decisions are model-mediated tool inputs; VS Code does not authenticate that the decision came from the human rather than the model. The agent workflow still asks and waits for an explicit chat reply at each gate.

Reports are immutable per-batch cumulative snapshots stored under the extension's global storage, not in the scanned project. They are historical evidence, not a live view of later finding dispositions.
Dependency manifests and lockfiles are not scanned, so dependency changes are not assessed. Dependency assessment is not part of this workflow. Model choices and destinations depend on your VS Code configuration. Applying is optional.

### Optional Behavior Check

After a successful apply, the agent prepares `legacy_codebase_transformation_demo_check_behavior` using the applied proposal IDs. Preparation executes nothing. Review the original and transformed hashes, eight existing tests, nine fixed case names, Node runtime, and execution commands.
The agent asks once: `Check behavior using these banking tests and sample inputs?` Approve execution or decline in a separate chat reply. You can skip it and keep the change; behavior remains `not-checked`. Scan and write approvals do not authorize test execution.

The checker uses Node.js 24.19.x from PATH and runs pinned banking tests and reset-state cases against disposable original and transformed copies. It compares stdout, stderr, exit codes, returned results, and balances. It makes no model requests, installs no dependencies, and does not write or revert project source. Temporary copies are not an OS sandbox; executing transformed code can have external side effects.

Results are `passed`, `failed`, or `not-checked`, with before/after test counts and matched sample counts when available. Failure does not undo the transformation. Passing covers only these tests and samples, not every possible input or complete equivalence.

The check supports only the known banking fixture with unchanged test, case, and runner files and an original-source snapshot from the current extension session. Dirty buffers, later source changes, arbitrary projects, and unavailable runtimes prevent checking. Reloading loses the applied snapshot; reset the disposable sample, start a fresh scan, and apply again to test this workflow after a reload.

### Inspect Uncertain Apply Outcomes

Read both `status` and `sourceWritten`, not just whether the tool reports success. A saved `verification-failed` result with `sourceWritten: true` means source was written but exact verification failed: inspect the path and resulting hash, and do not retry the proposal.
`sourceWritten: null` means the write outcome is unknown, not that no writes occurred. Inspect the current file and editor before any further action. Non-applied dirty-editor or save-failure outcomes also require inspection; an unsuccessful save can leave editor changes. Do not retry blindly or assume rollback.

## Scope And Limits

* Supported source extensions: `.cs`, `.js`, `.cjs`, `.mjs`, `.jsx`, `.ts`, and `.tsx`, including first-party source under `packages`. Hidden, dependency, and build directories are excluded. Unsupported paths and skipped paths with reasons are reported.
* Initial finding categories: redundant control flow, repeated local expressions or branches, and simplification of a complex function.
* Each approved scan batch is limited to 30 model requests, not 30 findings. Each batch validates an unchanged source fingerprint and session revision. Skipped files, rejected outputs, failures, and remaining chunks limit coverage. Failures remain incomplete and require a fresh scan.
* Only complete analysis of eligible supported source may be described as complete. Inventory alone is not analysis, and supported-source completion is not whole-codebase semantic understanding or coverage of arbitrary languages. Line-based chunks can split functions and do not establish full function or cross-symbol context.
* Findings, proposals, continuation state, and approval previews live only in extension-host memory. Reports persist in extension storage, but a restart requires a fresh scan. Changed roots, source, editor buffers, or exact spans invalidate affected findings and previews.
* Direct application groups 1 to 30 unique, non-overlapping report findings from one unchanged file snapshot and requires one exact-write approval. Custom proposal generation remains one span at a time, with separate source-sharing approval. Draft all desired custom proposals before writing. Applying one batch makes changed-file findings and proposals stale; scan changed source afresh.
* The extension does not load projects, invoke MSBuild or editor providers, or execute arbitrary projects. Only the separately approved optional banking checker runs pinned tests and fixed cases in temporary copies. Arbitrary-project behavior remains unverified.
* No source is written during discovery, review, or proposal generation.

## Validate

From the repository root, run the package-local checks:

```powershell
npm.cmd --prefix demos/legacy-codebase-transformation/extension test -- tests/manifest.test.js
npm.cmd --prefix demos/legacy-codebase-transformation/extension run check
npm.cmd --prefix demos/legacy-codebase-transformation/extension test
```

The focused manifest test checks package/tool integration and proposal/apply behavior using controlled local fixtures. The syntax check covers package JavaScript. The full suite includes real Node behavior-check tests on controlled temporary banking copies and requires Node.js 24.19.x on PATH. It does not launch a development host, make live model requests, or execute the user's scanned project.
Root plugin, extension, and documentation generators do not apply to this standalone demo. The targeted extension retains its own package checks and controlled fixture replay workflow.
