'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyApprovedFindings,
  getSession,
  getTransformProgress,
  normalizeUploadPath,
  prepareUpload,
  prepareUploadedFiles,
  removeSession,
  replayAfterUpdate,
  safeTransformFailure,
  transformUnits
} = require('../server/workflow');

function prepareProject(path, content) {
  const bytes = Buffer.from(content);
  const preview = prepareUpload([{ id: 'file-0', path, size: bytes.length }], new Map([['file-0', bytes]]));
  return { preview, bytes };
}

function config() {
  return { apiKey: 'test', model: 'test-model', url: 'https://example.test' };
}

function readyProposal(unit, replacementText, options = {}) {
  return {
    unitId: unit.id,
    path: unit.path,
    name: unit.name,
    status: 'ready',
    originalText: unit.originalText,
    replacementText,
    rationale: 'Focused test proposal.',
    gates: [{ id: 'static', status: 'pass' }, { id: 'characterisation', status: options.baseline?.status === 'passed' ? 'pass' : 'not-checked' }],
    baseline: options.baseline ?? { status: 'not-checked', reason: 'Not available for this test.' },
    comparison: { status: options.baseline?.status === 'passed' ? 'passed' : 'not-checked' },
    residualFindings: [],
    warningAcknowledgementRequired: options.baseline?.status !== 'passed'
  };
}

test('upload paths reject traversal and conflicting manifests', () => {
  assert.equal(normalizeUploadPath('project/src/file.js'), 'project/src/file.js');
  assert.throws(() => normalizeUploadPath('../outside.js'), /invalid relative path/);
  assert.throws(() => normalizeUploadPath('C:/outside.js'), /invalid relative path/);
  assert.throws(() => prepareUploadedFiles([
    { id: 'file-0', path: 'project/one.js', size: 1 },
    { id: 'file-0', path: 'project/two.js', size: 1 }
  ], new Map([['file-0', Buffer.from('a')], ['file-1', Buffer.from('b')]])), /did not match their manifest/);
});

