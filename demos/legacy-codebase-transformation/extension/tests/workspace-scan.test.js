'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chunkSourceFiles, inventorySourceFiles, scanPrompt } = require('../src/workspace-scan');
const { scanWorkspace } = require('../src/scan-pipeline');
const { FindingStore } = require('../src/finding-store');
const { hashSource } = require('../src/workspace-scan');

function uri(filePath) {
  return { scheme: 'file', authority: '', fsPath: filePath };
}

test('inventory admits only root-contained visible source and chunks without exceeding the byte limit', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-scan-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'src', 'sample.js');
  const hiddenPath = path.join(temporaryRoot, '.private', 'secret.ts');
  const dependencyPath = path.join(temporaryRoot, 'node_modules', 'pkg', 'index.js');
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-outside-'));
  context.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  const outsidePath = path.join(outsideRoot, 'escaped.cs');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(hiddenPath), { recursive: true });
  await fs.mkdir(path.dirname(dependencyPath), { recursive: true });
  await fs.writeFile(sourcePath, `${'const value = 1;\n'.repeat(4)}`);
  await fs.writeFile(hiddenPath, 'const secret = true;');
  await fs.writeFile(dependencyPath, 'module.exports = {};');
  await fs.writeFile(outsidePath, 'class Escaped {}');
  const linkedPath = path.join(temporaryRoot, 'linked.cs');
  let linkedUri;
  try {
    await fs.symlink(outsidePath, linkedPath, 'file');
    linkedUri = uri(linkedPath);
  } catch (error) {
    linkedUri = uri(outsidePath);
  }

  const candidates = [sourcePath, hiddenPath, dependencyPath].map(uri).concat(linkedUri);
  const folder = { uri: uri(temporaryRoot) };
  const vscode = {
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => candidates,
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await inventorySourceFiles(vscode, temporaryRoot);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.files.map((file) => file.path), ['src/sample.js']);
  assert.equal(result.skipped, 3);
  const bounded = chunkSourceFiles(result.files, 32);
  assert.ok(bounded.chunks.length > 1);
  assert.ok(bounded.chunks.every((chunk) => Buffer.byteLength(chunk.content) <= 32));
  assert.equal(bounded.skipped, 0);
});

test('inventory requires an exact open workspace root and cancellation stops enumeration', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-root-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const folder = { uri: uri(temporaryRoot) };
  const vscode = {
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => { throw new Error('No scan expected after cancellation.'); },
      fs: { readFile: fs.readFile }
    }
  };
  await assert.rejects(inventorySourceFiles(vscode, path.dirname(temporaryRoot)), /open VS Code workspace folder/);
  assert.equal((await inventorySourceFiles(vscode, temporaryRoot, { isCancellationRequested: true })).status, 'cancelled');
});

test('declining source-sharing consent makes no model request and returns no findings', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-consent-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'sample.js');
  await fs.writeFile(sourcePath, 'function sample() { return true; }\n');
  const folder = { uri: uri(temporaryRoot) };
  let requests = 0;
  let consentDetail = '';
  const vscode = {
    RelativePattern: class {},
    window: { showWarningMessage: async (message, options) => { consentDetail = options.detail; return undefined; } },
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => [uri(sourcePath)],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot,
    { vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() {} }, undefined,
    { requestModel: async () => { requests += 1; return '{"findings":[]}'; } });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.findings, []);
  assert.equal(result.requests, 0);
  assert.equal(requests, 0);
  assert.match(consentDetail, /Eligible source files: 1/);
  assert.match(consentDetail, /Projected model requests: 1/);
  assert.match(consentDetail, /Destination: test \/ test-model/);
});

test('scan validates exact source locations and reports the request ceiling as incomplete', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-budget-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourceFiles = [];
  for (let index = 0; index < 31; index += 1) {
    const filePath = path.join(temporaryRoot, `sample-${index}.js`);
    await fs.writeFile(filePath, 'function sample() { return true; }\n');
    sourceFiles.push(uri(filePath));
  }
  const folder = { uri: uri(temporaryRoot) };
  let requests = 0;
  const vscode = {
    RelativePattern: class {},
    window: { showWarningMessage: async () => 'Send source and scan' },
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => sourceFiles,
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot,
    { vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() {} }, undefined,
    { requestModel: async (chunk) => {
      requests += 1;
      const originalText = chunk.content.split('\n')[0];
      return JSON.stringify({ findings: [{
        category: 'redundant-control-flow', rationale: 'The function returns a constant.', confidence: 'low',
        symbol: 'sample', functionStartLine: 1, functionEndLine: 1,
        startLine: 1, startCharacter: 0, endLine: 1, endCharacter: originalText.length, originalText
      }] });
    } });
  assert.equal(requests, 30);
  assert.equal(result.requests, 30);
  assert.equal(result.findings.length, 30);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.projectedRequests, 31);
  assert.equal(result.findings[0].path, 'sample-0.js');
  assert.equal(result.findings[0].range.startLine, 1);
});

