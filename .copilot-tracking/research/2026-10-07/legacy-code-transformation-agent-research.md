<!-- markdownlint-disable-file -->

# Legacy Code Transformation Agent Research

| Field | Value |
| --- | --- |
| Date | 2026-10-07 |
| Researcher / agent | RPI Research |
| Output mode | convergence |

## Executive Summary

Cycle 1 supports a .NET-first PoC using a VS Code extension-contributed custom agent, Roslyn MSBuild Workspaces, bounded workspace search, and installed TypeScript language providers for the later Node slice. P02-T01 has validated root-filtering behavior in controlled extension tests. Cycle 2 confirms Roslyn 5.9.0 evaluates project files and executes design-time targets in a separate BuildHost process; custom target tasks may run. P02-T02 can proceed only with an extension-owned confirmation before MSBuild loading and a syntax-only/text/provider fallback when that confirmation is declined.

* Bottom line: the architecture is feasible; P02-T02 may resume by implementing the MSBuild confirmation gate and declined-consent fallback before project loading.
* Why this matters: the user needs a defensible technical path for the first .NET 10 demo, with Node.js 24.19 as the second demo.
* Research status: Cycles 1 and 2 are synthesized; Q8 is answered with an implementation prerequisite.
* Confidence and uncertainty: the exact Roslyn 5.9.0 source confirms design-time target execution in a separate process. Process separation is not evidence of sandboxing, and whether a specific imported custom task runs depends on project hooks.

## What You May Not Know

This is an early, user-directed research start, not a standard DT exit tier. Method 1 is complete, Methods 2-6 were intentionally skipped, and Method 7a is incomplete. The PoC will test technical workflow feasibility only; it will not establish real-user demand.

## Findings

### VS Code exposes commands that query registered language providers

VS Code has commands for document symbols, references, and call hierarchy, including `vscode.executeReferenceProvider`, `vscode.prepareCallHierarchy`, `vscode.provideIncomingCalls`, and `vscode.provideOutgoingCalls`. These commands invoke language providers registered for the document; they are an orchestration surface, not an independent semantic analyzer. The extension must verify that the relevant provider is present and has loaded the supplied project before treating returned locations as evidence.

* Questions: Q1, Q3
* Evidence state: evidence-backed finding
* Evidence: W1
* Confidence and limits: The command contract is explicit. Whether the active C# and Node providers return complete enough results for the target projects is not yet validated.

### C# and JavaScript have language-service reference support, with project setup affecting scope

VS Code documents C# Dev Kit as Roslyn-based, with .NET/MSBuild project support and reference CodeLens/navigation. Its C# experience can load a single solution when that solution is present in the opened workspace. In the built-in JavaScript extension source, the reference provider calls `tsserver`'s `references` request, and the call-hierarchy provider calls `prepareCallHierarchy`, `provideCallHierarchyIncomingCalls`, and `provideCallHierarchyOutgoingCalls`. Call hierarchy registration is gated on a minimum TypeScript service version and semantic capability. JavaScript project membership depends on configured, external, or inferred project rules; `jsconfig.json` lets a project explicitly include and exclude files.

* Questions: Q1, Q2, Q3
* Evidence state: evidence-backed capability with runtime prerequisite
* Evidence: W2, W3, W13, W14
* Confidence and limits: The command API and current built-in TypeScript provider implementation are verified. The provider can return no results when unavailable or not semantically enabled; installed extension versions and target workspace behavior still need a smoke test.

### Roslyn Workspaces provides a solution-level .NET analysis model

Roslyn separates parsing into syntax trees from declaration and semantic binding into symbols and semantic models. Its Workspaces layer models solutions, projects, documents, and project references. The current `Microsoft.CodeAnalysis.Workspaces.MSBuild` package is version 5.9.0 and targets .NET 10; the package description says to add language support such as `Microsoft.CodeAnalysis.CSharp.Workspaces`. `SymbolFinder.FindReferencesAsync` finds references to a symbol in a solution and has an overload that restricts the search to a supplied document set. In the 5.9.0 source, `MSBuildWorkspace.OpenSolutionAsync` delegates to a project loader and BuildHost. The BuildHost sets `DesignTimeBuild=true`, `BuildProjectReferences=false`, `BuildingProject=false`, and `SkipCompilerExecution=true`, but still invokes MSBuild targets `Compile` and `CoreCompile` plus an optional design-time markup target. Custom tasks attached to those targets may therefore execute even though the C# compiler and dependent-project builds are skipped.

* Questions: Q2, Q4
* Evidence state: evidence-backed finding with a project-trust prerequisite
* Evidence: W4, W5, W12
* Confidence and limits: Public package/API docs and the package's exact upstream source commit confirm the loading path and design-time targets. A separate BuildHost process provides process separation, not an OS sandbox. Exact project compatibility and external reference behavior still require controlled tests; arbitrary projects must not be loaded without explicit approval.

### Original-code execution needs a separate trust decision

VS Code Workspace Trust disables agents in Restricted Mode and restricts terminal, task, and debugging features. Its security documentation recommends sandboxing agent-executed terminal commands; on Windows this is currently Experimental, and its documented scope is terminal commands rather than arbitrary extension-tool code. Trust/approval is therefore not equivalent to a general-purpose sandbox for executing a selected function. For the PoC, deterministic runs should use the controlled pizza and banking fixtures; any execution of an arbitrary user project needs an explicit trust/approval boundary and a clear report of what was run.

