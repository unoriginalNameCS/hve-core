'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { validateRelativePath } = require('./source-evidence');
const { isPathWithinRoot } = require('./workspace-scope');

const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const OTHER_LOCKS = new Set(['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'coverage', 'generated', 'out', 'target']);
const MAX_PROJECT_FILES = 500;
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;
const MAX_LOCK_PACKAGES = 200;
const MAX_NODE_MODULES_FILES = 50000;
const MAX_NODE_MODULES_BYTES = 256 * 1024 * 1024;
const MAX_NPM_MS = 180000;
const MAX_NPM_OUTPUT_BYTES = 128 * 1024;
const REGISTRY = 'https://registry.npmjs.org/';
const SUPPORTED_NODE_VERSION = /^v24\.19\.\d+$/;
const SAFE_VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function excludedPath(relativePath) {
  return relativePath.split('/').some((segment) => segment.startsWith('.') || EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));
}

function credentialFile(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return ['credentials.json', 'secrets.json', 'service-account.json', 'id_rsa', 'id_ed25519'].includes(basename) ||
    /\.(?:pem|key|p12|pfx|crt|cer)$/i.test(basename);
}

async function collectProjectFiles(projectRoot) {
  const rootPath = await fs.realpath(projectRoot);
  const files = new Map();
  let bytes = 0;
  async function visit(directory, relativeDirectory) {
    for await (const entry of await fs.opendir(directory)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (excludedPath(relativePath) || credentialFile(relativePath)) continue;
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are unsupported in the test workspace: ${relativePath}`);
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported project entry in the test workspace: ${relativePath}`);
      if (files.size >= MAX_PROJECT_FILES) throw new Error('The test workspace exceeds the 500-file limit.');
      bytes += stat.size;
      if (bytes > MAX_PROJECT_BYTES) throw new Error('The test workspace exceeds the 25 MB source limit.');
      files.set(relativePath, await fs.readFile(absolutePath));
    }
  }
  await visit(rootPath, '');
  return { rootPath, files, bytes };
}

function packageNameFromLockPath(location) {
  if (typeof location !== 'string' || location.includes('\\')) return null;
  const parts = location.split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index < 0 || index + 1 >= parts.length) return null;
  let name = parts[index + 1];
  if (name.startsWith('@')) {
    if (!parts[index + 2]) return null;
    name += `/${parts[index + 2]}`;
  }
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null;
}

