---
title: Technical Debt Assessor Demo
description: Run a local JavaScript debt assessment and approve selected Foundry-proposed refactors with static and characterisation gates.
---

## Run The Demo

Requirements: Node.js 24 or later and a deployed Microsoft Foundry chat model for transformation. Local assessment works without Foundry configuration.

From the repository root, enter the demo folder. Create `.env` only if you do not already have one:

```powershell
Set-Location demos/legacy-codebase-transformation-web
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set `FOUNDRY_API_KEY`, `FOUNDRY_ENDPOINT`, and `FOUNDRY_MODEL` in `.env` to your resource endpoint and deployment. Optionally set `FOUNDRY_REWRITE_MODEL` to a stronger deployment on the same resource for source rewrites; input generation keeps using `FOUNDRY_MODEL`. The API key stays in the local Node server and is never sent to the browser. Do not paste it into chat or commit `.env`.

Stop an existing Vite server for this demo before reinstalling dependencies. Then run:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open `http://127.0.0.1:5173`. The API status is available at `http://127.0.0.1:5173/api/status`.

## Lifecycle

The demo moves through five stages. Each stage hands a defined output to the next, and nothing leaves your machine or executes until you approve it.

```mermaid
flowchart LR
  A[01 Choose project] --> B[02 Assess locally]
  B -->|select up to 5 units<br/>+ one combined approval| C[03 Review proposals<br/>per-proposal characterisation]
  C --> R[Apply<br/>combined characterisation re-check]
  R --> D[04 Build check<br/>only when dependency updates are selected<br/>build + characterisation on upgraded copy]
  D --> E[05 Export]
```

Characterisation runs on every path: once per proposal against its rewrite, and again across all selected proposals in the combined staged copy before anything is applied. When you select a dependency update, it runs a third time against the upgraded copy after the build passes. Stage 04 is the only optional step. It runs when you select a dependency update and needs its own approval.

| Stage | Inputs | What happens | Outputs | Network or execution |
|-------|--------|--------------|---------|----------------------|
| 01 Choose project | A local project folder (up to 500 files, 25 MB) | The browser uploads supported files to the local Node server; `node_modules` and `dist` are excluded | An in-memory session holding the file bytes | None |
| 02 Assess locally | Session files and optional `debt.config.json` | Babel parses each source file, measures every function, applies the rules, and scores the project | A–E rating, per-file scores, hotspots, findings with line and column, selectable units, coverage gaps, and a dependency inventory | None |
| 03 Review proposals | Up to five selected units, the findings you approved in each, and your combined approval | For each function, Foundry generates five inputs, the original runs twice to capture a baseline, Foundry rewrites the unit for the approved findings only, static gates run, and the rewrite replays the baseline. npm Registry and OSV evidence loads for the declared packages | One proposal per unit (`ready`, `rejected`, or `failed`) with its targeted findings, gates, case tabs, residual findings, attempt history, a preview of the generated test file, and dependency update candidates | Foundry, npm Registry, OSV, `npm ci --ignore-scripts` in a temporary copy, and local function execution |
| 04 Build check | Applied proposals, selected dependency updates, and your separate build approval | The server resolves the update, shows the `package.json` and lockfile diff, then runs `npm ci` and `npm run build` with scripts disabled in a temporary copy. After a passing build, every stable characterisation baseline replays against the upgraded copy; any difference blocks the update | Build status and output, per-function characterisation results, plus updated manifests when both pass | npm install, the project build script, and local function execution |
| 05 Export | The staged session | The server packages the staged project | A ZIP with the transformed source, `__characterisation__/*.test.js` files, updated manifests, and `TECH-DEBT-REPORT.md` with the before and after ratings | None |

Source-only runs skip stage 04. The uploaded folder is never modified, and the workflow does not run your project's own tests. Sessions live in server memory, so restarting the dev server clears them.

## Step-By-Step Demo Guide

This walkthrough uses the headline `samples/invoice-desk` project. It shows both a source refactor and a dependency upgrade.

