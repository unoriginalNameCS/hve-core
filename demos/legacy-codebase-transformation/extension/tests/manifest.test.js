'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { registerApplyProposalTool, registerFindingReviewTool, registerProposalTool, registerScanTool } = require('../src/extension');
const { FindingStore } = require('../src/finding-store');
const { hashSource } = require('../src/workspace-scan');
const { APPLY_CONSENT, applyProposal, captureSourceSnapshot, generateProposal, ProposalStore } = require('../src/proposal-workflow');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package-lock.json'), 'utf8'));

test('package owns one manually invoked Codebase-Level agent and no Targeted workflow artifacts', () => {
  assert.equal(manifest.contributes.chatAgents.length, 1);
  const agentPath = path.resolve(extensionRoot, manifest.contributes.chatAgents[0].path);
  assert.ok(path.relative(extensionRoot, agentPath) && !path.relative(extensionRoot, agentPath).startsWith('..'));
  const agentContent = fs.readFileSync(agentPath, 'utf8');
  assert.match(agentContent, /^name: Codebase-Level Legacy Code Transformation Agent$/m);
  assert.match(agentContent, /^user-invocable: true$/m);
  assert.match(agentContent, /^disable-model-invocation: true$/m);
  assert.match(agentContent, /^agents: \[\]$/m);
  assert.doesNotMatch(agentContent, /legacy_code_transformation_demo_/);
  assert.doesNotMatch(manifest.contributes.chatAgents[0].path, /legacy-code-transformation\/extension/);
});

test('package and lock names align and every native tool matches the agent allowlist', () => {
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  const agentContent = fs.readFileSync(path.resolve(extensionRoot, manifest.contributes.chatAgents[0].path), 'utf8');
  const referenceNames = new Set();
  for (const tool of manifest.contributes.languageModelTools) {
    assert.equal(tool.canBeReferencedInPrompt, true);
    assert.equal(tool.toolReferenceName, tool.name);
    assert.ok(agentContent.split(/\r?\n/).includes(`  - ${tool.toolReferenceName}`));
    assert.ok(!referenceNames.has(tool.toolReferenceName));
    referenceNames.add(tool.toolReferenceName);
  }
  assert.equal(manifest.contributes.languageModelTools.length, 4);
});

test('native registrations are package-local and own one shared finding store', () => {
  const registrations = [];
  const context = { subscriptions: [] };
  const vscode = { lm: { registerTool: (name, tool) => {
    const registration = { name, tool, dispose() {} };
    registrations.push(registration);
    return registration;
  } } };
  const store = {};
  const proposalStore = {};
  registerScanTool(vscode, context, store);
  registerFindingReviewTool(vscode, context, store);
  registerProposalTool(vscode, context, store, proposalStore);
  registerApplyProposalTool(vscode, context, store, proposalStore);
  assert.deepEqual(registrations.map(({ name }) => name).sort(),
    manifest.contributes.languageModelTools.map(({ name }) => name).sort());
  assert.ok(registrations.filter(({ name }) => !name.endsWith('_generate_proposal') && !name.endsWith('_apply_proposal'))
    .every(({ tool }) => tool.store === store));
  const proposal = registrations.find(({ name }) => name === 'legacy_codebase_transformation_demo_generate_proposal');
  assert.equal(proposal.tool.findingStore, store);
  assert.equal(proposal.tool.proposalStore, proposalStore);
  const apply = registrations.find(({ name }) => name === 'legacy_codebase_transformation_demo_apply_proposal');
  assert.equal(apply.tool.findingStore, store);
  assert.equal(apply.tool.proposalStore, proposalStore);
  assert.equal(context.subscriptions.length, 4);
});

async function approvedFinding(context) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lcb-proposal-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const originalText = 'function sample() { return 0 + 1; }';
  const source = `// keep π\r\n${originalText}\r\nconst sentinel = 'unchanged';\r\n`;
  await fsp.writeFile(path.join(root, 'sample.js'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')
  ]));
  const findingStore = new FindingStore();
  const range = { startLine: 2, startCharacter: 0, endLine: 2, endCharacter: originalText.length };
  findingStore.addScan({ root, scanId: 'scan', findings: [{
    id: 'finding-id', scanId: 'scan', path: 'sample.js', sourceHash: hashSource(source),
    symbol: 'sample', category: 'repeated-local-expression', rationale: 'The expression can be simplified.',
    confidence: 'medium', functionRange: { startLine: 2, endLine: 2 }, range,
    originalText, status: 'new'
  }] });
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: root } }], textDocuments: [] },
    window: { showWarningMessage: async () => 'Send context and draft proposal' },
    LanguageModelChatMessage: { User: (content) => ({ content }) }
  };
  await findingStore.select(vscode, 'finding-id');
  await findingStore.approve(vscode, 'finding-id');
  return { root, source, findingStore, vscode };
}

