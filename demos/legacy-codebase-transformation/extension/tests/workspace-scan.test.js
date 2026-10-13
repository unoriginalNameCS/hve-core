'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chunkSourceFiles, inventorySourceFiles, scanPrompt } = require('../src/workspace-scan');
const { scanWorkspace, validateFindingResponse } = require('../src/scan-pipeline');
const { FindingStore } = require('../src/finding-store');
const { ProposalStore } = require('../src/proposal-workflow');
const { hashSource } = require('../src/workspace-scan');
const { renderScanReport, writeScanReport } = require('../src/scan-report');
const { ReviewFindingsTool, ScanWorkspaceTool, TransformCodebaseTool } = require('../src/extension');

function uri(filePath) {
  return { scheme: 'file', authority: '', fsPath: filePath };
}

async function scanToolFixture(context, count = 31, requestModel) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-continue-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = path.join(temporaryRoot, 'project');
  await fs.mkdir(projectRoot);
  const sourceFiles = [];
  const sourceLine = 'function sample() { return 0 + 1; }';
  for (let index = 0; index < count; index += 1) {
    const filePath = path.join(projectRoot, `sample-${index}.js`);
    await fs.writeFile(filePath, `${sourceLine}\n`);
    sourceFiles.push(uri(filePath));
  }
  const state = { requests: 0, selections: 0, progress: [] };
  const vscode = {
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    RelativePattern: class {},
    ProgressLocation: { Notification: 15 },
    Uri: { file: uri },
    window: {
      withProgress: async (options, task) => task({ report: (value) => state.progress.push(value.message) }),
      showTextDocument: async () => {}
    },
    workspace: {
      workspaceFolders: [{ uri: uri(projectRoot) }],
      findFiles: async () => sourceFiles,
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) },
      openTextDocument: async (fileUri) => ({ uri: fileUri }),
      textDocuments: []
    }
  };
  const store = new FindingStore();
  const tool = new ScanWorkspaceTool(vscode, store, {
    reportDirectory: path.join(temporaryRoot, 'reports'),
    selectLanguageModel: async () => { state.selections += 1; return { sendRequest() {}, vendor: 'test', id: 'model' }; },
    requestModel: async (chunk, token) => {
      state.requests += 1;
      if (requestModel) return requestModel(chunk, token, state);
      return { findings: [{ category: 'repeated-local-expression', rationale: 'Simplify a constant expression.',
        confidence: 'medium', symbol: 'sample', functionStartLine: 1, functionEndLine: 1,
        startLine: 1, startCharacter: 0, endLine: 1, endCharacter: sourceLine.length,
        originalText: sourceLine, replacementText: 'function sample() { return 1; }' }] };
    }
  });
  const invoke = async (input, token) => JSON.parse((await tool.invoke({ input }, token)).content[0].value);
  const approve = async (scanId, token) => {
    const preview = await invoke({ phase: 'prepare', projectRoot, ...(scanId ? { scanId } : {}) });
    assert.equal(preview.status, 'awaiting-decision');
    return invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' }, token);
  };
  return { projectRoot, sourceFiles, store, tool, state, vscode, invoke, approve };
}

test('technical-debt prompt broadens review and explicitly checks redundant else after return', () => {
  const prompt = JSON.parse(scanPrompt({ path: 'src/index.js', content: 'if (ready) return value; else return fallback;\n',
    startLine: 1, sourceHash: 'hash' }, 5));
  assert.match(prompt.instructions, /concrete technical debt/);
  assert.match(prompt.instructions, /else\/else-if after a branch that returns/);
  assert.match(prompt.instructions, /category labels are not an exhaustive checklist/);
  assert.match(prompt.instructions, /Preserve behavior/);
  assert.equal(prompt.remainingFindingBudget, 5);
});

