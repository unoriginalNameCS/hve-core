'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateModelProposal, validateEndpoint } = require('../src/foundry-adapter');
const { generateProposalReport, writeProposalReport } = require('../src/proposal-report');
const { expectedSampleCase, generateSampleInputs, validateSampleInputs } = require('../src/sample-inputs');

const modelContext = {
  target: { path: 'Target.js', symbol: 'calculate', source: null },
  evidenceCatalog: [{ id: 'E1', path: 'Target.js', startLine: 1, endLine: 1, content: 'function calculate() {}' }]
};
const fakeEnv = { api_key: 'fake-test-credential', model: 'test-deployment', endpoint: 'https://test-resource.openai.azure.com' };

function liveOptions(fetchImpl, consent = 'Send collected context') {
  return { changeRequest: 'Simplify nested conditionals while preserving behavior.', env: fakeEnv, fetchImpl,
    vscode: { window: { showWarningMessage: async () => consent } } };
}

function proposalFor(context, changes = []) {
  return {
    summary: 'Proposal based on collected source evidence.',
    target: { path: context.target.path, symbol: context.target.symbol },
    evidence: (context.evidenceCatalog ?? []).map((item) => ({
      id: item.id, path: item.path, startLine: item.startLine, endLine: item.endLine,
      claim: 'This source range supports review of the selected target.'
    })),
    changes,
    unknowns: ['Runtime behavior remains unverified until the controlled verification step.']
  };
}

function response(proposal, overrides = {}) {
  const payload = proposal;
  return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) }, ...overrides }] }) };
}

function fakeFoundry(proposalFactory = proposalFor) {
  return async (url, request) => {
    const context = JSON.parse(JSON.parse(request.body).messages[2].content);
    return response(proposalFactory(context));
  };
}

test('proposal generation always requires configured Live Foundry and cannot fall back to mock', async () => {
  await assert.rejects(generateModelProposal(modelContext, { env: {} }), /requires api_key/);
  await assert.rejects(generateModelProposal(modelContext, { mode: 'mock', env: {} }), /requires api_key/);
});

test('live fake transport uses documented v1 auth and strict schema after exact context confirmation', async () => {
  const options = liveOptions(async (url, request) => {
    assert.equal(url, 'https://test-resource.openai.azure.com/openai/v1/chat/completions');
    assert.equal(request.headers['api-key'], fakeEnv.api_key);
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    const body = JSON.parse(request.body);
    assert.equal(body.model, fakeEnv.model);
    assert.equal(body.messages[1].content, `Requested refactor: ${options.changeRequest}`);
    assert.equal(body.messages[2].content, JSON.stringify(modelContext));
    assert.doesNotMatch(body.messages[0].content, /pizzaCases|nodeCases/i);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.properties.pizzaCases, undefined);
    assert.equal(body.response_format.json_schema.schema.properties.nodeCases, undefined);
    assert.equal(body.response_format.json_schema.schema.properties.evidence.items.properties.startLine.minimum, undefined);
    return response(proposalFor(modelContext));
  });
  options.vscode.window.showWarningMessage = async (message, modal) => {
    assert.equal(modal.modal, true);
    assert.ok(modal.detail.includes('Destination: https://test-resource.openai.azure.com'));
    assert.ok(modal.detail.includes(`Model: ${fakeEnv.model}`));
    assert.ok(modal.detail.includes(`Requested refactor:\n${options.changeRequest}`));
    assert.ok(modal.detail.endsWith(JSON.stringify(modelContext)));
    return 'Send collected context';
  };
  const result = await generateModelProposal(modelContext, options);
  assert.equal(result.status, 'ready');
  assert.equal(result.changeRequest, options.changeRequest);
});

test('live output generates Node inputs locally and leaves expected results to the extension', async () => {
  const context = { ...modelContext, target: { path: 'src/transfer.js', symbol: 'transfer', source: null } };
  const proposal = proposalFor(context);
  const options = liveOptions(async (url, request) => {
    const schema = JSON.parse(request.body).response_format.json_schema.schema;
    assert.equal(schema.properties.nodeCases, undefined);
    assert.equal(schema.properties.pizzaCases, undefined);
    return response(proposal);
  });
  const result = await generateModelProposal(context, options);
  const nodeCases = generateSampleInputs(context.target);
  assert.deepEqual(result.sampleInputs, nodeCases);
  assert.deepEqual(result.proposal, proposal);
  assert.deepEqual(nodeCases.map((sample) => expectedSampleCase(context.target, sample).result.reason),
    [null, 'source missing', 'destination missing', 'accounts must differ', 'insufficient funds']);
  assert.deepEqual(expectedSampleCase(context.target, nodeCases[0]), {
    result: { accepted: true, reason: null }, balances: { alice: 75, bob: 75 }
  });
});

