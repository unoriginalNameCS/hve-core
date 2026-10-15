'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { analyzePreparedUpload, applyApprovedFindings, getSession, normalizeUploadPath, prepareUpload, prepareUploadedFiles, removeSession } = require('../server/workflow');

const source = [
  'function isReady(value) {',
  '  if (value) {',
  '    return true;',
  '  } else {',
  '    return false;',
  '  }',
  '}',
  ''
].join('\n');
const candidate = {
  category: 'redundant-control-flow', rationale: 'The branch returns booleans directly.', confidence: 'high',
  symbol: 'isReady', functionStartLine: 1, functionEndLine: 7, startLine: 2, startCharacter: 2,
  endLine: 6, endCharacter: 3,
  originalText: 'if (value) {\n    return true;\n  } else {\n    return false;\n  }',
  replacementText: 'return Boolean(value);'
};

test('upload paths reject traversal and conflicting roots', () => {
  assert.equal(normalizeUploadPath('project/src/file.js'), 'project/src/file.js');
  assert.throws(() => normalizeUploadPath('../outside.js'), /invalid relative path/);
  assert.throws(() => normalizeUploadPath('C:/outside.js'), /invalid relative path/);
  assert.throws(() => prepareUploadedFiles([
    { id: 'file-0', path: 'project/one.js', size: 1 },
    { id: 'file-0', path: 'project/two.js', size: 1 }
  ], new Map([['file-0', Buffer.from('a')], ['file-1', Buffer.from('b')]])), /did not match their manifest/);
});

test('combined demo sample prepares exactly one source chunk with npm inventory', () => {
  const sampleRoot = path.resolve(__dirname, '../samples/npm-review');
  const relativePaths = ['package.json', 'package-lock.json', 'src/transfer.js'];
  const uploaded = relativePaths.map((relativePath, index) => ({
    id: `file-${index}`,
    path: `npm-review/${relativePath}`,
    bytes: fs.readFileSync(path.join(sampleRoot, relativePath))
  }));
  const preview = prepareUpload(
    uploaded.map(({ id, path: relativePath, bytes }) => ({ id, path: relativePath, size: bytes.length })),
    new Map(uploaded.map(({ id, bytes }) => [id, bytes]))
  );

  assert.equal(preview.summary.sourceFiles, 1);
  assert.equal(preview.summary.projectedRequests, 1);
  assert.deepEqual(preview.sourceDisclosure.files, ['npm-review/src/transfer.js']);
  assert.deepEqual(preview.dependencyPreview.registryNames, ['lodash', 'mkdirp']);
  assert.equal(preview.dependencyPreview.advisoryTuples.length, 3);
  assert.equal(preview.dependencyPreview.buildAvailable, true);
  assert.ok(preview.dependencyPreview.buildScript);
  removeSession(preview.sessionId);
});

test('validated findings remain selectable when another source response is rejected', async () => {
  const bytes = Buffer.from(source);
  const preview = prepareUpload([
    { id: 'file-0', path: 'project/src/first.js', size: bytes.length },
    { id: 'file-1', path: 'project/src/second.js', size: bytes.length }
  ], new Map([['file-0', bytes], ['file-1', bytes]]));
  let requests = 0;
  const review = await analyzePreparedUpload(preview.sessionId, { sourceApproved: true, dependencyApproved: false }, {
    config: { apiKey: 'test', model: 'gpt-4.1-mini', url: 'https://example.test' },
    requestFindings: async () => (++requests === 1 ? { findings: [candidate] } : { findings: [{ ...candidate, originalText: 'not in the source' }] })
  });
  assert.equal(review.sourceStatus, 'incomplete');
  assert.equal(review.complete, false);
  assert.equal(review.findings.length, 1);
  assert.equal(review.sourceFailures.length, 1);
  assert.throws(() => applyApprovedFindings(preview.sessionId, ['rejected']), /unknown finding/);
  const applied = applyApprovedFindings(preview.sessionId, [review.findings[0].id]);
  assert.equal(applied.findings, 1);
  const session = getSession(preview.sessionId);
  assert.match(session.files.get('project/src/first.js').toString(), /return Boolean\(value\);/);
  assert.equal(session.files.get('project/src/second.js').toString(), source);
  removeSession(preview.sessionId);
});

