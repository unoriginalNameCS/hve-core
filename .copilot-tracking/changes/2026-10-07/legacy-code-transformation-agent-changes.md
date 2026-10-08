<!-- markdownlint-disable-file -->

# RPI Changes: Legacy Code Transformation Agent PoC

## Metadata

* Task ID: RPI-LCTA-2026-10-07
* Related plan: [.copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md](../../plans/2026-10-07/legacy-code-transformation-agent-plan.md)
* Implementation date: 2026-10-07

## Execution Status

* Status: Partial
* Declared invocation scope: full plan
* Completed scope markers: P01, P01-T01, P01-T02, P02-T01, P02-T02
* All remaining active-plan markers: P02, P02-T03, P03, P03-T01, P03-T02, P04, P04-T01, P04-T02
* Status basis: The standalone extension, .NET pizza baseline, bounded discovery, and consent-gated Roslyn analysis are implemented. A manually invokable read-only demo is available. Report generation, Foundry adapter, approval-bound apply, behavior replay, and Node banking support remain.

## Execution Summary

P01, P02-T01, and P02-T02 are complete. The extension provides read-only selected-root discovery and evidence reads, with consent-gated Roslyn syntax/MSBuild analysis. The controlled pizza integration returns the target method and in-root caller. The fixture baseline outputs are `2.50`, `0.00`, `5.00`, and `7.50` for its four representative cases.

## Completed Work

### Standalone extension scaffold

* Related phase or task: P01-T01
* Files:
	* [demos/legacy-code-transformation/extension/package.json](../../../demos/legacy-code-transformation/extension/package.json)
	* [demos/legacy-code-transformation/extension/package-lock.json](../../../demos/legacy-code-transformation/extension/package-lock.json)
	* [demos/legacy-code-transformation/extension/.npmrc](../../../demos/legacy-code-transformation/extension/.npmrc)
	* [demos/legacy-code-transformation/extension/src/extension.js](../../../demos/legacy-code-transformation/extension/src/extension.js)
	* [demos/legacy-code-transformation/extension/agents/legacy-code-transformation.agent.md](../../../demos/legacy-code-transformation/extension/agents/legacy-code-transformation.agent.md)
	* [demos/legacy-code-transformation/extension/tests/manifest.test.js](../../../demos/legacy-code-transformation/extension/tests/manifest.test.js)
* Behavior or functionality changed: The demo has an independent VS Code extension package with a bundled, manually invokable discovery-preview agent and only two read-only tools. The full proposal/apply workflow remains unavailable; no HVE Core plugin membership changed.
* Validation: `npm.cmd ci` passed in the demo extension root; `npm.cmd run check` passed; `npm.cmd test` passed 2 manifest tests. Root `npm.cmd ci` and `npm.cmd run lint:md` passed. `npm.cmd run lint:frontmatter` was unavailable because `pwsh` is not on the terminal PATH.

### .NET pizza behavior baseline

* Related phase or task: P01-T02
* Files:
	* [demos/legacy-code-transformation/fixtures/dotnet/PizzaEligibility.sln](../../../demos/legacy-code-transformation/fixtures/dotnet/PizzaEligibility.sln)
	* [demos/legacy-code-transformation/fixtures/dotnet/src/PizzaEligibility/Program.cs](../../../demos/legacy-code-transformation/fixtures/dotnet/src/PizzaEligibility/Program.cs)
	* [demos/legacy-code-transformation/fixtures/dotnet/src/PizzaEligibility/PizzaDiscountCalculator.cs](../../../demos/legacy-code-transformation/fixtures/dotnet/src/PizzaEligibility/PizzaDiscountCalculator.cs)
	* [demos/legacy-code-transformation/fixtures/dotnet/tests/PizzaEligibility.Tests/PizzaEligibilityTests.cs](../../../demos/legacy-code-transformation/fixtures/dotnet/tests/PizzaEligibility.Tests/PizzaEligibilityTests.cs)
	* `demos/legacy-code-transformation/fixtures/dotnet/src/PizzaEligibility/PizzaEligibility.csproj`
	* `demos/legacy-code-transformation/fixtures/dotnet/tests/PizzaEligibility.Tests/PizzaEligibility.Tests.csproj`
