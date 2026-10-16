'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assessProject } = require('../server/assess');
const { evaluateReplacement } = require('../server/transform/gates');

function prepare(source, unitName = 'calculate') {
  const path = 'src/sample.cjs';
  const assessment = assessProject([{ path, content: source }]);
  const unit = assessment.units.find((candidate) => candidate.name === unitName);
  return { path, source, unit, assessment, files: [{ path, content: source }] };
}

function gateStatus(result, id) {
  return result.gates.find((item) => item.id === id)?.status;
}

test('accepts a same-span rewrite that preserves the signature and improves targeted smells', () => {
  const fixture = prepare('function calculate(temp) { if (temp > 10) return temp * 0.15; return 0; }\nmodule.exports = { calculate };');
  const replacement = [
    'function calculate(amount) {',
    '  const minimumAmount = 10;',
    '  const discountRate = 0.15;',
    '  if (amount > minimumAmount) return amount * discountRate;',
    '  return 0;',
    '}',
    'function applyDiscount(amount, rate) { return amount * rate; }'
  ].join('\n');
  const result = evaluateReplacement({ ...fixture, replacementText: replacement });
  assert.equal(result.accepted, true, JSON.stringify(result.gates));
  assert.equal(gateStatus(result, 'exact-span'), 'pass');
  assert.equal(gateStatus(result, 'source-hash'), 'pass');
  assert.equal(gateStatus(result, 'invariants'), 'pass');
  assert.equal(gateStatus(result, 'metric-improvement'), 'pass');
  assert.equal(gateStatus(result, 'no-new-findings'), 'pass');
});

test('rejects invalid syntax and changed signatures or exports', () => {
  const fixture = prepare('function calculate(value) { return value + 3; }\nmodule.exports = { calculate };');
  const invalid = evaluateReplacement({ ...fixture, replacementText: 'function calculate(value) {' });
  assert.equal(gateStatus(invalid, 'parse'), 'fail');

  const changedSignature = evaluateReplacement({ ...fixture, replacementText: 'function calculate(value, extra) { return value + extra; }' });
  assert.equal(gateStatus(changedSignature, 'invariants'), 'fail');

  const changedExports = evaluateReplacement({ ...fixture, replacementText: 'function calculate(value) { return value + 3; }\nmodule.exports = { other: calculate };' });
  assert.equal(gateStatus(changedExports, 'invariants'), 'fail');
});

test('rejects a helper that collides with an existing module binding', () => {
  const fixture = prepare('function calculate(temp) { return temp + 8; }\nfunction normalize(value) { return value; }\nmodule.exports = { calculate, normalize };');
  const replacement = 'function calculate(value) { return normalizeValue(value); }\nfunction normalize(value) { return value; }';
  const result = evaluateReplacement({ ...fixture, replacementText: replacement });
  assert.equal(gateStatus(result, 'invariants'), 'fail');
  assert.match(result.gates.find((item) => item.id === 'invariants').message, /already exists/);
});

test('rejects replacements that introduce a warning-level finding', () => {
  const fixture = prepare('function calculate(temp) { return temp + 1; }\nmodule.exports = { calculate };');
  const result = evaluateReplacement({ ...fixture, replacementText: 'function calculate(value) { return value + 99; }' });
  assert.equal(gateStatus(result, 'no-new-findings'), 'fail');
});

test('allows a targeted high finding to reduce to warning without treating it as new', () => {
  const fixture = prepare([
    'function inspect(value) {',
    '  if (value) {',
    '    if (value) {',
    '      if (value) {',
    '        if (value) {',
    '          if (value) return true;',
    '        }',
    '      }',
    '    }',
    '  }',
    '  return false;',
    '}',
    'module.exports = { inspect };'
  ].join('\n'), 'inspect');
  const result = evaluateReplacement({ ...fixture, replacementText: [
    'function inspect(value) {',
    '  if (value) {',
    '    if (value) {',
    '      if (value) return true;',
    '    }',
    '  }',
    '  return false;',
    '}'
  ].join('\n') });
  assert.equal(gateStatus(result, 'metric-improvement'), 'pass');
  assert.equal(gateStatus(result, 'no-new-findings'), 'pass');
});

test('allows unresolved too-many-params when another finding improves and preserves the signature', () => {
  const fixture = prepare('function formatLine(a, b, c, d, e, f, val) { return val; }\nmodule.exports = { formatLine };', 'formatLine');
  const result = evaluateReplacement({ ...fixture, replacementText: 'function formatLine(a, b, c, d, e, f, value) { return value; }' });
  assert.equal(result.accepted, true, JSON.stringify(result.gates));
  assert.ok(result.residualFindings.some((item) => item.ruleId === 'too-many-params'));
});

test('metric-improvement only requires the approved findings and matches the exact identifier', () => {
  const fixture = prepare('function calculate(d, tmp) { return d + tmp; }\nmodule.exports = { calculate };');
  const approved = { ...fixture.unit, findings: fixture.unit.findings.filter((item) => item.message.includes('"d"')) };
  assert.equal(approved.findings.length, 1);
  const renamedApproved = evaluateReplacement({ ...fixture, unit: approved, replacementText: 'function calculate(amount, tmp) { return amount + tmp; }' });
  assert.equal(gateStatus(renamedApproved, 'metric-improvement'), 'pass');
  const renamedOther = evaluateReplacement({ ...fixture, unit: approved, replacementText: 'function calculate(d, extra) { return d + extra; }' });
  assert.equal(gateStatus(renamedOther, 'metric-improvement'), 'fail');
});

test('rejects unsafe var-to-const and use-before-declaration changes', () => {
  const reassigned = prepare('var amount = 1;\namount += 2;\nmodule.exports = { amount };', 'VariableDeclaration');
  const constResult = evaluateReplacement({ ...reassigned, replacementText: 'const amount = 1;' });
  assert.equal(gateStatus(constResult, 'statement-scope'), 'fail');

  const beforeDeclaration = prepare('console.log(amount);\nvar amount = 1;\nmodule.exports = { amount };', 'VariableDeclaration');
  const letResult = evaluateReplacement({ ...beforeDeclaration, replacementText: 'let amount = 1;' });
  assert.equal(gateStatus(letResult, 'statement-scope'), 'fail');
});
