<!-- markdownlint-disable-file -->

# RPI Plan: Legacy Code Transformation Agent PoC

## Task Metadata

* Task ID: RPI-LCTA-2026-10-07
* Task slug: legacy-code-transformation-agent
* Plan date: 2026-10-07
* Decision participation: agent-owned, automatic RPI Agent context

## Executive Summary

The plan will build a contained VS Code proof of concept that analyzes a selected legacy function or class, produces a source-grounded proposal, waits for approval of the exact change, and then compares tests and representative runs before and after. The first slice is the .NET 10 pizza eligibility sample; Node.js 24.19 banking transfer follows. Java remains deferred.

* Bottom line: P01-P04 implementation and user-authorized native smoke are complete. Repository mechanical acceptance remains deferred because PowerShell-owned checks cannot run without `pwsh`.
* Why this matters: an inheriting developer needs evidence-backed context and a behavior-checked proposal before modifying difficult code.
* Planning result: Both fixtures use owned evidence, exact-target validation, mock-default reports, immutable memory-only candidates, mandatory exact-diff approval and real disposable verification before source writes. Both native workflows passed; Node cancellation passed and a separate pizza cancellation attempt was skipped, not claimed as performed.
* Confidence and uncertainty: 73/73 extension tests, worker compile and both native apply/replay paths pass. Installed Node `v24.19.0` matches the target. Frontmatter/public-feed checks remain unavailable; complete editor-provider compatibility, installed TypeScript service version and optional live resource compatibility are not certified. No live call or credential access was authorized.

### What You May Not Know

* The existing HVE Core extension is declarative packaging, not an executable runtime. The PoC should live in a separate demo area and must not silently change the HVE Core extension packaging pipeline.
* The selected project root must be an opened VS Code workspace folder for language-provider/project loading. The analysis tool must reject or stop on external project references instead of reading beyond the selected root.
* Roslyn 5.9.0 executes design-time `Compile`/`CoreCompile` targets in a separate BuildHost process. This is not a sandbox. C# provider and MSBuild calls now require extension-owned confirmation; declining runs syntax-only parsing and bounded text search, with semantic references unresolved.
* A real Foundry invocation requires a configured endpoint/model, endpoint-appropriate authentication, and confirmation that sending the supplied source context is allowed. The plan can implement the adapter and mocked contract tests without accessing credentials or making a live request.
* VS Code references and representative test runs do not prove a complete dynamic call graph or equivalence for every possible input.

## Phase Checklist

### Before

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Arial, Helvetica, sans-serif", "fontSize": "16px"}}}%%
flowchart LR
	vscode["VS Code host"]
	hve["HVE Core declarative extension package"]
	agent["Workspace custom-agent pattern"]
	runtime["Legacy-code tool runtime: absent"]
	fixtures["PoC fixtures: absent"]
	vscode --> hve --> agent
```

### After

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Arial, Helvetica, sans-serif", "fontSize": "16px"}}}%%
flowchart LR
	vscode["VS Code host"] --> agent["Added: Legacy transform .agent.md"]
	agent --> tools["Added: Extension-contributed tool provider"]
	tools -->|bounded read| root["Opened, selected project root"]
	tools --> roslyn["Added: Roslyn .NET worker"]
	roslyn --> root
	tools -->|provider commands| ts["TypeScript references and call hierarchy"]
	ts --> root
	tools -->|configured and authorized| foundry["Foundry inference API"]
	foundry --> tools
	tools --> report["Added: Evidence and exact-change proposal"]
	report --> approval["Added: Requester approval gate"]
	approval --> apply["Added: Proposal-bound apply tool"]
	apply --> runner["Added: Controlled sample replay"]
	root --> fixtures["Added: Pizza and banking fixtures"]
	runner --> tests["Added: Existing tests and replay comparison"]
	fixtures --> tests
	classDef new stroke-dasharray: 5 5
	class agent,tools,roslyn,report,approval,apply,runner,fixtures,tests new
```

Before this implementation, the repository had agent customization and a declarative extension package, but no transformation runtime or sample fixtures. The implemented automation adds a separate PoC workspace, keeps discovery read-only, and makes approval and behavior replay explicit stages. Native-host acceptance remains pending.

<!-- rpi:phase id=P01 -->
### [x] P01: Establish the .NET baseline

Goals:
* Create a self-contained PoC workspace and behavior-correct pizza fixture so later analysis and replay have a stable baseline.

Dependencies:
* None.

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Arial, Helvetica, sans-serif", "fontSize": "16px"}}}%%
flowchart LR
	vscode["VS Code host"] --> agent["Added: Legacy transform .agent.md"]
	agent --> tools["Added: Extension-contributed tool provider"]
	tools -->|bounded read| root["Opened, selected project root"]
	tools --> roslyn["Added: Roslyn .NET worker"]
	roslyn --> root
	tools -->|provider commands| ts["TypeScript references and call hierarchy"]
	ts --> root
	tools -->|configured and authorized| foundry["Foundry inference API"]
	foundry --> tools
	tools --> report["Added: Evidence and exact-change proposal"]
	report --> approval["Added: Requester approval gate"]
	approval --> apply["Added: Proposal-bound apply tool"]
	apply --> runner["Added: Controlled sample replay"]
	root --> fixtures["Added: Pizza and banking fixtures"]
	runner --> tests["Added: Existing tests and replay comparison"]
	fixtures --> tests
	classDef new stroke-dasharray: 5 5
	class agent,tools,roslyn,report,approval,apply,runner,fixtures,tests new
	class agent,tools,root,fixtures,tests phase
