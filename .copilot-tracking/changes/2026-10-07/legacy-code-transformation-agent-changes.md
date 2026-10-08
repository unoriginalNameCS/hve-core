<!-- markdownlint-disable-file -->

# RPI Changes: Legacy Code Transformation Agent PoC

## Metadata

* Task ID: RPI-LCTA-2026-10-07
* Related plan: [.copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md](../../plans/2026-10-07/legacy-code-transformation-agent-plan.md)
* Implementation date: 2026-10-07
* Last implementation update: 2026-10-08

## Execution Status

* Status: Partial
* Declared invocation scope: full plan
* Completed scope markers: P01, P01-T01, P01-T02, P02, P02-T01, P02-T02, P02-T03, P03, P03-T01, P03-T02, P04-T01
* All remaining active-plan markers: P04, P04-T02
* Latest bounded invocation: P04-T01 and feasible P04-T02 handoff work within parent full-plan scope. Real extension-host smoke explicitly excluded; no subagents or git operations were used.
* Current validation: focused generation/registration/runner checks, real disposable pizza and Node test/replay, full demo syntax/tests, dependency-free Node tests and root Markdown lint. Frontmatter/public-feed owners cannot start without `pwsh`.
* P03 interpretation: read-only preview was implementation staging, not a user restriction. With the gate implemented, the manual agent now exposes only the two read-only tools, owned report generation and ID-only apply. Commands and tools share one memory-only store and independent extension modals.
* Status basis: P01-P03 and the Node automation slice are implemented and validated. README and standalone launch recipes are ready. Full-plan acceptance remains Partial because real host interaction and installed TypeScript-provider readiness are unverified. No live Foundry request or credential access is claimed.

## Execution Summary

P01-P03 and P04-T01 are complete. The manual agent and commands share bounded source-grounded generation, immutable candidates, exact-diff approval and controlled verification. The default mock never reads environment values or calls transport. Pizza replay compares four existing tests and outputs `2.50`, `0.00`, `5.00`, `7.50`; Node compares eight reset-state tests, eight transfer subprocesses and one CLI error case before/after. Generation still reports tests and runs as `not run`; observed verification is a separate Markdown report. Original fixtures remain unchanged by tests. P04-T02 handoff automation is ready, but real host smoke remains unperformed.

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

### P02-T03: Independent source-grounded proposal reports

* Status: Complete for the delegated P02-T03 scope; completion entry recorded before checking the plan marker.
* Added files:
	* [demos/legacy-code-transformation/extension/src/foundry-adapter.js](../../../demos/legacy-code-transformation/extension/src/foundry-adapter.js)
	* [demos/legacy-code-transformation/extension/src/proposal-report.js](../../../demos/legacy-code-transformation/extension/src/proposal-report.js)
	* [demos/legacy-code-transformation/extension/tests/proposal-pipeline.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-pipeline.test.js)
* Modified files:
	* [demos/legacy-code-transformation/extension/src/proposal-contract.js](../../../demos/legacy-code-transformation/extension/src/proposal-contract.js)
	* [demos/legacy-code-transformation/extension/src/workspace-discovery.js](../../../demos/legacy-code-transformation/extension/src/workspace-discovery.js)
	* [demos/legacy-code-transformation/extension/src/extension.js](../../../demos/legacy-code-transformation/extension/src/extension.js)
	* [demos/legacy-code-transformation/extension/package.json](../../../demos/legacy-code-transformation/extension/package.json)
	* [demos/legacy-code-transformation/extension/tests/manifest.test.js](../../../demos/legacy-code-transformation/extension/tests/manifest.test.js)
	* [demos/legacy-code-transformation/extension/tests/proposal-contract.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-contract.test.js)
	* [demos/legacy-code-transformation/extension/tests/workspace-discovery.test.js](../../../demos/legacy-code-transformation/extension/tests/workspace-discovery.test.js)
	* [demos/legacy-code-transformation/README.md](../../../demos/legacy-code-transformation/README.md)