async function combinedToolFixture(context, requestModel) {
  const fixture = await scanToolFixture(context, 1, requestModel);
  const manifest = { name: 'sample', version: '1.0.0', dependencies: { alpha: '^1' } };
  for (const [name, value] of Object.entries({ 'package.json': manifest,
    'package-lock.json': { name: 'sample', version: '1.0.0', lockfileVersion: 3,
      packages: { '': manifest, 'node_modules/alpha': { version: '1.0.0',
        resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz' } } } })) {
    const filePath = path.join(fixture.projectRoot, name);
    await fs.writeFile(filePath, JSON.stringify(value));
    fixture.sourceFiles.push(uri(filePath));
  }
  const calls = [];
  fixture.tool.options.transport = async (request) => {
    calls.push(request);
    return request.method === 'POST' ? {} : { name: 'alpha', 'dist-tags': { latest: '1.2.0' },
      versions: { '1.0.0': { name: 'alpha', version: '1.0.0', deprecated: 'Use a newer release.' },
        '1.2.0': { name: 'alpha', version: '1.2.0' } } };
  };
  let opened = 0;
  fixture.tool.vscode.window.showTextDocument = async () => { opened += 1; };
  return { ...fixture, calls, opened: () => opened,
    prepareCombined: () => fixture.invoke({ phase: 'prepare', projectRoot: fixture.projectRoot, includeDependencies: true }) };
}

test('combined preview and decline send no source or metadata and cannot be reused', async (context) => {
  const fixture = await combinedToolFixture(context);
  const preview = await fixture.prepareCombined();
  assert.equal(preview.status, 'awaiting-decision');
  assert.equal(preview.includeDependencies, true);
  assert.deepEqual(preview.dependencies.registryNames, ['alpha']);
  assert.deepEqual(preview.dependencies.advisoryTuples, [{ name: 'alpha', version: '1.0.0' }]);
  assert.equal(preview.dependencies.destinations.length, 2);
  assert.match(preview.approvalScope, /both/);
  assert.equal(fixture.state.requests, 0);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.opened(), 0);
  const input = { phase: 'confirm', previewId: preview.previewId, decision: 'reject' };
  const declined = await fixture.invoke(input);
  assert.equal(declined.status, 'cancelled');
  assert.equal(declined.dependencyRequests, 0);
  assert.equal((await fixture.invoke({ ...input, decision: 'approve' })).status, 'rejected');
  assert.equal(fixture.state.requests, 0);
  assert.equal(fixture.calls.length, 0);
});

test('combined approval writes and opens one report containing source findings and npm evidence', async (context) => {
  const fixture = await combinedToolFixture(context);
  const before = await Promise.all(fixture.sourceFiles.map((fileUri) => fs.readFile(fileUri.fsPath)));
  const preview = await fixture.prepareCombined();
  const result = await fixture.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'completed');
  assert.equal(result.sourceStatus, 'completed');
  assert.equal(result.dependencyStatus, 'completed');
  assert.equal(result.requests, 1);
  assert.equal(result.dependencyRequests, 2);
  assert.equal(result.sourceSnapshotCurrent, true);
  assert.equal(result.currentDependencySnapshot, true);
  assert.equal(result.findingCount, 1);
  assert.equal(fixture.opened(), 1);
  assert.match(path.basename(result.reportPath), /^codebase-review-/);
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /# Codebase Technical Debt And Dependency Report/);
  assert.match(report, /Simplify a constant expression/);
  assert.match(report, /Published latest tag: 1\\\.2\\\.0/);
  assert.match(report, /Use a newer release/);
  assert.match(report, /Published Advisory Evidence/);
  assert.match(report, /- \[ \] Reviewed and validated/);
  assert.deepEqual(await Promise.all(fixture.sourceFiles.map((fileUri) => fs.readFile(fileUri.fsPath))), before);
});

test('changed dependency input after combined preparation blocks both transfer types', async (context) => {
  const fixture = await combinedToolFixture(context);
  const preview = await fixture.prepareCombined();
  await fs.appendFile(path.join(fixture.projectRoot, 'package.json'), '\n');
  const result = await fixture.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'stale');
  assert.equal(result.requests, 0);
  assert.equal(result.dependencyRequests, 0);
  assert.equal(fixture.state.requests, 0);
  assert.equal(fixture.calls.length, 0);
});

test('dependency changes during source analysis leave a combined historical section with zero metadata sends', async (context) => {
  const fixture = await combinedToolFixture(context, async (chunk) => {
    await fs.appendFile(path.join(chunk.root ?? fixture.projectRoot, 'package.json'), '\n');
    return { findings: [] };
  });
  const preview = await fixture.prepareCombined();
  const result = await fixture.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.sourceStatus, 'completed');
  assert.equal(result.dependencyStatus, 'stale');
  assert.equal(result.dependencyRequests, 0);
  assert.equal(fixture.calls.length, 0);
  assert.equal(result.currentDependencySnapshot, false);
  assert.match(await fs.readFile(result.reportPath, 'utf8'), /historical only/);
});

test('source-only scans never call dependency providers', async (context) => {
  const fixture = await combinedToolFixture(context);
  const result = await fixture.approve();
  assert.equal(result.dependencyStatus, undefined);
  assert.equal(result.dependencyRequests, 0);
  assert.equal(fixture.calls.length, 0);
    assert.match(await fs.readFile(result.reportPath, 'utf8'), /Not assessed\. This review did not include npm dependency evidence/);
});

test('transform review is approvable only when source and dependency snapshots are complete and current', async (context) => {
  const fixture = await scanToolFixture(context, 1);
  const manifest = { name: 'sample', version: '1.0.0' };
  await fs.writeFile(path.join(fixture.projectRoot, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(fixture.projectRoot, 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: manifest.name, version: manifest.version } }
  }));
  fixture.sourceFiles.push(uri(path.join(fixture.projectRoot, 'package.json')),
    uri(path.join(fixture.projectRoot, 'package-lock.json')));
  const tool = new TransformCodebaseTool(fixture.vscode, fixture.store, new ProposalStore(), fixture.tool.options);
  const result = JSON.parse((await tool.invoke({ input: { action: 'review', projectRoot: fixture.projectRoot } })).content[0].value);
  assert.equal(result.status, 'awaiting-approval');
  assert.equal(result.sourceStatus, 'completed');
  assert.equal(result.dependencyStatus, 'not-applicable');
  assert.equal(result.sourceSnapshotCurrent, true);
  assert.equal(result.dependencySnapshotCurrent, true);
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /Source snapshot: matched at final local check/);
  assert.match(report, /## Transformation Plan/);
});

test('transform review puts source findings and deprecated npm updates in one report', async (context) => {
  const fixture = await combinedToolFixture(context);
  const tool = new TransformCodebaseTool(fixture.vscode, fixture.store, new ProposalStore(), fixture.tool.options);
  const result = JSON.parse((await tool.invoke({ input: { action: 'review', projectRoot: fixture.projectRoot } })).content[0].value);
  assert.equal(result.status, 'awaiting-approval');
  assert.equal(result.sourceStatus, 'completed');
  assert.equal(result.dependencyStatus, 'completed');
  assert.deepEqual(result.dependencyUpdates, [{ name: 'alpha', from: '1.0.0', version: '1.2.0', reason: 'deprecated' }]);
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /Simplify a constant expression/);
  assert.match(report, /`alpha` 1\.0\.0 -> 1\.2\.0 \(deprecated\)/);
  assert.match(report, /## Transformation Plan/);
});

