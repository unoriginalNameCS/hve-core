project:
  name: "Getting Started"
  slug: "getting-started"
  created: "2026-10-06"
  initial_request: "how do I use this?"
  initial_classification: "fluid"

current:
  method: 7
  space: "implementation"
  phase: "7a paused for user-directed RPI Research"
  disclaimerShownAt: "2026-10-06T10:22:52+11:00"

methods_completed: [1]

transition_log:
  - from_method: null
    to_method: 1
    rationale: "Project initialized; begin by clarifying the underlying need."
    date: "2026-10-06"
  - from_method: 1
    to_method: 7
    rationale: "User chose to build the agent workflow as a technical proof of concept using controlled .NET and Node sample apps. Methods 2-6 are deliberately skipped because real-user validation and solution exploration are not the current PoC objective; this path tests technical feasibility only."
    date: "2026-10-06"
  - from_method: 7
    to_method: 7
    transition_type: "lateral-early-handoff"
    handoff_target: "rpi-research"
    rationale: "User requested an early RPI Research start to validate evidence and close implementation unknowns. This is not a standard DT exit tier because Method 7a is incomplete and Methods 2-6 were skipped by user direction."
    date: "2026-10-07"

hint_calibration:
  level: 3
  pattern_notes: "User asked for concrete ideas and then asked the coach to make the pizza-ordering sample more concrete; offer a provisional example and clearly label assumptions."

session_log:
  - date: "2026-10-06"
    method: 1
    summary: >-
      User is building a proof-of-concept legacy code transformation agent for
      developers maintaining .NET or Node projects. The PoC demos use .NET 10
      and Node.js 24.19; Java support is planned for a later extension.
      The intended user is a
      developer inheriting a difficult-to-read, difficult-to-maintain function or
      class after its original author has left the company or project. The agent
      should help bridge that knowledge gap by simplifying individual functions
      or classes for readability and maintainability while preserving original
      behavior. Extracting code into another function or class is allowed only
      when the exact extraction appears in the Markdown report and is approved
      before editing. The use case is critical code that the project depends on, but
      that the current developer does not understand well enough to maintain.
      Markdown report must include an analysis-and-discovery section explaining
      what the selected function or class does, using its callers, existing tests,
      documentation, and representative observed inputs/outputs as evidence,
      alongside every proposed code change, affected file, and specific
      transformation. The Foundry-backed LLM proposes refactors; the requester
      reviews the report and approves, rejects, or requests revisions before any
      code is changed. Approval authorizes only the exact listed changes; any
      additional changes require a revised report and fresh approval. After
      approval, the agent applies only the approved transformation and verifies
      behavior and tests. The agent should transform code only; migration to a
      new platform and architectural redesign are out of scope, with a separate
      application modernization agent owned by another person. Success evidence
      combines the requester reviewing readability and maintainability,
      before-and-after comparisons against captured outputs for representative
      inputs, and passing existing tests. Run existing tests against both the
      original and transformed code. Capture results from representative agent-
      generated inputs against the original, then replay those same inputs
      against the transformed code and compare outputs and observable behavior.
      The behavior contract covers outputs, errors, side effects, and
      caller-facing behavior. For the PoC, the user wants
      two console-app demos: a .NET pizza-ordering app with an eligibility
      evaluator, plus a separate Node banking app with deposit, withdrawal, and
      a deliberately hard-to-read transfer function written in an old style. The
      transfer function is the selected Node refactoring target. Its provisional
      behavior contract is to move a positive amount when both accounts exist
      and the source has sufficient funds; otherwise reject the transfer without
      changing either balance. Return a success/failure result with a reason.
      Rejection cases are unknown source/destination account, nonpositive
      amount, insufficient funds, and source/destination being the same account.
      The .NET pizza eligibility evaluator is also selected: members receive a
      10% discount; non-members receive the same discount when order subtotal is
      at least $50; otherwise no discount. The requesting developer is the
      report approver and handles report review and behavior validation. The
      exact deliberately confusing coding patterns for the samples remain open.
      Method 1 scope, stakeholder roles, and assumptions artifacts were reviewed
      and accepted by the user.
  - date: "2026-10-06"
    method: 7
    summary: >-
      User chose the agent workflow as the PoC build focus and identified the
      analysis-and-discovery explanation in the report as the first technical
      risk to test. The first workflow slice will use the .NET pizza eligibility
      evaluator, whose original function should be intentionally very hard to
      read with deeply nested conditions, duplicated checks, and unexplained
      constants while remaining correct and baseline-tested; the Node banking
      transfer is the second demo. Its exact legacy-style patterns remain open.
      The intended host is a VS Code agent using workspace tools plus a
      Foundry-calling tool. The PoC
      demonstrates the workflow on controlled .NET and
      Node console-app samples; real-user demand validation is not its goal.
      The discovery report should combine surrounding source and README context,
      when available, with outputs captured by running the original code against
      representative sample inputs. The same inputs will be replayed after
      transformation for comparison. The banking demo resets account balances
      before each input run so side effects do not contaminate later results.
      The report should present each case's input, original captured output,
      what that result reveals about the code, and the transformed result side
      by side. The agent searches only inside the supplied project folder for
      callers, tests, surrounding code, README files, and related documentation.
      Java is outside the current
      PoC. The developer supplies a path to the project folder and identifies both the
      target file and function or class; the agent then searches the project
      for related context.
      Explanation claims should cite exact source locations and relevant tests;
      uncertain behavior should be labeled unknown. Caller discovery should use
      syntax parsing plus language-aware reference resolution where available;
      dynamic or unresolved references must be labeled unknown rather than
      represented as a complete call graph. Roslyn Workspaces is selected for
      .NET analysis. Hybrid discovery means language-aware syntax/symbol
      analysis plus bounded workspace text/file search for README, tests, and
      other context. A Foundry API call supplies the LLM step. VS Code exposes
      commands for references and call hierarchy, and built-in JavaScript
      supports reference navigation. Verify provider availability and project
      loading for the PoC's C# and JavaScript setups, and ensure returned
      locations stay within the supplied project root. Roslyn Workspaces remains
      the .NET analysis choice.

artifacts:
  - path: ".copilot-tracking/dt/getting-started/method-01-scope/scope-boundaries.md"
    method: 1
    type: "scope-boundaries"
  - path: ".copilot-tracking/dt/getting-started/method-01-scope/stakeholder-map.md"
    method: 1
    type: "stakeholder-map"
  - path: ".copilot-tracking/dt/getting-started/method-01-scope/assumptions-log.md"
    method: 1
    type: "assumptions-log"
  - path: ".copilot-tracking/dt/getting-started/handoff-summary.md"
    method: 7
    type: "early-rpi-handoff"
  - path: ".copilot-tracking/research/2026-10-07/legacy-code-transformation-agent-research.md"
    method: 7
    type: "rpi-research"

canonical_deck:
  snapshots: []
  last_offered_at: null
  last_offered_response: null
  last_generated_at: null

customer_card_render:
  last_offered_at: null
  last_offered_response: null
  last_generated_at: null
  decline_final: false
  output_path: null