* Behavior: `legacyCodeTransformation.generateProposalReport` picks an opened root, saved selected source file, exact symbol, and explicit mode. It re-runs owned discovery and source-evidence reads; caller-supplied catalogs are ignored. Full symbol ranges are separated from provider name-selection positions, including exact character bounds. Reports preserve provider warnings, Roslyn diagnostics, references/call edges, text matches, source/test/doc excerpts, and unverified model prose separately.
* Mock: The default deterministic simulation never reads environment values or calls transport. It proposes the known pizza expression only for an exact match of the selected controlled method baseline; other/unresolved/ambiguous targets yield an honest no-change report. Baseline inputs/outputs and tests say `not run`; no behavior equivalence or test pass is generated by the model.
* Live adapter: Only explicit live mode reads extension-host `api_key`, `model`, and `endpoint`. A modal displays the destination/model and exact collected context before transport. Native injectable `fetch` uses HTTPS resource-only `/openai/v1/chat/completions`, `api-key`, strict JSON Schema, no redirects, a finite timeout, cancellation, and bounded redacted errors. Refusal/non-JSON/HTTP/transport/invalid-citation failures never become success or mock fallback. No live calls or credential reads were performed during implementation; tests supplied fake environment values and transport.
* Report writer: Only unique Markdown reports are written under default `reports/legacy-code-transformation/`, with an artifact-only in-root directory override. Paths, source/dependency directories, existing realpath ancestors, and symlinks are checked before directory creation/writes. Exclusive writes reject overwrites; cancellation removes new reports and empty created directories. No source writes, generic edit tool, sidecar, root packaging/dependency change, or preview-agent change was made.
* Proposal boundary: Empty/disjoint anchors, multi-file edits, multiple replacements, and originals other than the exact selected span are rejected by the pipeline. Structural validation is not semantic proof of the replacement. Unknowns and provider warnings remain independently visible.
* API handoff: `generateModelProposal` and `validateEndpoint` are adapter exports. `generateProposalReport` returns the validated proposal/target/catalog, report path, `proposalHash`, `targetSpanHash`, and `evidenceHash`; `writeProposalReport` and `DEFAULT_REPORT_DIRECTORY` are report-module exports. The target-span hash uses normalized excerpt text and is not a full-file hash. P03 must acquire full source-file hashes and extension-owned approval itself; no apply permission was created here.
* Validation: Focused contract 7/7, pipeline/adapter/command 15/15, manifest 4/4, exact-span/root-filtered discovery 2/2. `npm.cmd --prefix demos/legacy-code-transformation/extension run check` passed; `npm.cmd --prefix demos/legacy-code-transformation/extension test` passed 41/41 (zero failures/cancelled/skipped). Direct demo-owned Node suite also passed 41/41. Root `npm.cmd run lint:md` passed with exit code 0 after three README formatting repairs. Relevant editor diagnostics are clear.
* Validation capture: Terminal control-character injection and streaming truncation initially hid aggregate results; ignored generated logs capture the confirmed summaries at [logs/lcta-proposal-npm-tests.log](../../../logs/lcta-proposal-npm-tests.log), [logs/lcta-proposal-tests.stdout.log](../../../logs/lcta-proposal-tests.stdout.log), and [logs/lcta-proposal-markdown.log](../../../logs/lcta-proposal-markdown.log). The direct suite stderr log is empty. No dependencies were reinstalled or lockfiles changed.
* Official sources verified on 2026-10-08: [v1 API lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) establishes both resource hostnames; [structured outputs REST documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs) establishes the API-key/header/request/schema/refusal contract. Numeric minimum constraints are omitted only from the documented wire-schema subset; local citation-range validation retains them. The obsolete API-deprecation URL returned 404; the canonical lifecycle page was used instead.
* Manual gaps: Real extension-host selection/modal/cancellation/report-opening smoke and live resource/model compatibility are untested and require separate authorization. Root frontmatter tooling remains unavailable because `pwsh` is not on PATH. Arbitrary projects were not executed; fixture baseline/replay was not rerun or represented as report-time evidence.

## Current Continuation State

### P03-T01: Immutable approval-bound source application