* Behavior or functionality changed: A deliberately nested but correct evaluator and a console runner now establish the agreed member/threshold behavior, with deterministic tests for four representative cases.
* Validation: `dotnet test PizzaEligibility.sln --verbosity minimal` passed 4/4 tests. Console replay outputs: `25.00 true` -> `2.50`; `49.99 false` -> `0.00`; `50.00 false` -> `5.00`; `75.00 false` -> `7.50`.

### Root-bounded discovery and focused evidence reads

* Related phase or task: P02-T01
* Files:
	* [demos/legacy-code-transformation/extension/src/workspace-scope.js](../../../demos/legacy-code-transformation/extension/src/workspace-scope.js)
	* [demos/legacy-code-transformation/extension/src/workspace-discovery.js](../../../demos/legacy-code-transformation/extension/src/workspace-discovery.js)
	* [demos/legacy-code-transformation/extension/src/source-evidence.js](../../../demos/legacy-code-transformation/extension/src/source-evidence.js)
	* [demos/legacy-code-transformation/extension/src/extension.js](../../../demos/legacy-code-transformation/extension/src/extension.js)
	* [demos/legacy-code-transformation/extension/package.json](../../../demos/legacy-code-transformation/extension/package.json)
	* [demos/legacy-code-transformation/extension/tests/workspace-scope.test.js](../../../demos/legacy-code-transformation/extension/tests/workspace-scope.test.js)
	* [demos/legacy-code-transformation/extension/tests/workspace-discovery.test.js](../../../demos/legacy-code-transformation/extension/tests/workspace-discovery.test.js)
	* [demos/legacy-code-transformation/extension/tests/source-evidence.test.js](../../../demos/legacy-code-transformation/extension/tests/source-evidence.test.js)
	* [demos/legacy-code-transformation/extension/tests/manifest.test.js](../../../demos/legacy-code-transformation/extension/tests/manifest.test.js)
* Behavior or functionality changed: The extension rejects unopened roots and out-of-root paths, returns in-root symbols/references/call hierarchy and line matches, and reads requested line ranges only after canonical URI validation.
* Validation: `npm.cmd run check` passed; `npm.cmd test` passed 13/13 tests, including path traversal, symlink escape, sibling-prefix, provider-result filtering, evidence line ranges, and tool registration.

## Implementation-Time Plan Updates

### Bundle the custom agent with the demo extension

* Affected plan area or markers: P01-T01, Sources.
* What changed: Bundle `demos/legacy-code-transformation/extension/agents/legacy-code-transformation.agent.md` with `contributes.chatAgents`; launch each fixture folder as the target workspace root, with extension source outside it.
* Why: VS Code supports extension-contributed agents, while HVE Core plugin synchronization starts from tracked files under the repository-root `.github` artifact tree.
* Triggering evidence: RPI research W16 and C5; official VS Code contribution-point documentation and `scripts/plugins/Sync-PluginManifest.ps1`.
* User answer or decision: None; agent-owned implementation detail within the confirmed separate-demo boundary.
* Reconciliation performed: Updated P01-T01 References/Details and the plan Sources section. The current component diagrams already show the agent and extension tool provider; no topology change was needed.
* Planning and critique state: W16/C5 confirm the extension-contributed path; plan critique-3 passed. P01 and P02-T01 are complete; P02-T02 resumes with the MSBuild confirmation gate.

### Pin the proposal contract and target boundary

* Affected plan area or markers: FR-005, P01-T02, P02-T03.
* What changed: Restrict proposals to the selected function/class and explicitly test the $49.99/$50.00 discount boundary. Define a JSON Schema contract for model proposal output and require tool-validated evidence references.
* Why: The selected target and exact approval rules need machine-checkable boundaries; the sample needs a deterministic threshold regression case.
* Triggering evidence: User-approved scope boundaries and the RPI plan's schema-contract requirement.
* User answer or decision: None; this refines already confirmed user direction.
* Reconciliation performed: Updated FR-005, P01-T02, P02-T03 Requirements/Details, and the plan self-check; no phase or dependency changes.
* Planning and critique state: Standard follow-up critique passed; runtime validation remains pending.

### Stage custom-agent availability