test('local-assessment runs during upload preparation without network or project execution', () => {
  const childProcess = require('node:child_process');
  const originalFetch = globalThis.fetch;
  const originalSpawn = childProcess.spawn;
  globalThis.fetch = () => { throw new Error('upload assessment attempted network access'); };
  childProcess.spawn = () => { throw new Error('upload assessment attempted project execution'); };
  let preview;
  try {
    ({ preview } = prepareProject('project/src/inspect.js', 'function inspect(temp) { return temp; }'));
    assert.ok(preview.assessment.findings.some((item) => item.ruleId === 'bad-variable-name'));
    assert.equal(preview.summary.findingCount, preview.assessment.findings.length);
    assert.equal(preview.sourceDisclosure, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
    if (preview) removeSession(preview.sessionId);
  }
});

test('transform-unit runs the approved selected-unit flow and exposes per-unit progress', async () => {
  const { preview } = prepareProject('project/src/inspect.js', 'function inspect(temp) { return temp; }');
  const unit = preview.assessment.units.find((item) => item.kind === 'function');
  let receivedFiles;
  const review = await transformUnits(preview.sessionId, { unitIds: [unit.id], approved: true }, {
    config: config(),
    transformUnit: async (input, options) => {
      receivedFiles = input.files;
      options.onProgress({ stage: 'rewrite' });
      return readyProposal(input.unit, 'function inspect(value) { return value; }');
    }
  });
  assert.equal(review.proposals.length, 1);
  assert.equal(review.proposals[0].status, 'ready');
  assert.ok(receivedFiles instanceof Map);
  assert.ok(receivedFiles.has('project/src/inspect.js'));
  assert.equal(getTransformProgress(preview.sessionId).stage, 'complete');
  removeSession(preview.sessionId);
});

test('dependency updates replay stable baselines against the upgraded copy', async () => {
  const session = { rootName: 'project' };
  const files = new Map([['project/package-lock.json', Buffer.from('{}')]]);
  const checked = { name: 'calc', unit: { id: 'u1' }, baseline: { status: 'passed', cases: [{}] } };
  const unchecked = { name: 'stmt', unit: { id: 'u2' }, baseline: { status: 'not-checked' } };
  const received = [];
  const passed = await replayAfterUpdate(session, [checked, unchecked], files, {
    compareRewrite: async (actualFiles, root, unit) => {
      received.push({ actualFiles, root, unit: unit.id });
      return { status: 'passed', cases: [{ passed: true }, { passed: true }] };
    }
  });
  assert.deepEqual(received, [{ actualFiles: files, root: 'project', unit: 'u1' }]);
  assert.deepEqual(passed, { status: 'passed', results: [{ name: 'calc', status: 'passed', reason: null, matched: 2, total: 2 }] });

  const failed = await replayAfterUpdate(session, [checked], files, {
    compareRewrite: async () => ({ status: 'failed', cases: [{ passed: true }, { passed: false }] })
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.results[0].matched, 1);
  assert.equal((await replayAfterUpdate(session, [unchecked], files)).status, 'not-run');
});

test('only approved findings are sent for each selected unit', async () => {
  const { preview } = prepareProject('project/src/inspect.js', 'function inspect(d, tmp) { return d + tmp; }');
  const unit = preview.assessment.units.find((item) => item.kind === 'function');
  const keep = unit.findings.find((item) => item.message.includes('"d"'));
  await assert.rejects(transformUnits(preview.sessionId, { unitIds: [unit.id], findingIds: [], approved: true }, { config: config() }),
    /Approve at least one finding for inspect/);
  removeSession(preview.sessionId);

  const second = prepareProject('project/src/inspect.js', 'function inspect(d, tmp) { return d + tmp; }').preview;
  let receivedFindings;
  const secondReview = await transformUnits(second.sessionId, { unitIds: [unit.id], findingIds: [keep.id], approved: true }, {
    config: config(),
    transformUnit: async (input) => {
      receivedFindings = input.unit.findings;
      return readyProposal(input.unit, 'function inspect(amount, tmp) { return amount + tmp; }');
    }
  });
  assert.deepEqual(receivedFindings.map((item) => item.id), [keep.id]);
  assert.deepEqual(secondReview.proposals[0].targetFindings.map((item) => [item.id, item.line, item.column]), [[keep.id, keep.line, keep.column]]);
  removeSession(second.sessionId);
});

test('dependency checks are skipped unless the user opts in', async () => {
  const { preview } = prepareProject('project/src/inspect.js', 'function inspect(temp) { return temp; }');
  const unit = preview.assessment.units.find((item) => item.kind === 'function');
  const review = await transformUnits(preview.sessionId, { unitIds: [unit.id], approved: true }, {
    config: config(),
    metadataFetchImpl: async () => { throw new Error('npm/OSV must not be called'); },
    transformUnit: async (input) => readyProposal(input.unit, 'function inspect(value) { return value; }')
  });
  assert.equal(review.dependencyAssessment.status, 'skipped');
  assert.equal(review.dependencyAssessment.requests, 0);
  removeSession(preview.sessionId);
});

test('failed proposals show safe Foundry diagnostics without exposing arbitrary runtime paths', async () => {
  assert.equal(safeTransformFailure(new Error('Foundry returned HTTP 400. Check the deployment and endpoint configuration.')),
    'Foundry returned HTTP 400. Check the deployment and endpoint configuration.');
  assert.equal(safeTransformFailure(new Error('Error: read failed at C:\\private\\source.js')),
    'Foundry or characterisation processing failed.');
});

test('apply rechecks the combined copy and stages a runnable characterization test', async () => {
  const content = 'function inspect(temp) { return temp; }\nmodule.exports = { inspect };';
  const { preview } = prepareProject('project/src/inspect.js', content);
  const unit = preview.assessment.units.find((item) => item.kind === 'function');
  const cases = [{ description: 'normal', args: ['x'], expected: { value: 'x' } }];
  const review = await transformUnits(preview.sessionId, { unitIds: [unit.id], approved: true }, {
    config: config(),
    transformUnit: async () => readyProposal(unit, 'function inspect(value) { return value; }', {
      baseline: { status: 'passed', cases }
    })
  });
  const proposalId = review.proposals[0].id;
  assert.match(review.proposals[0].testPreview.path, /^project\/__characterisation__\/.+\.test\.js$/);
  assert.ok(review.proposals[0].testPreview.content.includes('"description": "normal"'));
  const applied = await applyApprovedFindings(preview.sessionId, [proposalId], [], {
    compareRewrite: async () => ({ status: 'passed', cases: [] })
  });
  const session = getSession(preview.sessionId);
  assert.equal(applied.proposals, 1);
  assert.equal(session.files.get('project/src/inspect.js').toString(),
    'function inspect(value) { return value; }\nmodule.exports = { inspect };');
  assert.ok([...session.files.keys()].some((file) => file.startsWith('project/__characterisation__/') && file.endsWith('.test.js')));
  assert.equal(session.changeReport.testFiles.length, 1);
  assert.match(session.changeReport.testFiles[0], /^project\/__characterisation__\/.+\.test\.js$/);
  assert.equal(applied.testFiles, 1);
  assert.equal(session.changeReport.before.rating, preview.assessment.rating);
  assert.equal(session.changeReport.after.rating, session.assessment.rating);
  removeSession(preview.sessionId);
});

test('apply blocks combined behavior drift and requires not-checked acknowledgement', async () => {
  const content = 'function inspect(temp) { return temp; }\nmodule.exports = { inspect };';
  const { preview } = prepareProject('project/src/inspect.js', content);
  const unit = preview.assessment.units.find((item) => item.kind === 'function');
  const review = await transformUnits(preview.sessionId, { unitIds: [unit.id], approved: true }, {
    config: config(),
    transformUnit: async () => readyProposal(unit, 'function inspect(value) { return value; }', {
      baseline: { status: 'passed', cases: [{ description: 'normal', args: ['x'], expected: {} }] }
    })
  });
  await assert.rejects(applyApprovedFindings(preview.sessionId, [review.proposals[0].id], [], {
    compareRewrite: async () => ({ status: 'failed', cases: [] })
  }), /Combined selected changes did not preserve/);
  assert.equal(getSession(preview.sessionId).applied, false);
  removeSession(preview.sessionId);

  const { preview: statementPreview } = prepareProject('statement/src/value.js', 'var amount = 4;');
  const statement = statementPreview.assessment.units.find((item) => item.kind === 'statement');
  const statementReview = await transformUnits(statementPreview.sessionId, { unitIds: [statement.id], approved: true }, {
    config: config(),
    transformUnit: async () => readyProposal(statement, 'const amount = 4;')
  });
  await assert.rejects(applyApprovedFindings(statementPreview.sessionId, [statementReview.proposals[0].id]), /Acknowledge every not-checked/);
  await applyApprovedFindings(statementPreview.sessionId, [statementReview.proposals[0].id], [statementReview.proposals[0].id]);
  assert.equal(getSession(statementPreview.sessionId).applied, true);
  removeSession(statementPreview.sessionId);
});
