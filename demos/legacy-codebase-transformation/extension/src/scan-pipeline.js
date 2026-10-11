'use strict';

const { randomUUID } = require('node:crypto');
const { scanPrompt } = require('./workspace-scan');

const MAX_FINDINGS = 30;
const MAX_MODEL_REQUESTS = 30;
const FINDING_CATEGORIES = Object.freeze([
  'redundant-control-flow', 'repeated-local-expression', 'complex-function-simplification'
]);

function sourceOffset(content, lineNumber, character) {
  const lines = content.split('\n');
  if (!Number.isInteger(lineNumber) || !Number.isInteger(character) || lineNumber < 1 ||
      lineNumber > lines.length || character < 0 || character > lines[lineNumber - 1].replace(/\r$/, '').length) {
    return null;
  }
  return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + character;
}

function validateFindingResponse(payload, chunk) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || !Array.isArray(payload.findings) || payload.findings.length > 3) {
    return [];
  }
  const requiredKeys = [
    'category', 'rationale', 'confidence', 'symbol', 'functionStartLine', 'functionEndLine',
    'startLine', 'startCharacter', 'endLine', 'endCharacter', 'originalText'
  ].sort().join('\0');
  const findings = [];

  for (const candidate of payload.findings) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        Object.keys(candidate).sort().join('\0') !== requiredKeys ||
        !FINDING_CATEGORIES.includes(candidate.category) ||
        !['low', 'medium', 'high'].includes(candidate.confidence) ||
        typeof candidate.rationale !== 'string' || !candidate.rationale.trim() || candidate.rationale.length > 1000 ||
        typeof candidate.symbol !== 'string' || !candidate.symbol.trim() || candidate.symbol.length > 200 ||
        typeof candidate.originalText !== 'string' || !candidate.originalText || candidate.originalText.length > 30 * 1024 ||
        ![candidate.functionStartLine, candidate.functionEndLine, candidate.startLine, candidate.startCharacter,
          candidate.endLine, candidate.endCharacter].every(Number.isInteger) ||
        candidate.functionStartLine < 1 || candidate.functionEndLine < candidate.functionStartLine ||
        candidate.startLine < candidate.functionStartLine || candidate.endLine > candidate.functionEndLine ||
        candidate.endLine < candidate.startLine) {
      continue;
    }
    const start = sourceOffset(chunk.content, candidate.startLine, candidate.startCharacter);
    const end = sourceOffset(chunk.content, candidate.endLine, candidate.endCharacter);
    const functionStart = sourceOffset(chunk.content, candidate.functionStartLine, 0);
    const functionLine = chunk.content.split('\n')[candidate.functionEndLine - 1];
    const functionEnd = functionLine === undefined ? null : sourceOffset(chunk.content, candidate.functionEndLine,
      functionLine.replace(/\r$/, '').length);
    if (start === null || end === null || functionStart === null || functionEnd === null ||
        start >= end || start < functionStart || end > functionEnd ||
        chunk.content.slice(start, end) !== candidate.originalText) {
      continue;
    }
    findings.push({
      id: randomUUID(), scanId: chunk.scanId, path: chunk.path, sourceHash: chunk.sourceHash,
      category: candidate.category, rationale: candidate.rationale.trim(), confidence: candidate.confidence,
      symbol: candidate.symbol.trim(),
      functionRange: {
        startLine: chunk.startLine + candidate.functionStartLine - 1,
        endLine: chunk.startLine + candidate.functionEndLine - 1
      },
      range: {
        startLine: chunk.startLine + candidate.startLine - 1,
        startCharacter: candidate.startCharacter,
        endLine: chunk.startLine + candidate.endLine - 1,
        endCharacter: candidate.endCharacter
      },
      originalText: candidate.originalText, status: 'new'
    });
  }
  return findings;
}

