'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const semver = require('semver');
const { consistentRoot, inventoryDependencies, packagePathName, publicResolution, validPackageName } = require('./dependency-inventory');
const { isPathWithinRoot } = require('./workspace-scope');

const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const MAX_UPDATES = 20;
const MAX_RESOLUTION_MS = 90 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const REGISTRY = 'https://registry.npmjs.org/';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const npmErrorCode = (output) => output.match(/npm(?:\s+error|\s+ERR!)\s+code\s+([A-Z0-9]+)/i)?.[1] ?? null;

function fault(code) {
  const error = new Error(`Dependency update ${code}.`);
  error.code = code;
  return error;
}

function decodeJson(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

function parseObject(bytes) {
  const value = JSON.parse(decodeJson(bytes));
  if (!object(value)) throw fault('invalid-json');
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalizeUpdates(updates) {
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > MAX_UPDATES) throw fault('invalid-selection');
  const names = new Set();
  return updates.map((update) => {
    if (!object(update) || Object.keys(update).some((key) => !['name', 'version'].includes(key)) ||
        !validPackageName(update.name) || typeof update.version !== 'string' || semver.valid(update.version) !== update.version ||
        names.has(update.name)) throw fault('invalid-selection');
    names.add(update.name);
    return { name: update.name, version: update.version };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function readSnapshotDocument(snapshot, relativePath) {
  const expected = snapshot.documents.find((document) => document.path === relativePath);
  if (!expected) throw fault('unsupported-project-root');
  const filePath = path.join(snapshot.projectRoot, ...relativePath.split('/'));
  const realPath = await fs.realpath(filePath);
  if (!isPathWithinRoot(snapshot.projectRoot, realPath) || path.resolve(realPath) !== path.resolve(filePath)) {
    throw fault('document-alias');
  }
  const bytes = await fs.readFile(realPath);
  if (hash(bytes) !== expected.hash) throw fault('stale-inputs');
  return { path: relativePath, filePath: realPath, bytes, hash: expected.hash };
}

async function prepareDependencyUpdate(vscode, projectRoot, updates, token) {
  const selection = normalizeUpdates(updates);
  const inventory = await inventoryDependencies(vscode, projectRoot, token);
  if (inventory.projectRoot !== await fs.realpath(projectRoot)) throw fault('noncanonical-root');
  if (inventory.gaps.length) throw fault('unsupported-project-root');
  if (inventory.documents.some((document) => document.path !== 'package.json' && document.path !== 'package-lock.json')) {
    throw fault('single-package-root-required');
  }
  const manifestDocument = await readSnapshotDocument(inventory, 'package.json');
  const lockDocument = await readSnapshotDocument(inventory, 'package-lock.json');
  const manifest = parseObject(manifestDocument.bytes);
  const lock = parseObject(lockDocument.bytes);
  if (manifest.workspaces !== undefined || manifest.packageManager !== undefined &&
      (typeof manifest.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(manifest.packageManager)) ||
      ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages) || !consistentRoot(manifest, lock)) {
    throw fault('unsupported-project-root');
  }
  for (const [location, record] of Object.entries(lock.packages)) {
    if (!location) continue;
    const name = packagePathName(location);
    if (!name || record?.link || publicResolution(record, name) !== 'public') throw fault('unsupported-lock-origin');
  }
  const resolvedUpdates = selection.map((update) => {
    const declaration = inventory.declarations.find((entry) => entry.name === update.name && entry.manifest === 'package.json');
    const groups = GROUPS.filter((group) => Object.hasOwn(manifest[group] ?? {}, update.name));
    if (!declaration || declaration.spec === '(unsupported)' || !groups.length || declaration.lockedVersions.length !== 1) {
      throw fault('unsupported-direct-dependency');
    }
    const locked = lock.packages[`node_modules/${update.name}`];
    if (!locked || semver.valid(locked.version) !== locked.version || declaration.lockedVersions[0] !== locked.version ||
        !semver.gt(update.version, locked.version)) throw fault('candidate-not-newer');
    return { ...update, fromVersion: locked.version, fromSpec: declaration.spec, groups };
  });
  return {
    status: 'ready', projectRoot: inventory.projectRoot, fingerprint: inventory.fingerprint,
    inventory, updates: resolvedUpdates, manifest: manifestDocument, lock: lockDocument
  };
}

function changedLockEntries(before, after) {
  const prior = before.packages ?? {};
  const next = after.packages ?? {};
  const locations = [...new Set([...Object.keys(prior), ...Object.keys(next)])].filter((location) => location !== '').sort();
  return locations.flatMap((location) => {
    const from = prior[location]?.version ?? null;
    const to = next[location]?.version ?? null;
    if (from === to) return [];
    const name = packagePathName(location);
    return [{ name: name ?? '(unsupported lock entry)', path: location, from, to }];
  });
}

function makeManifestBuffer(originalBytes, manifest) {
  const text = decodeJson(originalBytes);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /(?:\r?\n)$/.test(text);
  let output = JSON.stringify(manifest, null, 2).replace(/\n/g, newline);
  if (trailingNewline) output += newline;
  const bom = originalBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? originalBytes.subarray(0, 3) : Buffer.alloc(0);
  return Buffer.concat([bom, Buffer.from(output, 'utf8')]);
}

function preserveLineEndings(originalBytes, generatedBytes) {
  const originalText = decodeJson(originalBytes);
  const generatedText = decodeJson(generatedBytes);
  const newline = originalText.includes('\r\n') ? '\r\n' : '\n';
  const normalized = generatedText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
  const bom = originalBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? originalBytes.subarray(0, 3) : Buffer.alloc(0);
  return Buffer.concat([bom, Buffer.from(normalized, 'utf8')]);
}

async function runNpmResolution(cwd, token, options = {}) {
  const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
    `--registry=${REGISTRY}`, '--userconfig=user.npmrc', '--globalconfig=global.npmrc', '--cache=.npm-cache'];
  if (options.npmResolver) return options.npmResolver({ cwd, args, token });
  const windows = process.platform === 'win32';
  const executable = windows ? process.env.ComSpec ?? 'cmd.exe' : 'npm';
  const command = 'npm.cmd install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --userconfig=user.npmrc --globalconfig=global.npmrc --cache=.npm-cache';
  const spawnArgs = windows ? ['/d', '/s', '/c', command] : args;
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (windows && process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) return reject(fault('cancelled'));
    const child = spawn(executable, spawnArgs, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let output = '';
    let failure;
    const kill = (code) => {
      if (failure) return;
      failure = fault(code);
      if (windows && child.pid && process.env.SystemRoot) {
        const taskkill = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
        taskkill.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), MAX_RESOLUTION_MS);
    const subscription = token?.onCancellationRequested?.(() => kill('cancelled'));
    const consume = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) kill('output-limit');
      else output += chunk.toString('utf8');
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', () => { clearTimeout(timer); subscription?.dispose(); reject(fault('npm-unavailable')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      subscription?.dispose();
      if (failure) reject(failure);
      else if (code !== 0) {
        const error = fault('resolution-failed');
        error.npmExitCode = Number.isInteger(code) ? code : null;
        error.npmErrorCode = npmErrorCode(output);
        reject(error);
      }
      else resolve({ exitCode: code });
    });
  });
}

