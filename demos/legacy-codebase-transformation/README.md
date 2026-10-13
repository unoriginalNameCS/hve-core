---
title: Legacy Codebase Transformation Demo
description: Review a codebase for refactoring opportunities and outdated npm dependencies in one report, then apply it after approval.
---

## Run The Demo

Prerequisites: VS Code 1.140 or later, GitHub Copilot Chat, an available tool-capable model, and Node.js 24 or later.

From the repository root, run these commands in PowerShell:

```powershell
npm.cmd --prefix demos/legacy-codebase-transformation/extension ci --ignore-scripts --registry=https://registry.npmjs.org/
$sample = (Resolve-Path "demos/legacy-codebase-transformation/fixtures/npm-dependency-demo").Path
$demo = Join-Path $env:TEMP ("npm-dependency-demo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $demo | Out-Null
Copy-Item "$sample/package.json", "$sample/package-lock.json", "$sample/.npmrc" -Destination $demo
Copy-Item "$sample/src", "$sample/data" -Destination $demo -Recurse
$extension = (Resolve-Path "demos/legacy-codebase-transformation/extension").Path
code --new-window --extensionDevelopmentPath="$extension" "$demo"
```

In the new window, confirm the title shows `npm-dependency-demo-...`. Open Copilot Chat, select **Codebase-Level Legacy Code Transformation Agent**, and send:

```text
Review and transform this codebase.
```

Read the report, then reply `approve` to apply its plan or `reject` to leave the code unchanged. To run again, close the window and repeat the commands to create a fresh copy.

The sample demonstrates a readability refactor and deprecated or vulnerable npm dependencies. Major dependency updates may require API changes. Review the report before approving. Tests are out of scope and are not run.
