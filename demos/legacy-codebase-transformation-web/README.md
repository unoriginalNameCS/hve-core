---
title: Standalone Codebase Transformation Demo
description: Run a local React workflow that reviews uploaded source with Microsoft Foundry and exports only approved changes.
---

## Run The Demo

Requirements: Node.js 24 or later and a deployed Microsoft Foundry chat model. The default deployment name is `gpt-4.1-mini`.

From the repository root, enter the web demo folder. Create `.env` only if you do not already have one:

```powershell
Set-Location demos/legacy-codebase-transformation-web
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set `FOUNDRY_API_KEY`, `FOUNDRY_ENDPOINT`, and `FOUNDRY_MODEL` in `.env` if they are not already set. Use the Foundry resource endpoint and deployment name from your project. The API key stays in the local Node server and is never sent to the browser. Do not paste it into chat or commit `.env`.

Before installing, stop any existing Vite server for this demo with Ctrl+C in the terminal where it is running, including another terminal from an earlier session. On Windows, Vite holds `esbuild.exe` open and `npm.cmd ci` can fail with `EPERM` while that process is active. Then install the locked dependencies and start the app:

```powershell
npm.cmd ci
npm.cmd run dev
```

Keep that terminal running and open `http://127.0.0.1:5173`. To confirm the backend loaded configuration, visit `http://127.0.0.1:5173/api/status`; it should return `configured: true` and the model name. Choose a project folder to begin.

If the page is blank, check the terminal where Vite is running and the browser developer console for a React/runtime error, then hard-refresh the page after fixing it. If `npm.cmd ci` still fails with `EPERM` on `esbuild.exe`, check for another running Vite terminal, stop it, retry `npm.cmd ci`, and then run `npm.cmd run dev`.

If the page loads but behaves like an older version (for example, the build check says unavailable for the `npm-review` sample), the dev server is running stale backend code. Stop it with Ctrl+C and run `npm.cmd run dev` again. Saving files under `server/` now restarts the API automatically; in-progress reviews are lost when that happens.

The app first prepares a local inventory and shows the exact source paths and npm package identifiers before any external request. When both source and npm identifiers are present, one combined approval starts Foundry and npm/OSV analysis together in the same review. Review the evidence and proposed source replacements, then download the transformed ZIP. The uploaded folder is not modified.

## Demo Walkthrough

Use the small banking sample for source refactoring. In the folder picker, navigate from the repository root to:

```text
demos/targeted-legacy-code-transformation/fixtures/node
```

This fixture contains six files and does not require `npm install`. Select the `node` folder itself, not its parent `fixtures` folder.

1. Select the `node` folder and prepare the review.
2. On the data-review step, inspect the source paths. Check **Send source to Foundry** to approve the model transfer.
3. Review the findings. Expand **Inspect exact change** to compare each original span with its proposed replacement.
4. Select only the findings you approve, then choose **Approve ... and transform**. To leave source unchanged, choose **Reject review** instead.
5. Review the **What changed** report: each applied change with file, line range, rationale, and before/after code. Then download the transformed ZIP. The fixture remains unchanged; the ZIP contains the staged copy with only approved edits.

To demo code and npm analysis together, use this compact sample:

```text
demos/legacy-codebase-transformation-web/samples/npm-review
```

This sample contains one source file, `package.json`, a v3 lockfile, and a root `build` script; it needs no local `npm install` and has no `node_modules` directory. After **Prepare review**, confirm the data-review panel says the build check is available. If it says unavailable, reject that preview, refresh the page, and select the folder again. Inspect the source path, Registry names, and exact OSV name/version tuples, then approve the combined transfer once to run both analyses in the same review.

After evidence loads, select a nondeprecated direct update candidate, such as the `mkdirp` major-version candidate. Choose **Resolve 1 update** (or the matching update count) to resolve the package/lock diff in a temporary copy. Review the exact direct and transitive lock changes and the displayed build command. Then acknowledge the build warning and choose **Run build and stage download**.

