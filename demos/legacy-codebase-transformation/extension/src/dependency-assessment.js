'use strict';

const semver = require('semver');
const { DEPENDENCY_LIMITS, validPackageName } = require('./dependency-inventory');

const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json';
const OSV_URL = 'https://api.osv.dev/v1/query';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactVersion = (value) => typeof value === 'string' && value.length <= 256 && semver.valid(value) === value;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const timestamp = (value) => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const registryUrl = (name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`;
const now = () => new Date().toISOString();

function fault(code) {
  const error = new Error(`Dependency metadata ${code}.`);
  error.code = code;
  return error;
}

function limitsFor(overrides = {}) {
  if (!object(overrides)) throw fault('invalid-limits');
  const limits = { ...DEPENDENCY_LIMITS };
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 1 || value > limits[name]) {
      throw fault('invalid-limits');
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function plainFact(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > DEPENDENCY_LIMITS.maxResponseBytes ||
      /[^\x20-\x7e]|<|>|https?:\/\/|www\.|\[|\]|`/i.test(value)) return null;
  return value.trim();
}

function safeSpec(value) {
  return typeof value === 'string' && value.length <= 512 && value === value.trim() &&
    /^[a-zA-Z0-9.*+^~<>=| -]+$/.test(value) &&
    (semver.validRange(value) !== null || /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value));
}

async function boundedOperation(operation, token, limits) {
  if (token?.isCancellationRequested) throw fault('cancelled');
  const controller = new AbortController();
  let timer;
  let subscription;
  let abortReason;
  const interrupted = new Promise((resolve, reject) => {
    const abort = (code) => {
      abortReason = code;
      controller.abort();
      reject(fault(code));
    };
    timer = setTimeout(() => abort('timeout'), limits.requestTimeoutMs);
    subscription = token?.onCancellationRequested?.(() => abort('cancelled'));
    if (token?.isCancellationRequested) abort('cancelled');
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw fault(abortReason);
      return operation(controller.signal);
    }), interrupted]);
  } finally {
    clearTimeout(timer);
    subscription?.dispose();
    controller.abort();
  }
}

function validateRequest(request, limits) {
  if (!object(request) || Object.keys(request).some((key) => !['url', 'method', 'headers', 'body'].includes(key))) {
    throw fault('invalid-request');
  }
  let url;
  try { url = new URL(request.url); } catch { throw fault('invalid-request'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw fault('invalid-request');
  }
  if (url.hostname === 'registry.npmjs.org') {
    let name;
    try { name = decodeURIComponent(url.pathname.slice(1)); } catch { throw fault('invalid-request'); }
    if (!validPackageName(name) || request.url !== registryUrl(name) || request.method !== 'GET' ||
        request.body !== undefined || JSON.stringify(request.headers) !== JSON.stringify({ Accept: REGISTRY_ACCEPT })) {
      throw fault('invalid-request');
    }
  } else if (request.url === OSV_URL) {
    const body = request.body;
    if (request.method !== 'POST' || JSON.stringify(request.headers) !== JSON.stringify({ 'Content-Type': 'application/json' }) ||
        !object(body) || Object.keys(body).some((key) => !['package', 'version', 'page_token'].includes(key)) ||
        !object(body.package) || Object.keys(body.package).length !== 2 || body.package.ecosystem !== 'npm' ||
        !validPackageName(body.package.name) || !exactVersion(body.version) ||
        (body.page_token !== undefined && (typeof body.page_token !== 'string' || !body.page_token ||
          Buffer.byteLength(body.page_token) > limits.maxResponseBytes))) throw fault('invalid-request');
  } else {
    throw fault('invalid-request');
  }
  if (Buffer.byteLength(JSON.stringify(request.body ?? {})) > limits.maxResponseBytes) throw fault('request-body-limit');
}

async function defaultTransport(request, token, limits = DEPENDENCY_LIMITS, options = {}) {
  limits = limitsFor(limits);
  validateRequest(request, limits);
  return boundedOperation(async (signal) => {
    let reader;
    const cancelReader = () => { if (reader) void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
      const response = await (options.fetch ?? globalThis.fetch)(request.url, {
        method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal
      });
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw fault('cancelled'); }
      if (response.status !== 200 || response.redirected || (response.url && response.url !== request.url)) {
        void response.body?.cancel().catch(() => {});
        throw fault(response.status >= 300 && response.status < 400 || response.redirected ? 'redirect-rejected' : 'http-unavailable');
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limits.maxResponseBytes)) {
        void response.body?.cancel().catch(() => {});
        throw fault('response-size-limit');
      }
      if (!response.body) throw fault('malformed-json');
      reader = response.body.getReader();
      const buffer = Buffer.alloc(limits.maxResponseBytes);
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) throw fault('cancelled');
        if (chunk.done) break;
        const offset = bytes;
        bytes += chunk.value.byteLength;
        if (bytes > limits.maxResponseBytes) throw fault('response-size-limit');
        buffer.set(chunk.value, offset);
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
      } catch { throw fault('malformed-json'); }
    } catch (error) {
      cancelReader();
      throw typeof error?.code === 'string' && error.message === `Dependency metadata ${error.code}.` ? error : fault('service-unavailable');
    } finally {
      signal.removeEventListener('abort', cancelReader);
    }
  }, token, limits);
}

