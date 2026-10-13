---
title: npm Dependency Demo
description: Separate order-summary CLI for a combined technical-debt and npm registry, deprecation and published advisory demonstration.
ms.date: 2026-10-13
---

## Purpose

A small local order-summary CLI uses lodash to group and total fictional orders, and mkdirp to create
a temporary folder for its JSON summary. Its `formatOrderCount` helper has an intentional redundant
`else` after `return`, giving the source review a concrete, behavior-preserving readability opportunity
to assess. The app output should remain unchanged if that suggestion is applied. It is completely
separate from the banking fixture: no banking source, harness, pins or before/after snapshots are reused.

> [!WARNING]
> These dependencies are deliberately outdated, and lodash 4.17.20 has published advisories. `mkdirp@0.5.1` is explicitly deprecated by npm, which recommends the newer 1.x API. Use only a disposable local copy with the supplied fictional data. Do not deploy this sample, use sensitive input, expose it as a service, or treat its dependencies as production recommendations.

The app has no server, credentials or application network requests. npm restore and approved metadata lookups use the network. The dependency assessment itself does not install dependencies or run the app.

## What To Showcase

* `lodash@4.17.20` shows an older version, published latest comparison and OSV advisory GHSA-35jh-r3h4-6jhm.
* `mkdirp@0.5.1` shows explicit npm deprecation and a clear newer release line; its API changed in 1.x, so a newer version is a review candidate, not a compatibility guarantee.

