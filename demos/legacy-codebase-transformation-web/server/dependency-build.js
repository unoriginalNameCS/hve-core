'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const semver = require('semver');
const { DEPENDENCY_LIMITS, UPDATE_LEVELS, packagePathName, publicResolution, validPackageName } = require('./dependency-review');

const MAX_SELECTED_UPDATES = 10;
const MAX_RESOLUTION_MS = 90000;
const MAX_INSTALL_MS = 180000;
const MAX_BUILD_MS = 120000;
const MAX_TEST_MS = 180000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const REGISTRY = 'https://registry.npmjs.org/';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fault(code) {
  const error = new Error(`Dependency build ${code}.`);
  error.code = code;
  return error;
}

function parseObject(bytes) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  if (!object(value)) throw fault('invalid-json');
  return value;
}

function updateEvidence(assessment, inventory, selection) {
  const packageName = selection?.name;
  if (!object(selection) || Object.keys(selection).some((key) => !['name', 'level'].includes(key)) ||
      !validPackageName(packageName) || !UPDATE_LEVELS.includes(selection.level)) throw fault('invalid-selection');
  const registry = assessment.registry.find((entry) => entry.name === packageName && entry.status === 'completed');
  const declaration = registry?.declarations.find((entry) => entry.manifest === inventory.rootManifest &&
    entry.lockedVersions.length === 1);
  const option = declaration?.updateOptions?.find((entry) => entry.level === selection.level &&
    entry.status === 'completed' && !entry.deprecated);
  if (!option) throw fault('candidate-unavailable');
  const fromVersion = declaration.lockedVersions[0];
  const toVersion = option.version;
  if (semver.valid(fromVersion) !== fromVersion || semver.valid(toVersion) !== toVersion || !semver.gt(toVersion, fromVersion)) {
    throw fault('candidate-invalid');
  }
  return { name: packageName, fromVersion, fromSpec: declaration.spec, version: toVersion, level: option.level, groups: declaration.groups };
}

function normalizeUpdates(selections, assessment, inventory) {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > MAX_SELECTED_UPDATES ||
      new Set(selections.map((item) => item?.name)).size !== selections.length) throw fault('invalid-selection');
  return selections.map((selection) => updateEvidence(assessment, inventory, selection)).sort((left, right) => left.name.localeCompare(right.name));
}

function encodeJson(originalBytes, value) {
  const original = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /(?:\r?\n)$/.test(original);
  let output = JSON.stringify(value, null, 2).replace(/\n/g, newline);
  if (trailingNewline) output += newline;
  const bom = originalBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? originalBytes.subarray(0, 3) : Buffer.alloc(0);
  return Buffer.concat([bom, Buffer.from(output, 'utf8')]);
}

function publicLock(lock) {
  for (const [location, record] of Object.entries(lock.packages ?? {})) {
    if (!location) continue;
    const name = packagePathName(location);
    if (!name || !object(record) || record.link || publicResolution(record, name) !== 'public' ||
        typeof record.integrity !== 'string' || !record.integrity.startsWith('sha512-')) {
      throw fault('unsupported-lock-origin');
    }
  }
}

function changedLockEntries(before, after) {
  const locations = [...new Set([...Object.keys(before.packages ?? {}), ...Object.keys(after.packages ?? {})])]
    .filter((location) => location !== '').sort();
  return locations.flatMap((location) => {
    const from = before.packages?.[location]?.version ?? null;
    const to = after.packages?.[location]?.version ?? null;
    if (from === to) return [];
    return [{ name: packagePathName(location) ?? '(unsupported lock entry)', path: location, from, to }];
  });
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter((candidate) => typeof candidate === 'string' && path.basename(candidate).toLowerCase() === 'npm-cli.js');
  return candidates.find((candidate) => require('node:fs').existsSync(candidate));
}

function processEnvironment(tempRoot) {
  const environment = {};
  const allowed = process.platform === 'win32' ?
    ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT'] : ['PATH', 'TMPDIR'];
  for (const name of allowed) if (process.env[name]) environment[name] = process.env[name];
  environment.HOME = tempRoot;
  environment.USERPROFILE = tempRoot;
  environment.CI = '1';
  environment.NO_COLOR = '1';
  return environment;
}

function runNpm(args, cwd, stage, options = {}) {
  const timeoutMs = options.timeoutMs ?? (stage === 'resolve' ? MAX_RESOLUTION_MS : stage === 'install' ? MAX_INSTALL_MS :
    stage === 'test' ? MAX_TEST_MS : MAX_BUILD_MS);
  if (options.runCommand) return options.runCommand({ args: ['npm', ...args], cwd, stage, timeoutMs });
  const cli = npmCliPath();
  if (!cli) return Promise.reject(fault('npm-unavailable'));
  const env = processEnvironment(options.tempRoot ?? os.tmpdir());
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    let outputBytes = 0;
    let finished = false;
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    const terminate = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (process.platform === 'win32' && child.pid && env.SystemRoot) {
        const taskkill = spawn(path.join(env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
        taskkill.on('error', () => child.kill());
      } else child.kill('SIGKILL');
      resolve({ exitCode: null, timedOut: code === 'timeout', output: output.slice(-MAX_OUTPUT_BYTES), reason: code });
    };
    const consume = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { terminate('output-limit'); return; }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ exitCode: null, output: output.slice(-MAX_OUTPUT_BYTES), reason: 'spawn-failed' });
    });
    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ exitCode: Number.isInteger(code) ? code : null, output: output.slice(-MAX_OUTPUT_BYTES), reason: null });
    });
  });
}