function metadataRecord(name, version, value, gaps) {
  if (!object(value) || value.version !== version || (value.name !== undefined && value.name !== name)) {
    gaps.push('Missing or invalid exact-version metadata.');
    return { version, status: 'unknown', deprecated: null, deprecationStatus: 'unknown', engines: {}, peerDependencies: {} };
  }
  const explicitDeprecation = typeof value.deprecated === 'string' && value.deprecated.trim().length > 0;
  const deprecated = value.deprecated === undefined ? '' : plainFact(value.deprecated);
  const record = { version, status: 'completed', deprecated: deprecated || null,
    deprecationStatus: explicitDeprecation ? 'deprecated' : deprecated === null ? 'unknown' : 'not-declared',
    engines: {}, peerDependencies: {} };
  if (deprecated === null) {
    record.status = 'unknown';
    gaps.push(explicitDeprecation ? 'Unsafe deprecation message omitted; explicit deprecation retained.' : 'Invalid version-specific deprecation field.');
  }
  for (const field of ['engines', 'peerDependencies']) {
    if (value[field] === undefined) continue;
    if (!object(value[field])) { record.status = 'unknown'; gaps.push(`Invalid ${field} metadata.`); continue; }
    for (const [key, spec] of Object.entries(value[field])) {
      if (!validPackageName(key) || !safeSpec(spec)) {
        record.status = 'unknown'; gaps.push(`Unsupported ${field} metadata.`); continue;
      }
      Object.defineProperty(record[field], key, { value: spec, enumerable: true });
    }
  }
  return record;
}

