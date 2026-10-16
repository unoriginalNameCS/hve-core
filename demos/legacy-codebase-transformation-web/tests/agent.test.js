'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assessProject } = require('../server/assess');
const { transformUnit, validateCases, validationFeedback } = require('../server/transform/agent');
const { INPUT_SCHEMA, buildRewritePrompt } = require('../server/transform/prompts');

const source = [
  'function calculate(temp) { return temp * 10; }',
  'function privateHelper(secret) { return secret; }',
  'module.exports = { calculate, privateHelper };'
].join('\n');
const path = 'src/sample.cjs';
const assessment = assessProject([{ path, content: source }]);
const unit = assessment.units.find((candidate) => candidate.name === 'calculate');
const sourceFiles = [{ path, content: source }];
const cases = Array.from({ length: 5 }, (_, index) => ({ description: `input ${index}`, args: [JSON.stringify(index)] }));
const replacementText = 'function calculate(value) { const multiplier = 10; return value * multiplier; }';

function mockRequestStructured(prompts) {
  let rewriteCount = 0;
  return async (prompt, { schemaName }) => {
    prompts.push(prompt);
    if (schemaName === 'characterisation_inputs') return { cases };
    rewriteCount += 1;
    return { replacementText, rationale: 'Use a descriptive parameter and a named constant.' };
  };
}

test('generates inputs, captures a baseline, gates the rewrite, and sends only the selected unit source', async () => {
  const prompts = [];
  const workspaceFiles = new Map([[path, Buffer.from(source)]]);
  let baselineCalls = 0;
  let compareCalls = 0;
  const result = await transformUnit({ unit, source, sourceFiles, files: workspaceFiles, rootName: 'sample', assessment }, {
    requestStructured: mockRequestStructured(prompts),
    captureBaseline: async (actualFiles, _root, _unit, receivedCases) => {
      baselineCalls += 1;
      assert.equal(actualFiles, workspaceFiles);
      assert.equal(receivedCases.length, 5);
      return { status: 'passed', cases: receivedCases.map((item) => ({ ...item, expected: { value: item.args[0] } })) };
    },
    compareRewrite: async (actualFiles) => {
      compareCalls += 1;
      assert.notEqual(actualFiles, workspaceFiles);
      assert.ok(actualFiles.get(path).toString('utf8').includes(replacementText));
      return { status: 'passed', cases: [] };
    }
  });
  assert.equal(result.status, 'ready', JSON.stringify(result.gates));
  assert.equal(result.attempts, 1);
  assert.equal(baselineCalls, 1);
  assert.equal(compareCalls, 1);
  assert.equal(prompts.some((prompt) => prompt.includes('privateHelper')), false);
  assert.ok(result.gates.every((item) => item.status === 'pass'));
});

test('input schema uses concrete JSON strings and decoded cases are safe data', () => {
  assert.deepEqual(INPUT_SCHEMA.properties.cases.items.properties.args.items, { type: 'string' });
  assert.deepEqual(validateCases({ cases: [{ description: 'object', args: ['{"status":"approved"}'] },
    { description: 'string', args: ['"hello"'] }, { description: 'number', args: ['4'] },
    { description: 'null', args: ['null'] }, { description: 'array', args: ['[1,2]'] }] }, { paramCount: 1 }), [
    { description: 'object', args: [{ status: 'approved' }] }, { description: 'string', args: ['hello'] },
    { description: 'number', args: [4] }, { description: 'null', args: [null] }, { description: 'array', args: [[1, 2]] }
  ]);
  assert.throws(() => validateCases({ cases: [{ description: 'code', args: ['function(){}'] }, ...cases.slice(1)] }, { paramCount: 1 }), /valid JSON/);
});

test('rewrite prompt names the exact identifier to rename and protects the signature finding', () => {
  const formatSource = 'function formatLine(a1, b1, c1, d1, e1, f1, val) { return val; }\nmodule.exports = { formatLine };';
  const formatAssessment = assessProject([{ path, content: formatSource }]);
  const formatUnit = formatAssessment.units.find((item) => item.name === 'formatLine');
  const prompt = buildRewritePrompt(formatUnit, { status: 'not-checked' }, formatAssessment);
  assert.match(prompt, /Vague or short identifier "val"\. Rename exactly that identifier/);
  assert.match(prompt, /too-many-params: leave the parameter count unchanged/);
  assert.match(prompt, /at most 39 non-blank lines/);
  const todoSource = 'function price(amount) {\n  // TODO: apply loyalty pricing\n  return amount;\n}\nmodule.exports = { price };';
  const todoAssessment = assessProject([{ path, content: todoSource }]);
  const todoPrompt = buildRewritePrompt(todoAssessment.units.find((item) => item.name === 'price'), { status: 'not-checked' }, todoAssessment);
  assert.match(todoPrompt, /delete the TODO\/FIXME\/HACK comment\. Do not implement what it describes/);
});

