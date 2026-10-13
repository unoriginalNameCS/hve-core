'use strict';

const { randomUUID } = require('node:crypto');
const { FindingStore } = require('./finding-store');
const { MAX_FINDINGS_PER_REQUEST, MAX_MODEL_REQUESTS, prepareWorkspaceScan, scanWorkspace } = require('./scan-pipeline');
const { selectLanguageModel } = require('./model-selection');
const { applyProposal, applyProposalBatch, generateProposal, prepareApplyProposal, prepareApplyProposalBatch, prepareApplyFindings, prepareProposalRequest, ProposalStore } = require('./proposal-workflow');
const { renderScanReport, writeScanReport } = require('./scan-report');
const { prepareBehaviorCheck, runBehaviorCheck } = require('./behavior-check');
const { inventoryDependencies } = require('./dependency-inventory');
const { assessDependencies } = require('./dependency-assessment');
const { renderDependencyReport, writeDependencyReport } = require('./dependency-report');
const { MAX_OUTPUT_BYTES, MAX_RESOLUTION_MS, MAX_UPDATES, applyDependencyUpdate, prepareDependencyUpdate, resolveDependencyUpdate, showDependencyDiff } = require('./dependency-updates');

const SCAN_TOOL = 'legacy_codebase_transformation_demo_scan_workspace';
const REVIEW_TOOL = 'legacy_codebase_transformation_demo_review_findings';
const PROPOSAL_TOOL = 'legacy_codebase_transformation_demo_generate_proposal';
const APPLY_TOOL = 'legacy_codebase_transformation_demo_apply_proposal';
const BEHAVIOR_TOOL = 'legacy_codebase_transformation_demo_check_behavior';
const DEPENDENCY_TOOL = 'legacy_codebase_transformation_demo_assess_dependencies';
const DEPENDENCY_UPDATE_TOOL = 'legacy_codebase_transformation_demo_update_dependencies';
const TRANSFORM_TOOL = 'legacy_codebase_transformation_demo_transform_codebase';
const PREVIEW_TTL_MS = 5 * 60 * 1000;

function issuePreview(previews, value) {
  const now = Date.now();
  for (const [id, preview] of previews) {
    if (now - preview.createdAt > PREVIEW_TTL_MS) previews.delete(id);
  }
  const previewId = randomUUID();
  previews.set(previewId, { ...value, createdAt: now });
  return previewId;
}

function consumePreview(previews, previewId) {
  const preview = previews.get(previewId);
  previews.delete(previewId);
  return preview && Date.now() - preview.createdAt <= PREVIEW_TTL_MS ? preview : null;
}

function toolResult(vscode, value) {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);
}

function dependencyDisclosure(snapshot) {
  return {
    root: snapshot.projectRoot, fingerprint: snapshot.fingerprint,
    documents: snapshot.documents, coverage: snapshot.coverage,
    registryNames: snapshot.lookup.registryNames, advisoryTuples: snapshot.lookup.advisoryTuples,
    gaps: snapshot.gaps.slice(0, 200), omittedGapDetails: Math.max(0, snapshot.gaps.length - 200),
    destinations: [
      { endpoint: 'https://registry.npmjs.org/<encoded-package-name>', method: 'GET',
        payload: 'Each listed registry name; abbreviated public package metadata only.' },
      { endpoint: 'https://api.osv.dev/v1/query', method: 'POST',
        payload: 'Each listed exact tuple as {package:{name,ecosystem:"npm"},version}; page_token only for pagination.' }
    ],
    limits: snapshot.limits,
    warning: 'Names and versions reveal project metadata. Unknown origins may be internal packages; approve only identifiers you authorize for public lookup. Full files, source and credentials are not sent.'
  };
}

async function checkDependencySnapshot(vscode, result) {
  try {
    const current = await inventoryDependencies(vscode, result.projectRoot);
    result.currentSnapshot = current.fingerprint === result.fingerprint;
  } catch { result.currentSnapshot = false; }
  if (!result.currentSnapshot) {
    result.status = 'stale';
    result.gaps.push({ source: 'snapshot', reason: 'Inputs changed or became dirty; evidence covers only the approved historical snapshot.' });
  }
}

