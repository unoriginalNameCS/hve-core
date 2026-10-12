'use strict';

const { randomUUID } = require('node:crypto');
const { FindingStore } = require('./finding-store');
const { MAX_MODEL_REQUESTS, prepareWorkspaceScan, scanWorkspace } = require('./scan-pipeline');
const { selectLanguageModel } = require('./model-selection');
const { applyProposal, applyProposalBatch, generateProposal, prepareApplyProposal, prepareApplyProposalBatch, prepareApplyFindings, prepareProposalRequest, ProposalStore } = require('./proposal-workflow');
const { renderScanReport, writeScanReport } = require('./scan-report');
const { prepareBehaviorCheck, runBehaviorCheck } = require('./behavior-check');

const SCAN_TOOL = 'legacy_codebase_transformation_demo_scan_workspace';
const REVIEW_TOOL = 'legacy_codebase_transformation_demo_review_findings';
const PROPOSAL_TOOL = 'legacy_codebase_transformation_demo_generate_proposal';
const APPLY_TOOL = 'legacy_codebase_transformation_demo_apply_proposal';
const BEHAVIOR_TOOL = 'legacy_codebase_transformation_demo_check_behavior';
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
    if (!input || Object.keys(input).some((key) => !['phase', 'projectRoot', 'scanId', 'previewId', 'decision'].includes(key)) ||
        !['prepare', 'confirm'].includes(input.phase) ||
        (input.phase === 'prepare' && (typeof input.projectRoot !== 'string' || !input.projectRoot.trim() ||
          (input.scanId !== undefined && (typeof input.scanId !== 'string' || !input.scanId)) ||
          input.previewId !== undefined || input.decision !== undefined)) ||
        (input.phase === 'confirm' && (typeof input.previewId !== 'string' || !['approve', 'reject'].includes(input.decision) ||
          input.projectRoot !== undefined || input.scanId !== undefined))) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Prepare a scan with an absolute projectRoot, then confirm a current previewId with approve or reject.' });
    }
    if (this.running) return toolResult(this.vscode, { status: 'busy', reason: 'A scan batch is already running.' });
    let stage = 'model selection';
    let ownsRun = false;
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
        if (revision !== this.revision || this.running || (previous && previous.fingerprint !== prepared.fingerprint)) {
          return toolResult(this.vscode, { status: 'stale', reason: 'The scan session or source changed. Prepare a fresh scan.' });
        }
        const remainingChunks = prepared.chunks.length - (previous?.nextChunk ?? 0);
        const previewId = issuePreview(this.previews, {
          projectRoot: input.projectRoot, model, fingerprint: prepared.fingerprint, previousResult: previous, revision
        });
        return toolResult(this.vscode, {
          status: 'awaiting-decision', previewId, root: prepared.inventory.root.realPath,
          files: prepared.inventory.files.length, bytes: prepared.inventory.bytes,
          projectedRequests: prepared.chunks.length, remainingChunks,
          batchRequests: Math.min(MAX_MODEL_REQUESTS, remainingChunks),
          batchSourceBytes: prepared.chunks.slice(previous?.nextChunk ?? 0,
            (previous?.nextChunk ?? 0) + MAX_MODEL_REQUESTS).reduce((total, chunk) => total + Buffer.byteLength(chunk.content, 'utf8'), 0),
          scanId: previous?.scanId ?? null, unsupportedFiles: prepared.inventory.unsupportedFiles.length,
          model: model.name ?? model.family ?? model.id ?? 'selected model',
          destination: `${model.vendor ?? 'unknown vendor'}${model.id ? ` / ${model.id}` : ''}`,
          limits: { requestsPerBatch: MAX_MODEL_REQUESTS, findingsPerRequest: 3, requestBytes: 256 * 1024 },
          expiresInSeconds: PREVIEW_TTL_MS / 1000
        });
      }
      const preview = consumePreview(this.previews, input.previewId);
      if (!preview) {
        return toolResult(this.vscode, { status: 'rejected', reason: 'The scan preview is missing, expired, or already used. Prepare a new scan.' });
      }
      if (input.decision !== 'approve' || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'cancelled', previewId: input.previewId, requests: 0 });
      }
      if (preview.revision !== this.revision) {
        return toolResult(this.vscode, { status: 'stale', requests: 0, reason: 'Another batch advanced the scan session. Prepare a new preview.' });
      }
      this.running = true;
      ownsRun = true;
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
      this.session = { result, model: preview.model };
      this.revision += 1;
      this.store.addScan(result);
      stage = 'report creation';
      const report = renderScanReport({ ...result, findings: this.store.list() });
      const reportPath = await writeScanReport(this.options.reportDirectory, result.scanId, report, result.batchNumber);
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

function activate(context) {
  const vscode = require('vscode');
  const findingStore = new FindingStore();
  const proposalStore = new ProposalStore();
  registerScanTool(vscode, context, findingStore, { reportDirectory: context.globalStorageUri.fsPath });
  registerFindingReviewTool(vscode, context, findingStore);
  registerProposalTool(vscode, context, findingStore, proposalStore);
  registerApplyProposalTool(vscode, context, findingStore, proposalStore);
  registerBehaviorCheckTool(vscode, context, proposalStore);
}

function deactivate() {}

module.exports = {
  APPLY_TOOL,
  BEHAVIOR_TOOL,
  PROPOSAL_TOOL,
  REVIEW_TOOL,
  SCAN_TOOL,
  GenerateProposalTool,
  ApplyProposalTool,
  BehaviorCheckTool,
  ReviewFindingsTool,
  ScanWorkspaceTool,
  activate,
  deactivate,
  registerFindingReviewTool,
  registerProposalTool,
  registerApplyProposalTool,
  registerBehaviorCheckTool,
  registerScanTool
};
