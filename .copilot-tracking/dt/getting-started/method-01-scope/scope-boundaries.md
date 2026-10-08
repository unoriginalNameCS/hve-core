---
title: "Method 1 Scope Boundaries"
description: "Rough scope boundaries and success criteria for the legacy code transformation agent proof of concept."
---

## Problem and User

A developer inherits a critical function or class after its original author has left the company or project. The code is difficult to understand and maintain, and the current developer needs to improve it without changing its behavior.

The intended user is a developer maintaining .NET or Node projects. The requester is also the report approver and is responsible for reviewing the code explanation and validating behavior. Java support is planned for a later extension, not this PoC.

## In Scope

* The developer provides a path to the project folder and identifies both the target file and the function or class to refactor.
* Analyze and simplify one selected function or class at a time to improve readability and maintainability while preserving its behavior.
* Extract code into another function or class only when the analysis supports that change and the requester approves the exact extraction described in the report.
* Use a Foundry-backed LLM to propose a transformation.
* Create a Markdown report before editing code. Include an analysis-and-discovery section, affected files, and the exact proposed code changes.
* Search only within the provided project folder for callers, existing tests, surrounding code, README files, and other relevant documentation to ground the explanation.
* Use syntax parsing and language-aware reference resolution to find cross-file callers when supported; cite found locations and mark unresolved dynamic references as unknown.
* Run representative inputs against the original function and record observed outputs; label behavior that remains uncertain as unknown.
* Wait for the requester to approve, reject, or request report changes. Approval authorizes only the listed changes; additions require a revised report and fresh approval. No code changes occur before approval.
* After approval, apply only the approved changes. Run existing tests against the original and transformed code, and replay the same representative inputs against both versions to compare outputs and observable behavior.

## Out of Scope

* Migrating the project to another platform or runtime.
* Redesigning the application architecture.
* Applying unapproved changes, including changes outside the selected function or class.

## Success Criteria

* The requesting developer judges the transformed code easier to read and maintain.
* Existing tests pass against the original and transformed code.
* Representative agent-generated inputs produce matching captured outputs and observable behavior before and after transformation. The comparison includes outputs, errors, side effects, and caller-facing behavior.
* The requester approves the exact changes before the agent applies them.

## PoC Examples

The demos use .NET 10 and Node.js 24.19. Java support is deferred until after this PoC.

* .NET console app: pizza discount eligibility implemented in an intentionally very hard-to-read function using deeply nested conditions, duplicated checks, and unexplained constants. Members receive 10% off. Non-members receive the same discount when the order subtotal is at least $50. Otherwise, no discount. Keep this original behavior correct and baseline-tested.
* Node console app: banking operations, including a deliberately hard-to-read `transfer` function. The function transfers a positive amount only when both accounts exist and the source has enough funds. It returns success or failure with a reason. Missing accounts, nonpositive amounts, insufficient funds, and transfers between the same account are rejected without changing either balance.

These examples are demo fixtures, not evidence that the rules represent real customer or banking policies.

## Open Questions

* Which intentionally confusing legacy coding patterns will the Node `transfer` function use?
