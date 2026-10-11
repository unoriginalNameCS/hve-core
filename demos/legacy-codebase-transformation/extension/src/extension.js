'use strict';

const { FindingStore } = require('./finding-store');
const { scanWorkspace } = require('./scan-pipeline');
const { selectLanguageModel } = require('./model-selection');
const { applyProposal, generateProposal, ProposalStore } = require('./proposal-workflow');

const SCAN_TOOL = 'legacy_codebase_transformation_demo_scan_workspace';
const REVIEW_TOOL = 'legacy_codebase_transformation_demo_review_findings';
const PROPOSAL_TOOL = 'legacy_codebase_transformation_demo_generate_proposal';
const APPLY_TOOL = 'legacy_codebase_transformation_demo_apply_proposal';
const APPROVE_FINDING_LABEL = 'Approve finding';

function toolResult(vscode, value) {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);
}

class ScanWorkspaceTool {
  constructor(vscode, store, options = {}) {
    this.vscode = vscode;
    this.store = store;
    this.options = options;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).length !== 1 || typeof input.projectRoot !== 'string' || !input.projectRoot.trim()) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Provide only the absolute projectRoot path.' });
    }
    try {
      const model = await selectLanguageModel(this.vscode, 'Select the model and destination for this source scan');
      if (!model || token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled' });
      const result = await scanWorkspace(this.vscode, input.projectRoot, model, token, this.options);
      if (result.status !== 'cancelled') this.store.addScan(result);
      return toolResult(this.vscode, {
        status: result.status, scanId: result.scanId, root: result.root,
        files: result.files, bytes: result.bytes, projectedRequests: result.projectedRequests,
        requests: result.requests, skipped: result.skipped, rejected: result.rejected,
        incomplete: result.incomplete,
        findings: result.findings.map(({ id, path, category, rationale, confidence, symbol, functionRange, range, originalText }) =>
          ({ id, path, category, rationale, confidence, symbol, functionRange, range, originalText, status: 'new' }))
      });
    } catch {
      return toolResult(this.vscode, { status: 'failed', reason: 'Scan setup failed. Verify the opened root, model availability, and consent UI; source changes were not made.' });
    }
  }
}

class GenerateProposalTool {
  constructor(vscode, findingStore, proposalStore, options = {}) {
    this.vscode = vscode;
    this.findingStore = findingStore;
    this.proposalStore = proposalStore;
    this.options = options;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).some((key) => !['findingId', 'changeRequest'].includes(key)) ||
        typeof input.findingId !== 'string' ||
        (input.changeRequest !== undefined && typeof input.changeRequest !== 'string')) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Provide an approved findingId and an optional refactor request.' });
    }
    if (!this.findingStore.getApproved(input.findingId)) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Only a current finding with explicit finding approval can be proposed.' });
    }
    try {
      const model = await selectLanguageModel(this.vscode, 'Select the model and destination for this proposal');
      if (!model || token?.isCancellationRequested) return toolResult(this.vscode, { status: 'cancelled' });
      const result = await generateProposal(this.vscode, this.findingStore, this.proposalStore,
        input.findingId, model, input.changeRequest, token, this.options);
      return toolResult(this.vscode, result);
    } catch {
      return toolResult(this.vscode, { status: 'failed', reason: 'Proposal generation failed. Refresh the finding and verify the saved source and consent UI.' });
    }
  }
}

class ApplyProposalTool {
  constructor(vscode, findingStore, proposalStore) {
    this.vscode = vscode;
    this.findingStore = findingStore;
    this.proposalStore = proposalStore;
  }

  async invoke(options, token) {
    const input = options?.input;
    if (!input || Object.keys(input).length !== 1 || typeof input.proposalId !== 'string') {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Provide only a proposalId from a current proposal.' });
    }
    try {
      return toolResult(this.vscode, await applyProposal(this.vscode, this.findingStore,
        this.proposalStore, input.proposalId, token));
    } catch {
      return toolResult(this.vscode, { status: 'failed', reason: 'The exact proposal could not be applied. Verify the editor, source path, and save state.' });
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
    if (!input || Object.keys(input).some((key) => !['action', 'findingId'].includes(key)) ||
        !['list', 'refresh', 'select', 'dismiss', 'approve'].includes(input.action) ||
        (input.action !== 'list' && input.action !== 'refresh' && typeof input.findingId !== 'string') ||
        (input.findingId !== undefined && typeof input.findingId !== 'string')) {
      return toolResult(this.vscode, { status: 'rejected', reason: 'Use a supported action and a current finding ID when required.' });
    }
    try {
      if (input.action === 'list' || input.action === 'refresh') {
        const findings = await this.store.refresh(this.vscode);
        return toolResult(this.vscode, { status: 'ready', findings });
      }
      if (input.action === 'dismiss') return toolResult(this.vscode, { status: 'dismissed', finding: this.store.dismiss(input.findingId) });
      if (input.action === 'select') return toolResult(this.vscode, await this.store.select(this.vscode, input.findingId));

      const finding = await this.store.refresh(this.vscode, input.findingId);
      if (finding.status !== 'selected' || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'rejected', finding });
      }
      const choice = await this.vscode.window.showWarningMessage(
        'Approve this finding to allow a separate proposal request?',
        { modal: true, detail: `Finding: ${finding.id}\nFile: ${finding.path}\nCategory: ${finding.category}\nRange: ${finding.range.startLine}-${finding.range.endLine}\nSource SHA-256: ${finding.sourceHash}\nRationale: ${finding.rationale}\n\nApproval permits proposal drafting only. It does not authorize a source write.` },
        APPROVE_FINDING_LABEL
      );
      if (choice !== APPROVE_FINDING_LABEL || token?.isCancellationRequested) {
        return toolResult(this.vscode, { status: 'cancelled', finding });
      }
      return toolResult(this.vscode, await this.store.approve(this.vscode, input.findingId));
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

function activate(context) {
  const vscode = require('vscode');
  const findingStore = new FindingStore();
  const proposalStore = new ProposalStore();
  registerScanTool(vscode, context, findingStore);
  registerFindingReviewTool(vscode, context, findingStore);
  registerProposalTool(vscode, context, findingStore, proposalStore);
  registerApplyProposalTool(vscode, context, findingStore, proposalStore);
}

function deactivate() {}

module.exports = {
  APPROVE_FINDING_LABEL,
  APPLY_TOOL,
  PROPOSAL_TOOL,
  REVIEW_TOOL,
  SCAN_TOOL,
  GenerateProposalTool,
  ApplyProposalTool,
  ReviewFindingsTool,
  ScanWorkspaceTool,
  activate,
  deactivate,
  registerFindingReviewTool,
  registerProposalTool,
  registerApplyProposalTool,
  registerScanTool
};
