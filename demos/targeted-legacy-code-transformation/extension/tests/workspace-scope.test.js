'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isPathWithinRoot, isUriWithinRoot, resolveWorkspaceRoot } = require('../src/workspace-scope');

test('workspace root must match an open folder exactly', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-root-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const nestedFolder = path.join(temporaryRoot, 'nested');
  await fs.mkdir(nestedFolder);

  const workspaceFolder = { uri: { scheme: 'file', authority: '', fsPath: temporaryRoot } };
  const selected = await resolveWorkspaceRoot(temporaryRoot, [workspaceFolder]);

  assert.equal(selected.workspaceFolder, workspaceFolder);
  await assert.rejects(
    resolveWorkspaceRoot(nestedFolder, [workspaceFolder]),
    /must match an open VS Code workspace folder/
  );
  await assert.rejects(
    resolveWorkspaceRoot('relative-folder', [workspaceFolder]),
    /must be an absolute path/
  );
});

test('path containment rejects parents and sibling-prefix paths', () => {
  const root = path.join(path.parse(process.cwd()).root, 'lcta-root');

  assert.equal(isPathWithinRoot(root, path.join(root, 'src', 'file.cs')), true);
  assert.equal(isPathWithinRoot(root, root), true);
  assert.equal(isPathWithinRoot(root, path.dirname(root)), false);
  assert.equal(isPathWithinRoot(root, `${root}-outside`, ), false);
});

test('URI containment requires matching scheme and authority', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-uri-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'target.cs');
  await fs.writeFile(filePath, 'class Target {}');

  const root = {
    uri: { scheme: 'file', authority: '', fsPath: temporaryRoot },
    realPath: await fs.realpath(temporaryRoot)
  };

  assert.equal(await isUriWithinRoot(root, { scheme: 'file', authority: '', fsPath: filePath }), true);
  assert.equal(await isUriWithinRoot(root, { scheme: 'vscode-remote', authority: 'ssh-remote+host', fsPath: filePath }), false);
  assert.equal(await isUriWithinRoot(root, { scheme: 'file', authority: 'other', fsPath: filePath }), false);
});

test('URI containment rejects a symlink that resolves outside the root', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-link-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const rootPath = path.join(temporaryRoot, 'root');
  const outsidePath = path.join(temporaryRoot, 'outside');
  const linkPath = path.join(rootPath, 'linked');
  await fs.mkdir(rootPath);
  await fs.mkdir(outsidePath);
  const outsideFile = path.join(outsidePath, 'secret.cs');
  await fs.writeFile(outsideFile, 'class Outside {}');

  try {
    await fs.symlink(outsidePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    context.skip(`Symlink creation is unavailable: ${error.code}`);
    return;
  }

  const root = {
    uri: { scheme: 'file', authority: '', fsPath: rootPath },
    realPath: await fs.realpath(rootPath)
  };

  assert.equal(await isUriWithinRoot(root, { scheme: 'file', authority: '', fsPath: path.join(linkPath, 'secret.cs') }), false);
});