function normalizeRegistry(name, payload, declarations) {
  const result = { name, status: 'completed', latest: null, latestStable: null, lockedVersions: [], declarations: [], gaps: [],
    caveats: ['Registry candidates are not verified compatible; candidate advisories were not queried.'] };
  if (!object(payload) || payload.name !== name || !object(payload.versions)) throw fault('registry-identity-or-schema');
  const versions = new Map();
  const versionGaps = new Map();
  for (const [version, value] of Object.entries(payload.versions)) {
    if (!exactVersion(version)) { result.gaps.push('Invalid registry version key.'); continue; }
    const gaps = [];
    versions.set(version, metadataRecord(name, version, value, gaps));
    if (gaps.length) versionGaps.set(version, gaps);
  }
  const includeVersionGaps = (version) => result.gaps.push(...(versionGaps.get(version) ?? []));
  const latest = object(payload['dist-tags']) ? payload['dist-tags'].latest : undefined;
  if (exactVersion(latest) && versions.get(latest)?.status === 'completed') result.latest = versions.get(latest);
  else {
    result.gaps.push('Missing or invalid latest tag/version metadata.');
    if (exactVersion(latest)) includeVersionGaps(latest);
  }
  const locked = [...new Set(declarations.flatMap((entry) => entry.lockedVersions))];
  result.lockedVersions = locked.map((version) => {
    const record = versions.get(version);
    if (!record) return metadataRecord(name, version, undefined, result.gaps);
    if (record.status !== 'completed') includeVersionGaps(version);
    return record;
  });
  const stable = [...versions.values()].filter((entry) => entry.status === 'completed' && !entry.deprecated &&
    semver.prerelease(entry.version) === null).map((entry) => entry.version);
  const stableNondeprecated = [...versions.values()].filter((entry) => entry.deprecationStatus === 'not-declared' &&
    semver.prerelease(entry.version) === null).map((entry) => entry.version);
  const latestStableVersion = semver.maxSatisfying(stableNondeprecated, '*');
  if (latestStableVersion) {
    result.latestStable = versions.get(latestStableVersion);
    includeVersionGaps(latestStableVersion);
  }
  for (const [version, record] of versions) {
    if (record.status !== 'completed' && record.deprecationStatus !== 'deprecated' &&
        semver.prerelease(version) === null && (!latestStableVersion || semver.gt(version, latestStableVersion))) {
      includeVersionGaps(version);
    }
  }
  result.declarations = declarations.map((entry) => {
    const range = semver.validRange(entry.spec);
    const candidate = range === null ? null : semver.maxSatisfying(stable, range);
    if (range !== null) {
      for (const [version, record] of versions) {
        if (record.status !== 'completed' && record.deprecationStatus !== 'deprecated' &&
            semver.prerelease(version) === null && semver.satisfies(version, range) &&
            (!candidate || semver.gt(version, candidate))) includeVersionGaps(version);
      }
    }
    const caveats = [...result.caveats];
    const lockedVersion = semver.maxSatisfying(entry.lockedVersions, '*');
    const updateCandidate = range !== null && lockedVersion && result.latestStable &&
      semver.gt(result.latestStable.version, lockedVersion) ? result.latestStable : null;
    if (range === null) caveats.push('Registry tag; no declared semver range candidate inferred.');
    if (range !== null && new semver.Range(entry.spec).set.some((comparators) =>
      comparators.some((comparator) => comparator.semver.prerelease?.length && entry.spec.includes(comparator.semver.version)))) {
      caveats.push('Declared range includes prerelease comparators; candidates remain stable only.');
    }
    if (!entry.lockedVersions.length) caveats.push('Exact locked direct version unknown.');
    if (entry.lockedVersions.some((version) => semver.prerelease(version) !== null)) caveats.push('A locked direct version is a prerelease.');
    if (result.latest && semver.prerelease(result.latest.version) !== null) caveats.push('Latest tag points to a prerelease.');
    if (result.latest && range !== null && !semver.satisfies(result.latest.version, range)) caveats.push('Latest is outside the declared range.');
    if (updateCandidate && !semver.satisfies(updateCandidate.version, range)) {
      caveats.push('Update candidate changes the declared range; review compatibility before applying.');
    }
    if (updateCandidate?.status !== 'completed') caveats.push('Update candidate metadata is incomplete.');
    if (result.latest && entry.lockedVersions.some((version) => semver.major(version) !== semver.major(result.latest.version))) {
      caveats.push('Latest changes the major version relative to a locked direct version.');
    }
    if (range !== null && !candidate) caveats.push('No nondeprecated stable release satisfies the declared range.');
    return { manifest: entry.manifest, spec: entry.spec, groups: [...entry.groups], lockedVersions: [...entry.lockedVersions],
      candidate: candidate ? versions.get(candidate) : null, updateCandidate, caveats };
  });
  result.gaps = [...new Set(result.gaps)];
  if (result.gaps.length) result.status = 'incomplete';
  return result;
}