async function draftProposal(fixture, proposalStore) {
  fixture.vscode.window.showWarningMessage = async () => 'Send context and draft proposal';
  return generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', {
    vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() { throw new Error('Injected request should be used.'); }
  }, undefined, undefined, { requestModel: async () => JSON.stringify({
    summary: 'Simplify the expression.', replacementText: 'function sample() { return 1; }',
    rationale: 'The arithmetic is constant.', unknowns: []
  }) });
}

test('proposal requires a currently approved finding before consent or model calls', async (context) => {
  const fixture = await approvedFinding(context);
  const findings = new FindingStore();
  const proposalStore = new ProposalStore();
  let requests = 0;
  const result = await generateProposal(fixture.vscode, findings, proposalStore, 'finding-id',
    { sendRequest() { requests += 1; } }, undefined, undefined, { requestModel: async () => { requests += 1; } });
  assert.equal(result.status, 'rejected');
  assert.equal(requests, 0);
  assert.deepEqual(proposalStore.list(), []);
});

test('proposal asks separate per-proposal consent and returns one exact unverified span', async (context) => {
  const fixture = await approvedFinding(context);
  let permissionCalls = 0;
  let modelCalls = 0;
  fixture.vscode.window.showWarningMessage = async (message, options, label) => {
    permissionCalls += 1;
    assert.equal(options.modal, true);
    assert.ok(options.detail.includes('Requested refactor:'));
    assert.ok(options.detail.includes('Destination: test / test-model'));
    assert.ok(options.detail.includes('Recollected source context:'));
    assert.equal(label, 'Send context and draft proposal');
    return label;
  };
  const proposalStore = new ProposalStore();
  const result = await generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', {
    vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() { throw new Error('Injected request should be used.'); }
  }, undefined, undefined, { requestModel: async (prompt) => {
    modelCalls += 1;
    const submitted = JSON.parse(prompt);
    assert.match(submitted.context, /function sample/);
    return JSON.stringify({ summary: 'Remove the redundant arithmetic.', replacementText: 'function sample() { return 1; }',
      rationale: 'The expression has a constant result.', unknowns: ['Callers were not analyzed.'] });
  } });
  assert.equal(permissionCalls, 1);
  assert.equal(modelCalls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.originalText, 'function sample() { return 0 + 1; }');
  assert.equal(result.replacementText, 'function sample() { return 1; }');
  assert.equal(result.tests, 'not run');
  assert.match(result.report, /No project tests or commands were run/);
  assert.equal((await fsp.readFile(path.join(fixture.root, 'sample.js'), 'utf8')), `\ufeff${fixture.source}`);
  assert.equal(proposalStore.list().length, 1);
});

test('declined proposal source consent and stale findings make no model request', async (context) => {
  const fixture = await approvedFinding(context);
  let requests = 0;
  const model = { vendor: 'test', id: 'test-model', sendRequest() { requests += 1; } };
  const proposalStore = new ProposalStore();
  fixture.vscode.window.showWarningMessage = async () => undefined;
  const declined = await generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', model,
    undefined, undefined, { requestModel: async () => { requests += 1; } });
  assert.equal(declined.status, 'cancelled');
  assert.equal(requests, 0);

  await fsp.appendFile(path.join(fixture.root, 'sample.js'), '// changed\n');
  await assert.rejects(generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', model,
    undefined, undefined, { requestModel: async () => { requests += 1; } }), /source changed/);
  assert.equal(requests, 0);
  assert.deepEqual(proposalStore.list(), []);
});