class ScanWorkspaceTool {
  constructor(vscode, store, options = {}) {
    this.vscode = vscode;
    this.store = store;
    this.options = options;
    this.selectModel = options.selectLanguageModel ?? selectLanguageModel;
    this.previews = new Map();
    this.session = null;
    this.revision = 0;
    this.running = false;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).some((key) => !['phase', 'projectRoot', 'scanId', 'includeDependencies', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'confirm'].includes(input.phase) ||
        (input.phase === 'prepare' && (typeof input.projectRoot !== 'string' || !input.projectRoot.trim() ||
          (input.scanId !== undefined && (typeof input.scanId !== 'string' || !input.scanId)) ||
          (input.includeDependencies !== undefined && typeof input.includeDependencies !== 'boolean') ||
          input.previewId !== undefined || input.decision !== undefined)) ||
        (input.phase === 'confirm' && (typeof input.previewId !== 'string' || !['approve', 'reject'].includes(input.decision) ||
          input.projectRoot !== undefined || input.scanId !== undefined || input.includeDependencies !== undefined))) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Prepare a scan with an absolute projectRoot, then confirm a current previewId with approve or reject.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy', reason: 'A scan batch is already running.' });
    let stage = 'model selection';
    let ownsRun = false;
    let dependencyRequests = 0;
    try {
      if (input.phase === 'prepare') {
        const revision = this.revision;
        const previous = input.scanId ? this.session?.result : null;
        if (input.scanId && (!previous || previous.scanId !== input.scanId || !previous.canContinue)) {
          return toolResult(this.vscode, { status: 'rejected', reason: 'Only the current session scan with remaining chunks can continue. Otherwise prepare a fresh scan.' });
        }
        const model = previous ? this.session.model :
          await this.selectModel(this.vscode, 'Select the model and destination for this source scan');
        if (!model || token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled' });
        stage = 'scan preview';
        const prepared = await prepareWorkspaceScan(this.vscode, input.projectRoot, token);
        if (prepared.status !== 'ready') return toolResult(this.vscode, prepared);
        const includeDependencies = input.includeDependencies ?? (previous ? this.session.includeDependencies : false);
        stage = 'dependency preview';
        const dependencySnapshot = includeDependencies ?
          await inventoryDependencies(this.vscode, prepared.inventory.root.realPath, token) : null;
        if (revision !== this.revision || this.running || (previous && previous.fingerprint !== prepared.fingerprint)) {
          return toolResult(this.vscode, { status: 'stale', reason: 'The scan session or source changed. Prepare a fresh scan.' });
        }
        const remainingChunks = prepared.chunks.length - (previous?.nextChunk ?? 0);
        const previewId = issuePreview(this.previews, {
          projectRoot: prepared.inventory.root.realPath, model, fingerprint: prepared.fingerprint,
          previousResult: previous, revision, dependencySnapshot
        });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', previewId, root: prepared.inventory.root.realPath,
          includeDependencies, dependencies: dependencySnapshot ? dependencyDisclosure(dependencySnapshot) : undefined,
          requests: 0, dependencyRequests: 0,
          approvalScope: includeDependencies ? 'Approve both the displayed source transfer and exact npm/OSV metadata transfers, or reject this combined preview. No writes or project commands are authorized.' : 'Source transfer only.',
          files: prepared.inventory.files.length, bytes: prepared.inventory.bytes,
          projectedRequests: prepared.chunks.length, remainingChunks,
          batchRequests: Math.min(MAX_MODEL_REQUESTS, remainingChunks),
          batchSourceBytes: prepared.chunks.slice(previous?.nextChunk ?? 0,
            (previous?.nextChunk ?? 0) + MAX_MODEL_REQUESTS).reduce((total, chunk) => total + Buffer.byteLength(chunk.content, 'utf8'), 0),
          scanId: previous?.scanId ?? null, unsupportedFiles: prepared.inventory.unsupportedFiles.length,
          model: model.name ?? model.family ?? model.id ?? 'selected model',
          destination: `${model.vendor ?? 'unknown vendor'}${model.id ? ` / ${model.id}` : ''}`,
          limits: { requestsPerBatch: MAX_MODEL_REQUESTS, findingsPerRequest: MAX_FINDINGS_PER_REQUEST, requestBytes: 256 * 1024 },
          expiresInSeconds: PREVIEW_TTL_MS / 1000
        });
      }
      const preview = consumePreview(this.previews, input.previewId);
      if (!preview) {
        return toolResult(this.vscode, { status: 'rejected', reason: 'The scan preview is missing, expired, or already used. Prepare a new scan.' });
      }
      if (input.decision !== 'approve' || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'cancelled', previewId: input.previewId, requests: 0, dependencyRequests: 0 });
      }
      if (preview.revision !== this.revision) {
        return toolResult(this.vscode, { status: 'stale', requests: 0, reason: 'Another batch advanced the scan session. Prepare a new preview.' });
      }
      this.running = true;
      ownsRun = true;
      if (preview.dependencySnapshot) {
        stage = 'dependency snapshot validation';
        try {
          const current = await inventoryDependencies(this.vscode, preview.projectRoot, token);
          if (current.fingerprint !== preview.dependencySnapshot.fingerprint) throw new Error('Changed snapshot.');
        } catch {
          return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'stale',
            requests: 0, dependencyRequests: 0, reason: 'Dependency inputs changed or became unavailable. Prepare a fresh combined preview.' });
        }
      }
      stage = 'source scan';
      const execute = (progress) => scanWorkspace(this.vscode, preview.projectRoot, preview.model, token,
        { ...this.options, chatApproved: true, expectedFingerprint: preview.fingerprint,
          previousResult: preview.previousResult,
          onProgress: (coverage) => progress?.report({
            message: `${coverage.attemptedChunks}/${coverage.totalChunks} chunks attempted; ${coverage.findings} findings`
          }) });
      const result = typeof this.vscode.window?.withProgress === 'function' ?
        await this.vscode.window.withProgress({ location: this.vscode.ProgressLocation.Notification,
          title: 'Legacy codebase scan', cancellable: false }, execute) : await execute();
      if (result.status === 'stale' || !Number.isInteger(result.nextChunk)) return toolResult(this.vscode, result);
      this.session = { result, model: preview.model, includeDependencies: Boolean(preview.dependencySnapshot) };
      this.revision += 1;
      this.store.addScan(result);
      if (preview.dependencySnapshot) {
        result.sourceStatus = result.status;
        stage = 'dependency snapshot validation';
        let dependencyToken = token;
        try {
          const current = await inventoryDependencies(this.vscode, preview.projectRoot, token);
          if (current.fingerprint !== preview.dependencySnapshot.fingerprint) dependencyToken = { isCancellationRequested: true };
        } catch { dependencyToken = { isCancellationRequested: true }; }
        stage = 'dependency metadata lookup';
        result.dependencies = await assessDependencies(preview.dependencySnapshot, dependencyToken, this.options);
        dependencyRequests = result.dependencies.requests;
        await checkDependencySnapshot(this.vscode, result.dependencies);
        try {
          result.sourceSnapshotCurrent = (await prepareWorkspaceScan(this.vscode, preview.projectRoot)).fingerprint === preview.fingerprint;
        } catch { result.sourceSnapshotCurrent = false; }
        if (result.status === 'completed' && (!result.sourceSnapshotCurrent ||
            !['completed', 'not-applicable'].includes(result.dependencies.status))) result.status = 'incomplete';
        result.incomplete ||= !result.sourceSnapshotCurrent || !['completed', 'not-applicable'].includes(result.dependencies.status);
      }
      stage = 'report creation';
      const report = renderScanReport({ ...result, findings: this.store.list() });
      const reportPath = result.dependencies ?
        await writeDependencyReport(this.options.reportDirectory, randomUUID(), report, result.root, 'codebase-review') :
        await writeScanReport(this.options.reportDirectory, result.scanId, report, result.batchNumber);
      stage = 'report opening';
      let reportOpened = true;
      try {
        await this.vscode.window.showTextDocument(
          await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(reportPath)), { preview: false });
      } catch {
        reportOpened = false;
      }
      return toolResult(this.vscode, {
        status: result.status, scanId: result.scanId, root: result.root,
        sourceStatus: result.sourceStatus ?? result.status, sourceSnapshotCurrent: result.sourceSnapshotCurrent,
        dependencyStatus: result.dependencies?.status, dependencyRequests,
        currentDependencySnapshot: result.dependencies?.currentSnapshot,
        files: result.files, bytes: result.bytes, projectedRequests: result.projectedRequests,
        requests: result.requests, skipped: result.skipped, rejected: result.rejected,
        batchRequests: result.batchRequests, batchNumber: result.batchNumber,
        filesReviewed: result.filesReviewed, chunksReviewed: result.reviewedChunks.length,
        remainingChunks: result.remainingChunks, canContinue: result.canContinue,
        unsupportedFiles: result.unsupportedFiles.length,
        incomplete: result.incomplete, findingCount: result.findings.length, reportPath, reportOpened
      });
    } catch {
      return toolResult(this.vscode, { status: 'failed', stage, scanId: this.session?.result.scanId ?? null,
        dependencyRequests: stage === 'dependency metadata lookup' ? null : dependencyRequests,
        canContinue: this.session?.result.canContinue ?? false,
        reason: 'Scan or report creation failed. Verify the opened root, model availability, chat preview, and extension storage; project source was not changed.' });
    } finally {
      if (ownsRun) this.running = false;
    }
  }
}