* Affected plan area or markers: P01-T01, P02-T03, P03-T01.
* What changed: Keep the contributed agent hidden and tool-less through P01-P02; make it user-invocable only after P03 registers the proposal-bound apply tool. Make the pizza replay explicitly test the $49.99 and $50.00 boundary.
* Why: The agent should not appear usable until its complete approval-gated workflow exists, and the sample threshold must have deterministic edge coverage.
* Triggering evidence: Plan sequencing review of P01-P03 and the user-confirmed pizza threshold.
* User answer or decision: None; implementation sequencing detail within confirmed scope.
* Reconciliation performed: Updated task Requirements/Details for P01-T01, P01-T02, P02-T03, and P03-T01; phase dependencies and diagrams remain unchanged.
* Planning and critique state: Plan critique-3 passed after the bundled-agent packaging refinement. P02-T01 is complete; no full workflow behavior is claimed.

### Add focused source-evidence reads

* Affected plan area or markers: P02-T01, P02-T03.
* What changed: The plan requires a read-only line-range tool for normalized project-relative paths, with canonical URI validation before reads; the report stage uses it for focused test and documentation excerpts.
* Why: Discovery needs citeable test/doc context without generic unbounded reads.
* Triggering evidence: P02-T01 implementation showed that file inventory and symbol matches did not retrieve selected supporting excerpts.
* User answer or decision: None; detail completes the existing bounded evidence requirement.
* Reconciliation performed: Updated P02-T01 Requirements/Details and P02-T03 Details; implemented and tested the bounded evidence reader; checked P02-T01. Phase structure and user scope are unchanged.
* Planning and critique state: Critique-3 passed the bundled-agent packaging path; P02-T01 is complete and P02-T02 is next.

### Enable early read-only agent demo

* Affected plan areas or markers: P01-T01, P02-T02, P02-T03.
* What changed: Expose the agent for manual invocation with only bounded discovery and source-evidence tools. Keep automatic invocation disabled and prohibit Foundry, edits, and project execution in this preview.
* Why: The user wants an early demo to assess the intended experience before the full proposal/apply workflow is complete.
* User answer or decision: The user explicitly requested continuing implementation toward an early demo. This authorizes read-only preview only.
* Reconciliation performed: Updated agent frontmatter/instructions, guarded the allowlist with a manifest test, revised the plan's prior hidden-agent gate, and documented the flow in the demo README.
* Planning and critique state: Plan updated in place; proposal generation and application remain later tasks.

## Plan Update: Roslyn Load Safety
### Gate Roslyn project loading on explicit confirmation

* Affected plan area or markers: P02-T02; research Q8 and Cycle 2.
* What changed: Require extension-owned confirmation before loading arbitrary projects with Roslyn MSBuild Workspaces. If declined, skip MSBuild loading and use syntax-only parsing, bounded search, and available editor-provider results with semantic references marked unresolved. Restrict PoC MSBuild loading tests to the controlled pizza fixture.
* Why: Roslyn 5.9.0 executes design-time `Compile`/`CoreCompile` targets in a separate BuildHost process; custom target tasks may run, and process separation is not a sandbox.
* Triggering evidence: Research W17-W22, including the version-pinned Roslyn 5.9.0 project-load path, target flags, and `Process.Start` implementation.
* User answer or decision: None; this is a required safety boundary for the already approved read-only analysis scope.
* Reconciliation performed: Completed Cycle 2 Wider, Deeper, and Contrarian; answered Q8; updated research readiness, P02-T02 requirements, details, and references. Implemented the modal and fallback; directly loaded only the controlled pizza project through the worker. No arbitrary user project was loaded.
* Planning and critique state: P02-T01 remains checked and complete. P02-T02 is in progress; extension-launched MSBuild validation remains.

## Plan Update: Early Read-Only Demo

