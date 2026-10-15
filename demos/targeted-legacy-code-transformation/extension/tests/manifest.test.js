'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { registerDiscoveryTool, registerSourceEvidenceTool, registerProposalReportCommand, GENERATE_REPORT_COMMAND } = require('../src/extension');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package-lock.json'), 'utf8'));

test('custom agent contribution resolves to the manually invoked approval-gated agent and exact tools', () => {
  const [agentContribution] = manifest.contributes.chatAgents;
  const agentPath = path.resolve(extensionRoot, agentContribution.path);
  const relativePath = path.relative(extensionRoot, agentPath);
  const agentContent = fs.readFileSync(agentPath, 'utf8');

  assert.ok(relativePath && !relativePath.startsWith('..'));
  assert.ok(agentPath.endsWith('.agent.md'));
  assert.match(agentContent, /^---\r?\nname: Legacy Code Transformation Demo\r?\ndescription:/);
  assert.match(agentContent, /^name: Legacy Code Transformation Demo$/m);
  assert.match(agentContent, /^user-invocable: true$/m);
  assert.match(agentContent, /^disable-model-invocation: true$/m);
  assert.match(agentContent, /^tools:\r?\n\s+- legacy_code_transformation_demo_discover_target\r?\n\s+- legacy_code_transformation_demo_read_source_evidence\r?\n\s+- legacy_code_transformation_demo_generate_proposal_report\r?\n\s+- legacy_code_transformation_demo_apply_proposal\r?\n---/m);
});

test('package and lock names remain aligned', () => {
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
});

test('all owned tools are exposed to chat using the agent allowlist names', () => {
  const agentContent = fs.readFileSync(path.join(extensionRoot, manifest.contributes.chatAgents[0].path), 'utf8');
  const referenceNames = new Set();
  for (const tool of manifest.contributes.languageModelTools) {
    assert.equal(tool.canBeReferencedInPrompt, true);
    assert.equal(tool.toolReferenceName, tool.name);
    assert.ok(agentContent.split(/\r?\n/).includes(`  - ${tool.toolReferenceName}`));
    assert.ok(!referenceNames.has(tool.toolReferenceName));
    referenceNames.add(tool.toolReferenceName);
  }
});

test('read-only tool manifest entries match their runtime registrations', () => {
  const registeredNames = [];
  const context = { subscriptions: [] };
  const vscode = {
    lm: {
      registerTool(name, tool) {
        registeredNames.push(name);
        return { name, tool, dispose() {} };
      }
    }
  };

  registerDiscoveryTool(vscode, context);
  registerSourceEvidenceTool(vscode, context);

  assert.deepEqual(
    registeredNames.sort(),
    manifest.contributes.languageModelTools.filter((tool) => tool.tags.includes('readOnly')).map((tool) => tool.name).sort()
  );
  assert.equal(manifest.contributes.languageModelTools.filter((tool) => tool.tags.includes('readOnly')).length, 2);
  assert.equal(context.subscriptions.length, 2);
});

test('report command is registered separately from proposal-bound application', async () => {
  const registrations = [];
  const context = { subscriptions: [] };
  const vscode = {
    workspace: { workspaceFolders: [{ name: 'project', uri: { fsPath: 'project' } }] },
    window: { showQuickPick: async () => undefined },
    commands: { registerCommand: (name, callback) => {
      const registration = { name, callback, dispose() {} };
      registrations.push(registration);
      return registration;
    } }
  };
  registerProposalReportCommand(vscode, context);
  assert.equal(registrations[0].name, GENERATE_REPORT_COMMAND);
  assert.equal(manifest.contributes.commands[0].command, GENERATE_REPORT_COMMAND);
  assert.equal(manifest.contributes.commands[0].title, 'Legacy Code Transformation: Generate Proposal Report');
  assert.equal(manifest.contributes.languageModelTools.length, 4);
  assert.equal((await registrations[0].callback()).status, 'cancelled');
  assert.equal(context.subscriptions.length, 1);
});

test('ID-only apply tool and review command register only with extension confirmation available', () => {
  const { registerProposalApply, REVIEW_APPLY_COMMAND } = require('../src/extension');
  const { ProposalCandidateStore, APPLY_TOOL } = require('../src/proposal-apply');
  const registered = [];
  const vscode = { window: {}, commands: { registerCommand: (name) => { registered.push(name); return { dispose() {} }; } },
    lm: { registerTool: (name) => { registered.push(name); return { dispose() {} }; } } };
  const context = { subscriptions: [] };
  registerProposalApply(vscode, context, new ProposalCandidateStore());
  assert.deepEqual(registered, []);
  vscode.window.showWarningMessage = async () => undefined;
  registerProposalApply(vscode, context, new ProposalCandidateStore());
  assert.deepEqual(registered, [REVIEW_APPLY_COMMAND, APPLY_TOOL]);
  const tool = manifest.contributes.languageModelTools.find((item) => item.name === APPLY_TOOL);
  assert.deepEqual(tool.inputSchema.required, ['proposalId']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['proposalId']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(manifest.contributes.commands.some((command) => command.command === REVIEW_APPLY_COMMAND));
});

test('generation registration shares the candidate store and rejects missing modal support', () => {
  const { registerProposalReportTool, GENERATE_REPORT_TOOL } = require('../src/extension');
  const { ProposalCandidateStore } = require('../src/proposal-apply');
  const registrations = [];
  const store = new ProposalCandidateStore();
  const vscode = { window: {}, lm: { registerTool: (name, tool) => {
    registrations.push({ name, tool });
    return { dispose() {} };
  } } };
  registerProposalReportTool(vscode, { subscriptions: [] }, store);
  assert.equal(registrations.length, 0);
  vscode.window.showWarningMessage = async () => undefined;
  registerProposalReportTool(vscode, { subscriptions: [] }, store);
  assert.equal(registrations[0].name, GENERATE_REPORT_TOOL);
  assert.equal(registrations[0].tool.store, store);
  const tool = manifest.contributes.languageModelTools.find((item) => item.name === GENERATE_REPORT_TOOL);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['projectRoot', 'targetFile', 'targetSymbol', 'changeRequest', 'testFile']);
  assert.match(tool.modelDescription, /Always use the configured Live Azure OpenAI\/Foundry deployment/);
  assert.ok(!JSON.stringify(tool.inputSchema).includes('mock'));
});

test('standalone launch configurations prompt for fixture copies and contain no credentials', () => {
  const launch = JSON.parse(fs.readFileSync(path.join(extensionRoot, '.vscode/launch.json'), 'utf8'));
  assert.equal(launch.configurations.length, 2);
  for (const configuration of launch.configurations) {
    assert.equal(configuration.type, 'extensionHost');
    assert.deepEqual(configuration.args.slice(0, 1), ['--extensionDevelopmentPath=${workspaceFolder}']);
    assert.match(configuration.args[1], /^\$\{input:(pizzaRoot|nodeRoot)\}$/);
    assert.equal(configuration.env, undefined);
  }
});