class GenerateProposalTool {
  constructor(vscode, findingStore, proposalStore, options = {}) {
    this.vscode = vscode;
    this.findingStore = findingStore;
    this.proposalStore = proposalStore;
    this.options = options;
    this.selectModel = options.selectLanguageModel ?? selectLanguageModel;
    this.previews = new Map();
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).some((key) => !['phase', 'findingId', 'changeRequest', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'confirm'].includes(input.phase) ||
        (input.phase === 'prepare' && (typeof input.findingId !== 'string' || input.previewId !== undefined || input.decision !== undefined ||
          (input.changeRequest !== undefined && typeof input.changeRequest !== 'string'))) ||
        (input.phase === 'confirm' && (typeof input.previewId !== 'string' || !['approve', 'reject'].includes(input.decision) ||
          input.findingId !== undefined || input.changeRequest !== undefined))) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Prepare with an approved findingId, then confirm a current previewId with approve or reject.' });
    }
    try {
      if (input.phase === 'prepare') {
        if (!this.findingStore.getApproved(input.findingId)) {
          return toolResult(this.vscode, { status: 'rejected', reason: 'Only a current finding explicitly approved in chat can be proposed.' });
        }
        const model = await this.selectModel(this.vscode, 'Select the model and destination for this proposal');
        if (!model || token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled' });
        const prepared = await prepareProposalRequest(this.vscode, this.findingStore, input.findingId, model, input.changeRequest);
        if (prepared.status !== 'ready') return toolResult(this.vscode, prepared);
        const previewId = issuePreview(this.previews, {
          findingId: input.findingId, changeRequest: input.changeRequest, model, fingerprint: prepared.fingerprint
        });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', previewId, ...prepared.preview,
          model: model.name ?? model.family ?? model.id ?? 'selected model',
          destination: `${model.vendor ?? 'unknown vendor'}${model.id ? ` / ${model.id}` : ''}`,
          expiresInSeconds: PREVIEW_TTL_MS / 1000,
          note: 'Approval permits proposal drafting only. It does not authorize a source write.'
        });
      }
      const preview = consumePreview(this.previews, input.previewId);
      if (!preview) return toolResult(this.vscode, { status: 'rejected', reason: 'The proposal preview is missing, expired, or already used. Prepare it again.' });
      if (input.decision !== 'approve' || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'cancelled', previewId: input.previewId, requests: 0 });
      }
      return toolResult(this.vscode, await generateProposal(this.vscode, this.findingStore, this.proposalStore,
        preview.findingId, preview.model, preview.changeRequest, token,
        { ...this.options, chatApproved: true, expectedFingerprint: preview.fingerprint }));
    } catch {
      return toolResult(this.vscode, { status: 'failed', reason: 'Proposal generation failed. Refresh the finding and verify the saved source and chat preview.' });
    }
  }
}