test('fixture sample inputs are locally generated from function behavior and validated', () => {
  const pizzaTarget = { path: 'src/PizzaEligibility/PizzaDiscountCalculator.cs', symbol: 'CalculateDiscountAmount' };
  const pizzaCases = generateSampleInputs(pizzaTarget);
  assert.equal(pizzaCases.length, 4);
  assert.deepEqual(pizzaCases.map((sample) => expectedSampleCase(pizzaTarget, sample)), ['2.50', '0.00', '5.00', '5.01']);

  const nodeTarget = { path: 'src/transfer.js', symbol: 'transfer' };
  const nodeCases = generateSampleInputs(nodeTarget);
  assert.equal(nodeCases.length, 5);
  assert.deepEqual(validateSampleInputs(nodeCases, nodeTarget, true), nodeCases);
  assert.equal(new Set(nodeCases.map((sample) => JSON.stringify(sample))).size, nodeCases.length);
  assert.deepEqual(generateSampleInputs({ path: 'Target.js', symbol: 'calculate' }), []);

  const valid = { accounts: [{ id: 'alice', balance: 100 }], sourceId: 'alice', destinationId: 'bob', amount: 1 };
  assert.throws(() => validateSampleInputs([valid], nodeTarget, true), /three to five/);
  assert.throws(() => validateSampleInputs([valid, valid, valid], nodeTarget, true), /valid, unique cases/);
  assert.throws(() => validateSampleInputs([
    valid, valid, { ...valid, accounts: [{ id: '__proto__', balance: 1 }] }
  ], nodeTarget, true), /valid, unique cases/);
});

test('live cancelled permission or missing modal never calls transport', async () => {
  let calls = 0;
  const options = liveOptions(async () => { calls += 1; }, undefined);
  options.vscode.window.showWarningMessage = async () => undefined;
  assert.equal((await generateModelProposal(modelContext, options)).status, 'cancelled');
  await assert.rejects(generateModelProposal(modelContext, { ...options, vscode: {} }), /extension-owned/);
  assert.equal(calls, 0);
});

test('endpoint/config validation rejects arbitrary hosts, project endpoints, credentials and queries', async () => {
  for (const endpoint of [undefined, 'https://example.com', 'http://test.openai.azure.com',
    'https://test.openai.azure.com?secret=x', 'https://user@test.openai.azure.com',
    'https://test.openai.azure.com:443', 'https://test.services.ai.azure.com/api/projects/test',
    'https://test.openai.azure.com/../', 'https://test.openai.azure.com/#fragment']) {
    assert.throws(() => validateEndpoint(endpoint), /canonical HTTPS/);
  }
  assert.equal(validateEndpoint('https://test.services.ai.azure.com/openai/v1/'), 'https://test.services.ai.azure.com/openai/v1/chat/completions');
  await assert.rejects(generateModelProposal(modelContext, { ...liveOptions(), env: {} }), /requires api_key/);
});

test('Live failures expose only safe stage diagnostics and never response credentials', async () => {
  const failures = [
    [async () => response({}, { message: { refusal: fakeEnv.api_key } }), /model refused/],
    [async () => ({ ok: true, text: async () => fakeEnv.api_key }), /not valid bounded JSON/],
    [async () => ({ ok: false, status: 401, text: async () => fakeEnv.api_key }), /HTTP 401/],
    [async () => { throw new Error(fakeEnv.api_key); }, /Could not reach the configured Foundry endpoint/],
    [async () => response({ summary: fakeEnv.api_key }), /configured credential and was discarded/],
    [async () => response({}, { finish_reason: 'length' }), /response was incomplete/],
    [async () => response({}, { message: { content: 'not JSON' } }), /not valid JSON/],
    [async () => response({}, { message: {} }), /did not contain structured proposal content/]
  ];
  for (const [fetchImpl, expectedMessage] of failures) {
    await assert.rejects(generateModelProposal(modelContext, liveOptions(fetchImpl)), (error) => {
      assert.equal(error.code, 'FOUNDRY_DIAGNOSTIC');
      assert.ok(!error.message.includes(fakeEnv.api_key));
      assert.match(error.message, expectedMessage);
      return true;
    });
  }
});

