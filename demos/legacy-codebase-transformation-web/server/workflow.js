'use strict';

const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { assessProject } = require('./assess');
const { parseSource } = require('./assess/parse');
const { transformUnit } = require('./transform/agent');
const { compareRewrite } = require('./characterise/harness');
const { renderTestFile } = require('./characterise/export');
const { assessNpmDependencies, inventoryNpmFiles } = require('./dependency-review');
const { prepareDependencyBuild: resolveDependencyBuild, runApprovedBuild } = require('./dependency-build');
const { getFoundryConfiguration, requestStructured } = require('./foundry-client');

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx']);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', '.vite', '__characterisation__']);
const MAX_UPLOAD_FILES = 500;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function hashSource(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isExcludedPath(relativePath) {
  return relativePath.split('/').some((segment) => segment.startsWith('.') || EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));
}

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

function readDebtConfig(files, rootName) {
  const bytes = files.get(`${rootName}/debt.config.json`);
  if (!bytes) return {};
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw appError('The uploaded debt.config.json is not valid UTF-8 JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw appError('The uploaded debt.config.json must contain a JSON object.');
  return value;
}

function prepareUpload(manifest, uploadedFiles) {
  const uploaded = prepareUploadedFiles(manifest, uploadedFiles);
  const inventory = sourceInventory(uploaded.files);
  const dependencyInventory = inventoryNpmFiles(uploaded.files, uploaded.rootName);
  const rootManifest = dependencyInventory.rootManifest ?
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(uploaded.files.get(dependencyInventory.rootManifest))) : null;
  if (inventory.sourceFiles.length === 0 && dependencyInventory.documents.length === 0) {
    throw appError('No supported source files or npm manifests/lockfiles were found.');
  }
  const debtConfig = readDebtConfig(uploaded.files, uploaded.rootName);
  const assessment = assessProject(inventory.sourceFiles, debtConfig);

  const scanId = randomUUID();
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    scanId,
    rootName: uploaded.rootName,
    files: uploaded.files,
    sourceFiles: inventory.sourceFiles,
    debtConfig,
    assessment,
    initialAssessment: assessment,
    dependencyInventory,
    proposals: [],
    dependencyAssessment: null,
    applied: false,
    transformStarted: false,
    progress: { stage: 'assessment-complete', completed: 0, total: 0, unitId: null },
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    summary: {
      filesUploaded: uploaded.files.size,
      sourceFiles: inventory.sourceFiles.length,
      bytesUploaded: uploaded.totalBytes,
      skippedFiles: inventory.skippedFiles,
      rating: assessment.rating,
      debtMinutes: assessment.debtMinutes,
      findingCount: assessment.findingCount,
      parseGaps: assessment.gaps.length
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
    assessment,
    dependencyPreview: {
      documents: dependencyInventory.documents,
      declarations: dependencyInventory.declarations,
      occurrences: dependencyInventory.occurrences,
      registryNames: dependencyInventory.lookup.registryNames,
      advisoryTuples: dependencyInventory.lookup.advisoryTuples,
      buildAvailable: dependencyInventory.buildAvailable,
      buildScript: typeof rootManifest?.scripts?.build === 'string' ? rootManifest.scripts.build : null,
      gaps: dependencyInventory.gaps,
      limits: dependencyInventory.limits,
      destinations: [
        { endpoint: 'https://registry.npmjs.org/<encoded-package-name>', method: 'GET', payload: 'Displayed direct npm package names only.' },
        { endpoint: 'https://api.osv.dev/v1/query', method: 'POST', payload: 'Displayed exact npm package name and locked version tuples only.' }
      ]
    }
  };
}

function getTransformProgress(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw appError('This upload preview expired. Select the folder again.', 404);
  return { ...session.progress };
}

function safeTransformFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const safePrefixes = [
    'Foundry returned HTTP ', 'Foundry refused ', 'Foundry request timed out',
    'The Foundry response ', 'The Foundry request ', 'Could not complete the Foundry ',
    'Set FOUNDRY_', 'Each characterisation ', 'Characterisation inputs ',
    'Foundry must ', 'A valid structured-output ', 'The selected function '
  ];
  return safePrefixes.some((prefix) => message.startsWith(prefix)) ? message : 'Foundry or characterisation processing failed.';
}