class ApplyProposalTool {
  constructor(vscode, findingStore, proposalStore) {
    this.vscode = vscode;
    this.findingStore = findingStore;
    this.proposalStore = proposalStore;
    this.previews = new Map();
    this.running = false;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).some((key) => !['phase', 'proposalId', 'proposalIds', 'findingIds', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'confirm'].includes(input.phase) ||
        (input.phase === 'prepare' && ([input.proposalId, input.proposalIds, input.findingIds].filter((value) => value !== undefined).length !== 1 ||
          (input.proposalId !== undefined && (typeof input.proposalId !== 'string' || !input.proposalId)) ||
          (input.findingIds !== undefined && (!Array.isArray(input.findingIds) || input.findingIds.length < 1 ||
            input.findingIds.length > 30 || input.findingIds.some((id) => typeof id !== 'string' || !id.trim()) ||
            new Set(input.findingIds).size !== input.findingIds.length)) ||
          (input.proposalIds !== undefined && (!Array.isArray(input.proposalIds) || input.proposalIds.length < 1 ||
            input.proposalIds.length > 30 || input.proposalIds.some((id) => typeof id !== 'string' || !id) ||
            new Set(input.proposalIds).size !== input.proposalIds.length)) ||
          input.previewId !== undefined || input.decision !== undefined)) ||
        (input.phase === 'confirm' && (typeof input.previewId !== 'string' || !['approve', 'reject'].includes(input.decision) ||
            input.proposalId !== undefined || input.proposalIds !== undefined || input.findingIds !== undefined))) {
          return toolResult(this.vscode, { status: 'rejected', reason: 'Prepare exactly one of findingIds, proposalId, or proposalIds, then confirm its current previewId with approve or reject.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy', reason: 'An approved file edit is already running.' });
    let ownsRun = false;
    try {
      if (input.phase === 'prepare') {
        const prepared = input.findingIds ?
          await prepareApplyFindings(this.vscode, this.findingStore, this.proposalStore, input.findingIds) : input.proposalIds ?
          await prepareApplyProposalBatch(this.vscode, this.findingStore, this.proposalStore, input.proposalIds) :
          await prepareApplyProposal(this.vscode, this.findingStore, this.proposalStore, input.proposalId);
        if (prepared.status !== 'ready') return toolResult(this.vscode, prepared);
        const previewId = issuePreview(this.previews, {
          proposalId: input.proposalId, proposalIds: input.findingIds ? prepared.preview.proposalIds : input.proposalIds,
          fingerprint: prepared.fingerprint
        });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', previewId, ...prepared.preview,
          expiresInSeconds: PREVIEW_TTL_MS / 1000,
          note: 'Approving applies only these exact replacements in one file. No project tests or commands will run.'
        });
      }
      const preview = consumePreview(this.previews, input.previewId);
      if (!preview) return toolResult(this.vscode, { status: 'rejected', reason: 'The apply preview is missing, expired, or already used. Review a current proposal.' });
      if (input.decision !== 'approve' || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'cancelled', previewId: input.previewId, sourceWritten: false });
      }
      this.running = true;
      ownsRun = true;
      const result = preview.proposalIds ?
        await applyProposalBatch(this.vscode, this.findingStore, this.proposalStore, preview.proposalIds, token,
          { chatApproved: true, expectedFingerprint: preview.fingerprint }) :
        await applyProposal(this.vscode, this.findingStore, this.proposalStore, preview.proposalId, token,
          { chatApproved: true, expectedFingerprint: preview.fingerprint });
      if (result.status === 'applied') {
        await this.findingStore.refresh(this.vscode);
        result.sourceWritten = true;
        result.behaviorCheck = { status: 'not-checked', proposalIds: preview.proposalIds ?? [preview.proposalId],
          note: 'Offer an optional behavior check. Executing the known banking tests and cases requires separate approval.' };
      }
      return toolResult(this.vscode, result);
    } catch {
      return toolResult(this.vscode, { status: 'failed', reason: 'The exact proposal could not be applied. Verify the editor, source path, and save state.' });
    } finally {
      if (ownsRun) this.running = false;
    }
  }
}

class BehaviorCheckTool {
  constructor(vscode, proposalStore, options = {}) {
    this.vscode = vscode;
    this.proposalStore = proposalStore;
    this.options = options;
    this.previews = new Map();
    this.running = false;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).some((key) => !['phase', 'proposalIds', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'confirm'].includes(input.phase) ||
        (input.phase === 'prepare' && (!Array.isArray(input.proposalIds) || input.previewId !== undefined || input.decision !== undefined)) ||
        (input.phase === 'confirm' && (typeof input.previewId !== 'string' || !['approve', 'reject'].includes(input.decision) ||
          input.proposalIds !== undefined))) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Prepare with applied proposalIds, then confirm only a previewId and decision.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy', reason: 'A behavior check is already running.' });
    let ownsRun = false;
    try {
      if (input.phase === 'prepare') {
        const prepared = await prepareBehaviorCheck(this.vscode, this.proposalStore, input.proposalIds);
        if (prepared.status !== 'ready') return toolResult(this.vscode, prepared);
        const previewId = issuePreview(this.previews, { proposalIds: prepared.preview.proposalIds, fingerprint: prepared.fingerprint });
        return toolResult(this.vscode, { status: 'awaiting-decision', previewId, ...prepared.preview,
          expiresInSeconds: PREVIEW_TTL_MS / 1000, note: 'Ask for explicit approval to execute before confirming. Apply approval does not cover this check.' });
      }
      const preview = consumePreview(this.previews, input.previewId);
      if (!preview) return toolResult(this.vscode, { status: 'not-checked', reason: 'The behavior preview is missing, expired, or already used.' });
      if (input.decision === 'reject' || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'not-checked', reason: 'Behavior checking was declined or cancelled.' });
      }
      this.running = true;
      ownsRun = true;
      const run = () => runBehaviorCheck(this.vscode, this.proposalStore, preview.proposalIds,
        preview.fingerprint, token, { ...this.options, chatApproved: true });
      const result = this.vscode.window?.withProgress ? await this.vscode.window.withProgress({
        location: this.vscode.ProgressLocation.Notification, title: 'Checking banking behavior in disposable copies', cancellable: false
      }, run) : await run();
      return toolResult(this.vscode, result);
    } catch {
      return toolResult(this.vscode, { status: 'not-checked', reason: 'Behavior checking could not complete. The applied source was not reverted.' });
    } finally {
      if (ownsRun) this.running = false;
    }
  }
}