* Questions: Q6
* Evidence state: evidence-backed risk and recommended constraint
* Evidence: W15
* Confidence and limits: This establishes VS Code's documented security boundary, not the safest final harness. Dev Container isolation and what the custom tool itself can execute remain planning/implementation decisions.

### Roslyn/MSBuild project loading can execute project-defined target tasks

Roslyn 5.9.0 source shows that `MSBuildWorkspace.OpenSolutionAsync` loads through a separate BuildHost and executes a design-time build request for `Compile` and `CoreCompile` targets, with compiler execution skipped and project-reference builds disabled. Because MSBuild lets projects import custom targets/tasks and `Compile`/`CoreCompile` may have project-defined hooks, the load operation must be treated as potentially executing project-controlled code. The BuildHost is described as process separation for dependency isolation, not a sandbox. `ProjectCollection.IsBuildEnabled=false` prevents calls through `Project.Build`, but the Roslyn loading path directly uses `BuildManager` and does not set that property in the inspected code.

* Questions: Q8
* Evidence state: evidence-backed risk and required consent boundary
* Evidence: W17-W22
* Confidence and limits: The Roslyn 5.9.0 package source commit confirms the specific design-time target invocation and flags. Whether an arbitrary target's custom task actually runs depends on its project hooks; no user project was executed in this research.

For P02-T02, require an extension-owned confirmation before loading an arbitrary project through MSBuild Workspace. The prompt must state that Roslyn will evaluate the solution and invoke design-time targets that may run custom tasks. If declined, fall back to syntax-only parsing, bounded text search, and provider results already available in the editor, and label semantic references unresolved rather than claiming equivalence.

### Symbol references must not be reported as a complete call graph

Roslyn and TypeScript providers can resolve references and call-hierarchy edges, but neither documented provider contract establishes all runtime dispatch paths. Reflection, dependency injection, delegates, dynamic property calls, generated code, and string-based invocation can evade static references or make caller identity ambiguous. The report should distinguish language-provider references, textual matches, direct call sites, and unresolved paths; it should use the phrase "references found" rather than claim a complete call graph.

* Questions: Q1, Q3, Q4
* Evidence state: evidence-backed limitation
* Evidence: W1, W12, W13, W14
* Confidence and limits: The provider contracts are scoped to static language analysis. Exact missed cases depend on source patterns and project configuration.

### Representative runs and passing tests are evidence, not proof of equivalence

The user-approved workflow compares existing tests and replays the same sample inputs before and after edits. Those checks demonstrate preservation only for the covered cases; they cannot prove equivalence for all inputs or hidden environment-dependent behavior. The report should capture each input, initial state, observed output, side effects, and test command/result, and retain unknowns where coverage is incomplete. Banking cases need a fresh state fixture for every run.

* Questions: Q6
* Evidence state: evidence-backed limitation derived from confirmed success criteria
* Evidence: C4, W15
* Confidence and limits: The replay workflow is user-confirmed. A general arbitrary-project runner and its sandbox are not validated.

### An agent-only approval instruction is weaker than a proposal-bound apply operation

VS Code's extension-tool API provides an invocation confirmation message, but that confirmation is attached to a tool call, not inherently to the report's exact content. A robust PoC should not expose a generic edit tool during analysis. The apply operation should be separate, limited to an immutable proposal/report identifier and listed edits, and show the exact change set before application. An LLM's prose promise alone is not an authorization boundary.

* Questions: Q4, Q6
* Evidence state: evidence-backed design constraint
* Evidence: W8, W9, W10, C4
* Confidence and limits: Tool confirmation is documented. Whether to enforce proposal binding inside a custom tool or rely on explicit workflow confirmation remains an implementation decision; tool-level binding is recommended.

### Foundry offers a direct OpenAI-compatible chat-completions API

The current Foundry REST reference documents `POST {endpoint}/openai/v1/chat/completions`, with `model` and `messages` in the request. The v1 API avoids a dated `api-version` query parameter and documents API-key and Microsoft Entra authentication. The v1 lifecycle article recommends the Responses API for Azure OpenAI models while still documenting chat completions for supported model families. The endpoint and model deployment should determine the final request path and Entra audience; current official pages show different token scopes for these API descriptions. This supports the user's API-call direction without requiring a hosted Foundry agent or resource provisioning as part of this research.

* Questions: Q5
* Evidence state: evidence-backed finding
* Evidence: W6, W7
* Confidence and limits: Endpoint shapes and authentication options are documented, but the user's selected endpoint, model deployment, and organizational authentication requirements are unknown and will not be queried here. The tool would transmit supplied source context to that endpoint; permission to send non-demo project code must be confirmed before live use.

### The current HVE Core extension folder is packaging-only

The repository's `extension/` folder contains packaging metadata, assets, and templates rather than a custom extension runtime. Its packaging guide describes it as declarative and says workspace files are accessed through standard VS Code workspace APIs. This repository therefore supplies agent/artifact conventions, not an existing Roslyn or Foundry runtime implementation to reuse.

* Questions: Q1, Q4, Q5
* Evidence state: evidence-backed finding
* Evidence: C1, C2
* Confidence and limits: The packaging guide and directory inventory establish the current structure; this does not constrain the PoC from adding a separate local tool or extension later.