function normalizeSeverity(value, gaps) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { gaps.push('Malformed upstream severity.'); return []; }
  return value.flatMap((entry) => {
    if (!object(entry) || typeof entry.type !== 'string' || !/^[A-Z0-9_]+$/.test(entry.type) ||
        !plainFact(entry.score)) { gaps.push('Malformed upstream severity.'); return []; }
    return [{ type: entry.type, score: plainFact(entry.score) }];
  });
}

function normalizeAdvisory(name, payload) {
  if (!object(payload) || !identifier(payload.id) || !timestamp(payload.modified) ||
      (payload.withdrawn !== undefined && !timestamp(payload.withdrawn)) || !Array.isArray(payload.affected)) {
    throw fault('advisory-identity-or-schema');
  }
  const gaps = [];
  const matching = payload.affected.filter((entry) => object(entry) && object(entry.package) &&
    entry.package.ecosystem === 'npm' && entry.package.name === name);
  if (!matching.length) throw fault('advisory-package-identity');
  const aliases = payload.aliases === undefined ? [] : payload.aliases;
  if (!Array.isArray(aliases) || aliases.some((alias) => !identifier(alias))) throw fault('advisory-alias-schema');
  const affected = matching.map((entry) => {
    const normalized = { package: { name, ecosystem: 'npm' }, versions: [], ranges: [],
      severity: normalizeSeverity(entry.severity, gaps) };
    if (entry.versions !== undefined) {
      if (!Array.isArray(entry.versions) || entry.versions.some((version) => !exactVersion(version))) {
        gaps.push('Malformed affected versions.');
      } else normalized.versions = [...entry.versions];
    }
    if (entry.ranges !== undefined) {
      if (!Array.isArray(entry.ranges)) gaps.push('Malformed affected ranges.');
      else for (const range of entry.ranges) {
        if (!object(range) || !['SEMVER', 'ECOSYSTEM'].includes(range.type) || !Array.isArray(range.events) || !range.events.length) {
          gaps.push('Unsupported affected range.'); continue;
        }
        const events = [];
        for (const event of range.events) {
          const keys = object(event) ? Object.keys(event) : [];
          const key = keys[0];
          if (keys.length !== 1 || !['introduced', 'fixed', 'last_affected', 'limit'].includes(key) ||
              !(exactVersion(event[key]) || key === 'introduced' && event[key] === '0')) {
            gaps.push('Malformed advisory range event.'); continue;
          }
          events.push({ [key]: event[key] });
        }
        normalized.ranges.push({ type: range.type, events });
      }
    }
    if (!normalized.versions.length && !normalized.ranges.length) gaps.push('Missing affected version/range evidence.');
    return normalized;
  });
  const severity = normalizeSeverity(payload.severity, gaps);
  const suppliedSeverity = payload.database_specific?.severity;
  const databaseSeverity = suppliedSeverity === undefined ? null : plainFact(suppliedSeverity);
  if (suppliedSeverity !== undefined && !databaseSeverity) gaps.push('Malformed database severity.');
  return { record: { id: payload.id, aliases: [...new Set(aliases)], modified: payload.modified,
    withdrawn: payload.withdrawn ?? null, url: `https://osv.dev/vulnerability/${encodeURIComponent(payload.id)}`,
    severity, databaseSeverity,
    severityStatus: severity.length || databaseSeverity || affected.some((entry) => entry.severity.length) ? 'supplied' : 'unknown',
    affected }, gaps };
}