* Status: Complete; the parent confirmed the package-wide suite passed 65/65 after the delegated implementation.
* Added [demos/legacy-code-transformation/extension/src/proposal-apply.js](../../../demos/legacy-code-transformation/extension/src/proposal-apply.js) and [demos/legacy-code-transformation/extension/tests/proposal-apply.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-apply.test.js). Modified the existing proposal pipeline, entry point, manifest and manifest/pipeline tests; P02 parent edits are preserved.
* Generation captures complete saved UTF-8 source bytes/hash and document version before discovery, binds original report bytes/hash, and rejects concurrent generation changes. Deep-frozen memory-only candidates use extension-issued IDs; model/caller patches and approval booleans cannot authorize writes. No-change candidates are excluded. No sidecar is created.
* Mandatory extension-owned confirmation presents exact affected file, original/replacement/diff, ID, proposal and full-file hashes. Source/report/root/path/version/dirty-buffer checks run before and after the modal and after disposable verification; final source checks precede the exact byte-preserving write. Stale candidates remain visible; no rollback overwrites concurrent user changes.
* The review command and ID-only model tool share the gate. Tool registration requires the extension modal API. The implementation conservatively retains the preview agent's two read-only tools; command-based generation/review/apply is the current P03 workflow, not a complete chat-agent workflow or a user-requested restriction.
* Focused validation: 27/27 tests passed, including BOM/CRLF preservation, immutable caller snapshot, cancellation/wrong ID, source edits outside the target, source/report/dirty/version modal races, closed roots, symlink escape, harness/replacement rejection, stale proposal hashes, report tamper before registration, duplicate-string exact offsets, replay failure and cancellation. The suite also ran real controlled pizza tests 4/4 before and after and four matching outputs without changing bundled source. Evidence: [logs/lcta-p03-focused.log](../../../logs/lcta-p03-focused.log).
* Windows findings: short-name temp aliases require target realpath resolution while retaining ancestor symlink checks. Restricted child environments need `APPDATA`/`LOCALAPPDATA` for NuGet; no API/auth values were read. Terminal wrapper/PATH resolution was intermittent; the verified installed Node executable and generated output logs produced complete summaries.
* P03 interpretation, affected P03-T01/P03-T02: retain the preview allowlist during implementation; verify disposable pinned copies before approved source writes; disable arbitrary-project application. These are implementation choices under the controlled-fixture plan, not additional user requirements. Historical critique-3 remains Pass; no new critique was run.

### P03-T02: Disposable pizza verification before application

* Status: Complete; parent validation passed 65/65 extension tests, including real .NET baseline and transformed runs against disposable copies.
* Files: [demos/legacy-code-transformation/extension/src/fixture-replay.js](../../../demos/legacy-code-transformation/extension/src/fixture-replay.js), [demos/legacy-code-transformation/extension/src/proposal-apply.js](../../../demos/legacy-code-transformation/extension/src/proposal-apply.js), and [demos/legacy-code-transformation/extension/tests/proposal-apply.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-apply.test.js).
* Behavior: Checks fingerprinted fixture source/harness, runs four existing tests before and after the exact replacement, and compares the four representative outputs, errors, exit codes, and visible working-directory side effects. Failure/cancellation leaves original source unchanged; extension-owned verification reports contain actual process observations and limits.
* Validation: `npm.cmd --prefix demos/legacy-code-transformation/extension test` captured in `logs/lcta-parent-tests.log`: 65 passed, zero failed/cancelled/skipped. Real bundled fixture source remains unchanged; tests apply only to disposable copies.

* Active parent scope: full plan. Delegated P02-T03 implementation is complete; the parent owns inspection, continuation, and later review.
* Current user direction: mocks now; future lowercase environment API-key calls only after explicit live selection and exact-context sharing consent. Retaining the preview was implementation staging; the owned proposal/apply tools are now enabled in the manual agent after the gate exists.
* Next dependency-ready task: remaining P04-T02 native development-host smoke on disposable copies, only after separate authorization. No runtime version gap: installed Node is `v24.19.0`.
* Current offline blockers: none for executable demo checks. Real host smoke is deliberately not authorized; live source-sharing/resource compatibility is a separate optional prerequisite, not a completion claim.

### P04-T01: Controlled Node banking fixture and replay