### A custom agent needs an executable tool provider for specialized behavior

VS Code custom agents define role instructions and select built-in, MCP, or extension-contributed tools. The Language Model Tool API lets an extension register executable tools and use VS Code APIs; it also supports per-invocation confirmation messages. VS Code positions MCP as a fit when a tool is already an MCP server, should be reused across environments, is remotely hosted, or does not need VS Code APIs. The agent Markdown file alone is therefore not the runtime for Roslyn analysis or a direct Foundry REST call.

* Questions: Q1, Q4, Q5
* Evidence state: evidence-backed finding
* Evidence: W8, W9
* Confidence and limits: Official docs establish the extension/MCP choices and confirmation mechanism. The PoC's distribution and host requirements are not yet fully specified.

### A standalone extension can bundle its own custom agent without a workspace `.github` artifact

VS Code's `contributes.chatAgents` contribution points to a `.agent.md` file inside the extension root, so the agent and executable tools can ship together in a standalone PoC extension. HVE Core's plugin synchronizer separately indexes tracked files under the repository-root `.github` artifact root and only classifies package-scoped agent paths there. Keeping the demo agent inside its own extension avoids accidental membership in HVE Core's plugin and preserves the confirmed no-packaging-change boundary.

* Questions: Q7
* Evidence state: evidence-backed finding
* Evidence: W16, C5
* Confidence and limits: VS Code contribution-point documentation and the local synchronizer establish the packaging boundary. The standalone extension still needs its own build/activation smoke test.

### VS Code provides bounded file discovery primitives, but caller code must enforce the project root

The VS Code extension API exposes `workspace.findFiles` with include/exclude patterns and a `RelativePattern` whose base can be a URI or workspace folder; `workspace.fs` reads resources across supported file systems. This gives an extension a native mechanism for project-root-bounded search without using host-specific filesystem assumptions. The API does not automatically bind a user-supplied path to a workspace folder, so the implementation must validate the selected directory and filter both discovered files and language-provider results against it.

* Questions: Q4
* Evidence state: partially supported claim
* Evidence: W9
* Confidence and limits: The API signatures and pattern semantics are documented. Canonical path handling, symlink policy, multi-root behavior, and URI filtering need Deeper validation.

## Recommendation and Alternatives

Use an extension-contributed VS Code custom agent and a small, separately implemented extension tool provider for executable operations. Bundle the `.agent.md` inside the standalone extension using `contributes.chatAgents`; do not put the demo agent under HVE Core's root `.github` tree or alter its plugin catalog. Before Roslyn loads an arbitrary project, show an extension-owned confirmation that names design-time target execution risk. If declined, use syntax-only parsing, bounded search, and available editor-provider results, and label semantic project references unresolved. During the PoC, test MSBuild loading only against the controlled pizza fixture. For Node, query the installed TypeScript provider through VS Code reference/call-hierarchy commands and report when the provider or project context is unavailable. Keep the Foundry request in a dedicated tool, follow the endpoint-specific current API/auth contract, and do not send real project source until the applicable data-handling policy is confirmed. Keep discovery read-only; expose a separate proposal-bound apply operation only after approval.

| Option | Benefits | Costs and risks | Evidence | Disposition |
| --- | --- | --- | --- | --- |
| Extension-contributed custom agent plus a small extension tool provider; Roslyn helper for .NET, built-in TypeScript providers for Node, and a dedicated Foundry API tool. | Bundles the agent and executable tools together; direct access to VS Code commands and workspace APIs; avoids changing HVE Core plugin membership. | Requires a new runtime not present in this repository's declarative extension folder; root confinement, confirmation-before-load, endpoint auth, and controlled execution need tests. | W8-W16, W20-W22, C1-C5 | Recommended for the VS Code-only PoC, gated by root-boundary checks, MSBuild-load confirmation, and controlled-fixture replay. |
| MCP server for discovery and Foundry calls. | Portable across editors; natural fit for an existing or remote service and MCP tool confirmation. | Does not directly use VS Code extension APIs for language commands; coordinating Roslyn and the TypeScript provider path becomes less direct. | W9-W10, W15 | Keep as an alternative if cross-editor reuse becomes a requirement. |
| `.agent.md` instructions plus built-in search/terminal tools only. | Lowest initial setup; useful for a manual feasibility spike. | Cannot itself implement a direct Foundry call or deterministically expose VS Code provider APIs; generic terminal execution and model-authored edits weaken reproducibility and approval binding. | W8-W11, W15 | Not recommended as the durable PoC architecture; use only for a disposable manual probe. |

## Scope and Questions

* Goal: validate implementation evidence and close technical unknowns for the user-directed VS Code agent PoC.
* Audience and use: the PoC builder deciding how to implement the first technical slice.
* In scope: VS Code agent/orchestration capabilities; C#/.NET 10 Roslyn and editor-provider paths; JavaScript/Node.js 24.19 provider paths; project-root-bounded source and documentation search; Foundry model API integration; repeatable execution and comparison of sample inputs; exact approval-gated changes.
* Out of scope: coding or editing source; provisioning Foundry resources; Java implementation; real-user demand validation; changing the user's agreed project scope.
* Decision and evidence criteria: identify a feasible, source-verifiable path, its prerequisites and limitations, and a testable first slice. Do not claim complete call-graph coverage where dynamic references remain unresolved.
* Requested output: evidence-based comparison and one recommended technical path if sources support it.

