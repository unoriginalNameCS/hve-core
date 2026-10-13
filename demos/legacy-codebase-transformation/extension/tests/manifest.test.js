'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ApplyProposalTool, GenerateProposalTool, ReviewFindingsTool, TransformCodebaseTool, UpdateDependenciesTool, registerApplyProposalTool, registerBehaviorCheckTool, registerDependencyAssessmentTool, registerDependencyUpdateTool, registerFindingReviewTool, registerProposalTool, registerScanTool, registerTransformCodebaseTool } = require('../src/extension');
const { FindingStore } = require('../src/finding-store');
const { hashSource } = require('../src/workspace-scan');
const { validateFindingResponse } = require('../src/scan-pipeline');
const { renderScanReport } = require('../src/scan-report');
const { applyProposal, applyProposalBatch, captureSourceSnapshot, contentHash, generateProposal, prepareApplyProposal, prepareApplyProposalBatch, prepareProposalRequest, ProposalStore, renderProposalReport } = require('../src/proposal-workflow');

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
  assert.match(agentContent, /action: review/);
  assert.match(agentContent, /Never apply without an explicit approval reply/);
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
  assert.equal(manifest.contributes.languageModelTools.length, 8);
  const tools = Object.fromEntries(manifest.contributes.languageModelTools.map((tool) => [tool.name, tool]));
  for (const name of [
    'legacy_codebase_transformation_demo_scan_workspace',
    'legacy_codebase_transformation_demo_generate_proposal',
    'legacy_codebase_transformation_demo_apply_proposal',
    'legacy_codebase_transformation_demo_check_behavior',
    'legacy_codebase_transformation_demo_assess_dependencies'
  ]) {
    assert.deepEqual(tools[name].inputSchema.properties.phase.enum, ['prepare', 'confirm']);
  }
  const reviewSchema = tools.legacy_codebase_transformation_demo_review_findings.inputSchema;
  assert.ok(reviewSchema.properties.action.enum.includes('disposition'));
  assert.equal(reviewSchema.properties.approveIds.uniqueItems, true);
  assert.equal(reviewSchema.properties.rejectIds.uniqueItems, true);
  assert.equal(tools.legacy_codebase_transformation_demo_scan_workspace.inputSchema.properties.scanId.type, 'string');
  assert.equal(tools.legacy_codebase_transformation_demo_scan_workspace.inputSchema.properties.includeDependencies.type, 'boolean');
  assert.match(tools.legacy_codebase_transformation_demo_scan_workspace.modelDescription, /up to five focused before\/after proposals/);
  assert.deepEqual(tools.legacy_codebase_transformation_demo_transform_codebase.inputSchema.properties.action.enum, ['review', 'apply']);
  const batchSchema = tools.legacy_codebase_transformation_demo_apply_proposal.inputSchema.properties.proposalIds;
  assert.equal(batchSchema.type, 'array');
  assert.equal(batchSchema.uniqueItems, true);
  assert.equal(batchSchema.minItems, 1);
  assert.equal(batchSchema.maxItems, 30);
  const findingSchema = tools.legacy_codebase_transformation_demo_apply_proposal.inputSchema.properties.findingIds;
  assert.equal(findingSchema.type, 'array');
  assert.equal(findingSchema.uniqueItems, true);
  assert.equal(findingSchema.minItems, 1);
  assert.equal(findingSchema.maxItems, 30);
  const dependencySchema = tools.legacy_codebase_transformation_demo_assess_dependencies.inputSchema;
  assert.equal(dependencySchema.additionalProperties, false);
  assert.deepEqual(dependencySchema.oneOf[0].required, ['projectRoot']);
  assert.deepEqual(dependencySchema.oneOf[1].required, ['previewId', 'decision']);
  assert.deepEqual(dependencySchema.oneOf[1].not.required, ['projectRoot']);
  assert.deepEqual(dependencySchema.oneOf[0].not.anyOf.map((entry) => entry.required), [['previewId'], ['decision']]);
  const updateTool = tools.legacy_codebase_transformation_demo_update_dependencies;
  assert.deepEqual(updateTool.inputSchema.properties.phase.enum, ['prepare', 'resolve', 'apply']);
  assert.equal(updateTool.inputSchema.properties.updates.maxItems, 20);
  assert.match(updateTool.modelDescription, /--package-lock-only/);
  const transformTool = tools.legacy_codebase_transformation_demo_transform_codebase;
  assert.deepEqual(transformTool.inputSchema.properties.action.enum, ['review', 'apply']);
  assert.match(transformTool.modelDescription, /one report/i);
  assert.match(agentContent, /Use only `legacy_codebase_transformation_demo_transform_codebase`/);
  assert.match(agentContent, /Approve or reject this report/);
  assert.doesNotMatch(agentContent, /sharing preview|Apply Selected npm Version Updates/);
});