test('Live pizza generation includes extension-owned threshold and membership cases', async () => {
  const context = { ...modelContext, target: { path: 'src/PizzaEligibility/PizzaDiscountCalculator.cs', symbol: 'CalculateDiscountAmount' } };
  const proposal = proposalFor(context);
  const result = await generateModelProposal(context, liveOptions(async () => response(proposal)));
  assert.deepEqual(result.sampleInputs, generateSampleInputs(context.target));
  assert.deepEqual(result.sampleInputs.map((sample) => sample.subtotal), ['25.00', '49.90', '50.00', '50.10']);
});

test('finite timeout aborts a hung transport without fallback success', async () => {
  let signal;
  await assert.rejects(generateModelProposal(modelContext, {
    ...liveOptions(async (url, request) => { signal = request.signal; return new Promise(() => {}); }), timeoutMs: 5
  }), /timed out/);
  assert.equal(signal.aborted, true);
});

function uri(filePath) {
  return { scheme: 'file', authority: '', fsPath: filePath, path: filePath.split(path.sep).join('/') };
}

async function project(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-report-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = 'function calculate() { return 1; }\n';
  await fs.writeFile(path.join(root, 'Target.js'), source);
  await fs.writeFile(path.join(root, 'Target.test.js'), 'calculate();\n');
  await fs.writeFile(path.join(root, 'README.md'), '# Example\n');
  const targetUri = uri(path.join(root, 'Target.js'));
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 34 } };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: uri(root) }],
      findFiles: async () => [targetUri, uri(path.join(root, 'Target.test.js')), uri(path.join(root, 'README.md'))],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    },
    commands: { executeCommand: async (command) => command === 'vscode.executeDocumentSymbolProvider' ?
      [{ name: 'calculate', kind: 11, range, selectionRange: range }] : [] },
    window: { showWarningMessage: async () => 'Send collected context' }
  };
  return { root, vscode, source, input: { projectRoot: root, targetFile: targetUri.fsPath, targetSymbol: 'calculate' } };
}

test('pipeline rediscovers and reads source and writes a Live report from Foundry output', async (context) => {
  const fixture = await project(context);
  const result = await generateProposalReport(fixture.vscode,
    { ...fixture.input, evidenceCatalog: [{ id: 'forged' }] }, undefined,
    { env: fakeEnv, fetchImpl: fakeFoundry() });
  assert.equal(result.status, 'ready');
  assert.ok(result.reportPath.endsWith('.md'));
  assert.ok(result.evidenceCatalog.some((item) => item.kind === 'test context'));
  assert.ok(result.evidenceCatalog.some((item) => item.kind === 'documentation context'));
  assert.ok(result.evidenceCatalog.every((item) => item.id !== 'forged'));
  assert.equal(result.baselineObservations, null);
  const markdown = await fs.readFile(result.reportPath, 'utf8');
  assert.match(markdown, /Mode: Live Foundry model/);
  assert.doesNotMatch(markdown, /SIMULATION|offline mock/);
  assert.match(markdown, /Existing tests: not run/);
  assert.match(markdown, /Observed baseline inputs\/outputs: not captured for this proposal/);
  assert.ok(markdown.includes('text match \\(not a semantic edge\\)'));
  assert.match(markdown, /not a full-file hash/);
  assert.equal(Buffer.from(result.sourceSnapshot.bytes, 'base64').toString('utf8'), fixture.source);
  const { assertSourceSnapshot } = require('../src/proposal-apply');
  await fs.appendFile(fixture.input.targetFile, '\n');
  await assert.rejects(assertSourceSnapshot(fixture.vscode, result.sourceSnapshot), /changed/);
  await fs.writeFile(fixture.input.targetFile, fixture.source);
  assert.equal(await fs.readFile(fixture.input.targetFile, 'utf8'), fixture.source);
});

