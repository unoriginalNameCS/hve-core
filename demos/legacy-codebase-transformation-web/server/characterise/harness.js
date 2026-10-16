'use strict';

const { spawn } = require('node:child_process');
const { builtinModules } = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const traverse = require('@babel/traverse').default;
const { npmOptions, processEnvironment, runNpm, writeProjectFiles } = require('../dependency-build');
const { parseSource } = require('../assess/parse');
const { describeDifferences } = require('./diff');

const CASE_TIMEOUT_MS = 5000;
const MAX_CASE_OUTPUT_BYTES = 128 * 1024;
const BUILTIN_NAMES = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]));
const SERVER_DIRECTORY = __dirname;

function hasTopLevelSideEffects(ast) {
  for (const statement of ast.program.body) {
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ImportDeclaration' ||
        statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') continue;
    let sideEffect = false;
    const wrapper = { type: 'File', program: { type: 'Program', sourceType: 'script', body: [statement], directives: [] } };
    traverse(wrapper, {
      Function(path) { path.skip(); },
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        const isRequire = callee.type === 'Identifier' && callee.name === 'require' &&
          args.length === 1 && args[0].type === 'StringLiteral';
        if (!isRequire) sideEffect = true;
      },
      NewExpression() { sideEffect = true; },
      UpdateExpression() { sideEffect = true; },
      AssignmentExpression(path) {
        const left = path.node.left;
        const isExports = left.type === 'MemberExpression' &&
          ((left.object.type === 'Identifier' && left.object.name === 'exports') ||
           (left.object.type === 'Identifier' && left.object.name === 'module' && left.property.name === 'exports'));
        if (!isExports && statement.type === 'ExpressionStatement') sideEffect = true;
      }
    });
    if (sideEffect) return true;
  }
  return false;
}

function packageRequires(source, relativePath) {
  const parsed = parseSource(source, relativePath);
  if (!parsed.ast) return { parseError: parsed.error, packages: [] };
  const packages = new Set();
  const inspect = (specifier) => {
    if (specifier.startsWith('.') || specifier.startsWith('/') || BUILTIN_NAMES.has(specifier)) return;
    packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
  };
  traverse(parsed.ast, {
    CallExpression(path) {
      if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'require' && path.node.arguments[0]?.type === 'StringLiteral') {
        inspect(path.node.arguments[0].value);
      }
    },
    ImportDeclaration(path) { inspect(path.node.source.value); }
  });
  return { parseError: null, packages: [...packages] };
}

function getInstalledDependencies(files, rootName) {
  const manifestBytes = files.get(`${rootName}/package.json`);
  const lockBytes = files.get(`${rootName}/package-lock.json`);
  if (!manifestBytes) return { needed: false, available: false };
  let manifest;
  try { manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); } catch { return { needed: false, available: false }; }
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  return { needed: Object.keys(declared).length > 0, available: Boolean(lockBytes) };
}

function characterisationEligibility(unit, source) {
  if (unit.kind !== 'function') return { status: 'not-checked', reason: 'Only top-level functions can be characterised.' };
  if (unit.moduleFormat !== 'commonjs' || /\.mjs$/i.test(unit.path)) return { status: 'not-checked', reason: 'ES modules are not supported by the v1 characterisation runner.' };
  const parsed = parseSource(source, unit.path);
  if (!parsed.ast) return { status: 'not-checked', reason: 'The target module could not be parsed.' };
  if (hasTopLevelSideEffects(parsed.ast)) return { status: 'not-checked', reason: 'The module has executable top-level expressions.' };
  return { status: 'eligible', reason: null };
}

function appendTemporaryExport(files, unit) {
  const bytes = files.get(unit.path);
  if (!bytes) throw new Error('Characterisation source file is missing.');
  const source = Buffer.from(bytes).toString('utf8');
  const property = `__characterise_${require('node:crypto').createHash('sha256').update(unit.id).digest('hex').slice(0, 12)}`;
  if (unit.exportNames?.includes(unit.name)) return { files, property: unit.name };
  const updated = new Map(files);
  updated.set(unit.path, Buffer.from(`${source}\nmodule.exports[${JSON.stringify(property)}] = ${unit.name};\n`, 'utf8'));
  return { files: updated, property };
}

