'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { discoverTarget } = require('./workspace-discovery');
const { readSourceEvidence, validateRelativePath } = require('./source-evidence');
const { isPathWithinRoot, resolveWorkspaceRoot } = require('./workspace-scope');
const { generateModelProposal } = require('./foundry-adapter');
const { renderProposalReport, validateProposal } = require('./proposal-contract');
const { captureSourceSnapshot, assertSourceSnapshot } = require('./proposal-apply');
const { expectedSampleCase, validateSampleInputs } = require('./sample-inputs');

const DEFAULT_REPORT_DIRECTORY = 'reports/legacy-code-transformation';

function checkCancelled(token) {
  if (token?.isCancellationRequested) {
    const error = new Error('Report generation cancelled.');
    error.code = 'CANCELLED';
    throw error;
  }
}

function contentHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateReportDirectory(directory, sourcePaths = []) {
  validateRelativePath(directory);
  const blocked = new Set(['node_modules', 'deps', 'dependencies', 'vendor', 'packages', 'bin', 'obj', 'dist', 'build', 'coverage', 'src', 'source', 'sources', 'lib', 'tests', 'test', 'docs', 'agents', 'fixtures', 'roslyn-worker']);
  if (directory.split('/').some((segment) => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(segment) ||
      blocked.has(segment.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) || segment.endsWith('.'))) {
    throw new Error('Report directory must be an artifact directory, not a hidden, dependency, or source directory.');
  }
  if (sourcePaths.some((sourcePath) => sourcePath.startsWith(`${directory}/`) &&
      /\.(?:cs|[cm]?js|jsx|ts|tsx|csproj|sln)$/i.test(sourcePath))) {
    throw new Error('Report directory contains discovered source or project files.');
  }
}