* Affected plan areas or markers: P01-T01, P02-T02, P02-T03.
* What changed: Expose the bundled agent for manual invocation with only the existing bounded discovery and source-evidence tools. The agent returns a read-only evidence summary and cannot invoke Foundry, edit files, or run project commands.
* Why: The user asked to demo the current implementation soon to assess whether it meets their needs.
* User answer or decision: User authorized continuing implementation for an early demo. This is a bounded preview, not approval to expose refactoring or source mutation.
* Reconciliation performed: Updated agent frontmatter and demo instructions, added a manifest test for the exact tool allowlist, and updated the demo README with agent-picker usage. Existing proposal/apply requirements remain for later phases.
* Planning and critique state: Plan updated in place; P02-T02 is complete against the controlled pizza fixture. VS Code-host interaction remains a manual smoke check. Follow-up critique not run.

## Completed Work Follow-Up

### P02-T02: Consent-gated Roslyn discovery

* Files:
	* [demos/legacy-code-transformation/extension/src/roslyn-worker.js](../../../demos/legacy-code-transformation/extension/src/roslyn-worker.js)
	* [demos/legacy-code-transformation/extension/src/workspace-discovery.js](../../../demos/legacy-code-transformation/extension/src/workspace-discovery.js)
	* [demos/legacy-code-transformation/extension/package.json](../../../demos/legacy-code-transformation/extension/package.json)
	* [demos/legacy-code-transformation/extension/tests/workspace-discovery.test.js](../../../demos/legacy-code-transformation/extension/tests/workspace-discovery.test.js)
	* [demos/legacy-code-transformation/extension/roslyn-worker/LegacyCodeTransformation.RoslynWorker.csproj](../../../demos/legacy-code-transformation/extension/roslyn-worker/LegacyCodeTransformation.RoslynWorker.csproj)
	* [demos/legacy-code-transformation/extension/roslyn-worker/NuGet.Config](../../../demos/legacy-code-transformation/extension/roslyn-worker/NuGet.Config)
	* [demos/legacy-code-transformation/extension/roslyn-worker/Program.cs](../../../demos/legacy-code-transformation/extension/roslyn-worker/Program.cs)
* Behavior: C# discovery asks before language-provider or MSBuild analysis. Declining parses source text already read inside the selected root and leaves semantic references unresolved. After confirmation, the worker statically preflights project references, imports, source includes, and task assemblies before opening the project; returned locations are filtered to the root.
* Validation: Extension suite passed 17/17; worker build passed; syntax-only fallback and external-reference rejection passed; end-to-end `discoverTarget` invoked the real worker against the controlled pizza fixture and returned `CalculateDiscountAmount` with its in-root caller.
* Remaining: The VS Code development-host modal/agent interaction has not been manually smoke-tested. P02-T02 requirements are otherwise met for the controlled fixture; arbitrary projects remain gated by confirmation and root preflight.

## Current In-Progress Work

### P02-T03: Validate proposal contracts and render reports

* Status: In progress. The local contract validator and renderer are not yet connected to discovery evidence, an agent tool, report-file writing, or a Foundry adapter.
* Live Foundry remains gated on endpoint/model configuration and data-sharing permission.

* Files:
	* [demos/legacy-code-transformation/extension/src/proposal-contract.js](../../../demos/legacy-code-transformation/extension/src/proposal-contract.js)
	* [demos/legacy-code-transformation/extension/tests/proposal-contract.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-contract.test.js)
	* [demos/legacy-code-transformation/extension/package.json](../../../demos/legacy-code-transformation/extension/package.json)
* Behavior: Proposal validation enforces a closed data shape, selected target identity, citations within collected evidence, normalized project-relative paths, and original text found in collected source. Valid proposals render to Markdown without writing project files.
* Validation: Focused proposal-contract tests passed 6/6; the extension syntax check includes the new module. The combined suite output did not complete in the terminal capture, so no aggregate test count is claimed here.
* Remaining in P02-T03: Connect the validator to tool-collected evidence, implement a report writer and mockable Foundry adapter, and resolve endpoint/auth/data-sharing prerequisites before any live call.

## Validation Record