class AssessDependenciesTool {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.options = options;
    this.previews = new Map();
    this.revision = 0;
    this.running = false;
  }

  async publish(result) {
    const reportPath = await writeDependencyReport(this.options.reportDirectory, randomUUID(),
      renderDependencyReport(result), result.projectRoot);
    let reportOpened = true;
    try {
      await this.vscode.window.showTextDocument(
        await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(reportPath)), { preview: false });
    } catch { reportOpened = false; }
    return { status: result.status, root: result.projectRoot, fingerprint: result.fingerprint,
      requests: result.requests, coverage: result.inventory.coverage, gaps: result.gaps.length,
      registryQueried: result.registry.filter((entry) => entry.queried).length,
      advisoryTuplesQueried: result.advisories.filter((entry) => entry.queried).length,
      activeAdvisoryIdsPerTuple: result.advisories.reduce((total, entry) => total + entry.activeCount, 0),
      currentSnapshot: result.currentSnapshot, sourceWritten: false, reportPath, reportOpened,
      note: 'Recommendations and published advisory evidence only. No installs, upgrades, project commands or security approval.' };
  }

  async checkCurrent(result) {
    await checkDependencySnapshot(this.vscode, result);
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['phase', 'projectRoot', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'confirm'].includes(input.phase) ||
        (input.phase === 'prepare' && (typeof input.projectRoot !== 'string' || !input.projectRoot.trim() ||
          input.previewId !== undefined || input.decision !== undefined)) ||
        (input.phase === 'confirm' && (typeof input.previewId !== 'string' || !input.previewId ||
          !['approve', 'reject'].includes(input.decision) || input.projectRoot !== undefined))) {
      return toolResult(this.vscode, { status: 'rejected', requests: 0,
        reason: 'Prepare with the exact open projectRoot, then confirm only its previewId and approve/reject decision.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy', requests: 0, reason: 'Dependency inventory or assessment is running.' });
    this.running = true;
    let stage = 'local inventory';
    let requests = 0;
    try {
      if (input.phase === 'prepare') {
        if (token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled', requests: 0 });
        const snapshot = await inventoryDependencies(this.vscode, input.projectRoot, token);
        if (token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled', requests: 0 });
        this.revision += 1;
        if (!snapshot.lookup.registryNames.length && !snapshot.lookup.advisoryTuples.length) {
          const result = await assessDependencies(snapshot, token);
          await this.checkCurrent(result);
          stage = 'report creation';
          return toolResult(this.vscode, await this.publish(result));
        }
        const previewId = issuePreview(this.previews, { snapshot: structuredClone(snapshot), revision: this.revision });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', previewId, requests: 0, ...dependencyDisclosure(snapshot),
          expiresInSeconds: PREVIEW_TTL_MS / 1000,
          note: 'Ask for metadata-sharing approval and wait for a later reply. Scan, write and execution approvals do not cover this assessment.'
        });
      }
      const preview = consumePreview(this.previews, input.previewId);
      if (!preview) return toolResult(this.vscode, { status: 'rejected', requests: 0, reason: 'Dependency preview is missing, expired or already used.' });
      if (token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled', requests: 0 });
      if (input.decision === 'reject') return toolResult(this.vscode, { status: 'cancelled', requests: 0 });
      if (preview.revision !== this.revision) return toolResult(this.vscode, { status: 'stale', requests: 0, reason: 'A newer dependency preview superseded this one.' });
      stage = 'snapshot validation';
      let current;
      try { current = await inventoryDependencies(this.vscode, preview.snapshot.projectRoot, token); }
      catch {
        return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'stale', requests: 0,
          reason: 'The opened root or dependency documents changed, became dirty, or are unavailable.' });
      }
      if (current.fingerprint !== preview.snapshot.fingerprint) {
        return toolResult(this.vscode, { status: 'stale', requests: 0, reason: 'Dependency membership or contents changed. Prepare a new preview.' });
      }
      if (token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled', requests: 0 });
      this.revision += 1;
      stage = 'metadata lookup';
      const run = () => assessDependencies(preview.snapshot, token, this.options);
      const result = this.vscode.window?.withProgress ? await this.vscode.window.withProgress({
        location: this.vscode.ProgressLocation.Notification, title: 'Assessing approved npm dependency metadata', cancellable: false
      }, run) : await run();
      requests = result.requests;
      await this.checkCurrent(result);
      stage = 'report creation';
      return toolResult(this.vscode, await this.publish(result));
    } catch {
      return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'failed', stage,
        requests: stage === 'metadata lookup' ? null : requests, sourceWritten: false,
        reason: 'Dependency inventory, assessment or storage could not complete. Save metadata, verify the exact opened root and extension storage, and prepare again. Project files were not changed.' });
    } finally { this.running = false; }
  }
}

