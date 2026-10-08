'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isUriWithinRoot, resolveWorkspaceRoot } = require('./workspace-scope');

function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string' ||
      relativePath.length === 0 ||
      relativePath.includes('\\') ||
      path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath ||
      relativePath.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw new Error('Evidence paths must be normalized, project-relative paths using forward slashes.');
  }
}

async function readSourceEvidence(vscode, input, token) {
  const root = await resolveWorkspaceRoot(input.projectRoot, vscode.workspace.workspaceFolders);
  const results = [];

  for (const request of input.requests ?? []) {
    if (token?.isCancellationRequested) {
      return { status: 'cancelled', results };
    }
    validateRelativePath(request.path);
    if (!Number.isInteger(request.startLine) ||
        !Number.isInteger(request.endLine) ||
        request.startLine < 1 ||
        request.endLine < request.startLine) {
      throw new Error('Evidence line ranges must use positive, inclusive, one-based line numbers.');
    }

    const uri = vscode.Uri.joinPath(root.uri, ...request.path.split('/'));
    if (!(await isUriWithinRoot(root, uri))) {
      throw new Error(`Evidence path is outside the selected project root: ${request.path}`);
    }

    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const lines = content.split(/\r?\n/);
    if (request.endLine > lines.length) {
      throw new Error(`Evidence range exceeds the file length: ${request.path}`);
    }

    results.push({
      path: request.path,
      startLine: request.startLine,
      endLine: request.endLine,
      content: lines.slice(request.startLine - 1, request.endLine).join('\n')
    });
  }

  return { status: 'ready', results };
}

class ReadSourceEvidenceTool {
  constructor(vscode) {
    this.vscode = vscode;
  }

  async prepareInvocation(options) {
    const count = options.input.requests?.length ?? 0;
    return {
      invocationMessage: `Reading ${count} in-root source evidence range${count === 1 ? '' : 's'}`
    };
  }

  async invoke(options, token) {
    const result = await readSourceEvidence(this.vscode, options.input, token);
    return new this.vscode.LanguageModelToolResult([
      new this.vscode.LanguageModelTextPart(JSON.stringify(result))
    ]);
  }
}

module.exports = { ReadSourceEvidenceTool, readSourceEvidence, validateRelativePath };