test('retry feedback lists unresolved findings', () => {
  const feedback = JSON.parse(validationFeedback([{ id: 'metric-improvement', status: 'fail', message: 'x' }], null,
    [{ ruleId: 'bad-variable-name', line: 3, message: 'Vague or short identifier "val".' }, { ruleId: 'too-many-params', line: 3, message: 'p' }]));
  assert.deepEqual(feedback.unresolvedFindings, ['bad-variable-name (line 3): Vague or short identifier "val".']);
  const withAttempt = JSON.parse(validationFeedback([], { cases: [{ description: 'zero', args: [0], passed: false,
    differences: [{ path: 'value[0].subtotal', expected: 0, actual: 30 }] }] }, [], 'function f() {}'));
  assert.equal(withAttempt.previousAttempt, 'function f() {}');
  assert.deepEqual(withAttempt.mismatches[0].differences, [{ path: 'value[0].subtotal', expected: 0, actual: 30 }]);
});

test('retries once with mismatch feedback and accepts a passing retry', async () => {
  const prompts = [];
  let rewriteCount = 0;
  const result = await transformUnit({ unit, source, sourceFiles, rootName: 'sample', assessment }, {
    requestStructured: async (prompt, { schemaName }) => {
      prompts.push(prompt);
      if (schemaName === 'characterisation_inputs') return { cases };
      rewriteCount += 1;
      return { replacementText, rationale: 'Refactor.' };
    },
    captureBaseline: async (_files, _root, _unit, receivedCases) => ({ status: 'passed', cases: receivedCases.map((item) => ({ ...item, expected: { value: item.args[0] } })) }),
    compareRewrite: async () => rewriteCount === 1 ? { status: 'failed', cases: [{ description: 'input 1', args: [1], expected: 1, actual: 2, passed: false }] } : { status: 'passed', cases: [] }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 2);
  assert.equal(rewriteCount, 2);
  assert.ok(prompts.at(-1).includes('Validation feedback'));
});

test('a behaviour mismatch reports how many cases differ and why runs failed', async () => {
  const result = await transformUnit({ unit, source, sourceFiles, rootName: 'sample', assessment }, {
    requestStructured: mockRequestStructured([]),
    captureBaseline: async (_files, _root, _unit, receivedCases) => ({ status: 'passed', cases: receivedCases.map((item) => ({ ...item, expected: { value: 1 } })) }),
    compareRewrite: async () => ({ status: 'failed', cases: [
      { description: 'a', args: [1], expected: { value: 1 }, actual: { value: 2 }, passed: false },
      { description: 'b', args: [2], expected: { value: 1 }, actual: { moduleError: { name: 'ReferenceError', message: 'x is not defined' } }, passed: false },
      { description: 'c', args: [3], expected: { value: 1 }, actual: { value: 1 }, passed: true }
    ] })
  });
  const gate = result.gates.find((item) => item.id === 'characterisation');
  assert.equal(result.status, 'rejected');
  assert.equal(gate.message, '2 of 3 cases returned a different result from the original (1 did not run: module error: x is not defined). See the case tabs below.');
});

test('permits a statically valid rewrite with a not-checked acknowledgement warning', async () => {
  const result = await transformUnit({ unit, source, sourceFiles, rootName: 'sample', assessment }, {
    requestStructured: mockRequestStructured([]),
    captureBaseline: async () => ({ status: 'not-checked', reason: 'Unsupported function context.' }),
    compareRewrite: async () => { throw new Error('comparison must not run'); }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.warningAcknowledgementRequired, true);
  assert.equal(result.gates.find((item) => item.id === 'characterisation').status, 'not-checked');
});

test('transforms a statement unit without requesting function inputs', async () => {
  const statementSource = 'var count = 4;\nmodule.exports = { count };';
  const statementAssessment = assessProject([{ path, content: statementSource }]);
  const statement = statementAssessment.units.find((candidate) => candidate.kind === 'statement');
  let schemaRequests = 0;
  const result = await transformUnit({ unit: statement, source: statementSource,
    sourceFiles: [{ path, content: statementSource }], rootName: 'sample', assessment: statementAssessment }, {
    requestStructured: async (_prompt, { schemaName }) => {
      if (schemaName === 'characterisation_inputs') { schemaRequests += 1; return { cases }; }
      return { replacementText: 'const count = 4;', rationale: 'Use a block-scoped declaration.' };
    }
  });
  assert.equal(result.status, 'ready', JSON.stringify(result.gates));
  assert.equal(schemaRequests, 0);
  assert.equal(result.warningAcknowledgementRequired, true);
});