function validPublicTarball(record, name) {
  if (typeof record.resolved !== 'string' || typeof record.version !== 'string' ||
  !SAFE_VERSION_TEXT.test(record.version) || record.link === true) return false;
  try {
    const url = new URL(record.resolved);
    const basename = name.split('/').at(-1);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      decodeURIComponent(url.pathname) === `/${name}/-/${basename}-${record.version}.tgz`;
  } catch {
    return false;
  }
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function validateNpmProject(files) {
  const manifestBytes = files.get('package.json');
  const lockBytes = files.get('package-lock.json');
  const managerFile = [...OTHER_LOCKS].find((name) => files.has(name));
  if (managerFile) throw new Error(`Only a single-root npm project is supported; found ${managerFile}.`);
  if (!manifestBytes) {
    if (lockBytes) throw new Error('A root package-lock.json requires a matching package.json.');
    return { installRequired: false, packageCount: 0, manifestHash: null, lockHash: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The root package.json is unreadable or invalid.');
  }
  if (!object(manifest) || manifest.workspaces !== undefined ||
      manifest.packageManager !== undefined && (typeof manifest.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(manifest.packageManager))) {
    throw new Error('Only a single-root npm package without workspace or conflicting package-manager configuration is supported.');
  }
  const hasDependencies = GROUPS.some((group) => {
    const value = manifest[group];
    return value !== undefined && (!object(value) || Object.keys(value).length > 0);
  });
  if (!lockBytes) {
    if (hasDependencies) throw new Error('A supported package-lock.json is required to install test dependencies.');
    return { installRequired: false, packageCount: 0, manifestHash: digest(manifestBytes), lockHash: null };
  }

  let lock;
  try {
    lock = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockBytes).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The root package-lock.json is unreadable or invalid.');
  }
  if (!object(lock) || ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages) ||
      !object(lock.packages[''])) {
    throw new Error('Only a valid single-root npm lock v2 or v3 is supported.');
  }
  const rootPackage = lock.packages[''];
  if (manifest.name && lock.name && manifest.name !== lock.name ||
      manifest.version && lock.version && manifest.version !== lock.version) {
    throw new Error('The root package-lock.json identity does not match package.json.');
  }
  for (const group of GROUPS) {
    if (JSON.stringify(sortedObject(manifest[group])) !== JSON.stringify(sortedObject(rootPackage[group]))) {
      throw new Error(`The package-lock.json root ${group} does not match package.json.`);
    }
  }

  const tuples = new Set();
  for (const [location, record] of Object.entries(lock.packages)) {
    if (location === '') continue;
    const pathName = packageNameFromLockPath(location);
    const name = record?.name ?? pathName;
    if (!pathName || !object(record) || typeof name !== 'string' ||
        pathName !== name && record.name !== undefined || !validPublicTarball(record, name)) {
      throw new Error('Every locked package must resolve to its exact public npm tarball; local, linked, or non-public packages are unsupported.');
    }
    tuples.add(`${name}@${record.version}`);
    if (tuples.size > MAX_LOCK_PACKAGES) throw new Error('The package lock exceeds the 200-package limit.');
  }
  if (hasDependencies && tuples.size === 0) throw new Error('The package lock has no package records for declared dependencies.');
  if (!hasDependencies && tuples.size > 0) throw new Error('The package lock contains packages but package.json declares no dependencies.');
  return { installRequired: hasDependencies, packageCount: tuples.size,
    manifestHash: digest(manifestBytes), lockHash: digest(lockBytes) };
}

async function inspectNodeTestProject(projectRoot, testFilePath) {
  validateRelativePath(testFilePath);
  if (!/\.(?:js|cjs|mjs)$/i.test(testFilePath)) throw new Error('The selected Node test must be a .js, .cjs, or .mjs file.');
  const inventory = await collectProjectFiles(projectRoot);
  if (!inventory.files.has(testFilePath)) throw new Error('The selected test file is excluded or missing from the project copy.');
  const npmProject = validateNpmProject(inventory.files);
  return {
    rootPath: inventory.rootPath, installRequired: npmProject.installRequired,
    packageCount: npmProject.packageCount,
    manifestHash: npmProject.manifestHash, lockHash: npmProject.lockHash,
    testFileHash: digest(inventory.files.get(testFilePath))
  };
}

function getEnvValue(env, name) {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function safeProcessEnvironment(tempRoot, source = process.env) {
  const allowed = process.platform === 'win32' ?
    ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT'] : ['PATH', 'TMPDIR'];
  const env = {};
  for (const name of allowed) {
    const value = getEnvValue(source, name);
    if (value) env[name] = value;
  }
  env.HOME = tempRoot;
  env.USERPROFILE = tempRoot;
  env.TMPDIR = tempRoot;
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  env.CI = '1';
  env.NO_COLOR = '1';
  return env;
}

async function resolveNodeExecutable(env = process.env) {
  const pathValue = getEnvValue(env, 'PATH');
  if (typeof pathValue !== 'string') throw new Error('Node.js was not found on PATH.');
  const windows = process.platform === 'win32';
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), windows ? 'node.exe' : 'node');
    try {
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch {}
  }
  throw new Error('Node.js was not found on PATH.');
}

async function resolveNpmCli(nodeExecutable) {
  const directory = path.dirname(nodeExecutable);
  const candidates = [
    path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch {}
  }
  throw new Error('Could not find npm CLI alongside the Node.js executable on PATH.');
}

