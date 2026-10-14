'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { SOURCE_EXTENSIONS, chunkSourceFiles, hashSource, isExcludedPath, scanPrompt } = require('../../legacy-codebase-transformation/extension/src/workspace-scan');
const { MAX_FINDINGS_PER_REQUEST, MAX_MODEL_REQUESTS } = require('../../legacy-codebase-transformation/extension/src/scan-pipeline');
const { validateUploadedFinding } = require('./analysis');
const { assessNpmDependencies, inventoryNpmFiles } = require('./dependency-review');
const { prepareDependencyBuild: resolveDependencyBuild, runApprovedBuild } = require('./dependency-build');
const { getFoundryConfiguration, requestFindings } = require('./foundry-client');

const MAX_UPLOAD_FILES = 500;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function appError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeUploadPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      /^[a-z]:/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw appError('The upload contains an invalid relative path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    throw appError('The upload contains an invalid relative path.');
  }
  return segments.join('/');
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (now - session.lastAccessed > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getSession(sessionId) {
  pruneSessions();
  const session = sessions.get(sessionId);
  if (session) session.lastAccessed = Date.now();
  return session ?? null;
}

function removeSession(sessionId) {
  return sessions.delete(sessionId);
}

function offsetAt(text, lineNumber, character) {
  const lines = text.split('\n');
  if (!Number.isInteger(lineNumber) || !Number.isInteger(character) || lineNumber < 1 ||
      lineNumber > lines.length || character < 0 || character > lines[lineNumber - 1].replace(/\r$/, '').length) return null;
  return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + character;
}

function prepareUploadedFiles(manifest, uploadedFiles) {
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_UPLOAD_FILES ||
      !(uploadedFiles instanceof Map) || manifest.length !== uploadedFiles.size) {
    throw appError(`Choose between 1 and ${MAX_UPLOAD_FILES} files from one folder.`);
  }

  let totalBytes = 0;
  const files = new Map();
  const seen = new Set();
  const usedIds = new Set();
  let rootName;
  for (const item of manifest) {
    const relativePath = normalizeUploadPath(item?.path);
    const id = item?.id;
    const buffer = uploadedFiles.get(id);
    if (typeof id !== 'string' || !/^file-\d+$/.test(id) || !Buffer.isBuffer(buffer) ||
        usedIds.has(id) || !Number.isInteger(item.size) || item.size !== buffer.byteLength) {
      throw appError('The uploaded files did not match their manifest. Start a fresh upload.');
    }
    usedIds.add(id);
    const foldedPath = relativePath.toLowerCase();
    if (seen.has(foldedPath)) throw appError('The upload contains duplicate file paths.');
    seen.add(foldedPath);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_UPLOAD_BYTES) throw appError('The selected folder exceeds the 25 MB upload limit.', 413);
    const topLevel = relativePath.split('/')[0];
    if (rootName && topLevel !== rootName) throw appError('Select files from one folder at a time.');
    rootName = topLevel;
    files.set(relativePath, Buffer.from(buffer));
  }
  if (usedIds.size !== uploadedFiles.size) throw appError('The uploaded files did not match their manifest. Start a fresh upload.');

  for (const relativePath of seen) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (seen.has(segments.slice(0, index).join('/'))) {
        throw appError('The upload contains conflicting file and folder paths.');
      }
    }
  }
  return { files, rootName, totalBytes };
}

function sourceInventory(files) {
  const sourceFiles = [];
  const skippedFiles = [];
  for (const [relativePath, bytes] of files) {
    if (isExcludedPath(relativePath) || !SOURCE_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) continue;
    if (bytes.includes(0)) {
      skippedFiles.push({ path: relativePath, reason: 'Binary or unsupported source encoding.' });
      continue;
    }
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      sourceFiles.push({ path: relativePath, content, sourceHash: hashSource(content), bytes: bytes.byteLength });
    } catch {
      skippedFiles.push({ path: relativePath, reason: 'Unreadable source or invalid UTF-8.' });
    }
  }
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  return { sourceFiles, skippedFiles };
}