class UpdateDependenciesTool {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.options = options;
    this.previews = new Map();
    this.revision = 0;
    this.running = false;
  }

  async invoke(options, token) {
    const input = options?.input;
    const prepare = input?.phase === 'prepare';
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['phase', 'projectRoot', 'updates', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'resolve', 'apply'].includes(input.phase) ||
        (prepare && (typeof input.projectRoot !== 'string' || !input.projectRoot.trim() || !Array.isArray(input.updates) ||
          input.previewId !== undefined || input.decision !== undefined)) ||
        (!prepare && (typeof input.previewId !== 'string' || !input.previewId ||
          !['approve', 'reject'].includes(input.decision) || input.projectRoot !== undefined || input.updates !== undefined))) {
      return toolResult(this.vscode, { status: 'rejected', dependencyWritten: false,
        reason: 'Prepare with an exact open projectRoot and selected direct name/version updates; then resolve or apply only a current previewId with approve/reject.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy', dependencyWritten: false,
      reason: 'A dependency resolution or apply is already running.' });
    if (prepare) {
      try {
        if (token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled', resolutionAttempted: false, dependencyWritten: false });
        this.revision += 1;
        const prepared = await prepareDependencyUpdate(this.vscode, input.projectRoot, input.updates, token);
        const previewId = issuePreview(this.previews, { kind: 'resolve', prepared, revision: this.revision });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', stage: 'resolution', previewId, root: prepared.projectRoot,
          updates: prepared.updates.map(({ name, fromVersion, fromSpec, version, groups }) => ({ name, fromVersion, fromSpec, version, groups })),
          documents: [prepared.manifest, prepared.lock].map(({ path: filePath, hash: documentHash }) => ({ path: filePath, hash: documentHash })),
          resolution: { endpoint: 'https://registry.npmjs.org/', operation: 'npm install --package-lock-only',
            directIdentifiers: prepared.updates.map(({ name, version }) => `${name}@${version}`),
            transitiveMetadata: 'npm may request metadata for transitive packages needed to resolve the selected versions; the complete transitive identifier set is not known before resolution.' },
          scripts: 'disabled', audit: 'disabled', installs: 'package-lock-only; no node_modules expected',
          limits: { maxUpdates: MAX_UPDATES, timeoutMs: MAX_RESOLUTION_MS, maxOutputBytes: MAX_OUTPUT_BYTES },
          expiresInSeconds: PREVIEW_TTL_MS / 1000, resolutionAttempted: false, dependencyWritten: false,
          warning: 'Approval authorizes public npm metadata resolution for the selected direct updates and the transitive graph in a disposable copy. No project files, source, .npmrc, credentials or lifecycle scripts are sent or used.'
        });
      } catch (error) {
        return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'rejected',
          resolutionAttempted: false, dependencyWritten: false, reason: error?.code ?? 'unsupported-update-selection' });
      }
    }

    const preview = consumePreview(this.previews, input.previewId);
    if (!preview) return toolResult(this.vscode, { status: 'rejected', resolutionAttempted: false, dependencyWritten: false,
      reason: 'The dependency update preview is missing, expired or already used.' });
    if (preview.revision !== this.revision) return toolResult(this.vscode, { status: 'stale', resolutionAttempted: false,
      dependencyWritten: false, reason: 'A newer dependency update preview superseded this one.' });
    if (input.decision === 'reject' || token?.isCancellationRequested) {
      return toolResult(this.vscode, { status: 'cancelled', stage: preview.kind, resolutionAttempted: false,
        dependencyWritten: false });
    }
    if (preview.kind === 'resolve' && input.phase === 'resolve') {
      this.running = true;
      try {
        let fresh;
        try {
          fresh = await prepareDependencyUpdate(this.vscode, preview.prepared.projectRoot,
            preview.prepared.updates.map(({ name, version }) => ({ name, version })), token);
        } catch {
          return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'stale',
            resolutionAttempted: false, dependencyWritten: false,
            reason: 'Package inputs changed or became unavailable before resolution.' });
        }
        if (fresh.fingerprint !== preview.prepared.fingerprint) return toolResult(this.vscode, {
          status: 'stale', resolutionAttempted: false, dependencyWritten: false,
          reason: 'Package manifest, lock or inventory changed. Prepare a new resolution preview.' });
        const resolve = () => resolveDependencyUpdate(preview.prepared, token, this.options);
        const resolved = this.vscode.window?.withProgress ? await this.vscode.window.withProgress({
          location: this.vscode.ProgressLocation.Notification, title: 'Resolving selected npm updates in a disposable copy', cancellable: false
        }, resolve) : await resolve();
        if (resolved.status !== 'ready') return toolResult(this.vscode, { ...resolved, dependencyWritten: false });
        let current;
        try {
          current = await prepareDependencyUpdate(this.vscode, preview.prepared.projectRoot,
            preview.prepared.updates.map(({ name, version }) => ({ name, version })), token);
        } catch {
          return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'stale',
            resolutionAttempted: true, dependencyWritten: false,
            reason: 'Package inputs changed or became unavailable during resolution. Nothing was written.' });
        }
        if (current.fingerprint !== preview.prepared.fingerprint) return toolResult(this.vscode, {
          status: 'stale', resolutionAttempted: true, dependencyWritten: false,
          reason: 'Package inputs changed during resolution. The resolved diff is discarded and nothing was written.' });
        const diffs = await showDependencyDiff(this.vscode, resolved);
        this.revision += 1;
        const applyPreviewId = issuePreview(this.previews, { kind: 'apply', prepared: resolved, revision: this.revision });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', stage: 'exact-diff', previewId: applyPreviewId,
          root: resolved.projectRoot, updates: resolved.updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
          diffs, lockChanges: resolved.lockChanges.slice(0, 200), omittedLockChanges: Math.max(0, resolved.lockChanges.length - 200),
          fingerprint: resolved.fingerprint, resolutionAttempted: true, dependencyWritten: false,
          note: 'The package.json and package-lock.json diffs are open in VS Code. Review both. A later approval applies only these exact files and hashes; no tests, builds or project scripts will run.'
        });
      } catch (error) {
        return toolResult(this.vscode, { status: token?.isCancellationRequested ? 'cancelled' : 'failed', stage: 'resolution',
          resolutionAttempted: true, dependencyWritten: false, reason: error?.code ?? 'resolution-or-diff-failed' });
      } finally { this.running = false; }
    }
    if (preview.kind !== 'apply' || input.phase !== 'apply') return toolResult(this.vscode, {
      status: 'rejected', resolutionAttempted: false, dependencyWritten: false,
      reason: 'This preview is for a different dependency update stage.' });
    this.running = true;
    try {
      const result = await applyDependencyUpdate(this.vscode, preview.prepared, token);
      return toolResult(this.vscode, { ...result, resolutionAttempted: true });
    } catch {
      return toolResult(this.vscode, { status: 'verification-failed', dependencyWritten: null,
        resolutionAttempted: true, reason: 'The approved multi-file dependency write outcome is uncertain. Inspect both package files; do not retry blindly.' });
    } finally { this.running = false; }
  }
}

function plannedDependencyUpdates(assessment) {
  const updates = [];
  for (const entry of assessment?.registry ?? []) {
    for (const declaration of entry.declarations ?? []) {
      const locked = declaration.lockedVersions?.[0];
      const target = declaration.updateCandidate?.version;
      if (declaration.manifest !== 'package.json' || !locked || !target) continue;
      const deprecated = entry.lockedVersions?.some((record) => record.version === locked && record.deprecationStatus === 'deprecated');
      const advisories = assessment.advisories.find((advisory) => advisory.name === entry.name && advisory.version === locked)?.activeCount ?? 0;
      if (!deprecated && !advisories) continue;
      const reasons = [deprecated ? 'deprecated' : null, advisories ? `${advisories} published advisories` : null].filter(Boolean);
      updates.push({ name: entry.name, from: locked, version: target, reason: reasons.join(', ') });
    }
  }
  return updates;
}