function runBoundedProcess(executable, args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const env = options.env ?? {};
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let finished = false;
    let reason = null;
    const child = spawnProcess(executable, args, {
      cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stop = (failure) => {
      if (finished || reason) return;
      reason = failure;
      if (process.platform === 'win32' && child.pid && env.SystemRoot) {
        const killer = spawn(path.join(env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const subscription = options.token?.onCancellationRequested?.(() => stop('cancelled'));
    const consume = (stream) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        stop('output-limit');
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', consume('stdout'));
    child.stderr?.on('data', consume('stderr'));
    child.once('error', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        subscription?.dispose();
        resolve({ command: [executable, ...args], exitCode: null, stdout, stderr, reason: reason ?? 'spawn-failed' });
      }
    });
    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.dispose();
      resolve({ command: [executable, ...args], exitCode: reason ? null : code, stdout, stderr, reason });
    });
    if (options.token?.isCancellationRequested) stop('cancelled');
  });
}

async function readSupportedNodeVersion(nodeExecutable, env, options = {}) {
  const runVersion = options.runVersion ?? ((executable, args, runOptions) =>
    runBoundedProcess(executable, args, runOptions));
  const result = await runVersion(nodeExecutable, ['--version'], {
    cwd: options.cwd ?? os.tmpdir(), env, timeoutMs: 5000, maxOutputBytes: 1024, token: options.token
  });
  const runtimeVersion = result.stdout?.trim();
  if (result.exitCode !== 0 || result.reason || !SUPPORTED_NODE_VERSION.test(runtimeVersion ?? '')) {
    throw new Error(`Node.js 24.19.x is required; found ${runtimeVersion || 'an unavailable runtime version'}.`);
  }
  return runtimeVersion;
}

async function measureNodeModules(directory) {
  const metrics = { files: 0, bytes: 0 };
  async function visit(current, root) {
    for await (const entry of await fs.opendir(current)) {
      const filePath = path.join(current, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(filePath);
        if (!isPathWithinRoot(root, resolved)) throw new Error('npm install created a node_modules symlink outside its tree.');
        metrics.files += 1;
        continue;
      }
      if (stat.isDirectory()) await visit(filePath, root);
      else if (stat.isFile()) {
        metrics.files += 1;
        metrics.bytes += stat.size;
      }
      if (metrics.files > MAX_NODE_MODULES_FILES || metrics.bytes > MAX_NODE_MODULES_BYTES) {
        throw new Error('Installed dependencies exceed the 256 MiB or 50,000-file limit.');
      }
    }
  }
  await visit(directory, await fs.realpath(directory));
  return metrics;
}

async function writeProjectFiles(files, destinationRoot) {
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const [relativePath, bytes] of files) {
    validateRelativePath(relativePath);
    const destination = path.resolve(destinationRoot, ...relativePath.split('/'));
    if (!isPathWithinRoot(destinationRoot, destination)) throw new Error('Project copy path escaped its temporary root.');
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
}