function approvedSnapshot(inventory) {
  let snapshot;
  try { snapshot = structuredClone(inventory); } catch { throw fault('invalid-inventory'); }
  if (!object(snapshot) || typeof snapshot.projectRoot !== 'string' || !snapshot.projectRoot ||
      typeof snapshot.fingerprint !== 'string' || !snapshot.fingerprint || !object(snapshot.lookup) ||
      !Array.isArray(snapshot.lookup.registryNames) || !Array.isArray(snapshot.lookup.advisoryTuples) ||
      !Array.isArray(snapshot.declarations) || !Array.isArray(snapshot.occurrences) || !Array.isArray(snapshot.gaps)) {
    throw fault('invalid-inventory');
  }
  const { registryNames, advisoryTuples } = snapshot.lookup;
  if (registryNames.length > DEPENDENCY_LIMITS.maxRegistryNames || advisoryTuples.length > DEPENDENCY_LIMITS.maxAdvisoryTuples ||
      new Set(registryNames).size !== registryNames.length ||
      new Set(advisoryTuples.map((entry) => `${entry?.name}@${entry?.version}`)).size !== advisoryTuples.length ||
      registryNames.some((name) => !validPackageName(name) || !snapshot.declarations.some((entry) => entry.name === name && safeSpec(entry.spec))) ||
      advisoryTuples.some((entry) => !object(entry) || Object.keys(entry).length !== 2 || !validPackageName(entry.name) ||
        !exactVersion(entry.version) || !snapshot.occurrences.some((occurrence) => occurrence.name === entry.name && occurrence.version === entry.version))) {
    throw fault('invalid-inventory');
  }
  for (const entry of snapshot.declarations.filter((declaration) => registryNames.includes(declaration.name))) {
    if (entry.spec === '(unsupported)') continue;
    if (!safeSpec(entry.spec) || !Array.isArray(entry.groups) || !Array.isArray(entry.lockedVersions) ||
        entry.lockedVersions.some((version) => !exactVersion(version) || !snapshot.occurrences.some((occurrence) =>
          occurrence.name === entry.name && occurrence.version === version && occurrence.manifest === entry.manifest))) {
      throw fault('invalid-inventory');
    }
  }
  return snapshot;
}