async function transformUnits(sessionId, input, options = {}) {
  const session = getSession(sessionId);
  if (!session) throw appError('This upload preview expired. Select the folder again.', 404);
  if (session.transformStarted) throw appError('This upload preview was already used. Select the folder again.');
  if (!input || input.approved !== true || !Array.isArray(input.unitIds) || input.unitIds.length === 0 ||
      input.unitIds.length > 5 || new Set(input.unitIds).size !== input.unitIds.length) {
    throw appError('Approve and select between one and five unique transformation units.');
  }
  const unitsById = new Map(session.assessment.units.map((unit) => [unit.id, unit]));
  const selected = [];
  const selectedIds = new Set();
  for (const id of input.unitIds) {
    const unit = unitsById.get(id);
    if (!unit) throw appError('A selected transformation unit is stale. Refresh the assessment.');
    if (unit.kind === 'file') {
      const functions = session.assessment.units.filter((candidate) => candidate.kind === 'function' && candidate.path === unit.path);
      if (!functions.length) throw appError('The selected long-file finding has no function units to transform.');
      for (const candidate of functions) if (!selectedIds.has(candidate.id)) { selected.push(candidate); selectedIds.add(candidate.id); }
    } else if (unit.kind === 'function' || unit.kind === 'statement') {
      if (!selectedIds.has(unit.id)) { selected.push(unit); selectedIds.add(unit.id); }
    } else throw appError('The selected unit cannot be transformed.');
  }
  if (selected.length > 5) throw appError('Selecting the long-file finding expands beyond the five-unit limit. Select fewer units.');
  if (input.findingIds !== undefined) {
    if (!Array.isArray(input.findingIds) || input.findingIds.some((id) => typeof id !== 'string')) throw appError('Approved findings must be a list of finding IDs.');
    const approved = new Set(input.findingIds);
    for (const [index, unit] of selected.entries()) {
      if (!input.unitIds.includes(unit.id)) continue;
      const findings = unit.findings.filter((item) => approved.has(item.id));
      if (!findings.length) throw appError(`Approve at least one finding for ${unit.name}, or deselect it.`);
      selected[index] = { ...unit, findings };
    }
  }
  const config = options.config ?? getFoundryConfiguration(options.env);
  session.transformStarted = true;
  session.progress = { stage: 'dependency-assessment', completed: 0, total: selected.length, unitId: null };

  const dependencyIdsAvailable = session.dependencyInventory.lookup.registryNames.length > 0 ||
    session.dependencyInventory.lookup.advisoryTuples.length > 0;
  let dependencyAssessment;
  if (input.checkDependencies === true && dependencyIdsAvailable) {
    dependencyAssessment = await assessNpmDependencies(session.dependencyInventory, { fetchImpl: options.metadataFetchImpl });
  } else {
    dependencyAssessment = {
      status: input.checkDependencies !== true ? 'skipped' : session.dependencyInventory.documents.length ? 'not-applicable' : 'not-found',
      fingerprint: session.dependencyInventory.fingerprint,
      requests: 0, registry: [], advisories: [], gaps: session.dependencyInventory.gaps,
      startedAt: null, completedAt: null
    };
  }

  session.dependencyAssessment = dependencyAssessment;
  session.proposals = [];
  for (const [index, unit] of selected.entries()) {
    const sourceFile = session.sourceFiles.find((item) => item.path === unit.path);
    session.progress = { stage: 'unit-start', completed: index, total: selected.length, unitId: unit.id };
    options.onProgress?.({ ...session.progress });
    const targetFindings = unit.findings.map(({ id, ruleId, severity, line, column, message }) => ({ id, ruleId, severity, line, column, message }));
    try {
      const proposal = await (options.transformUnit ?? transformUnit)({
        unit, source: sourceFile.content, sourceFiles: session.sourceFiles, files: session.files,
        rootName: session.rootName, assessment: session.assessment, config: session.debtConfig
      }, {
        requestStructured: options.requestStructured,
        foundryOptions: { config, fetchImpl: options.fetchImpl },
        characterisationOptions: { runCommand: options.runCharacterisationCommand },
        onProgress: (progress) => {
          session.progress = { ...progress, completed: index, total: selected.length, unitId: unit.id };
          options.onProgress?.({ ...session.progress });
        }
      });
      const testPreview = proposal.baseline?.status === 'passed'
        ? { path: testArtifactPath(session.rootName, unit), content: renderTestFile({ unit, rootName: session.rootName, baseline: proposal.baseline }) }
        : null;
      session.proposals.push({ ...proposal, id: randomUUID(), unit, testPreview, targetFindings });
    } catch (error) {
      session.proposals.push({ id: randomUUID(), unitId: unit.id, path: unit.path, name: unit.name,
        originalText: unit.originalText, status: 'failed', attempts: 0, gates: [], baseline: { status: 'not-checked' },
        targetFindings, reason: safeTransformFailure(error) });
    }
    session.progress = { stage: 'unit-complete', completed: index + 1, total: selected.length, unitId: unit.id };
    options.onProgress?.({ ...session.progress });
  }

  session.complete = true;
  session.summary = {
    ...session.summary,
    transformedUnits: selected.length,
    completedProposals: session.proposals.filter((proposal) => proposal.status === 'ready').length,
    rejectedProposals: session.proposals.filter((proposal) => proposal.status !== 'ready').length,
    dependencyRequests: dependencyAssessment.requests,
    directPackages: session.dependencyInventory.declarations.length,
    lockedPackages: session.dependencyInventory.occurrences.length
  };
  session.progress = { stage: 'complete', completed: selected.length, total: selected.length, unitId: null };
  session.lastAccessed = Date.now();
  return {
    sessionId: session.id,
    scanId: session.scanId,
    complete: session.complete,
    summary: session.summary,
    proposals: session.proposals.map(({ unit, ...proposal }) => proposal),
    sourceDisclosure: {
      units: selected.map(({ id, path: unitPath, name, originalText }) => ({ id, path: unitPath, name,
        bytes: Buffer.byteLength(originalText, 'utf8') })),
      bytes: selected.reduce((total, unit) => total + Buffer.byteLength(unit.originalText, 'utf8'), 0)
    },
    dependencyAssessment: {
      ...dependencyAssessment,
      inventory: session.dependencyInventory
    }
  };
}