The app runs the displayed `npm ci --ignore-scripts` install with the public npm registry and
empty npm config, then `npm --ignore-scripts run build` to suppress lifecycle hooks. It does not
run tests. The build script executes uploaded project code, and the temporary directory is not an
OS sandbox. Only a successful build stages the approved source and dependency changes for ZIP
download; a failed build leaves the uploaded files unchanged. Generated build output and
`node_modules` are not included in the ZIP.

Project tests are never run. Dependency edits are made only in the staged copy after the selected update's build succeeds. After a successful transform, the **What changed** report lists source before/after code, package version changes, lockfile changes, and the build output. The ZIP also contains `TRANSFORMATION-REPORT.md` with the same change details.

For a larger multi-file sample with deprecated dependencies and source refactoring candidates, use:

```text
demos/legacy-codebase-transformation-web/samples/order-desk
```

This Node.js order desk app has separate order-report and catalog-search modules plus direct dependencies pinned to deprecated versions of `mkdirp` and `uuid`. From the sample folder, run `npm ci` and `npm start` to see its output. Select the `order-desk` folder in the demo, inspect the disclosed source and package identifiers, and approve the combined analysis. The intentionally nested `buildOrderReport` and repetitive `searchCatalog` functions are source-refactoring candidates; the dependency panel shows the deprecation notices and update candidates. Selecting updates exposes the package/lockfile diff and the app's `npm run build` command for explicit approval.

For the most visually obvious source-only transformation, use:

```text
demos/legacy-codebase-transformation-web/samples/dispatch-desk
```

This small Node.js CLI has one roughly 25-line `summarizeDispatch` function with deeply nested request, status, destination, and package validation branches. The web scan prompt prioritizes a whole-function simplification for this kind of target. Run the sample with `npm start`, then select the `dispatch-desk` folder in the demo and approve source analysis. Compare the full function in the report to see whether the model produces the shorter guard-clause replacement. This source-only sample has no dependencies to update.

<details>
<summary>How each step works: inputs, outputs, and tools</summary>

### 1. Select and prepare a folder

- **Input:** One folder selected with the browser's folder picker. The demo accepts up to 500 files and 25 MB total.
- **Tools:** The React page uses the browser File API and sends a multipart upload to the local Express API. Busboy parses the upload.
- **Work:** The browser filters excluded/generated paths. The server checks the manifest against uploaded bytes, normalizes relative paths, and rejects duplicate, conflicting, oversized, or multi-root uploads. It builds a UTF-8 source inventory and an npm manifest/lock inventory in memory. No network calls are made yet.
- **Output:** A short-lived review session plus a preview of source paths/chunks, npm package names and exact locked versions, inventory gaps, and whether the supported dependency build path is available.

The dependency lists are generated from the selected folder's manifests and lockfiles, not hard-coded for a sample. Registry names are direct dependencies; OSV tuples also include supported transitive dependencies recorded in the lockfile. This is a fixed snapshot of the upload for consent, not live Registry/OSV results. Select a new folder to prepare a different snapshot.

### 2. Review data transfers and analyze

- **Input:** The source-sharing and dependency-metadata approvals shown in the data-review step. When supported source and npm lookup identifiers are both present, both approvals must be given together.
- **Tools:** The server calls the configured Microsoft Foundry chat-completions deployment for source analysis, `registry.npmjs.org` for direct package metadata, and OSV for exact package/version advisory evidence.
- **Work:** Source files are chunked and prompted using the existing `workspace-scan.js` helpers; `scan-pipeline.js` validates the response contract. The server checks proposed paths, ranges, and exact source text before presenting findings. npm requests send only the disclosed package names or name/version tuples. The Foundry key remains server-side; manifests, source, and credentials are not sent to npm or OSV.
- **Output:** Proposed source findings with exact before/replacement text, rationale, and confidence, plus Registry and OSV evidence and any coverage gaps. Provider evidence is advisory, not a compatibility or exploitability decision.

If some model proposals fail validation, those proposals are excluded and the scan is marked incomplete. When only line/character coordinates are out of bounds, the adapter can recover a proposal if its exact original text occurs once in that source chunk, then reruns normal validation. Missing or ambiguous source text remains rejected. Individually validated findings remain selectable; approving them does not mean every source file was successfully analyzed.