test('transform review blocks approval after invalid model output or a source change', async (context) => {
  const malformed = await scanToolFixture(context, 1, async () => 'not JSON');
  const malformedTool = new TransformCodebaseTool(malformed.vscode, malformed.store, new ProposalStore(), malformed.tool.options);
  const incomplete = JSON.parse((await malformedTool.invoke({ input: {
    action: 'review', projectRoot: malformed.projectRoot
  } })).content[0].value);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.reviewId, undefined);
  assert.match(await fs.readFile(incomplete.reportPath, 'utf8'), /cannot be applied/);

  let projectRoot;
  const changed = await scanToolFixture(context, 1, async (chunk) => {
    await fs.writeFile(path.join(projectRoot, chunk.path), 'function sample() { return 42; }\n');
    return { findings: [] };
  });
  projectRoot = changed.projectRoot;
  const changedTool = new TransformCodebaseTool(changed.vscode, changed.store, new ProposalStore(), changed.tool.options);
  const stale = JSON.parse((await changedTool.invoke({ input: {
    action: 'review', projectRoot: changed.projectRoot
  } })).content[0].value);
  assert.equal(stale.status, 'incomplete');
  assert.equal(stale.sourceSnapshotCurrent, false);
  assert.equal(stale.reviewId, undefined);
});

test('scan tool continues approved batches with cumulative reports and retained finding decisions', async (context) => {
  const fixture = await scanToolFixture(context);
  const first = await fixture.approve();
  assert.equal(first.status, 'incomplete');
  assert.equal(first.requests, 30);
  assert.equal(first.remainingChunks, 1);
  assert.equal(first.canContinue, true);
  const finding = fixture.store.list()[0];
  await fixture.store.dispose(fixture.tool.vscode, [finding.id], []);
  const second = await fixture.approve(first.scanId);
  assert.equal(second.status, 'completed');
  assert.equal(second.scanId, first.scanId);
  assert.equal(second.requests, 31);
  assert.equal(second.batchRequests, 1);
  assert.equal(second.batchNumber, 2);
  assert.equal(second.findingCount, 31);
  assert.equal(second.filesReviewed, 31);
  assert.equal(second.chunksReviewed, 31);
  assert.equal(second.canContinue, false);
  assert.equal(fixture.state.selections, 1);
  assert.equal(fixture.store.get(finding.id).status, 'approved');
  assert.notEqual(second.reportPath, first.reportPath);
  assert.match(await fs.readFile(second.reportPath, 'utf8'), /Review status: approved/);
  assert.match(await fs.readFile(first.reportPath, 'utf8'), /Continuation available: yes/);
  assert.ok(fixture.state.progress.some((message) => message.includes('31/31')));
  assert.equal((await fixture.invoke({ phase: 'prepare', projectRoot: fixture.projectRoot, scanId: first.scanId })).status, 'rejected');
});

test('scan continuation requires its own decision and rejects old session revisions', async (context) => {
  const fixture = await scanToolFixture(context);
  const first = await fixture.approve();
  const input = { phase: 'prepare', projectRoot: fixture.projectRoot, scanId: first.scanId };
  const declined = await fixture.invoke(input);
  assert.equal(declined.batchRequests, 1);
  assert.ok(declined.batchSourceBytes > 0);
  assert.equal((await fixture.invoke({ phase: 'confirm', previewId: declined.previewId, decision: 'reject' })).status, 'cancelled');
  assert.equal(fixture.state.requests, 30);
  const older = await fixture.invoke(input);
  const current = await fixture.invoke(input);
  assert.equal((await fixture.invoke({ phase: 'confirm', previewId: current.previewId, decision: 'approve' })).status, 'completed');
  assert.equal((await fixture.invoke({ phase: 'confirm', previewId: older.previewId, decision: 'approve' })).status, 'stale');
  assert.equal(fixture.state.requests, 31);
});

test('changed continuation source sends nothing and requires a fresh scan', async (context) => {
  const fixture = await scanToolFixture(context);
  const first = await fixture.approve();
  const input = { phase: 'prepare', projectRoot: fixture.projectRoot, scanId: first.scanId };
  const preview = await fixture.invoke(input);
  await fs.appendFile(fixture.sourceFiles[0].fsPath, '// changed\n');
  assert.equal((await fixture.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'stale');
  assert.equal((await fixture.invoke(input)).status, 'stale');
  assert.equal(fixture.state.requests, 30);
});

test('cancelled scan keeps completed work and resumes only after new approval', async (context) => {
  const token = { isCancellationRequested: false };
  const fixture = await scanToolFixture(context, 31, async () => {
    token.isCancellationRequested = true;
    return { findings: [] };
  });
  const first = await fixture.approve(undefined, token);
  assert.equal(first.status, 'cancelled');
  assert.equal(first.requests, 1);
  assert.equal(first.chunksReviewed, 1);
  assert.equal(first.remainingChunks, 30);
  assert.equal(first.canContinue, true);
  const resumed = await fixture.approve(first.scanId);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.requests, 31);
  assert.equal(resumed.chunksReviewed, 31);
});

test('malformed responses remain incomplete after all chunks have been attempted', async (context) => {
  const fixture = await scanToolFixture(context, 2, async (chunk, token, state) =>
    state.requests === 1 ? {} : { findings: [] });
  const result = await fixture.approve();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.rejected, 1);
  assert.equal(result.filesReviewed, 1);
  assert.equal(result.canContinue, false);
  assert.equal(result.remainingChunks, 0);
  assert.match(await fs.readFile(result.reportPath, 'utf8'), /Failed chunks:[\s\S]*sample-0\.js/);
  assert.match(await fs.readFile(result.reportPath, 'utf8'), /Response must contain only a findings array/);
});