async function resolveDependencyUpdate(prepared, token, options = {}) {
  let temporaryRoot;
  let resolutionAttempted = false;
  try {
    if (!prepared || prepared.status !== 'ready' || token?.isCancellationRequested) throw fault('cancelled');
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-dependency-resolution-'));
    const manifest = parseObject(prepared.manifest.bytes);
    for (const update of prepared.updates) for (const group of update.groups) manifest[group][update.name] = update.version;
    const expectedManifest = structuredClone(manifest);
    const packagePath = path.join(temporaryRoot, 'package.json');
    const lockPath = path.join(temporaryRoot, 'package-lock.json');
    await fs.writeFile(packagePath, makeManifestBuffer(prepared.manifest.bytes, manifest), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(lockPath, prepared.lock.bytes, { flag: 'wx', mode: 0o600 });
    for (const config of ['.npmrc', 'user.npmrc', 'global.npmrc']) {
      await fs.writeFile(path.join(temporaryRoot, config), '', { flag: 'wx', mode: 0o600 });
    }
    resolutionAttempted = true;
    const resolution = await runNpmResolution(temporaryRoot, token, options);
    if (resolution?.exitCode !== 0 || token?.isCancellationRequested) {
      const error = fault(token?.isCancellationRequested ? 'cancelled' : 'resolution-failed');
      if (Number.isInteger(resolution?.npmExitCode ?? resolution?.exitCode)) {
        error.npmExitCode = resolution.npmExitCode ?? resolution.exitCode;
      }
      const reportedCode = typeof resolution?.npmErrorCode === 'string' ? resolution.npmErrorCode :
        npmErrorCode([resolution?.stderr, resolution?.stdout, resolution?.rawOutput].filter((value) => typeof value === 'string').join('\n'));
      if (typeof reportedCode === 'string' && /^[A-Z0-9]{1,32}$/.test(reportedCode)) error.npmErrorCode = reportedCode;
      throw error;
    }
    const nodeModules = await fs.stat(path.join(temporaryRoot, 'node_modules')).then(() => true, () => false);
    if (nodeModules) throw fault('unexpected-install');
    const afterManifestBytes = await fs.readFile(packagePath);
    const generatedLockBytes = await fs.readFile(lockPath);
    if (afterManifestBytes.length > 4 * 1024 * 1024 || generatedLockBytes.length > 4 * 1024 * 1024) throw fault('resolution-size-limit');
    const afterManifest = parseObject(afterManifestBytes);
    const afterLock = parseObject(generatedLockBytes);
    if (!sameJson(afterManifest, expectedManifest) || ![2, 3].includes(afterLock.lockfileVersion) ||
        !object(afterLock.packages) || !consistentRoot(afterManifest, afterLock)) throw fault('unexpected-manifest-change');
    for (const [location, record] of Object.entries(afterLock.packages)) {
      if (!location) continue;
      const name = packagePathName(location);
      if (!name || record?.link || publicResolution(record, name) !== 'public') throw fault('unsupported-lock-origin');
      if (typeof record.integrity !== 'string' || !record.integrity.startsWith('sha512-')) throw fault('lock-integrity-not-sha512');
    }
    for (const update of prepared.updates) {
      if (afterLock.packages[`node_modules/${update.name}`]?.version !== update.version) throw fault('lock-version-mismatch');
    }
    const manifestAfter = makeManifestBuffer(prepared.manifest.bytes, afterManifest);
    const lockAfter = preserveLineEndings(prepared.lock.bytes, generatedLockBytes);
    const files = [
      { path: prepared.manifest.path, filePath: prepared.manifest.filePath, before: prepared.manifest.bytes, after: manifestAfter },
      { path: prepared.lock.path, filePath: prepared.lock.filePath, before: prepared.lock.bytes, after: lockAfter }
    ].map((file) => ({ ...file, beforeHash: hash(file.before), afterHash: hash(file.after) }));
    if (files.some((file) => file.beforeHash === file.afterHash)) throw fault('empty-diff');
    const lockChanges = changedLockEntries(parseObject(prepared.lock.bytes), afterLock);
    const fingerprint = hash(Buffer.from(JSON.stringify({ root: prepared.projectRoot, snapshot: prepared.fingerprint,
      updates: prepared.updates, files: files.map(({ path: filePath, beforeHash, afterHash }) => ({ path: filePath, beforeHash, afterHash })) })));
    return { status: 'ready', projectRoot: prepared.projectRoot, sourceFingerprint: prepared.fingerprint,
      updates: prepared.updates, files, lockChanges, fingerprint, resolutionAttempted: true };
  } catch (error) {
    const status = error?.code === 'cancelled' ? 'cancelled' : 'failed';
    return { status, resolutionAttempted, reason: error?.code ?? 'resolution-failed',
      npmExitCode: Number.isInteger(error?.npmExitCode) ? error.npmExitCode : null,
      npmErrorCode: typeof error?.npmErrorCode === 'string' ? error.npmErrorCode : null };
  } finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function showDependencyDiff(vscode, prepared) {
  if (!vscode.commands?.executeCommand || !vscode.workspace?.openTextDocument || !vscode.Uri?.file) throw fault('diff-unavailable');
  const diffs = [];
  for (const file of prepared.files) {
    const beforeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(file.filePath));
    const afterDocument = await vscode.workspace.openTextDocument({ language: 'json', content: decodeJson(file.after) });
    await vscode.commands.executeCommand('vscode.diff', beforeDocument.uri, afterDocument.uri,
      `${file.path} dependency update proposal`);
    diffs.push({ path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash });
  }
  return diffs;
}

function textForDocument(bytes, originalBytes, document, vscode) {
  const text = decodeJson(bytes).replace(/\r\n/g, '\n');
  const eol = document.eol === vscode.EndOfLine?.CRLF ? '\r\n' : '\n';
  const normalized = text.replace(/\n/g, eol);
  const bom = originalBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? originalBytes.subarray(0, 3) : Buffer.alloc(0);
  return { text: normalized, bytes: Buffer.concat([bom, Buffer.from(normalized, 'utf8')]) };
}

async function inspectDependencyWrites(documents) {
  const files = [];
  let unreadable = false;
  for (const { file, expectedBytes } of documents) {
    try {
      const actual = await fs.readFile(file.filePath);
      files.push({ path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash,
        actualHash: hash(actual), saved: actual.equals(expectedBytes) });
    } catch {
      unreadable = true;
      files.push({ path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash,
        actualHash: null, saved: false });
    }
  }
  const changed = files.some((file) => file.actualHash !== null && file.actualHash !== file.beforeHash);
  const complete = files.every((file) => file.saved);
  return { files, changed, complete, dependencyWritten: unreadable ? null : changed };
}

async function applyDependencyUpdate(vscode, prepared, token) {
  if (!prepared || prepared.status !== 'ready' || token?.isCancellationRequested) return { status: 'cancelled', dependencyWritten: false };
  let current;
  try { current = await inventoryDependencies(vscode, prepared.projectRoot, token); }
  catch { return { status: 'stale', dependencyWritten: false, reason: 'The package root or dependency files are no longer available.' }; }
  if (current.fingerprint !== prepared.sourceFingerprint) return { status: 'stale', dependencyWritten: false, reason: 'Dependency inputs changed after resolution.' };
  const documents = [];
  try {
    for (const file of prepared.files) {
      if (!isPathWithinRoot(prepared.projectRoot, file.filePath)) throw fault('path-escape');
      const bytes = await fs.readFile(file.filePath);
      if (hash(bytes) !== file.beforeHash) throw fault('stale-inputs');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.filePath));
      const originalText = decodeJson(file.before);
      if (document.isDirty || document.getText() !== originalText) throw fault('dirty-or-changed-buffer');
      const output = textForDocument(file.after, file.before, document, vscode);
      documents.push({ file, document, version: document.version, expectedBytes: output.bytes, newText: output.text });
    }
  } catch (error) {
    return { status: 'stale', dependencyWritten: false, reason: error?.code ?? 'document-unavailable' };
  }
  try {
    for (const { file } of documents) {
      if (hash(await fs.readFile(file.filePath)) !== file.beforeHash) throw fault('stale-inputs');
    }
  } catch (error) {
    return { status: 'stale', dependencyWritten: false, reason: error?.code ?? 'stale-inputs' };
  }
  if (token?.isCancellationRequested) return { status: 'cancelled', dependencyWritten: false };
  if (documents.some(({ document, version, file }) => document.version !== version || document.isDirty ||
      document.getText() !== decodeJson(file.before))) {
    return { status: 'stale', dependencyWritten: false, reason: 'A package document changed before the edit.' };
  }
  const edit = new vscode.WorkspaceEdit();
  for (const { document, newText } of documents) {
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), newText);
  }
  let accepted;
  try { accepted = await vscode.workspace.applyEdit(edit); }
  catch {
    const observed = await inspectDependencyWrites(documents);
    return { status: observed.complete ? 'applied' : 'verification-failed', ...observed,
      reason: observed.complete ? undefined : 'VS Code could not confirm the multi-file edit outcome. Inspect both files before retrying.' };
  }
  if (!accepted) {
    const observed = await inspectDependencyWrites(documents);
    return { status: observed.complete ? 'applied' : observed.changed || observed.dependencyWritten === null ? 'verification-failed' : 'failed',
      ...observed, reason: observed.complete ? undefined : observed.changed || observed.dependencyWritten === null ?
        'VS Code rejected the multi-file edit after a partial or uncertain write. Inspect both files before retrying.' :
        'VS Code rejected the approved package/lock edit; no file changes were found.' };
  }
  for (const entry of documents) {
    try { await entry.document.save(); } catch { }
  }
  const observed = await inspectDependencyWrites(documents);
  return { status: observed.complete ? 'applied' : 'verification-failed', ...observed,
    updates: prepared.updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
    reason: observed.complete ? undefined : 'One or more approved package files did not persist exactly. Inspect both files before retrying.' };
}

module.exports = { MAX_UPDATES, applyDependencyUpdate, prepareDependencyUpdate, resolveDependencyUpdate, showDependencyDiff };
