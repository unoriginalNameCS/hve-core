'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { renderProposalReport, validateProposal } = require('../src/proposal-contract');

const evidence = [{
  id: 'E1',
  path: 'src/Calculator.cs',
  startLine: 10,
  endLine: 18,
  content: 'public static decimal Calculate() { return 1m; }'
}];

function proposal() {
  return {
    summary: 'Simplify the calculator.',
    target: { path: 'src/Calculator.cs', symbol: 'Calculate' },
    evidence: [{
      id: 'E1',
      path: 'src/Calculator.cs',
      startLine: 10,
      endLine: 12,
      claim: 'The target is a single expression method.'
    }],
    changes: [{
      path: 'src/Calculator.cs',
      originalText: 'return 1m;',
      replacementText: 'return CalculateValue();',
      rationale: 'Extract the repeated operation.'
    }],
    unknowns: ['Callers outside the selected project were not analyzed.']
  };
}

test('proposal validation accepts exact citations within collected evidence and selected target', () => {
  assert.deepEqual(validateProposal(proposal(), evidence, { path: 'src/Calculator.cs', symbol: 'Calculate' }), { valid: true, errors: [] });
});

test('proposal validation rejects invented evidence and out-of-range citations', () => {
  const candidate = proposal();
  candidate.evidence[0].id = 'E2';
  assert.match(validateProposal(candidate, evidence).errors.join(' '), /does not identify collected evidence/);

  const outOfRange = proposal();
  outOfRange.evidence[0].endLine = 19;
  assert.match(validateProposal(outOfRange, evidence).errors.join(' '), /outside the collected evidence range/);
});

test('proposal validation rejects traversal paths and additional properties', () => {
  const traversal = proposal();
  traversal.changes[0].path = '../outside.cs';
  assert.match(validateProposal(traversal, evidence).errors.join(' '), /normalized project-relative path/);

  const extra = proposal();
  extra.unreviewedInstruction = 'not allowed';
  assert.equal(validateProposal(extra, evidence).valid, false);
});

test('report renderer includes only validated evidence and exact proposed text', () => {
  const rendered = renderProposalReport(proposal(), evidence);
  assert.match(rendered, /src\/Calculator\.cs`?:10-12/);
  assert.match(rendered, /return CalculateValue\(\);/);
  assert.match(rendered, /No source files were changed or validated/);
});

test('report renderer escapes model prose from Markdown structure', () => {
  const candidate = proposal();
  candidate.summary = '# Injected heading\n* Injected list item';
  const rendered = renderProposalReport(candidate, evidence);

  assert.match(rendered, /\\# Injected heading/);
  assert.match(rendered, /\\\* Injected list item/);
});

test('proposal validation rejects a different target and ungrounded replacement source', () => {
  const wrongTarget = proposal();
  assert.match(validateProposal(wrongTarget, evidence, { path: 'src/Other.cs', symbol: 'Calculate' }).errors.join(' '), /does not match the user-selected/);

  const inventedOriginal = proposal();
  inventedOriginal.changes[0].originalText = 'return 9m;';
  assert.match(validateProposal(inventedOriginal, evidence).errors.join(' '), /originalText was not found/);
});