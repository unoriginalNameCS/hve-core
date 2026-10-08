'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { registerDiscoveryTool, registerSourceEvidenceTool } = require('../src/extension');

const extensionRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package-lock.json'), 'utf8'));

test('custom agent contribution resolves to the read-only demo agent and tools', () => {
  const [agentContribution] = manifest.contributes.chatAgents;
  const agentPath = path.resolve(extensionRoot, agentContribution.path);
  const relativePath = path.relative(extensionRoot, agentPath);
  const agentContent = fs.readFileSync(agentPath, 'utf8');

  assert.ok(relativePath && !relativePath.startsWith('..'));
  assert.ok(agentPath.endsWith('.agent.md'));
  assert.match(agentContent, /^user-invocable: true$/m);
  assert.match(agentContent, /^disable-model-invocation: true$/m);
  assert.match(agentContent, /^tools:\r?\n\s+- legacy_code_transformation_demo_discover_target\r?\n\s+- legacy_code_transformation_demo_read_source_evidence$/m);
});

test('package and lock names remain aligned', () => {
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
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
    manifest.contributes.languageModelTools.map((tool) => tool.name).sort()
  );
  assert.ok(manifest.contributes.languageModelTools.every((tool) => tool.tags.includes('readOnly')));
  assert.equal(context.subscriptions.length, 2);
});