function renderTransformationPlan(findings, updates, canApply) {
  const lines = ['', '## Transformation Plan', '',
    canApply ? 'Approving this report applies exactly these changes. Tests are not run.' :
      'This review is incomplete or stale and cannot be applied. Run a fresh review before approving changes.',
    '', '### Source Changes', ''];
  lines.push(...(findings.length ? findings.map((finding) =>
    `* \`${finding.path}\` lines ${finding.range.startLine}-${finding.range.endLine}: ${finding.category} (finding \`${finding.id}\`)`) :
    ['None.']));
  lines.push('', '### npm Dependency Updates', '');
  lines.push(...(updates.length ? updates.map((update) =>
    `* \`${update.name}\` ${update.from} -> ${update.version} (${update.reason})`) : ['None.']));
  return `${lines.join('\n')}\n`;
}

class TransformCodebaseTool {
  constructor(vscode, findingStore, proposalStore, options = {}) {
    this.vscode = vscode;
    this.findingStore = findingStore;
    this.proposalStore = proposalStore;
    this.options = options;
    this.selectModel = options.selectLanguageModel ?? selectLanguageModel;
    this.reviews = new Map();
    this.running = false;
  }

  async invoke(options, token) {
    const input = options?.input;
    const review = input?.action === 'review';
    if (!input || (review ? typeof input.projectRoot !== 'string' || !input.projectRoot.trim() :
        input.action !== 'apply' || typeof input.reviewId !== 'string' || !['approve', 'reject'].includes(input.decision))) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Use action "review" with projectRoot, or action "apply" with reviewId and decision approve/reject.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy' });
    this.running = true;
    try {
      return toolResult(this.vscode, review ? await this.review(input.projectRoot, token) : await this.apply(input, token));
    } catch (error) {
      return toolResult(this.vscode, { status: 'failed', reason: error?.message ?? 'Transformation failed.' });
    } finally {
      this.running = false;
    }
  }

  async review(projectRoot, token) {
    const model = await this.selectModel(this.vscode, 'Select the model for the codebase review');
    if (!model || token?.isCancellationRequested) return { status: 'cancelled' };
    const run = async () => {
      let result = await scanWorkspace(this.vscode, projectRoot, model, token, { ...this.options, chatApproved: true });
      while (result.canContinue && !token?.isCancellationRequested) {
        result = await scanWorkspace(this.vscode, projectRoot, model, token, { ...this.options, chatApproved: true, previousResult: result });
      }
      if (!Number.isInteger(result.nextChunk)) return result;
      result.sourceStatus = result.status;
      this.findingStore.addScan(result);
      result.dependencies = await assessDependencies(await inventoryDependencies(this.vscode, result.root, token), token, this.options);
      await checkDependencySnapshot(this.vscode, result.dependencies);
      try {
        const currentSource = await prepareWorkspaceScan(this.vscode, result.root);
        result.sourceSnapshotCurrent = currentSource.status === 'ready' && currentSource.fingerprint === result.fingerprint;
      } catch { result.sourceSnapshotCurrent = false; }
      if (result.status === 'completed' && (!result.sourceSnapshotCurrent ||
          !['completed', 'not-applicable'].includes(result.dependencies.status) || result.dependencies.currentSnapshot !== true)) {
        result.status = 'incomplete';
      }
      result.incomplete ||= result.status !== 'completed';
      return result;
    };
    const result = this.vscode.window?.withProgress ? await this.vscode.window.withProgress({
      location: this.vscode.ProgressLocation.Notification, title: 'Reviewing codebase and npm dependencies', cancellable: false
    }, run) : await run();
    if (!result.dependencies) return { status: result.status ?? 'failed', reason: result.reason };
    const findings = this.findingStore.list().filter((finding) => finding.status !== 'dismissed');
    const updates = plannedDependencyUpdates(result.dependencies);
    const canApply = result.status === 'completed' && result.sourceSnapshotCurrent === true &&
      result.dependencies.currentSnapshot === true && ['completed', 'not-applicable'].includes(result.dependencies.status);
    const report = renderScanReport({ ...result, findings }) + renderTransformationPlan(findings, updates, canApply);
    const reviewId = randomUUID();
    const reportPath = await writeDependencyReport(this.options.reportDirectory, reviewId, report, result.root, 'codebase-review');
    try {
      await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(reportPath)), { preview: false });
    } catch { /* report path is still returned */ }
    if (canApply) this.reviews.set(reviewId, { projectRoot: result.root, findingIds: findings.map((finding) => finding.id), updates });
    return { status: canApply ? 'awaiting-approval' : 'incomplete', ...(canApply ? { reviewId } : {}), reportPath, sourceStatus: result.sourceStatus,
      dependencyStatus: result.dependencies.status, sourceChanges: findings.length, dependencyUpdates: updates,
      sourceSnapshotCurrent: result.sourceSnapshotCurrent, dependencySnapshotCurrent: result.dependencies.currentSnapshot,
      note: canApply ? 'Ask the user to approve or reject the report. Nothing has been changed.' :
        'This report is not eligible for approval because coverage or snapshot validation is incomplete. Nothing has been changed.' };
  }

  async apply(input, token) {
    const plan = this.reviews.get(input.reviewId);
    this.reviews.delete(input.reviewId);
    if (!plan) return { status: 'rejected', reason: 'Unknown or already used reviewId. Run a new review.' };
    if (input.decision === 'reject') return { status: 'rejected-by-user', changed: false };
    const source = [];
    const byFile = new Map();
    for (const id of plan.findingIds) {
      const finding = this.findingStore.getCurrent(id);
      if (finding) byFile.set(finding.path, [...(byFile.get(finding.path) ?? []), id]);
    }
    for (const [file, ids] of byFile) {
      const prepared = await prepareApplyFindings(this.vscode, this.findingStore, this.proposalStore, ids);
      const outcome = prepared.status !== 'ready' ? prepared : await applyProposalBatch(this.vscode, this.findingStore,
        this.proposalStore, prepared.preview.proposalIds, token, { chatApproved: true, expectedFingerprint: prepared.fingerprint });
      source.push({ file, findings: ids.length, status: outcome.status, reason: outcome.reason });
    }
    let dependencies = { status: 'none-planned' };
    if (plan.updates.length) {
      const prepared = await prepareDependencyUpdate(this.vscode, plan.projectRoot,
        plan.updates.map(({ name, version }) => ({ name, version })), token);
      const resolved = await resolveDependencyUpdate(prepared, token, this.options);
      dependencies = resolved.status !== 'ready' ? resolved : await applyDependencyUpdate(this.vscode, resolved, token);
      dependencies.updates = plan.updates;
    }
    return { status: 'applied', source, dependencies, tests: 'not run (out of scope)' };
  }
}