async function prepareWorkspace(files, rootName, unit, options = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tech-debt-characterise-'));
  try {
    const prepared = appendTemporaryExport(files, unit);
    const projectRoot = await writeProjectFiles(prepared.files, rootName, tempRoot);
    await fs.copyFile(path.join(SERVER_DIRECTORY, 'runner.cjs'), path.join(tempRoot, 'runner.cjs'));
    await fs.copyFile(path.join(SERVER_DIRECTORY, 'serialise.js'), path.join(tempRoot, 'serialise.cjs'));

    const source = Buffer.from(files.get(unit.path)).toString('utf8');
    const packages = packageRequires(source, unit.path).packages;
    if (packages.length) {
      const deps = getInstalledDependencies(files, rootName);
      if (!deps.needed || !deps.available) return { status: 'not-checked', reason: 'npm ci requires a complete package-lock.json.', tempRoot };
      let install;
      try {
        install = await runNpm(['ci', ...npmOptions()], projectRoot, 'install', {
          tempRoot,
          timeoutMs: options.installTimeoutMs,
          runCommand: options.runCommand
        });
      } catch {
        return { status: 'not-checked', reason: 'npm ci could not run in the temporary project copy.', tempRoot };
      }
      if (install.exitCode !== 0) return { status: 'not-checked', reason: install.timedOut ? 'npm ci timed out.' : 'npm ci failed in the temporary project copy.', tempRoot };
    }
    const modulePath = path.join(projectRoot, ...unit.path.slice(rootName.length + 1).split('/'));
    return { status: 'ready', tempRoot, projectRoot, modulePath, exportName: prepared.property };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function runChildCase(workspace, args, options = {}) {
  if (options.executeCase) return options.executeCase(workspace, args);
  const timeoutMs = options.timeoutMs ?? CASE_TIMEOUT_MS;
  const runnerPath = path.join(workspace.tempRoot, 'runner.cjs');
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${workspace.tempRoot}`, runnerPath], {
    cwd: workspace.projectRoot,
    env: processEnvironment(workspace.tempRoot),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let reason = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const kill = (failure) => {
      if (settled) return;
      reason = failure;
      child.kill();
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CASE_OUTPUT_BYTES) { kill('output-limit'); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CASE_OUTPUT_BYTES) { kill('output-limit'); return; }
      stderr += chunk.toString('utf8');
    });
    child.once('error', () => finish({ status: 'failed', reason: 'spawn-failed' }));
    child.once('close', (code) => {
      if (reason) { finish({ status: reason, output: stderr }); return; }
      if (code !== 0) { finish({ status: 'failed', reason: 'child-failed' }); return; }
      try {
        const outcome = JSON.parse(stdout);
        if (outcome.moduleError) finish({ status: 'failed', reason: 'module-error', outcome });
        else finish({ status: 'passed', outcome });
      } catch {
        finish({ status: 'failed', reason: 'invalid-runner-output', output: stderr });
      }
    });
    child.stdin.end(JSON.stringify({ modulePath: workspace.modulePath, exportName: workspace.exportName, args }));
  });
}

async function captureBaseline(files, rootName, unit, cases, options = {}) {
  if (!Array.isArray(cases) || cases.length !== 5 || cases.some((item) => !item || !Array.isArray(item.args))) {
    return { status: 'not-checked', reason: 'Exactly five JSON argument cases are required.' };
  }
  const source = Buffer.from(files.get(unit.path) ?? '').toString('utf8');
  const eligibility = characterisationEligibility(unit, source);
  if (eligibility.status !== 'eligible') return eligibility;
  const workspace = await prepareWorkspace(files, rootName, unit, options);
  if (workspace.status !== 'ready') {
    await fs.rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => {});
    return { status: workspace.status, reason: workspace.reason };
  }

  try {
    const stableCases = [];
    for (const [index, item] of cases.entries()) {
      options.onProgress?.({ stage: 'baseline', case: index + 1, total: cases.length });
      const first = await runChildCase(workspace, item.args, options);
      if (first.status !== 'passed') continue;
      const second = await runChildCase(workspace, item.args, options);
      if (second.status === 'passed' && JSON.stringify(first.outcome) === JSON.stringify(second.outcome)) {
        stableCases.push({ description: item.description, args: item.args, expected: first.outcome });
      }
    }
    if (stableCases.length < 3) return { status: 'not-checked', reason: `Only ${stableCases.length} stable cases remained; at least three are required.`, cases: stableCases };
    return { status: 'passed', cases: stableCases, requestedCases: cases.length, stableCases: stableCases.length };
  } finally {
    await fs.rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function compareRewrite(files, rootName, unit, baseline, options = {}) {
  if (baseline?.status !== 'passed' || !baseline.cases?.length) return { status: 'not-checked', reason: 'No stable baseline is available.', cases: [] };
  const workspace = await prepareWorkspace(files, rootName, unit, options);
  if (workspace.status !== 'ready') {
    await fs.rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => {});
    return { status: workspace.status, reason: workspace.reason, cases: [] };
  }
  try {
    const results = [];
    for (const [index, item] of baseline.cases.entries()) {
      options.onProgress?.({ stage: 'comparison', case: index + 1, total: baseline.cases.length });
      const actual = await runChildCase(workspace, item.args, options);
      const passed = actual.status === 'passed' && JSON.stringify(actual.outcome) === JSON.stringify(item.expected);
      const actualOutcome = actual.outcome ?? { status: actual.status, reason: actual.reason };
      results.push({ description: item.description, args: item.args, expected: item.expected,
        actual: actualOutcome, passed, differences: passed ? [] : describeDifferences(item.expected, actualOutcome) });
    }
    return { status: results.every((item) => item.passed) ? 'passed' : 'failed', cases: results };
  } finally {
    await fs.rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { CASE_TIMEOUT_MS, MAX_CASE_OUTPUT_BYTES, captureBaseline, characterisationEligibility, compareRewrite, hasTopLevelSideEffects, packageRequires, runChildCase };
