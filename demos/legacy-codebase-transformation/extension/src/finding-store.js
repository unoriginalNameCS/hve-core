'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isPathWithinRoot, resolveWorkspaceRoot } = require('./workspace-scope');
const { hashSource } = require('./workspace-scan');

function freezeRecord(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeRecord);
    Object.freeze(value);
  }
  return value;
}

function samePath(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === 'win32' ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

function publicFinding(entry) {
  const { rootPath, ...finding } = entry.finding;
  return { ...structuredClone(finding), status: entry.status };
}

class FindingStore {
  #entries = new Map();
  #scanId = null;

  addScan(result) {
    if (this.#scanId !== result.scanId) this.#entries.clear();
    this.#scanId = result.scanId ?? null;
    for (const finding of result.findings ?? []) {
      if (this.#entries.has(finding.id)) continue;
      const record = freezeRecord(structuredClone({ ...finding, rootPath: result.root }));
      this.#entries.set(record.id, { finding: record, status: 'new' });
    }
    return this.list();
  }

  list() {
    return [...this.#entries.values()].map(publicFinding);
  }

  get(findingId) {
    const entry = this.#entries.get(findingId);
    return entry ? publicFinding(entry) : null;
  }

  async #isCurrent(vscode, entry) {
    const { finding } = entry;
    const root = await resolveWorkspaceRoot(finding.rootPath, vscode.workspace.workspaceFolders);
    const storedRootRealPath = await fs.realpath(finding.rootPath);
    if (!samePath(root.realPath, storedRootRealPath) || !finding.path || finding.path.includes('\\') ||
        path.posix.isAbsolute(finding.path) || finding.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      return false;
    }
    const candidatePath = path.resolve(root.realPath, ...finding.path.split('/'));
    if (!isPathWithinRoot(root.realPath, candidatePath)) return false;
    const realPath = await fs.realpath(candidatePath);
    if (!isPathWithinRoot(root.realPath, realPath) || !(await fs.stat(realPath)).isFile()) return false;
    const document = (vscode.workspace.textDocuments ?? []).find((item) => samePath(item.uri.fsPath, realPath));
    if (document?.isDirty) return false;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(realPath));
    return hashSource(source) === finding.sourceHash;
  }

  async refresh(vscode, findingId) {
    const entries = findingId ? [this.#entries.get(findingId)] : [...this.#entries.values()];
    if (findingId && !entries[0]) throw new Error('Unknown finding ID. Run a scan and list current findings.');
    for (const entry of entries) {
      if (entry.status === 'dismissed' || entry.status === 'stale') continue;
      try {
        if (!(await this.#isCurrent(vscode, entry))) entry.status = 'stale';
      } catch {
        entry.status = 'stale';
      }
    }
    return findingId ? this.get(findingId) : this.list();
  }

  async select(vscode, findingId) {
    const finding = await this.refresh(vscode, findingId);
    const entry = this.#entries.get(findingId);
    if (entry.status === 'stale' || entry.status === 'dismissed' || entry.status === 'approved') {
      return { status: 'rejected', finding };
    }
    entry.status = 'selected';
    return { status: 'selected', finding: this.get(findingId) };
  }

  dismiss(findingId) {
    const entry = this.#entries.get(findingId);
    if (!entry) throw new Error('Unknown finding ID. Run a scan and list current findings.');
    if (entry.status === 'approved') throw new Error('An approved finding cannot be dismissed.');
    entry.status = 'dismissed';
    return this.get(findingId);
  }

  async approve(vscode, findingId) {
    const finding = await this.refresh(vscode, findingId);
    const entry = this.#entries.get(findingId);
    if (entry.status !== 'selected' || finding.status === 'stale') {
      return { status: 'rejected', finding };
    }
    entry.status = 'approved';
    return { status: 'approved', finding: this.get(findingId) };
  }

  async dispose(vscode, approveIds = [], rejectIds = []) {
    if (!Array.isArray(approveIds) || !Array.isArray(rejectIds) ||
        [...approveIds, ...rejectIds].some((id) => typeof id !== 'string' || !id) ||
        new Set([...approveIds, ...rejectIds]).size !== approveIds.length + rejectIds.length ||
        approveIds.length + rejectIds.length === 0) {
      return { status: 'rejected', reason: 'Provide non-empty, unique, disjoint finding ID lists.' };
    }
    const ids = [...approveIds, ...rejectIds];
    if (ids.some((id) => !this.#entries.has(id))) {
      return { status: 'rejected', reason: 'Every ID must belong to the current scan.' };
    }
    const findings = await Promise.all(ids.map((id) => this.refresh(vscode, id)));
    const statuses = new Map(findings.map((finding) => [finding.id, finding.status]));
    if (approveIds.some((id) => !['new', 'selected', 'approved'].includes(statuses.get(id))) ||
        rejectIds.some((id) => !['new', 'selected', 'dismissed'].includes(statuses.get(id)))) {
      return { status: 'rejected', reason: 'No decisions were applied; refresh and resolve stale or previously dispositioned findings.', findings };
    }
    for (const id of approveIds) {
      if (statuses.get(id) !== 'approved') this.#entries.get(id).status = 'approved';
    }
    for (const id of rejectIds) {
      if (statuses.get(id) !== 'dismissed') this.#entries.get(id).status = 'dismissed';
    }
    return {
      status: 'completed',
      approved: approveIds.map((id) => this.get(id)),
      rejected: rejectIds.map((id) => this.get(id))
    };
  }

  getCurrent(findingId) {
    const entry = this.#entries.get(findingId);
    if (!entry || !['new', 'selected', 'approved'].includes(entry.status)) return null;
    return structuredClone(entry.finding);
  }

  getApproved(findingId) {
    const entry = this.#entries.get(findingId);
    if (!entry || entry.status !== 'approved') return null;
    return structuredClone(entry.finding);
  }
}

module.exports = { FindingStore };