test('pipeline rejects invented citations and edits outside the selected target span with no report', async (context) => {
  const fixture = await project(context);
  for (const mutation of [
    (candidate) => { candidate.evidence[0].id = 'invented'; },
    (candidate) => { candidate.changes = [{ path: 'README.md', originalText: '# Example', replacementText: 'changed', rationale: 'No.' }]; },
    (candidate) => { candidate.changes = [{ path: 'Target.js', originalText: 'return 1;', replacementText: 'return 2;', rationale: 'No.' }]; }
  ]) {
    await assert.rejects(generateProposalReport(fixture.vscode, fixture.input, undefined, {
      env: fakeEnv,
      fetchImpl: fakeFoundry((collected) => {
        const candidate = proposalFor(collected);
        mutation(candidate);
        return candidate;
      })
    }), /Proposal rejected/);
    assert.equal(await fs.stat(path.join(fixture.root, 'reports')).catch(() => null), null);
  }
});

test('unresolved targets retain provider warning and refuse edits', async (context) => {
  const fixture = await project(context);
  fixture.vscode.commands.executeCommand = async () => { throw new Error('provider unavailable'); };
  const result = await generateProposalReport(fixture.vscode, fixture.input, undefined,
    { env: fakeEnv, fetchImpl: fakeFoundry() });
  assert.deepEqual(result.proposal.changes, []);
  assert.equal(result.targetSpanHash, null);
  assert.match(await fs.readFile(result.reportPath, 'utf8'), /provider unavailable/);
});

