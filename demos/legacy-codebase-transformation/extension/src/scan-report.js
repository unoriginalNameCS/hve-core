'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function inlineCode(value) {
  const text = String(value);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = /^`|`$|^ | $/.test(text) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function codeFence(value) {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function renderCodeBlock(value, language) {
  const fence = codeFence(value);
  return `${fence}${language}\n${value}\n${fence}`;
}

function languageFor(filePath) {
  return ({ '.cs': 'csharp', '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript',
    '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx' })[path.extname(filePath).toLowerCase()] ?? '';
}

function renderFinding(finding, index) {
  const { startLine, endLine } = finding.range;
  const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  const language = languageFor(finding.path);
  return [
    `### ${index + 1}. ${escapeMarkdown(finding.category)}`,
    '',
    `Finding ID: ${inlineCode(finding.id)}`,
    `File: ${inlineCode(finding.path)}`,
    `Lines: ${lineRange} (proposed replacement span)`,
    `Symbol: ${inlineCode(finding.symbol)}`,
    `Confidence: ${escapeMarkdown(finding.confidence)}`,
    `Review status: ${escapeMarkdown(finding.status ?? 'new')}`,
    '',
    'Rationale:',
    '',
    escapeMarkdown(finding.rationale),
    '',
    'Before:',
    '',
    renderCodeBlock(finding.originalText, language),
    '',
    'After (model suggestion, unverified):',
    '',
    renderCodeBlock(finding.replacementText, language)
  ].join('\n');
}

function renderScanReport(result) {
  const files = [...new Set((result.findings ?? []).map((finding) => finding.path))].sort();
  const findings = result.findings ?? [];
  const sourceStatus = result.sourceStatus ?? result.status;
  const coverage = sourceStatus === 'completed' ? 'All eligible source chunks were reviewed. Unsupported and excluded files are outside this coverage.' :
    sourceStatus === 'incomplete' ? 'Incomplete. Review skipped files, rejected outputs, and unscanned chunks before drawing conclusions.' :
      'No complete scan result is available.';
  const summary = [
    result.dependencies ? '# Codebase Technical Debt And Dependency Report' : '# Codebase Refactoring Scan Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Status: ${escapeMarkdown(result.status)}`,
    ...(result.dependencies ? [
      `Source analysis status: ${escapeMarkdown(sourceStatus)}`,
      `Source snapshot: ${result.sourceSnapshotCurrent ? 'matched at final local check' : 'changed, dirty or unchecked; findings are historical only'}`,
      `Dependency status: ${escapeMarkdown(result.dependencies.status)}; actual HTTP attempts: ${result.dependencies.requests}`
    ] : []),
    'Human review: pending',
    'Source changes: none',
    `Workspace root: ${inlineCode(result.root ?? 'unavailable')}`,
    `Eligible source files inventoried: ${result.files ?? 0}`,
    `Source files fully reviewed: ${result.filesReviewed ?? 0}`,
    `Eligible source bytes: ${result.bytes ?? 0}`,
    `Source bytes included in attempted model requests: ${result.sharedBytes ?? 0}`,
    `Model requests attempted: ${result.requests ?? 0}; source chunks planned: ${result.projectedRequests ?? 0}`,
    `Batch: ${result.batchNumber ?? 1}; requests this batch: ${result.batchRequests ?? result.requests ?? 0}`,
    `Chunks reviewed: ${result.reviewedChunks?.length ?? 0}; chunks remaining: ${result.remainingChunks ?? 0}`,
    `Continuation available: ${result.canContinue === true ? 'yes' : 'no'}`,
    `Scan ID: ${inlineCode(result.scanId ?? 'unavailable')}`,
    `Findings: ${findings.length}`,
    `Files with proposed spans: ${files.length}`,
    `Paths excluded by scan policy (observed): ${result.excluded ?? 0}`,
    `Skipped files or chunks: ${result.skipped ?? 0}`,
    `Rejected model outputs or requests: ${result.rejected ?? 0}`,
    '',
    'Source suggestions are unverified model output. Review the Transformation Plan before approving it. No source or dependency changes have been made, and tests are not run.',
    '',
    '## Proposed File Changes',
    '',
    files.length ? files.map((file) => `* ${inlineCode(file)}: ${findings.filter((finding) => finding.path === file).length} proposed span(s)`).join('\n') : 'No findings were returned.',
    '',
    '## Findings',
    '',
    findings.length ? findings.map(renderFinding).join('\n\n') : 'No findings were returned by this scan.',
    '',
    '## Dependency Recommendations',
    '',
    result.dependencies ? require('./dependency-report').renderDependencyReport(result.dependencies)
      .split('\n').map((line) => /^#{1,3} /.test(line) ? `##${line}` : line).join('\n') :
      'Not assessed. This review did not include npm dependency evidence.',
    '',
    '## Coverage And Limitations',
    '',
    coverage,
    'Excluded by policy: hidden directories, node_modules, vendor, bin, obj, dist, build, coverage, generated, out, and target. First-party packages directories are included. Excluded paths are not guaranteed to be enumerated.',
    '',
    'Unsupported files (not sent to the model):',
    '',
    result.unsupportedFiles?.length ? result.unsupportedFiles.map((file) => `* ${inlineCode(file)}`).join('\n') : 'None inventoried.',
    '',
    'Skipped files:',
    '',
    result.skippedFiles?.length ? result.skippedFiles.map((file) =>
      `* ${inlineCode(file.path)}: ${escapeMarkdown(file.reason)}`).join('\n') : 'None recorded.',
    '',
    'Failed chunks:',
    '',
    result.failedChunks?.length ? result.failedChunks.map((chunk) =>
      `* ${inlineCode(chunk.path)} from line ${chunk.startLine}: ${escapeMarkdown(chunk.reason)}`).join('\n') : 'None recorded.',
    '',
    'Coverage is source-text analysis, not whole-program semantic analysis. Line-based chunks may split functions. Failed or rejected chunks require a fresh scan; exhausting the queue does not make failed analysis complete.',
    'This report contains best-effort, evidence-backed technical-debt suggestions for eligible source. A completed scan means every eligible chunk was reviewed, not that every issue was found. Suggestions do not establish correctness, security, behavior preservation, build success, or test success. Project commands and tests were not run.'
  ];
  return summary.join('\n');
}

async function writeScanReport(reportDirectory, scanId, markdown, batchNumber = 1) {
  if (typeof reportDirectory !== 'string' || !path.isAbsolute(reportDirectory) ||
  typeof scanId !== 'string' || !/^[0-9a-f-]{36}$/i.test(scanId) ||
  !Number.isInteger(batchNumber) || batchNumber < 1) {
    throw new Error('A valid extension storage directory and scan ID are required.');
  }
  await fs.mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `scan-${scanId}-batch-${batchNumber}.md`);
  await fs.writeFile(reportPath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return reportPath;
}

module.exports = { escapeMarkdown, renderScanReport, writeScanReport };