async function scanWorkspace(vscode, projectRoot, model, token, options = {}) {
  const inventory = await require('./workspace-scan').inventorySourceFiles(vscode, projectRoot, token);
  if (inventory.status !== 'ready') return inventory;
  const { chunkSourceFiles } = require('./workspace-scan');
  const chunked = chunkSourceFiles(inventory.files);
  const chunks = chunked.chunks;
  const skipped = inventory.skipped + chunked.skipped;
  const scanId = randomUUID();
  if (chunks.length === 0) {
    return { status: skipped ? 'incomplete' : 'completed', scanId, root: inventory.root.realPath,
      findings: [], files: inventory.files.length, bytes: inventory.bytes, projectedRequests: 0,
      requests: 0, skipped, rejected: 0, incomplete: skipped > 0 };
  }
  if (!model || typeof model.sendRequest !== 'function') throw new Error('Select an available language model before scanning.');
  if (typeof vscode.window?.showWarningMessage !== 'function') throw new Error('Per-scan source-sharing confirmation is unavailable.');

  const destination = `${model.vendor ?? 'unknown vendor'}${model.id ? ` / ${model.id}` : ''}`;
  const modelName = model.name ?? model.family ?? model.id ?? 'selected model';
  const permission = await vscode.window.showWarningMessage(
    'Send bounded source chunks from this workspace to the selected language model for refactoring findings?',
    { modal: true, detail: `Root: ${inventory.root.realPath}\nEligible source files: ${inventory.files.length}\nEligible source bytes: ${inventory.bytes}\nProjected model requests: ${chunks.length} (this scan sends at most ${MAX_MODEL_REQUESTS})\nModel: ${modelName}\nDestination: ${destination}\nFindings are limited to ${MAX_FINDINGS}; declining sends no source.` },
    'Send source and scan'
  );
  if (permission !== 'Send source and scan' || token?.isCancellationRequested) {
    return { status: 'cancelled', scanId, root: inventory.root.realPath, findings: [], files: inventory.files.length,
      bytes: inventory.bytes, projectedRequests: chunks.length, requests: 0, skipped, rejected: 0, incomplete: false };
  }

  const requestModel = options.requestModel ?? (async (chunk) => {
    const prompt = scanPrompt(chunk, MAX_FINDINGS);
    if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw new Error('A scan request exceeded the 256 KB context limit.');
    const message = vscode.LanguageModelChatMessage.User(prompt);
    const response = await model.sendRequest([message], {}, token);
    let text = '';
    for await (const part of response.text) {
      text += part;
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('The model finding response exceeded its size limit.');
    }
    return text;
  });
  const findings = [];
  let requests = 0;
  let rejected = 0;
  const scanChunks = chunks.slice(0, MAX_MODEL_REQUESTS).map((chunk) => ({ ...chunk, scanId }));
  for (const chunk of scanChunks) {
    if (token?.isCancellationRequested || findings.length >= MAX_FINDINGS) break;
    const prompt = scanPrompt(chunk, MAX_FINDINGS - findings.length);
    if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) {
      rejected += 1;
      continue;
    }
    try {
      requests += 1;
      const output = await requestModel(chunk, token);
      const payload = typeof output === 'string' ? JSON.parse(output) : output;
      const validated = validateFindingResponse(payload, chunk);
      if (!validated.length && payload?.findings?.length) rejected += 1;
      findings.push(...validated.slice(0, MAX_FINDINGS - findings.length));
    } catch {
      rejected += 1;
    }
  }
  const incomplete = skipped > 0 || chunks.length > requests || rejected > 0;
  return {
    status: token?.isCancellationRequested ? 'cancelled' : incomplete ? 'incomplete' : 'completed',
    scanId, root: inventory.root.realPath,
    findings: token?.isCancellationRequested ? [] : findings.slice(0, MAX_FINDINGS),
    files: inventory.files.length, bytes: inventory.bytes, projectedRequests: chunks.length,
    requests, skipped, rejected, incomplete
  };
}

module.exports = { FINDING_CATEGORIES, scanWorkspace, sourceOffset, validateFindingResponse };
