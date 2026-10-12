'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FindingStore } = require('../src/finding-store');
const { hashSource } = require('../src/workspace-scan');
const { ProposalStore, prepareApplyFindings } = require('../src/proposal-workflow');
const { prepareBehaviorCheck, runBehaviorCheck } = require('../src/behavior-check');
const { BehaviorCheckTool } = require('../src/extension');

async function appliedFixture(context, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-behavior-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve(__dirname, '../../../legacy-code-transformation/fixtures/node'), root, { recursive: true });
  const sourcePath = path.join(root, 'src/transfer.js');
  const originalBytes = await fs.readFile(sourcePath);
  const originalText = new TextDecoder().decode(originalBytes);
  const lines = originalText.split('\n');
  const replacementText = options.regression ? originalText.replace('accounts[destinationId] += amount;', 'accounts[destinationId] += amount + 1;') :
    originalText.replace('if (Object.hasOwn(accounts, sourceId))', 'if (Object.hasOwn(accounts, sourceId) === true)');
  const vscode = { workspace: { workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: root } }], textDocuments: [] } };
  const findings = new FindingStore();
  findings.addScan({ root, scanId: 'scan', findings: [{ id: 'finding', path: 'src/transfer.js', symbol: 'transfer',
    sourceHash: hashSource(originalText), category: 'complex-function-simplification', rationale: 'Make the boolean condition explicit.',
    functionRange: { startLine: 1, endLine: lines.length }, range: { startLine: 1, startCharacter: 0,
      endLine: lines.length, endCharacter: lines.at(-1).replace(/\r$/, '').length }, originalText, replacementText }] });
  const store = new ProposalStore();
  const prepared = await prepareApplyFindings(vscode, findings, store, ['finding']);
  assert.equal(prepared.status, 'ready');
  const ids = prepared.preview.proposalIds;
  ids.forEach((id) => store.setStatus(id, 'applied'));
  await fs.writeFile(sourcePath, replacementText);
  return { root, sourcePath, vscode, store, ids, originalBytes };
}

function fakeRunner(state, mode) {
  return async (args, cwd) => {
    state.calls += 1;
    state.directories.push(cwd);
    if (args[0] === '--version') return { exitCode: 0, stdout: mode === 'runtime' ? 'v22.0.0\n' : 'v24.19.0\n', stderr: '' };
    if (args[0] === '--test') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ success: mode !== 'tests',
      counts: { passed: mode === 'tests' ? 7 : 8, failed: mode === 'tests' ? 1 : 0, cancelled: 0, skipped: 0 } }) };
    const transformed = args[0].includes(`${path.sep}transformed${path.sep}`);
    const unknown = args[1] === 'unknown case';
    return { exitCode: unknown ? 2 : 0, stdout: unknown ? '' : JSON.stringify({ case: args[1],
      balances: mode === 'mismatch' && transformed ? 'different' : 'same' }), stderr: unknown ? '{"error":"unknown case"}' : '' };
  };
}

test('behavior prepare checks only the known applied banking fixture without executing code', async (context) => {
  const fixture = await appliedFixture(context);
  const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.preview.tests, 8);
  assert.equal(prepared.preview.sampleCases, 9);
  assert.ok(!JSON.stringify(prepared.preview).includes('function transfer'));
  assert.equal((await prepareBehaviorCheck(fixture.vscode, fixture.store, ['unknown'])).status, 'not-checked');
});

test('behavior check rejects dirty source, altered disk and non-banking snapshots without executing', async (context) => {
  const fixture = await appliedFixture(context);
  const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
  fixture.vscode.workspace.textDocuments = [{ uri: { fsPath: fixture.sourcePath }, isDirty: true }];
  assert.equal((await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids)).status, 'not-checked');
  fixture.vscode.workspace.textDocuments = [];
  await fs.appendFile(fixture.sourcePath, '\n// changed');
  let calls = 0;
  const result = await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, prepared.fingerprint, undefined,
    { chatApproved: true, runProcess: async () => { calls += 1; } });
  assert.equal(result.status, 'not-checked');
  assert.equal(calls, 0);
  const candidate = fixture.store.get(fixture.ids[0]);
  const unknownId = fixture.store.add({ ...candidate, finding: { ...candidate.finding, path: 'src/other.js' } });
  fixture.store.setStatus(unknownId, 'applied');
  assert.equal((await prepareBehaviorCheck(fixture.vscode, fixture.store, [unknownId])).status, 'not-checked');
});

