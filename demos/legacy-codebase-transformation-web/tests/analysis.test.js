'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chunkSourceFiles, scanPrompt, validateUploadedFinding } = require('../server/analysis');

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

test('uploaded source uses the existing chunker and prompt contract', () => {
  const { chunks } = chunkSourceFiles([{ path: 'src/readiness.js', content: source, sourceHash: 'hash' }]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, source);
  const prompt = scanPrompt({ ...chunks[0], scanId: 'scan-1' }, 5);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /prioritize one safe whole-function simplification/);
});

test('uploaded findings must match an exact source span before review', () => {
  const chunk = {
    scanId: 'scan-1', path: 'src/readiness.js', sourceHash: 'hash', startLine: 1, content: source
  };
  const candidate = {
    category: 'redundant-control-flow', rationale: 'The branch returns booleans directly.', confidence: 'high',
    symbol: 'isReady', functionStartLine: 1, functionEndLine: 7, startLine: 2, startCharacter: 2,
    endLine: 6, endCharacter: 3,
    originalText: 'if (value) {\n    return true;\n  } else {\n    return false;\n  }',
    replacementText: 'return Boolean(value);'
  };

  const accepted = validateUploadedFinding({ findings: [candidate] }, chunk);
  assert.equal(accepted.findings.length, 1);
  assert.deepEqual(accepted.rejections, []);

  const rejected = validateUploadedFinding({ findings: [{ ...candidate, originalText: 'invented source text' }] }, chunk);
  assert.equal(rejected.findings.length, 0);
  assert.equal(rejected.rejections.length, 1);

  const unchanged = validateUploadedFinding({ findings: [{ ...candidate, replacementText: candidate.originalText }] }, chunk);
  assert.equal(unchanged.findings.length, 0);
  assert.match(unchanged.rejections[0], /replacementText is unchanged from originalText/);
});

test('uploaded findings recover invalid coordinates only when original text is unique', () => {
  const chunk = {
    scanId: 'scan-1', path: 'src/readiness.js', sourceHash: 'hash', startLine: 1, content: source
  };
  const candidate = {
    category: 'redundant-control-flow', rationale: 'The branch returns booleans directly.', confidence: 'high',
    symbol: 'isReady', functionStartLine: 500, functionEndLine: 600, startLine: 501, startCharacter: 100,
    endLine: 505, endCharacter: 100,
    originalText: 'if (value) {\n    return true;\n  } else {\n    return false;\n  }',
    replacementText: 'return Boolean(value);'
  };

  const recovered = validateUploadedFinding({ findings: [candidate] }, chunk);
  assert.equal(recovered.findings.length, 1);
  assert.deepEqual(recovered.findings[0].range, {
    startLine: 2, startCharacter: 2, endLine: 6, endCharacter: 3
  });
  assert.deepEqual(recovered.rejections, []);

  const repeatedText = source.replace('    return false;', '    return true;');
  const ambiguous = validateUploadedFinding({ findings: [{ ...candidate, originalText: 'return true;' }] }, {
    ...chunk, content: repeatedText
  });
  assert.equal(ambiguous.findings.length, 0);
  assert.ok(ambiguous.rejections.some((reason) => reason.includes('did not identify one unique source span')));
});