```

Highlighted work: create the separate demo workspace and the pizza fixture/test baseline.

<!-- rpi:task id=P01-T01 -->
#### [x] P01-T01: Create the standalone PoC workspace

Goals:
* Provide a runnable VS Code extension scaffold with a bundled custom-agent definition so later phases can add tools without changing HVE Core's declarative extension package.

Requirements:
* FR-001, NFR-001, NFR-002.
* Keep the runtime under `demos/legacy-code-transformation/extension/`; do not add artifacts to HVE Core's root `.github`, root `plugin.json`, or `extension/` packaging.
* Bundle the `.agent.md` through the extension's `contributes.chatAgents` path.
* Open each selected fixture project folder as the VS Code workspace root; load the extension separately in the extension-development host.
* Keep the agent manually invokable with automatic model invocation and nested delegation disabled. Initial read-only preview was implementation staging; P04-T02 now connects only the registered owned report and ID-only apply tools after the P03 gate exists.

Details:
* Bundle the custom agent at `demos/legacy-code-transformation/extension/agents/legacy-code-transformation.agent.md`. Discovery remains read-only; proposal/application use the separate owned tools, mandatory report/exact-diff review and extension confirmation. Native agent interaction still requires P04-T02 smoke.
* Keep the demo self-contained. Do not alter the HVE Core release, plugin synchronization, extension packaging, or documentation-generation pipelines.

References:
* [extension/PACKAGING.md](../../../extension/PACKAGING.md): confirms the current extension folder is declarative packaging.
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): W8-W10, W16, C1-C3, and C5 establish the agent/tool/runtime and plugin-root boundaries.
* [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points): `contributes.chatAgents` bundles an `.agent.md` from inside an extension.
* [scripts/plugins/Sync-PluginManifest.ps1](../../../scripts/plugins/Sync-PluginManifest.ps1): plugin membership starts from tracked files under root `.github`.

Dependencies:
* None.

<!-- rpi:task id=P01-T02 -->
#### [x] P01-T02: Establish pizza behavior baselines

Goals:
* Make the .NET pizza eligibility behavior reproducible before any analysis or transformation is attempted.

Requirements:
* FR-006, NFR-004.
* Target .NET 10 and preserve the confirmed rules: members receive 10% off; non-members receive 10% off at subtotal greater than or equal to $50; otherwise no discount.
* Include a member case below the threshold, a non-member case at $49.99, a non-member case at exactly $50.00, and an above-threshold case with deterministic expected outputs.

Details:
* Use an intentionally difficult but correct fixture, and keep its test harness separate from the future Roslyn/tool implementation.
* Capture baseline outputs and the existing test command/result without invoking arbitrary user projects.

References:
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): confirmed pizza behavior and first-slice priority.
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): Q6 and W15 constrain repeatability and execution trust.

Dependencies:
* P01-T01.

<!-- rpi:phase id=P02 -->
### [x] P02: Build bounded discovery and proposal reporting

Goals:
* Produce a read-only, source-grounded proposal for the selected .NET function while enforcing the supplied project-root boundary.

Dependencies:
* P01.

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Arial, Helvetica, sans-serif", "fontSize": "16px"}}}%%
flowchart LR
	vscode["VS Code host"] --> agent["Added: Legacy transform .agent.md"]
	agent --> tools["Added: Extension-contributed tool provider"]
	tools -->|bounded read| root["Opened, selected project root"]
	tools --> roslyn["Added: Roslyn .NET worker"]
	roslyn --> root
	tools -->|provider commands| ts["TypeScript references and call hierarchy"]
	ts --> root
	tools -->|configured and authorized| foundry["Foundry inference API"]
	foundry --> tools
	tools --> report["Added: Evidence and exact-change proposal"]
	report --> approval["Added: Requester approval gate"]
	approval --> apply["Added: Proposal-bound apply tool"]
	apply --> runner["Added: Controlled sample replay"]
	root --> fixtures["Added: Pizza and banking fixtures"]
	runner --> tests["Added: Existing tests and replay comparison"]
	fixtures --> tests
	classDef new stroke-dasharray: 5 5
	class agent,tools,roslyn,report,approval,apply,runner,fixtures,tests new
	class tools,root,roslyn,foundry,report phase
```

Highlighted work: implement the read-only tool path, Roslyn analysis, Foundry adapter, and evidence report.

<!-- rpi:task id=P02-T01 -->
#### [x] P02-T01: Enforce project-root intake and bounded discovery

Goals:
* Restrict every file search and location returned to the selected, opened workspace folder and identify unsupported scope without reading outside it.

Requirements:
* FR-001, FR-002, NFR-001.
* Require a target path under the selected workspace root; canonicalize paths and validate every discovered URI against that root.
* Exclude dependencies/generated output by default while reporting the search boundary and exclusions.
* Fail closed or report an unresolved external project reference without reading outside the selected root.
* Provide a read-only `read_source_evidence` tool that accepts only normalized project-relative paths and line ranges, then revalidates the canonical URI before reading.

Details:
* Use VS Code workspace APIs for file discovery and language-provider commands. Keep bounded text search complementary to semantic results.
* Return target source spans and line-numbered text matches from discovery. Use `read_source_evidence` to retrieve focused test, README, and documentation excerpts after their paths/lines are known; do not return whole project files by default.
* Report language provider unavailable, project still loading, or no result as an evidence limitation, not proof of no callers.
* Record dynamic dispatch, reflection, delegates, generated code, and textual matches as unknown or unverified where applicable.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): Q1, Q3-Q4; Findings on provider limits and root validation; W1, W9, W13-W14.
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): project-folder-only discovery boundary.

Dependencies:
* P01-T01.

<!-- rpi:task id=P02-T02 -->
#### [x] P02-T02: Analyze .NET symbols with Roslyn

Goals:
* Resolve the selected C# target symbol in the loaded .NET 10 project and return source references with exact file and location evidence.

Requirements:
* FR-002, NFR-001.
* Use Roslyn MSBuild Workspaces and C# workspace support compatible with .NET 10.
* Restrict reported reference locations to the selected root and distinguish direct references from caller edges that could not be resolved.
* Surface solution-load diagnostics and unsupported project cases instead of silently claiming completeness.