1. Optionally confirm the sample works on its own: from `samples/invoice-desk`, run `npm.cmd ci` and `npm.cmd start`. The CLI prints two invoice summaries.
2. Start the assessor with `npm.cmd run dev` from this folder and open `http://127.0.0.1:5173`. The header shows the configured model, or `Foundry not configured`.
3. Choose Select folder, pick `samples/invoice-desk`, then choose Run local assessment.
4. Review the dashboard. The project rates D. The hotspots list `calculateDiscount` (nesting, complexity, magic numbers, a TODO), `buildInvoiceLines` (long function, unclear names), `formatLine` (seven parameters and the vague name `val`), and a top-level statement with `var`, `==`, and a magic number. Select a hotspot to open its local detail:
   * Each finding shows its position as `Line N:Col` for an exact token, or `Line N` for whole-function metrics, which point at the function's first line.
   * The source preview has line numbers. Lines with approved findings are highlighted red, lines with only unapproved findings are grey, and the badge counts the findings on that line.
   * Choose a finding's position to scroll the source to that line, or choose a flagged line to highlight its findings in the list.
5. Select those four units. Ticking a unit approves all of its findings. Use each finding's checkbox to drop any you do not want changed, or Select all and Clear all for the whole unit; clearing every finding deselects the unit. Only approved findings go to Foundry and the gates; unapproved findings stay as they are. The approval band shows the approved finding count, the exact source spans sent to Foundry, the package names and versions sent to npm and OSV, and that selected functions will execute locally.
6. Tick Also check npm dependencies if you want the dependency upgrade in this run. Leave it unticked for a source-only run: no npm Registry or OSV lookups happen and the dependency update and build check are skipped. Then approve once. While assessment or transformation runs, a spinner shows that work is in progress. Transformation also shows the current unit and step, such as baseline capture or rewrite, with a completed-unit count.
7. Review each proposal:
   * Approved findings targeted lists the findings you approved for that unit, with their line and column.
   * The BEFORE and PROPOSED columns show the replacement span.
   * The gate list shows each static and behaviour gate as PASS, FAIL, or NOT CHECKED.
   * The characterisation tabs show each case with its input, the original's result, and the rewrite's result. A failing case lists the exact fields that differ, for example `value[0].tax expected -7.42, got 0`, and the same differences go to the model for its one retry. The final Test file tab shows the exact `node:test` file that ships in the export.
   * Remaining findings list what the rewrite left behind. `too-many-params` on `formatLine` is expected because the signature is preserved.
   * Rejected proposals show both attempts and which gates each failed. They cannot be selected.
8. Tick the ready proposals. If a selected proposal is marked not-checked and has not been acknowledged, Apply opens a dialog listing the affected proposal and why characterisation did not run. Choose Go back to change the selection, or Acknowledge and continue to apply it without a behaviour check. The top-level statement has no function inputs, so it always needs acknowledgement.
9. Select the `lodash@4.17.20` patch update once its npm and OSV evidence appears (`uuid@3.4.0` is shown as deprecated but is only used for CLI invoice IDs), then choose Review update diff and build. The server re-runs every stable baseline against the combined staged copy before anything is applied.
10. In Build check, inspect the package and lockfile diff and the exact commands, then approve the build separately. After the build passes, the server replays each stable baseline against the copy with the upgraded lodash installed. If `buildInvoiceLines` returns anything different, the update is blocked and the build result names the function and the matched case count.
11. After the build and the post-update characterisation pass, download the ZIP. The generated tests are under `<project>/__characterisation__/`; from the extracted project folder, run them with `node --test __characterisation__`. They replay the stable cases against the transformed functions. The workflow does not run these tests automatically. Open `TECH-DEBT-REPORT.md` to see the rating move from D towards B, each applied change, the exported test-file paths, the post-update characterisation result, and the residual findings.

For a shorter source-only run, use `samples/dispatch-desk`. Select `summarizeDispatch`, approve, review its cases and gates, apply, and download. There are no dependencies, so stage 04 is skipped.

