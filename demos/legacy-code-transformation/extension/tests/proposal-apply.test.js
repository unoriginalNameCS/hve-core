'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { generateProposalReport } = require('../src/proposal-report');
const { APPLY_LABEL, ProposalCandidateStore, replacementBytes, ApplyProposalTool } = require('../src/proposal-apply');
const { TARGET_PATH, readControlledFixture, verifyPizzaProposal, runDotnet, runNode } = require('../src/fixture-replay');

const fixtureRoot = path.resolve(__dirname, '../../fixtures/dotnet');
const fixturePaths = ['PizzaEligibility.sln', TARGET_PATH, 'src/PizzaEligibility/Program.cs',
  'src/PizzaEligibility/PizzaEligibility.csproj', 'tests/PizzaEligibility.Tests/PizzaEligibility.Tests.csproj',
  'tests/PizzaEligibility.Tests/PizzaEligibilityTests.cs'];

function uri(filePath) {
  return { scheme: 'file', authority: '', fsPath: filePath, path: filePath.split(path.sep).join('/') };
}

async function project(context, newline = '\n', bom = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-apply-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const relativePath of fixturePaths) {
    const destination = path.join(root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    let text = (await fs.readFile(path.join(fixtureRoot, relativePath), 'utf8')).replace(/\r\n/g, '\n');
    if (relativePath === TARGET_PATH) text = `${bom ? '\ufeff' : ''}${text.replace(/\n/g, newline)}`;
    await fs.writeFile(destination, text);
  }
  const canonicalRoot = await fs.realpath(root);
  const targetFile = path.join(canonicalRoot, TARGET_PATH);
  const bytes = await fs.readFile(targetFile);
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  const range = { start: { line: lines.findIndex((line) => line.includes('public static decimal CalculateDiscountAmount')), character: 4 },
    end: { line: lines.findLastIndex((line) => line === '    }'), character: 5 } };
  const documents = new Map([[targetFile, { uri: uri(targetFile), version: 1, isDirty: false }]]);
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) }, RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: uri(canonicalRoot) }], textDocuments: [...documents.values()],
      findFiles: async () => fixturePaths.map((relativePath) => uri(path.join(canonicalRoot, relativePath))),
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) },
      openTextDocument: async (filePath) => {
        const key = typeof filePath === 'string' ? filePath : filePath.fsPath;
        if (!documents.has(key)) documents.set(key, { uri: uri(key), version: 1, isDirty: false });
        vscode.workspace.textDocuments = [...documents.values()];
        return documents.get(key);
      }
    },
    commands: { executeCommand: async (command) => command === 'vscode.executeDocumentSymbolProvider' ?
      [{ name: 'CalculateDiscountAmount', range, selectionRange: { start: range.start, end: range.start } }] : [] },
    window: { showWarningMessage: async (message, options) => options.detail?.includes('Proposal ID:') ? APPLY_LABEL : 'Continue with C# providers' }
  };
  const result = await generateProposalReport(vscode, { projectRoot: canonicalRoot, targetFile, targetSymbol: 'CalculateDiscountAmount' }, undefined,
    { roslynAnalyzer: async () => ({ mode: 'msbuild', semanticReferencesResolved: true, references: [], diagnostics: [] }) });
  let verificationCalls = 0;
  const store = new ProposalCandidateStore(async (candidate) => {
    verificationCalls += 1;
    const { hashBytes } = require('../src/proposal-apply');
    const files = await readControlledFixture(candidate);
    return { status: 'passed', fixtureHashes: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hashBytes(content)])) };
  });
  const id = await store.add(vscode, result);
  return { root: canonicalRoot, targetFile, bytes, documents, vscode, result, store, id, calls: () => verificationCalls };
}

test('approved ID applies only exact span, keeps CRLF/BOM and immutable snapshot despite caller mutation', async (context) => {
  const fixture = await project(context, '\r\n', true);
  const expected = replacementBytes(fixture.result);
  fixture.result.proposal.changes[0].replacementText = 'forged';
  fixture.result.sourceSnapshot = {};
  fixture.vscode.window.showWarningMessage = async (message, options) => {
    assert.equal(options.modal, true);
    assert.ok(options.detail.includes(fixture.targetFile));
    assert.match(options.detail, /Original:[\s\S]*Replacement:[\s\S]*Exact diff:/);
    assert.match(options.detail, /proposed code executes[\s\S]*not an OS sandbox/);
    assert.ok(options.detail.includes(fixture.store.list()[0].proposalHash));
    return APPLY_LABEL;
  };
  const result = await fixture.store.apply(fixture.vscode, fixture.id);
  assert.equal(result.status, 'applied');
  assert.deepEqual(await fs.readFile(fixture.targetFile), expected);
  assert.equal(fixture.calls(), 1);
  assert.equal(fixture.store.list()[0].status, 'applied');
  assert.equal((await fixture.store.apply(fixture.vscode, fixture.id)).status, 'rejected');
  const applicationReport = await fs.readFile(result.verificationReportPath, 'utf8');
  assert.match(applicationReport, /Verification: passed/);
  assert.match(applicationReport, /Application: applied/);
  assert.match(applicationReport, new RegExp(`Applied source SHA-256: ${result.sourceHash}`));
  assert.equal(require('../src/proposal-apply').hashBytes(await fs.readFile(fixture.targetFile)), result.sourceHash);
});