function prepareUpload(manifest, uploadedFiles) {
  const uploaded = prepareUploadedFiles(manifest, uploadedFiles);
  const inventory = sourceInventory(uploaded.files);
  const chunked = chunkSourceFiles(inventory.sourceFiles);
  if (chunked.chunks.length > MAX_MODEL_REQUESTS) {
    throw appError(`This demo limits a scan to ${MAX_MODEL_REQUESTS} Foundry requests. Select a smaller folder.` , 413);
  }
  const dependencyInventory = inventoryNpmFiles(uploaded.files, uploaded.rootName);
  const rootManifest = dependencyInventory.rootManifest ?
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(uploaded.files.get(dependencyInventory.rootManifest))) : null;
  if (inventory.sourceFiles.length === 0 && dependencyInventory.documents.length === 0) {
    throw appError('No supported source files or npm manifests/lockfiles were found.');
  }

  const scanId = randomUUID();
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    scanId,
    rootName: uploaded.rootName,
    files: uploaded.files,
    sourceFiles: inventory.sourceFiles,
    chunks: chunked.chunks,
    dependencyInventory,
    findings: [],
    sourceFailures: [],
    dependencyAssessment: null,
    complete: false,
    applied: false,
    analysisStarted: false,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    summary: {
      filesUploaded: uploaded.files.size,
      sourceFiles: inventory.sourceFiles.length,
      bytesUploaded: uploaded.totalBytes,
      projectedRequests: chunked.chunks.length,
      skippedFiles: inventory.skippedFiles,
      skippedChunks: chunked.skippedFiles
    }
  };
  pruneSessions();
  if (sessions.size >= 4) {
    const oldestId = [...sessions.values()].sort((left, right) => left.lastAccessed - right.lastAccessed)[0].id;
    sessions.delete(oldestId);
  }
  sessions.set(sessionId, session);
  return {
    sessionId,
    scanId,
    summary: session.summary,
    sourceDisclosure: {
      files: [...new Set(chunked.chunks.map((chunk) => chunk.path))],
      chunks: chunked.chunks.length,
      bytes: chunked.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.content, 'utf8'), 0)
    },
    dependencyPreview: {
      documents: dependencyInventory.documents,
      declarations: dependencyInventory.declarations,
      occurrences: dependencyInventory.occurrences,
      registryNames: dependencyInventory.lookup.registryNames,
      advisoryTuples: dependencyInventory.lookup.advisoryTuples,
      buildAvailable: dependencyInventory.buildAvailable,
      buildScript: dependencyInventory.buildScript,
      gaps: dependencyInventory.gaps,
      limits: dependencyInventory.limits,
      buildScript: typeof rootManifest?.scripts?.build === 'string' ? rootManifest.scripts.build : null,
      destinations: [
        { endpoint: 'https://registry.npmjs.org/<encoded-package-name>', method: 'GET', payload: 'Displayed direct npm package names only.' },
        { endpoint: 'https://api.osv.dev/v1/query', method: 'POST', payload: 'Displayed exact npm package name and locked version tuples only.' }
      ]
    }
  };
}

