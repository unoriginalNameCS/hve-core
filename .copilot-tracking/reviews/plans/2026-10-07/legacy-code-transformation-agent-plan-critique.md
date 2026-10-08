<!-- markdownlint-disable-file -->

# RPI Plan Critique: Legacy Code Transformation Agent PoC

## Metadata

* Task ID: RPI-LCTA-2026-10-07
* Critique date: 2026-10-07
* Plan: .copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md
* Critique execution: Complete
* Critique depth: standard
* Depth provenance: default
* Critique type: initial
* Earlier critique: not applicable

## Inputs and Criterion Boundary

* Task context and caller requirements: User-directed technical feasibility PoC, .NET 10 pizza slice first, Node.js 24.19 transfer second, exact approval before source edits, and project-root-bounded discovery.
* Research and evidence considered: .copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md; .copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md.
* Decisions, dependencies, task Goals, and task Requirements considered: Plan decisions D1-D5, FR-001 through FR-007, NFR-001 through NFR-004, phases P01-P04, task requirements and risks.
* Assessment boundary: Assess plan credibility against supplied research and confirmed DT scope. No new research or source-code inspection was performed.

## Coverage Assessment

| Requirement, research, phase, or task ID | Coverage | Evidence or concern |
| --- | --- | --- |
| FR-001 through FR-007 | Covered with findings | Intake, bounded discovery, report, Foundry adapter, approved apply, replay, and Node slice are sequenced in P01-P04. |
| NFR-001 through NFR-004 | Partial | Root boundary, secrets, replay, and proposal binding are present; the approval interaction needs protection from tool auto-approval behavior. |
| P01 and P02 tasks | Covered | Baseline fixture, workspace path, Roslyn analysis, report, and source-data gates are linked to research. |
| P03-T01 | Partial | Proposal ID/hash and confirmation are required, but the plan does not distinguish a mandatory extension-owned approval prompt from tool-call confirmation that can be auto-approved. |
| P03-T02 and P04 | Covered | Controlled .NET replay and later Node provider/state-reset work are scoped and ordered. |
| Research Q4/Q5 and D3 | Partial | The D3 decision selects API-key SecretStorage for the PoC, while a risk row still says the API-key route is unspecified. |

## Verdict

* Verdict: Revise
* Rationale: The phase structure is implementable and preserves the research boundaries, but the central approval requirement needs an explicit human confirmation mechanism that cannot be satisfied solely by tool-call auto-approval. One risk row also contradicts the resolved Foundry auth choice.

## Findings

<!-- rpi:critique id=PC-001 -->
### PC-001 [High]: Bind the apply gate to explicit human approval

* Related IDs: FR-005, NFR-002, P03-T01
* Evidence: .copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md; .copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md
* Concern: The plan requires a tool confirmation showing the edits, but does not say that the apply tool itself must obtain an explicit confirmation independent of agent-tool permission settings. VS Code tool approvals can be configured or auto-approved, so the confirmation may not always represent review of this specific report.
* Impact: The core no-edit-before-approval requirement could be bypassed by an agent/tool permission configuration, or a stale proposal could be applied after the user reviewed a different report.
* Smallest useful change: Require the apply operation to present an extension-owned confirmation bound to the proposal ID, source hashes, and exact diff on every application. Cancel must leave every source file unchanged. Test approval, cancel, changed proposal, and changed source cases.
* Action owner: Planning parent
* Exact resolving evidence: P03-T01 Requirements and Details specify the independent confirmation and the four corresponding tests; critique disposition records the updated plan section.
* Decision route: Direct planner correction

<!-- rpi:critique id=PC-002 -->
### PC-002 [Medium]: Reconcile the Foundry authentication risk with D3

* Related IDs: D3, FR-004, P02-T03
* Evidence: .copilot-tracking/plans/2026-10-07/legacy-code-transformation-agent-plan.md
* Concern: D3 resolves the PoC adapter to API-key auth in VS Code SecretStorage, while the risks table still lists the Entra/API-key route as unspecified.
* Impact: The implementation handoff does not clearly distinguish the chosen PoC credential mechanism from the endpoint/model configuration that remains unknown.
* Smallest useful change: Update the risk row to state that API-key handling is selected for the PoC; endpoint, model deployment, and source-data permission remain prerequisites for live invocation. Record Entra as out of scope unless endpoint constraints require a new decision.
* Action owner: Planning parent
* Exact resolving evidence: Revised D3 and Risks and Open Questions table agree on the PoC auth path and remaining live-call prerequisites.
* Decision route: Direct planner correction

## Strengths and Residual Risk

* The plan keeps the runtime outside HVE Core's declarative packaging, sequences .NET before Node, and has concrete root, provider, execution, and source-data gates.
* Live Foundry invocation remains unverified until an endpoint/model is configured and the requester confirms source-data permission.

## Questions or Blocking Evidence Gaps

* None. Both findings are planner-owned corrections and need no user decision.

## Limitations

* This standard critique used only the supplied plan, RPI research, and user-approved DT scope. It did not validate actual runtime behavior or render diagrams in light and dark themes.

## Recommended Next Action

* Highest-impact finding: PC-001
* Action owner: Planning parent
* Smallest next action: Revise P03-T01 and the Foundry risk row, then update the plan's critique disposition and readiness.
* User response required: No.