async function prepareNodeTestWorkspace(projectRoot, testFilePath, options = {}) {
  validateRelativePath(testFilePath);
  if (!/\.(?:js|cjs|mjs)$/i.test(testFilePath)) throw new Error('The selected Node test must be a .js, .cjs, or .mjs file.');
  const inventory = await collectProjectFiles(projectRoot);
  if (!inventory.files.has(testFilePath)) throw new Error('The selected test file is excluded or missing from the project copy.');
  const npmProject = validateNpmProject(inventory.files);
  const projectHashes = {
    manifestHash: npmProject.manifestHash, lockHash: npmProject.lockHash,
    testFileHash: digest(inventory.files.get(testFilePath))
  };
  if (options.expectedProjectHashes && Object.entries(options.expectedProjectHashes).some(([key, value]) => projectHashes[key] !== value)) {
    throw new Error('The selected test or npm project files changed after confirmation.');
  }
  const tempRoot = await fs.mkdtemp(path.join(options.tempDirectory ?? os.tmpdir(), 'lcta-node-test-'));
  const preparedRoot = path.join(tempRoot, 'prepared');
  const baselineRoot = path.join(tempRoot, 'baseline');
  const transformedRoot = path.join(tempRoot, 'transformed');
  try {
    await writeProjectFiles(inventory.files, preparedRoot);
    const baseEnvironment = options.baseEnvironment ?? process.env;
    const env = safeProcessEnvironment(tempRoot, baseEnvironment);
    const nodeExecutable = options.nodeExecutable ?? await resolveNodeExecutable(baseEnvironment);
    const runtimeVersion = await readSupportedNodeVersion(nodeExecutable, env, {
      cwd: preparedRoot, runVersion: options.runVersion, token: options.token
    });
    let toolchain = { nodeExecutable, runtimeVersion, npmCliPath: null };
    let installResult = null;
    let nodeModules = { files: 0, bytes: 0 };
    if (npmProject.installRequired) {
      const npmCliPath = options.npmCliPath ?? await resolveNpmCli(nodeExecutable);
      toolchain.npmCliPath = npmCliPath;
      const userConfig = path.join(tempRoot, 'user.npmrc');
      const globalConfig = path.join(tempRoot, 'global.npmrc');
      await fs.writeFile(userConfig, '', { flag: 'wx', mode: 0o600 });
      await fs.writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
      const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`,
        `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, `--cache=${path.join(tempRoot, 'npm-cache')}`];
      const runNpm = options.runNpm ?? ((request) => runBoundedProcess(request.nodeExecutable,
        [request.npmCliPath, ...request.args], { cwd: request.cwd, env: request.env,
          timeoutMs: MAX_NPM_MS, maxOutputBytes: MAX_NPM_OUTPUT_BYTES, token: request.token }));
      installResult = await runNpm({ nodeExecutable, npmCliPath, args, cwd: preparedRoot, env, token: options.token });
      if (installResult.exitCode !== 0 || installResult.reason) {
        throw new Error(`npm ci did not complete successfully: ${installResult.reason ?? `exit ${installResult.exitCode}`}.`);
      }
      const nodeModulesPath = path.join(preparedRoot, 'node_modules');
      if (!await fs.stat(nodeModulesPath).then((stat) => stat.isDirectory(), () => false)) {
        throw new Error('npm ci completed without creating node_modules.');
      }
      nodeModules = await measureNodeModules(nodeModulesPath);
    }
    await fs.cp(preparedRoot, baselineRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await fs.cp(preparedRoot, transformedRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    return {
      rootPath: inventory.rootPath, tempRoot, preparedRoot, baselineRoot, transformedRoot,
      testFilePath, installRequired: npmProject.installRequired, installResult, toolchain,
      packageCount: npmProject.packageCount, ...projectHashes,
      sourceFiles: inventory.files.size, sourceBytes: inventory.bytes, nodeModules
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupNodeTestWorkspace(workspace) {
  if (typeof workspace?.tempRoot === 'string') await fs.rm(workspace.tempRoot, { recursive: true, force: true });
}

module.exports = {
  MAX_PROJECT_FILES, MAX_PROJECT_BYTES, MAX_LOCK_PACKAGES, MAX_NODE_MODULES_FILES, MAX_NODE_MODULES_BYTES,
  MAX_NPM_MS, MAX_NPM_OUTPUT_BYTES, collectProjectFiles, packageNameFromLockPath, validPublicTarball,
  validateNpmProject, inspectNodeTestProject, resolveNodeExecutable, resolveNpmCli, safeProcessEnvironment, runBoundedProcess, readSupportedNodeVersion,
  measureNodeModules, prepareNodeTestWorkspace, cleanupNodeTestWorkspace
};
