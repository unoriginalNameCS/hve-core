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

Install the locked dependencies, then start the app:

```powershell
npm.cmd ci
npm.cmd run dev
```

Keep that terminal running and open `http://127.0.0.1:5173`. To confirm the backend loaded configuration, visit `http://127.0.0.1:5173/api/status`; it should return `configured: true` and the model name. Choose a project folder to begin.

If the page is blank, check the terminal where Vite is running and the browser developer console for a React/runtime error, then hard-refresh the page after fixing it. If `npm.cmd ci` fails with `EPERM` on `esbuild.exe`, stop the Vite server with Ctrl+C first, run `npm.cmd ci` from this demo folder, and restart with `npm.cmd run dev`. Do not run `npm ci` while the dev server is holding its files open.

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

## Scope And Limits

The demo accepts up to 500 files and 25 MB per review. It makes at most 30 sequential Foundry requests,
100 npm Registry lookups, 200 OSV version queries, and 300 metadata requests. Supported UTF-8 source
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
