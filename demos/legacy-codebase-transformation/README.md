---
title: Legacy Codebase Transformation Demo
description: Setup and safety boundaries for bounded codebase-level legacy refactoring discovery and exact-span proposals.
---

## Overview

This standalone VS Code extension contributes the **Codebase-Level Legacy Code Transformation Agent**. It is separate from the [Targeted Legacy Code Transformation demo](../legacy-code-transformation/README.md), which retains its fixture-focused workflow.

The codebase-level agent scans C#, JavaScript, and TypeScript under an exact open workspace root. It identifies bounded readability and maintainability opportunities, then drafts one exact-span proposal from a finding that you explicitly approve.

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

1. Ask: `Scan this exact workspace for bounded readability and maintainability findings.` Review the extension's consent dialog, including eligible files and bytes, projected requests, model, destination, and limits. Approve only if you are comfortable sharing that source with the displayed destination. Declining cancels the scan; do not retry without a new request.
2. Ask: `List the current findings and show the source range, rationale, confidence, and freshness for each.` Choose one in-scope finding. Findings are model-dependent, so do not promise that a particular result will appear.
3. Ask to select the finding by its ID, then ask to approve it. Review the separate approval dialog. This permits proposal drafting only; it does not permit a source write.
4. Ask: `Draft a readability proposal for finding <finding-id>.` Review the second source-sharing dialog before approving it. Then inspect the exact original and replacement, rationale, unknowns, and source hash returned by the agent. The proposal is unverified and project tests are not run.
5. For a review-only demo, stop here. To demonstrate the optional write, explicitly ask to apply the returned proposal, inspect the exact-diff dialog, and approve only if the change is intended. The extension writes only the approved span in the disposable copy; it does not run project commands or tests.

The extension requests consent before sending source for each scan and again before sending recollected context for a proposal. Model choices and destinations depend on your VS Code configuration. Applying is optional and is not needed to demonstrate discovery, finding review, and proposal generation.

## Scope And Limits

* Supported source extensions: C#, JavaScript, and TypeScript.
* Initial finding categories: redundant control flow, repeated local expressions or branches, and simplification of a complex function.
* Each scan is limited to 30 model requests and 30 findings; skipped files, rejected outputs, and remaining work are reported rather than described as comprehensive coverage.
* Findings and proposals live only in extension-host memory. A restart requires a new scan; changed roots, source, editor buffers, or exact spans make prior findings unusable.
* Proposal generation is limited to one source span in one file. Applying requires a separate explicit request and exact-diff confirmation.
* The extension does not load projects, invoke MSBuild or editor providers, or run builds, tests, scripts, or proposed code. Arbitrary-project behavior is unverified and tests are not run.
* No source is written during discovery, review, or proposal generation.

## Validate

From the repository root, run the package-local checks:

```powershell
npm.cmd --prefix demos/legacy-codebase-transformation/extension run check
npm.cmd --prefix demos/legacy-codebase-transformation/extension test
```

These checks do not launch a development host or make live model requests. The targeted extension retains its own package checks and controlled fixture replay workflow.