test('writer rejects source/dependency paths, traversal, symlink ancestors and overwrites', async (context) => {
  const fixture = await project(context);
  for (const directory of ['../escape', '.git/reports', 'node_modules/reports', 'deps/reports', 'dependencies/reports', 'src/reports', 'sources/reports', 'docs/reports', 'reports/nul', 'reports/x:stream']) {
    await assert.rejects(writeProposalReport(fixture.root, directory, 'report'), /directory|paths/);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-outside-'));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(fixture.root, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeProposalReport(fixture.root, 'escaped/new/reports', 'report'), /unsafe ancestor/);
  assert.deepEqual(await fs.readdir(outside), []);
  const reportPath = await writeProposalReport(fixture.root, 'custom-reports/proposals', 'first', undefined, [], 'fixed.md');
  await assert.rejects(writeProposalReport(fixture.root, 'custom-reports/proposals', 'second', undefined, [], 'fixed.md'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(reportPath, 'utf8'), 'first');
});

test('cancelled generation and cancelled source sharing create no report', async (context) => {
  const fixture = await project(context);
  assert.equal((await generateProposalReport(fixture.vscode, fixture.input, { isCancellationRequested: true })).status, 'cancelled');
  fixture.vscode.window.showWarningMessage = async () => undefined;
  const result = await generateProposalReport(fixture.vscode, { ...fixture.input, mode: 'live' }, undefined, {
    env: fakeEnv, fetchImpl() { throw new Error('Must not fetch.'); }
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(await fs.stat(path.join(fixture.root, 'reports')).catch(() => null), null);
});

test('active cancellation aborts transport and leaves no successful proposal', async () => {
  let cancel;
  let signal;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (callback) => { cancel = callback; return { dispose() {} }; }
  };
  const result = await generateModelProposal(modelContext, { ...liveOptions(async (url, request) => {
    signal = request.signal;
    token.isCancellationRequested = true;
    cancel();
    return new Promise(() => {});
  }), token });
  assert.equal(result.status, 'cancelled');
  assert.equal(signal.aborted, true);
});

test('cancellation after exclusive open removes the empty file and newly created directories', async (context) => {
  const fixture = await project(context);
  let checks = 0;
  const token = { get isCancellationRequested() { checks += 1; return checks === 5; } };
  await assert.rejects(writeProposalReport(fixture.root, 'reports/proposals', 'report', token, [], 'cancelled.md'), { code: 'CANCELLED' });
  assert.equal(await fs.stat(path.join(fixture.root, 'reports')).catch(() => null), null);
});

test('command always runs Live and opens the Foundry-backed report without mutating source', async (context) => {
  const fixture = await project(context);
  const { registerProposalReportCommand } = require('../src/extension');
  let callback;
  let opened;
  fixture.vscode.commands.registerCommand = (name, handler) => { callback = handler; return { dispose() {} }; };
  fixture.vscode.Uri.file = uri;
  fixture.vscode.ProgressLocation = { Notification: 15 };
  fixture.vscode.workspace.getConfiguration = () => ({ get: (name, fallback) => fallback });
  fixture.vscode.workspace.openTextDocument = async (fileUri) => ({ uri: fileUri });
  fixture.vscode.window.activeTextEditor = { document: { uri: uri(fixture.input.targetFile), isDirty: false } };
  let rootPickCount = 0;
  let inputCount = 0;
  fixture.vscode.window.showQuickPick = async (items) => { rootPickCount += 1; return items[0]; };
  fixture.vscode.window.showInputBox = async () => ++inputCount === 1 ? 'calculate' : 'Simplify the selected function.';
  fixture.vscode.window.withProgress = async (options, action) => action({}, { isCancellationRequested: false });
  fixture.vscode.window.showTextDocument = async (document) => { opened = document.uri.fsPath; };
  fixture.vscode.window.showErrorMessage = async () => assert.fail('Command should succeed.');
  registerProposalReportCommand(fixture.vscode, { subscriptions: [] }, undefined,
    { env: fakeEnv, fetchImpl: fakeFoundry() });
  const result = await callback();
  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'live');
  assert.equal(rootPickCount, 1);
  assert.equal(result.reportPath, opened);
  assert.match(await fs.readFile(opened, 'utf8'), /Mode: Live Foundry model/);
  assert.equal(await fs.readFile(fixture.input.targetFile, 'utf8'), fixture.source);
});

test('report tool always uses Live, rejects mode overrides, and confirms report and source sharing', async (context) => {
  const fixture = await project(context);
  const { GenerateProposalReportTool } = require('../src/extension');
  const { ProposalCandidateStore } = require('../src/proposal-apply');
  fixture.vscode.Uri.file = uri;
  fixture.vscode.LanguageModelToolResult = class { constructor(parts) { this.parts = parts; } };
  fixture.vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  fixture.vscode.workspace.getConfiguration = () => ({ get: (name, fallback) => fallback });
  fixture.vscode.workspace.openTextDocument = async (value) => ({ uri: value });
  fixture.vscode.window.showTextDocument = async () => {};
  const tool = new GenerateProposalReportTool(fixture.vscode, new ProposalCandidateStore(),
    { env: fakeEnv, fetchImpl: fakeFoundry() });
  const invoke = async (input, token) => JSON.parse((await tool.invoke({ input }, token)).parts[0].value);
  assert.equal((await invoke({ ...fixture.input, patch: 'not accepted' })).status, 'failed');
  assert.equal((await invoke({ ...fixture.input, mode: 'mock' })).status, 'failed');
  assert.equal((await invoke(fixture.input, { isCancellationRequested: true })).status, 'cancelled');
  fixture.vscode.window.showWarningMessage = async () => undefined;
  assert.equal((await invoke(fixture.input)).status, 'cancelled');
  assert.equal(await fs.stat(path.join(fixture.root, 'reports')).catch(() => null), null);
  fixture.vscode.window.showWarningMessage = async (message, options) => {
    assert.equal(options.modal, true);
    if (message === 'Generate and write a proposal report without changing source?') {
      assert.match(options.detail, /Mode: Live Foundry/);
      return 'Generate report';
    }
    return 'Send collected context';
  };
  const result = await invoke(fixture.input);
  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'live');
  assert.equal(result.proposalId, null);
  assert.equal(result.proposal, undefined);
  assert.equal(result.sourceSnapshot, undefined);
  assert.equal(result.evidenceCatalog, undefined);
  assert.equal(result.tests, 'not run');
  assert.equal(await fs.readFile(fixture.input.targetFile, 'utf8'), fixture.source);
});

test('Node provider pipeline generates known candidate and ID-only tool applies after real disposable verification', async (context) => {
  const fixture = await project(context);
  const { NODE_HASHES, NODE_TARGET_PATH, NODE_BASELINE, NODE_REPLACEMENT } = require('../src/node-fixture');
  const { ProposalCandidateStore, ApplyProposalTool, APPLY_LABEL } = require('../src/proposal-apply');
  const { GenerateProposalReportTool } = require('../src/extension');
  for (const relativePath of Object.keys(NODE_HASHES)) {
    const destination = path.join(fixture.root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, '../../fixtures/node', relativePath), destination);
  }
  const targetFile = path.join(fixture.root, NODE_TARGET_PATH);
  const original = await fs.readFile(targetFile);
  const range = { start: { line: 2, character: 0 }, end: { line: 1 + NODE_BASELINE.split('\n').length, character: 1 } };
  fixture.vscode.workspace.findFiles = async () => Object.keys(NODE_HASHES).map((relativePath) => uri(path.join(fixture.root, relativePath)));
  fixture.vscode.commands.executeCommand = async (command) => {
    if (command === 'vscode.executeDocumentSymbolProvider') return [{ name: 'transfer', range,
      selectionRange: { start: { line: 2, character: 9 }, end: { line: 2, character: 17 } } }];
    if (command === 'vscode.executeReferenceProvider') return [{ uri: uri(path.join(fixture.root, 'src/runner.js')), range: { start: { line: 10, character: 0 } } }];
    if (command === 'vscode.prepareCallHierarchy') return [{ uri: uri(targetFile), selectionRange: range }];
    if (command === 'vscode.provideIncomingCalls') return [{ from: {
      uri: uri(path.join(fixture.root, 'src/runner.js')), selectionRange: { start: { line: 10, character: 0 } }
    } }];
    return [];
  };
  fixture.vscode.Uri.file = uri;
  fixture.vscode.workspace.getConfiguration = () => ({ get: (name, fallback) => fallback });
  fixture.vscode.workspace.openTextDocument = async (value) => ({ uri: value });
  fixture.vscode.window.showTextDocument = async () => {};
  fixture.vscode.LanguageModelToolResult = class { constructor(parts) { this.parts = parts; } };
  fixture.vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  const store = new ProposalCandidateStore();
  const generation = new GenerateProposalReportTool(fixture.vscode, store, {
    env: fakeEnv,
    fetchImpl: fakeFoundry((collected) => ({
      ...proposalFor(collected, [{ path: collected.target.path, originalText: collected.target.source.text,
        replacementText: NODE_REPLACEMENT, rationale: 'Replace nested guards with direct early exits.' }]),
    }))
  });
  const input = { projectRoot: fixture.root, targetFile, targetSymbol: 'transfer' };
  fixture.vscode.window.showWarningMessage = async (message) => message === 'Generate and write a proposal report without changing source?'
    ? 'Generate report' : 'Send collected context';
  const metadata = JSON.parse((await generation.invoke({ input })).parts[0].value);
  assert.equal(metadata.status, 'ready', JSON.stringify(metadata));
  assert.ok(metadata.proposalId);
  assert.equal(store.list()[0].id, metadata.proposalId);
  assert.deepEqual(await fs.readFile(targetFile), original);
  const report = await fs.readFile(metadata.reportPath, 'utf8');
  assert.match(report, /Observed baseline inputs\/outputs: captured/);
  assert.match(report, /extension generated these bounded inputs/i);
  assert.equal((report.match(/### Sample \d+/g) ?? []).length, 5);
  assert.match(report, /Observed stdout:[\s\S]*"alice"[\s\S]*"bob"/);
  assert.match(report, /return.*source missing/);
  const provenance = report.split('### Discovery Provenance And Limits')[1].split('### Validated Source Catalog')[0];
  const discovery = JSON.parse(provenance.slice(provenance.indexOf('{'), provenance.lastIndexOf('}') + 1));
  assert.deepEqual(discovery.incomingCalls, [{ path: 'src/runner.js', line: 11 }]);
  fixture.vscode.window.showWarningMessage = async () => undefined;
  const apply = new ApplyProposalTool(fixture.vscode, store);
  assert.equal(JSON.parse((await apply.invoke({ input: { proposalId: metadata.proposalId } })).parts[0].value).status, 'cancelled');
  assert.deepEqual(await fs.readFile(targetFile), original);
  fixture.vscode.window.showWarningMessage = async (message, options) => {
    assert.match(options.detail, /Exact diff:/);
    return APPLY_LABEL;
  };
  const result = JSON.parse((await apply.invoke({ input: { proposalId: metadata.proposalId } })).parts[0].value);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.ok((await fs.readFile(targetFile, 'utf8')).replace(/\r\n/g, '\n').includes(NODE_REPLACEMENT));
  fixture.vscode.window.showWarningMessage = async () => 'Send collected context';
  const again = await generateProposalReport(fixture.vscode, input, undefined,
    { env: fakeEnv, fetchImpl: fakeFoundry() });
  assert.deepEqual(again.proposal.changes, []);
  fixture.vscode.commands.executeCommand = async () => { throw new Error('TypeScript provider unavailable'); };
  const unavailable = await generateProposalReport(fixture.vscode, input, undefined,
    { env: fakeEnv, fetchImpl: fakeFoundry() });
  assert.deepEqual(unavailable.proposal.changes, []);
  assert.match(await fs.readFile(unavailable.reportPath, 'utf8'), /provider unavailable/);
});