* Status: Complete for the automated fixture/provider contract slice; recorded before checking the task marker. Native installed-provider interaction is retained under P04-T02 smoke, not certified here.
* Added files: [demos/legacy-code-transformation/fixtures/node/package.json](../../../demos/legacy-code-transformation/fixtures/node/package.json), [demos/legacy-code-transformation/fixtures/node/jsconfig.json](../../../demos/legacy-code-transformation/fixtures/node/jsconfig.json), [demos/legacy-code-transformation/fixtures/node/src/transfer.js](../../../demos/legacy-code-transformation/fixtures/node/src/transfer.js), [demos/legacy-code-transformation/fixtures/node/src/cases.js](../../../demos/legacy-code-transformation/fixtures/node/src/cases.js), [demos/legacy-code-transformation/fixtures/node/src/runner.js](../../../demos/legacy-code-transformation/fixtures/node/src/runner.js), [demos/legacy-code-transformation/fixtures/node/tests/transfer.test.js](../../../demos/legacy-code-transformation/fixtures/node/tests/transfer.test.js), and [demos/legacy-code-transformation/extension/src/node-fixture.js](../../../demos/legacy-code-transformation/extension/src/node-fixture.js).
* Modified runtime/tests: [demos/legacy-code-transformation/extension/src/fixture-replay.js](../../../demos/legacy-code-transformation/extension/src/fixture-replay.js), [demos/legacy-code-transformation/extension/src/foundry-adapter.js](../../../demos/legacy-code-transformation/extension/src/foundry-adapter.js), [demos/legacy-code-transformation/extension/src/proposal-apply.js](../../../demos/legacy-code-transformation/extension/src/proposal-apply.js), [demos/legacy-code-transformation/extension/tests/proposal-apply.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-apply.test.js), and [demos/legacy-code-transformation/extension/tests/proposal-pipeline.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-pipeline.test.js).
* Behavior: Correct deliberately nested transfer requires distinct existing accounts, finite positive amount and sufficient funds. Eight cases cover success, each rejection and both missing; source-missing precedence is deterministic. Every test/process resets account state. Success yields balances 75/75; rejected transfers retain 100/50. The fixed CLI error has JSON stderr and exit 2.
* Verification: The generic selector chooses separately pinned six-file pizza/Node definitions; unknown source/harness/replacement is rejected before execution. Node runs real builtin tests with JSON summaries and nine fixed subprocesses before/after the exact guard-clause replacement on disposable copies. Native spawn has no shell, restricted environment (including the Windows cancellation helper), finite timeout, cancellation and bounded output. Actual Node `v24.19.0` matches the planned runtime; installed TypeScript service version is not inferred from it.
* Safety: Existing source/report/version/modals and byte-preserving write checks remain shared. Unsupported model replacements cannot execute. Both fixture baselines remain unchanged; selected source changes only after explicit extension approval and successful verification. Repeat application requires a fresh pristine fixture copy; changed fingerprints/no-change mock and consumed IDs prevent automatic second transformations. Disposable copies are not OS sandboxes or formal equivalence proofs.
* API handoff: `node-fixture.js` exports `NODE_TARGET_PATH`, `NODE_BASELINE`, `NODE_REPLACEMENT`, `NODE_HASHES`, `NODE_CASES`. `fixture-replay.js` now exports `runNode`, `verifyNodeProposal`, `verifyControlledProposal` alongside preserved pizza exports; `readControlledFixture` and `assertFixtureHashes` select the appropriate definition. The candidate store defaults to `verifyControlledProposal`.
* Validation: Dependency-free Node `npm.cmd test`: 8/8. Full extension suite: 70/70, including real pizza tests 4/4 before/after, real Node tests 8/8 before/after, reset-state output/error/balance/visible-file comparison, tampered harness/replacement rejection and unchanged bundled source. Mock provider tests cover the exact span, references/incoming-call evidence, unavailable providers and post-apply no-change behavior; native host readiness remains unknown.
* Implementation findings: Programmatic `node:test.run` launched from `-e` recursively inherits the parent entry point with default isolation; the controlled fixed test subprocess uses `isolation: 'none'` and validates its aggregate JSON counts. Test span was corrected from a hard-coded end line to the trusted baseline length. Neither repair weakened verification.

### P04-T02: Agent and reviewer handoff automation

