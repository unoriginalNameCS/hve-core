'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const semver = require('semver');
const { resolveWorkspaceRoot, isPathWithinRoot } = require('./workspace-scope');
const { isExcludedPath, EXCLUDED_DIRECTORIES } = require('./workspace-scan');

const DEPENDENCY_LIMITS = Object.freeze({
  maxDocuments: 200,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxSnapshotBytes: 32 * 1024 * 1024,
  maxRegistryNames: 100,
  maxAdvisoryTuples: 200,
  maxHttpRequests: 300,
  maxOsvPagesPerTuple: 5,
  maxConcurrentRequests: 4,
  requestTimeoutMs: 15000,
  maxResponseBytes: 2 * 1024 * 1024,
  previewTtlMs: 5 * 60 * 1000
});
const NPM_DOCUMENTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
const MANAGER_SIGNALS = new Set(['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const UNSUPPORTED = '(unsupported)';
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function validPackageName(name) {
  return typeof name === 'string' && name.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !['node_modules', 'favicon.ico'].includes(name);
}

function safeSpec(spec) {
  if (typeof spec !== 'string' || spec.length > 512 || spec !== spec.trim()) return UNSUPPORTED;
  if (!/^[a-zA-Z0-9.*+^~<>=| -]+$/.test(spec)) return UNSUPPORTED;
  return semver.validRange(spec) !== null || /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(spec) ? spec : UNSUPPORTED;
}

function exactVersion(version) {
  return typeof version === 'string' && version.length <= 256 && semver.valid(version) === version;
}

function unsupportedLockNames(packages) {
  const names = new Set();
  for (const record of Object.values(packages)) {
    if (!object(record)) continue;
    for (const group of GROUPS) {
      if (!object(record[group])) continue;
      for (const [name, spec] of Object.entries(record[group])) {
        if (group === 'dependencies' && Object.hasOwn(record.optionalDependencies ?? {}, name)) continue;
        if (validPackageName(name) && safeSpec(spec) === UNSUPPORTED) names.add(name);
      }
    }
  }
  return names;
}

function validManifest(manifest) {
  return object(manifest) &&
    (manifest.name === undefined || validPackageName(manifest.name)) &&
    (manifest.version === undefined || exactVersion(manifest.version)) &&
    GROUPS.every((group) => manifest[group] === undefined ||
      (object(manifest[group]) && Object.entries(manifest[group]).every(([name, spec]) =>
        validPackageName(name) && typeof spec === 'string'))) &&
    (manifest.overrides === undefined || object(manifest.overrides));
}

function declarationsFor(manifest, manifestPath, unsupported, gap) {
  const names = [...new Set(GROUPS.flatMap((group) => Object.keys(manifest[group] ?? {})))].sort(compare);
  return names.map((name) => {
    const groups = GROUPS.filter((group) => Object.hasOwn(manifest[group] ?? {}, name));
    const effectiveGroups = groups.filter((group) => group !== 'dependencies' || !groups.includes('optionalDependencies'));
    const specs = [...new Set(effectiveGroups.map((group) => safeSpec(manifest[group][name])))];
    const spec = !unsupported && specs.length === 1 ? specs[0] : UNSUPPORTED;
    if (spec === UNSUPPORTED) gap(manifestPath, 'Unsupported or ambiguous declaration; no lookup authorized by this entry.');
    return { name, spec, groups, manifest: manifestPath, lockedVersions: [] };
  });
}

function packagePathName(location) {
  if (typeof location !== 'string' || location.includes('\\')) return undefined;
  const segments = location.split('/');
  let name;
  for (let index = 0; index < segments.length;) {
    if (segments[index++] !== 'node_modules') return undefined;
    name = segments[index++];
    if (name?.startsWith('@')) name += `/${segments[index++] ?? ''}`;
    if (!validPackageName(name)) return undefined;
  }
  return name;
}

function publicResolution(record, name) {
  if (record.resolved === undefined) return 'unknown';
  if (typeof record.resolved !== 'string') return 'unsupported';
  try {
    const resolved = new URL(record.resolved);
    const basename = name.split('/').at(-1);
    return resolved.protocol === 'https:' && resolved.hostname === 'registry.npmjs.org' &&
      !resolved.port && !resolved.username && !resolved.password && !resolved.search && !resolved.hash &&
      decodeURIComponent(resolved.pathname) === `/${name}/-/${basename}-${record.version}.tgz`
      ? 'public' : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

function consistentRoot(manifest, lock) {
  const lockRoot = lock.packages[''];
  if (!validManifest(lockRoot)) return false;
  for (const field of ['name', 'version']) {
    for (const source of [lock, lockRoot]) {
      if (source[field] !== undefined && source[field] !== manifest[field]) return false;
    }
  }
  return GROUPS.every((group) => {
    const manifestGroup = { ...(manifest[group] ?? {}) };
    const lockGroup = { ...(lockRoot[group] ?? {}) };
    if (group === 'dependencies') {
      for (const name of Object.keys(manifest.optionalDependencies ?? {})) delete manifestGroup[name];
      for (const name of Object.keys(lockRoot.optionalDependencies ?? {})) delete lockGroup[name];
    }
    return JSON.stringify(Object.entries(manifestGroup).sort(([left], [right]) => compare(left, right))) ===
      JSON.stringify(Object.entries(lockGroup).sort(([left], [right]) => compare(left, right)));
  });
}

function cancelled(token) {
  if (token?.isCancellationRequested) throw new Error('Dependency inventory cancelled.');
}

async function inventoryDependencies(vscode, projectRoot, token) {
  const root = await resolveWorkspaceRoot(projectRoot, vscode.workspace.workspaceFolders);
  if (root.uri.scheme !== 'file' || root.uri.authority) {
    throw new Error('Dependency inventory requires the canonical open file workspace root.');
  }
  cancelled(token);
  const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(root.workspaceFolder, '**/*'),
    '**/{.git,node_modules,vendor,bin,obj,dist,build,coverage,generated,out,target}/**', undefined, token);
  const gaps = [];
  const gap = (filePath, reason) => gaps.push({ path: filePath, reason });
  const candidates = [];
  const seen = new Set();
  let excluded = 0;
  for (const uri of matches) {
    cancelled(token);
    if (!NPM_DOCUMENTS.has(path.basename(uri.fsPath ?? '')) && !MANAGER_SIGNALS.has(path.basename(uri.fsPath ?? ''))) continue;
    const discoveryRoot = isPathWithinRoot(root.uri.fsPath, uri.fsPath) ? root.uri.fsPath : root.realPath;
    const relativePath = path.relative(discoveryRoot, uri.fsPath).split(path.sep).join('/');
    if (!isPathWithinRoot(discoveryRoot, uri.fsPath)) {
      gap('(outside workspace)', 'Path escapes the opened root.');
      continue;
    }
    if (isExcludedPath(relativePath)) { excluded += 1; continue; }
    if (uri.scheme !== 'file' || uri.authority) throw new Error('Unsupported dependency document URI.');
    let realPath;
    try { realPath = await fs.realpath(uri.fsPath); } catch {
      gap(relativePath, 'Unreadable dependency document.');
      continue;
    }
    if (!isPathWithinRoot(root.realPath, realPath)) throw new Error('Dependency document escapes the canonical workspace root.');
    if (pathKey(realPath) !== pathKey(path.join(root.realPath, relativePath)) || seen.has(pathKey(realPath))) {
      throw new Error('Dependency document has a canonical path alias.');
    }
    seen.add(pathKey(realPath));
    candidates.push({ uri, realPath, path: relativePath });
  }
  candidates.sort((left, right) => compare(left.path, right.path));
  for (const document of vscode.workspace.textDocuments ?? []) {
    if (!document.isDirty || document.uri?.scheme !== 'file') continue;
    let realPath;
    try { realPath = await fs.realpath(document.uri.fsPath); } catch { realPath = document.uri.fsPath; }
    if (seen.has(pathKey(realPath))) throw new Error('Save dirty dependency documents before inventory.');
  }
  const documents = [];
  const parsed = new Map();
  const membership = [];
  let bytes = 0;
  for (const candidate of candidates) {
    cancelled(token);
    membership.push(candidate.path);
    if (documents.length >= DEPENDENCY_LIMITS.maxDocuments) {
      gap(candidate.path, 'Inventory document limit exceeded.');
      continue;
    }
    try {
      const handle = await fs.open(candidate.realPath, 'r');
      let input;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) { gap(candidate.path, 'Not a regular dependency document.'); continue; }
        if (stat.size > DEPENDENCY_LIMITS.maxDocumentBytes || bytes + stat.size > DEPENDENCY_LIMITS.maxSnapshotBytes) {
          gap(candidate.path, 'Inventory byte limit exceeded.');
          continue;
        }
        input = Buffer.alloc(stat.size + 1);
        const result = await handle.read(input, 0, input.length, 0);
        input = input.subarray(0, result.bytesRead);
        if (input.length !== stat.size) throw new Error('Document changed during read.');
      } finally { await handle.close(); }
      if (pathKey(await fs.realpath(candidate.uri.fsPath)) !== pathKey(candidate.realPath)) {
        throw new Error('Document path changed during read.');
      }
      bytes += input.length;
      documents.push({ path: candidate.path, hash: hash(input) });
      if (MANAGER_SIGNALS.has(path.basename(candidate.path))) continue;
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input).replace(/^\uFEFF/, ''));
      if (!object(value)) throw new Error('Invalid document schema.');
      parsed.set(candidate.path, value);
    } catch {
      gap(candidate.path, 'Unreadable, changed, malformed JSON or invalid dependency document.');
    }
  }
  cancelled(token);
  const declarations = [];
  const occurrences = [];
  if (![...parsed].some(([documentPath, value]) => path.posix.basename(documentPath) === 'package.json' && validManifest(value))) {
    gap('(inventory)', 'No valid visible npm manifest; dependency presence was not assessed.');
  }
  const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
  const locatedPath = (directory, filename) => directory === '.' ? filename : `${directory}/${filename}`;
  for (const [manifestPath, manifest] of parsed) {
    if (path.posix.basename(manifestPath) !== 'package.json') continue;
    if (!validManifest(manifest)) { gap(manifestPath, 'Invalid manifest identity or declaration schema.'); continue; }
    const directory = path.posix.dirname(manifestPath);
    const mixed = [...MANAGER_SIGNALS].some((filename) => candidatePaths.has(locatedPath(directory, filename))) ||
      (manifest.packageManager !== undefined && (typeof manifest.packageManager !== 'string' ||
        !/^npm@\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(manifest.packageManager)));
    const overrides = manifest.overrides !== undefined && Object.keys(manifest.overrides).length > 0;
    const direct = declarationsFor(manifest, manifestPath, mixed || overrides, gap);
    declarations.push(...direct);
    if (mixed || overrides) {
      gap(manifestPath, mixed ? 'Conflicting package-manager signals; npm ownership not assessed.' : 'Overrides make package identity ambiguous; not assessed.');
      continue;
    }
    const shrinkwrap = locatedPath(directory, 'npm-shrinkwrap.json');
    const packageLock = locatedPath(directory, 'package-lock.json');
    const lockPath = candidatePaths.has(shrinkwrap) ? shrinkwrap : packageLock;
    if (candidatePaths.has(shrinkwrap) && candidatePaths.has(packageLock)) gap(packageLock, 'Superseded by colocated npm-shrinkwrap.json.');
    const lock = parsed.get(lockPath);
    if (!candidatePaths.has(lockPath)) {
      if (direct.length) gap(manifestPath, 'No colocated npm lock; shared workspace lock ownership is not inferred.');
      continue;
    }
    if (!lock || ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages)) {
      gap(lockPath, 'Only valid npm lock v2/v3 packages maps are supported.');
      continue;
    }
    if (!consistentRoot(manifest, lock)) {
      gap(lockPath, 'Stale or invalid lock root identity/declarations; recorded versions not assessed.');
      continue;
    }
    const blockedNames = unsupportedLockNames(lock.packages);
    const lockOccurrences = [];
    for (const [location, record] of Object.entries(lock.packages).sort(([left], [right]) => compare(left, right))) {
      if (location === '') continue;
      const name = packagePathName(location);
        if (!name || !validManifest(record) || (record.name !== undefined && record.name !== name) ||
          !exactVersion(record.version) || (record.link !== undefined && record.link !== false)) {
        if (name) blockedNames.add(name);
        gap(lockPath, 'Unsupported lock path, link, package identity or exact version.');
        continue;
      }
      if (blockedNames.has(name) || record.private === true || publicResolution(record, name) === 'unsupported') {
        blockedNames.add(name);
        gap(lockPath, 'Known non-public or unsupported package resolution omitted.');
        continue;
      }
      if (publicResolution(record, name) === 'unknown') gap(lockPath, 'Package origin unknown; public lookup requires explicit approval.');
      const declaration = direct.find((entry) => location === `node_modules/${entry.name}`);
      if (declaration && (declaration.spec === UNSUPPORTED ||
          (semver.validRange(declaration.spec) !== null && !semver.satisfies(record.version, declaration.spec)))) {
        blockedNames.add(name);
        gap(lockPath, 'Direct lock version does not satisfy the effective declaration.');
        continue;
      }
      lockOccurrences.push({ name, version: record.version, path: location, lock: lockPath, manifest: manifestPath });
    }
    for (const declaration of direct) {
      if (blockedNames.has(declaration.name)) {
        declaration.spec = UNSUPPORTED;
        continue;
      }
      const occurrence = lockOccurrences.find((entry) => entry.path === `node_modules/${declaration.name}`);
      if (occurrence) declaration.lockedVersions.push(occurrence.version);
      else gap(manifestPath, 'Direct dependency has no supported colocated lock occurrence.');
    }
    occurrences.push(...lockOccurrences);
  }
  for (const candidate of candidates) {
    if (['package-lock.json', 'npm-shrinkwrap.json'].includes(path.posix.basename(candidate.path)) &&
        !parsed.has(locatedPath(path.posix.dirname(candidate.path), 'package.json'))) {
      gap(candidate.path, 'No valid colocated manifest; lock ownership not inferred.');
    }
  }
  for (const document of vscode.workspace.textDocuments ?? []) {
    if (!document.isDirty || document.uri?.scheme !== 'file') continue;
    let realPath;
    try { realPath = await fs.realpath(document.uri.fsPath); } catch { realPath = document.uri.fsPath; }
    if (seen.has(pathKey(realPath))) throw new Error('Save dirty dependency documents before inventory.');
  }
  cancelled(token);
  const supportedOccurrences = occurrences;
  const registryNames = [...new Set(declarations.filter((entry) => entry.spec !== UNSUPPORTED).map((entry) => entry.name))].sort(compare);
  const advisoryTuples = [...new Map(supportedOccurrences.map(({ name, version }) =>
    [`${name}@${version}`, { name, version }])).values()].sort((left, right) => compare(left.name, right.name) || compare(left.version, right.version));
  module.exports = { inventoryDependencies, DEPENDENCY_LIMITS, validPackageName, consistentRoot, packagePathName, publicResolution };
  if (registryNames.length > DEPENDENCY_LIMITS.maxRegistryNames) gap('(lookup)', 'Registry name limit exceeded; remaining names not selected.');
  if (advisoryTuples.length > DEPENDENCY_LIMITS.maxAdvisoryTuples) gap('(lookup)', 'Advisory tuple limit exceeded; remaining tuples not selected.');
  gaps.sort((left, right) => compare(left.path, right.path) || compare(left.reason, right.reason));
  const snapshot = {
    projectRoot: root.realPath, documents, declarations, occurrences: supportedOccurrences,
    lookup: { registryNames: registryNames.slice(0, DEPENDENCY_LIMITS.maxRegistryNames),
      advisoryTuples: advisoryTuples.slice(0, DEPENDENCY_LIMITS.maxAdvisoryTuples) },
    gaps,
    coverage: { discoveredDocuments: candidates.length, readDocuments: documents.length, snapshotBytes: bytes,
      excludedDocuments: excluded, declarations: declarations.length, occurrences: supportedOccurrences.length,
      registryNames: registryNames.length, advisoryTuples: advisoryTuples.length,
      omittedRegistryNames: Math.max(0, registryNames.length - DEPENDENCY_LIMITS.maxRegistryNames),
      omittedAdvisoryTuples: Math.max(0, advisoryTuples.length - DEPENDENCY_LIMITS.maxAdvisoryTuples) },
    limits: DEPENDENCY_LIMITS
  };
  snapshot.fingerprint = hash(JSON.stringify({ ...snapshot, membership, exclusions: [...EXCLUDED_DIRECTORIES].sort(compare) }));
  return snapshot;
}

module.exports = { inventoryDependencies, DEPENDENCY_LIMITS, validPackageName, consistentRoot, packagePathName, publicResolution };