Public records were checked on 2026-10-13. [OSV GHSA-35jh-r3h4-6jhm](https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm)
lists npm lodash versions below 4.17.21 as affected, with 4.17.21 as an advisory-reported fix.
[npm mkdirp 0.5.1 metadata](https://registry.npmjs.org/mkdirp/0.5.1) explicitly marks that version
deprecated and recommends 1.x; the current stable release is 3.0.1. Registry latest, advisory revisions
and service availability may change; do not promise a fixed number of matches or a guaranteed-safe upgrade.

Both direct dependencies are exact pins. A newer registry latest can therefore be outside the declared range; the highest in-range candidate is not automatically newer. The lock also records mkdirp's transitive dependency for exact-version advisory coverage.

## Step-By-Step Demo

### 1. Create A Clean Disposable Copy

Use Node.js 24 or later, VS Code 1.140 or later and GitHub Copilot Chat. Run from the repository root:

Restore the extension only for first-time setup or after its lockfile changes. Skip this command
when its dependencies are already installed. PowerShell waits for npm to finish; this installs
the extension runtime, not the sample app:

```powershell
npm.cmd --prefix demos/legacy-codebase-transformation/extension ci --ignore-scripts --registry=https://registry.npmjs.org/ --no-audit --no-fund
```

For each demo, create a new copy and launch the current extension:

```powershell
$samplePath = (Resolve-Path "demos/legacy-codebase-transformation/fixtures/npm-dependency-demo").Path
$demoRoot = Join-Path $env:TEMP ("npm-dependency-demo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $demoRoot | Out-Null
Copy-Item -Path "$samplePath/package.json", "$samplePath/package-lock.json", "$samplePath/.npmrc", "$samplePath/README.md" -Destination $demoRoot
Copy-Item -Path "$samplePath/src", "$samplePath/data" -Destination $demoRoot -Recurse
$extensionPath = (Resolve-Path "demos/legacy-codebase-transformation/extension").Path
code --extensionDevelopmentPath="$extensionPath" "$demoRoot"
```

This copies only the sample files, not node_modules or banking content. Open the new temporary app folder itself, not the repository or the parent fixtures directory.
Use this newly created folder for each run rather than reopening an earlier temporary copy. Before scanning, confirm its `src/index.js` contains the `formatOrderCount` helper; its redundant `else` is the seeded readability finding.

### 2. Optionally Run The App

Dependency assessment needs only the manifest and lock, so this step is optional. To show the working CLI first, use the same PowerShell session where demoRoot was set:

```powershell
npm.cmd --prefix "$demoRoot" ci --ignore-scripts --registry=https://registry.npmjs.org/ --no-audit --no-fund
npm.cmd --prefix "$demoRoot" start
```

The deprecation warning for mkdirp is expected. Automatic npm audit is disabled for this optional restore so the presentation uses the separate, explicitly approved assessment report. No install lifecycle scripts run. This does not declare the fixture secure.

Expected app output:

```text
Order Summary
North: 2 orders, $55.45
South: 2 orders, $56.50
Total: 4 orders, $111.95
```

The CLI also writes `order-summary.json` to `path.join(os.tmpdir(), 'npm-dependency-demo')`.

The banking-only check_behavior tool does not support this app. Running this CLI manually is not behavior-equivalence verification.

### 3. Prepare One Combined Review

In the new development host, select Codebase-Level Legacy Code Transformation Agent, start a new chat and ask:

```text
Review technical debt and npm dependency recommendations in this exact workspace; show the combined sharing preview and wait.
```

This is the single request for both analyses. It prepares the source scan with `includeDependencies`
enabled and presents one combined sharing preview. After you approve both the source and metadata
disclosures in a later reply, the agent analyzes the code and dependencies and produces one combined
report. You do not need a separate dependency-analysis prompt. A source-only request still excludes
dependency assessment.

Preparation should report awaiting-decision with zero source-model and metadata requests. Review
the source-sharing disclosure and the nested dependency disclosure: exact root, file hashes, gaps,
every identifier, destination/payload details and limits. For the supplied unchanged lock, the outbound
registry names are lodash and mkdirp, plus mkdirp's locked transitive dependencies; the exact OSV tuples are:

* lodash 4.17.20
* mkdirp 0.5.1
* minimist 0.0.8

The runtime preview is authoritative. Do not approve undisclosed additions or a different workspace. Metadata lookups can disclose architecture even when package names look public.

### 4. Demonstrate Decline

Reply in a later chat turn:

```text
Reject this combined source and dependency metadata-sharing preview.
```

Expect cancelled with zero source-model and metadata requests. That preview is consumed and cannot later be reused.

### 5. Prepare Again And Approve

Repeat the preparation request, review the new exact outbound set, then reply in a later turn:

```text
Approve both the displayed source transfer and npm/OSV metadata transfers in this combined preview, for the displayed files and identifiers only.
```

Only this explicit combined approval permits both the source-model requests and public npm/OSV
lookups. Approval for source alone, writes or tests does not substitute for metadata approval.
Previews expire after five minutes; changed or dirty source/metadata requires fresh preparation.

### 6. Inspect The Combined Report

Open the saved codebase-review report. It contains source findings and a Dependency Recommendations
section with declared pins and exact lock provenance, registry latest and range caveats, mkdirp
deprecation, provider-returned lodash advisory IDs and fixes, service timestamps, actual request
counts and snapshot validity. The report also proposes every eligible direct version update
automatically, with before/after `package.json` snippets; you do not list package names in the initial
request. Source findings are model-dependent and may be empty; dependency evidence still appears.
The normal first-page metadata lookup set is two registry reads and four
advisory queries; pagination or failures can change the observed count/status. Source requests are
counted separately. Excluded files and source coverage gaps can leave overall status incomplete
even when the dependency section completes.

Unavailable services or incomplete evidence must remain unknown/incomplete. Advisory fixes are cited observations, not automatic upgrade targets. Matching a published advisory does not prove exploitability in this CLI; no matches is not security approval. Candidate advisories, installation compatibility and application behavior are not verified by the assessment. Assessment itself applies no source or dependency edits.

### 7. Preview A Selected Version Update

If the report offers direct update candidates, approve all of them or a subset in one reply. For example:

```text
Prepare all direct dependency updates proposed in this report; show one public npm resolution preview and wait.
```

The agent should batch the report's selected package/version proposals into one update request; you do
not need to prompt once per package. To choose a subset, name those proposals together in one reply.
Review the current and selected versions, file hashes, public-registry disclosure and transitive-metadata
warning. Approve or reject resolution in a later reply. On approval, npm runs in a disposable copy with
scripts and audit disabled; it does not install packages or run project tests. Review both opened VS Code
diffs, including transitive lock changes, before separately approving application to the project.
Candidate advisories and compatibility are not checked. Deprecated-package replacements that require
source/API migration remain advisory-only.

If resolution fails, inspect the returned npm exit/error codes if available. A generic exit code does
not mean the selected version is unpublished; the cause may be network, npm configuration, integrity
or unresolved. The preview is one-use. A retry needs fresh preparation and approval.

### 8. Reset

Close the demo window and repeat step 1 to get a new disposable copy. Keep the committed pins and lock unchanged; do not run npm update or npm audit fix on the fixture to remove the evidence. This procedure is not a claim that live registry/OSV assessment or native UI rehearsal has passed.