async function verifyAncestors(rootPath, directory) {
  let candidate = rootPath;
  for (const segment of directory.split('/')) {
    candidate = path.join(candidate, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !isPathWithinRoot(rootPath, await fs.realpath(candidate))) {
        throw new Error('Report directory has an unsafe ancestor.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function writeProposalReport(rootPath, directory, markdown, token, sourcePaths = [], fileName = `${randomUUID()}.md`) {
  validateReportDirectory(directory, sourcePaths);
  if (!/^[a-zA-Z0-9-]+\.md$/.test(fileName)) throw new Error('Reports must have a safe Markdown filename.');
  const rootRealPath = await fs.realpath(rootPath);
  await verifyAncestors(rootRealPath, directory);
  checkCancelled(token);
  let current = rootRealPath;
  const createdDirectories = [];
  let reportPath;
  let handle;
  let created = false;
  try {
    for (const segment of directory.split('/')) {
      checkCancelled(token);
      current = path.join(current, segment);
      await verifyAncestors(rootRealPath, directory);
      try {
        await fs.mkdir(current);
        createdDirectories.push(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      await verifyAncestors(rootRealPath, directory);
    }
    reportPath = path.join(current, fileName);
    checkCancelled(token);
    await verifyAncestors(rootRealPath, directory);
    handle = await fs.open(reportPath, 'wx', 0o600);
    created = true;
    checkCancelled(token);
    await handle.writeFile(markdown, 'utf8');
    await handle.close();
    handle = undefined;
    checkCancelled(token);
    await verifyAncestors(rootRealPath, directory);
    return reportPath;
  } catch (error) {
    await handle?.close();
    if (created) await fs.unlink(reportPath);
    for (const createdDirectory of createdDirectories.reverse()) {
      await fs.rmdir(createdDirectory).catch(() => {});
    }
    throw error;
  }
}

async function collectEvidence(vscode, root, discovery, token) {
  const evidenceCatalog = [];
  const seen = new Set();
  const read = async (request, kind, optional = false) => {
    checkCancelled(token);
    const key = `${request.path}:${request.startLine}:${request.endLine}`;
    if (seen.has(key) || evidenceCatalog.length >= 40) return;
    seen.add(key);
    let result;
    try {
      result = await readSourceEvidence(vscode, { projectRoot: root.realPath, requests: [request] }, token);
    } catch (error) {
      if (!optional || !error.message.startsWith('Evidence range exceeds the file length:')) throw error;
      result = await readSourceEvidence(vscode, { projectRoot: root.realPath, requests: [{ ...request, endLine: request.startLine }] }, token);
    }
    if (result.status !== 'ready') checkCancelled({ isCancellationRequested: true });
    evidenceCatalog.push({ id: `E${evidenceCatalog.length + 1}`, ...result.results[0], kind });
    return result.results[0];
  };
  const target = { path: discovery.target.path, symbol: discovery.target.symbol, source: null };
  const source = discovery.target.source;
  if (discovery.target.resolution === 'unique' && source && source.endLine - source.startLine < 400 &&
      Number.isInteger(source.startCharacter) && Number.isInteger(source.endCharacter)) {
    const collected = await read({ path: target.path, startLine: source.startLine, endLine: source.endLine }, 'target');
    const lines = collected.content.split('\n');
    lines[lines.length - 1] = lines.at(-1).slice(0, source.endCharacter);
    lines[0] = lines[0].slice(source.startCharacter);
    if (lines.join('\n') !== source.text) throw new Error('Target source changed during evidence collection.');
    target.source = { ...source, text: lines.join('\n') };
    if (source.startLine > 1) await read({ path: target.path, startLine: Math.max(1, source.startLine - 5), endLine: source.startLine - 1 }, 'surrounding source');
  } else {
    const line = discovery.target.candidates?.[0]?.line ?? 1;
    await read({ path: target.path, startLine: line, endLine: line }, 'unresolved target context');
  }
  for (const [kind, locations] of [
    ['editor reference', discovery.references], ['incoming caller', discovery.incomingCalls],
    ['outgoing call', discovery.outgoingCalls], ['Roslyn reference', discovery.roslynAnalysis?.references],
    ['text match (not a semantic edge)', discovery.textMatches]
  ]) {
    for (const location of (locations ?? []).slice(0, 8)) {
      await read({ path: location.path, startLine: location.line, endLine: location.line }, kind);
    }
  }
  for (const file of (discovery.files ?? []).filter((file) => /(?:tests?[^/]*\.(?:cs|js|ts)|\.(?:test|spec)\.[cm]?[jt]s|(?:^|\/)(?:tests?|__tests__)\/)/i.test(file)).slice(0, 4)) {
    await read({ path: file, startLine: 1, endLine: 30 }, 'test context', true);
  }
  for (const file of (discovery.files ?? []).filter((file) => /(?:^|\/)README\.md$|(?:^|\/)docs\/.*\.mdx?$/i.test(file) &&
      !file.startsWith('reports/')).slice(0, 4)) {
    await read({ path: file, startLine: 1, endLine: 20 }, 'documentation context', true);
  }
  if (Buffer.byteLength(JSON.stringify(evidenceCatalog)) > 200 * 1024) throw new Error('Collected evidence exceeds the report context limit.');
  return { target, evidenceCatalog };
}

async function generateProposalReport(vscode, input, token, options = {}) {
  try {
    checkCancelled(token);
    const root = await resolveWorkspaceRoot(input.projectRoot, vscode.workspace.workspaceFolders);
    const directory = input.reportDirectory ?? DEFAULT_REPORT_DIRECTORY;
    validateReportDirectory(directory);
    await verifyAncestors(root.realPath, directory);
    const sourceSnapshot = await captureSourceSnapshot(vscode, root.realPath, input.targetFile);
    const discovery = await discoverTarget(vscode, {
      projectRoot: root.realPath, targetFile: input.targetFile, targetSymbol: input.targetSymbol
    }, token, options.roslynAnalyzer);
    if (discovery.status === 'cancelled') return { status: 'cancelled' };
    if (discovery.status !== 'ready') throw new Error('Discovery did not return usable evidence.');
    validateReportDirectory(directory, discovery.files);
    const { target, evidenceCatalog } = await collectEvidence(vscode, root, discovery, token);
    const generated = await generateModelProposal({ target, evidenceCatalog }, {
      mode: input.mode ?? 'mock', vscode, token, env: options.env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs,
      changeRequest: input.changeRequest
    });
    if (generated.status === 'cancelled') return { status: 'cancelled' };
    checkCancelled(token);
    if (!validateProposal(generated.proposal, evidenceCatalog, target).valid) {
      throw Object.assign(new Error('Proposal rejected by target/evidence validation. No report was generated.'), { code: 'PROPOSAL_REJECTED' });
    }
    const sampleInputs = validateSampleInputs(generated.sampleInputs ?? [], target, generated.mode === 'live');
    const proposal = generated.proposal;
    const proposalHash = contentHash(JSON.stringify(proposal));
    const targetSpanHash = target.source ? contentHash(target.source.text) : null;
    const evidenceHash = contentHash(JSON.stringify(evidenceCatalog));
    const markdown = renderProposalReport(proposal, evidenceCatalog, target, {
      mode: generated.mode, discovery, proposalHash, targetSpanHash, evidenceHash, sampleInputs, expectedSampleCase,
      changeRequest: generated.changeRequest
    });
    const reportPath = await writeProposalReport(root.realPath, directory, markdown, token, discovery.files);
    await assertSourceSnapshot(vscode, sourceSnapshot);
    return { status: 'ready', reportPath, reportHash: contentHash(Buffer.from(markdown, 'utf8')),
      proposal, target, evidenceCatalog, sampleInputs, proposalHash, targetSpanHash, evidenceHash, sourceSnapshot,
      mode: generated.mode, changeRequest: generated.changeRequest };
  } catch (error) {
    if (error.code === 'CANCELLED' || token?.isCancellationRequested) return { status: 'cancelled' };
    throw error;
  }
}

module.exports = { DEFAULT_REPORT_DIRECTORY, generateProposalReport, writeProposalReport };
