'use strict';

const path = require('node:path');
const { DiscoverTargetTool } = require('./workspace-discovery');
const { ReadSourceEvidenceTool } = require('./source-evidence');
const { generateProposalReport, DEFAULT_REPORT_DIRECTORY } = require('./proposal-report');
const { ProposalCandidateStore, ApplyProposalTool, APPLY_TOOL } = require('./proposal-apply');
const { resolveWorkspaceRoot } = require('./workspace-scope');

const GENERATE_REPORT_COMMAND = 'legacyCodeTransformation.generateProposalReport';
const REVIEW_APPLY_COMMAND = 'legacyCodeTransformation.reviewAndApplyProposal';
const GENERATE_REPORT_TOOL = 'legacy_code_transformation_demo_generate_proposal_report';

class GenerateProposalReportTool {
	constructor(vscode, store, options = {}) {
		this.vscode = vscode;
		this.store = store;
		this.options = options;
	}

	async invoke(options, token) {
		let metadata;
		try {
			const input = options.input;
			if (!input || Object.keys(input).some((key) => !['projectRoot', 'targetFile', 'targetSymbol', 'mode'].includes(key)) ||
				!['projectRoot', 'targetFile', 'targetSymbol'].every((key) => typeof input[key] === 'string' && input[key].trim()) ||
				!['mock', 'live'].includes(input.mode ?? 'mock')) throw new Error('Invalid report tool input.');
			const root = await resolveWorkspaceRoot(input.projectRoot, this.vscode.workspace.workspaceFolders);
			const reportDirectory = this.vscode.workspace.getConfiguration('legacyCodeTransformation', root.uri)
				.get('reportDirectory', DEFAULT_REPORT_DIRECTORY);
			if (token?.isCancellationRequested) return this.result({ status: 'cancelled' });
			const consent = await this.vscode.window.showWarningMessage('Generate and write a proposal report without changing source?',
				{ modal: true, detail: `Root: ${root.realPath}\nSource: ${input.targetFile}\nSymbol: ${input.targetSymbol}\nMode: ${input.mode ?? 'mock'}\nArtifact directory: ${reportDirectory}\nLive mode requires a separate exact-context sharing confirmation. Tests are not run by generation.` },
				'Generate report');
			if (consent !== 'Generate report' || token?.isCancellationRequested) return this.result({ status: 'cancelled' });
			const generated = await generateProposalReport(this.vscode, { ...input, reportDirectory }, token, this.options);
			if (generated.status !== 'ready') return this.result({ status: generated.status });
			const proposalId = await this.store.add(this.vscode, generated);
			await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(generated.reportPath)), { preview: false });
			metadata = { status: 'ready', mode: input.mode ?? 'mock', proposalId, hasChanges: proposalId !== null,
				reportPath: generated.reportPath, reportRelativePath: path.relative(root.realPath, generated.reportPath).split(path.sep).join('/'),
				proposalHash: generated.proposalHash, sourceHash: generated.sourceSnapshot.fileHash, tests: 'not run' };
		} catch {
			metadata = { status: 'failed', reason: 'Report generation failed or report display was unavailable. No source was applied. Check root, saved target, provider, configuration and consent; review any created report before retrying.' };
		}
		return this.result(metadata);
	}

	result(metadata) {
		return new this.vscode.LanguageModelToolResult([new this.vscode.LanguageModelTextPart(JSON.stringify(metadata))]);
	}
}

function registerProposalReportTool(vscode, context, store) {
	if (typeof vscode.window?.showWarningMessage !== 'function') return;
	context.subscriptions.push(vscode.lm.registerTool(GENERATE_REPORT_TOOL, new GenerateProposalReportTool(vscode, store)));
}