test('scan report uses the report approval workflow instead of legacy per-finding gates', () => {
  const report = renderScanReport({ status: 'completed', root: '/sample', findings: [], files: 0, bytes: 0,
    filesReviewed: 0, sharedBytes: 0, requests: 0, projectedRequests: 0, batchNumber: 1,
    reviewedChunks: [], remainingChunks: 0, canContinue: false, scanId: 'scan-id' });
  assert.match(report, /Review the Transformation Plan before approving it/);
  assert.doesNotMatch(report, /Select finding IDs|exact-write preview|source-sharing preview/);
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
  registerBehaviorCheckTool(vscode, context, proposalStore);
  registerDependencyAssessmentTool(vscode, context);
  registerDependencyUpdateTool(vscode, context);
  registerTransformCodebaseTool(vscode, context, store, proposalStore);
  assert.deepEqual(registrations.map(({ name }) => name).sort(),
    manifest.contributes.languageModelTools.map(({ name }) => name).sort());
  assert.ok(registrations.filter(({ name }) => !name.endsWith('_generate_proposal') && !name.endsWith('_apply_proposal') && !name.endsWith('_check_behavior') && !name.endsWith('_assess_dependencies') && !name.endsWith('_update_dependencies') && !name.endsWith('_transform_codebase'))
    .every(({ tool }) => tool.store === store));
  const proposal = registrations.find(({ name }) => name === 'legacy_codebase_transformation_demo_generate_proposal');
  assert.equal(proposal.tool.findingStore, store);
  assert.equal(proposal.tool.proposalStore, proposalStore);
  const apply = registrations.find(({ name }) => name === 'legacy_codebase_transformation_demo_apply_proposal');
  assert.equal(apply.tool.findingStore, store);
  assert.equal(apply.tool.proposalStore, proposalStore);
  const behavior = registrations.find(({ name }) => name.endsWith('_check_behavior'));
  assert.equal(behavior.tool.proposalStore, proposalStore);
  const dependency = registrations.find(({ name }) => name.endsWith('_assess_dependencies'));
  const dependencyUpdate = registrations.find(({ name }) => name.endsWith('_update_dependencies'));
  const transform = registrations.find(({ name }) => name.endsWith('_transform_codebase'));
  assert.ok(transform.tool instanceof TransformCodebaseTool);
  assert.equal(transform.tool.findingStore, store);
  assert.equal(transform.tool.proposalStore, proposalStore);
  assert.ok(dependencyUpdate.tool instanceof UpdateDependenciesTool);
  assert.equal(dependency.tool.store, undefined);
  assert.equal(dependency.tool.findingStore, undefined);
  assert.equal(dependency.tool.proposalStore, undefined);
  assert.equal(context.subscriptions.length, 8);
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
    originalText, replacementText: 'function sample() { return 1; }', status: 'new'
  }] });
  const vscode = {
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: root } }], textDocuments: [] },
    window: {},
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    LanguageModelChatMessage: { User: (content) => ({ content }) }
  };
  await findingStore.select(vscode, 'finding-id');
  await findingStore.approve(vscode, 'finding-id');
  return { root, source, findingStore, vscode };
}

