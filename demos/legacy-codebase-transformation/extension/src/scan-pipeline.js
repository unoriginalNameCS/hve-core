'use strict';

const { randomUUID } = require('node:crypto');
const { scanPrompt } = require('./workspace-scan');
const { chunkSourceFiles, hashSource, inventorySourceFiles } = require('./workspace-scan');

const MAX_MODEL_REQUESTS = 30;
const FINDING_CATEGORIES = Object.freeze([
  'redundant-control-flow', 'repeated-local-expression', 'complex-function-simplification'
]);

async function prepareWorkspaceScan(vscode, projectRoot, token) {
  const inventory = await inventorySourceFiles(vscode, projectRoot, token);
  if (inventory.status !== 'ready') return inventory;
  const chunked = chunkSourceFiles(inventory.files);
  const fingerprint = hashSource(JSON.stringify({
    root: inventory.root.realPath,
    files: inventory.files.map(({ path, sourceHash, bytes }) => ({ path, sourceHash, bytes })),
    skipped: inventory.skipped,
    bytes: inventory.bytes,
    chunks: chunked.chunks.length,
    skippedChunks: chunked.skipped,
    unsupportedFiles: inventory.unsupportedFiles
  }));
  return {
    status: 'ready', inventory, chunks: chunked.chunks,
    skipped: inventory.skipped + chunked.skipped,
    skippedFiles: [...inventory.skippedFiles, ...chunked.skippedFiles],
    scanId: randomUUID(), fingerprint
  };
}

function sourceOffset(content, lineNumber, character) {
  const lines = content.split('\n');
  if (!Number.isInteger(lineNumber) || !Number.isInteger(character) || lineNumber < 1 ||
      lineNumber > lines.length || character < 0 || character > lines[lineNumber - 1].replace(/\r$/, '').length) {
    return null;
  }
  return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + character;
}