test('source analysis retries once when the model returns invalid replacement text', async () => {
  const preview = prepareUpload(
    [{ id: 'file-0', path: 'project/src/readiness.js', size: Buffer.byteLength(source) }],
    new Map([['file-0', Buffer.from(source)]])
  );
  const prompts = [];
  const review = await analyzePreparedUpload(preview.sessionId, { sourceApproved: true, dependencyApproved: false }, {
    config: { apiKey: 'test', model: 'gpt-4.1-mini', url: 'https://example.test' },
    requestFindings: async (prompt) => {
      prompts.push(prompt);
      return { findings: [prompts.length === 1 ? { ...candidate, replacementText: candidate.originalText } : candidate] };
    }
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Preserve the existing module format/);
  assert.match(prompts[0], /Findings must not overlap/);
  assert.match(prompts[1], /Validation feedback/);
  assert.match(prompts[1], /replacementText is unchanged from originalText/);
  assert.equal(review.complete, true);
  assert.equal(review.summary.requests, 2);
  assert.equal(review.sourceFailures.length, 0);
  assert.equal(review.findings.length, 1);
  removeSession(preview.sessionId);
});

test('approval edits only the staged copy and refuses unapproved or repeated writes', async () => {
  const originalBuffer = Buffer.from(source);
  const preview = prepareUpload(
    [{ id: 'file-0', path: 'project/src/readiness.js', size: originalBuffer.length }],
    new Map([['file-0', originalBuffer]])
  );
  const result = await analyzePreparedUpload(preview.sessionId, { sourceApproved: true, dependencyApproved: false }, {
      config: { apiKey: 'test', model: 'gpt-4.1-mini', url: 'https://example.test' },
      requestFindings: async () => ({ findings: [candidate] })
    });
  const session = getSession(result.sessionId);

  assert.equal(result.complete, true);
  assert.equal(session.files.get('project/src/readiness.js').toString('utf8'), source);
  assert.throws(() => applyApprovedFindings(result.sessionId, ['unknown']), /unknown finding/);

  const applied = applyApprovedFindings(result.sessionId, [result.findings[0].id]);
  assert.equal(applied.findings, 1);
  assert.equal(applied.files, 1);
  assert.equal(applied.report.sourceChanges[0].before, result.findings[0].originalText);
  assert.equal(applied.report.sourceChanges[0].after, result.findings[0].replacementText);
  assert.match(session.files.get('project/src/readiness.js').toString('utf8'), /return Boolean\(value\);/);
  assert.equal(originalBuffer.toString('utf8'), source);
  assert.throws(() => applyApprovedFindings(result.sessionId, [result.findings[0].id]), /already been transformed/);
  removeSession(result.sessionId);
});

test('individually valid proposals cannot stage an invalid combined JavaScript file', async () => {
  const content = 'function summarize() {\n  var first = 1;\n  var second = 2;\n  return first + second;\n}\n';
  const bytes = Buffer.from(content);
  const preview = prepareUpload([{ id: 'file-0', path: 'project/src/summary.js', size: bytes.length }],
    new Map([['file-0', bytes]]));
  const proposals = [2, 3].map((line, index) => ({
    ...candidate, symbol: 'summarize', functionStartLine: 1, functionEndLine: 5,
    startLine: line, endLine: line, startCharacter: 2,
    endCharacter: content.split('\n')[line - 1].length,
    originalText: index === 0 ? 'var first = 1;' : 'var second = 2;',
    replacementText: `const shared = ${index + 1};`
  }));
  const review = await analyzePreparedUpload(preview.sessionId, { sourceApproved: true, dependencyApproved: false }, {
    config: { apiKey: 'test', model: 'gpt-4.1-mini', url: 'https://example.test' },
    requestFindings: async () => ({ findings: proposals })
  });
  assert.equal(review.findings.length, 2);
  assert.throws(() => applyApprovedFindings(preview.sessionId, review.findings.map((finding) => finding.id)),
    /summary\.js: Replacement must preserve valid JavaScript/);
  assert.equal(getSession(preview.sessionId).files.get('project/src/summary.js').toString(), content);
  removeSession(preview.sessionId);
});