Details:
* Implement an extension-owned confirmation before invoking `MSBuildWorkspace` or C# language-provider commands that may load an arbitrary project. State that project evaluation and design-time `Compile`/`CoreCompile` targets may invoke custom tasks; do not imply that the separate BuildHost is a sandbox.
* If confirmation is declined, do not invoke MSBuild Workspace or C# project-loading provider commands. Use syntax-only Roslyn parsing, bounded text search, and any editor-provider results already available; mark project-semantic references unresolved and do not present the fallback as equivalent.
* Discovery returns evidence and unknowns without editing or claiming validation. The initial two-tool preview was staging; generation and controlled application now belong to separate registered tools with independent gates, enabled during P04 handoff.
* Before `MSBuildWorkspace` opens the selected project, preflight explicit project references, source includes, imports, and task-assembly paths. Reject paths that escape the selected root or cannot be proven static; report the reason and return syntax-only evidence instead.
* Use the current Roslyn package evidence from research as the starting point. The 5.9.0 source confirms `OpenSolutionAsync` and the design-time build path; test loading only against the controlled pizza fixture during the PoC.
* Do not describe `FindReferencesAsync` results as a complete dynamic call graph. Pair them with the bounded text/context search in P02-T01.

Validation:
* Build the extension-owned worker for `net10.0`.
* Test syntax-only fallback and root-preflight rejection.
* Run discovery through the Node launcher on the controlled pizza fixture and verify the target method and in-root reference.
* Keep the VS Code development-host interaction as a manual smoke check; do not claim arbitrary project compatibility.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): Q2, Q8; Roslyn findings; W4-W5, W12, W17-W22; Cycle 2 consent/fallback decision.

Dependencies:
* P02-T01.

<!-- rpi:task id=P02-T03 -->
#### [x] P02-T03: Generate a structured proposal report

Goals:
* Produce a reviewable Markdown report that separates source evidence, observed behavior, explanation, and exact proposed changes.

Requirements:
* FR-002, FR-003, FR-004.
* Include cited callers/references, tests, surrounding source, README/docs, original-run inputs/outputs or an explicit `not run` status, affected files, exact proposed edits, helper-extraction limits, and unresolved unknowns.
* Store the report under `reports/legacy-code-transformation/` inside the selected root; do not edit source while producing the report.
* Validate the model response against a structured schema before rendering or making it available for approval.
* Validate every model-provided evidence path/range against tool-collected evidence and every proposed change path against the selected root; reject invented citations or out-of-root changes.
* Keep live Foundry invocation disabled until endpoint/model configuration and permission to send the supplied source context are confirmed.
* Default to mocked responses. Read future Foundry configuration from extension-host environment variables `api_key`, `model`, and `endpoint`; require explicit live-mode selection and extension-owned source-sharing confirmation before a request. Never persist or log the API key.
* Keep discovery read-only. The initial preview-only boundary was implementation staging, not a final command-only restriction. After P03, P04-T02 enables owned report generation and ID-only apply with review and extension consent.
* Expose proposal reporting through the independent `Legacy Code Transformation: Generate Proposal Report` command and the same owned generation pipeline used by the P04 report tool. No generic edit tool is exposed.

The model proposal shape is a contract; the tool validates it before it may become an approval candidate:

```json
{
	"type": "object",
	"additionalProperties": false,
	"required": ["summary", "target", "evidence", "changes", "unknowns"],
	"properties": {
		"summary": { "type": "string" },
		"target": {
			"type": "object",
			"additionalProperties": false,
			"required": ["path", "symbol"],
			"properties": {
				"path": { "type": "string" },
				"symbol": { "type": "string" }
			}
		},
		"evidence": {
			"type": "array",
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": ["id", "path", "startLine", "endLine", "claim"],
				"properties": {
					"id": { "type": "string" },
					"path": { "type": "string" },
					"startLine": { "type": "integer", "minimum": 1 },
					"endLine": { "type": "integer", "minimum": 1 },
					"claim": { "type": "string" }
				}
			}
		},
		"changes": {
			"type": "array",
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": ["path", "originalText", "replacementText", "rationale"],
				"properties": {
					"path": { "type": "string" },
					"originalText": { "type": "string" },
					"replacementText": { "type": "string" },
					"rationale": { "type": "string" }
				}
			}
		},
		"unknowns": { "type": "array", "items": { "type": "string" } }
	}
}
```

Details:
* Use only documented Azure OpenAI/Foundry resource OpenAI v1 chat completions behind an isolated adapter, with API-key auth. Keep request construction and credentials out of the agent Markdown file; reject project endpoints, arbitrary hosts, user information, ports, queries, and fragments.
* Use a test double for local tests. The API/auth implementation must follow the selected endpoint family's current documentation; do not guess the Entra token audience.
* Populate observed behavior and test results only from a controlled runner/test process. Until that process is explicitly run, report `not run`, never model-generated baseline outputs or test passes. The report command does not execute arbitrary projects.
* Retrieve relevant test/documentation excerpts through `read_source_evidence`; validate each citation path and line range against tool-collected evidence before rendering.
* The report path is a planning choice intended to keep generated evidence separate from source files; expose it as a configurable override if it conflicts with an existing project convention.
* Validate existing realpath ancestors before creating nonexistent output parents or writing. Reject source/dependency/hidden directories and symlink ancestors; use exclusive Markdown-only writes with cancellation cleanup, no source writes or sidecar artifacts.
* Require a unique exact target span for an edit proposal. Unresolved/ambiguous targets produce no-change reports, preserving discovery warnings independently of model prose. The mock proposes only the exact known pizza or Node banking baseline refactor; other source is an explicitly limited simulation.