async function draftProposal(fixture, proposalStore, findingId = 'finding-id', replacementText = 'function sample() { return 1; }') {
  return generateProposal(fixture.vscode, fixture.findingStore, proposalStore, findingId, {
    vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() { throw new Error('Injected request should be used.'); }
  }, undefined, undefined, { requestModel: async () => JSON.stringify({
    summary: 'Simplify the expression.', replacementText,
    rationale: 'The arithmetic is constant.', unknowns: []
  }), chatApproved: true });
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

async function proposalBatchFixture(context, options = {}) {
  const fixture = await approvedFinding(context);
  const originalFinding = fixture.findingStore.getApproved('finding-id');
  const firstStart = originalFinding.originalText.indexOf('0 + 1');
  const findings = [{
    ...originalFinding, originalText: '0 + 1', replacementText: '1',
    range: { startLine: 2, startCharacter: firstStart, endLine: 2, endCharacter: firstStart + 5 }
  }, {
    ...originalFinding, id: 'second-finding', symbol: 'sentinel', originalText: "'unchanged'", replacementText: "'a much longer sentinel'",
    functionRange: { startLine: 3, endLine: 3 },
    range: { startLine: 3, startCharacter: 17, endLine: 3, endCharacter: 28 }
  }, { ...originalFinding, id: 'remaining-finding' }];
  if (options.overlap) {
    findings[1] = { ...originalFinding, id: 'second-finding' };
  }
  if (options.mixed) {
    await fsp.copyFile(path.join(fixture.root, 'sample.js'), path.join(fixture.root, 'other.js'));
    findings[1].path = 'other.js';
  }
  fixture.findingStore.addScan({ root: fixture.root, scanId: 'batch-scan', findings });
  await fixture.findingStore.dispose(fixture.vscode, ['finding-id', 'second-finding']);
  const state = { text: fixture.source, dirty: false, version: 1, edits: 0, saves: 0, saveMode: 'exact' };
  const document = {
    uri: { fsPath: await fsp.realpath(path.join(fixture.root, 'sample.js')) },
    get isDirty() { return state.dirty; },
    get version() { return state.version; },
    getText: () => state.text,
    positionAt: (offset) => ({ offset }),
    async save() {
      state.saves += 1;
      const savedText = state.saveMode === 'eol' ? state.text.replace(/\r\n/g, '\n') : state.text;
      const savedBytes = state.saveMode === 'unchanged' ? Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fixture.source, 'utf8')
      ]) : Buffer.concat([
        state.saveMode === 'bom' ? Buffer.alloc(0) : Buffer.from([0xef, 0xbb, 0xbf]),
        state.saveMode === 'invalid' ? Buffer.from([0xff]) : Buffer.from(savedText, 'utf8')
      ]);
      if (state.saveMode === 'failed') return false;
      await fsp.writeFile(this.uri.fsPath, savedBytes);
      state.dirty = false;
      state.version += 1;
      return true;
    }
  };
  fixture.vscode.workspace.textDocuments = [document];
  fixture.vscode.workspace.openTextDocument = async () => {
    if (state.onOpen) await state.onOpen();
    return document;
  };
  fixture.vscode.WorkspaceEdit = class {
    operations = [];
    replace(uri, range, replacement) { this.operations.push({ uri, range, replacement }); }
  };
  fixture.vscode.Range = class {
    constructor(start, end) { this.start = start; this.end = end; }
  };
  fixture.vscode.Uri = { file: (fsPath) => ({ fsPath }) };
  fixture.vscode.workspace.applyEdit = async (edit) => {
    state.edits += 1;
    for (const { range, replacement } of edit.operations) {
      state.text = state.text.slice(0, range.start.offset) + replacement + state.text.slice(range.end.offset);
    }
    state.dirty = true;
    return true;
  };
  const proposalStore = new ProposalStore();
  if (options.closed) fixture.vscode.workspace.textDocuments = [];
  const first = await draftProposal(fixture, proposalStore, 'finding-id', '1');
  const second = await draftProposal(fixture, proposalStore, 'second-finding',
    options.overlap ? 'function sample() { return 1; }' : "'a much longer sentinel'");
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (options.closed) state.onOpen = () => { fixture.vscode.workspace.textDocuments = [document]; };
  return { ...fixture, proposalStore, ids: [first.proposalId, second.proposalId], state, document };
}

async function approveBatch(fixture, token, fingerprint) {
  const prepared = await prepareApplyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids);
  return applyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids, token,
    { chatApproved: true, expectedFingerprint: fingerprint ?? prepared.fingerprint });
}

test('report suggestions apply after one exact-write decision without proposal generation or finding approval', async (context) => {
  const fixture = await proposalBatchFixture(context);
  const findings = ['finding-id', 'second-finding'].map((id) => fixture.findingStore.getApproved(id));
  fixture.findingStore.addScan({ root: fixture.root, scanId: 'direct-scan', findings });
  const proposalStore = new ProposalStore();
  fixture.vscode.lm = { selectChatModels() { throw new Error('Direct apply must not select or call a model.'); } };
  const tool = new ApplyProposalTool(fixture.vscode, fixture.findingStore, proposalStore);
  const invoke = async (input) => JSON.parse((await tool.invoke({ input })).content[0].value);
  const preview = await invoke({ phase: 'prepare', findingIds: findings.map((finding) => finding.id) });
  assert.equal(preview.status, 'awaiting-decision');
  assert.deepEqual(preview.changes.map((change) => change.replacementText), ['1', "'a much longer sentinel'"]);
  assert.equal(fixture.state.edits, 0);
  assert.ok(fixture.findingStore.list().every((finding) => finding.status === 'new'));
  assert.deepEqual(await fsp.readdir(fixture.root), ['sample.js']);
  const result = await invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'applied');
  assert.equal(result.sourceWritten, true);
  assert.equal(result.behaviorCheck.status, 'not-checked');
  assert.deepEqual(result.behaviorCheck.proposalIds, preview.proposalIds);
  assert.equal(fixture.state.edits, 1);
  assert.equal(fixture.state.saves, 1);
  assert.deepEqual(await fsp.readdir(fixture.root), ['sample.js']);
  assert.equal((await invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'rejected');
});

