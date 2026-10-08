<!-- markdownlint-disable-file -->

# User-Directed Early Research Handoff

handoff_type: "user-directed-partial-research-start"
standard_exit_point: null
handoff_status: "early and non-standard; not a completed DT space exit"
dt_method: 7
dt_space: "implementation"
handoff_target: "rpi-research"
date: "2026-10-07"

## Method Status

* Method 1 is complete; its scope, stakeholder, and assumptions artifacts were reviewed and accepted.
* Methods 2-6 were deliberately skipped at the user's direction. Real-user demand validation is not a goal of this PoC.
* Method 7a is in progress. This handoff is to validate implementation evidence and close technical unknowns, not to claim that Methods 2-6 or the normal Method 7 readiness gates are complete.

## Research Topic

Determine a technically feasible VS Code agent workflow for a behavior-preserving refactoring PoC. The first vertical slice is a .NET 10 pizza discount eligibility function. A Node.js 24.19 banking transfer function is the second demo; Java support is deferred beyond the PoC.

## Confirmed Constraints

* The developer provides a path to the project folder and names the target file and function or class.
* Discovery is restricted to the supplied project folder.
* The agent should use Roslyn for .NET analysis, and research available VS Code language features and a hybrid of language-aware references plus workspace search.
* The analysis report reads source, callers, tests, README and other relevant documentation; it runs representative inputs against original code, records outputs, cites exact locations and tests, and labels unknown behavior.
* Every proposed code edit appears in a Markdown report. The requester approves the exact change set before any edit. After approval, replay the same inputs and run tests against the transformed code.
* The PoC's Foundry interaction is an API call. No Foundry resource provisioning is in scope for this research.

## Handoff Artifacts

| Artifact | Confidence | Note |
| --- | --- | --- |
| `.copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md` | assumed | User-approved PoC scope; not validated with real end users. |
| `.copilot-tracking/dt/getting-started/method-01-scope/stakeholder-map.md` | assumed | Stakeholder roles based on the user's description. |
| `.copilot-tracking/dt/getting-started/method-01-scope/assumptions-log.md` | assumed | Contains user-confirmed demo assumptions and unresolved technical items. |