test('behavior check cancellation stops before fixture execution', async (context) => {
  const fixture = await appliedFixture(context);
  const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
  const token = { isCancellationRequested: false };
  let calls = 0;
  const result = await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, prepared.fingerprint, token,
    { chatApproved: true, runProcess: async () => { calls += 1; token.isCancellationRequested = true;
      return { exitCode: 0, stdout: 'v24.19.0\n', stderr: '' }; } });
  assert.equal(result.status, 'not-checked');
  assert.equal(calls, 1);
});

test('real Node processes pass existing banking tests and all reset-state sample comparisons', async (context) => {
  const fixture = await appliedFixture(context);
  const saved = await fs.readFile(fixture.sourcePath);
  const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
  const result = await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, prepared.fingerprint, undefined,
    { chatApproved: true });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.tests.baseline.passed, 8);
  assert.equal(result.tests.transformed.passed, 8);
  assert.equal(result.sampleCases.matched, 9);
  assert.deepEqual(await fs.readFile(fixture.sourcePath), saved);
});

test('real Node processes detect a banking behavior regression without reverting source', async (context) => {
  const fixture = await appliedFixture(context, { regression: true });
  const saved = await fs.readFile(fixture.sourcePath);
  const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
  const result = await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, prepared.fingerprint, undefined,
    { chatApproved: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.tests.baseline.passed, 8);
  assert.ok(result.tests.transformed.failed > 0);
  assert.deepEqual(await fs.readFile(fixture.sourcePath), saved);
});

test('behavior execution requires separate approval and a fresh fingerprint', async (context) => {
  const fixture = await appliedFixture(context);
  const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
  const state = { calls: 0, directories: [] };
  for (const options of [{}, { chatApproved: true }]) {
    const result = await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, 'wrong', undefined,
      { ...options, runProcess: fakeRunner(state) });
    assert.equal(result.status, 'not-checked');
  }
  assert.equal(state.calls, 0);
  await fs.appendFile(path.join(fixture.root, 'src/cases.js'), '\n// changed');
  assert.equal((await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, prepared.fingerprint, undefined,
    { chatApproved: true, runProcess: fakeRunner(state) })).status, 'not-checked');
  assert.equal(state.calls, 0);
});

test('native behavior tool waits for a separate decision and consumes its preview once', async (context) => {
  const fixture = await appliedFixture(context);
  fixture.vscode.LanguageModelToolResult = class { constructor(content) { this.content = content; } };
  fixture.vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  const state = { calls: 0, directories: [] };
  const tool = new BehaviorCheckTool(fixture.vscode, fixture.store, { runProcess: fakeRunner(state, 'same') });
  const invoke = async (input) => JSON.parse((await tool.invoke({ input })).content[0].value);
  const declined = await invoke({ phase: 'prepare', proposalIds: fixture.ids });
  assert.equal(declined.status, 'awaiting-decision');
  assert.equal(state.calls, 0);
  assert.equal((await invoke({ phase: 'confirm', previewId: declined.previewId, decision: 'reject' })).status, 'not-checked');
  assert.equal(state.calls, 0);
  const preview = await invoke({ phase: 'prepare', proposalIds: fixture.ids });
  assert.equal((await invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve', proposalIds: fixture.ids })).status, 'rejected');
  assert.equal((await invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'passed');
  const calls = state.calls;
  assert.equal((await invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'not-checked');
  assert.equal(state.calls, calls);
});

test('behavior check compares tests and reset-state outputs in disposable copies without writing project source', async (context) => {
  for (const mode of ['same', 'mismatch', 'tests', 'runtime']) {
    const fixture = await appliedFixture(context);
    const saved = await fs.readFile(fixture.sourcePath);
    const prepared = await prepareBehaviorCheck(fixture.vscode, fixture.store, fixture.ids);
    const state = { calls: 0, directories: [] };
    const result = await runBehaviorCheck(fixture.vscode, fixture.store, fixture.ids, prepared.fingerprint, undefined,
      { chatApproved: true, runProcess: fakeRunner(state, mode) });
    assert.equal(result.status, mode === 'same' ? 'passed' : mode === 'runtime' ? 'not-checked' : 'failed');
    if (mode === 'same') {
      assert.equal(result.tests.baseline.passed, 8);
      assert.equal(result.tests.transformed.passed, 8);
      assert.equal(result.sampleCases.matched, 9);
    }
    assert.deepEqual(await fs.readFile(fixture.sourcePath), saved);
    for (const directory of state.directories) {
      assert.ok(!directory.startsWith(fixture.root));
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    }
  }
});