async function analyzePreparedUpload(sessionId, decisions, options = {}) {
  const session = getSession(sessionId);
  if (!session) throw appError('This upload preview expired. Select the folder again.', 404);
  if (session.analysisStarted) throw appError('This upload preview was already used. Select the folder again.');
  if (!decisions || typeof decisions.sourceApproved !== 'boolean' || typeof decisions.dependencyApproved !== 'boolean') {
    throw appError('Confirm source sharing and npm metadata sharing.');
  }
  const findings = [];
  const sourceFailures = [];
  const dependencyIdsAvailable = session.dependencyInventory.lookup.registryNames.length > 0 ||
    session.dependencyInventory.lookup.advisoryTuples.length > 0;
  if (session.chunks.length > 0 && dependencyIdsAvailable &&
      decisions.sourceApproved !== decisions.dependencyApproved) {
    throw appError('This codebase has source and npm dependencies; approve both analyses together or decline both.');
  }
  session.analysisStarted = true;
  let sourceStatus = session.chunks.length ? 'not-approved' : 'not-applicable';
  let requests = 0;
  if (decisions.sourceApproved && session.chunks.length) {
    const config = options.config ?? getFoundryConfiguration(options.env);
    sourceStatus = 'completed';
    const requestModel = options.requestFindings ?? requestFindings;
    for (const [index, rawChunk] of session.chunks.entries()) {
      const chunk = { ...rawChunk, scanId: session.scanId };
      try {
        const prompt = scanPrompt(chunk, MAX_FINDINGS_PER_REQUEST);
        const payload = await requestModel(prompt, {
          config, fetchImpl: options.fetchImpl
        });
        let validated = validateUploadedFinding(payload, chunk);
        requests += 1;

        if (validated.rejections.some((reason) => reason.includes('Text validation failed:'))) {
          try {
            requests += 1;
            const feedback = validated.rejections.filter((reason) => reason.includes('Text validation failed:')).join(' ');
            const retryPayload = await requestModel(`${prompt}\n\nValidation feedback: ${feedback} Reinspect this source chunk. For every finding, originalText must be an exact, nonempty source span and replacementText must be a different, nonempty replacement. Omit a finding if you cannot provide both exactly.`, {
              config, fetchImpl: options.fetchImpl
            });
            const retryValidation = validateUploadedFinding(retryPayload, chunk);
            const seen = new Set();
            const retryFindings = [...validated.findings, ...retryValidation.findings].filter((finding) => {
              const key = JSON.stringify([finding.path, finding.range, finding.originalText, finding.replacementText]);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            validated = { findings: retryFindings, rejections: retryValidation.rejections };
          } catch (error) {
            sourceFailures.push({ path: chunk.path, startLine: chunk.startLine,
              reason: error.statusCode ? error.message : 'The model retry failed or did not match the finding contract.' });
          }
        }
        if (validated.rejections.length) {
          sourceFailures.push({ path: chunk.path, startLine: chunk.startLine, reason: validated.rejections.join(' ') });
        }
        findings.push(...validated.findings);
      } catch (error) {
        sourceFailures.push({ path: chunk.path, startLine: chunk.startLine,
          reason: error.statusCode ? error.message : 'The model response failed or did not match the finding contract.' });
        requests += 1;
      }
      options.onProgress?.({ attempted: index + 1, total: session.chunks.length });
    }
    if (sourceFailures.length) sourceStatus = 'incomplete';
  }

  let dependencyAssessment;
  if (decisions.dependencyApproved && dependencyIdsAvailable) {
    dependencyAssessment = await assessNpmDependencies(session.dependencyInventory, { fetchImpl: options.metadataFetchImpl });
  } else {
    dependencyAssessment = {
      status: dependencyIdsAvailable ? 'not-approved' : session.dependencyInventory.documents.length ? 'not-applicable' : 'not-found',
      fingerprint: session.dependencyInventory.fingerprint,
      requests: 0,
      registry: [],
      advisories: [],
      gaps: session.dependencyInventory.gaps,
      startedAt: null,
      completedAt: null
    };
  }

  session.findings = findings;
  session.sourceFailures = sourceFailures;
  session.dependencyAssessment = dependencyAssessment;
  session.sourceStatus = sourceStatus;
  session.complete = sourceStatus === 'completed';
  session.summary = {
    ...session.summary,
    requests,
    sourceStatus,
    dependencyRequests: dependencyAssessment.requests,
    directPackages: session.dependencyInventory.declarations.length,
    lockedPackages: session.dependencyInventory.occurrences.length
  };
  session.lastAccessed = Date.now();
  return {
    sessionId: session.id,
    scanId: session.scanId,
    complete: session.complete,
    sourceStatus,
    sourceFailures,
    summary: session.summary,
    findings,
    dependencyAssessment: {
      ...dependencyAssessment,
      inventory: session.dependencyInventory
    }
  };
}

function prepareApprovedChanges(session, approvedFindingIds, allowEmpty = false) {
  if (!Array.isArray(approvedFindingIds) || (!allowEmpty && approvedFindingIds.length === 0) ||
      approvedFindingIds.length > session.findings.length || new Set(approvedFindingIds).size !== approvedFindingIds.length) {
    throw appError('Select unique findings to approve.');
  }
  const findingById = new Map(session.findings.map((finding) => [finding.id, finding]));
  const selected = approvedFindingIds.map((id) => findingById.get(id));
  if (selected.some((finding) => !finding)) throw appError('The approval included an unknown finding. Refresh the review.');

  const changesByPath = new Map();
  for (const finding of selected) {
    const originalBytes = session.files.get(finding.path);
    if (!originalBytes) throw appError('A reviewed source file is missing. Upload the folder again.');
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
    if (hashSource(originalText) !== finding.sourceHash) throw appError('A reviewed source file changed. Upload the folder again.');
    const start = offsetAt(originalText, finding.range.startLine, finding.range.startCharacter);
    const end = offsetAt(originalText, finding.range.endLine, finding.range.endCharacter);
    if (start === null || end === null || end <= start || originalText.slice(start, end) !== finding.originalText) {
      throw appError('A proposed source span no longer matches. Nothing was applied.');
    }
    const changes = changesByPath.get(finding.path) ?? [];
    changes.push({ start, end, replacementText: finding.replacementText });
    changesByPath.set(finding.path, changes);
  }

  const updatedFiles = new Map();
  for (const [relativePath, changes] of changesByPath) {
    changes.sort((left, right) => left.start - right.start);
    for (let index = 1; index < changes.length; index += 1) {
      if (changes[index].start < changes[index - 1].end) throw appError('Selected changes overlap. Choose a non-overlapping set.');
    }
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(session.files.get(relativePath));
    let updatedText = originalText;
    for (const change of [...changes].reverse()) {
      updatedText = `${updatedText.slice(0, change.start)}${change.replacementText}${updatedText.slice(change.end)}`;
    }
    updatedFiles.set(relativePath, Buffer.from(updatedText, 'utf8'));
  }

  const stagedFiles = new Map(session.files);
  for (const [relativePath, bytes] of updatedFiles) stagedFiles.set(relativePath, bytes);
  return { files: stagedFiles, selected, updatedFiles };
}

function buildChangeReport(selected, { updates = [], lockChanges = [], omittedLockChanges = 0, build = null } = {}) {
  return {
    sourceChanges: selected.map((finding) => ({
      id: finding.id,
      path: finding.path,
      symbol: finding.symbol,
      category: finding.category,
      rationale: finding.rationale,
      startLine: finding.range.startLine,
      endLine: finding.range.endLine,
      before: finding.originalText,
      after: finding.replacementText
    })),
    packageChanges: updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
    lockChanges,
    omittedLockChanges,
    build,
    tests: 'not run'
  };
}

function applyApprovedFindings(sessionId, approvedFindingIds) {
  const session = getSession(sessionId);
  if (!session) throw appError('This review expired. Upload the folder again.', 404);
  if (!['completed', 'incomplete'].includes(session.sourceStatus)) throw appError('Source analysis must be approved before applying findings.');
  if (session.applied) throw appError('This review has already been transformed.');
  const prepared = prepareApprovedChanges(session, approvedFindingIds);
  session.files = prepared.files;
  session.applied = true;
  session.lastAccessed = Date.now();
  session.appliedSummary = { findings: prepared.selected.length, files: prepared.updatedFiles.size };
  session.changeReport = buildChangeReport(prepared.selected);
  return { ...session.appliedSummary, report: session.changeReport };
}

async function prepareApprovedUpdate(sessionId, approvedFindingIds, selectedUpdateNames, options = {}) {
  const session = getSession(sessionId);
  if (!session) throw appError('This review expired. Upload the folder again.', 404);
  if (session.applied) throw appError('This review has already been transformed.');
  if (session.dependencyAssessment?.status !== 'completed') throw appError('Only a complete dependency assessment can proceed with updates.');
  if (approvedFindingIds?.length > 0 && !['completed', 'incomplete'].includes(session.sourceStatus)) {
    throw appError('Source analysis must be approved before applying findings.');
  }
  const source = prepareApprovedChanges(session, approvedFindingIds, true);
  let prepared;
  try {
    prepared = await resolveDependencyBuild(session, selectedUpdateNames, {
      ...options,
      sourceFiles: source.files,
      sourceFindings: source.selected.length
    });
  } catch (error) {
    throw appError(error.code ? `Could not prepare the selected updates: ${error.code}.` : 'Could not prepare the selected updates.');
  }
  if (prepared.status !== 'ready') throw appError(`Could not prepare the selected updates: ${prepared.reason ?? 'resolution failed'}.`);
  session.updatePreview = prepared.internalPreview;
  session.updatePreview.sourceChanges = source.selected;
  session.lastAccessed = Date.now();
  return {
    previewId: prepared.previewId,
    packageDiff: prepared.packageDiff,
    lockChanges: prepared.lockChanges,
    omittedLockChanges: prepared.omittedLockChanges,
    sourceFindings: prepared.sourceFindings,
    build: prepared.build
  };
}

async function runApprovedUpdateBuild(sessionId, previewId, options = {}) {
  const session = getSession(sessionId);
  if (!session) throw appError('This review expired. Upload the folder again.', 404);
  const preview = session.updatePreview;
  if (!preview || preview.id !== previewId || preview.consumed) throw appError('The update/build preview is missing, expired, or already used.');
  const result = await runApprovedBuild({ status: 'ready', internalPreview: preview }, options);
  if (result.status !== 'passed') {
    session.updatePreview = null;
    session.lastAccessed = Date.now();
    return result;
  }
  session.files = result.files;
  session.updatePreview = null;
  session.applied = true;
  session.lastAccessed = Date.now();
  session.appliedSummary = { findings: preview.sourceFindings, files: result.updatedFiles,
    packages: result.updates.length, buildStatus: result.status };
  session.changeReport = buildChangeReport(preview.sourceChanges ?? [], {
    updates: result.updates,
    lockChanges: preview.lockChanges,
    omittedLockChanges: preview.omittedLockChanges,
    build: { status: result.status, command: 'npm --ignore-scripts run build', output: result.output }
  });
  return { status: result.status, stage: result.stage, output: result.output, tests: result.tests,
    updates: result.updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
    summary: session.appliedSummary, report: session.changeReport };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  analyzePreparedUpload,
  applyApprovedFindings,
  getSession,
  normalizeUploadPath,
  prepareApprovedUpdate,
  prepareUpload,
  prepareUploadedFiles,
  removeSession,
  runApprovedUpdateBuild
};
