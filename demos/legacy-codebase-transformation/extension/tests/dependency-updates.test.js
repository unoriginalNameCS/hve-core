'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UpdateDependenciesTool } = require('../src/extension');
const { applyDependencyUpdate, prepareDependencyUpdate, resolveDependencyUpdate } = require('../src/dependency-updates');

function uri(filePath) {
  return { scheme: 'file', authority: '', fsPath: filePath };
}

function record(name, version) {
  return { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: 'sha512-ZGVtby1pbnRlZ3JpdHk=' };
}

async function fixture(context, options = {}) {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-dependency-update-')));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const newline = options.crlf ? '\r\n' : '\n';
  const manifest = { name: 'sample', version: '1.0.0', private: true, dependencies: { alpha: '1.0.0' },
    ...(options.manifest ?? {}) };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: manifest.version, dependencies: { ...manifest.dependencies } },
      'node_modules/alpha': record('alpha', '1.0.0') } };
  await fs.writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify(manifest, null, 2).replace(/\n/g, newline)}${newline}`);
  await fs.writeFile(path.join(projectRoot, 'package-lock.json'), `${JSON.stringify(lock, null, 2).replace(/\n/g, newline)}${newline}`);
  const matches = [uri(path.join(projectRoot, 'package.json')), uri(path.join(projectRoot, 'package-lock.json'))];
  const vscode = {
    RelativePattern: class {},
    workspace: { workspaceFolders: [{ uri: uri(projectRoot) }], textDocuments: [], findFiles: async () => matches }
  };
  return { projectRoot, manifest, lock, matches, vscode,
    prepare: (updates = [{ name: 'alpha', version: '1.1.0' }]) => prepareDependencyUpdate(vscode, projectRoot, updates) };
}

async function resolveFixture(sample) {
  const prepared = await sample.prepare();
  assert.equal(prepared.status, 'ready');
  let temporaryRoot;
  const resolved = await resolveDependencyUpdate(prepared, undefined, { npmResolver: async ({ cwd, args }) => {
    temporaryRoot = cwd;
    assert.ok(!cwd.startsWith(sample.projectRoot));
    assert.ok(args.includes('--package-lock-only'));
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('--no-audit'));
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
    assert.equal(await fs.readFile(path.join(cwd, '.npmrc'), 'utf8'), '');
    assert.ok(args.includes('--userconfig=user.npmrc'));
    assert.ok(args.includes('--globalconfig=global.npmrc'));
    assert.equal(await fs.readFile(path.join(cwd, 'user.npmrc'), 'utf8'), '');
    assert.equal(await fs.readFile(path.join(cwd, 'global.npmrc'), 'utf8'), '');
    await assert.rejects(fs.stat(path.join(cwd, 'src')));
    const lock = JSON.parse(await fs.readFile(path.join(cwd, 'package-lock.json'), 'utf8'));
    lock.packages[''].dependencies.alpha = '1.1.0';
    lock.packages['node_modules/alpha'] = record('alpha', '1.1.0');
    await fs.writeFile(path.join(cwd, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    return { exitCode: 0 };
  } });
  assert.equal(resolved.status, 'ready');
  assert.ok(resolved.files.every((file) => file.beforeHash !== file.afterHash));
  assert.equal(resolved.lockChanges[0].name, 'alpha');
  await assert.rejects(fs.stat(temporaryRoot));
  return { prepared, resolved };
}

test('update preparation is local, validates direct public package origins and does not write project files', async (context) => {
  const sample = await fixture(context);
  const before = await Promise.all(sample.matches.map((file) => fs.readFile(file.fsPath)));
  const prepared = await sample.prepare();
  assert.equal(prepared.status, 'ready');
  assert.deepEqual(prepared.updates.map(({ name, fromVersion, version }) => ({ name, fromVersion, version })),
    [{ name: 'alpha', fromVersion: '1.0.0', version: '1.1.0' }]);
  assert.deepEqual(await Promise.all(sample.matches.map((file) => fs.readFile(file.fsPath))), before);
});

test('update preparation rejects invalid, non-direct, downgrading and workspace selections', async (context) => {
  const sample = await fixture(context);
  for (const updates of [[], [{ name: 'alpha', version: 'v1.1.0' }], [{ name: 'not-direct', version: '2.0.0' }],
    [{ name: 'alpha', version: '1.0.0' }], [{ name: 'alpha', version: '2.0.0' }, { name: 'alpha', version: '3.0.0' }]]) {
    await assert.rejects(sample.prepare(updates));
  }
  const workspace = await fixture(context, { manifest: { workspaces: ['packages/*'] } });
  await assert.rejects(workspace.prepare(), /unsupported-project-root/);
});

test('approved resolver changes only a disposable manifest/lock and rejects unrelated manifest edits', async (context) => {
  const sample = await fixture(context);
  const { resolved } = await resolveFixture(sample);
  const manifestAfter = JSON.parse(resolved.files.find((file) => file.path === 'package.json').after.toString('utf8'));
  assert.equal(manifestAfter.dependencies.alpha, '1.1.0');
  assert.equal(await fs.readFile(path.join(sample.projectRoot, 'package.json'), 'utf8'), `${JSON.stringify(sample.manifest, null, 2)}\n`);
  const prepared = await sample.prepare();
  const failed = await resolveDependencyUpdate(prepared, undefined, { npmResolver: async ({ cwd }) => {
    const manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    manifest.dependencies.unselected = '9.0.0';
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest));
    return { exitCode: 0 };
  } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'unexpected-manifest-change');
  const unavailable = await resolveDependencyUpdate(prepared, undefined, { npmResolver: async () => ({
    exitCode: 1, rawOutput: 'npm ERR! code ENETUNREACH credentials must not be returned'
  }) });
  assert.equal(unavailable.status, 'failed');
  assert.equal(unavailable.npmExitCode, 1);
  assert.equal(unavailable.npmErrorCode, 'ENETUNREACH');
  assert.doesNotMatch(JSON.stringify(unavailable), /credentials|rawOutput/);
});

test('resolver rejects generated non-public and non-SHA512 lock entries', async (context) => {
  for (const [name, mutate, expected] of [
    ['non-public origin', (lock) => { lock.packages['node_modules/alpha'].resolved = 'https://example.com/alpha.tgz'; }, 'unsupported-lock-origin'],
    ['weak integrity', (lock) => { lock.packages['node_modules/alpha'].integrity = 'sha1-ZGVtbw=='; }, 'lock-integrity-not-sha512']
  ]) {
    const sample = await fixture(context);
    const prepared = await sample.prepare();
    const result = await resolveDependencyUpdate(prepared, undefined, { npmResolver: async ({ cwd }) => {
      const lock = JSON.parse(await fs.readFile(path.join(cwd, 'package-lock.json'), 'utf8'));
      lock.packages[''].dependencies.alpha = '1.1.0';
      lock.packages['node_modules/alpha'] = record('alpha', '1.1.0');
      mutate(lock);
      await fs.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
      return { exitCode: 0 };
    } });
    assert.equal(result.status, 'failed', name);
    assert.equal(result.reason, expected, name);
  }
});

function editorApi(projectRoot) {
  const documents = new Map();
  class WorkspaceEdit {
    constructor() { this.edits = []; }
    replace(documentUri, range, text) { this.edits.push({ documentUri, range, text }); }
  }
  class Range {
    constructor(start, end) { this.start = start; this.end = end; }
  }
  const vscode = {
    RelativePattern: class {}, Uri: { file: uri }, EndOfLine: { LF: 1, CRLF: 2 }, WorkspaceEdit, Range,
    workspace: { workspaceFolders: [{ uri: uri(projectRoot) }], textDocuments: [],
      findFiles: async () => [uri(path.join(projectRoot, 'package.json')), uri(path.join(projectRoot, 'package-lock.json'))],
      openTextDocument: async (documentUri) => {
        const key = documentUri.fsPath;
        if (!documents.has(key)) {
          const text = (await fs.readFile(key, 'utf8')).replace(/^\uFEFF/, '');
          const document = { uri: documentUri, version: 1, eol: text.includes('\r\n') ? 2 : 1, isDirty: false, text,
            getText() { return this.text; }, positionAt(offset) { return offset; },
            async save() {
              await fs.writeFile(key, this.text);
              this.isDirty = false;
              return true;
            } };
          documents.set(key, document);
        }
        return documents.get(key);
      },
      applyEdit: async (edit) => {
        for (const entry of edit.edits) {
          const document = documents.get(entry.documentUri.fsPath);
          document.text = entry.text;
          document.version += 1;
          document.isDirty = true;
        }
        return true;
      } }
  };
  return vscode;
}

async function nativeUpdateFixture(context) {
  const sample = await fixture(context);
  const vscode = editorApi(sample.projectRoot);
  const openTextDocument = vscode.workspace.openTextDocument;
  vscode.workspace.openTextDocument = async (input) => input?.language ?
    { uri: { scheme: 'untitled', fsPath: `untitled:${Math.random()}` }, getText: () => input.content } : openTextDocument(input);
  vscode.LanguageModelToolResult = class { constructor(content) { this.content = content; } };
  vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  vscode.commands = { diffs: [], executeCommand: async (name, before, after) => {
    assert.equal(name, 'vscode.diff');
    vscode.commands.diffs.push({ before, after });
  } };
  let resolverCalls = 0;
  const tool = new UpdateDependenciesTool(vscode, { npmResolver: async ({ cwd }) => {
    resolverCalls += 1;
    const lock = JSON.parse(await fs.readFile(path.join(cwd, 'package-lock.json'), 'utf8'));
    lock.packages[''].dependencies.alpha = '1.1.0';
    lock.packages['node_modules/alpha'] = record('alpha', '1.1.0');
    await fs.writeFile(path.join(cwd, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    return { exitCode: 0 };
  } });
  const invoke = async (input) => JSON.parse((await tool.invoke({ input })).content[0].value);
  return { ...sample, vscode, tool, invoke, resolverCalls: () => resolverCalls };
}

test('dependency update resolution and exact two-file write each require a separate approval', async (context) => {
  const sample = await nativeUpdateFixture(context);
  const before = await Promise.all(sample.matches.map((file) => fs.readFile(file.fsPath)));
  const prepare = () => sample.invoke({ phase: 'prepare', projectRoot: sample.projectRoot,
    updates: [{ name: 'alpha', version: '1.1.0' }] });
  let preview = await prepare();
  assert.equal(preview.status, 'awaiting-decision');
  assert.equal(preview.resolutionAttempted, false);
  assert.match(preview.resolution.transitiveMetadata, /not known before resolution/);
  assert.equal(sample.resolverCalls(), 0);
  assert.equal((await sample.invoke({ phase: 'resolve', previewId: preview.previewId, decision: 'reject' })).status, 'cancelled');
  assert.equal(sample.resolverCalls(), 0);
  assert.deepEqual(await Promise.all(sample.matches.map((file) => fs.readFile(file.fsPath))), before);

  preview = await prepare();
  const diff = await sample.invoke({ phase: 'resolve', previewId: preview.previewId, decision: 'approve' });
  assert.equal(diff.status, 'awaiting-decision');
  assert.equal(diff.stage, 'exact-diff');
  assert.equal(diff.diffs.length, 2);
  assert.equal(sample.vscode.commands.diffs.length, 2);
  assert.equal(sample.resolverCalls(), 1);
  assert.deepEqual(await Promise.all(sample.matches.map((file) => fs.readFile(file.fsPath))), before);
  assert.equal((await sample.invoke({ phase: 'apply', previewId: diff.previewId, decision: 'reject' })).status, 'cancelled');
  assert.deepEqual(await Promise.all(sample.matches.map((file) => fs.readFile(file.fsPath))), before);

  preview = await prepare();
  const approvedDiff = await sample.invoke({ phase: 'resolve', previewId: preview.previewId, decision: 'approve' });
  const applied = await sample.invoke({ phase: 'apply', previewId: approvedDiff.previewId, decision: 'approve' });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.dependencyWritten, true);
  assert.equal(applied.files.length, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(sample.projectRoot, 'package.json'), 'utf8')).dependencies.alpha, '1.1.0');
  assert.equal(JSON.parse(await fs.readFile(path.join(sample.projectRoot, 'package-lock.json'), 'utf8'))
    .packages['node_modules/alpha'].version, '1.1.0');
});

test('approved exact dependency diff applies manifest and lock together after freshness checks', async (context) => {
  const sample = await fixture(context);
  const { resolved } = await resolveFixture(sample);
  const vscode = editorApi(sample.projectRoot);
  const result = await applyDependencyUpdate(vscode, resolved);
  assert.equal(result.status, 'applied');
  assert.equal(result.dependencyWritten, true);
  assert.equal(result.files.length, 2);
  const manifest = JSON.parse(await fs.readFile(path.join(sample.projectRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(sample.projectRoot, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies.alpha, '1.1.0');
  assert.equal(lock.packages['node_modules/alpha'].version, '1.1.0');
});

test('stale source after resolution prevents all dependency writes', async (context) => {
  const sample = await fixture(context);
  const { resolved } = await resolveFixture(sample);
  await fs.appendFile(path.join(sample.projectRoot, 'package.json'), '\n');
  const result = await applyDependencyUpdate(editorApi(sample.projectRoot), resolved);
  assert.equal(result.status, 'stale');
  assert.equal(result.dependencyWritten, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(sample.projectRoot, 'package-lock.json'), 'utf8'))
    .packages['node_modules/alpha'].version, '1.0.0');
});

test('CRLF package files retain their line endings across the generated diff and apply', async (context) => {
  const sample = await fixture(context, { crlf: true });
  const { resolved } = await resolveFixture(sample);
  for (const file of resolved.files) {
    const text = file.after.toString('utf8');
    assert.match(text, /\r\n/);
    assert.doesNotMatch(text, /(?<!\r)\n/);
  }
  const applied = await applyDependencyUpdate(editorApi(sample.projectRoot), resolved);
  assert.equal(applied.status, 'applied');
  for (const file of resolved.files) assert.deepEqual(await fs.readFile(file.filePath), file.after);
});

test('rejected multi-file workspace edit reports observed bytes rather than assuming no write', async (context) => {
  const sample = await fixture(context);
  const { resolved } = await resolveFixture(sample);
  const vscode = editorApi(sample.projectRoot);
  vscode.workspace.applyEdit = async () => false;
  const result = await applyDependencyUpdate(vscode, resolved);
  assert.equal(result.status, 'failed');
  assert.equal(result.dependencyWritten, false);
  assert.ok(result.files.every((file) => file.actualHash === file.beforeHash));
});