test('cancelled confirmation and wrong ID leave all source unchanged and never replay', async (context) => {
  const fixture = await project(context);
  fixture.vscode.window.showWarningMessage = async () => undefined;
  assert.equal((await fixture.store.apply(fixture.vscode, 'wrong')).status, 'rejected');
  assert.equal((await fixture.store.apply(fixture.vscode, fixture.id)).status, 'cancelled');
  assert.equal(fixture.calls(), 0);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

for (const mutation of ['source', 'modal-source', 'report', 'modal-report', 'dirty-source', 'modal-dirty-source', 'dirty-report', 'version', 'modal-version', 'closed-root']) {
  test(`${mutation} invalidates stored proposal without overwriting concurrent work`, async (context) => {
    const fixture = await project(context);
    const mutate = async () => {
      if (mutation.includes('source') && !mutation.includes('dirty')) await fs.appendFile(fixture.targetFile, '\n// concurrent edit\n');
      if (mutation === 'report' || mutation === 'modal-report') await fs.appendFile(fixture.result.reportPath, '\nChanged report\n');
      if (mutation === 'dirty-source' || mutation === 'modal-dirty-source') fixture.documents.get(fixture.targetFile).isDirty = true;
      if (mutation === 'dirty-report') (await fixture.vscode.workspace.openTextDocument(fixture.result.reportPath)).isDirty = true;
      if (mutation.includes('version')) fixture.documents.get(fixture.targetFile).version += 1;
      if (mutation === 'closed-root') fixture.vscode.workspace.workspaceFolders = [];
    };
    if (mutation.startsWith('modal-')) fixture.vscode.window.showWarningMessage = async () => { await mutate(); return APPLY_LABEL; };
    else await mutate();
    const expected = await fs.readFile(fixture.targetFile);
    assert.equal((await fixture.store.apply(fixture.vscode, fixture.id)).status, 'rejected');
    const final = await fs.readFile(fixture.targetFile);
    if (mutation === 'modal-source') assert.ok(final.toString().endsWith('// concurrent edit\n'));
    else assert.deepEqual(final, expected);
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.store.list()[0].status, 'stale');
  });
}

test('symlink escape fails closed before replay', async (context) => {
  const fixture = await project(context);
  const directory = path.join(fixture.root, 'src/PizzaEligibility');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-escape-'));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.rename(directory, path.join(outside, 'PizzaEligibility'));
  await fs.symlink(path.join(outside, 'PizzaEligibility'), directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fixture.store.apply(fixture.vscode, fixture.id)).status, 'rejected');
  assert.deepEqual(await fs.readFile(path.join(outside, 'PizzaEligibility/PizzaDiscountCalculator.cs')), fixture.bytes);
  assert.equal(fixture.calls(), 0);
});