test('scan reports JSON decoding separately from request failure without echoing model output', async (context) => {
  const fixture = await scanToolFixture(context, 2, async (chunk, token, state) => {
    if (state.requests === 1) return 'private-response-text: not JSON';
    throw new Error('private-provider-error');
  });
  const result = await fixture.approve();
  assert.equal(result.rejected, 2);
  assert.equal(result.chunksReviewed, 0);
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /Model response is not valid JSON/);
  assert.match(report, /one JSON object that matches the requested schema/);
  assert.match(report, /Model request failed or response exceeded its size limit/);
  assert.doesNotMatch(report, /private-response-text|private-provider-error/);
});

test('scan accepts one fenced JSON finding and still validates its exact source span', async (context) => {
  const sourceLine = 'function sample() { return 0 + 1; }';
  const response = { findings: [{ category: 'redundant-control-flow',
    rationale: 'The else follows a returning branch; remove it to reduce nesting.', confidence: 'high', symbol: 'sample',
    functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
    endLine: 1, endCharacter: sourceLine.length, originalText: sourceLine,
    replacementText: 'function sample() { return 1; }' }] };
  const fixture = await scanToolFixture(context, 1, async () => `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``);
  const result = await fixture.approve();
  assert.equal(result.status, 'completed');
  assert.equal(result.findingCount, 1);
  assert.equal(result.rejected, 0);
  assert.equal(fixture.store.list()[0].category, 'redundant-control-flow');
});

test('scan accepts one JSON finding object surrounded by model prose and validates its exact source span', async (context) => {
  const sourceLine = 'function sample() { return 0 + 1; }';
  const response = { findings: [{ category: 'redundant-control-flow',
    rationale: 'The else follows a returning branch; remove it to reduce nesting.', confidence: 'high', symbol: 'sample',
    functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
    endLine: 1, endCharacter: sourceLine.length, originalText: sourceLine,
    replacementText: 'function sample() { return 1; }' }] };
  const fixture = await scanToolFixture(context, 1, async () => `Here is the JSON result:\n${JSON.stringify(response)}\nEnd of response.`);
  const result = await fixture.approve();
  assert.equal(result.status, 'completed');
  assert.equal(result.findingCount, 1);
  assert.equal(result.rejected, 0);
  assert.equal(fixture.store.list()[0].category, 'redundant-control-flow');
});

test('finding rejection reasons distinguish schema, metadata, positions, and exact source mismatch', () => {
  const content = 'function sample() { return true; }';
  const chunk = { path: 'sample.js', content, startLine: 1, sourceHash: hashSource(content) };
  const candidate = { category: 'redundant-control-flow', rationale: 'Simplify the function.',
    confidence: 'medium', symbol: 'sample', functionStartLine: 1, functionEndLine: 1,
    startLine: 1, startCharacter: 0, endLine: 1, endCharacter: content.length,
    originalText: content, replacementText: 'function sample() { return true; /* proposed */ }' };
  const cases = [
    [{ ...candidate, extra: true }, /Required fields/],
    [{ ...candidate, category: 'unsupported' }, /Category/],
    [{ ...candidate, confidence: 'certain' }, /Confidence/],
    [{ ...candidate, rationale: '' }, /Rationale or symbol/],
    [{ ...candidate, replacementText: content }, /Original or replacement/],
    [{ ...candidate, startCharacter: 0.5 }, /must be integers/],
    [{ ...candidate, functionStartLine: 0 }, /Span lines/],
    [{ ...candidate, endCharacter: content.length + 1 }, /outside the supplied source/],
    [{ ...candidate, startCharacter: content.length }, /Span must be nonempty/],
    [{ ...candidate, originalText: 'private-invented-text' }, /originalText does not exactly match/]
  ];
  for (const [invalid, expected] of cases) {
    const rejections = [];
    const findings = validateFindingResponse({ findings: [candidate, invalid] }, chunk, rejections);
    assert.equal(findings.length, 1);
    assert.equal(rejections.length, 1);
    assert.match(rejections[0], /^Finding 2:/);
    assert.match(rejections[0], expected);
    assert.doesNotMatch(rejections[0], /private-invented-text/);
  }
});

test('scan binds LF model text to exact CRLF source using chunk-local UTF-16 positions', () => {
  const lines = ['// \u{1f600}', 'function sample() {', '  return "\u{1f600}";', '}'];
  const content = `${lines.join('\r\n')}\r\n`;
  const chunk = { path: 'sample.js', content, startLine: 80, sourceHash: hashSource(content) };
  const prompt = JSON.parse(scanPrompt(chunk, 3));
  assert.equal(prompt.source.content, content.replace(/\r\n/g, '\n'));
  assert.deepEqual(prompt.source.lineLengths, [...lines.map((line) => line.length), 0]);
  assert.match(prompt.instructions, /zero-based UTF-16/);
  assert.match(prompt.instructions, /encode CRLF as \\r\\n/);
  const candidate = { category: 'complex-function-simplification', rationale: 'Review this function.',
    confidence: 'low', symbol: 'sample', functionStartLine: 2, functionEndLine: 4,
    startLine: 2, startCharacter: 0, endLine: 4, endCharacter: 1,
    originalText: lines.slice(1).join('\r\n'), replacementText: 'function sample() { return "value"; }' };
  const findings = validateFindingResponse({ findings: [candidate] }, chunk);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].range.startLine, 81);
  assert.equal(findings[0].range.endLine, 83);
  const lfFindings = validateFindingResponse({ findings: [{ ...candidate,
    originalText: candidate.originalText.replace(/\r\n/g, '\n'),
    replacementText: 'function sample() {\n  return "value";\n}'
  }] }, chunk);
  assert.equal(lfFindings.length, 1);
  assert.equal(lfFindings[0].originalText, candidate.originalText);
  assert.equal(lfFindings[0].replacementText, 'function sample() {\r\n  return "value";\r\n}');
  const corrected = validateFindingResponse({ findings: [{ ...candidate, startLine: 3, endLine: 3,
    endCharacter: [...lines[2]].length, originalText: lines[2] }] }, chunk);
  assert.equal(corrected.length, 1);
  assert.deepEqual(corrected[0].range, { startLine: 82, startCharacter: 0, endLine: 82, endCharacter: lines[2].length });
  for (const invalid of [
    { ...candidate, originalText: candidate.originalText.replace('  return', ' return') }
  ]) {
    const rejections = [];
    assert.equal(validateFindingResponse({ findings: [invalid] }, chunk, rejections).length, 0);
    assert.match(rejections[0], /originalText does not exactly match/);
  }
});

test('coordinate recovery requires a unique exact snippet inside the declared function', () => {
  const candidate = { category: 'complex-function-simplification', rationale: 'Simplify the function.',
    confidence: 'medium', symbol: 'sample', functionStartLine: 2, functionEndLine: 4,
    startLine: 2, startCharacter: 1, endLine: 4, endCharacter: 0,
    originalText: 'function sample() {\n  return true;\n}', replacementText: 'function sample() { return true; }' };
  for (const newline of ['\n', '\r\n']) {
    const content = ['// header', 'function sample() {', '  return true;', '}'].join(newline);
    const chunk = { path: 'sample.js', content, startLine: 42, sourceHash: hashSource(content) };
    const rejections = [];
    const findings = validateFindingResponse({ findings: [candidate] }, chunk, rejections);
    assert.equal(findings.length, 1);
    assert.deepEqual(rejections, []);
    assert.equal(findings[0].originalText, candidate.originalText.replace(/\n/g, newline));
    assert.deepEqual(findings[0].range, { startLine: 43, startCharacter: 0, endLine: 45, endCharacter: 1 });
  }
  const repeated = 'function sample() { return true; return true; }';
  const other = 'function other() { return false; }';
  for (const [content, invalid] of [
    [repeated, { ...candidate, functionStartLine: 1, functionEndLine: 1,
      startLine: 1, startCharacter: 0, endLine: 1, endCharacter: repeated.length, originalText: 'return true;' }],
    [`${other}\n${repeated}`, { ...candidate, functionEndLine: 2,
      startCharacter: 0, endLine: 2, endCharacter: repeated.length, originalText: other }]
  ]) {
    const rejections = [];
    assert.equal(validateFindingResponse({ findings: [invalid] },
      { path: 'sample.js', content, startLine: 1, sourceHash: hashSource(content) }, rejections).length, 0);
    assert.match(rejections[0], /unique span inside the declared function/);
  }
});

test('newline binding rejects newline-only edits and code mismatches on LF source', () => {
  const content = 'function sample() {\n  return true;\n}';
  const chunk = { path: 'sample.js', content, startLine: 1, sourceHash: hashSource(content) };
  const candidate = { category: 'complex-function-simplification', rationale: 'Simplify the function.',
    confidence: 'medium', symbol: 'sample', functionStartLine: 1, functionEndLine: 3,
    startLine: 1, startCharacter: 0, endLine: 3, endCharacter: 1,
    originalText: content.replace(/\n/g, '\r\n'), replacementText: 'function sample() { return true; }' };
  const findings = validateFindingResponse({ findings: [candidate] }, chunk);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].originalText, content);
  for (const invalid of [
    { ...candidate, replacementText: content },
    { ...candidate, originalText: candidate.originalText.replace('true', 'false') }
  ]) {
    const rejections = [];
    assert.equal(validateFindingResponse({ findings: [invalid] }, chunk, rejections).length, 0);
    assert.equal(rejections.length, 1);
  }
});

test('interrupted model request stays queued for an approved continuation', async (context) => {
  const token = { isCancellationRequested: false };
  const fixture = await scanToolFixture(context, 2, async (chunk, requestToken, state) => {
    if (state.requests === 1) {
      token.isCancellationRequested = true;
      throw new Error('Request interrupted.');
    }
    return { findings: [] };
  });
  const first = await fixture.approve(undefined, token);
  assert.equal(first.status, 'cancelled');
  assert.equal(first.remainingChunks, 2);
  assert.equal(first.chunksReviewed, 0);
  assert.equal(first.rejected, 0);
  const resumed = await fixture.approve(first.scanId);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.requests, 3);
  assert.equal(resumed.chunksReviewed, 2);
  assert.equal(resumed.filesReviewed, 2);
  assert.equal(resumed.remainingChunks, 0);
});

test('concurrent scan invocations cannot overwrite a running batch', async (context) => {
  let releaseRequest;
  let startedRequest;
  const started = new Promise((resolve) => { startedRequest = resolve; });
  const gate = new Promise((resolve) => { releaseRequest = resolve; });
  const fixture = await scanToolFixture(context, 1, async () => {
    startedRequest();
    await gate;
    return { findings: [] };
  });
  const pending = fixture.approve();
  await started;
  const busy = await fixture.invoke({ phase: 'prepare', projectRoot: fixture.projectRoot });
  releaseRequest();
  assert.equal(busy.status, 'busy');
  assert.equal((await pending).status, 'completed');
  assert.equal(fixture.state.requests, 1);
});

test('inventory admits only root-contained visible source and chunks without exceeding the byte limit', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-scan-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'src', 'sample.js');
  const hiddenPath = path.join(temporaryRoot, '.private', 'secret.ts');
  const npmConfigPath = path.join(temporaryRoot, '.npmrc');
  const dependencyPath = path.join(temporaryRoot, 'node_modules', 'pkg', 'index.js');
  const packageSourcePath = path.join(temporaryRoot, 'packages', 'app', 'index.ts');
  const unsupportedPath = path.join(temporaryRoot, 'README.md');
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-outside-'));
  context.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  const outsidePath = path.join(outsideRoot, 'escaped.cs');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(hiddenPath), { recursive: true });
  await fs.mkdir(path.dirname(dependencyPath), { recursive: true });
  await fs.mkdir(path.dirname(packageSourcePath), { recursive: true });
  await fs.writeFile(sourcePath, `${'const value = 1;\n'.repeat(4)}`);
  await fs.writeFile(npmConfigPath, 'registry=https://registry.npmjs.org/');
  await fs.writeFile(hiddenPath, 'const secret = true;');
  await fs.writeFile(dependencyPath, 'module.exports = {};');
  await fs.writeFile(packageSourcePath, 'export const value = 1;\n');
  await fs.writeFile(unsupportedPath, 'Not source.');
  await fs.writeFile(outsidePath, 'class Escaped {}');
  const linkedPath = path.join(temporaryRoot, 'linked.cs');
  let linkedUri;
  try {
    await fs.symlink(outsidePath, linkedPath, 'file');
    linkedUri = uri(linkedPath);
  } catch (error) {
    linkedUri = uri(outsidePath);
  }

  const candidates = [sourcePath, hiddenPath, npmConfigPath, dependencyPath, packageSourcePath, unsupportedPath].map(uri).concat(linkedUri);
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
  assert.deepEqual(result.files.map((file) => file.path), ['packages/app/index.ts', 'src/sample.js']);
  assert.equal(result.skipped, 1);
  assert.equal(result.excluded, 3);
  assert.deepEqual(result.unsupportedFiles, ['README.md']);
  assert.equal(result.skippedFiles.length, 1);
  const bounded = chunkSourceFiles(result.files, 32);
  assert.ok(bounded.chunks.length > 1);
  assert.ok(bounded.chunks.every((chunk) => Buffer.byteLength(chunk.content) <= 32));
  assert.equal(bounded.skipped, 0);
  const oversized = chunkSourceFiles([{ path: 'long.js', content: `const value = 1;\n${'a'.repeat(40)}\n`, sourceHash: 'hash' }], 32);
  assert.equal(oversized.chunks.length, 0);
  assert.equal(oversized.skippedFiles[0].path, 'long.js');
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

test('scan preview exposes scope and rejecting its chat decision makes no model request', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-consent-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'sample.js');
  await fs.writeFile(sourcePath, 'function sample() { return true; }\n');
  const folder = { uri: uri(temporaryRoot) };
  let requests = 0;
  const vscode = {
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    RelativePattern: class {},
    window: {},
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => [uri(sourcePath)],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const tool = new ScanWorkspaceTool(vscode, new FindingStore(), {
    reportDirectory: temporaryRoot,
    selectLanguageModel: async () => ({ vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() {} }),
    requestModel: async () => { requests += 1; return '{"findings":[]}'; }
  });
  const preview = JSON.parse((await tool.invoke({ input: { phase: 'prepare', projectRoot: temporaryRoot } })).content[0].value);
  assert.equal(preview.status, 'awaiting-decision');
  assert.equal(preview.files, 1);
  assert.equal(preview.projectedRequests, 1);
  assert.equal(preview.destination, 'test / test-model');
  const result = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: preview.previewId, decision: 'reject'
  } })).content[0].value);
  assert.equal(result.status, 'cancelled');
  assert.equal(requests, 0);
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
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => sourceFiles,
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot,
    { vendor: 'test', id: 'test-model', name: 'Test Model', sendRequest() {} }, undefined,
    { chatApproved: true, requestModel: async (chunk) => {
      requests += 1;
      const originalText = chunk.content.split('\n')[0];
      return JSON.stringify({ findings: [{
        category: 'redundant-control-flow', rationale: 'The function returns a constant.', confidence: 'low',
        symbol: 'sample', functionStartLine: 1, functionEndLine: 1,
        startLine: 1, startCharacter: 0, endLine: 1, endCharacter: originalText.length, originalText,
        replacementText: 'function sample() { return false; }'
      }] });
    } });
  assert.equal(requests, 30);
  assert.equal(result.requests, 30);
  assert.equal(result.findings.length, 30);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.projectedRequests, 31);
  assert.equal(result.findings[0].path, 'sample-0.js');
  assert.equal(result.findings[0].range.startLine, 1);
  assert.equal(result.remainingChunks, 1);
  assert.equal(result.filesReviewed, 30);
  const resumed = await scanWorkspace(vscode, temporaryRoot, { sendRequest() {} }, undefined, {
    chatApproved: true, previousResult: result,
    requestModel: async () => { requests += 1; return { findings: [] }; }
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.scanId, result.scanId);
  assert.equal(requests, 31);
  assert.equal(resumed.requests, 31);
  assert.equal(resumed.batchRequests, 1);
  assert.equal(resumed.findings.length, 30);
  assert.equal(resumed.filesReviewed, 31);
  assert.equal(resumed.remainingChunks, 0);
  assert.equal(resumed.canContinue, false);
  await fs.appendFile(sourceFiles[0].fsPath, '// changed\n');
  const stale = await scanWorkspace(vscode, temporaryRoot, { sendRequest() {} }, undefined, {
    chatApproved: true, previousResult: result,
    requestModel: async () => { throw new Error('No stale continuation request expected.'); }
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.requests, 0);
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
    workspace: {
      workspaceFolders: [folder], findFiles: async () => [uri(sourcePath)],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot, { sendRequest() {}, vendor: 'test' }, undefined, {
    chatApproved: true,
    requestModel: async () => JSON.stringify({ findings: [
      { category: 'repeated-local-expression', rationale: 'Valid evidence.', confidence: 'medium', symbol: 'sample',
        functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
        endLine: 1, endCharacter: sourceLine.length, originalText: sourceLine,
        replacementText: 'function sample() { return false; }' },
      { category: 'repeated-local-expression', rationale: 'Invented evidence.', confidence: 'high', symbol: 'sample',
        functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
        endLine: 1, endCharacter: sourceLine.length, originalText: 'not present in the source' }
    ] })
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].originalText, sourceLine);
  assert.equal(result.rejected, 1);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.filesReviewed, 0);
  assert.match(result.failedChunks[0].reason, /Finding 2: Required fields/);
});

test('scan retains more than 30 unique findings without stopping coverage', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-findings-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourceFiles = [];
  const sourceLine = 'function sample() { return true; }';
  for (let index = 0; index < 11; index += 1) {
    const filePath = path.join(temporaryRoot, `sample-${index}.js`);
    await fs.writeFile(filePath, `${sourceLine}\n`.repeat(3));
    sourceFiles.push(uri(filePath));
  }
  const folder = { uri: uri(temporaryRoot) };
  let requests = 0;
  const vscode = {
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [folder], findFiles: async () => sourceFiles,
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const result = await scanWorkspace(vscode, temporaryRoot, { sendRequest() {}, vendor: 'test' }, undefined, {
    chatApproved: true,
    requestModel: async (chunk) => {
      requests += 1;
      const finding = { category: 'complex-function-simplification', rationale: 'Review this function.',
        confidence: 'low', symbol: 'sample', functionStartLine: 1, functionEndLine: 1,
        startLine: 1, startCharacter: 0, endLine: 1, endCharacter: sourceLine.length, originalText: sourceLine,
        replacementText: 'function sample() { return false; }' };
      assert.ok(Buffer.byteLength(scanPrompt(chunk, 30), 'utf8') <= 256 * 1024);
      return JSON.stringify({ findings: [1, 2, 3].map((line) => ({ ...finding,
        functionStartLine: line, functionEndLine: line, startLine: line, endLine: line })) });
    }
  });
  assert.equal(requests, 11);
  assert.equal(result.findings.length, 33);
  assert.equal(result.projectedRequests, 11);
  assert.equal(result.status, 'completed');
  assert.equal(result.filesReviewed, 11);
  const worstEscapingChunk = { path: 'control.js', content: '\u0001'.repeat(30 * 1024) };
  assert.ok(Buffer.byteLength(scanPrompt(worstEscapingChunk, 30), 'utf8') <= 256 * 1024);
});

test('scan report shows exact before and after spans and never overwrites an earlier report', async (context) => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-report-'));
  context.after(() => fs.rm(reportDirectory, { recursive: true, force: true }));
  const result = {
    status: 'incomplete', scanId: '12345678-1234-1234-1234-123456789abc', root: '/workspace',
    files: 4, bytes: 512, projectedRequests: 5, requests: 4, skipped: 1, rejected: 0,
    findings: [{ id: 'finding-1', path: 'src/sample.js', category: 'redundant-control-flow',
      rationale: 'This branch can be simplified.', confidence: 'medium', symbol: 'sample',
      range: { startLine: 12, startCharacter: 2, endLine: 14, endCharacter: 3 },
      originalText: 'if (ready) {\\n  return true;\\n}', replacementText: 'return ready;' }]
  };
  const report = renderScanReport(result);
  assert.match(report, /Files with proposed spans: 1/);
  assert.match(report, /`src\/sample\.js`/);
  assert.match(report, /Lines: 12-14/);
  assert.match(report, /Before:/);
  assert.match(report, /After \(model suggestion, unverified\):/);
  assert.match(report, /Review the Transformation Plan before approving it/);
  assert.doesNotMatch(report, /one exact-write preview per file|No second model request or report is needed/);
  assert.match(report, /Dependency Recommendations[\s\S]*Not assessed/);
  assert.match(report, /Incomplete\./);
  assert.match(report, /Source changes: none/);
  const reportPath = await writeScanReport(reportDirectory, result.scanId, report);
  assert.equal(await fs.readFile(reportPath, 'utf8'), report);
  await assert.rejects(writeScanReport(reportDirectory, result.scanId, 'replacement'), { code: 'EEXIST' });
  const nextReportPath = await writeScanReport(reportDirectory, result.scanId, 'next batch', 2);
  assert.notEqual(nextReportPath, reportPath);
  assert.equal(await fs.readFile(reportPath, 'utf8'), report);
});

test('scan tool opens the report and returns only a compact result summary', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-scan-report-tool-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-scan-report-store-'));
  context.after(() => fs.rm(reportDirectory, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'sample.js');
  const originalText = 'function sample() { return true; }';
  await fs.writeFile(sourcePath, `${originalText}\n`);
  let openedReportPath;
  class LanguageModelToolResult { constructor(content) { this.content = content; } }
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  const folder = { uri: uri(temporaryRoot) };
  const vscode = {
    LanguageModelToolResult, LanguageModelTextPart,
    Uri: { file: (filePath) => uri(filePath) },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    window: {
      showTextDocument: async (document) => { openedReportPath = document.uri.fsPath; }
    },
    workspace: {
      workspaceFolders: [folder],
      findFiles: async () => [uri(sourcePath)],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) },
      openTextDocument: async (fileUri) => ({ uri: fileUri })
    }
  };
  const tool = new ScanWorkspaceTool(vscode, new FindingStore(), {
    reportDirectory,
    selectLanguageModel: async () => ({ vendor: 'test', id: 'test-model', sendRequest() {} }),
    requestModel: async () => JSON.stringify({ findings: [{
      category: 'redundant-control-flow', rationale: 'The value is constant.', confidence: 'low', symbol: 'sample',
      functionStartLine: 1, functionEndLine: 1, startLine: 1, startCharacter: 0,
      endLine: 1, endCharacter: originalText.length, originalText, replacementText: 'function sample() { return false; }'
    }] })
  });

  const preview = JSON.parse((await tool.invoke({ input: { phase: 'prepare', projectRoot: temporaryRoot } })).content[0].value);
  const result = await tool.invoke({ input: { phase: 'confirm', previewId: preview.previewId, decision: 'approve' } });
  const output = JSON.parse(result.content[0].value);
  assert.equal(output.status, 'completed', JSON.stringify(output));
  assert.equal(output.findingCount, 1);
  assert.equal(Object.hasOwn(output, 'findings'), false);
  assert.equal(output.reportOpened, true);
  assert.equal(openedReportPath, output.reportPath);
  assert.match(await fs.readFile(openedReportPath, 'utf8'), /After \(model suggestion, unverified\):/);
  const reused = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: preview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(reused.status, 'rejected');
});

test('scan approval rejects a changed workspace before sending any source', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-scan-stale-preview-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, 'sample.js');
  await fs.writeFile(sourcePath, 'function sample() { return true; }\n');
  let requests = 0;
  const vscode = {
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: uri(temporaryRoot) }], findFiles: async () => [uri(sourcePath)],
      fs: { readFile: (fileUri) => fs.readFile(fileUri.fsPath) }
    }
  };
  const tool = new ScanWorkspaceTool(vscode, new FindingStore(), {
    selectLanguageModel: async () => ({ vendor: 'test', id: 'model', sendRequest() {} }),
    requestModel: async () => { requests += 1; return '{"findings":[]}'; }
  });
  const preview = JSON.parse((await tool.invoke({ input: { phase: 'prepare', projectRoot: temporaryRoot } })).content[0].value);
  await fs.appendFile(sourcePath, '// changed\n');
  const result = JSON.parse((await tool.invoke({ input: {
    phase: 'confirm', previewId: preview.previewId, decision: 'approve'
  } })).content[0].value);
  assert.equal(result.status, 'stale');
  assert.equal(requests, 0);
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
  store.addScan({ root: temporaryRoot, scanId: 'scan-1', findings: store.list() });
  assert.equal(store.get('finding-1').status, 'approved');
  assert.equal(store.get('finding-2').status, 'dismissed');
  await fs.writeFile(sourcePath, `${source}// changed\n`);
  assert.equal((await store.refresh(vscode, 'finding-1')).status, 'stale');
  assert.equal(store.getApproved('finding-1'), null);
});

test('finding disposition applies fresh approve/reject ID batches atomically', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-findings-batch-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const source = 'function sample() { return true; }\n';
  await fs.writeFile(path.join(temporaryRoot, 'sample.js'), source);
  const vscode = { workspace: { workspaceFolders: [{ uri: uri(temporaryRoot) }], textDocuments: [] } };
  const store = new FindingStore();
  store.addScan({ root: temporaryRoot, scanId: 'scan-batch', findings: ['one', 'two'].map((id) => ({
    id, scanId: 'scan-batch', path: 'sample.js', sourceHash: hashSource(source), originalText: source.trim(), status: 'new'
  })) });

  const result = await store.dispose(vscode, ['one'], ['two']);
  assert.equal(result.status, 'completed');
  assert.equal(result.approved[0].status, 'approved');
  assert.equal(result.rejected[0].status, 'dismissed');
  assert.equal((await store.dispose(vscode, ['one'], [])).status, 'completed');
  assert.equal((await store.dispose(vscode, [], ['two'])).status, 'completed');
  assert.equal((await store.dispose(vscode, ['one'], ['one'])).status, 'rejected');
  assert.equal((await store.dispose(vscode, ['missing'], [])).status, 'rejected');
});