| ID | Question | Source | Status |
| --- | --- | --- | --- |
| Q1 | Which VS Code APIs/commands can query document symbols, references, and call hierarchy from installed language providers? | User request and official VS Code API | Answered at API and TypeScript-provider implementation level; installed-provider smoke test remains |
| Q2 | What does Roslyn Workspaces provide for loading a .NET 10 project and finding symbol references? | User-selected direction and official Roslyn documentation | Answered at package/API level; safe root-bounded loading still needs validation |
| Q3 | Which reference/call-hierarchy operations work for the Node.js 24.19 JavaScript demo, and what project configuration is required? | User scope and official VS Code/TypeScript documentation | Answered at provider implementation/project-model level; installed-version smoke test open |
| Q4 | What bounded workspace search mechanism should gather README, tests, callers, and surrounding source only under the supplied project root? | User-confirmed scope and VS Code extension APIs | API path identified; canonical root validation and external project-reference policy remain |
| Q5 | What Foundry API request/authentication pattern fits a VS Code custom agent without turning this into resource provisioning? | User-confirmed API-call direction and official Foundry documentation | API options answered; endpoint-family auth scope, model/deployment, and source-data policy remain |
| Q6 | How should the PoC execute original sample inputs and rerun them after approved changes reproducibly, including resetting banking state? | User-confirmed behavior-comparison workflow | Partially answered; VS Code trust is not a general sandbox; harness choice open |
| Q7 | How can the custom agent be bundled without changing HVE Core plugin membership? | Planning gap during RPI handoff | Answered: use the extension `contributes.chatAgents` path to a bundled `.agent.md`; keep it outside root `.github` |
| Q8 | Does loading a target .NET solution/project through Roslyn MSBuild Workspaces evaluate user-controlled build logic, and what does that mean for the PoC trust gate? | Implementation discovery in P02-T02 | Answered: Roslyn 5.9.0 evaluates projects and executes design-time targets in a separate process; require explicit extension confirmation before arbitrary project loading. |

## Decisions and Feedback

| Group | Decision or feedback item | Status | Owner | Rationale or input needed | Evidence | Impact of answer |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Use Roslyn for .NET code analysis. | Confirmed | User | User selected Roslyn; research validates a .NET 10 MSBuild Workspaces package and symbol-reference API. | W4, W5, W12 | Shapes the .NET discovery path. |
| D2 | Use workspace search with language-aware reference analysis. | Confirmed direction | User | Search stays in the supplied project folder; language references should be cited and unresolved dynamic references marked unknown. | W1, W9 | Shapes the cross-file evidence path. |
| D3 | Call a Foundry LLM API for the model step. | Confirmed direction | User | Research API/auth options; do not provision a Foundry project. | W6, W7 | Shapes model invocation/tool boundary. |
| D4 | Start with .NET 10 pizza eligibility; Node.js 24.19 banking transfer is second; Java later. | Confirmed | User | Tests the report workflow on one sample before expanding. | .copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md | Bounds the first recommendation. |

## Risks and Open Questions

| Priority | Type | Risk, question, or research item | Impact | Smallest action or evidence needed | Owner |
| --- | --- | --- | --- | --- | --- |
| Medium | Validation gate | VS Code language-provider availability and project loading vary by extension/version. | Caller discovery could be incomplete or unavailable in a target workspace. | Smoke-test references and incoming/outgoing calls in the controlled Node fixture; detect unavailable or empty provider responses. | Plan/implementation |
| High | Open question | A project path supplied as input may not be the active VS Code workspace root, and Roslyn project references may point outside it. | Search or project loading could inspect files outside the user's explicit boundary. | Validate/canonicalize the selected root, filter every discovered URI, and fail closed or report external project references without reading them. | Plan/implementation |
| High | Implementation gate | Roslyn MSBuildWorkspace loading executes design-time `Compile`/`CoreCompile` targets in a separate BuildHost process; custom tasks may run. | P02-T02 could execute project-controlled code before source changes; process separation is not a sandbox. | Before loading, show an extension-owned confirmation that names the design-time target/task risk. If declined, use syntax-only Roslyn parsing, bounded text search, and available editor-provider results; mark semantic references unresolved. Test target execution only with the controlled fixture. | Plan/implementation |
| High | Implementation gate | Running builds/tests or invoking selected code can execute project-controlled behavior; Workspace Trust is not a general sandbox for extension tools. | Behavior capture may expose the developer environment to project side effects. | Restrict the first runner to controlled sample fixtures; require explicit execution approval and define isolation before generalizing. | Plan/implementation |
| Medium | Implementation gate | The exact Foundry endpoint and Entra audience/auth route depend on the selected endpoint family; current official sources document different scopes. | A generic auth implementation may fail against the eventual deployment. | Choose the endpoint family in planning and follow its current authentication documentation; keep credentials out of tracking artifacts. | User/environment before live invocation |
| Medium | User decision | Sending repository source to a Foundry deployment is a source-data transfer. | Organizational policy may restrict which source code can leave the workstation or tenant boundary. | Confirm the applicable data-handling posture before invoking the model on any non-demo project. | User before live invocation |