function validateFindingResponse(payload, chunk, rejections = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || !Array.isArray(payload.findings) || payload.findings.length > 3) {
    rejections.push('Response must contain only a findings array with at most three entries.');
    return [];
  }
  const requiredKeys = [
    'category', 'rationale', 'confidence', 'symbol', 'functionStartLine', 'functionEndLine',
    'startLine', 'startCharacter', 'endLine', 'endCharacter', 'originalText', 'replacementText'
  ].sort().join('\0');
  const findings = [];

  for (const [index, candidate] of payload.findings.entries()) {
    const reject = (reason) => rejections.push(`Finding ${index + 1}: ${reason}`);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        Object.keys(candidate).sort().join('\0') !== requiredKeys) {
      reject('Required fields are missing or unexpected fields are present.');
      continue;
    }
    if (!FINDING_CATEGORIES.includes(candidate.category)) {
      reject('Category is not an allowed readability category.');
      continue;
    }
    if (!['low', 'medium', 'high'].includes(candidate.confidence)) {
      reject('Confidence must be low, medium, or high.');
      continue;
    }
    if (typeof candidate.rationale !== 'string' || !candidate.rationale.trim() || candidate.rationale.length > 1000 ||
        typeof candidate.symbol !== 'string' || !candidate.symbol.trim() || candidate.symbol.length > 200) {
      reject('Rationale or symbol is empty, oversized, or not a string.');
      continue;
    }
    if (
        typeof candidate.originalText !== 'string' || !candidate.originalText || candidate.originalText.length > 30 * 1024 ||
        typeof candidate.replacementText !== 'string' || !candidate.replacementText.trim() ||
        candidate.replacementText.length > 30 * 1024 || candidate.replacementText === candidate.originalText) {
      reject('Original or replacement text is empty, oversized, invalid, or unchanged.');
      continue;
    }
    if (![candidate.functionStartLine, candidate.functionEndLine, candidate.startLine, candidate.startCharacter,
      candidate.endLine, candidate.endCharacter].every(Number.isInteger)) {
      reject('All line and character positions must be integers.');
      continue;
    }
    if (candidate.functionStartLine < 1 || candidate.functionEndLine < candidate.functionStartLine ||
        candidate.startLine < candidate.functionStartLine || candidate.endLine > candidate.functionEndLine ||
        candidate.endLine < candidate.startLine) {
      reject('Span lines must be ordered and contained in the declared function.');
      continue;
    }
    let start = sourceOffset(chunk.content, candidate.startLine, candidate.startCharacter);
    let end = sourceOffset(chunk.content, candidate.endLine, candidate.endCharacter);
    const functionStart = sourceOffset(chunk.content, candidate.functionStartLine, 0);
    const functionLine = chunk.content.split('\n')[candidate.functionEndLine - 1];
    const functionEnd = functionLine === undefined ? null : sourceOffset(chunk.content, candidate.functionEndLine,
      functionLine.replace(/\r$/, '').length);
    if (start === null || end === null || functionStart === null || functionEnd === null) {
      reject('Line or character position is outside the supplied source (characters use zero-based UTF-16 offsets, excluding CR/LF).');
      continue;
    }
    if (start >= end || start < functionStart || end > functionEnd) {
      reject('Span must be nonempty, ordered, and contained in the declared function.');
      continue;
    }
    const normalizedOriginal = candidate.originalText.replace(/\r\n/g, '\n');
    if (chunk.content.slice(start, end).replace(/\r\n/g, '\n') !== normalizedOriginal) {
      const functionText = chunk.content.slice(functionStart, functionEnd).replace(/\r\n/g, '\n');
      const match = functionText.indexOf(normalizedOriginal);
      if (match < 0 || functionText.indexOf(normalizedOriginal, match + 1) >= 0) {
        reject('originalText does not exactly match a unique span inside the declared function after newline normalization; check source text and indentation.');
        continue;
      }
      const prefix = chunk.content.slice(0, functionStart).replace(/\r\n/g, '\n');
      const normalizedContent = chunk.content.replace(/\r\n/g, '\n');
      const positionAt = (offset) => {
        const lines = normalizedContent.slice(0, offset).split('\n');
        return sourceOffset(chunk.content, lines.length, lines.at(-1).length);
      };
      start = positionAt(prefix.length + match);
      end = positionAt(prefix.length + match + normalizedOriginal.length);
    }
    const originalText = chunk.content.slice(start, end);
    const startLines = chunk.content.slice(0, start).split('\n');
    const endLines = chunk.content.slice(0, end).split('\n');
    const lineEnding = chunk.content.includes('\r\n') && !/(?<!\r)\n/.test(chunk.content) ? '\r\n' : '\n';
    const replacementText = candidate.replacementText.replace(/\r\n/g, '\n').replace(/\n/g, lineEnding);
    if (originalText.length > 30 * 1024 || replacementText.length > 30 * 1024 || replacementText === originalText) {
      reject('Original or replacement text is oversized or unchanged after newline normalization.');
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
        startLine: chunk.startLine + startLines.length - 1,
        startCharacter: startLines.at(-1).length,
        endLine: chunk.startLine + endLines.length - 1,
        endCharacter: endLines.at(-1).length
      },
      originalText, replacementText, status: 'new'
    });
  }
  return findings;
}