test('LF scan suggestions bind and apply to exact CRLF bytes with one write decision', async (context) => {
  const fixture = await proposalBatchFixture(context);
  const originalText = 'function sample() {\n  return 0 + 1;\n}';
  const replacementText = 'function sample() {\n  return 1;\n}';
  const source = fixture.source.replace('function sample() { return 0 + 1; }', originalText.replace(/\n/g, '\r\n'));
  fixture.state.text = source;
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await fsp.writeFile(fixture.document.uri.fsPath, Buffer.concat([bom, Buffer.from(source, 'utf8')]));
  const findings = validateFindingResponse({ findings: [{
    category: 'complex-function-simplification', rationale: 'Simplify the constant expression.', confidence: 'medium',
    symbol: 'sample', functionStartLine: 2, functionEndLine: 4,
    startLine: 2, startCharacter: 0, endLine: 4, endCharacter: 1, originalText, replacementText
  }] }, { path: 'sample.js', content: source, startLine: 1, sourceHash: hashSource(source), scanId: 'newline-scan' });
  assert.equal(findings.length, 1);
  fixture.findingStore.addScan({ root: fixture.root, scanId: 'newline-scan', findings });
  const tool = new ApplyProposalTool(fixture.vscode, fixture.findingStore, new ProposalStore());
  const invoke = async (input) => JSON.parse((await tool.invoke({ input })).content[0].value);
  const preview = await invoke({ phase: 'prepare', findingIds: [findings[0].id] });
  assert.equal(preview.status, 'awaiting-decision');
  assert.equal(preview.changes[0].originalText, originalText.replace(/\n/g, '\r\n'));
  assert.equal(preview.changes[0].replacementText, replacementText.replace(/\n/g, '\r\n'));
  assert.equal(fixture.state.edits, 0);
  const result = await invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'applied');
  assert.deepEqual(await fsp.readFile(fixture.document.uri.fsPath), Buffer.concat([bom,
    Buffer.from(source.replace(originalText.replace(/\n/g, '\r\n'), replacementText.replace(/\n/g, '\r\n')), 'utf8')]));
  assert.equal(fixture.state.edits, 1);
  assert.equal(fixture.state.saves, 1);
});

test('direct report apply rejects invalid selections and unsafe source without writes', async (context) => {
  for (const mode of ['overlap', 'mixed', 'dismissed', 'dirty', 'stale', 'declined']) {
    const fixture = await proposalBatchFixture(context, { overlap: mode === 'overlap', mixed: mode === 'mixed' });
    const findings = ['finding-id', 'second-finding'].map((id) => fixture.findingStore.getApproved(id));
    fixture.findingStore.addScan({ root: fixture.root, scanId: 'direct-scan', findings });
    const tool = new ApplyProposalTool(fixture.vscode, fixture.findingStore, new ProposalStore());
    const invoke = async (input) => JSON.parse((await tool.invoke({ input })).content[0].value);
    const findingIds = findings.map((finding) => finding.id);
    for (const input of [
      { phase: 'prepare', findingIds: [] },
      { phase: 'prepare', findingIds: [findingIds[0], findingIds[0]] },
      { phase: 'prepare', findingIds, proposalIds: fixture.ids },
      { phase: 'prepare', findingIds: ['unknown'] },
      { phase: 'confirm', previewId: 'none', decision: 'approve', findingIds }
    ]) assert.equal((await invoke(input)).status, 'rejected');
    if (mode === 'dismissed') fixture.findingStore.dismiss(findingIds[0]);
    if (mode === 'dirty') fixture.state.dirty = true;
    const preview = await invoke({ phase: 'prepare', findingIds });
    if (mode === 'stale' || mode === 'declined') {
      assert.equal(preview.status, 'awaiting-decision');
      if (mode === 'stale') await fsp.appendFile(fixture.document.uri.fsPath, '// changed\r\n');
      const result = await invoke({ phase: 'confirm', previewId: preview.previewId,
        decision: mode === 'declined' ? 'reject' : 'approve' });
      assert.equal(result.status, mode === 'declined' ? 'cancelled' : 'stale');
    } else assert.notEqual(preview.status, 'awaiting-decision');
    assert.equal(fixture.state.edits, 0);
    assert.equal(fixture.state.saves, 0);
  }
});

test('apply tool requires a separate exact batch decision and never accepts IDs on confirm', async (context) => {
  const fixture = await proposalBatchFixture(context);
  const tool = new ApplyProposalTool(fixture.vscode, fixture.findingStore, fixture.proposalStore);
  const invoke = async (input) => JSON.parse((await tool.invoke({ input })).content[0].value);
  for (const input of [
    { phase: 'prepare', proposalId: fixture.ids[0], proposalIds: fixture.ids },
    { phase: 'prepare', proposalIds: [fixture.ids[0], fixture.ids[0]] },
    { phase: 'confirm', previewId: 'none', decision: 'approve', proposalIds: fixture.ids }
  ]) assert.equal((await invoke(input)).status, 'rejected');
  const declined = await invoke({ phase: 'prepare', proposalIds: fixture.ids });
  assert.equal(declined.status, 'awaiting-decision');
  assert.equal(declined.changes.length, 2);
  assert.equal(fixture.state.edits, 0);
  assert.equal((await invoke({ phase: 'confirm', previewId: declined.previewId, decision: 'reject' })).status, 'cancelled');
  assert.equal(fixture.state.edits, 0);
  const approved = await invoke({ phase: 'prepare', proposalIds: fixture.ids });
  const result = await invoke({ phase: 'confirm', previewId: approved.previewId, decision: 'approve' });
  assert.equal(result.status, 'applied');
  assert.equal(result.sourceWritten, true);
  assert.equal(fixture.state.edits, 1);
  assert.equal(fixture.state.saves, 1);
  assert.equal((await invoke({ phase: 'confirm', previewId: approved.previewId, decision: 'approve' })).status, 'rejected');
});