async function writeProjectFiles(files, rootName, tempRoot) {
  const projectRoot = path.join(tempRoot, rootName);
  await fs.mkdir(projectRoot, { recursive: true, mode: 0o700 });
  const controlledConfigs = ['.npmrc', 'user.npmrc', 'global.npmrc'];
  for (const [relativePath, content] of files) {
    const parts = relativePath.split('/');
    if (parts[0] !== rootName || parts.some((part) => !part || part === '.' || part === '..')) throw fault('invalid-path');
    if (parts.length === 2 && controlledConfigs.includes(parts[1].toLowerCase())) continue;
    const target = path.resolve(tempRoot, ...parts);
    if (!target.startsWith(`${path.resolve(tempRoot)}${path.sep}`)) throw fault('invalid-path');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 });
  }
  for (const config of controlledConfigs) {
    await fs.writeFile(path.join(projectRoot, config), '', { flag: 'wx', mode: 0o600 });
  }
  return projectRoot;
}

function npmOptions() {
  return [
    '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`,
    '--userconfig=user.npmrc', '--globalconfig=global.npmrc', '--cache=.npm-cache'
  ];
}

function projectTestScript(manifest) {
  const script = manifest?.scripts?.test;
  return typeof script === 'string' && script.trim() && !/no test specified/i.test(script) ? script : null;
}