class ReviewFindingsTool {
  constructor(vscode, store) {
    this.vscode = vscode;
    this.store = store;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).some((key) => !['action', 'findingId', 'approveIds', 'rejectIds'].includes(key)) ||
        !['list', 'refresh', 'select', 'dismiss', 'disposition'].includes(input.action) ||
        (['select', 'dismiss'].includes(input.action) && typeof input.findingId !== 'string') ||
        (input.findingId !== undefined && typeof input.findingId !== 'string') ||
        (input.action === 'disposition' &&
          (!Array.isArray(input.approveIds) || !Array.isArray(input.rejectIds) ||
            [...input.approveIds, ...input.rejectIds].some((id) => typeof id !== 'string')) ) ||
        (input.action !== 'disposition' && (input.approveIds !== undefined || input.rejectIds !== undefined)) ||
        (input.action !== 'select' && input.action !== 'dismiss' && input.findingId !== undefined)) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Use a supported action and current finding IDs when required.' });
    }
    try {
      if (input.action === 'list' || input.action === 'refresh') {
        const findings = await this.store.refresh(this.vscode);
        return toolResult(this.vscode, { status: 'ready', findings });
      }
      if (input.action === 'disposition') {
        return toolResult(this.vscode, await this.store.dispose(this.vscode, input.approveIds, input.rejectIds));
      }
      if (input.action === 'dismiss') return toolResult(this.vscode, { status: 'dismissed', finding: this.store.dismiss(input.findingId) });
      if (input.action === 'select') return toolResult(this.vscode, await this.store.select(this.vscode, input.findingId));
      return toolResult(this.vscode, { status: 'rejected', reason: 'Use the disposition action with explicit approveIds or rejectIds.' });
    } catch {
      return toolResult(this.vscode, { status: 'failed', reason: 'Finding review failed. Refresh the scan and try a current finding ID.' });
    }
  }
}

function registerScanTool(vscode, context, store, options) {
  context.subscriptions.push(vscode.lm.registerTool(SCAN_TOOL, new ScanWorkspaceTool(vscode, store, options)));
}

function registerFindingReviewTool(vscode, context, store) {
  context.subscriptions.push(vscode.lm.registerTool(REVIEW_TOOL, new ReviewFindingsTool(vscode, store)));
}

function registerProposalTool(vscode, context, findingStore, proposalStore, options) {
  context.subscriptions.push(vscode.lm.registerTool(PROPOSAL_TOOL,
    new GenerateProposalTool(vscode, findingStore, proposalStore, options)));
}

function registerApplyProposalTool(vscode, context, findingStore, proposalStore) {
  context.subscriptions.push(vscode.lm.registerTool(APPLY_TOOL,
    new ApplyProposalTool(vscode, findingStore, proposalStore)));
}

function registerBehaviorCheckTool(vscode, context, proposalStore, options) {
  context.subscriptions.push(vscode.lm.registerTool(BEHAVIOR_TOOL, new BehaviorCheckTool(vscode, proposalStore, options)));
}

function registerDependencyAssessmentTool(vscode, context, options) {
  context.subscriptions.push(vscode.lm.registerTool(DEPENDENCY_TOOL, new AssessDependenciesTool(vscode, options)));
}

function registerDependencyUpdateTool(vscode, context, options) {
  context.subscriptions.push(vscode.lm.registerTool(DEPENDENCY_UPDATE_TOOL, new UpdateDependenciesTool(vscode, options)));
}

function registerTransformCodebaseTool(vscode, context, findingStore, proposalStore, options) {
  context.subscriptions.push(vscode.lm.registerTool(TRANSFORM_TOOL,
    new TransformCodebaseTool(vscode, findingStore, proposalStore, options)));
}

function activate(context) {
  const vscode = require('vscode');
  const findingStore = new FindingStore();
  const proposalStore = new ProposalStore();
  registerScanTool(vscode, context, findingStore, { reportDirectory: context.globalStorageUri.fsPath });
  registerFindingReviewTool(vscode, context, findingStore);
  registerProposalTool(vscode, context, findingStore, proposalStore);
  registerApplyProposalTool(vscode, context, findingStore, proposalStore);
  registerBehaviorCheckTool(vscode, context, proposalStore);
  registerDependencyAssessmentTool(vscode, context, { reportDirectory: context.globalStorageUri.fsPath });
  registerDependencyUpdateTool(vscode, context);
  registerTransformCodebaseTool(vscode, context, findingStore, proposalStore,
    { reportDirectory: context.globalStorageUri.fsPath });
}

function deactivate() {}

module.exports = {
  APPLY_TOOL,
  BEHAVIOR_TOOL,
  DEPENDENCY_TOOL,
  DEPENDENCY_UPDATE_TOOL,
  PROPOSAL_TOOL,
  REVIEW_TOOL,
  SCAN_TOOL,
  TRANSFORM_TOOL,
  TransformCodebaseTool,
  GenerateProposalTool,
  ApplyProposalTool,
  BehaviorCheckTool,
  AssessDependenciesTool,
  UpdateDependenciesTool,
  ReviewFindingsTool,
  ScanWorkspaceTool,
  activate,
  deactivate,
  registerFindingReviewTool,
  registerProposalTool,
  registerApplyProposalTool,
  registerBehaviorCheckTool,
  registerDependencyAssessmentTool,
  registerDependencyUpdateTool,
  registerTransformCodebaseTool,
  registerScanTool
};