## Planning Readiness and Next Step

| Field | Record |
| --- | --- |
| Research disposition | Executed, synthesized; ready with an implementation trust prerequisite |
| Decision participation | Agent-owned, automatic RPI Agent context |
| Planning Readiness | Ready with prerequisite: P02-T02 must implement the MSBuild confirmation and declined-consent fallback before invoking `MSBuildWorkspace` on arbitrary projects. |
| Research depth and helpers | Cycle 1 and Cycle 2 Wider, Deeper, Contrarian complete; no helper used. |
| Blockers | P02-T02 must implement the extension-owned MSBuild load confirmation and declined-consent fallback before opening projects. Endpoint-specific authentication and permission to send non-demo source remain separate prerequisites before live model invocation. |
| Output mode and planning support | Convergence; supports P02-T02 with the trust prerequisite recorded in the implementation plan. |
| Continuation owner | Active RPI Agent |
| Required gates or confirmations | Implement and test the MSBuild load confirmation, cancellation path, and syntax-only fallback before invoking `MSBuildWorkspace` on an arbitrary project. |
| Next action | Resume P02-T02 by implementing the confirmation gate first; test loading only against the controlled pizza fixture. |
| Primary evidence file | .copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md; date source: current system date. |

## Research Record

### Method and Boundaries

| Field | Record |
| --- | --- |
| Research posture and provenance | Focused; bounded technical PoC with named stacks and open implementation questions. |
| Completion basis | Complete required three-wave cycles, support material claims with official/current docs and workspace evidence, challenge the first approach, and resolve or honestly list material unknowns. |
| Explicit limits or deadline | Read-only research; no source edits, cloud provisioning, or credentials. Java and production/user-demand validation are out of scope. |
| Codebase and external scope | HVE Core agent/extension patterns and current DT artifacts; official VS Code, .NET/Roslyn, Node/TypeScript, and Microsoft Foundry documentation. |
| Initial candidate areas | Existing extension/, .github/agents/, .github/skills/, official VS Code language-provider/API docs, Roslyn Workspaces docs, Node/TypeScript language-service docs, Foundry inference API docs. |
| Evidence root | .copilot-tracking/research; codebase root .copilot-tracking; date source: current system date 2026-10-07; path .copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md. |
| Constraints and excluded sources | Supplied project folder only for project code; exclude secrets and external user-project code; no Foundry resource or deployment operations. |
| Prior knowledge | Read user-approved Method 1 scope artifacts and current Method 7a state; this is a user-directed early research kickoff, not a standard DT exit tier. Earlier VS Code/Roslyn documentation claims will be revalidated at source. |

### Extensions and Participation

#### Extension Registry

