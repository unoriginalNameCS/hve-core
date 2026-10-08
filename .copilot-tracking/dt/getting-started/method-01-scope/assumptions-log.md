---
title: "Method 1 Assumptions Log"
description: "Known, assumed, and unresolved details for the legacy code transformation agent proof of concept."
---

## Assumptions and Unknowns

| Item | Status | Note |
| --- | --- | --- |
| The PoC supports .NET and Node; Java support is planned later. | Agreed scope | The demos use .NET 10 and Node.js 24.19. Java is not in this PoC. |
| The agent simplifies one selected function or class without migrating platforms or redesigning architecture. | Agreed scope | Proposed code movement or changes outside the selected unit must be listed in the report and approved before editing. |
| The developer provides a project-folder path and names the target file and function or class. | Agreed workflow | Discovery is limited to that folder; the agent searches there for related callers, tests, and documentation. |
| The requester is also the report approver and behavior reviewer. | Agreed for the PoC | A separate reviewer may be needed in a real project. |
| The agent searches the codebase for callers, tests, surrounding code, and documentation to explain the selected code. | Agreed workflow | The report also uses observed outputs from representative inputs; uncertain behavior is labeled unknown. |
| Caller discovery uses syntax parsing and language-aware reference resolution where available. | Agreed technical direction | Report exact locations; mark dynamic or unresolved references unknown rather than claiming a complete call graph. |
| VS Code's built-in reference and call-hierarchy commands can invoke registered language providers. | Research finding | Provider coverage and project-loading behavior must be verified for the C# and JavaScript setups used by the PoC; Roslyn remains the .NET analysis choice. |
| Existing tests run against the original and transformed code; representative generated inputs are replayed against both versions. | Agreed validation approach | The comparisons are evidence of preservation for tested cases, not a proof of equivalence. |
| Pizza discount rules are 10% for members, or 10% for non-members with subtotal at least $50. | Agreed demo behavior | These are sample rules, not validated business policy. |
| Node `transfer` requires existing distinct accounts, a positive amount, and sufficient source funds. | Agreed demo behavior | Failures return a reason and leave balances unchanged. |
| Demo runtimes are .NET 10 and Node.js 24.19. | Agreed for the PoC | Java runtime/version is not selected because Java is not a demo target in this scope. |
| The original .NET eligibility function uses deeply nested conditions, duplicated checks, and unexplained constants while remaining behavior-correct and baseline-tested. | Agreed demo requirement | The Node `transfer` function's exact confusing patterns are still undecided. |