## How The Parts Work

Each server module owns one responsibility. The UI calls them through a small HTTP API.

| Module | Responsibility |
|--------|----------------|
| `server/assess/` | Parses source with Babel (`parse.js`), measures lines, nesting, complexity, callbacks, and branch chains per function (`metrics.js`), applies rules and thresholds (`rules.js`), builds selectable function, statement, and file units (`units.js`), and converts findings into remediation minutes and A–E ratings (`score.js`). Entirely local and deterministic. |
| `server/foundry-client.js` | Sends one prompt per request to the Foundry chat completions endpoint with a strict JSON schema, bounded response size, timeout, and credential leak check. Rewrites use `FOUNDRY_REWRITE_MODEL` when set. |
| `server/transform/prompts.js` | Builds the input-generation prompt and the rewrite prompt. The rewrite prompt sends only the selected unit, lists each required change (exact identifiers to rename, where constants go, TODO comments to delete without acting on them), states hard metric limits, and forbids new behaviour. |
| `server/characterise/` | `harness.js` writes the project to a temporary folder, installs locked dependencies when needed, and runs each case in a separate `node --permission` process that can only read that folder. `runner.cjs` captures the return value, thrown error, argument mutation, and console output. `export.js` renders the replayable `node:test` file. |
| `server/transform/gates.js` | Applies the rewrite to a copy of the file and checks span, hash, syntax, invariants, scope, metric improvement, and new findings. |
| `server/transform/agent.js` | Runs one unit end to end: generate inputs, capture the baseline, request a rewrite, run the static gates, replay the baseline against the rewritten copy, and retry once with the failed gates, unresolved findings, and mismatched cases as feedback. |
| `server/dependency-review.js` | Inventories declared and locked npm packages and gathers npm Registry and OSV evidence for update candidates. |
| `server/dependency-build.js` | Resolves an approved update with `npm install --package-lock-only`, then runs `npm ci` and `npm run build` with lifecycle scripts disabled in a temporary copy. |
| `server/workflow.js` | Owns sessions, the five-unit limit, approval checks, proposal state, the combined re-check before apply, the post-update characterisation replay, characterisation test staging, and the change report. |
| `server/api.js` | Exposes `/api/status`, `/api/analyze/prepare`, `/api/sessions/:id/transform`, `/progress`, `/apply`, `/updates/prepare`, `/updates/build`, and `/download`. |
| `src/App.jsx` | Renders the stages, approval band, proposals, gate list, case tabs, build checkpoint, and export. |

### How They Work Together

```mermaid
sequenceDiagram
  participant UI as Browser UI
  participant WF as workflow.js
  participant AS as assess
  participant AG as agent.js
  participant FD as Foundry
  participant CH as characterise
  participant GT as gates.js
  UI->>WF: upload folder
  WF->>AS: assessProject
  AS-->>UI: rating, hotspots, units
  UI->>WF: selected units + approval
  loop each selected unit
    WF->>AG: transformUnit
    AG->>FD: generate 5 inputs
    AG->>CH: run original twice, keep stable cases
    AG->>FD: rewrite with required changes
    AG->>GT: static gates on rewritten copy
    AG->>CH: replay cases against rewritten copy
    AG-->>AG: one retry with feedback if needed
  end
  WF-->>UI: proposals, gates, case tabs, test preview
  UI->>WF: apply selected proposals
  WF->>CH: replay every baseline on combined copy
  WF-->>UI: staged files, report, optional build checkpoint
  opt dependency update selected
    UI->>WF: approve build
    WF->>WF: npm ci + npm run build on upgraded copy
    WF->>CH: replay every baseline on upgraded copy
    WF-->>UI: build and characterisation results
  end
```

The assessor is the single source of truth for findings. The gates re-run it on the rewritten file, so a proposal must reduce the targeted smells without creating new ones. Characterisation is the behaviour check: the original's recorded outputs are the expected values, and the rewrite must reproduce them exactly. The combined re-check before apply catches interactions between proposals in the same file. The post-update replay catches behaviour changes caused by a new dependency version. The generated test file lets you replay the same cases later with `node --test`.

