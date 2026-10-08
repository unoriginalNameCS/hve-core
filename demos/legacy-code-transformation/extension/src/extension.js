'use strict';

const { DiscoverTargetTool } = require('./workspace-discovery');
const { ReadSourceEvidenceTool } = require('./source-evidence');

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
	registerDiscoveryTool(vscode, context);
	registerSourceEvidenceTool(vscode, context);
}

function deactivate() {}

module.exports = { activate, deactivate, registerDiscoveryTool, registerSourceEvidenceTool };