* Status: Partial; all feasible non-interactive handoff work implemented. P04-T02/P04 remain unchecked because the required real extension-host smoke was explicitly excluded.
* Modified files: [demos/legacy-code-transformation/extension/src/extension.js](../../../demos/legacy-code-transformation/extension/src/extension.js), [demos/legacy-code-transformation/extension/package.json](../../../demos/legacy-code-transformation/extension/package.json), [demos/legacy-code-transformation/extension/agents/legacy-code-transformation.agent.md](../../../demos/legacy-code-transformation/extension/agents/legacy-code-transformation.agent.md), [demos/legacy-code-transformation/extension/tests/manifest.test.js](../../../demos/legacy-code-transformation/extension/tests/manifest.test.js), and [demos/legacy-code-transformation/README.md](../../../demos/legacy-code-transformation/README.md). Added [demos/legacy-code-transformation/extension/.vscode/launch.json](../../../demos/legacy-code-transformation/extension/.vscode/launch.json); pipeline tests above also cover generation/application.
* Behavior: `GenerateProposalReportTool` recollects source via owned routines, confirms safe report writing, defaults mock and shares the commands' `ProposalCandidateStore`. Returns only status/mode/ID/path/hash metadata, never caller patches, evidence/source snapshots or model prose. Strict tool input rejects extra properties. Live mode still requires separate exact-context sharing confirmation; mock tests deliberately fail if environment/transport is touched.
* Agent: `user-invocable: true`, `disable-model-invocation: true`, `agents: []` preserved. User-requested exact tool configuration includes discovery/evidence plus registered report and ID-only apply tools. Instructions treat repository/report/model content as untrusted, require report/exact-diff inspection and user apply request, and retain independent extension approval on every apply. Failure/refusal/staleness/unavailable evidence is never success. No generic write/execution tool was exposed.
* Reviewer setup: README covers both targets, report paths, commands/chat, source binding, replay ownership, one-apply limits, provider/dynamic-reference uncertainty and optional future `api_key`/`model`/`endpoint` v1 configuration. Launch recipes prompt for disposable fixture-copy roots; no host was launched. No new npm dependencies, registry access, root packaging/membership/generated docs, servers/browsers/provisioning or live credential reads were introduced.
* API handoff: `extension.js` additionally exports `GENERATE_REPORT_TOOL`, `GenerateProposalReportTool`, `registerProposalReportTool`; registration uses the same store passed to `registerProposalReportCommand` and `registerProposalApply`. Production artifacts contain no internal tracking references.
* Validation: Focused manifest/pipeline 23/23 before launch-test addition; final manifest 7/7; full extension 70/70; Node 8/8; syntax check and root Markdown lint pass (524 files, zero issues). Runner focused test passes both native runner contracts. Full summaries are captured under [logs/lcta-p04-tests.log](../../../logs/lcta-p04-tests.log), [logs/lcta-p04-check.log](../../../logs/lcta-p04-check.log), [logs/lcta-p04-node-tests.log](../../../logs/lcta-p04-node-tests.log), [logs/lcta-p04-markdown.log](../../../logs/lcta-p04-markdown.log), and [logs/lcta-p04-runner.log](../../../logs/lcta-p04-runner.log).
* Authoring review: Improve mode within the existing standalone agent boundary; baseline manual activation and no delegation preserved, staging restrictions replaced only as requested. Self-review against the HVE Builder catalog/rubric finds no unresolved instruction-quality correction: outcome/stop rules precede flow, review and native approval are explicit, untrusted output and missing-evidence handling are bounded, and response claims distinguish simulation from process observations. Source review verdict: Pass for this automation artifact. Mechanical result: Deferred overall because `pwsh`-owned frontmatter validation cannot run; no native host acceptance is implied. Tool configuration is the user's requested exact set, not an inferred HVE recommendation.
* Tooling gaps: `npm.cmd run lint:frontmatter` and `npm.cmd run lint:public-dependency-feeds` could not start because `pwsh` is absent; captured in [logs/lcta-p04-frontmatter.log](../../../logs/lcta-p04-frontmatter.log) and [logs/lcta-p04-feeds.log](../../../logs/lcta-p04-feeds.log). No installation attempted. Node fixture has no dependencies and is not an npm install root; existing extension/root lockfiles are unchanged.
* Packaging exemption: Standalone demo artifacts are outside root `.github` distribution discovery, so root `plugin:sync`, `extension:prepare` and `docs:generate` are not applicable and were not run. No new production telemetry emitter/exporter was added; local fixture process observations are test evidence, not production telemetry.

### Plan Update: Complete staging and reconcile current handoff

* Affected markers: P01-T01, P02-T02/P02-T03, P03-T01, P04-T01/P04-T02 and current summary/readiness sections.
* What/why: Replace obsolete preview-only active prose with the now-gated manual agent workflow, add concrete Node/generation exports, reconcile P01-P03 completion and make native smoke the only remaining implementation task.
* User direction: Continue the full work with mocks now and future environment-configured Foundry support. The gated agent tools implement the existing plan. Repository action boundaries require separate authorization before native host smoke; the user did not request a permanent preview restriction.
* Evidence/state: Automated suite 70/70 and runtime `v24.19.0`; P04-T02 remains Partial. Historical critique-3 is retained as Pass, not rerun or treated as native runtime certification. Parent retains final acceptance and separately authorized smoke ownership.

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
| Proposal report pipeline, adapter and command | P02-T03, complete | Passed | Demo `npm.cmd run check`; `npm.cmd test` passed 41/41, including fake transport, exact-span/citation rejection, safe writes, cancellation, and unchanged preview allowlist. No live request. |
| Documentation update | P02-T03 | Passed | Root `npm.cmd run lint:md` passed with exit code 0 after focused formatting repairs. |
| Plan diagnostics | Plan artifact | Passed | No errors reported after P01 markers were checked. |
| Final extension syntax and full tests | P04 automation | Passed | `npm.cmd run check`; `npm.cmd test`: 70/70 in `logs/lcta-p04-tests.log`, including real controlled .NET and Node replay. |
| Node banking behavior and target runtime | P04-T01 | Passed | Node `v24.19.0`; dependency-free fixture suite 8/8; original bundled source unchanged by tests. |
| Final root Markdown lint | P04-T02 handoff | Passed | 524 files, zero issues in `logs/lcta-p04-markdown.log`. |
| Frontmatter and public-feed owners | P04 artifacts/manifests | Unavailable | Both require absent `pwsh`; no tool installation authorized or attempted. |
| Native extension host and TypeScript provider | P04-T02 | Not run | Explicit stop before interactive smoke; requires separate permission and disposable fixture copies. |