test('applying a proposal requires exact-diff confirmation and writes only its approved span', async (context) => {
  const fixture = await approvedFinding(context);
  let text = fixture.source;
  let dirty = false;
  let version = 1;
  const document = {
    uri: { fsPath: path.join(fixture.root, 'sample.js') },
    get isDirty() { return dirty; },
    get version() { return version; },
    getText: () => text,
    positionAt: (offset) => ({ offset }),
    async save() {
      await fsp.writeFile(this.uri.fsPath, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')
      ]));
      dirty = false;
      version += 1;
      return true;
    }
  };
  fixture.vscode.workspace.textDocuments = [document];
  fixture.vscode.workspace.openTextDocument = async () => document;
  fixture.vscode.vscodeEdit = null;
  fixture.vscode.WorkspaceEdit = class {
    replace(uri, range, replacement) { this.operation = { uri, range, replacement }; }
  };
  fixture.vscode.Range = class {
    constructor(start, end) { this.start = start; this.end = end; }
  };
  fixture.vscode.Uri = { file: (fsPath) => ({ fsPath }) };
  fixture.vscode.workspace.applyEdit = async (edit) => {
    const { start, end } = edit.operation.range;
    text = text.slice(0, start.offset) + edit.operation.replacement + text.slice(end.offset);
    dirty = true;
    return true;
  };
  let approvalLabels = 0;
  fixture.vscode.window.showWarningMessage = async (_message, options, label) => {
    approvalLabels += 1;
    if (approvalLabels === 1) return 'Send context and draft proposal';
    assert.equal(options.modal, true);
    assert.ok(options.detail.includes('Exact original:'));
    assert.ok(options.detail.includes('function sample() { return 1; }'));
    return label;
  };
  const proposalStore = new ProposalStore();
  const generated = await generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', {
    vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() { throw new Error('Injected request should be used.'); }
  }, undefined, undefined, { requestModel: async () => JSON.stringify({
    summary: 'Simplify the expression.', replacementText: 'function sample() { return 1; }',
    rationale: 'The arithmetic is constant.', unknowns: []
  }) });
  assert.equal(generated.status, 'ready');
  const applied = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.application, 'applied');
  assert.equal(approvalLabels, 2);
  assert.equal(applied.tests, 'not run');
  const writtenBytes = await fsp.readFile(document.uri.fsPath);
  assert.equal(applied.resultingSourceHash, createHash('sha256').update(writtenBytes).digest('hex'));
  assert.equal(writtenBytes.toString('utf8'), "\ufeff// keep π\r\nfunction sample() { return 1; }\r\nconst sentinel = 'unchanged';\r\n");
  assert.equal(proposalStore.list()[0].status, 'applied');
  const repeated = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(repeated.status, 'rejected');
  assert.equal(approvalLabels, 2);
});

test('apply cancellation, stale source, dirty buffers, and modal races never write a proposal', async (context) => {
  const fixture = await approvedFinding(context);
  const proposalStore = new ProposalStore();
  const generated = await draftProposal(fixture, proposalStore);
  assert.equal(generated.status, 'ready');
  let confirmations = 0;
  fixture.vscode.window.showWarningMessage = async () => {
    confirmations += 1;
    return undefined;
  };
  const cancelled = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(proposalStore.list()[0].status, 'pending');
  assert.equal((await fsp.readFile(path.join(fixture.root, 'sample.js'), 'utf8')), `\ufeff${fixture.source}`);
  assert.equal(confirmations, 1);

  await fsp.appendFile(path.join(fixture.root, 'sample.js'), '// changed\r\n');
  await assert.rejects(captureSourceSnapshot(fixture.vscode, fixture.findingStore.getApproved('finding-id')));
  const stale = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(stale.status, 'stale', JSON.stringify(stale));
  assert.equal(proposalStore.list()[0].status, 'stale');
  assert.equal(confirmations, 1);

  const dirtyFixture = await approvedFinding(context);
  const dirtyStore = new ProposalStore();
  const dirtyProposal = await draftProposal(dirtyFixture, dirtyStore);
  const dirtyFilePath = await fsp.realpath(path.join(dirtyFixture.root, 'sample.js'));
  dirtyFixture.vscode.workspace.textDocuments = [{
    uri: { fsPath: dirtyFilePath }, isDirty: true, version: 1
  }];
  await assert.rejects(captureSourceSnapshot(dirtyFixture.vscode, dirtyFixture.findingStore.getApproved('finding-id')));
  const dirtyResult = await applyProposal(dirtyFixture.vscode, dirtyFixture.findingStore, dirtyStore, dirtyProposal.proposalId);
  assert.equal(dirtyResult.status, 'stale');
  assert.equal(dirtyStore.list()[0].status, 'stale');
  assert.equal((await fsp.readFile(path.join(dirtyFixture.root, 'sample.js'), 'utf8')), `\ufeff${dirtyFixture.source}`);

  const raceFixture = await approvedFinding(context);
  const raceStore = new ProposalStore();
  const raceProposal = await draftProposal(raceFixture, raceStore);
  let raceConfirmations = 0;
  raceFixture.vscode.window.showWarningMessage = async (_message, _options, label) => {
    raceConfirmations += 1;
    assert.equal(label, APPLY_CONSENT);
    await fsp.appendFile(path.join(raceFixture.root, 'sample.js'), '// concurrent edit\r\n');
    return label;
  };
  const raced = await applyProposal(raceFixture.vscode, raceFixture.findingStore, raceStore, raceProposal.proposalId);
  assert.equal(raced.status, 'stale');
  assert.equal(raceStore.list()[0].status, 'stale');
  assert.equal(raceConfirmations, 1);
  assert.equal((await fsp.readFile(path.join(raceFixture.root, 'sample.js'), 'utf8')),
    `\ufeff${raceFixture.source}// concurrent edit\r\n`);
});