test('apply tool rejects source changed after the exact batch preview', async (context) => {
  const fixture = await proposalBatchFixture(context);
  const tool = new ApplyProposalTool(fixture.vscode, fixture.findingStore, fixture.proposalStore);
  const preview = JSON.parse((await tool.invoke({ input: { phase: 'prepare', proposalIds: fixture.ids } })).content[0].value);
  await fsp.appendFile(fixture.document.uri.fsPath, '// changed\r\n');
  const result = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: preview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(result.status, 'stale');
  assert.equal(fixture.state.edits, 0);
});

test('batch preview binds sorted IDs and exact changes; one write preserves unrelated UTF-8, BOM and CRLF bytes', async (context) => {
  const fixture = await proposalBatchFixture(context);
  const preview = await prepareApplyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids);
  const reversed = await prepareApplyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, [...fixture.ids].reverse());
  assert.equal(preview.status, 'ready');
  assert.equal(preview.fingerprint, reversed.fingerprint);
  assert.deepEqual(Object.keys(preview.preview).sort(), ['changes', 'path', 'proposalIds', 'sourceHash', 'tests']);
  assert.deepEqual(preview.preview.proposalIds, [...fixture.ids].sort());
  assert.equal(preview.preview.path, 'sample.js');
  assert.equal(preview.preview.tests, 'not run');
  for (const change of preview.preview.changes) {
    assert.deepEqual(Object.keys(change).sort(),
      ['findingId', 'originalText', 'proposalHash', 'proposalId', 'range', 'replacementText', 'reportHash']);
  }
  const result = await approveBatch(fixture);
  assert.equal(result.status, 'applied');
  assert.equal(result.sourceWritten, true);
  assert.equal(result.tests, 'not run');
  assert.equal(fixture.state.edits, 1);
  assert.equal(fixture.state.saves, 1);
  const written = await fsp.readFile(fixture.document.uri.fsPath);
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(fixture.source.replace('0 + 1', '1').replace("'unchanged'", "'a much longer sentinel'"), 'utf8')]);
  assert.deepEqual(written, expected);
  assert.equal(result.resultingSourceHash, contentHash(written));
  assert.equal(preview.preview.sourceHash, contentHash(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fixture.source, 'utf8')
  ])));
  assert.ok(fixture.proposalStore.list().every((proposal) => proposal.status === 'applied'));
  assert.ok(fixture.findingStore.list().every((finding) => finding.status === 'stale'));
  assert.equal((await approveBatch(fixture)).status, 'rejected');
  assert.equal(fixture.state.edits, 1);
});

test('batch can open an unchanged closed file without treating its initial editor version as a source change', async (context) => {
  const fixture = await proposalBatchFixture(context, { closed: true });
  assert.ok(fixture.ids.every((id) => fixture.proposalStore.get(id).sourceSnapshot.version === null));
  assert.equal((await approveBatch(fixture)).status, 'applied');
  assert.equal(fixture.state.edits, 1);
  assert.equal(fixture.state.saves, 1);
});

test('batch rejects overlapping or mixed-file proposals and invalid ID lists without writing', async (context) => {
  for (const options of [{ overlap: true }, { mixed: true }]) {
    const fixture = await proposalBatchFixture(context, options);
    const before = await fsp.readFile(fixture.document.uri.fsPath);
    const result = await approveBatch(fixture);
    assert.equal(result.status, 'rejected');
    assert.equal(result.sourceWritten, false);
    assert.equal(fixture.state.edits, 0);
    assert.equal(fixture.state.saves, 0);
    assert.deepEqual(await fsp.readFile(fixture.document.uri.fsPath), before);
    if (options.mixed) assert.deepEqual(await fsp.readFile(path.join(fixture.root, 'other.js')), before);
  }
  const fixture = await proposalBatchFixture(context);
  for (const ids of [[], [fixture.ids[0], fixture.ids[0]], Array.from({ length: 31 }, (_, index) => `id-${index}`),
    [''], [null], null, ['unknown-id']]) {
    assert.equal((await prepareApplyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, ids)).status, 'rejected');
  }
  assert.equal(fixture.state.edits, 0);
});

test('batch requires explicit consent, exact fingerprint and uncancelled execution', async (context) => {
  const fixture = await proposalBatchFixture(context);
  assert.equal((await applyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids)).status, 'cancelled');
  assert.equal((await applyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids,
    undefined, { chatApproved: true })).status, 'stale');
  assert.equal((await approveBatch(fixture, undefined, 'wrong')).status, 'stale');
  assert.equal((await approveBatch(fixture, { isCancellationRequested: true })).status, 'cancelled');
  const token = { isCancellationRequested: false };
  fixture.state.onOpen = () => { token.isCancellationRequested = true; };
  assert.equal((await approveBatch(fixture, token)).status, 'cancelled');
  assert.equal(fixture.state.edits, 0);
  assert.equal(fixture.state.saves, 0);
  assert.ok(fixture.proposalStore.list().every((proposal) => proposal.status === 'pending'));
});

