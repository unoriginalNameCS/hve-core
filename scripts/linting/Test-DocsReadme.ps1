#!/usr/bin/env pwsh
# Copyright (c) 2026 Microsoft Corporation. All rights reserved.
# SPDX-License-Identifier: MIT

#Requires -Version 7.4

<#
.SYNOPSIS
    Validates that every immediate subdirectory of docs/ contains a README.md.

.DESCRIPTION
    Scans the immediate subdirectories of docs/ and reports any that are
    missing a README.md file. Exits 0 when all subdirectories pass, or 1
    when any subdirectory is missing its README.md.

.PARAMETER DocsPath
    Path to the docs/ directory to validate.

.EXAMPLE
    ./Test-DocsReadme.ps1

.NOTES
    Runs via: npm run lint:docs-readme
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$DocsPath = 'docs'
)

$ErrorActionPreference = 'Stop'

#region Functions

function Test-DocsReadmeCoverage {
    <#
    .SYNOPSIS
    Finds immediate docs/ subdirectories missing a README.md.

    .PARAMETER DocsPath
    Path to the docs/ directory to validate.

    .OUTPUTS
    [string[]] Relative paths of subdirectories missing a README.md.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$DocsPath
    )

    if (-not (Test-Path -Path $DocsPath -PathType Container)) {
        throw "Docs path not found: $DocsPath"
    }

    $subDirectories = Get-ChildItem -Path $DocsPath -Directory
    $missing = @()

    foreach ($directory in $subDirectories) {
        $readmePath = Join-Path $directory.FullName 'README.md'
        if (-not (Test-Path -Path $readmePath -PathType Leaf)) {
            $missing += "$DocsPath/$($directory.Name)"
        }
    }

    return $missing
}

#endregion Functions

#region Main Execution

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $missingReadmes = Test-DocsReadmeCoverage -DocsPath $DocsPath

        if ($missingReadmes.Count -eq 0) {
            Write-Host "✅ All docs/ subdirectories have a README.md" -ForegroundColor Green
            exit 0
        }

        Write-Host "❌ Missing README.md in $($missingReadmes.Count) docs/ subdirectories:" -ForegroundColor Red
        foreach ($path in $missingReadmes) {
            Write-Host "  - $path" -ForegroundColor Red
        }
        exit 1
    }
    catch {
        Write-Error -ErrorAction Continue "Test-DocsReadme failed: $($_.Exception.Message)"
        exit 1
    }
}

#endregion Main Execution