### 3. Review and approve source changes

- **Input:** Finding IDs individually selected by the user.
- **Tools:** The React review UI posts the selection to the Express API. The server applies edits to an in-memory copy.
- **Work:** Before applying, the server verifies the source hash and exact text span again, rejects unknown or overlapping selections, and applies approved replacements only. It does not modify the selected folder. This source-only route does not run a project build.
- **Output:** An approved staged copy and a change report containing file, line range, rationale, and before/after text. The user can proceed to export or choose dependency updates when eligible.

### 4. Resolve optional dependency updates

- **Input:** Selected eligible direct update candidates, plus any source findings selected for the same staged copy.
- **Tools:** The Node server uses npm with scripts disabled and the public npm registry to resolve a temporary package/lockfile copy. It supports a single root `package.json`, an npm lockfile v2/v3, and a declared root build script; unsupported layouts are not offered this update/build path.
- **Work:** The server updates selected manifest declarations in the temporary copy, resolves the lockfile, validates the result, and compares old and new direct and transitive lock entries. This preview does not modify the uploaded folder or run project lifecycle scripts.
- **Output:** An exact package and lockfile diff and the install/build commands for review. No dependency changes are staged for download yet.

### 5. Approve and run the build

- **Input:** Explicit acknowledgement of the displayed build command and the exact staged update preview.
- **Tools:** The server runs `npm ci --ignore-scripts` and then `npm --ignore-scripts run build` in a temporary copy, with bounded execution time/output and a sanitized environment.
- **Work:** The build command is uploaded project code, and the temporary directory is not an OS sandbox. Lifecycle scripts are disabled; project tests are not run. A failed install or build does not enable download.
- **Output:** On success, the staged source, manifest, and lockfile become exportable and the report records build status/output. On failure, the result is shown in the UI and no transformed ZIP is made available.

### 6. Export the transformed copy

- **Input:** An applied source-only session, or a session whose approved dependency update passed the build.
- **Tools:** The Express download route uses `archiver` to create a ZIP from the staged in-memory files.
- **Work:** The archive includes `TRANSFORMATION-REPORT.md` with the approved source before/after changes, package and lock changes, build details when applicable, and a tests-not-run note. The original uploaded folder remains unchanged.
- **Output:** A downloadable transformed ZIP. Review state is held in server memory, expires after inactivity, and is lost if the server restarts.
</details>

## Scope And Limits

The demo accepts up to 500 files and 25 MB per review. It analyzes at most 30 source chunks, with at
most one additional Foundry retry per chunk when source or replacement text is invalid. Retry feedback
names the specific text-field failure without echoing source code. This allows at most 60 sequential
Foundry requests. It makes at most 100 npm Registry lookups, 200 OSV version queries, and 300 metadata
requests. Supported UTF-8 source
extensions are `.cs`, `.js`, `.cjs`, `.mjs`, `.jsx`, `.ts`, and `.tsx`. Files under `.git`, `node_modules`,
`vendor`, `bin`, `obj`, `dist`, `build`, `coverage`, `generated`, `out`, and `target` are excluded.

The npm review supports a single root `package.json` and npm lockfile v2/v3 for updates. With consent,
direct package names are looked up at `registry.npmjs.org` for published version and deprecation
metadata. Exact locked package/version tuples are queried at OSV. Package identifiers can reveal
private project metadata; the app displays the bounded lookup lists before asking. When source and npm
identifiers both exist, partial analysis approval is rejected; approve both analyses together or reject
the upload. Update resolution is separately approved after candidate selection and diff review.

This version does not run project tests, execute lifecycle scripts, persist reviews after a server restart, or provide authentication or hosting. The declared build command is executed only after explicit approval, in a temporary copy that is not an OS sandbox. Review sessions expire after 30 minutes of inactivity.

Model output is unverified. The server validates each proposed exact source span and requires explicit selection before applying it to the staged copy. No change is written to the original folder.
