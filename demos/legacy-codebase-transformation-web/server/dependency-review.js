'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const semver = require('semver');
const { isExcludedPath } = require('../../legacy-codebase-transformation/extension/src/workspace-scan');

const DEPENDENCY_LIMITS = Object.freeze({
  maxDocuments: 200,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxSnapshotBytes: 32 * 1024 * 1024,
  maxRegistryNames: 100,
  maxAdvisoryTuples: 200,
  maxHttpRequests: 300,
  maxOsvPagesPerTuple: 5,
  requestTimeoutMs: 15000,
  maxResponseBytes: 2 * 1024 * 1024
});
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const MANAGER_SIGNALS = new Set(['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const UNSUPPORTED = '(unsupported)';
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json';
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const OSV_URL = 'https://api.osv.dev/v1/query';
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function validPackageName(name) {
  return typeof name === 'string' && name.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) &&
    !['node_modules', 'favicon.ico'].includes(name);
}

function safeSpec(spec) {
  if (typeof spec !== 'string' || spec.length > 512 || spec !== spec.trim() ||
      !/^[a-zA-Z0-9.*+^~<>=| -]+$/.test(spec)) return UNSUPPORTED;
  return semver.validRange(spec) !== null || /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(spec) ? spec : UNSUPPORTED;
}

function exactVersion(version) {
  return typeof version === 'string' && version.length <= 256 && semver.valid(version) === version;
}

function validManifest(value) {
  return object(value) &&
    (value.name === undefined || validPackageName(value.name)) &&
    (value.version === undefined || exactVersion(value.version)) &&
    GROUPS.every((group) => value[group] === undefined || (object(value[group]) &&
      Object.entries(value[group]).every(([name, spec]) => validPackageName(name) && typeof spec === 'string')));
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
    return resolved.protocol === 'https:' && resolved.hostname === 'registry.npmjs.org' && !resolved.port &&
      !resolved.username && !resolved.password && !resolved.search && !resolved.hash &&
      decodeURIComponent(resolved.pathname) === `/${name}/-/${basename}-${record.version}.tgz`
      ? 'public' : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

function parseJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
}

function inventoryNpmFiles(files, rootName, options = {}) {
  if (!(files instanceof Map)) throw new TypeError('Uploaded files must be a Map.');
  const limits = DEPENDENCY_LIMITS;
  const documents = [];
  const parsed = new Map();
  const candidates = [];
  const gaps = [];
  let bytes = 0;
  let discovered = 0;
  const addGap = (file, reason) => gaps.push({ path: file, reason });
  const eligible = [...files.entries()].filter(([file]) => {
    const basename = path.posix.basename(file);
    return !isExcludedPath(file) && ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', ...MANAGER_SIGNALS].includes(basename);
  }).sort(([left], [right]) => compare(left, right));

  for (const [file, content] of eligible) {
    discovered += 1;
    if (discovered > limits.maxDocuments) { addGap(file, 'Dependency document limit exceeded.'); continue; }
    const documentBytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (documentBytes.byteLength > limits.maxDocumentBytes || bytes + documentBytes.byteLength > limits.maxSnapshotBytes) {
      addGap(file, 'Dependency snapshot byte limit exceeded.');
      continue;
    }
    bytes += documentBytes.byteLength;
    documents.push({ path: file, hash: hash(documentBytes) });
    const basename = path.posix.basename(file);
    if (MANAGER_SIGNALS.has(basename)) continue;
    try {
      const value = parseJson(documentBytes);
      if (!object(value)) throw new Error('Invalid JSON object.');
      parsed.set(file, value);
      if (basename === 'package.json' && validManifest(value)) candidates.push(file);
    } catch {
      addGap(file, 'Unreadable or malformed dependency document.');
    }
  }

  const declarations = [];
  const occurrences = [];
  const candidatePaths = new Set(eligible.map(([file]) => file));
  if (!candidates.length) addGap('(inventory)', 'No valid npm manifest was found.');

  for (const manifestPath of candidates) {
    const manifest = parsed.get(manifestPath);
    const directory = path.posix.dirname(manifestPath);
    const lockPath = [
      directory === '.' ? 'npm-shrinkwrap.json' : `${directory}/npm-shrinkwrap.json`,
      directory === '.' ? 'package-lock.json' : `${directory}/package-lock.json`
    ].find((file) => candidatePaths.has(file));
    const managerConflict = [...MANAGER_SIGNALS].some((name) => candidatePaths.has(directory === '.' ? name : `${directory}/${name}`)) ||
      manifest.packageManager !== undefined && (typeof manifest.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(manifest.packageManager));
    const groupsFor = (name) => GROUPS.filter((group) => Object.hasOwn(manifest[group] ?? {}, name));
    const names = [...new Set(GROUPS.flatMap((group) => Object.keys(manifest[group] ?? {})))].sort(compare);
    const direct = names.map((name) => {
      const groups = groupsFor(name);
      const effectiveGroups = groups.filter((group) => group !== 'dependencies' || !groups.includes('optionalDependencies'));
      const specs = [...new Set(effectiveGroups.map((group) => safeSpec(manifest[group][name])))];
      const spec = !managerConflict && manifest.overrides === undefined && specs.length === 1 ? specs[0] : UNSUPPORTED;
      if (spec === UNSUPPORTED) addGap(manifestPath, `Unsupported or ambiguous declaration for ${name}; registry lookup omitted.`);
      return { name, spec, groups, manifest: manifestPath, lockedVersions: [] };
    });
    declarations.push(...direct);

    if (managerConflict || manifest.overrides !== undefined) {
      addGap(manifestPath, managerConflict ? 'Conflicting package-manager signals; npm declaration evidence is incomplete.' : 'Overrides make package identity ambiguous; npm declaration evidence is incomplete.');
      continue;
    }
    if (!lockPath) {
      if (direct.length) addGap(manifestPath, 'No colocated npm lockfile; exact versions and advisories are unavailable.');
      continue;
    }
    const lock = parsed.get(lockPath);
    if (!lock || ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages)) {
      addGap(lockPath, 'Only valid npm lock v2/v3 packages maps are supported.');
      continue;
    }
    const root = lock.packages[''];
    const matchingGroups = GROUPS.every((group) => {
      const expected = Object.entries(manifest[group] ?? {}).sort(([left], [right]) => compare(left, right));
      const actual = Object.entries(root?.[group] ?? {}).sort(([left], [right]) => compare(left, right));
      return JSON.stringify(expected) === JSON.stringify(actual);
    });
    const matchingIdentity = root && validManifest(root) && ['name', 'version'].every((field) =>
      root[field] === undefined || manifest[field] === root[field]) &&
      ['name', 'version'].every((field) => lock[field] === undefined || manifest[field] === lock[field]);
    if (!matchingIdentity || !matchingGroups) {
      addGap(lockPath, 'Lock root does not match the manifest declarations; locked versions are not assessed.');
      continue;
    }

    const packageRecords = [];
    let lockInvalid = false;
    for (const [location, record] of Object.entries(lock.packages).sort(([left], [right]) => compare(left, right))) {
      if (location === '') continue;
      const name = packagePathName(location);
      if (!name || !object(record) || record.name !== undefined && record.name !== name ||
          !exactVersion(record.version) || record.link !== undefined && record.link !== false) {
        addGap(lockPath, 'Unsupported lock path, package identity, link, or exact version.');
        lockInvalid = true;
        continue;
      }
      const origin = publicResolution(record, name);
      if (origin === 'unsupported' || record.private === true) {
        addGap(lockPath, `Non-public or unsupported package resolution omitted: ${name}.`);
        continue;
      }
      packageRecords.push({ name, version: record.version, path: location, lock: lockPath, manifest: manifestPath, origin });
    }
    if (lockInvalid) addGap(lockPath, 'One or more lock records were omitted; package coverage is incomplete.');
    for (const declaration of direct) {
      if (declaration.spec === UNSUPPORTED) continue;
      const record = packageRecords.find((entry) => entry.path === `node_modules/${declaration.name}`);
      if (!record) {
        addGap(manifestPath, `No supported direct lock record for ${declaration.name}.`);
        continue;
      }
      const range = semver.validRange(declaration.spec);
      if (range && !semver.satisfies(record.version, range)) {
        declaration.spec = UNSUPPORTED;
        addGap(lockPath, `Locked direct version does not satisfy the declared range for ${declaration.name}.`);
        continue;
      }
      declaration.lockedVersions.push(record.version);
    }
    occurrences.push(...packageRecords);
  }

  for (const [file] of eligible) {
    const basename = path.posix.basename(file);
    if (['package-lock.json', 'npm-shrinkwrap.json'].includes(basename) &&
        !parsed.has(path.posix.join(path.posix.dirname(file), 'package.json'))) {
      addGap(file, 'No colocated package manifest; lock ownership is unknown.');
    }
  }
  const registryNames = [...new Set(declarations.filter((entry) => entry.spec !== UNSUPPORTED).map((entry) => entry.name))].sort(compare);
  const advisoryTuples = [...new Map(occurrences.map(({ name, version }) => [`${name}@${version}`, { name, version }])).values()]
    .sort((left, right) => compare(left.name, right.name) || compare(left.version, right.version));
  const rootManifest = parsed.get(`${rootName}/package.json`);
  const rootLock = parsed.get(`${rootName}/package-lock.json`);
  const buildAvailable = Boolean(validManifest(rootManifest) && rootManifest.workspaces === undefined && rootLock &&
    [2, 3].includes(rootLock.lockfileVersion) && object(rootLock.packages) &&
    (rootManifest.packageManager === undefined || typeof rootManifest.packageManager === 'string' && /^npm@\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(rootManifest.packageManager)));
  if (registryNames.length > limits.maxRegistryNames) addGap('(lookup)', 'Registry name limit exceeded; remaining names omitted.');
  if (advisoryTuples.length > limits.maxAdvisoryTuples) addGap('(lookup)', 'Advisory tuple limit exceeded; remaining tuples omitted.');
  gaps.sort((left, right) => compare(left.path, right.path) || compare(left.reason, right.reason));

  const snapshot = {
    rootName,
    rootManifest: candidates.includes(`${rootName}/package.json`) ? `${rootName}/package.json` : undefined,
    buildScript: typeof rootManifest?.scripts?.build === 'string' && rootManifest.scripts.build.trim() ? rootManifest.scripts.build : null,
    buildAvailable,
    documents,
    declarations,
    occurrences,
    lookup: {
      registryNames: registryNames.slice(0, limits.maxRegistryNames),
      advisoryTuples: advisoryTuples.slice(0, limits.maxAdvisoryTuples)
    },
    gaps,
    coverage: {
      discoveredDocuments: discovered, readDocuments: documents.length, snapshotBytes: bytes,
      declarations: declarations.length, occurrences: occurrences.length,
      registryNames: registryNames.length, advisoryTuples: advisoryTuples.length
    },
    limits
  };
  snapshot.fingerprint = hash(JSON.stringify(snapshot));
  return snapshot;
}