function testArtifactPath(rootName, unit) {
  const relative = path.posix.relative(rootName, unit.path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._/-]/g, '_');
  const symbol = unit.name.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${rootName}/__characterisation__/${relative.replaceAll('/', '.')}.${symbol}.test.js`;
}

async function prepareApprovedChanges(session, proposalIds, acknowledgedWarningIds = [], allowEmpty = false, options = {}) {
  if (!Array.isArray(proposalIds) || (!allowEmpty && proposalIds.length === 0) ||
      proposalIds.length > session.proposals.length || new Set(proposalIds).size !== proposalIds.length ||
      !Array.isArray(acknowledgedWarningIds) || new Set(acknowledgedWarningIds).size !== acknowledgedWarningIds.length) {
    throw appError('Select unique proposals and warning acknowledgements.');
  }
  const byId = new Map(session.proposals.map((proposal) => [proposal.id, proposal]));
  const selected = proposalIds.map((id) => byId.get(id));
  if (selected.some((proposal) => !proposal)) throw appError('The approval included an unknown proposal. Refresh the review.');
  for (const proposal of selected) {
    if (proposal.status !== 'ready') throw appError('Only proposals that passed the static gates can be applied.');
    const failedGate = proposal.gates?.find((item) => item.status === 'fail');
    if (failedGate) throw appError('A proposal with a failed gate cannot be applied.');
    if (proposal.warningAcknowledgementRequired && !acknowledgedWarningIds.includes(proposal.id)) {
      throw appError('Acknowledge every not-checked proposal before applying it.');
    }
  }
  if (acknowledgedWarningIds.some((id) => !selected.some((proposal) => proposal.id === id))) {
    throw appError('A warning acknowledgement does not match a selected proposal.');
  }

  const changesByPath = new Map();
  for (const proposal of selected) {
    const unit = proposal.unit;
    const originalBytes = session.files.get(proposal.path);
    if (!originalBytes) throw appError('A reviewed source file is missing. Upload the folder again.');
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
    if (hashSource(originalText) !== unit.sourceHash) throw appError('A reviewed source file changed. Upload the folder again.');
    if (unit.start < 0 || unit.end <= unit.start || originalText.slice(unit.start, unit.end) !== proposal.originalText) {
      throw appError('A proposed source span no longer matches. Nothing was applied.');
    }
    const changes = changesByPath.get(proposal.path) ?? [];
    changes.push({ start: unit.start, end: unit.end, replacementText: proposal.replacementText });
    changesByPath.set(proposal.path, changes);
  }

  const updatedFiles = new Map();
  for (const [relativePath, changes] of changesByPath) {
    changes.sort((left, right) => left.start - right.start);
    for (let index = 1; index < changes.length; index += 1) {
      if (changes[index].start < changes[index - 1].end) throw appError('Selected proposals overlap. Choose a non-overlapping set.');
    }
    const originalText = new TextDecoder('utf-8', { fatal: true }).decode(session.files.get(relativePath));
    let updatedText = originalText;
    for (const change of [...changes].reverse()) {
      updatedText = `${updatedText.slice(0, change.start)}${change.replacementText}${updatedText.slice(change.end)}`;
    }
    const parsed = parseSource(updatedText, relativePath);
    if (!parsed.ast) throw appError(`${relativePath}: The combined source changes do not parse. Nothing was applied.`);
    updatedFiles.set(relativePath, Buffer.from(updatedText, 'utf8'));
  }

  const stagedFiles = new Map(session.files);
  for (const [relativePath, bytes] of updatedFiles) stagedFiles.set(relativePath, bytes);
  const compare = options.compareRewrite ?? compareRewrite;
  const testFiles = new Map();
  for (const proposal of selected) {
    if (proposal.baseline?.status !== 'passed') continue;
    const combined = await compare(stagedFiles, session.rootName, proposal.unit, proposal.baseline, {
      runCommand: options.runCharacterisationCommand
    });
    if (combined.status !== 'passed') throw appError(`Combined selected changes did not preserve ${proposal.name} characterisation. Nothing was applied.`);
    const testPath = testArtifactPath(session.rootName, proposal.unit);
    if (testFiles.has(testPath)) throw appError('Characterisation test output paths collided. Nothing was applied.');
    testFiles.set(testPath, Buffer.from(renderTestFile({ unit: proposal.unit, rootName: session.rootName, baseline: proposal.baseline }), 'utf8'));
  }
  for (const [testPath, bytes] of testFiles) stagedFiles.set(testPath, bytes);

  const stagedSourceFiles = sourceInventory(stagedFiles).sourceFiles;
  const afterAssessment = assessProject(stagedSourceFiles, session.debtConfig);
  return { files: stagedFiles, selected, updatedFiles, testFiles, sourceFiles: stagedSourceFiles, afterAssessment };
}

function characterisationTestPaths(files) {
  return [...files.keys()].filter((key) => key.includes('/__characterisation__/') && key.endsWith('.test.js')).sort();
}

function buildChangeReport(selected, { beforeAssessment, afterAssessment, updates = [], lockChanges = [], omittedLockChanges = 0, build = null, testFiles = [] } = {}) {
  return {
    before: beforeAssessment ? { rating: beforeAssessment.rating, debtMinutes: beforeAssessment.debtMinutes, debtHours: beforeAssessment.debtHours } : null,
    after: afterAssessment ? { rating: afterAssessment.rating, debtMinutes: afterAssessment.debtMinutes, debtHours: afterAssessment.debtHours } : null,
    sourceChanges: selected.map((proposal) => ({
      id: proposal.id,
      path: proposal.path,
      symbol: proposal.name,
      category: [...new Set(proposal.unit.findings.map((item) => item.ruleId))].join(', '),
      rationale: proposal.rationale,
      startLine: proposal.unit.startLine,
      endLine: proposal.unit.endLine,
      before: proposal.originalText,
      after: proposal.replacementText,
      gates: proposal.gates,
      baseline: proposal.baseline,
      comparison: proposal.comparison,
      residualFindings: proposal.residualFindings
    })),
    packageChanges: updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
    lockChanges,
    omittedLockChanges,
    build,
    testFiles,
    tests: selected.some((proposal) => proposal.baseline?.status === 'passed') ? 'characterisation tests exported; project tests not run' : 'not run'
  };
}

async function applyApprovedFindings(sessionId, proposalIds, acknowledgedWarningIds = [], options = {}) {
  const session = getSession(sessionId);
  if (!session) throw appError('This review expired. Upload the folder again.', 404);
  if (!session.complete) throw appError('Selected-unit transformation must complete before applying proposals.');
  if (session.applied) throw appError('This review has already been transformed.');
  const prepared = await prepareApprovedChanges(session, proposalIds, acknowledgedWarningIds, false, options);
  const beforeAssessment = session.assessment;
  session.files = prepared.files;
  session.sourceFiles = prepared.sourceFiles;
  session.assessment = prepared.afterAssessment;
  session.applied = true;
  session.lastAccessed = Date.now();
  session.appliedSummary = { proposals: prepared.selected.length, files: prepared.updatedFiles.size, testFiles: prepared.testFiles.size };
  session.changeReport = buildChangeReport(prepared.selected, { beforeAssessment, afterAssessment: prepared.afterAssessment,
    testFiles: characterisationTestPaths(session.files) });
  return { ...session.appliedSummary, report: session.changeReport };
}

async function prepareApprovedUpdate(sessionId, proposalIds, selectedUpdateNames, acknowledgedWarningIds = [], options = {}) {
  const session = getSession(sessionId);
  if (!session) throw appError('This review expired. Upload the folder again.', 404);
  if (session.applied) throw appError('This review has already been transformed.');
  if (session.dependencyAssessment?.status !== 'completed') throw appError('Only a complete dependency assessment can proceed with updates.');
  if (!session.complete) throw appError('Selected-unit transformation must complete before preparing dependency updates.');
  const source = await prepareApprovedChanges(session, proposalIds, acknowledgedWarningIds, true, options);
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
  session.updatePreview.sourceAssessmentBefore = session.initialAssessment;
  session.updatePreview.sourceAssessmentAfter = source.afterAssessment;
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

async function replayAfterUpdate(session, proposals, files, options = {}) {
  const compare = options.compareRewrite ?? compareRewrite;
  const results = [];
  for (const proposal of proposals) {
    if (proposal.baseline?.status !== 'passed') continue;
    const comparison = await compare(files, session.rootName, proposal.unit, proposal.baseline, { runCommand: options.runCharacterisationCommand });
    const cases = comparison.cases ?? [];
    results.push({ name: proposal.name, status: comparison.status, reason: comparison.reason ?? null,
      matched: cases.filter((item) => item.passed).length, total: cases.length });
  }
  const failed = results.filter((item) => item.status !== 'passed');
  return { status: failed.length ? 'failed' : results.length ? 'passed' : 'not-run', results };
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
  const characterisation = await replayAfterUpdate(session, preview.sourceChanges ?? [], result.files, options);
  if (characterisation.status === 'failed') {
    session.updatePreview = null;
    session.lastAccessed = Date.now();
    const drifted = characterisation.results.filter((item) => item.status !== 'passed');
    return { status: 'failed', stage: 'characterisation',
      reason: `Behaviour changed after the dependency update for ${drifted.map((item) => item.name).join(', ')}. Nothing was applied.`,
      output: drifted.map((item) => `${item.name}: ${item.total ? `${item.matched} of ${item.total} cases matched` : item.reason ?? item.status}`).join('\n'),
      characterisation };
  }
  session.files = result.files;
  session.sourceFiles = sourceInventory(session.files).sourceFiles;
  session.assessment = assessProject(session.sourceFiles, session.debtConfig);
  session.updatePreview = null;
  session.applied = true;
  session.lastAccessed = Date.now();
  session.appliedSummary = { findings: preview.sourceFindings, files: result.updatedFiles,
    packages: result.updates.length, buildStatus: result.status, testFiles: characterisationTestPaths(session.files).length };
  session.changeReport = buildChangeReport(preview.sourceChanges ?? [], {
    testFiles: characterisationTestPaths(session.files),
    beforeAssessment: preview.sourceAssessmentBefore,
    afterAssessment: session.assessment,
    updates: result.updates,
    lockChanges: preview.lockChanges,
    omittedLockChanges: preview.omittedLockChanges,
    build: { status: result.status, command: 'npm --ignore-scripts run build', output: result.output, characterisation }
  });
  return { status: result.status, stage: result.stage, output: result.output, tests: result.tests, characterisation,
    updates: result.updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
    summary: session.appliedSummary, report: session.changeReport };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  applyApprovedFindings,
  getSession,
  getTransformProgress,
  normalizeUploadPath,
  prepareApprovedUpdate,
  prepareUpload,
  prepareUploadedFiles,
  removeSession,
  replayAfterUpdate,
  safeTransformFailure,
  transformUnits,
  runApprovedUpdateBuild
};