Guidance:
* [demos/legacy-code-transformation/extension/src/proposal-contract.js](../../../demos/legacy-code-transformation/extension/src/proposal-contract.js) exports `PROPOSAL_SCHEMA`, `validateProposal`, and `renderProposalReport`. The pipeline supplies `expectedTarget.source`; edits must replace exactly that span in one target file. The renderer preserves extension-collected context separately from model prose.
* [demos/legacy-code-transformation/extension/src/proposal-report.js](../../../demos/legacy-code-transformation/extension/src/proposal-report.js) exports `generateProposalReport`, `writeProposalReport`, and `DEFAULT_REPORT_DIRECTORY`. The pipeline re-runs `discoverTarget` and `readSourceEvidence`; caller catalogs are never trusted.
* [demos/legacy-code-transformation/extension/src/foundry-adapter.js](../../../demos/legacy-code-transformation/extension/src/foundry-adapter.js) exports `generateModelProposal` and `validateEndpoint`. The default mock ignores environment values and transport; live tests inject fake environment and `fetch` only.
* [demos/legacy-code-transformation/extension/tests/proposal-pipeline.test.js](../../../demos/legacy-code-transformation/extension/tests/proposal-pipeline.test.js) covers the pipeline, writer, fake transport, and offline command. Existing contract, discovery, and manifest suites retain their owning checks.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): Q5-Q6; Foundry and report findings; W6-W10, W15.
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): pre-edit report and approval contract.
* [OpenAI v1 API lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle): both accepted Azure resource hostnames and v1 path, verified 2026-10-08.
* [Structured outputs REST documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs): `api-key`, strict `response_format`, schema subset, and refusal handling, verified 2026-10-08. Unsupported numeric minimum constraints are omitted only from the wire schema; local validation remains strict.

Dependencies:
* P01-T02, P02-T01, P02-T02.

<!-- rpi:phase id=P03 -->
### [x] P03: Enforce approval and verify the .NET change

Goals:
* Apply only the exact approved proposal and compare the transformed pizza fixture against its existing tests and original representative runs.

Dependencies:
* P02.

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Arial, Helvetica, sans-serif", "fontSize": "16px"}}}%%
flowchart LR
	vscode["VS Code host"] --> agent["Added: Legacy transform .agent.md"]
	agent --> tools["Added: Extension-contributed tool provider"]
	tools -->|bounded read| root["Opened, selected project root"]
	tools --> roslyn["Added: Roslyn .NET worker"]
	roslyn --> root
	tools -->|provider commands| ts["TypeScript references and call hierarchy"]
	ts --> root
	tools -->|configured and authorized| foundry["Foundry inference API"]
	foundry --> tools
	tools --> report["Added: Evidence and exact-change proposal"]
	report --> approval["Added: Requester approval gate"]
	approval --> apply["Added: Proposal-bound apply tool"]
	apply --> runner["Added: Controlled sample replay"]
	root --> fixtures["Added: Pizza and banking fixtures"]
	runner --> tests["Added: Existing tests and replay comparison"]
	fixtures --> tests
	classDef new stroke-dasharray: 5 5
	class agent,tools,roslyn,report,approval,apply,runner,fixtures,tests new
	class report,approval,apply,runner,tests phase