function registerProposalReportCommand(vscode, context, store) {
	context.subscriptions.push(vscode.commands.registerCommand(GENERATE_REPORT_COMMAND, async () => {
		try {
			const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ label: folder.name ?? folder.uri.fsPath, folder }));
			if (roots.length === 0) throw new Error('Open a project folder before generating a report.');
			const selected = await vscode.window.showQuickPick(roots, { title: 'Select the opened project root' });
			if (!selected) return { status: 'cancelled' };
			const document = vscode.window.activeTextEditor?.document;
			if (document?.uri.scheme !== 'file' || !/\.(?:cs|[cm]?js|jsx|ts|tsx)$/i.test(document.uri.fsPath)) {
				throw new Error('Select a source file in the editor before generating a report.');
			}
			if (document.isDirty) throw new Error('The selected source file has unsaved changes. Report generation reads saved source only.');
			const symbol = await vscode.window.showInputBox({ title: 'Exact function, method, or class name', ignoreFocusOut: true });
			if (!symbol?.trim()) return { status: 'cancelled' };
			const mode = await vscode.window.showQuickPick([
				{ label: 'Mock (offline simulation)', mode: 'mock' },
				{ label: 'Live (requires environment configuration and source-sharing consent)', mode: 'live' }
			], { title: 'Proposal mode', placeHolder: 'Mock is the default; environment configuration never enables live mode.' });
			if (!mode) return { status: 'cancelled' };
			const reportDirectory = vscode.workspace.getConfiguration('legacyCodeTransformation', selected.folder.uri)
				.get('reportDirectory', DEFAULT_REPORT_DIRECTORY);
			const result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification, title: 'Generating proposal report', cancellable: true
			}, (progress, token) => generateProposalReport(vscode, {
				projectRoot: selected.folder.uri.fsPath, targetFile: document.uri.fsPath,
				targetSymbol: symbol.trim(), mode: mode.mode, reportDirectory
			}, token));
			if (result.status === 'ready') {
				result.proposalId = store ? await store.add(vscode, result) : null;
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(result.reportPath)), { preview: false });
			}
			return result;
		} catch {
			await vscode.window.showErrorMessage('Proposal report failed. Check the selected root, saved source, exact symbol, report directory, and live configuration/permission. No source files were changed.');
			return { status: 'failed' };
		}
	}));
}

function registerProposalApply(vscode, context, store) {
	if (typeof vscode.window?.showWarningMessage !== 'function') return;
	context.subscriptions.push(vscode.commands.registerCommand(REVIEW_APPLY_COMMAND, async () => {
		const candidates = store.list().map((candidate) => ({
			label: `${candidate.path} (${candidate.status})`, description: candidate.id, detail: candidate.reportPath, candidate
		}));
		if (candidates.length === 0) {
			await vscode.window.showInformationMessage('No stored edit proposals. Generate a proposal report first; no-change reports cannot be applied.');
			return { status: 'unavailable' };
		}
		const selected = await vscode.window.showQuickPick(candidates, { title: 'Review and Apply Proposal' });
		if (!selected) return { status: 'cancelled' };
		const result = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification, title: 'Verifying and applying controlled proposal', cancellable: true
		}, (progress, token) => store.apply(vscode, selected.candidate.id, token));
		if (result.verificationReportPath) {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(result.verificationReportPath)), { preview: false });
		}
		if (result.status === 'applied') await vscode.window.showInformationMessage('Exact proposal applied after controlled verification.');
		else if (result.status !== 'cancelled') await vscode.window.showWarningMessage(result.reason ?? 'Proposal was not applied. Generate a revised report.');
		return result;
	}));
	context.subscriptions.push(vscode.lm.registerTool(APPLY_TOOL, new ApplyProposalTool(vscode, store)));
}

function registerDiscoveryTool(vscode, context) {
	const registration = vscode.lm.registerTool(
		'legacy_code_transformation_demo_discover_target',
		new DiscoverTargetTool(vscode)
	);
	context.subscriptions.push(registration);
}

function registerSourceEvidenceTool(vscode, context) {
	const registration = vscode.lm.registerTool(
		'legacy_code_transformation_demo_read_source_evidence',
		new ReadSourceEvidenceTool(vscode)
	);
	context.subscriptions.push(registration);
}

function activate(context) {
	const vscode = require('vscode');
	const store = new ProposalCandidateStore();
	registerDiscoveryTool(vscode, context);
	registerSourceEvidenceTool(vscode, context);
	registerProposalReportCommand(vscode, context, store);
	registerProposalReportTool(vscode, context, store);
	registerProposalApply(vscode, context, store);
}

function deactivate() {}

module.exports = { activate, deactivate, registerDiscoveryTool, registerSourceEvidenceTool, registerProposalReportCommand,
	registerProposalApply, registerProposalReportTool, GenerateProposalReportTool, GENERATE_REPORT_TOOL, GENERATE_REPORT_COMMAND, REVIEW_APPLY_COMMAND };