function plainText(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

async function readResponse(response, maxBytes) {
  if (response.status !== 200 || response.redirected) throw new Error('The metadata service did not return HTTP 200.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('Metadata response exceeded its size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Metadata response body was missing.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Metadata response exceeded its size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function requestJson(url, method, body, options) {
  if (url !== `${REGISTRY_ORIGIN}/${encodeURIComponent(options.name)}` && url !== OSV_URL) {
    throw new Error('Unsupported metadata destination.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEPENDENCY_LIMITS.requestTimeoutMs);
  try {
    const response = await options.fetch(url, {
      method,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: url === OSV_URL ? { 'Content-Type': 'application/json' } : { Accept: REGISTRY_ACCEPT },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return await readResponse(response, DEPENDENCY_LIMITS.maxResponseBytes);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Metadata request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function registryEvidence(name, payload, declarations, now = new Date().toISOString()) {
  if (!object(payload) || payload.name !== name || !object(payload.versions)) throw new Error('Registry identity or response schema was invalid.');
  const versions = new Map();
  for (const [version, value] of Object.entries(payload.versions)) {
    if (!exactVersion(version) || !object(value) || value.version !== version || value.name !== undefined && value.name !== name) continue;
    const deprecated = value.deprecated === undefined ? null : plainText(value.deprecated);
    versions.set(version, { version, deprecated, status: value.deprecated !== undefined && deprecated === null ? 'incomplete' : 'completed' });
  }
  const latestTag = object(payload['dist-tags']) ? payload['dist-tags'].latest : undefined;
  const latest = exactVersion(latestTag) ? versions.get(latestTag) ?? null : null;
  const stable = [...versions.values()].filter((entry) => !entry.deprecated && entry.status === 'completed' && semver.prerelease(entry.version) === null)
    .map((entry) => entry.version);
  const latestStableVersion = semver.maxSatisfying(stable, '*');
  const latestStable = latestStableVersion ? versions.get(latestStableVersion) : null;
  const direct = declarations.map((declaration) => {
    const range = semver.validRange(declaration.spec);
    const candidateVersion = range ? semver.maxSatisfying(stable, range) : null;
    const currentVersion = semver.maxSatisfying(declaration.lockedVersions, '*');
    return {
      manifest: declaration.manifest,
      spec: declaration.spec,
      groups: declaration.groups,
      lockedVersions: declaration.lockedVersions,
      candidate: candidateVersion ? versions.get(candidateVersion) : null,
      updateCandidate: latestStable && currentVersion && semver.gt(latestStable.version, currentVersion) ? latestStable : null,
      caveats: [
        ...(!range ? ['Declaration is not a semver range; no compatible candidate inferred.'] : []),
        ...(!currentVersion ? ['Exact locked version is unknown.'] : []),
        ...(currentVersion && latestStable && semver.major(currentVersion) !== semver.major(latestStable.version) ? ['Latest stable candidate changes the major version.'] : [])
      ]
    };
  });
  const lockedVersions = [...new Set(declarations.flatMap((entry) => entry.lockedVersions))].map((version) => versions.get(version) ?? { version, status: 'unknown', deprecated: null });
  return { name, status: latest || latestStable || lockedVersions.some((entry) => entry.status === 'completed') ? 'completed' : 'incomplete',
    queried: true, latest, latestStable, lockedVersions, declarations: direct, retrievedAt: now };
}

function advisoryEvidence(tuple, payload) {
  if (!object(payload) || payload.vulns !== undefined && !Array.isArray(payload.vulns)) throw new Error('OSV response schema was invalid.');
  const matches = [];
  for (const vulnerability of payload.vulns ?? []) {
    if (!object(vulnerability) || typeof vulnerability.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(vulnerability.id) ||
        !Array.isArray(vulnerability.affected)) continue;
    const affected = vulnerability.affected.filter((entry) => object(entry) && object(entry.package) &&
      entry.package.ecosystem === 'npm' && entry.package.name === tuple.name);
    if (!affected.length) continue;
    const severity = (vulnerability.severity ?? []).filter((entry) => object(entry) && typeof entry.type === 'string' && typeof entry.score === 'string')
      .map((entry) => ({ type: entry.type.slice(0, 40), score: entry.score.slice(0, 80) }));
    const fixedVersions = [...new Set(affected.flatMap((entry) => (entry.ranges ?? []).flatMap((range) =>
      (range.events ?? []).flatMap((event) => exactVersion(event.fixed) ? [event.fixed] : []))))];
    matches.push({ id: vulnerability.id, aliases: Array.isArray(vulnerability.aliases) ?
      vulnerability.aliases.filter((value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)).slice(0, 30) : [],
    summary: plainText(vulnerability.summary), modified: plainText(vulnerability.modified, 40), severity, fixedVersions });
  }
  return { ...tuple, status: 'completed', queried: true, matches };
}

async function assessNpmDependencies(inventory, options = {}) {
  if (!inventory || typeof inventory.fingerprint !== 'string' || !inventory.lookup ||
      !Array.isArray(inventory.lookup.registryNames) || !Array.isArray(inventory.lookup.advisoryTuples)) {
    throw new TypeError('A validated npm inventory is required.');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch.');
  let requests = 0;
  const gaps = inventory.gaps.map((entry) => ({ source: 'inventory', ...entry }));
  const registry = [];
  const advisories = [];
  const run = async (url, method, body, name) => {
    if (requests >= DEPENDENCY_LIMITS.maxHttpRequests) throw new Error('Metadata request budget exceeded.');
    requests += 1;
    return requestJson(url, method, body, { fetch: fetchImpl, name });
  };

  for (const name of inventory.lookup.registryNames.slice(0, DEPENDENCY_LIMITS.maxRegistryNames)) {
    const declarations = inventory.declarations.filter((entry) => entry.name === name && entry.spec !== UNSUPPORTED);
    const entryUrl = `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}`;
    try {
      const payload = await run(entryUrl, 'GET', undefined, name);
      registry.push(registryEvidence(name, payload, declarations));
    } catch {
      registry.push({ name, status: 'unknown', queried: requests > 0, latest: null, latestStable: null, lockedVersions: [], declarations: [] });
      gaps.push({ source: 'registry', name, reason: 'Registry evidence unavailable or invalid.' });
    }
  }

  for (const tuple of inventory.lookup.advisoryTuples.slice(0, DEPENDENCY_LIMITS.maxAdvisoryTuples)) {
    const matches = new Map();
    let pageToken;
    let status = 'completed';
    let pages = 0;
    const seenTokens = new Set();
    try {
      while (true) {
        if (pages >= DEPENDENCY_LIMITS.maxOsvPagesPerTuple) throw new Error('OSV page limit exceeded.');
        const payload = await run(OSV_URL, 'POST', {
          package: { name: tuple.name, ecosystem: 'npm' }, version: tuple.version,
          ...(pageToken ? { page_token: pageToken } : {})
        }, tuple.name);
        pages += 1;
        const page = advisoryEvidence(tuple, payload);
        for (const match of page.matches) matches.set(match.id, match);
        pageToken = payload.next_page_token;
        if (pageToken === undefined || pageToken === '') break;
        if (typeof pageToken !== 'string' || pageToken.length > DEPENDENCY_LIMITS.maxResponseBytes || seenTokens.has(pageToken)) {
          throw new Error('OSV pagination token was invalid.');
        }
        seenTokens.add(pageToken);
      }
    } catch {
      status = 'incomplete';
      gaps.push({ source: 'osv', name: tuple.name, version: tuple.version, reason: 'OSV evidence unavailable or incomplete.' });
    }
    advisories.push({ ...tuple, status, queried: true, pages, matches: [...matches.values()] });
  }

  return {
    status: gaps.length ? 'incomplete' : inventory.declarations.length || inventory.occurrences.length ? 'completed' : 'not-applicable',
    fingerprint: inventory.fingerprint,
    requests,
    registry,
    advisories,
    gaps,
    startedAt: options.startedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

module.exports = {
  DEPENDENCY_LIMITS,
  assessNpmDependencies,
  inventoryNpmFiles,
  packagePathName,
  publicResolution,
  safeSpec,
  validPackageName
};