## Assessment Rules

The assessor parses `.js`, `.cjs`, `.mjs`, and `.jsx` source with Babel. Assessment is local and deterministic. Parse failures appear as coverage gaps and are not silently treated as clean files.

| Rule | Default warning | Default high |
|------|-----------------|--------------|
| `long-function` | 40 nonblank lines | 80 nonblank lines |
| `deep-nesting` | depth 3 | depth 5 |
| `high-complexity` | 10 | 20 |
| `too-many-params` | 4 | 6 |
| `callback-nesting` | depth 3 | depth 4 |
| `long-branch-chain` | 6 branches | 10 branches |
| `bad-variable-name` | short, vague, or numbered-copy name | not applicable |
| `magic-number` | numeric literal outside the allowlist | not applicable |
| `loose-equality` | `==` or `!=` | not applicable |
| `var-declaration` | each `var` declaration | not applicable |
| `debt-marker` | `TODO`, `FIXME`, or `HACK` | not applicable |
| `long-file` | 300 nonblank lines | 600 nonblank lines |
| `empty-catch` | empty `catch` block | not applicable |

Function metrics exclude nested function bodies, except that callback nesting measures nested callbacks. Top-level `var`, loose equality, and magic-number findings can be transformed as one statement unit. A TODO outside a selected function is report-only. A magic-number replacement declares its named constant at the beginning of the selected function body.

Each finding contributes estimated remediation minutes. Ratings compare that estimate with an allowance of 0.5 minutes per source line: A is at most 5%, B at most 10%, C at most 20%, D at most 50%, and E is above 50%. Estimates are starting values for this demo and can be calibrated with `debt.config.json` at the project root.

Example configuration:

```json
{
  "rules": {
    "long-function": { "warn": 50, "high": 90 }
  },
  "nameAllowlist": ["cfg"],
  "vagueNames": ["payload"],
  "magicAllowlist": [0, 1, -1, 2, 100]
}
```

## Transformation Gates

The app asks Foundry for exactly five JSON argument cases only after you select a function and approve the combined action. It runs the original function twice in a temporary copy, drops unstable cases, and requires at least three stable cases for a checked baseline. If the baseline is unavailable or unstable, the proposal is marked `not-checked` and needs acknowledgement.

The runner supports top-level CommonJS functions in modules without executable top-level expressions. It captures return values, thrown errors, argument mutation, and console output. Class methods, nested functions, and ESM targets are not characterised in v1. Characterisation test files are included in the ZIP for functions with stable baselines.

Node 24's permission model restricts filesystem access and child processes for the runner, but it does not block network access. The consent panel says when uploaded functions will execute. Build commands also execute uploaded code in a temporary directory that is not an OS sandbox. npm installation uses `--ignore-scripts`; lifecycle scripts remain disabled and project tests are not run.

Static gates require an exact unchanged source span, valid updated syntax, preserved function name/parameter count/module exports/module format, no colliding helper names, metric improvement, and no new warning-or-higher findings. Statement rewrites also pass a scope check for unsafe `var` conversions. Named-constant declarations with literal values at the start of a function do not count toward its length, so extracting magic numbers cannot create a new `long-function` finding.

Each proposal replays its stable cases against the rewritten copy, and the gate message reports how many cases differ and why any case failed to run. A failed attempt receives one retry with the failed gates, unresolved findings, and up to three mismatched cases as feedback. Before apply, every stable baseline runs again against the final combined staged copy.

`too-many-params` remains visible when the original function signature is preserved. This signature-protected finding does not block a proposal when another actionable smell improves and all other gates pass.

## Validation

From this folder:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
```

The project tests exercise assessment rules, characterization behavior, static gates, workflow and API contracts, and dependency review/build behavior. The browser app uses `npm run dev` and requires user approval before source transfer, npm/OSV lookup, or local function execution.
