'use strict';

const { compileFunction } = require('node:vm');
const { chunkSourceFiles, scanPrompt: buildSharedScanPrompt } = require('../../legacy-codebase-transformation/extension/src/workspace-scan');
const { validateFindingResponse } = require('../../legacy-codebase-transformation/extension/src/scan-pipeline');

function scanPrompt(chunk, remainingFindings) {
  const prompt = JSON.parse(buildSharedScanPrompt(chunk, remainingFindings));
  prompt.instructions += ' When a function has several levels of nested conditionals that determine its outcome, prioritize one safe whole-function simplification that removes the nesting over a tiny local cleanup. If behavior can be preserved, set originalText to the exact complete function and replacementText to a shorter complete replacement. Keep the change to one function and omit it if you cannot verify the behavior-preserving replacement.';
  prompt.instructions += ' Preserve the existing module format. In CommonJS files retain require, module.exports, __dirname, and dynamic import() compatibility; do not introduce static import/export declarations or top-level await. Findings must not overlap; provide one preferred replacement for a source span, not competing alternatives.';
  return JSON.stringify(prompt);
}

function javaScriptReplacementFailure(relativePath, originalText, updatedText) {
  if (!/\.(?:js|cjs)$/i.test(relativePath)) return null;
  try {
    compileFunction(originalText);
  } catch {
    return null;
  }
  try {
    compileFunction(updatedText);
    return null;
  } catch {
    return 'Replacement must preserve valid JavaScript and the existing CommonJS/script module format; static import/export and top-level await are not compatible.';
  }
}

function validateReplacementSyntax(result, chunk) {
  const findings = [];
  const rejections = [...result.rejections];
  for (const finding of result.findings) {
    const normalizedContent = chunk.content.replace(/\r\n/g, '\n');
    const originalText = finding.originalText.replace(/\r\n/g, '\n');
    const replacementText = finding.replacementText.replace(/\r\n/g, '\n');
    const lines = normalizedContent.split('\n');
    const startLine = finding.range.startLine - chunk.startLine;
    const start = lines.slice(0, startLine).reduce((offset, line) => offset + line.length + 1, 0) + finding.range.startCharacter;
    const updatedText = normalizedContent.slice(0, start) + replacementText + normalizedContent.slice(start + originalText.length);
    const failure = javaScriptReplacementFailure(chunk.path, normalizedContent, updatedText);
    if (failure) rejections.push(failure);
    else findings.push(finding);
  }
  return { findings, rejections };
}

function recoverFindingCoordinates(candidate, content) {
  if (typeof candidate?.originalText !== 'string' || !candidate.originalText) return null;
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const normalizedOriginal = candidate.originalText.replace(/\r\n/g, '\n');
  const start = normalizedContent.indexOf(normalizedOriginal);
  if (start < 0 || normalizedContent.indexOf(normalizedOriginal, start + 1) >= 0) return null;

  const positionAt = (offset) => {
    const lines = normalizedContent.slice(0, offset).split('\n');
    return { line: lines.length, character: lines.at(-1).length };
  };
  const startPosition = positionAt(start);
  const endPosition = positionAt(start + normalizedOriginal.length);
  const lineCount = normalizedContent.split('\n').length;
  const functionRangeValid = Number.isInteger(candidate.functionStartLine) &&
    Number.isInteger(candidate.functionEndLine) && candidate.functionStartLine >= 1 &&
    candidate.functionStartLine <= startPosition.line && candidate.functionEndLine >= endPosition.line &&
    candidate.functionEndLine <= lineCount;

  return {
    ...candidate,
    functionStartLine: functionRangeValid ? candidate.functionStartLine : startPosition.line,
    functionEndLine: functionRangeValid ? candidate.functionEndLine : endPosition.line,
    startLine: startPosition.line,
    startCharacter: startPosition.character,
    endLine: endPosition.line,
    endCharacter: endPosition.character
  };
}

function textValidationFailure(candidate) {
  if (!candidate || typeof candidate !== 'object') return 'finding text fields must be strings.';
  if (typeof candidate.originalText !== 'string') return 'originalText must be a string.';
  if (!candidate.originalText) return 'originalText must not be empty.';
  if (candidate.originalText.length > 30 * 1024) return 'originalText exceeds the 30 KB limit.';
  if (typeof candidate.replacementText !== 'string') return 'replacementText must be a string.';
  if (!candidate.replacementText.trim()) return 'replacementText must not be empty.';
  if (candidate.replacementText.length > 30 * 1024) return 'replacementText exceeds the 30 KB limit.';
  const normalizeNewlines = (text) => text.replace(/\r\n/g, '\n');
  if (normalizeNewlines(candidate.replacementText) === normalizeNewlines(candidate.originalText)) {
    return 'replacementText is unchanged from originalText.';
  }
  return 'originalText must match the source exactly and replacementText must change it.';
}

function explainTextRejections(rejections, candidates) {
  return rejections.map((reason) => {
    const match = /^(Finding (\d+): )Original or replacement text is (?:empty, oversized, invalid, or unchanged|oversized or unchanged after newline normalization)\.$/.exec(reason);
    if (!match) return reason;
    const candidate = candidates[Number(match[2]) - 1];
    return `${match[1]}Text validation failed: ${textValidationFailure(candidate)}`;
  });
}

function validateUploadedFinding(payload, chunk) {
  const rejections = [];
  const findings = validateFindingResponse(payload, chunk, rejections);
  if (!rejections.some((reason) => reason.includes('outside the supplied source')) ||
      !payload || !Array.isArray(payload.findings)) {
    return validateReplacementSyntax({ findings, rejections: explainTextRejections(rejections, payload?.findings ?? []) }, chunk);
  }

  const recoveredFindings = [];
  const recoveredRejections = [];
  for (const candidate of payload.findings) {
    const candidateRejections = [];
    const accepted = validateFindingResponse({ findings: [candidate] }, chunk, candidateRejections);
    if (accepted.length || !candidateRejections.some((reason) => reason.includes('outside the supplied source'))) {
      recoveredFindings.push(...accepted);
      recoveredRejections.push(...explainTextRejections(candidateRejections, [candidate]));
      continue;
    }

    const recovered = recoverFindingCoordinates(candidate, chunk.content);
    if (!recovered) {
      recoveredRejections.push(...candidateRejections, 'Finding coordinates were invalid and originalText did not identify one unique source span.');
      continue;
    }

    const retryRejections = [];
    recoveredFindings.push(...validateFindingResponse({ findings: [recovered] }, chunk, retryRejections));
    recoveredRejections.push(...explainTextRejections(retryRejections, [recovered]));
  }
  return validateReplacementSyntax({ findings: recoveredFindings, rejections: recoveredRejections }, chunk);
}

module.exports = { chunkSourceFiles, scanPrompt, validateUploadedFinding, javaScriptReplacementFailure };