async function checkProject(files, rootName, { build = true, test = false } = {}, options = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-update-check-'));
  const failed = (stage, result) => ({ status: 'failed', stage, reason: result.reason || `${stage}-failed`,
    output: result.output, timedOut: Boolean(result.timedOut) });
  try {
    const projectRoot = await writeProjectFiles(files, rootName, tempRoot);
    const install = await runNpm(['ci', ...npmOptions()], projectRoot, 'install', { ...options, tempRoot });
    if (install.exitCode !== 0) return failed('install', install);
    let output = '';
    if (build) {
      const result = await runNpm(['--ignore-scripts', 'run', 'build'], projectRoot, 'build', { ...options, tempRoot });
      if (result.exitCode !== 0) return failed('build', result);
      output = result.output;
    }
    let tests = null;
    if (test) {
      const result = await runNpm(['--ignore-scripts', 'run', 'test'], projectRoot, 'test', { ...options, tempRoot });
      tests = { status: result.exitCode === 0 ? 'passed' : 'failed', output: result.output,
        timedOut: Boolean(result.timedOut), reason: result.reason ?? null };
    }
    return { status: 'passed', stage: build ? 'build' : 'install', output, tests };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function projectTestSummary(baseline, upgraded) {
  if (!baseline) return { status: 'not-available', command: null, baseline: null, upgraded: null };
  const command = 'npm --ignore-scripts run test';
  if (baseline.status !== 'passed') {
    return { status: 'not-gating', command, baseline, upgraded,
      reason: 'Project tests did not pass on the original upload, so they cannot gate the update.' };
  }
  if (!upgraded) return { status: 'not-run', command, baseline, upgraded: null };
  return { status: upgraded.status, command, baseline, upgraded };
}

async function baselineTests(staged, options) {
  if (!staged.testScript) return null;
  const result = await checkProject(staged.baselineFiles, staged.rootName, { build: false, test: true }, options);
  return result.status === 'passed' ? result.tests : { status: 'unavailable', output: result.output, reason: result.reason };
}

async function prepareDependencyBuild(session, selectedNames, options = {}) {
  const inventory = session.dependencyInventory;
  const rootManifest = `${session.rootName}/package.json`;
  const rootLock = `${session.rootName}/package-lock.json`;
  if (!inventory.buildAvailable || inventory.gaps.length || !inventory.documents.some((document) => document.path === rootManifest) ||
      !inventory.documents.some((document) => document.path === rootLock)) throw fault('unsupported-package-root');
  const manifestBytes = session.files.get(rootManifest);
  const lockBytes = session.files.get(rootLock);
  if (!manifestBytes || !lockBytes) throw fault('missing-package-files');
  const manifest = parseObject(manifestBytes);
  const lock = parseObject(lockBytes);
  if (manifest.workspaces !== undefined || typeof manifest.scripts?.build !== 'string' || !manifest.scripts.build.trim() ||
      ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages)) throw fault('build-unavailable');
  publicLock(lock);
  const updates = normalizeUpdates(selectedNames, session.dependencyAssessment, { ...inventory, rootManifest });
  const packageAfter = structuredClone(manifest);
  for (const update of updates) for (const group of update.groups) packageAfter[group][update.name] = update.version;
  const files = new Map(options.sourceFiles ?? session.files);
  files.set(rootManifest, encodeJson(manifestBytes, packageAfter));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-update-resolve-'));
  let resolution;
  try {
    const projectRoot = await writeProjectFiles(new Map([[rootManifest, files.get(rootManifest)], [rootLock, lockBytes]]), session.rootName, tempRoot);
    resolution = await runNpm(['install', '--package-lock-only', ...npmOptions()], projectRoot, 'resolve', { ...options, tempRoot });
    if (resolution.exitCode !== 0) {
      return { status: 'failed', reason: resolution.reason || 'resolution-failed', output: resolution.output,
        timedOut: Boolean(resolution.timedOut), selectedUpdates: updates.map(({ name, fromVersion, version, level }) => ({ name, fromVersion, version, level })) };
    }
    const resolvedManifestBytes = await fs.readFile(path.join(projectRoot, 'package.json'));
    const resolvedLockBytes = await fs.readFile(path.join(projectRoot, 'package-lock.json'));
    const resolvedManifest = parseObject(resolvedManifestBytes);
    const resolvedLock = parseObject(resolvedLockBytes);
    if (JSON.stringify(resolvedManifest) !== JSON.stringify(packageAfter) || ![2, 3].includes(resolvedLock.lockfileVersion) ||
        !object(resolvedLock.packages) || await fs.stat(path.join(projectRoot, 'node_modules')).then(() => true, () => false)) {
      throw fault('unexpected-resolution-output');
    }
    publicLock(resolvedLock);
    for (const update of updates) {
      if (resolvedLock.packages[`node_modules/${update.name}`]?.version !== update.version) throw fault('lock-version-mismatch');
    }
    files.set(rootLock, resolvedLockBytes);
    const lockChanges = changedLockEntries(lock, resolvedLock);
    const previewId = require('node:crypto').randomUUID();
    const testScript = projectTestScript(manifest);
    const preview = {
      id: previewId,
      rootName: session.rootName,
      files,
      baselineFiles: new Map(session.files),
      testScript,
      updates,
      packageDiff: updates.map(({ name, fromVersion, fromSpec, version, level }) => ({ name, fromVersion, fromSpec, version, level })),
      lockChanges: lockChanges.slice(0, 200),
      omittedLockChanges: Math.max(0, lockChanges.length - 200),
      sourceFindings: options.sourceFindings ?? 0,
      buildScript: manifest.scripts.build,
      createdAt: Date.now(),
      consumed: false
    };
    return {
      status: 'ready', previewId,
      packageDiff: preview.packageDiff,
      lockChanges: preview.lockChanges,
      omittedLockChanges: preview.omittedLockChanges,
      sourceFindings: preview.sourceFindings,
      build: {
        install: 'npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --userconfig=user.npmrc --globalconfig=global.npmrc --cache=.npm-cache',
        command: 'npm --ignore-scripts run build',
        script: manifest.scripts.build,
        tests: testScript ? 'npm --ignore-scripts run test' : 'not available',
        testScript,
        warning: 'The build and test commands execute uploaded project code. They run in temporary copies, not an OS sandbox.'
      },
      internalPreview: preview
    };
  } catch (error) {
    return { status: 'failed', reason: error.code ?? 'resolution-failed', output: resolution?.output ?? '' };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function runApprovedBuild(preview, options = {}) {
  if (!preview || preview.status !== 'ready' || !preview.internalPreview || preview.internalPreview.consumed) {
    throw fault('invalid-preview');
  }
  const staged = preview.internalPreview;
  staged.consumed = true;
  const baseline = await baselineTests(staged, options);
  const result = await checkProject(staged.files, staged.rootName, { build: true, test: Boolean(staged.testScript) }, options);
  if (result.status !== 'passed') {
    return { ...result, tests: projectTestSummary(baseline, null), baselineTests: baseline };
  }
  const tests = projectTestSummary(baseline, result.tests);
  if (tests.status === 'failed') {
    return { status: 'failed', stage: 'tests', reason: 'tests-failed', output: result.tests.output,
      timedOut: result.tests.timedOut, tests, baselineTests: baseline };
  }
  return {
    status: 'passed', stage: 'build', output: result.output,
    tests, baselineTests: baseline, files: staged.files, updatedFiles: staged.files.size, updates: staged.updates
  };
}

module.exports = {
  MAX_BUILD_MS,
  MAX_INSTALL_MS,
  MAX_OUTPUT_BYTES,
  MAX_RESOLUTION_MS,
  MAX_TEST_MS,
  checkProject,
  normalizeUpdates,
  npmOptions,
  processEnvironment,
  prepareDependencyBuild,
  projectTestScript,
  projectTestSummary,
  runNpm,
  runApprovedBuild,
  writeProjectFiles
};