test('finding disposition rejects a stale batch without approving any other ID', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-findings-stale-batch-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const source = 'function sample() { return true; }\n';
  await fs.writeFile(path.join(temporaryRoot, 'sample.js'), source);
  const vscode = { workspace: { workspaceFolders: [{ uri: uri(temporaryRoot) }], textDocuments: [] } };
  const store = new FindingStore();
  store.addScan({ root: temporaryRoot, scanId: 'scan-stale-batch', findings: ['one', 'two'].map((id) => ({
    id, scanId: 'scan-stale-batch', path: 'sample.js', sourceHash: hashSource(source), originalText: source.trim(), status: 'new'
  })) });
  await fs.appendFile(path.join(temporaryRoot, 'sample.js'), '// changed\n');

  const result = await store.dispose(vscode, ['one', 'two'], []);
  assert.equal(result.status, 'rejected');
  assert.equal(store.get('one').status, 'stale');
  assert.equal(store.get('two').status, 'stale');
});

test('finding review tool applies explicit chat ID batches', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-review-tool-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const source = 'function sample() { return true; }\n';
  await fs.writeFile(path.join(temporaryRoot, 'sample.js'), source);
  const store = new FindingStore();
  store.addScan({ root: temporaryRoot, scanId: 'scan-review-tool', findings: ['approve-me', 'reject-me'].map((id) => ({
    id, scanId: 'scan-review-tool', path: 'sample.js', sourceHash: hashSource(source), originalText: source.trim(), status: 'new'
  })) });
  const vscode = {
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    workspace: { workspaceFolders: [{ uri: uri(temporaryRoot) }], textDocuments: [] }
  };
  const tool = new ReviewFindingsTool(vscode, store);
  const result = JSON.parse((await tool.invoke({ input: {
    action: 'disposition', approveIds: ['approve-me'], rejectIds: ['reject-me']
  } })).content[0].value);
  assert.equal(result.status, 'completed');
  assert.deepEqual(store.list().map(({ id, status }) => ({ id, status })), [
    { id: 'approve-me', status: 'approved' }, { id: 'reject-me', status: 'dismissed' }
  ]);
});