| Kind | Candidate | Provenance and scoped contract | Selected or skipped reason |
| --- | --- | --- | --- |
| instruction | copilot-tracking-location.instructions.md | Applies to tracking files; establishes repository-root location and ignored-file handling. | Selected; governs artifact path. |
| instruction | copilot-tracking.instructions.md | Applies to .copilot-tracking/research/**; requires one primary research artifact and plain paths in research files. | Selected. |
| instruction | markdown.instructions.md / writing-style.instructions.md | Applies to Markdown authoring. | Selected for the primary artifact. |
| instruction | licensing-posture.instructions.md | Applies to tracking artifacts; paraphrase external documentation. | Selected. |
| skill | `dt-rpi-integration` | Supplies context for user-directed DT-to-RPI research start. | Selected; partial/non-standard handoff is explicit. |
| skill | `dt-methods` Method 7 | Current technical-prototype coaching context. | Selected for current Method 7a boundaries. |
| skill | `microsoft-foundry` / `vscode-microsoft-foundry` | Foundry hosted-agent creation, deployment, and testing workflows. | Skipped for this research cycle; no hosted Foundry agent, resource, deploy, or invoke operation is requested. |

#### Direction and Participation Log

| Checkpoint or change | Question, direction, or rationale | Answer or no-interaction reason | Result and revalidation effect |
| --- | --- | --- | --- |
| Intake | User asked to continue the DT work through `rpi-research`, validate evidence, and close implementation unknowns. | Explicit user direction. | Run focused research; preserve Methods 2–6 as skipped and real-user validation as out of scope. |
| Intake | Which target comes first? | User selected .NET pizza eligibility. | First technical slice is .NET 10; Node transfer is the second demo. |
| Intake | What execution and host assumptions apply? | VS Code agent, workspace tools, Foundry API call; project path and function/class supplied; search restricted to project root. | Research these constraints; do not provision resources. |

### Research Cycle Log

#### Cycle 1

* Active posture, controls, and limits: Focused. Keep project code evidence inside HVE Core and the user-provided PoC scope; external evidence from official docs only.

##### Wave 1: Wider

* Focus and questions: Locate current VS Code command/API reference for language providers; Roslyn Workspaces and MSBuild workspace docs; JavaScript/TypeScript reference and call hierarchy support; current Foundry inference API; workspace search and execution boundaries.
* Evidence: W1-W11 and C1-C3 establish the editor command surface, language-support baselines, Roslyn solution model, Foundry v1 endpoint/auth options, custom-agent tool boundary, workspace file-search primitives, and absence of a runtime implementation in the current HVE extension folder.
* Reflection: The hybrid has a grounded shape. VS Code extension tools provide direct access to editor commands and workspace APIs; MCP remains an alternative where portability or remote hosting matters. Neither supplies root confinement automatically. Wider is complete at the documented-capability level; proceed to version-specific and trust-boundary evidence.

##### Wave 2: Deeper

* Focus and questions: Validate exact .NET/Node provider pathways, project-loading/setup prerequisites, target-root restrictions, and Foundry auth/request contracts.
* Evidence: W12-W16 confirm the .NET 10 MSBuild package and reference API, TypeScript reference/call-hierarchy provider source and version gating, VS Code execution-trust limits, and extension-contributed agent packaging. W6-W7 confirm the Foundry request shape but show that exact Entra scope should follow the endpoint family; C4-C5 confirm the project-root, approval, and HVE plugin-root constraints.
* Reflection: Roslyn plus `SymbolFinder` is the strongest first-slice caller-discovery path; TypeScript references/call hierarchy can be exercised as an installed-provider capability. The custom agent can be bundled inside the new extension, avoiding HVE root `.github` membership. Root-boundary and execution tests remain planned gates.

##### Wave 3: Contrarian

* Focus and questions: Test whether provider discovery can be relied on in a custom agent, whether simple text search or direct Roslyn/TypeScript analysis is more reliable, and whether code execution adds risk or non-repeatability.
* Evidence: W12-W16 and C4-C5 challenge completeness, packaging, and safety: symbol references are not a complete dynamic call graph; workspace paths must be constrained by tool code; arbitrary project execution has no generic sandbox guarantee; tests/replays cover only sampled behavior. Extension `contributes.chatAgents` provides a bundled-agent path outside HVE's `.github` plugin root.
* Reflection: The initial approach survives with narrower claims and stronger tool boundaries. Use extension-contributed agent/tools, language-aware results as primary static evidence, bounded text search as a complementary signal, and explicit unknowns for dynamic edges. Keep arbitrary project execution outside the first demo; use controlled fixtures and treat source-data egress as a prerequisite. Remaining uncertainties have bounded acceptance checks or explicit prerequisites.

##### Synthesis and Re-entry

| Material or claim | Evidence | Disposition | Rationale | User-facing effect |
| --- | --- | --- | --- | --- |
| Initial technical direction: VS Code agent, Roslyn for .NET, workspace search and language-aware providers, Foundry API. | W1-W16, C1-C5 | Retained with constraints | Sources support a bundled extension-contributed agent/tool runtime; project-root enforcement, controlled execution, provider readiness, and endpoint auth must be tested or configured. | Recommend planning with explicit gates. |
| Claim that the agent can produce a complete call graph or prove behavior equivalence. | W12-W15, C4 | Rejected | Static provider results and representative tests do not cover every dynamic path or input. | Report bounded evidence and unknowns; avoid completeness claims. |
| Claim that the PoC must add an agent to HVE Core's root plugin membership. | W16, C5 | Rejected | VS Code can bundle the `.agent.md` through the extension contribution point, and HVE plugin discovery is scoped to tracked root `.github` paths. | Keep the demo isolated from the HVE plugin catalog. |

-* Another complete three-wave cycle needed: no; Cycle 2 closed Q8 with a consent boundary and lower-fidelity fallback.
-* Trigger or stop basis: Version-pinned Roslyn source confirms the target execution path; comparison retained syntax-only/editor-provider alternatives without executing arbitrary projects.
-* Readiness or revalidation effect: Research is ready for P02-T02 only if the implementation adds confirmation before MSBuild loading and tests only with the controlled fixture.

#### Cycle 2

* Active posture, controls, and limits: Focused and read-only. Answer Q8 only; do not run project targets or broaden into general sandbox design.

##### Wave 1: Wider

* Focus and questions: Locate official documentation for Roslyn MSBuildWorkspace loading, MSBuild design-time builds, and project imports/targets that may execute during loading.
* Evidence: W17-W19 establish that `ProjectCollection.LoadProject` evaluates project-file source; MSBuild project files import `.props`/`.targets`, and executable tasks are run from targets; `ProjectCollection.IsBuildEnabled` is a security control that prevents `Project.Build` when false. The dedicated design-time build docs and MSBuildWorkspace API pages returned 404 in this fetch pass.
* Reflection: The project-load path has an execution boundary worth treating as high risk, but these sources do not show whether Roslyn invokes targets or sets `IsBuildEnabled`. Deeper should inspect the exact Roslyn implementation and any documented host controls; no arbitrary project will be executed.

##### Wave 2: Deeper

* Focus and questions: Determine the evaluation behavior of the planned solution/project load path, available controls, and which claims are documented versus assumed.
* Evidence: W20-W22 verify against the exact Roslyn 5.9.0 source commit that `OpenSolutionAsync` uses the project loader and a BuildHost manager; the BuildHost sets design-time properties, skips compiler execution and dependent-project builds, then invokes `Compile` and `CoreCompile`; the manager starts a distinct process. `IsBuildEnabled` is not set in this inspected loading path.
* Reflection: The loading risk is confirmed, but process separation is not a sandbox and does not remove project-controlled target hooks. The right boundary is explicit confirmation before arbitrary MSBuild loading, with an honestly lower-fidelity syntax/text/provider fallback. A controlled fixture is sufficient for the PoC validation; no arbitrary project targets were run.

##### Wave 3: Contrarian

* Focus and questions: Compare MSBuildWorkspace loading with editor-provider-only analysis and syntax-only Roslyn parsing as safer but lower-fidelity alternatives. Do not execute an arbitrary project to probe its targets.
* Evidence: W20-W22 establish that the MSBuild route can execute design-time targets; W4-W5 and W12 establish Roslyn syntax/workspace APIs; W1, W9, W11, and W13 establish editor-provider and bounded workspace alternatives. No source or arbitrary targets were executed.
* Reflection: The initial MSBuild-first path is retained only behind a clear consent step and controlled-fixture scope. Syntax-only parsing plus bounded search and editor-provider results is the safer declined-consent path, but it cannot claim semantic project references. This resolves Q8 without broadening into general sandbox research.

##### Synthesis and Re-entry

| Material or claim | Evidence | Disposition | Rationale | User-facing effect |
| --- | --- | --- | --- | --- |
| P02-T02 can load arbitrary user projects without an additional trust boundary. | W17-W22 | Rejected | Roslyn 5.9.0 executes design-time targets in a separate BuildHost process; project custom tasks may run, and no sandbox guarantee was established. | Add extension-owned confirmation before arbitrary project loading; use syntax-only/text/provider fallback when declined. |
| Roslyn MSBuild Workspace must be removed from the PoC entirely. | W4-W5, W12, W20-W22 | Rejected with conditions | Roslyn remains the selected .NET semantic analysis path, but loading is a project-code execution boundary rather than a passive read. | Keep it behind consent and test it only against the controlled pizza fixture during the PoC. |

### Evidence Log

* Helpers: none used.

| ID | Claim or finding | Source or location | Retrieved and version | Tool | Confidence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| W8 | Workspace `.agent.md` files configure an agent's instructions and tool set; available tools depend on the harness and tool availability. | https://code.visualstudio.com/docs/copilot/customization/custom-agents | 2026-10-07; page metadata 2026-09-30 | fetch_webpage | High | An agent file is a declarative role configuration, not an executable plugin runtime. |
| W9 | VS Code extension tools execute implementation code and can call editor APIs; MCP is an alternative for portable, remote, or VS Code-independent tools. VS Code API provides `workspace.findFiles`, `RelativePattern`, and `workspace.fs`. | https://code.visualstudio.com/api/extension-guides/ai/tools; https://code.visualstudio.com/api/references/vscode-api | 2026-10-07; API page metadata 2026-02-04 | fetch_webpage | High | Supplied-root validation and URI filtering are implementation responsibilities. |
| W10 | Agent tools are selected from enabled built-in, extension, and MCP tools; execution uses the client while connected, and approvals remain separate from availability. | https://code.visualstudio.com/docs/agents/run/tools | 2026-10-07; page metadata 2026-09-30 | fetch_webpage | High | Tool availability and terminal approval controls vary by harness/settings. |
| W11 | Built-in commands can invoke reference, document-symbol, and call-hierarchy providers. | https://code.visualstudio.com/api/references/commands | 2026-10-07; page metadata 2026-09-30 | fetch_webpage | High | Use command IDs through extension command APIs; provider semantics still require validation. |
| W12 | Current `Microsoft.CodeAnalysis.Workspaces.MSBuild` 5.9.0 targets .NET 10 and requires a language workspace package; `SymbolFinder.FindReferencesAsync` has solution-wide and document-subset overloads. | https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild; https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findsymbols.symbolfinder.findreferencesasync?view=roslyn-dotnet-5.3.0 | 2026-10-07; NuGet package v5.9.0 and Roslyn API docs v5.3.0 default (v5.9.0 also listed) | fetch_webpage | High | The `MSBuildWorkspace.OpenSolutionAsync` API page fetch returned 404; exact load call still needs verification. |
| W13 | VS Code's built-in TypeScript extension implements references via tsserver `references` and call hierarchy via tsserver `prepareCallHierarchy` and incoming/outgoing call requests, with version/semantic-capability gates. | https://raw.githubusercontent.com/microsoft/vscode/main/extensions/typescript-language-features/src/languageFeatures/references.ts; https://raw.githubusercontent.com/microsoft/vscode/main/extensions/typescript-language-features/src/languageFeatures/callHierarchy.ts | 2026-10-07; VS Code main branch snapshot | fetch_webpage | High | Mutable branch; confirms implementation at retrieval, not a release-specific provider version. |
| W14 | tsserver supports configured, external, and inferred projects; `jsconfig.json` defines the JavaScript project root/files and include/exclude scope. | https://github.com/microsoft/TypeScript/wiki/Standalone-Server-(tsserver); https://code.visualstudio.com/docs/languages/jsconfig | 2026-10-07; wiki last edited 2023-08-01 and VS Code page metadata 2026-09-30 | fetch_webpage | High | Inferred project boundaries differ from explicit project configuration. |
| W15 | Workspace Trust restricts agent/terminal/task/debug execution; agent sandboxing is Experimental on Windows and documented for agent-executed terminal commands. | https://code.visualstudio.com/docs/agents/run/security; https://code.visualstudio.com/docs/editor/workspace-trust | 2026-10-07; page metadata 2026-09-30 | fetch_webpage | High | Does not establish sandboxing for extension-contributed tool code. |
| W16 | VS Code extensions can contribute a custom agent by pointing `contributes.chatAgents` to an `.agent.md` file inside the extension root. | https://code.visualstudio.com/api/references/contribution-points | 2026-10-07; page metadata 2026-09-30 | fetch_webpage | High | Bundles the demo agent with the standalone extension without a workspace `.github/agents` file. |
| W17 | Loading a project through `ProjectCollection.LoadProject` evaluates the project-file source with the collection's global properties and toolset. | https://learn.microsoft.com/en-us/dotnet/api/microsoft.build.evaluation.projectcollection.loadproject?view=msbuild-18-netcore | 2026-10-07; MSBuild API docs v18 | fetch_webpage | High | Establishes evaluation behavior for MSBuild project loading generally, not Roslyn's exact call path. |
| W18 | `ProjectCollection.IsBuildEnabled` defaults the build-enabled state for projects and is intended as a host security control; false prevents `Project.Build`. | https://learn.microsoft.com/en-us/dotnet/api/microsoft.build.evaluation.projectcollection.isbuildenabled?view=msbuild-18-netcore | 2026-10-07; MSBuild API docs v18 | fetch_webpage | High | No evidence yet that Roslyn MSBuildWorkspace sets or honors this property during load. |
| W19 | MSBuild project files import `.props`/`.targets`; target execution can invoke tasks, and custom tasks may load managed assemblies. | https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild?view=visualstudio; https://learn.microsoft.com/en-us/visualstudio/msbuild/target-build-order?view=visualstudio; https://learn.microsoft.com/en-us/visualstudio/msbuild/usingtask-element-msbuild?view=visualstudio | 2026-10-07; docs updated 2025-12-05, 2025-05-01, 2025-12-16 | fetch_webpage | High | Describes project extensibility and execution semantics; does not establish Roslyn load-time target invocation. |
| W20 | Roslyn 5.9.0's `ProjectBuildManager` sets `DesignTimeBuild=true`, disables dependent-project builds and compiler execution, and invokes the `Compile`/`CoreCompile` targets plus an optional markup target. | https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Workspaces/MSBuild/BuildHost/Build/ProjectBuildManager.cs | 2026-10-07; Roslyn source commit 35d9211b841e7613c1d2f8f5af6d628ace696c4c | fetch_webpage | High | Exact package-aligned implementation evidence; the inspected path uses `BuildManager`, not `Project.Build`, and does not set `ProjectCollection.IsBuildEnabled`. |
| W21 | Roslyn 5.9.0's `MSBuildWorkspace.OpenSolutionAsync` delegates to `MSBuildProjectLoader`, which creates a `BuildHostProcessManager` for project loading. | https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Workspaces/MSBuild/Core/MSBuild/MSBuildWorkspace.cs; https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Workspaces/MSBuild/Core/MSBuild/MSBuildProjectLoader.cs | 2026-10-07; Roslyn source commit 35d9211b841e7613c1d2f8f5af6d628ace696c4c | fetch_webpage | High | Confirms the solution-load call path and BuildHost manager use. |
| W22 | Roslyn 5.9.0's `BuildHostProcessManager` launches the BuildHost with `Process.Start`; this establishes process separation but not OS sandboxing. | https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Workspaces/MSBuild/Core/MSBuild/BuildHostProcessManager.cs | 2026-10-07; Roslyn source commit 35d9211b841e7613c1d2f8f5af6d628ace696c4c | fetch_webpage | High | Source shows process creation and RPC setup; no sandbox guarantee is inferred. |
| C3 | Existing DT Coach declares built-in VS Code tools in agent frontmatter and handles orchestration in Markdown; no Roslyn or direct Foundry runtime is present in this agent definition. | .github/agents/design-thinking/dt-coach.agent.md | not applicable | read_file | High | Illustrates local agent authoring convention, not an implementation precedent for custom runtime tools. |
| C4 | User-approved project scope requires caller/test/doc/run discovery only under the supplied project folder and exact approval before source edits. | .copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md | not applicable | read_file | High | Research must preserve this boundary; no product code is authorized for edits. |
| C5 | HVE plugin synchronization reads tracked paths under repository-root `.github` and classifies package-scoped agent paths there. | scripts/plugins/Sync-PluginManifest.ps1, Get-TrackedPluginIndex and Get-TrackedPluginFile | not applicable | read_file | High | An agent bundled under `demos/.../extension/agents` does not enter root plugin membership. |

### Artifact Self-Check

* [x] User-facing sections are complete and understandable without the Research Record.
* [x] All questions map to evidence-backed findings or the smallest open gap.
* [x] Wider, Deeper, and Contrarian waves and reflections are complete.
* [x] Scope, authority, extensions, participation, and the early DT handoff status are accurate.
* [x] Planning Readiness, blockers, disposition, and next action are evidence-based.
* Checked sections: executive summary, findings, recommendation, scope, question mapping, decisions, risks, three-wave cycle, synthesis, readiness, and evidence log.
* Missing or limited sections: endpoint-specific auth, permission to send non-demo code, root-boundary behavior, installed-provider readiness, and controlled execution remain implementation or user/environment prerequisites.
