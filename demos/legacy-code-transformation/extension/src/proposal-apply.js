'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const syncFs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { isPathWithinRoot, resolveWorkspaceRoot } = require('./workspace-scope');
const { validateRelativePath } = require('./source-evidence');
const { validateProposal } = require('./proposal-contract');

const APPLY_TOOL = 'legacy_code_transformation_demo_apply_proposal';
const APPLY_LABEL = 'Apply exact proposal';

function checkCancelled(token) {
  if (token?.isCancellationRequested) {
    const error = new Error('Application cancelled.');
    error.code = 'CANCELLED';
    throw error;
  }
}

function freezeSnapshot(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeSnapshot);
    Object.freeze(value);
  }
  return value;
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function safeFile(rootPath, relativePath) {
  validateRelativePath(relativePath);
  if (await fs.realpath(rootPath) !== rootPath) throw new Error('Project root changed.');
  let current = rootPath;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !isPathWithinRoot(rootPath, await fs.realpath(current))) {
      throw new Error('Unsafe source or report path.');
    }
  }
  if (!(await fs.stat(current)).isFile()) throw new Error('Expected a regular file.');
  return current;
}

async function captureSourceSnapshot(vscode, rootPath, targetFile) {
  let ancestor = targetFile;
  while (await fs.realpath(ancestor) !== rootPath) {
    if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Unsafe source path.');
    if (path.dirname(ancestor) === ancestor) throw new Error('Source is outside project root.');
    ancestor = path.dirname(ancestor);
  }
  const relativePath = path.relative(rootPath, await fs.realpath(targetFile)).split(path.sep).join('/');
  const filePath = await safeFile(rootPath, relativePath);
  const document = vscode.workspace.openTextDocument ? await vscode.workspace.openTextDocument(filePath) :
    (vscode.workspace.textDocuments ?? []).find((item) => item.uri.fsPath === filePath);
  if (document?.isDirty) throw new Error('Source buffer has unsaved changes.');
  const bytes = await fs.readFile(filePath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Object.freeze({ rootPath, path: relativePath, bytes: bytes.toString('base64'), fileHash: hashBytes(bytes),
    text, version: document?.version ?? null });
}

async function assertSourceSnapshot(vscode, snapshot) {
  const current = await captureSourceSnapshot(vscode, snapshot.rootPath, path.join(snapshot.rootPath, snapshot.path));
  if (current.fileHash !== snapshot.fileHash || current.version !== snapshot.version || current.text !== snapshot.text) {
    throw new Error('Source or saved document version changed; generate a revised proposal.');
  }
  return current;
}

function spanOffsets(text, source) {
  const lines = text.split('\n');
  const offset = (lineNumber, character) => {
    if (!Number.isInteger(lineNumber) || !Number.isInteger(character) || lineNumber < 1 ||
        lineNumber > lines.length || character < 0 || character > lines[lineNumber - 1].replace(/\r$/, '').length) {
      throw new Error('Invalid exact source span.');
    }
    return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + character;
  };
  const start = offset(source.startLine, source.startCharacter);
  const end = offset(source.endLine, source.endCharacter);
  if (end <= start || text.slice(start, end).replace(/\r\n/g, '\n') !== source.text) {
    throw new Error('Exact target span does not match the generation snapshot.');
  }
  return { start, end };
}

function replacementBytes(candidate) {
  const { sourceSnapshot, target, proposal } = candidate;
  const { start, end } = spanOffsets(sourceSnapshot.text, target.source);
  const original = Buffer.from(sourceSnapshot.bytes, 'base64');
  const bomSize = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const newline = sourceSnapshot.text.includes('\r\n') ? '\r\n' : '\n';
  if (newline === '\r\n' && sourceSnapshot.text.replace(/\r\n/g, '').includes('\n')) {
    throw new Error('Mixed source line endings are unsupported.');
  }
  const replacement = proposal.changes[0].replacementText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
  return Buffer.concat([original.subarray(0, bomSize + Buffer.byteLength(sourceSnapshot.text.slice(0, start))),
    Buffer.from(replacement, 'utf8'), original.subarray(bomSize + Buffer.byteLength(sourceSnapshot.text.slice(0, end)))]);
}

function proposalDetail(candidate) {
  const change = candidate.proposal.changes[0];
  const removed = change.originalText.split('\n').map((line) => `-${line}`).join('\n');
  const added = change.replacementText.split('\n').map((line) => `+${line}`).join('\n');
  return `Proposal ID: ${candidate.id}\nProposal SHA-256: ${candidate.proposalHash}\nSource SHA-256: ${candidate.sourceSnapshot.fileHash}\n` +
    `Affected file: ${path.join(candidate.sourceSnapshot.rootPath, change.path)}\n` +
    `Original:\n${change.originalText}\nReplacement:\n${change.replacementText}\n` +
    `Exact diff:\n--- ${change.path}\n+++ ${change.path}\n${removed}\n${added}\n` +
    'After confirmation, pinned fixture tests and representative inputs run on a disposable copy first. Failure or cancellation leaves source unchanged. ' +
    'Coverage is sampled, not an equivalence proof or an OS sandbox.';
}

function writeExactSource(vscode, candidate, bytes, token) {
  checkCancelled(token);
  const filePath = path.join(candidate.sourceSnapshot.rootPath, candidate.sourceSnapshot.path);
  if (syncFs.realpathSync.native(candidate.sourceSnapshot.rootPath) !== candidate.sourceSnapshot.rootPath) throw new Error('Project root changed before write.');
  for (const relativePath of [candidate.sourceSnapshot.path, candidate.reportRelativePath]) {
    let current = candidate.sourceSnapshot.rootPath;
    for (const segment of relativePath.split('/')) {
      current = path.join(current, segment);
      if (syncFs.lstatSync(current).isSymbolicLink() || !isPathWithinRoot(candidate.sourceSnapshot.rootPath, syncFs.realpathSync.native(current))) {
        throw new Error('Unsafe source or report path before write.');
      }
    }
  }
  const document = (vscode.workspace.textDocuments ?? []).find((item) =>
    path.resolve(item.uri.fsPath).toLowerCase() === path.resolve(filePath).toLowerCase());
  if (document && (document.isDirty || document.version !== candidate.sourceSnapshot.version)) {
    throw new Error('Source buffer or document version changed before write.');
  }
  const reportPath = path.join(candidate.sourceSnapshot.rootPath, candidate.reportRelativePath);
  const reportDocument = (vscode.workspace.textDocuments ?? []).find((item) =>
    path.resolve(item.uri.fsPath).toLowerCase() === path.resolve(reportPath).toLowerCase());
  if (reportDocument?.isDirty || hashBytes(syncFs.readFileSync(reportPath)) !== candidate.reportHash) {
    throw new Error('Reviewed report changed before write.');
  }
  const handle = syncFs.openSync(filePath, 'r+');
  try {
    const stat = syncFs.fstatSync(handle);
    const currentStat = syncFs.lstatSync(filePath);
    if (currentStat.isSymbolicLink() || stat.ino !== currentStat.ino || stat.dev !== currentStat.dev ||
        hashBytes(syncFs.readFileSync(handle)) !== candidate.sourceSnapshot.fileHash) {
      throw new Error('Source changed before write.');
    }
    checkCancelled(token);
    let written = 0;
    while (written < bytes.length) written += syncFs.writeSync(handle, bytes, written, bytes.length - written, written);
    syncFs.ftruncateSync(handle, bytes.length);
  } finally {
    syncFs.closeSync(handle);
  }
}

class ProposalCandidateStore {
  #entries = new Map();
  #active = new Set();
  #verifier;

  constructor(verifier) {
    this.#verifier = verifier ?? ((candidate, token) => require('./fixture-replay').verifyControlledProposal(candidate, token));
  }

  list() {
    return [...this.#entries.values()].map(({ candidate, status }) => Object.freeze({
      id: candidate.id, path: candidate.target.path, reportPath: candidate.reportPath, proposalHash: candidate.proposalHash, status
    }));
  }

  async add(vscode, result) {
    if (result.status !== 'ready' || result.proposal.changes.length === 0) return null;
    const candidate = structuredClone({ ...result, id: randomUUID() });
    if (!validateProposal(candidate.proposal, candidate.evidenceCatalog, candidate.target).valid ||
        hashBytes(JSON.stringify(candidate.proposal)) !== candidate.proposalHash ||
        hashBytes(JSON.stringify(candidate.evidenceCatalog)) !== candidate.evidenceHash ||
        hashBytes(candidate.target.source.text) !== candidate.targetSpanHash ||
        candidate.sourceSnapshot.path !== candidate.target.path ||
        hashBytes(Buffer.from(candidate.sourceSnapshot.bytes, 'base64')) !== candidate.sourceSnapshot.fileHash) {
      throw new Error('Invalid proposal candidate.');
    }
    replacementBytes(candidate);
    await assertSourceSnapshot(vscode, candidate.sourceSnapshot);
    candidate.reportRelativePath = path.relative(candidate.sourceSnapshot.rootPath, candidate.reportPath).split(path.sep).join('/');
    candidate.reportPath = await safeFile(candidate.sourceSnapshot.rootPath, candidate.reportRelativePath);
    if (hashBytes(await fs.readFile(candidate.reportPath)) !== candidate.reportHash) throw new Error('Generated report changed before candidate registration.');
    this.#entries.set(candidate.id, { candidate: freezeSnapshot(candidate), status: 'pending' });
    return candidate.id;
  }

  async #assertCurrent(vscode, candidate, token) {
    checkCancelled(token);
    const root = await resolveWorkspaceRoot(candidate.sourceSnapshot.rootPath, vscode.workspace.workspaceFolders);
    if (root.realPath !== candidate.sourceSnapshot.rootPath) throw new Error('Selected root changed.');
    await assertSourceSnapshot(vscode, candidate.sourceSnapshot);
    const report = await safeFile(root.realPath, candidate.reportRelativePath);
    const document = vscode.workspace.openTextDocument ? await vscode.workspace.openTextDocument(report) :
      (vscode.workspace.textDocuments ?? []).find((item) => item.uri.fsPath === report);
    if (document?.isDirty || hashBytes(await fs.readFile(report)) !== candidate.reportHash) {
      throw new Error('Reviewed report changed; generate a revised proposal.');
    }
    checkCancelled(token);
  }

  async apply(vscode, proposalId, token) {
    if (typeof proposalId !== 'string') return { status: 'rejected', reason: 'Only a stored proposal ID is accepted.' };
    const entry = this.#entries.get(proposalId);
    if (!entry || entry.status !== 'pending' || this.#active.has(proposalId)) return { status: 'rejected', reason: 'Unknown, stale, or already applied proposal ID.' };
    const { candidate } = entry;
    this.#active.add(proposalId);
    let verificationReportPath;
    try {
      await this.#assertCurrent(vscode, candidate, token);
      await require('./fixture-replay').readControlledFixture(candidate);
      if (typeof vscode.window?.showWarningMessage !== 'function') throw new Error('Extension-owned confirmation is unavailable.');
      const choice = await vscode.window.showWarningMessage('Review and apply this exact proposal?',
        { modal: true, detail: proposalDetail(candidate) }, APPLY_LABEL);
      checkCancelled(token);
      if (choice !== APPLY_LABEL) return { status: 'cancelled' };
      await this.#assertCurrent(vscode, candidate, token);
      const verification = await this.#verifier(candidate, token);
      checkCancelled(token);
      const { writeProposalReport } = require('./proposal-report');
      const { renderVerificationReport } = require('./fixture-replay');
      verificationReportPath = await writeProposalReport(candidate.sourceSnapshot.rootPath,
        path.posix.dirname(candidate.reportRelativePath), renderVerificationReport(candidate, verification), token);
      if (verification.status !== 'passed') {
        entry.status = 'failed';
        return { status: 'failed', reason: 'Controlled verification failed; revised proposal required.', verificationReportPath };
      }
      await this.#assertCurrent(vscode, candidate, token);
      await require('./fixture-replay').assertFixtureHashes(candidate, verification.fixtureHashes);
      await this.#assertCurrent(vscode, candidate, token);
      const bytes = replacementBytes(candidate);
      await safeFile(candidate.sourceSnapshot.rootPath, candidate.sourceSnapshot.path);
      writeExactSource(vscode, candidate, bytes, token);
      entry.status = 'applied';
      return { status: 'applied', proposalId, verificationReportPath, sourceHash: hashBytes(bytes) };
    } catch (error) {
      if (error.code === 'CANCELLED' || token?.isCancellationRequested) return { status: 'cancelled', verificationReportPath };
      entry.status = 'stale';
      return { status: 'rejected', reason: error.message, verificationReportPath };
    } finally {
      this.#active.delete(proposalId);
    }
  }
}

class ApplyProposalTool {
  constructor(vscode, store) {
    this.vscode = vscode;
    this.store = store;
  }

  async invoke(options, token) {
    const input = options.input;
    const result = input && Object.keys(input).length === 1 && typeof input.proposalId === 'string' ?
      await this.store.apply(this.vscode, input.proposalId, token) : { status: 'rejected', reason: 'Only a stored proposal ID is accepted.' };
    return new this.vscode.LanguageModelToolResult([new this.vscode.LanguageModelTextPart(JSON.stringify(result))]);
  }
}

module.exports = { APPLY_TOOL, APPLY_LABEL, hashBytes, safeFile, captureSourceSnapshot, assertSourceSnapshot,
  spanOffsets, replacementBytes, ProposalCandidateStore, ApplyProposalTool };