test('batch rejects stale disk, dirty and stale editor buffers, and version changes without writes', async (context) => {
  for (const mode of ['disk', 'dirty', 'buffer', 'version', 'open-dirty', 'open-disk']) {
    const fixture = await proposalBatchFixture(context);
    const prepared = await prepareApplyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids);
    if (mode === 'disk') await fsp.appendFile(fixture.document.uri.fsPath, '// changed\r\n');
    if (mode === 'dirty') fixture.state.dirty = true;
    if (mode === 'buffer') fixture.state.text += '// stale buffer\r\n';
    if (mode === 'version') fixture.state.version += 1;
    if (mode === 'open-dirty') fixture.state.onOpen = () => { fixture.state.dirty = true; };
    if (mode === 'open-disk') fixture.state.onOpen = () => fsp.appendFile(fixture.document.uri.fsPath, '// changed\r\n');
    const result = await applyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids,
      undefined, { chatApproved: true, expectedFingerprint: prepared.fingerprint });
    assert.equal(result.status, 'stale', mode);
    assert.equal(result.sourceWritten, false);
    assert.equal(fixture.state.edits, 0);
    assert.equal(fixture.state.saves, 0);
  }
});

test('batch revalidates proposal integrity, finding identity and snapshot before writing', async (context) => {
  for (const mode of ['pending', 'integrity', 'finding', 'snapshot', 'replacement']) {
    const fixture = await proposalBatchFixture(context);
    const prepared = await prepareApplyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids);
    const get = fixture.proposalStore.get.bind(fixture.proposalStore);
    const approved = fixture.findingStore.getApproved.bind(fixture.findingStore);
    fixture.state.onOpen = () => {
      if (mode === 'pending') fixture.proposalStore.setStatus(fixture.ids[1], 'applied');
      if (mode === 'finding') fixture.findingStore.getApproved = (id) => {
        const finding = approved(id);
        return finding ? { ...finding, symbol: 'changed-symbol' } : null;
      };
      fixture.proposalStore.get = (id) => {
        const candidate = get(id);
        if (id !== fixture.ids[1]) return candidate;
        if (mode === 'integrity') candidate.proposalHash = 'wrong';
        if (mode === 'snapshot') candidate.sourceSnapshot.bytes = '';
        if (mode === 'replacement') candidate.proposal.replacementText = "'different exact content'";
        if (mode === 'snapshot' || mode === 'replacement') {
          candidate.proposalHash = contentHash(JSON.stringify(candidate.proposal));
          candidate.report = renderProposalReport(candidate);
          candidate.reportHash = contentHash(Buffer.from(candidate.report, 'utf8'));
        }
        return candidate;
      };
    };
    const result = await applyProposalBatch(fixture.vscode, fixture.findingStore, fixture.proposalStore, fixture.ids,
      undefined, { chatApproved: true, expectedFingerprint: prepared.fingerprint });
    assert.ok(['stale', 'rejected'].includes(result.status), mode);
    assert.equal(fixture.state.edits, 0);
    assert.equal(fixture.state.saves, 0);
  }
});

test('batch consumes every candidate on saved mismatch or save failure and reports persisted bytes honestly', async (context) => {
  for (const mode of ['eol', 'bom', 'invalid', 'unchanged', 'failed']) {
    const fixture = await proposalBatchFixture(context);
    fixture.state.saveMode = mode;
    const original = await fsp.readFile(fixture.document.uri.fsPath);
    const result = await approveBatch(fixture);
    const written = await fsp.readFile(fixture.document.uri.fsPath);
    assert.equal(result.status, 'verification-failed', mode);
    assert.equal(result.sourceWritten, !written.equals(original));
    assert.equal(result.resultingSourceHash, contentHash(written));
    assert.equal(result.application, written.equals(original) ? 'not-applied' : 'saved-but-unverified');
    assert.equal(fixture.state.edits, 1);
    assert.equal(fixture.state.saves, 1);
    assert.ok(fixture.proposalStore.list().every((proposal) => proposal.status === 'verification-failed'));
    assert.equal((await approveBatch(fixture)).status, 'rejected');
    assert.equal(fixture.state.edits, 1);
  }
});