test('scan rejects malformed and out-of-source spans while retaining valid exact evidence', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-locations-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'sample.ts');
  const sourceLine = 'function sample() { return true; }';
  await fs.writeFile(sourcePath, `${sourceLine}\n`);
  const folder = { uri: uri(temporaryRoot) };
  const vscode = {
    RelativePattern: class {},
    window: { showWarningMessage: async () => 'Send source and scan' },
    workspace: {
      workspaceFolders: [folder], findFiles: async () => [uri(sourcePath)],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot, { sendRequest() {}, vendor: 'test' }, undefined, {
    requestModel: async () => JSON.stringify({ findings: [
      { category: 'repeated-local-expression', rationale: 'Valid evidence.', confidence: 'medium', symbol: 'sample',
        functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
        endLine: 1, endCharacter: sourceLine.length, originalText: sourceLine },
      { category: 'repeated-local-expression', rationale: 'Invented evidence.', confidence: 'high', symbol: 'sample',
        functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
        endLine: 1, endCharacter: sourceLine.length, originalText: 'not present in the source' }
    ] })
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].originalText, sourceLine);
  assert.equal(result.rejected, 0);
});

test('scan stops at 30 findings and request JSON remains under 256 KB', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-findings-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourceFiles = [];
  const sourceLine = 'function sample() { return true; }';
  for (let index = 0; index < 11; index += 1) {
    const filePath = path.join(temporaryRoot, `sample-${index}.js`);
    await fs.writeFile(filePath, `${sourceLine}\n`);
    sourceFiles.push(uri(filePath));
  }
  const folder = { uri: uri(temporaryRoot) };
  let requests = 0;
  const vscode = {
    RelativePattern: class {},
    window: { showWarningMessage: async () => 'Send source and scan' },
    workspace: {
      workspaceFolders: [folder], findFiles: async () => sourceFiles,
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot, { sendRequest() {}, vendor: 'test' }, undefined, {
    requestModel: async (chunk) => {
      requests += 1;
      const finding = { category: 'complex-function-simplification', rationale: 'Review this function.',
        confidence: 'low', symbol: 'sample', functionStartLine: 1, functionEndLine: 1,
        startLine: 1, startCharacter: 0, endLine: 1, endCharacter: sourceLine.length, originalText: sourceLine };
      assert.ok(Buffer.byteLength(scanPrompt(chunk, 30), 'utf8') <= 256 * 1024);
      return JSON.stringify({ findings: [finding, finding, finding] });
    }
  });
  assert.equal(requests, 10);
  assert.equal(result.findings.length, 30);
  assert.equal(result.projectedRequests, 11);
  assert.equal(result.status, 'incomplete');
  const worstEscapingChunk = { path: 'control.js', content: '\u0001'.repeat(30 * 1024) };
  assert.ok(Buffer.byteLength(scanPrompt(worstEscapingChunk, 30), 'utf8') <= 256 * 1024);
});

test('finding queue selects, approves, dismisses, and permanently rejects stale source', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-findings-state-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'sample.js');
  const source = 'function sample() { return true; }\n';
  await fs.writeFile(sourcePath, source);
  const folder = { uri: uri(temporaryRoot) };
  const vscode = { workspace: { workspaceFolders: [folder], textDocuments: [] } };
  const store = new FindingStore();
  store.addScan({ root: temporaryRoot, scanId: 'scan-1', findings: [
    { id: 'finding-1', scanId: 'scan-1', path: 'sample.js', sourceHash: hashSource(source), originalText: source.trim(), status: 'new' },
    { id: 'finding-2', scanId: 'scan-1', path: 'sample.js', sourceHash: hashSource(source), originalText: source.trim(), status: 'new' }
  ] });

  assert.equal((await store.select(vscode, 'finding-1')).status, 'selected');
  assert.equal((await store.approve(vscode, 'finding-1')).status, 'approved');
  assert.equal(store.getApproved('finding-1').path, 'sample.js');
  assert.equal(store.dismiss('finding-2').status, 'dismissed');
  await fs.writeFile(sourcePath, `${source}// changed\n`);
  assert.equal((await store.refresh(vscode, 'finding-1')).status, 'stale');
  assert.equal(store.getApproved('finding-1'), null);
});