async function assessDependencies(inventory, token, options = {}) {
  const snapshot = approvedSnapshot(inventory);
  const limits = limitsFor(options.limits);
  const transport = options.transport ?? ((request, cancellation, requestLimits) => defaultTransport(request, cancellation, requestLimits, { fetch: options.fetch }));
  const result = { status: 'completed', projectRoot: snapshot.projectRoot, fingerprint: snapshot.fingerprint,
    inventory: snapshot, requests: 0, registry: [], advisories: [], gaps: snapshot.gaps.map((entry) => ({ source: 'inventory', ...entry })),
    startedAt: now(), completedAt: null };
  let cancellationSeen = false;
  const send = async (request) => {
    if (cancellationSeen || token?.isCancellationRequested) throw fault('cancelled');
    if (result.requests >= limits.maxHttpRequests) throw fault('request-budget');
    validateRequest(request, limits);
    const payload = await boundedOperation(() => {
      if (token?.isCancellationRequested) throw fault('cancelled');
      result.requests += 1;
      return transport(request, token, limits);
    }, token, limits);
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(payload)); } catch { throw fault('malformed-json'); }
    if (bytes > limits.maxResponseBytes) throw fault('response-size-limit');
    if (token?.isCancellationRequested) throw fault('cancelled');
    return payload;
  };
  const unavailable = (entry, error) => {
    const codes = ['cancelled', 'timeout', 'request-budget', 'request-body-limit', 'response-size-limit', 'malformed-json',
      'invalid-request', 'redirect-rejected', 'http-unavailable', 'registry-identity-or-schema', 'advisory-identity-or-schema',
      'advisory-package-identity', 'advisory-alias-schema', 'malformed-page', 'repeated-page-token', 'page-limit', 'lookup-limit'];
    const reason = codes.includes(error?.code) ? error.code : 'service-unavailable';
    if (reason === 'cancelled') cancellationSeen = true;
    entry.gaps.push(reason);
    entry.status = entry.queried ? 'incomplete' : 'unknown';
  };
  for (const [index, name] of snapshot.lookup.registryNames.entries()) {
    let entry = { name, url: registryUrl(name), status: 'unknown', queried: false, latest: null,
      lockedVersions: [], declarations: [], caveats: [], gaps: [], startedAt: now(), completedAt: null };
    try {
      if (index >= limits.maxRegistryNames) throw fault('lookup-limit');
      const before = result.requests;
      let payload;
      try { payload = await send({ url: entry.url, method: 'GET', headers: { Accept: REGISTRY_ACCEPT } }); }
      finally { entry.queried = result.requests > before; }
      entry = { ...entry, ...normalizeRegistry(name, payload, snapshot.declarations.filter((declaration) =>
        declaration.name === name && declaration.spec !== '(unsupported)')) };
    } catch (error) { unavailable(entry, error); }
    entry.completedAt = now();
    result.registry.push(entry);
  }
  for (const [index, tuple] of snapshot.lookup.advisoryTuples.entries()) {
    const entry = { ...tuple, url: OSV_URL, status: 'unknown', queried: false, pages: 0, matches: [],
      activeCount: 0, withdrawnCount: 0, outcome: 'unknown', gaps: [], startedAt: now(), completedAt: null };
    const matches = new Map();
    const seenTokens = new Set();
    let pageToken;
    try {
      if (index >= limits.maxAdvisoryTuples) throw fault('lookup-limit');
      while (true) {
        if (entry.pages >= limits.maxOsvPagesPerTuple) throw fault('page-limit');
        const body = { package: { name: tuple.name, ecosystem: 'npm' }, version: tuple.version,
          ...(pageToken === undefined ? {} : { page_token: pageToken }) };
        const before = result.requests;
        let payload;
        try { payload = await send({ url: OSV_URL, method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
        finally { entry.queried ||= result.requests > before; }
        entry.pages += 1;
        if (!object(payload) || Object.keys(payload).some((key) => !['vulns', 'next_page_token'].includes(key)) ||
          payload.vulns !== undefined && !Array.isArray(payload.vulns)) throw fault('malformed-page');
        for (const advisory of payload.vulns ?? []) {
          try {
            const normalized = normalizeAdvisory(tuple.name, advisory);
            entry.gaps.push(...normalized.gaps);
            const prior = matches.get(normalized.record.id);
            if (prior && JSON.stringify(prior) !== JSON.stringify(normalized.record)) entry.gaps.push('Conflicting records for the same advisory ID.');
            if (!prior || Date.parse(prior.modified) < Date.parse(normalized.record.modified)) matches.set(normalized.record.id, normalized.record);
          } catch (error) { unavailable(entry, error); }
        }
        const next = payload.next_page_token;
        if (next === undefined || next === '') break;
        if (typeof next !== 'string' || Buffer.byteLength(next) > limits.maxResponseBytes) throw fault('malformed-page');
        if (seenTokens.has(next)) throw fault('repeated-page-token');
        seenTokens.add(next);
        pageToken = next;
      }
      entry.status = entry.gaps.length ? 'incomplete' : 'completed';
    } catch (error) { unavailable(entry, error); }
    entry.matches = [...matches.values()];
    entry.activeCount = entry.matches.filter((match) => !match.withdrawn).length;
    entry.withdrawnCount = entry.matches.length - entry.activeCount;
    entry.outcome = entry.matches.length ? 'provider-matches' : entry.status === 'completed' ? 'none-returned' : 'unknown';
    entry.gaps = [...new Set(entry.gaps)];
    entry.completedAt = now();
    result.advisories.push(entry);
  }
  for (const [source, entries] of [['registry', result.registry], ['osv', result.advisories]]) {
    for (const entry of entries) for (const reason of entry.gaps) {
      result.gaps.push({ source, name: entry.name, ...(entry.version ? { version: entry.version } : {}), reason });
    }
  }
  result.status = cancellationSeen || token?.isCancellationRequested ? 'cancelled' : result.gaps.length ? 'incomplete' :
    !snapshot.declarations.length && !snapshot.occurrences.length ? 'not-applicable' : 'completed';
  result.completedAt = now();
  return result;
}

module.exports = { assessDependencies, defaultTransport, normalizeRegistry, normalizeAdvisory };
