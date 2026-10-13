'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function normalizePath(value) {
  let resolvedPath = path.resolve(value);
  if (process.platform === 'win32') {
    resolvedPath = resolvedPath
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/, '');
  }
  return path.normalize(resolvedPath);
}

function comparablePath(value) {
  const resolvedPath = normalizePath(value);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function isPathWithinRoot(rootPath, candidatePath) {
  const relativePath = path.relative(normalizePath(rootPath), normalizePath(candidatePath));
  return relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath));
}

async function resolveWorkspaceRoot(projectRoot, workspaceFolders) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('The project root must be an absolute path.');
  }

  const requestedPath = await fs.realpath(projectRoot);
  const requestedKey = comparablePath(requestedPath);
  let workspaceFolder;
  for (const folder of workspaceFolders ?? []) {
    const folderPath = folder?.uri?.fsPath;
    if (typeof folderPath === 'string' &&
        comparablePath(await fs.realpath(folderPath)) === requestedKey) {
      workspaceFolder = folder;
      break;
    }
  }

  if (!workspaceFolder) {
    throw new Error('The project root must match an open VS Code workspace folder.');
  }

  return {
    workspaceFolder,
    uri: workspaceFolder.uri,
    realPath: requestedPath
  };
}

async function isUriWithinRoot(root, candidateUri) {
  if (!root?.uri || !candidateUri ||
      candidateUri.scheme !== root.uri.scheme ||
      candidateUri.authority !== root.uri.authority ||
      typeof candidateUri.fsPath !== 'string') {
    return false;
  }

  try {
    const candidateRealPath = await fs.realpath(candidateUri.fsPath);
    return isPathWithinRoot(root.realPath, candidateRealPath);
  } catch {
    return false;
  }
}

module.exports = {
  isPathWithinRoot,
  isUriWithinRoot,
  resolveWorkspaceRoot
};
