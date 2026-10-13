'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readSourceEvidence } = require('../src/source-evidence');

function makeUri(filePath, scheme = 'file', authority = '') {
  return {
    scheme,
    authority,
    fsPath: filePath,
    path: filePath.split(path.sep).join('/')
  };
}

function makeVscode(rootPath, readPaths) {
  const workspaceFolder = { uri: makeUri(rootPath) };
  return {
    workspace: {
      workspaceFolders: [workspaceFolder],
      fs: {
        readFile: async (uri) => {
          readPaths.push(uri.fsPath);
          return fs.readFile(uri.fsPath);
        }
      }
    },
    Uri: {
      joinPath(baseUri, ...segments) {
        return makeUri(path.join(baseUri.fsPath, ...segments), baseUri.scheme, baseUri.authority);
      }
    }
  };
}

test('source evidence returns only the requested one-based line range', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-evidence-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootPath, 'README.md'), 'first line\nsecond line\nthird line');
  const readPaths = [];
  const result = await readSourceEvidence(makeVscode(rootPath, readPaths), {
    projectRoot: rootPath,
    requests: [{ path: 'README.md', startLine: 2, endLine: 3 }]
  });

  assert.deepEqual(result, {
    status: 'ready',
    results: [{ path: 'README.md', startLine: 2, endLine: 3, content: 'second line\nthird line' }]
  });
  assert.equal(readPaths.length, 1);
});

test('source evidence rejects traversal and invalid ranges before reading', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-evidence-path-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const readPaths = [];
  const vscode = makeVscode(rootPath, readPaths);

  await assert.rejects(
    readSourceEvidence(vscode, {
      projectRoot: rootPath,
      requests: [{ path: '../outside.txt', startLine: 1, endLine: 1 }]
    }),
    /normalized, project-relative paths/
  );
  await assert.rejects(
    readSourceEvidence(vscode, {
      projectRoot: rootPath,
      requests: [{ path: 'missing.txt', startLine: 0, endLine: 1 }]
    }),
    /positive, inclusive, one-based line numbers/
  );
  assert.equal(readPaths.length, 0);
});

test('source evidence refuses a symlink that resolves outside the root without reading it', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-evidence-link-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const rootPath = path.join(temporaryRoot, 'root');
  const outsidePath = path.join(temporaryRoot, 'outside');
  await fs.mkdir(rootPath);
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(outsidePath, 'secret.md'), 'outside');
  const linkedPath = path.join(rootPath, 'linked');
  try {
    await fs.symlink(outsidePath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    context.skip(`Symlink creation is unavailable: ${error.code}`);
    return;
  }

  const readPaths = [];
  await assert.rejects(
    readSourceEvidence(makeVscode(rootPath, readPaths), {
      projectRoot: rootPath,
      requests: [{ path: 'linked/secret.md', startLine: 1, endLine: 1 }]
    }),
    /outside the selected project root/
  );
  assert.equal(readPaths.length, 0);
});