test('changed harness fails closed without executing project content', async (context) => {
  const fixture = await project(context);
  const harness = path.join(fixture.root, 'src/PizzaEligibility/Program.cs');
  await fs.appendFile(harness, '\n// untrusted harness edit\n');
  assert.equal((await fixture.store.apply(fixture.vscode, fixture.id)).status, 'rejected');
  assert.equal(fixture.calls(), 0);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

test('even an in-root report directory symlink is rejected at registration and apply', async (context) => {
  const fixture = await project(context);
  const reportDirectory = path.join(fixture.root, 'reports');
  const mirror = path.join(fixture.root, 'mirror-reports');
  await fs.rename(reportDirectory, mirror);
  await fs.symlink(mirror, reportDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ProposalCandidateStore().add(fixture.vscode, fixture.result), /Unsafe source or report path/);
  assert.equal((await fixture.store.apply(fixture.vscode, fixture.id)).status, 'rejected');
  assert.equal(fixture.calls(), 0);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

test('stale proposal hash and tampered report before registration cannot become candidates', async (context) => {
  const fixture = await project(context);
  const changed = structuredClone(fixture.result);
  changed.proposal.summary = 'Changed after report';
  await assert.rejects(new ProposalCandidateStore().add(fixture.vscode, changed), /Invalid proposal/);
  await fs.appendFile(fixture.result.reportPath, '\nChanged before registration\n');
  await assert.rejects(new ProposalCandidateStore().add(fixture.vscode, fixture.result), /report changed/);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

test('span offsets select the second identical method rather than the first string match', () => {
  const { hashBytes } = require('../src/proposal-apply');
  const text = 'method() {}\r\nmethod() {}\r\n';
  const bytes = Buffer.from(text);
  const candidate = { sourceSnapshot: { text, bytes: bytes.toString('base64'), fileHash: hashBytes(bytes) },
    target: { source: { startLine: 2, endLine: 2, startCharacter: 0, endCharacter: 11, text: 'method() {}' } },
    proposal: { changes: [{ replacementText: 'changed() {}' }] } };
  assert.equal(replacementBytes(candidate).toString(), 'method() {}\r\nchanged() {}\r\n');
});

test('replay mismatch produces failure report without source mutation', async (context) => {
  const fixture = await project(context);
  const store = new ProposalCandidateStore(async () => ({ status: 'failed', reason: 'Replay outputs differ.', baseline: { stdout: '2.50' }, transformed: { stdout: '2.75' } }));
  const id = await store.add(fixture.vscode, fixture.result);
  const result = await store.apply(fixture.vscode, id);
  assert.equal(result.status, 'failed');
  const verificationReport = await fs.readFile(result.verificationReportPath, 'utf8');
  assert.match(verificationReport, /Replay outputs differ/);
  assert.match(verificationReport, /Application: not applied/);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

test('source mutation during replay is preserved and requires fresh generation', async (context) => {
  const fixture = await project(context);
  const store = new ProposalCandidateStore(async () => {
    await fs.appendFile(fixture.targetFile, '\n// concurrent edit\n');
    return { status: 'passed' };
  });
  const id = await store.add(fixture.vscode, fixture.result);
  const result = await store.apply(fixture.vscode, id);
  assert.equal(result.status, 'rejected');
  const verificationReport = await fs.readFile(result.verificationReportPath, 'utf8');
  assert.match(verificationReport, /Verification: passed/);
  assert.match(verificationReport, /Application: not applied/);
  assert.ok((await fs.readFile(fixture.targetFile, 'utf8')).endsWith('// concurrent edit\n'));
});

test('cancellation during verification leaves source unchanged', async (context) => {
  const fixture = await project(context);
  const token = { isCancellationRequested: false };
  const store = new ProposalCandidateStore(async () => {
    token.isCancellationRequested = true;
    return { status: 'passed' };
  });
  const id = await store.add(fixture.vscode, fixture.result);
  const result = await store.apply(fixture.vscode, id, token);
  assert.equal(result.status, 'cancelled');
  const verificationReport = await fs.readFile(result.verificationReportPath, 'utf8');
  assert.match(verificationReport, /Verification: passed/);
  assert.match(verificationReport, /Application: not applied/);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

test('no-change candidates are excluded and apply tool rejects caller approval/patch objects', async (context) => {
  const fixture = await project(context);
  assert.equal(await fixture.store.add(fixture.vscode, { status: 'ready', proposal: { changes: [] } }), null);
  fixture.vscode.LanguageModelToolResult = class { constructor(parts) { this.parts = parts; } };
  fixture.vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  const tool = new ApplyProposalTool(fixture.vscode, fixture.store);
  const result = await tool.invoke({ input: { proposalId: fixture.id, approved: true } });
  assert.equal(JSON.parse(result.parts[0].value).status, 'rejected');
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
});

test('controlled runner bounds timeout, cancellation and failed launch without a shell', async () => {
  let cancel;
  let killed = false;
  const spawnFake = (command, args, options) => {
    assert.ok(command === 'dotnet' || command === 'node');
    assert.equal(options.shell, false);
    assert.equal(options.env.api_key, undefined);
    assert.equal(options.env.model, undefined);
    assert.equal(options.env.endpoint, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; child.emit('close', null); };
    return child;
  };
  for (const runner of [runDotnet, runNode]) {
    await assert.rejects(runner(['--version'], os.tmpdir(), undefined, 5, spawnFake), { code: 'TIMEOUT' });
    assert.equal(killed, true);
    const token = { onCancellationRequested: (callback) => { cancel = callback; return { dispose() {} }; } };
    const pending = runner(['--version'], os.tmpdir(), token, 1000, spawnFake);
    cancel();
    await assert.rejects(pending, { code: 'CANCELLED' });
    await assert.rejects(runner(['--version'], os.tmpdir(), undefined, 1000, (...args) => {
      const child = spawnFake(...args);
      queueMicrotask(() => child.emit('error', new Error('not found')));
      return child;
    }), /could not launch/);
  }
});

test('Node replay launches standalone node instead of the extension-host executable', async () => {
  const result = await runNode(['--version'], os.tmpdir(), undefined, 1000, (command, args, options) => {
    assert.equal(command, 'node');
    assert.deepEqual(args, ['--version']);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('v24.19.0\n'));
      child.emit('close', 0);
    });
    return child;
  });
  assert.deepEqual(result.command, ['node', '--version']);
  assert.equal(result.exitCode, 0);
});

test('real dotnet tests and four before/after inputs run on disposable copy, never original fixture', async (context) => {
  const original = await fs.readFile(path.join(fixtureRoot, TARGET_PATH));
  const fixture = await project(context);
  fixture.result.mode = 'live';
  fixture.result.sampleInputs = [
    { subtotal: '40.00', isMember: true },
    { subtotal: '60.00', isMember: false },
    { subtotal: '49.90', isMember: false }
  ];
  const result = await verifyPizzaProposal(fixture.result);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.baseline.cases.length, 4);
  assert.equal(result.transformed.cases.length, 4);
  assert.equal(result.baseline.suggestedCases.length, 3);
  assert.equal(result.transformed.suggestedCases.length, 3);
  assert.deepEqual(result.baseline.suggestedCases.map((item) => [item.expectedOutput, item.passed]),
    [['4.00', true], ['6.00', true], ['0.00', true]]);
  assert.match(result.baseline.tests.stdout, /Passed:\s+4/);
  assert.match(result.transformed.tests.stdout, /Passed:\s+4/);
  assert.deepEqual(result.baseline.cases.map((item) => item.stdout.trim()), ['2.50', '0.00', '5.00', '7.50']);
  assert.deepEqual(await fs.readFile(fixture.targetFile), fixture.bytes);
  assert.deepEqual(await fs.readFile(path.join(fixtureRoot, TARGET_PATH)), original);
});

test('real Node baseline and alternate model replacement pass reset-state tests and process replay without changing fixture', async (context) => {
  const { NODE_HASHES, NODE_TARGET_PATH, NODE_BASELINE, NODE_REPLACEMENT } = require('../src/node-fixture');
  const { hashBytes } = require('../src/proposal-apply');
  const { verifyControlledProposal } = require('../src/fixture-replay');
  const originalRoot = path.resolve(__dirname, '../../fixtures/node');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-node-apply-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const relativePath of Object.keys(NODE_HASHES)) {
    const destination = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(originalRoot, relativePath), destination);
  }
  const root = await fs.realpath(directory);
  const filePath = path.join(root, NODE_TARGET_PATH);
  const bytes = await fs.readFile(filePath);
  const text = bytes.toString('utf8');
  const candidate = { target: { path: NODE_TARGET_PATH, symbol: 'transfer', source: {
    text: NODE_BASELINE, startLine: 3, startCharacter: 0, endLine: 2 + NODE_BASELINE.split('\n').length, endCharacter: 1
  } }, sourceSnapshot: { rootPath: root, text, bytes: bytes.toString('base64'), fileHash: hashBytes(bytes) },
  mode: 'live', sampleInputs: [
    { accounts: [{ id: 'alice', balance: 100 }, { id: 'bob', balance: 50 }], sourceId: 'alice', destinationId: 'bob', amount: 25 },
    { accounts: [{ id: 'alice', balance: 100 }, { id: 'bob', balance: 50 }], sourceId: 'alice', destinationId: 'bob', amount: 0 },
    { accounts: [{ id: 'alice', balance: 100 }, { id: 'bob', balance: 50 }], sourceId: 'missing', destinationId: 'bob', amount: 1 }
  ],
  proposal: { changes: [{ replacementText: NODE_REPLACEMENT.replace(
    '\n  if (!Object.hasOwn(accounts, sourceId))', '\n\n  if (!Object.hasOwn(accounts, sourceId))') }] } };
  assert.notEqual(candidate.proposal.changes[0].replacementText, NODE_REPLACEMENT);
  const verification = await verifyControlledProposal(candidate);
  assert.equal(verification.status, 'passed', JSON.stringify(verification));
  assert.equal(verification.baseline.cases.length, 9);
  assert.equal(verification.transformed.cases.length, 9);
  assert.equal(verification.baseline.suggestedCases.length, 3);
  assert.equal(verification.transformed.suggestedCases.length, 3);
  assert.ok(verification.baseline.suggestedCases.every((item) => item.passed));
  assert.ok(verification.transformed.suggestedCases.every((item) => item.passed));
  assert.equal(JSON.parse(verification.baseline.tests.stdout).counts.passed, 8);
  assert.equal(JSON.parse(verification.transformed.tests.stdout).counts.passed, 8);
  assert.deepEqual(await fs.readFile(filePath), bytes);
  assert.deepEqual(await fs.readFile(path.join(originalRoot, NODE_TARGET_PATH)), bytes);
  await fs.appendFile(path.join(root, 'src/runner.js'), '\n');
  await assert.rejects(readControlledFixture(candidate), /fingerprint differs/);
});