| Check | Scope | Status | Evidence or reason |
| --- | --- | --- | --- |
| VS Code and repository packaging evidence | P01-T01 | Passed | Official `contributes.chatAgents` contribution point and root `.github` plugin-index behavior verified. |
| Demo extension clean install | P01-T01 | Passed | `npm.cmd ci` in the extension root completed successfully. |
| Extension entry-point syntax and manifest tests | P01-T01 | Passed | `npm.cmd run check`; `npm.cmd test`: 2/2 tests passed. |
| Root Markdown lint | P01-T01 | Passed | `npm.cmd run lint:md` passed. |
| Root frontmatter validation | P01-T01 | Unavailable | `npm.cmd run lint:frontmatter` could not start because `pwsh` is not on PATH. |
| Pizza build and behavior tests | P01-T02 | Passed | `dotnet test PizzaEligibility.sln --verbosity minimal`: 4/4 tests passed. |
| Original pizza replay | P01-T02 | Passed | Four CLI inputs produced the baseline outputs recorded above. |
| Bounded workspace discovery and evidence reads | P02-T01, complete | Passed | `npm.cmd run check`; `npm.cmd test`: 13/13 tests passed, including unopened-root, traversal, canonical path, provider URI filtering, symlink-escape, and bounded line-range evidence cases. |
| Roslyn syntax and MSBuild worker build | P02-T02, complete | Passed | Worker built for `net10.0`; syntax-only parsing returned the expected method candidate; direct controlled pizza-project load returned one target candidate and its in-root caller. |
| Roslyn root-bound preflight | P02-T02, complete | Passed | The actual worker rejected an external `ProjectReference` before creating `MSBuildWorkspace`; extension tests cover consent and returned-location filtering. |
| Node-launched controlled discovery integration | P02-T02, complete | Passed | `discoverTarget` invoked the real worker against the controlled pizza fixture and returned `CalculateDiscountAmount` plus its `Program.cs` caller. VS Code APIs were mocked; host UI remains a manual smoke check. |
| Proposal contract validation and report rendering | P02-T03, in progress | Passed | Focused `proposal-contract.test.js` passed 6/6, including citation bounds, target binding, source anchoring, path rejection, and Markdown escaping. |
| Plan diagnostics | Plan artifact | Passed | No errors reported after P01 markers were checked. |

## Pre-Review Reconciliation

* Plan markers and task-local context: current; P01, P01-T01, P01-T02, P02-T01, and P02-T02 are checked; P02-T03 through P04-T02 remain.
* Completed-work entries and handoff prose: current; P01 scaffold/baseline, P02-T01 bounded discovery, and P02-T02 Roslyn analysis have entries.
* Validation, blockers, remaining work, and follow-up items: current; root frontmatter check is unavailable, VS Code host UI smoke remains, and live Foundry remains gated.
* Review readiness: not ready; discovery/report/apply, Node slice, and end-to-end smoke remain.

## Blockers

* The VS Code development-host modal/agent interaction has not been manually smoke-tested. Arbitrary projects remain behind extension confirmation and root preflight. Live Foundry invocation separately requires endpoint/model configuration and explicit permission to send non-demo source.

## Remaining Work

* P02-T03 through P04-T02 remain active. Implement the structured evidence report and offline/mockable model adapter next; do not invoke live Foundry until endpoint/model configuration and data-sharing permission are confirmed.

## Follow-Up Items

* Canonical plan list: [.copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md](../../plans/2026-10-07/legacy-code-transformation-agent-plan.md), `## Follow-Up Items`.
* None.

## Return-to-Caller State

* Implementation execution status: Partial.
* Declared scope and markers: Full plan; P01, P01-T01, P01-T02, P02-T01, and P02-T02 completed; P02-T03 through P04 remain.
* Validation coverage: Extension tests passed 17/17; worker build passed; syntax-only and out-of-root preflight tests passed; Node-launched controlled-pizza discovery returned the target and in-root caller. Frontmatter validation is unavailable because `pwsh` is not on PATH.
* Blockers: VS Code development-host UI smoke remains; live Foundry separately requires endpoint/auth and source-data permission before using non-demo source.
* Current plan updates: P01-T01 bundles the demo agent; P02-T01 adds bounded evidence reads; P02-T02 completes consent-gated Roslyn analysis; the agent is manually invokable for read-only preview only.
* Planning and critique state: P02-T02 checked complete; P02-T03 is next. The user-authorized early demo update is recorded; no additional critique run.
* Follow-up items: None.
* Review readiness or no-handoff reason: Not ready; P02-P04 remain.
* Continuation owner: Active automatic RPI Agent.