test('proposal preview binds exact source context to a separate chat approval', async (context) => {
  const fixture = await approvedFinding(context);
  let modelCalls = 0;
  const model = { vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() {} };
  const prepared = await prepareProposalRequest(fixture.vscode, fixture.findingStore, 'finding-id', model);
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.preview.path, 'sample.js');
  assert.equal(prepared.preview.requestedRefactor, 'Improve readability and maintainability in this finding while preserving behavior.');
  assert.ok(prepared.preview.contextBytes > 0);
  assert.match(prepared.preview.contextHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(prepared.preview, 'sourceContext'), false);
  const rejectedStore = new ProposalStore();
  const rejected = await generateProposal(fixture.vscode, fixture.findingStore, rejectedStore, 'finding-id', model,
    undefined, undefined, { expectedFingerprint: prepared.fingerprint, requestModel: async () => { modelCalls += 1; } });
  assert.equal(rejected.status, 'cancelled');
  assert.equal(modelCalls, 0);
  const proposalStore = new ProposalStore();
  const result = await generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', model,
    undefined, undefined, { chatApproved: true, expectedFingerprint: prepared.fingerprint, requestModel: async (prompt) => {
    modelCalls += 1;
    const submitted = JSON.parse(prompt);
    assert.match(submitted.context, /function sample/);
    return JSON.stringify({ summary: 'Remove the redundant arithmetic.', replacementText: 'function sample() { return 1; }',
      rationale: 'The expression has a constant result.', unknowns: ['Callers were not analyzed.'] });
  } });
  assert.equal(modelCalls, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.originalText, 'function sample() { return 0 + 1; }');
  assert.equal(result.replacementText, 'function sample() { return 1; }');
  assert.equal(result.tests, 'not run');
  assert.match(result.report, /No project tests or commands were run/);
  assert.equal((await fsp.readFile(path.join(fixture.root, 'sample.js'), 'utf8')), `\ufeff${fixture.source}`);
  assert.equal(proposalStore.list().length, 1);
});

test('proposal tool requires a separate chat decision and consumes preview IDs once', async (context) => {
  const fixture = await approvedFinding(context);
  let requests = 0;
  const proposalStore = new ProposalStore();
  const tool = new GenerateProposalTool(fixture.vscode, fixture.findingStore, proposalStore, {
    selectLanguageModel: async () => ({ vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() {} }),
    requestModel: async () => {
      requests += 1;
      return JSON.stringify({ summary: 'Simplify.', replacementText: 'function sample() { return 1; }',
        rationale: 'The expression is constant.', unknowns: [] });
    }
  });
  const prepare = async () => JSON.parse((await tool.invoke({ input: {
    phase: 'prepare', findingId: 'finding-id'
  } })).content[0].value);
  const preview = await prepare();
  assert.equal(preview.status, 'awaiting-decision');
  assert.ok(preview.contextBytes > 0);
  assert.match(preview.contextHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(preview, 'sourceContext'), false);
  assert.equal(requests, 0);
  const rejected = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: preview.previewId, decision: 'reject'
  } })).content[0].value);
  assert.equal(rejected.status, 'cancelled');
  const reused = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: preview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(reused.status, 'rejected');
  assert.equal(requests, 0);

  const approvedPreview = await prepare();
  const generated = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: approvedPreview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(generated.status, 'ready');
  assert.equal(requests, 1);
});

test('declined proposal source consent and stale findings make no model request', async (context) => {
  const fixture = await approvedFinding(context);
  let requests = 0;
  const model = { vendor: 'test', id: 'test-model', sendRequest() { requests += 1; } };
  const proposalStore = new ProposalStore();
  const preview = await prepareProposalRequest(fixture.vscode, fixture.findingStore, 'finding-id', model);
  const declined = await generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', model,
    undefined, undefined, { expectedFingerprint: preview.fingerprint, requestModel: async () => { requests += 1; } });
  assert.equal(declined.status, 'cancelled');
  assert.equal(requests, 0);

  await fsp.appendFile(path.join(fixture.root, 'sample.js'), '// changed\n');
  await assert.rejects(prepareProposalRequest(fixture.vscode, fixture.findingStore, 'finding-id', model), /source changed/);
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
  fixture.vscode.window.showWarningMessage = async () => { approvalLabels += 1; };
  const proposalStore = new ProposalStore();
  const generated = await generateProposal(fixture.vscode, fixture.findingStore, proposalStore, 'finding-id', {
    vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() { throw new Error('Injected request should be used.'); }
  }, undefined, undefined, { requestModel: async () => JSON.stringify({
    summary: 'Simplify the expression.', replacementText: 'function sample() { return 1; }',
    rationale: 'The arithmetic is constant.', unknowns: []
  }), chatApproved: true });
  assert.equal(generated.status, 'ready');
  const preview = await prepareApplyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.preview.originalText, 'function sample() { return 0 + 1; }');
  assert.equal(preview.preview.replacementText, 'function sample() { return 1; }');
  const missingApproval = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(missingApproval.status, 'cancelled');
  const applyTool = new ApplyProposalTool(fixture.vscode, fixture.findingStore, proposalStore);
  const applyPreview = JSON.parse((await applyTool.invoke({ input: {
    phase: 'prepare', proposalId: generated.proposalId
  } })).content[0].value);
  assert.equal(applyPreview.status, 'awaiting-decision');
  assert.equal(applyPreview.originalText, 'function sample() { return 0 + 1; }');
  const declined = JSON.parse((await applyTool.invoke({ input: {
    phase: 'confirm', previewId: applyPreview.previewId, decision: 'reject'
  } })).content[0].value);
  assert.equal(declined.status, 'cancelled');
  assert.equal((await fsp.readFile(document.uri.fsPath, 'utf8')), `\ufeff${fixture.source}`);
  const approvedPreview = JSON.parse((await applyTool.invoke({ input: {
    phase: 'prepare', proposalId: generated.proposalId
  } })).content[0].value);
  const applied = JSON.parse((await applyTool.invoke({ input: {
    phase: 'confirm', previewId: approvedPreview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.application, 'applied');
  assert.equal(approvalLabels, 0);
  assert.equal(applied.tests, 'not run');
  const writtenBytes = await fsp.readFile(document.uri.fsPath);
  assert.equal(applied.resultingSourceHash, createHash('sha256').update(writtenBytes).digest('hex'));
  assert.equal(writtenBytes.toString('utf8'), "\ufeff// keep π\r\nfunction sample() { return 1; }\r\nconst sentinel = 'unchanged';\r\n");
  assert.equal(proposalStore.list()[0].status, 'applied');
  const reusedPreview = JSON.parse((await applyTool.invoke({ input: {
    phase: 'confirm', previewId: approvedPreview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(reusedPreview.status, 'rejected');
  const repeated = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId, undefined,
    { chatApproved: true, expectedFingerprint: preview.fingerprint });
  assert.equal(repeated.status, 'rejected');
  assert.equal(approvalLabels, 0);
});

test('post-save verification failure reports a changed file and consumes the proposal', async (context) => {
  const fixture = await approvedFinding(context);
  const proposalStore = new ProposalStore();
  const generated = await draftProposal(fixture, proposalStore);
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
        Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
      ]));
      dirty = false;
      version += 1;
      return true;
    }
  };
  fixture.vscode.workspace.textDocuments = [document];
  fixture.vscode.workspace.openTextDocument = async () => document;
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
  const result = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId, undefined,
    { chatApproved: true });
  const saved = await fsp.readFile(document.uri.fsPath, 'utf8');
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.application, 'saved-but-unverified');
  assert.equal(result.sourceWritten, true);
  assert.equal(result.resultingSourceHash, createHash('sha256').update(await fsp.readFile(document.uri.fsPath)).digest('hex'));
  assert.match(saved, /function sample\(\) \{ return 1; \}/);
  assert.equal(proposalStore.list()[0].status, 'verification-failed');
  assert.equal((await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId, undefined,
    { chatApproved: true })).status, 'rejected');
});