```

Highlighted work: bind approval to the proposal, apply only listed edits, and compare the same .NET tests and inputs.

<!-- rpi:task id=P03-T01 -->
#### [x] P03-T01: Bind edits to an approved proposal

Goals:
* Prevent source changes unless the requester confirms the exact current proposal and ensure the apply operation cannot add unlisted edits.

Requirements:
* FR-003, FR-005, NFR-002.
* Keep discovery tools read-only and do not expose a generic source-edit operation to the analysis agent.
* Bind the apply request to a proposal identifier/content hash and source-file hashes; reject stale proposals or changed source.
* Require an extension-owned confirmation for every application, independent of agent tool auto-approval settings; bind that confirmation to the proposal ID, source hashes, and exact diff.
* Initial preview staging is complete. Register generation/apply only when extension-owned confirmation is available. Commands and the manual agent share candidates and gates; expose only the requested owned generation and ID-only apply tools alongside read-only discovery/evidence. Native chat interaction remains subject to P04-T02 smoke, not inferred from mocked tests.
* Show the exact affected files and edits in the confirmation before application. Cancel must leave all source files unchanged.
* Apply only the approved edits and stop for a revised report/fresh approval if changes are needed beyond them.

Details:
* Keep approval state and proposed patches structured and immutable for the duration of the workflow. A generic tool invocation confirmation is not sufficient because tool approvals can be configured; the extension-owned confirmation and proposal hash are required for each write.
* Cover approved apply, cancelled apply with no changes, stale proposal, and changed-source rejection in the extension-tool suite.
* Keep the existing user requirement that report approval precedes code edits.
* Capture full source bytes/hash and saved document version at generation, not apply. Retain deep-frozen candidates in memory only; exclude no-change candidates. Original report-byte changes, source changes anywhere in the file, dirty buffers, version changes, and unsafe roots/symlink paths invalidate the candidate before or after the modal and replay.
* Resolve only the exact selected line/character span, preserving UTF-8 BOM and LF/CRLF outside it. Never accept caller edit objects or approval booleans. Keep arbitrary project apply disabled until equivalent controlled verification is configured.

Guidance:
* [demos/legacy-code-transformation/extension/src/proposal-report.js](../../../demos/legacy-code-transformation/extension/src/proposal-report.js) `generateProposalReport` returns validated `proposal`, `target`, `evidenceCatalog`, `reportPath`, `reportHash`, `proposalHash`, `targetSpanHash`, `evidenceHash` and full `sourceSnapshot`. The store retains an immutable structured snapshot rather than trusting rendered prose or caller assertions.
* `proposalHash` hashes validated proposal JSON; `evidenceHash` binds the catalog. `targetSpanHash` hashes normalized excerpt text, not full source bytes, and may be `null` for unresolved no-change targets. `sourceSnapshot.fileHash` binds complete saved bytes/version; `reportHash` binds original report bytes. All are revalidated before writes; none is an approval token.
* [demos/legacy-code-transformation/extension/src/extension.js](../../../demos/legacy-code-transformation/extension/src/extension.js) registers generation command/tool and review command/ID-only apply against one `ProposalCandidateStore`. `registerProposalReportTool` and `registerProposalApply` require independent extension confirmation support.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): approval finding and W9; user scope evidence C4.
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): exact approval and fresh-approval rules.

Dependencies:
* P02-T03.

<!-- rpi:task id=P03-T02 -->
#### [x] P03-T02: Replay and compare the .NET fixture

Goals:
* Demonstrate that the approved pizza refactor passes the same existing tests and representative inputs captured against the original fixture.

Requirements:
* FR-006, NFR-004.
* Run only the controlled fixture/test harness in this PoC; do not run arbitrary project build targets as part of discovery.
* Compare each original and transformed output, error, and observable side effect; report uncovered behavior as unknown.
* Leave the source unchanged when tests or replay indicate a behavior difference, and produce a revised proposal rather than applying a fix outside approval.

Details:
* Use the baseline from P01-T02 and preserve the exact representative input set across both versions.
* Before changing selected source, run the original and exact proposed pizza replacement on an isolated disposable copy of six fingerprint-checked fixture files. Never build mutable unknown project files or execute other replacements. Fixed arguments, no shell, explicit public-source NuGet configuration, disabled inherited MSBuild imports, finite timeout, output bounds and cancellation constrain the controlled harness.
* Record extension-owned test/run stdout, stderr, exit codes and visible working-directory files in a separate safe Markdown verification report; preserve the reviewed proposal report hash. Test log durations vary, so compare test counts/exits/errors and exact representative replay output, not raw test log equality. External/network/timing effects and uncovered inputs remain unknown; disposable copies are not an OS sandbox.
* On mismatch, launch failure, timeout or cancellation leave selected source unchanged and require a revised proposal. Revalidate full source hashes and saved versions after confirmation/replay and before the exact write; do not repair outside approval or roll back concurrent edits.

Guidance:
* [demos/legacy-code-transformation/extension/src/proposal-apply.js](../../../demos/legacy-code-transformation/extension/src/proposal-apply.js) exports `ProposalCandidateStore`, `ApplyProposalTool`, generation snapshot helpers, `spanOffsets` and `replacementBytes`. Apply accepts only the store-issued ID; the verification dependency is extension-owned, not tool input.
* [demos/legacy-code-transformation/extension/src/fixture-replay.js](../../../demos/legacy-code-transformation/extension/src/fixture-replay.js) preserves `verifyPizzaProposal`, `runDotnet`, `PIZZA_CASES`, `renderVerificationReport` and adds `verifyNodeProposal`, `runNode`, `verifyControlledProposal`. `readControlledFixture`/`assertFixtureHashes` select separate pinned pizza/Node definitions. The store defaults to the generic verifier; other replacements/projects are unsupported.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): Q6 and Contrarian finding on test evidence versus proof.
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): post-approval test/replay requirements.

Dependencies:
* P01-T02, P03-T01.

<!-- rpi:phase id=P04 -->
### [x] P04: Add the Node.js transfer slice

Goals:
* Demonstrate the same bounded discovery, proposal, approval, and replay workflow for the Node.js 24.19 banking transfer fixture after the .NET slice is stable.

Dependencies:
* P03.

```mermaid
%%{init: {"themeVariables": {"fontFamily": "Arial, Helvetica, sans-serif", "fontSize": "16px"}}}%%
flowchart LR
	vscode["VS Code host"] --> agent["Added: Legacy transform .agent.md"]
	agent --> tools["Added: Extension-contributed tool provider"]
	tools -->|bounded read| root["Opened, selected project root"]
	tools --> roslyn["Added: Roslyn .NET worker"]
	roslyn --> root
	tools -->|provider commands| ts["TypeScript references and call hierarchy"]
	ts --> root
	tools -->|configured and authorized| foundry["Foundry inference API"]
	foundry --> tools
	tools --> report["Added: Evidence and exact-change proposal"]
	report --> approval["Added: Requester approval gate"]
	approval --> apply["Added: Proposal-bound apply tool"]
	apply --> runner["Added: Controlled sample replay"]
	root --> fixtures["Added: Pizza and banking fixtures"]
	runner --> tests["Added: Existing tests and replay comparison"]
	fixtures --> tests
	classDef new stroke-dasharray: 5 5
	class agent,tools,roslyn,report,approval,apply,runner,fixtures,tests new
	class tools,root,ts,fixtures,runner,tests phase
