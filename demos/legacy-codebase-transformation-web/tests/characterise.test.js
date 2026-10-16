'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assessProject } = require('../server/assess');
const { captureBaseline, characterisationEligibility, compareRewrite, hasTopLevelSideEffects } = require('../server/characterise/harness');
const { renderTestFile } = require('../server/characterise/export');
const { serialise } = require('../server/characterise/serialise');
const { describeDifferences } = require('../server/characterise/diff');

const rootName = 'fixture';

test('describeDifferences names the changed field in serialised outcomes', () => {
  const expected = { value: serialise([{ subtotal: 0, tax: -7.42 }]), error: null };
  const actual = { value: serialise([{ subtotal: 0, tax: 0 }]), error: null };
  assert.deepEqual(describeDifferences(expected, actual), [{ path: 'value[0].tax', expected: -7.42, actual: 0 }]);
});

function project(source, exported = true) {
  const moduleSource = `${source}\nmodule.exports = ${exported ? '{ calculate, clock }' : '{ unrelated: true }'};\n`;
  const files = new Map([
    [`${rootName}/package.json`, Buffer.from(JSON.stringify({ name: 'fixture', version: '1.0.0' }))],
    [`${rootName}/src/math.cjs`, Buffer.from(moduleSource)]
  ]);
  const assessment = assessProject([{ path: `${rootName}/src/math.cjs`, content: moduleSource }]);
  const unit = assessment.units.find((item) => item.name === 'calculate');
  return { files, unit };
}

const cases = [
  { description: 'zero', args: [0] },
  { description: 'one', args: [1] },
  { description: 'two', args: [2] },
  { description: 'negative', args: [-1] },
  { description: 'four', args: [4] }
];

test('serialises special values and circular references deterministically', () => {
  const circular = { value: Number.NaN, missing: undefined, amount: 12n, date: new Date('2024-01-01T00:00:00.000Z') };
  circular.self = circular;
  assert.deepEqual(serialise(circular), {
    $type: 'object',
    entries: [
      ['amount', { $type: 'bigint', value: '12' }],
      ['date', { $type: 'date', value: '2024-01-01T00:00:00.000Z' }],
      ['missing', { $type: 'undefined' }],
      ['self', { $type: 'reference', path: '$' }],
      ['value', { $type: 'number', value: 'NaN' }]
    ]
  });
});

test('captures and compares all five stable cases in the permission-limited runner', async () => {
  const source = 'async function calculate(input) { input.calls = (input.calls || 0) + 1; console.log("value", input.value); if (input.value < 0) throw new Error("negative"); return input.value * 2; }\nfunction clock() { return Date.now(); }';
  const fixture = project(source);
  fixture.files.set(`${rootName}/src/math.cjs`, Buffer.from(`${source}\nmodule.exports = { calculate, clock };\n`));
  const inputs = [-1, 0, 1, 2, 4].map((value) => ({ description: `value ${value}`, args: [{ value }] }));
  const baseline = await captureBaseline(fixture.files, rootName, fixture.unit, inputs);
  assert.equal(baseline.status, 'passed');
  assert.equal(baseline.stableCases, 5);
  assert.deepEqual(baseline.cases.find((item) => item.description === 'value -1').expected.error,
    { name: 'Error', message: 'negative' });
  assert.equal(baseline.cases[0].expected.console.length, 1);
  assert.equal(JSON.stringify(baseline.cases[1].expected.argsAfter).includes('calls'), true);
  const comparison = await compareRewrite(fixture.files, rootName, fixture.unit, baseline);
  assert.equal(comparison.status, 'passed');
  assert.ok(comparison.cases.every((item) => item.passed));
});

test('rejects a rewrite whose output differs from the captured baseline', async () => {
  const fixture = project('function calculate(value) { return value * 2; }\nfunction clock() { return 0; }');
  const baseline = await captureBaseline(fixture.files, rootName, fixture.unit, cases);
  const changed = new Map(fixture.files);
  changed.set(fixture.unit.path, Buffer.from('function calculate(value) { return value * 3; }\nmodule.exports = { calculate, clock };\n'));
  const comparison = await compareRewrite(changed, rootName, fixture.unit, baseline);
  assert.equal(comparison.status, 'failed');
  assert.ok(comparison.cases.some((item) => !item.passed));
});

test('drops unstable cases and marks a weak baseline not-checked', async () => {
  const fixture = project('function calculate(value) { return value; }');
  let runNumber = 0;
  const baseline = await captureBaseline(fixture.files, rootName, fixture.unit, cases, {
    executeCase: async (_workspace, args) => {
      runNumber += 1;
      const caseNumber = Math.floor((runNumber - 1) / 2);
      return { status: 'passed', outcome: { value: caseNumber < 2 ? args[0] : runNumber, error: null, argsAfter: args, console: [] } };
    }
  });
  assert.equal(baseline.status, 'not-checked');
  assert.equal(baseline.stableCases, undefined);
  assert.equal(baseline.cases.length, 2);
});

test('marks timeouts and executable top-level expressions not-checked', async () => {
  const fixture = project('function calculate(value) { while (true) {} }');
  const timeout = await captureBaseline(fixture.files, rootName, fixture.unit, cases, { timeoutMs: 100 });
  assert.equal(timeout.status, 'not-checked');

  const sideEffect = project('console.log("loaded");\nfunction calculate(value) { return value; }');
  assert.deepEqual(characterisationEligibility(sideEffect.unit, Buffer.from(sideEffect.files.get(sideEffect.unit.path)).toString()), {
    status: 'not-checked', reason: 'The module has executable top-level expressions.'
  });
  assert.equal(hasTopLevelSideEffects(require('../server/assess/parse').parseSource('const lib = require("lodash"); module.exports = { lib };').ast), false);
});

test('exports a runnable node:test file for a non-exported target', async () => {
  const fixture = project('function calculate(value) { return value + 1; }', false);
  fixture.files.set(fixture.unit.path, Buffer.from('function calculate(value) { return value + 1; }\nmodule.exports = { unrelated: true };\n'));
  const baseline = await captureBaseline(fixture.files, rootName, fixture.unit, cases);
  assert.equal(baseline.status, 'passed');
  const testFile = renderTestFile({ unit: fixture.unit, rootName, baseline });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tech-debt-exported-test-'));
  try {
    const projectRoot = path.join(tempRoot, rootName);
    const testDirectory = path.join(projectRoot, '__characterisation__');
    await fs.mkdir(testDirectory, { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'math.cjs'), fixture.files.get(fixture.unit.path));
    const outputPath = path.join(testDirectory, 'math.calculate.test.cjs');
    await fs.writeFile(outputPath, testFile);
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', outputPath], { cwd: projectRoot, encoding: 'utf8', env: childEnvironment });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}${result.stderr}`, /pass 5/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