test('apply cancellation, stale source, and dirty buffers never write a proposal', async (context) => {
  const fixture = await approvedFinding(context);
  const proposalStore = new ProposalStore();
  const generated = await draftProposal(fixture, proposalStore);
  assert.equal(generated.status, 'ready');
  const cancelled = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(proposalStore.list()[0].status, 'pending');
  assert.equal((await fsp.readFile(path.join(fixture.root, 'sample.js'), 'utf8')), `\ufeff${fixture.source}`);

  await fsp.appendFile(path.join(fixture.root, 'sample.js'), '// changed\r\n');
  await assert.rejects(captureSourceSnapshot(fixture.vscode, fixture.findingStore.getApproved('finding-id')));
  const stale = await applyProposal(fixture.vscode, fixture.findingStore, proposalStore, generated.proposalId, undefined,
    { chatApproved: true });
  assert.equal(stale.status, 'stale', JSON.stringify(stale));
  assert.equal(proposalStore.list()[0].status, 'stale');

  const dirtyFixture = await approvedFinding(context);
  const dirtyStore = new ProposalStore();
  const dirtyProposal = await draftProposal(dirtyFixture, dirtyStore);
  const dirtyFilePath = await fsp.realpath(path.join(dirtyFixture.root, 'sample.js'));
  dirtyFixture.vscode.workspace.textDocuments = [{
    uri: { fsPath: dirtyFilePath }, isDirty: true, version: 1
  }];
  await assert.rejects(captureSourceSnapshot(dirtyFixture.vscode, dirtyFixture.findingStore.getApproved('finding-id')));
  const dirtyResult = await applyProposal(dirtyFixture.vscode, dirtyFixture.findingStore, dirtyStore, dirtyProposal.proposalId,
    undefined, { chatApproved: true });
  assert.equal(dirtyResult.status, 'stale');
  assert.equal(dirtyStore.list()[0].status, 'stale');
  assert.equal((await fsp.readFile(path.join(dirtyFixture.root, 'sample.js'), 'utf8')), `\ufeff${dirtyFixture.source}`);

  const raceFixture = await approvedFinding(context);
  const raceStore = new ProposalStore();
  const raceProposal = await draftProposal(raceFixture, raceStore);
  const applyPreview = await prepareApplyProposal(raceFixture.vscode, raceFixture.findingStore, raceStore, raceProposal.proposalId);
  await fsp.appendFile(path.join(raceFixture.root, 'sample.js'), '// concurrent edit\r\n');
  const raced = await applyProposal(raceFixture.vscode, raceFixture.findingStore, raceStore, raceProposal.proposalId,
    undefined, { chatApproved: true, expectedFingerprint: applyPreview.fingerprint });
  assert.equal(raced.status, 'stale');
  assert.equal(raceStore.list()[0].status, 'stale');
  assert.equal((await fsp.readFile(path.join(raceFixture.root, 'sample.js'), 'utf8')),
    `\ufeff${raceFixture.source}// concurrent edit\r\n`);
});