async function scanWorkspace(vscode, projectRoot, model, token, options = {}) {
  const prepared = await prepareWorkspaceScan(vscode, projectRoot, token);
  if (prepared.status !== 'ready') return prepared;
  const { inventory, chunks, skipped } = prepared;
  const previous = options.previousResult;
  const scanId = previous?.scanId ?? prepared.scanId;
  if ((options.expectedFingerprint && options.expectedFingerprint !== prepared.fingerprint) ||
      (previous && (previous.fingerprint !== prepared.fingerprint ||
        !Number.isInteger(previous.nextChunk) || previous.nextChunk < 0 || previous.nextChunk > chunks.length))) {
    return { status: 'stale', scanId, root: inventory.root.realPath, findings: [], files: inventory.files.length,
      bytes: inventory.bytes, projectedRequests: chunks.length, requests: 0, skipped, rejected: 0,
      reason: 'The workspace changed after the chat preview. Prepare a new scan.' };
  }
  if (chunks.length && (!model || typeof model.sendRequest !== 'function')) {
    throw new Error('Select an available language model before scanning.');
  }
  if (options.chatApproved !== true || token?.isCancellationRequested) {
    return { status: 'cancelled', scanId, root: inventory.root.realPath, findings: [], files: inventory.files.length,
      bytes: inventory.bytes, projectedRequests: chunks.length, requests: 0, skipped, rejected: 0, incomplete: false };
  }

  const requestModel = options.requestModel ?? (async (chunk) => {
    const prompt = scanPrompt(chunk, 3);
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
  const findings = structuredClone(previous?.findings ?? []);
  const findingKeys = new Set(findings.map((finding) => JSON.stringify([
    finding.path, finding.range, finding.originalText, finding.replacementText
  ])));
  const reviewedChunks = new Set(previous?.reviewedChunks ?? []);
  const failedChunks = structuredClone(previous?.failedChunks ?? []);
  let nextChunk = previous?.nextChunk ?? 0;
  let requests = previous?.requests ?? 0;
  let rejected = previous?.rejected ?? 0;
  let sharedBytes = previous?.sharedBytes ?? 0;
  let batchRequests = 0;
  const batchEnd = Math.min(chunks.length, nextChunk + MAX_MODEL_REQUESTS);
  while (nextChunk < batchEnd) {
    if (token?.isCancellationRequested) break;
    const chunkIndex = nextChunk;
    const chunk = { ...chunks[chunkIndex], scanId };
    nextChunk += 1;
    const prompt = scanPrompt(chunk, 3);
    if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) {
      rejected += 1;
      failedChunks.push({ path: chunk.path, startLine: chunk.startLine, reason: 'Request exceeds the context byte limit.' });
      continue;
    }
    let failureReason = 'Model request failed or response exceeded its size limit.';
    try {
      requests += 1;
      batchRequests += 1;
      sharedBytes += Buffer.byteLength(chunk.content, 'utf8');
      const output = await requestModel(chunk, token);
      failureReason = 'Model response is not valid JSON; return a JSON object without code fences or surrounding prose.';
      const payload = typeof output === 'string' ? JSON.parse(output) : output;
      const rejections = [];
      const validated = validateFindingResponse(payload, chunk, rejections);
      if (rejections.length) {
        rejected += 1;
        failedChunks.push({ path: chunk.path, startLine: chunk.startLine, reason: rejections.join(' ') });
      } else {
        reviewedChunks.add(chunkIndex);
      }
      for (const finding of validated) {
        const key = JSON.stringify([finding.path, finding.range, finding.originalText, finding.replacementText]);
        if (findingKeys.has(key)) continue;
        findingKeys.add(key);
        findings.push(finding);
      }
    } catch {
      if (token?.isCancellationRequested) {
        nextChunk = chunkIndex;
        break;
      }
      rejected += 1;
      failedChunks.push({ path: chunk.path, startLine: chunk.startLine, reason: failureReason });
    }
    options.onProgress?.({ attemptedChunks: nextChunk, totalChunks: chunks.length,
      reviewedChunks: reviewedChunks.size, findings: findings.length });
  }
  const remainingChunks = chunks.length - nextChunk;
  const incomplete = skipped > 0 || remainingChunks > 0 || rejected > 0;
  const unreviewedFiles = new Set(prepared.skippedFiles.map((file) => file.path));
  chunks.forEach((chunk, index) => { if (!reviewedChunks.has(index)) unreviewedFiles.add(chunk.path); });
  const filesReviewed = inventory.files.filter((file) => !unreviewedFiles.has(file.path)).length;
  return {
    status: token?.isCancellationRequested ? 'cancelled' : incomplete ? 'incomplete' : 'completed',
    scanId, fingerprint: prepared.fingerprint, root: inventory.root.realPath, findings,
    files: inventory.files.length, bytes: inventory.bytes, projectedRequests: chunks.length,
    requests, batchRequests, batchNumber: (previous?.batchNumber ?? 0) + 1,
    nextChunk, remainingChunks, reviewedChunks: [...reviewedChunks], filesReviewed,
    sharedBytes, skipped, skippedFiles: prepared.skippedFiles, unsupportedFiles: inventory.unsupportedFiles,
    failedChunks, rejected, incomplete, canContinue: remainingChunks > 0
  };
}

module.exports = { FINDING_CATEGORIES, MAX_MODEL_REQUESTS, prepareWorkspaceScan, scanWorkspace, sourceOffset, validateFindingResponse };