```

Highlighted work: add the Node fixture, verify the TypeScript provider path, and replay each case from reset account state.

<!-- rpi:task id=P04-T01 -->
#### [ ] P04-T01: Add Node transfer discovery and fixture

Goals:
* Resolve references/call hierarchy for the selected JavaScript target when the provider is available and establish deterministic banking behavior cases.

Requirements:
* FR-001, FR-002, FR-007, NFR-001, NFR-004.
* Target Node.js 24.19. Preserve the confirmed rules: both accounts exist and differ; amount is positive; source funds are sufficient; rejected transfers return a reason and leave balances unchanged.
* Configure an explicit JavaScript project when needed and report provider unavailability or unresolved dynamic references.
* Cover successful transfer and every confirmed rejection case.

Details:
* Use the VS Code TypeScript provider commands only after the target root is open and project loading is complete. Do not assume the target's Node runtime version determines the installed TypeScript service version.
* Use a correct nested legacy function with an exact known guard-clause mock replacement. Pin the owned Node source, runner, test cases and project metadata; reject unsupported harnesses/replacements before any process. Run eight reset-state tests and eight transfer inputs plus a fixed CLI error on disposable baseline/transformed copies; compare JSON results/balances, stdout/stderr/exits and visible working-directory files.
* Use native Node spawn with no shell, restricted environment excluding model/auth values and `NODE_OPTIONS`, finite timeout, bounded output and cancellation. Keep both bundled fixture sources unchanged during tests. Installed `v24.19.0` satisfies the runtime target; native TypeScript provider version/readiness remains a P04-T02 smoke requirement.

Guidance:
* Reuse the immutable snapshot, candidate, exact-span, report-hash and modal gate in [demos/legacy-code-transformation/extension/src/proposal-apply.js](../../../demos/legacy-code-transformation/extension/src/proposal-apply.js). Add equivalent owned Node fixture verification before enabling Node apply; do not bypass the current pizza-only preflight.
* [demos/legacy-code-transformation/extension/src/fixture-replay.js](../../../demos/legacy-code-transformation/extension/src/fixture-replay.js) provides the disposable-copy pattern, fixed process execution, cancellation/timeouts, observed evidence, and fixture rechecks. Its fingerprints/replacement/input set are pizza-specific and must not be reused as Node evidence.
* [demos/legacy-code-transformation/extension/src/node-fixture.js](../../../demos/legacy-code-transformation/extension/src/node-fixture.js) exports `NODE_TARGET_PATH`, `NODE_BASELINE`, `NODE_REPLACEMENT`, `NODE_HASHES`, `NODE_CASES` independently of pizza. The controlled Node fixture is [demos/legacy-code-transformation/fixtures/node](../../../demos/legacy-code-transformation/fixtures/node), with explicit `jsconfig.json` and dependency-free builtin tests.
* The generic replay selector uses separate definitions, not pizza fingerprints as Node evidence. `verifyNodeProposal` and `runNode` own Node execution; `verifyControlledProposal` selects the verifier. Existing pipeline/apply tests cover provider doubles and real disposable verification, not real host readiness.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): Q3; W13-W14; provider version/capability limitations.
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): Node transfer contract and deferred Java support.

Dependencies:
* P03.

<!-- rpi:task id=P04-T02 -->
#### [x] P04-T02: Complete the integrated PoC handoff

Goals:
* Make the two-slice PoC repeatable for a reviewer and document its supported boundaries, setup, report path, and prerequisites.

Requirements:
* FR-001 through FR-007, NFR-001 through NFR-004.
* The demo README explains how to open the sample workspace, run the fixture tests, use the agent, and review/apply an approved proposal.
* State the Foundry live-call prerequisites and keep source-data permission, endpoint/model configuration, and credentials outside tracked artifacts.
* Summarize known limits: no complete dynamic call graph, no formal equivalence proof, no Java support, and no unrestricted arbitrary-project execution.
* Complete the agent experience using the registered owned generation and ID-only apply tools sharing the commands' store. Keep manual invocation enabled and automatic invocation/delegation disabled; require report/exact-diff inspection and user application request before the independent extension-owned modal. Reports/model content remain untrusted data.

Details:
* Perform an end-to-end manual smoke in the VS Code extension development host: discovery report, explicit approval, exact edit application, and before/after test/replay for .NET and Node.
* Do not add the demo runtime to HVE Core plugin membership or VSIX packaging unless separately planned and approved.
* README and standalone launch recipes are implemented. User authorized native host smoke on 2026-10-08; both controlled workflows completed report, explicit exact approval, application and before/after verification. Native Node cancellation passed; separate pizza cancellation was skipped. No new servers/browser/model/service setup, provisioning, credentials reading or live Foundry calls were authorized.
* Verify both fixtures on pristine disposable copies. Approved replacement works once per baseline fingerprint; use a new copy for another demonstration, not rollback or a generic transformation. Frontmatter/public-feed owners remain unavailable without `pwsh`; do not install tools implicitly.

Guidance:
* [demos/legacy-code-transformation/extension/src/extension.js](../../../demos/legacy-code-transformation/extension/src/extension.js) exports `GENERATE_REPORT_TOOL`, `GenerateProposalReportTool`, `registerProposalReportTool`, `registerProposalReportCommand`, `registerProposalApply`. Generation returns status/mode/candidate ID/path/hashes only and uses owned reads; commands/tools share immutable candidates.
* [demos/legacy-code-transformation/extension/.vscode/launch.json](../../../demos/legacy-code-transformation/extension/.vscode/launch.json) prompts for disposable pizza/Node fixture roots without changing root configuration. [demos/legacy-code-transformation/README.md](../../../demos/legacy-code-transformation/README.md) is the shipped setup/review/live-prerequisite handoff.
* [demos/legacy-code-transformation/extension/tests/manifest.test.js](../../../demos/legacy-code-transformation/extension/tests/manifest.test.js) checks exact requested registrations and launch recipes; pipeline/apply suites own report binding, cancellation and real controlled replay. Full automation does not certify native picker/dialog/provider behavior.

References:
* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): recommendation, risks, and Planning Readiness gates.
* [extension/PACKAGING.md](../../../extension/PACKAGING.md): packaging boundary.

Dependencies:
* P01-T01, P01-T02, P02, P03, and P04-T01.

## User Decisions and Requirements

### Confirmed User Direction

* Continue the non-standard DT-to-RPI handoff as a technical feasibility PoC; Methods 2-6 and real-user demand validation remain skipped/out of scope.
* Start with .NET 10 pizza eligibility: members receive 10% off; non-members receive the same discount when subtotal is at least $50; otherwise no discount. The Node.js 24.19 banking transfer demo is second; Java is deferred.
* The requester supplies a project-folder path plus target file and function/class. Discovery stays within that root and cites callers, tests, surrounding code, README/docs, and observed input/output evidence. Unresolved dynamic references are reported as unknown.
* Generate a Markdown analysis/proposal report before code edits. The requester approves the exact listed changes; any unlisted change requires a revised proposal and fresh approval.
* After approval, apply only the approved changes, run existing tests, and replay the same representative inputs. Reset banking state for each input case.
* Use a Foundry-backed LLM API call without provisioning a Foundry resource. Do not access or store credentials in planning artifacts.

### Planning Decisions and Feedback

| Group | Decision or feedback item | Status | Owner | Rationale or input needed | Evidence | Planning impact |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Use a small VS Code extension-contributed tool provider for executable workspace/language-provider operations; keep the custom agent declarative. | Resolved | Agent | Extension tools directly use VS Code workspace APIs and commands. MCP remains an alternative if cross-editor reuse becomes a requirement. | RPI research W8-W10; extension/PACKAGING.md | Shapes the runtime boundary and separate demo location. |
| D2 | Require the selected project root to be an opened workspace folder and fail closed on external project references. | Resolved | Agent | C# Dev Kit and TypeScript services load workspace/project context; explicit validation is required to preserve the user-supplied root boundary. | RPI research W3, W9, W12-W14 | Adds root/URI boundary checks and an external-reference validation gate. |
| D3 | Use a mock-default Foundry v1 REST adapter with API-key auth read from extension-host environment variables `api_key`, `model`, and `endpoint`; require explicit live selection and source-sharing confirmation. | Resolved for the PoC adapter | User | User requested mocked responses for now and future environment-configured Foundry calls on 2026-10-08. No live calls are authorized in this implementation session. | RPI research W6-W7, W9; current user request | Replaces the SecretStorage planning choice with environment configuration; preserves source-sharing and endpoint validation gates. |
| D4 | Bundle the agent through the standalone demo extension's `contributes.chatAgents` path; keep runtime and fixtures separate from HVE Core's plugin packaging. | Resolved | Agent | VS Code supports extension-bundled agents, while HVE plugin discovery is rooted in tracked `.github` paths. | RPI research W16, C1-C2, C5; extension/PACKAGING.md | Avoids HVE plugin membership changes and keeps the agent/tool runtime together. |
| D5 | Write generated reports under `reports/legacy-code-transformation/` in the selected project root by default, with a configurable destination. | Resolved | Agent | Keeps the pre-edit report separate from source files while preserving the user-supplied project-root boundary. | Confirmed report-before-edit workflow; RPI research C4 | Defines report output without editing source before approval. |

## Planning Readiness and Next Step

| Field | Record |
| --- | --- |
| Planning execution and readiness | Complete planning and implementation/native smoke; mechanical acceptance deferred for unavailable PowerShell-owned validators. |
| Decision participation | Agent-owned; automatic RPI Agent context. |
| Blockers | Frontmatter/public-feed owners require unavailable `pwsh`. Installed TypeScript service version and broad provider compatibility are not certified. Live compatibility remains a separate optional source-sharing/configuration prerequisite. |
| Latest critique | [.copilot-tracking/reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-3.md](../../reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-3.md), Pass. |
| Relevant research | [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md) |
| Plan | `.copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md` |
| Changes-record role | [.copilot-tracking/changes/2026-10-07/legacy-code-transformation-agent-changes.md](../../changes/2026-10-07/legacy-code-transformation-agent-changes.md) records P01-P04 completion, native repairs, 73/73 tests, actual disposable application comparisons and remaining tooling/live limits. |
| Continuation owner | Active automatic RPI Agent. |
| Required gates or confirmations | Root confinement, report/source binding, independent exact approval and real .NET/Node replay pass with native evidence. PowerShell-owned validators remain unavailable; exact-context source sharing and live configuration remain separate. |
| Next action | Resolve PowerShell-owned mechanical validation as a separately authorized tooling action. No active implementation marker remains; do not infer permission for live calls. |

## Goals

* Deliver a working .NET-first PoC that grounds a refactoring proposal in source, callers/tests/docs, and observed behavior.
* Prevent source edits before explicit approval of the exact proposal, and prevent edits outside that proposal.
* Demonstrate the same report/approval/replay workflow on the Node transfer sample after the .NET slice.

## Scope and Non-Goals

### In Scope

* A separate demo workspace with extension-contributed VS Code tools, a Roslyn-backed .NET analysis helper, bounded workspace search, Foundry API adapter, report generation, approval-bound apply, and controlled sample replay.
* .NET 10 pizza eligibility first; Node.js 24.19 transfer second.
* Existing tests, representative fixture inputs, and explicit unknowns for unavailable providers or dynamic references.

### Non-Goals

* Changing HVE Core's existing declarative extension/VSIX packaging pipeline.
* Java support, architecture redesign, production hardening, service/resource provisioning, real-user demand validation, or unrestricted execution of arbitrary user projects.
* Claiming a complete call graph or formal proof of behavior equivalence.

### Change and Test Limits

* Canonical PoC source changes stay under `demos/legacy-code-transformation/`; remove or modify no existing HVE Core plugin, extension, agent, or test files.
* HVE Core test ownership is unchanged. Demo-owned coverage is limited to one .NET behavior suite, one extension-tool contract/integration suite, and one Node behavior/provider suite. Add cases only for confirmed behavior and material safety boundaries.
* Runtime-generated artifacts are Markdown proposal and separate controlled-verification reports under the selected project's safe artifact directory. Candidates remain memory-only. Do not commit build outputs or generated reports as fixtures.
* Existing tests plus semantic behavior and boundary tests are in scope; unrelated refactoring and broad hardening are not.

## Functional Requirements

* FR-001: Accept a project root, target file, and function/class; reject unsupported or ambiguous targets without editing source.
* FR-002: Discover source references/call sites, tests, surrounding source, README/docs, and representative observed behavior, with exact source locations and unknowns.
* FR-003: Produce a Markdown proposal before code edits, listing affected files and exact proposed changes.
* FR-004: Invoke a configurable Foundry model tool only when endpoint/auth settings and source-data permission are available; use a validated structured proposal contract.
* FR-005: Limit proposals to the selected function/class and any exact helper extraction described in the report; apply only the exact approved proposal and reject stale or unlisted changes.
* FR-006: Run the existing relevant tests and replay the same inputs before and after approved changes.
* FR-007: Add the Node transfer slice after the .NET slice, resetting account state for every replay case.

## Non-Functional Requirements

* NFR-001: No discovered file, language-provider result, project reference, or edit may escape the selected project root; unresolved external dependencies fail closed or are explicitly reported without reading them.
* NFR-002: Discovery is read-only. The apply operation is separate, proposal-bound, and requires confirmation that presents the exact change set.
* NFR-003: Secrets never appear in source, reports, logs, or tracking artifacts; live model invocation is blocked until endpoint-specific auth and data-handling permission are configured.
* NFR-004: Replay fixtures begin from a known state and capture inputs, outputs, errors, and side effects reproducibly.

## Risks and Open Questions

| Priority | Type | Risk, question, or planning item | Affected work | Impact | Smallest action or evidence needed | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| High | Risk | Roslyn solution/project loading may resolve project references outside the selected root. | P02-T01, P02-T02 | Violates the user's explicit discovery boundary. | Fail closed on external project references; test canonicalized root and result URI filtering. | Planner/implementer |
| High | Risk | Running build/test targets or arbitrary selected code can execute project-controlled behavior. | P01-T02, P03-T02 | Potential local side effects and non-repeatable results. | Keep execution to controlled fixtures; require explicit approval and document the isolation boundary. | Planner/implementer |
| Medium | Open question | Installed C# and TypeScript language providers may be absent, loading, or capability-gated. | P02-T02, P04-T01 | Caller data may be incomplete. | Probe provider readiness and surface unavailable/incomplete evidence. | Implementer |
| Medium | User/environment prerequisite | Live resource/model compatibility and source-code data policy remain unverified; extension-host environment API-key configuration is the selected PoC auth path. | P02-T03 | Live invocation cannot be verified without separate configuration and authorization. | The mock/fake-transport adapter is complete. Live use requires a supported resource endpoint, deployed structured-output model, and exact-context sharing permission. If Entra or a different endpoint family is required, reopen D3 rather than guessing an audience. | User/environment |

## Dependencies

* .NET 10 SDK and public NuGet access for Roslyn Workspaces packages.
* VS Code extension host and TypeScript language features for workspace commands/providers.
* Node.js 24.19 for the second demo fixture.
* Foundry endpoint/model/auth configuration and source-data permission only for a live invocation; mock transport is sufficient for local tests.

## Sources

* [.copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md](../../research/2026-10-07/legacy-code-transformation-agent-research.md): synthesized Wider, Deeper, and Contrarian evidence; planning readiness and gates.
* [.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md](../../dt/getting-started/method-01-scope/scope-boundaries.md): confirmed user problem, examples, root boundary, approval gate, and success criteria.
* [extension/PACKAGING.md](../../../extension/PACKAGING.md): existing extension is declarative packaging and should not be treated as an executable runtime.
* [scripts/plugins/Sync-PluginManifest.ps1](../../../scripts/plugins/Sync-PluginManifest.ps1): manifest synchronization is scoped to tracked files under root `.github`.
* [.github/agents/design-thinking/dt-coach.agent.md](../../../.github/agents/design-thinking/dt-coach.agent.md): workspace agent tool declarations and DT handoff context.
* [package.json](../../../package.json): available repository validation and test scripts; no project implementation command selected yet.
* [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points): the extension can contribute its bundled custom agent through `contributes.chatAgents`.
* [OpenAI v1 API lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) and [structured outputs REST documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs): resource endpoint, API-key request, response-schema subset, and refusal contract for P02-T03.

## Critique Disposition

* Critique setting and provenance: standard; default required by rpi-plan.
* Critique status: Complete.
* Latest critique and verdict: [.copilot-tracking/reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-3.md](../../reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-3.md), Pass.
* Earlier critiques: [.copilot-tracking/reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique.md](../../reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique.md), Revise; [.copilot-tracking/reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-2.md](../../reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-2.md), Pass.
* Limitations: critique uses supplied evidence only. Diagrams were not rendered in light/dark themes; runtime behavior remains unverified.

| Critique run and finding | Disposition | Action owner | Exact resolving evidence | Decision route | Plan response or residual risk |
| --- | --- | --- | --- | --- | --- |
| Initial standard PC-001, explicit human approval | Resolved; verified by follow-up Pass | Planning parent | Follow-up critique confirms P03-T01 requires extension-owned confirmation independent of tool auto-approval, exact proposal/source hashes, and cancel/stale-source tests. | Direct planner correction | Source edits require the extension-owned confirmation on every apply. |
| Initial standard PC-002, Foundry auth risk conflict | Resolved; verified by historical follow-up Pass | Planning parent | Earlier D3 selected SecretStorage; the user's 2026-10-08 environment direction supersedes that storage choice. Current D3 and the risk row agree on environment API-key handling and separate live-call prerequisites. | Direct planner correction, then explicit user update | Historical critique is not live runtime verification; fake-transport tests validate the current adapter boundaries. |
| Follow-up standard critique, revised approval and auth boundaries | Pass; no new findings | Planning parent | .copilot-tracking/reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-2.md | No further revision required | Plan is ready for implementation; runtime gates remain explicit. |
| Post-critique packaging refinement: extension-contributed agent | Pass; no new findings | Planning parent | [.copilot-tracking/reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-3.md](../../reviews/plans/2026-10-07/legacy-code-transformation-agent-plan-critique-3.md) confirms W16/C5 supports the bundled-agent path. | No further revision required | P01 is complete; P02-T01 is eligible to proceed. |

## Artifact Self-Check

* [x] Executive Summary, What You May Not Know, and the Phase Checklist come first and are understandable without reading the supporting sections.
* [x] Confirmed direction, grouped decisions, readiness, goals, scope, requirements, risks, and dependencies are current and consistent with the Phase Checklist.
* [x] Planning decision participation and provenance are recorded; agent-owned choices have evidence-backed rationales or honest blockers.
* [x] Every FR/NFR is cited by at least one task's Requirements.
* [x] Every phase and task has the required labeled blocks and a current diagram.
* [x] Open decisions, risks, and questions name the affected Pxx-Txx.
* [x] Existing paths use correct workspace-relative links; not-yet-created paths remain in backticks.
* [x] Before is evidence-backed; After and phase diagrams use stable IDs and distinguish additions/removals.
* [x] Diagram initialization styling follows the planning reference; dual-theme rendering limitation is recorded because preview was unavailable.
* [x] Critique setting, status, findings, dispositions, readiness, continuation owner, gates, and next action are current.
* [x] Follow-Up Items remain outside active plan completion.
* Checked sections: task metadata, executive summary, phase/task blocks and diagrams, decisions, readiness, requirements, risks, critique dispositions, sources, and handoff.
* Missing or limited sections: diagrams were not rendered in light/dark themes. Both native controlled workflows passed; installed TypeScript service version, comprehensive provider compatibility and optional live invocation are not certified. `pwsh`-owned frontmatter/public-feed checks are unavailable; human review acceptance is not inferred.

## Follow-Up Items

* None

## Handoff

* Authoritative implementation handoff: Planning Readiness and Next Step.