## Pre-Review Reconciliation

* Plan markers/task context: P01-P03 and P04-T01 complete; P04/P04-T02 remain unchecked pending real host smoke.
* Completed-work/handoff prose: current through P04 automation, including Node and generation-tool exports, exact approval sequence and packaging exemption.
* Validation/blockers: extension 70/70, Node 8/8, syntax and Markdown lint pass. Frontmatter/public-feed owners unavailable without `pwsh`; real host/provider smoke and optional live compatibility remain unverified.
* Review readiness: automation slice is ready for parent review; full-plan acceptance is not ready because required native host smoke has not run. Instruction-quality self-review is not human acceptance.

## Blockers

* P04-T02 real VS Code development-host modal/agent/provider interaction requires separate permission and disposable copies; none was launched. Installed TypeScript provider version/readiness remains unverified.
* Root frontmatter/public-feed validation requires unavailable `pwsh`. Record the unavailable gate; do not install tools implicitly.
* Live Foundry compatibility separately requires supported endpoint/model configuration and exact source-sharing consent; optional live verification is not part of current offline acceptance.

## Remaining Work

* Only P04/P04-T02 remain active: separately authorized native smoke of discovery, report/read/review, cancel/apply and observed verification for both fixture copies. Automated checks are complete; no Node runtime mismatch exists. Do not invoke live Foundry or set up services/credentials implicitly.

## Follow-Up Items

* Canonical plan list: [.copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md](../../plans/2026-10-07/legacy-code-transformation-agent-plan.md), `## Follow-Up Items`.
* None.

## Return-to-Caller State

* Implementation execution status: Partial.
* Declared scope and markers: Parent full plan; P04 automation invocation complete. P01-P03 and P04-T01 complete; P04/P04-T02 remain unchecked.
* Validation coverage: Final demo syntax and 70/70 extension tests, 8/8 Node fixture tests, and root Markdown lint pass. Real pinned pizza and Node before/after replay passed; native provider interaction is mocked, not certified. Frontmatter/public-feed owners unavailable without `pwsh`.
* Blockers: Native development-host smoke is a separate, not-yet-authorized interactive action; there is also a tooling gap for `pwsh`. Optional live calls require configuration and source-sharing consent and were not attempted.
* Current plan updates: Manual agent now uses the exact requested four registered tools, shared candidates and independent approval. Both known controlled replacements supported once per pristine copy; Node runtime matches `24.19.0`. No root packaging commands were run.
* Planning/critique state: Historical critique-3 remains Pass; no new critique or subagent launched. Next implementation action is separately authorized P04-T02 host smoke after automated gates, not P02/P03 reimplementation.
* Follow-up items: None.
* Review readiness/no-handoff reason: Automation slice ready for parent inspection; full-plan acceptance remains Partial because real-host smoke is unverified. Human acceptance is not marked complete.
* Continuation owner: Active automatic RPI Agent.

## Parent Final Validation

* `npm.cmd --prefix demos/legacy-code-transformation/extension test`: 70/70 passed, zero failed/cancelled/skipped; complete capture in `logs/lcta-final-extension-tests.log`.
* `npm.cmd --prefix demos/legacy-code-transformation/extension run check`: passed for all runtime modules.
* `npm.cmd --prefix demos/legacy-code-transformation/fixtures/node test`: 8/8 passed independently of extension replay.
* Editor diagnostics: no reported errors in the demo or current plan. Root Markdown lint passed in the delegated validation; unavailable PowerShell-owned gates remain explicitly recorded.
* No commits, pushes, branch changes, live Foundry calls, or interactive host launches were performed. P04-T02 remains unchecked pending the native-host acceptance action.
