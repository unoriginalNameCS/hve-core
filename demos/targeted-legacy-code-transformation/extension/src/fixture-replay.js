'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { hashBytes, safeFile, replacementBytes } = require('./proposal-apply');
const { NODE_TARGET_PATH, NODE_REPLACEMENT, NODE_HASHES, NODE_CASES } = require('./node-fixture');
const { expectedSampleCase, validateSampleInputs } = require('./sample-inputs');
const { isPathWithinRoot } = require('./workspace-scope');
const { validateRelativePath } = require('./source-evidence');
const { inspectNodeTestProject, prepareNodeTestWorkspace, cleanupNodeTestWorkspace,
  safeProcessEnvironment, runBoundedProcess } = require('./node-test-workspace');

const TARGET_PATH = 'src/PizzaEligibility/PizzaDiscountCalculator.cs';
const FIXTURE_HASHES = Object.freeze({
  'PizzaEligibility.sln': '547af0e75d06d7fc9642f20fa91802fc1e8595c3763138f9b6e8c99b9e7e943a',
  [TARGET_PATH]: 'e5161a440101ca5e7a1a64a82d94ae4032140d96febd3a7fae53ee81051eaddc',
  'src/PizzaEligibility/PizzaEligibility.csproj': 'acd95014af5198a4b92c655ddd680cef3448692ea96fd8613b512fa321816cd9',
  'src/PizzaEligibility/Program.cs': '7a655d9d8bc9a994c781182d42de90b42baf8ec9b6dde450e31605331bb659a5',
  'tests/PizzaEligibility.Tests/PizzaEligibility.Tests.csproj': '282b6941d98084c94f0c261471c14dc7edc40e05ab3c73863cbfc6338b2a3cce',
  'tests/PizzaEligibility.Tests/PizzaEligibilityTests.cs': '6d898b3a83db4fc3f7a40072228b81e286d2ba18920cd33633c4ad0cc6fe7e3f'
});
const KNOWN_REPLACEMENT = `public static decimal CalculateDiscountAmount(decimal subtotal, bool isMember)
    {
        return isMember || subtotal >= 50m ? subtotal * 0.10m : 0m;
    }`;
const PIZZA_CASES = Object.freeze([
  Object.freeze({ input: ['25.00', 'true'], output: '2.50' }),
  Object.freeze({ input: ['49.99', 'false'], output: '0.00' }),
  Object.freeze({ input: ['50.00', 'false'], output: '5.00' }),
  Object.freeze({ input: ['75.00', 'false'], output: '7.50' })
]);

function cancelled(token) {
  if (token?.isCancellationRequested) {
    const error = new Error('Controlled replay cancelled.');
    error.code = 'CANCELLED';
    throw error;
  }
}

function controlledDefinition(candidate) {
  if (candidate.proposal.changes.length === 1) {
    if (candidate.target.path === TARGET_PATH && candidate.target.symbol === 'CalculateDiscountAmount') {
      return { hashes: FIXTURE_HASHES, targetPath: TARGET_PATH, kind: 'pizza' };
    }
    if (candidate.target.path === NODE_TARGET_PATH && candidate.target.symbol === 'transfer') {
      return { hashes: NODE_HASHES, targetPath: NODE_TARGET_PATH, kind: 'node' };
    }
  }
  throw new Error('Apply disabled: controlled verification is configured only for one-span edits to the pinned pizza and Node targets.');
}

function isControlledTarget(target) {
  return (target.path === TARGET_PATH && target.symbol === 'CalculateDiscountAmount') ||
    (target.path === NODE_TARGET_PATH && target.symbol === 'transfer');
}

async function readControlledFixture(candidate) {
  const definition = controlledDefinition(candidate);
  const files = {};
  for (const [relativePath, fingerprint] of Object.entries(definition.hashes)) {
    const filePath = await safeFile(candidate.sourceSnapshot.rootPath, relativePath);
    const bytes = await fs.readFile(filePath);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    if (hashBytes(text) !== fingerprint) throw new Error('Apply disabled: controlled fixture fingerprint differs.');
    files[relativePath] = bytes;
  }
  if (hashBytes(files[definition.targetPath]) !== candidate.sourceSnapshot.fileHash) throw new Error('Controlled source changed.');
  return files;
}

async function assertFixtureHashes(candidate, expected) {
  if (!expected || Object.keys(expected).length !== Object.keys(controlledDefinition(candidate).hashes).length) throw new Error('Missing owned fixture verification.');
  const files = await readControlledFixture(candidate);
  for (const [relativePath, bytes] of Object.entries(files)) {
    if (hashBytes(bytes) !== expected[relativePath]) throw new Error('Controlled fixture changed during verification.');
  }
}

function runDotnet(args, cwd, token, timeoutMs = 120000, spawnProcess = spawn, executable = 'dotnet') {
  cancelled(token);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (executable === 'dotnet') Object.assign(env, { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1',
    DOTNET_CLI_UI_LANGUAGE: 'en-US', DOTNET_CLI_HOME: path.join(cwd, '.cli-home'), MSBUILDDISABLENODEREUSE: '1' });
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure;
    const stop = (message, code) => {
      if (failure) return;
      failure = Object.assign(new Error(message), { code });
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('Controlled process timed out.', 'TIMEOUT'), timeoutMs);
    const subscription = token?.onCancellationRequested?.(() => stop('Controlled replay cancelled.', 'CANCELLED'));
    const cleanup = () => { clearTimeout(timer); subscription?.dispose(); };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 1024 * 1024) stop('Controlled output limit exceeded.', 'OUTPUT_LIMIT');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > 1024 * 1024) stop('Controlled output limit exceeded.', 'OUTPUT_LIMIT');
    });
    child.on('error', () => { cleanup(); reject(new Error('Controlled process could not launch.')); });
    child.on('close', (exitCode) => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ command: [executable, ...args], exitCode, stdout, stderr });
    });
    if (token?.isCancellationRequested) stop('Controlled replay cancelled.', 'CANCELLED');
  });
}

async function visibleFiles(directory) {
  const files = {};
  const scan = async (current, prefix) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === '.cli-home') continue;
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Unexpected replay symlink.');
      if (entry.isDirectory()) await scan(path.join(current, entry.name), `${relativePath}/`);
      else files[relativePath] = hashBytes(await fs.readFile(path.join(current, entry.name)));
    }
  };
  await scan(directory, '');
  return files;
}

function sameObservedCases(before, after) {
  return before.length === after.length && before.every((item, index) => {
    const transformed = after[index];
    return item.stdout === transformed.stdout && item.stderr === transformed.stderr && item.exitCode === transformed.exitCode &&
      JSON.stringify(item.visibleFilesAfter) === JSON.stringify(transformed.visibleFilesAfter);
  });
}

function capturedBaseline(candidate, fixtureHashes) {
  const captured = candidate.baselineObservations;
  if (!captured) return null;
  const expected = captured.fixtureHashes ?? {};
  if (captured.status !== 'captured' || !captured.baseline?.passed ||
      Object.keys(expected).length !== Object.keys(fixtureHashes).length ||
      Object.entries(fixtureHashes).some(([relativePath, fingerprint]) => expected[relativePath] !== fingerprint)) {
    throw new Error('Captured baseline does not match the current controlled fixture.');
  }
  return captured.baseline;
}

async function verifyPizzaProposal(candidate, token) {
  cancelled(token);
  if (controlledDefinition(candidate).kind !== 'pizza') throw new Error('Expected controlled pizza target.');
  const sampleInputs = validateSampleInputs(candidate.sampleInputs ?? [], candidate.target, candidate.mode === 'live');
  const files = await readControlledFixture(candidate);
  const fixtureHashes = Object.fromEntries(Object.entries(files).map(([relativePath, bytes]) => [relativePath, hashBytes(bytes)]));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-pizza-replay-'));
  const observations = { status: 'failed', fixtureHashes, baseline: null, transformed: null, setup: [], unknowns: [
    'Four sampled inputs and four existing tests only; no formal equivalence proof.',
    'Visible replay working-directory files are compared; external, network, timing and hidden environment effects are not proven absent.',
    'Disposable trusted fixture copies are not an operating-system sandbox. Test logs include variable durations; test counts and exit codes, not log bytes, are compared.'
  ] };
  try {
    for (const [relativePath, bytes] of Object.entries(files)) {
      const destination = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx' });
    }
    const config = path.join(directory, 'NuGet.Config');
    await fs.writeFile(config, '<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources></configuration>', { flag: 'wx' });
    observations.setup.push(await runDotnet(['--version'], directory, token));
    if (observations.setup[0].exitCode !== 0 || !observations.setup[0].stdout.trim().startsWith('10.')) throw new Error('Controlled replay requires .NET SDK 10.');
    const buildFlags = ['-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false', '-p:ImportDirectoryPackagesProps=false'];
    const restore = await runDotnet(['restore', 'PizzaEligibility.sln', '--configfile', config, ...buildFlags], directory, token);
    observations.setup.push(restore);
    if (restore.exitCode !== 0) throw new Error('Controlled restore failed.');
    const stage = async () => {
      const tests = await runDotnet(['test', 'PizzaEligibility.sln', '--no-restore', '--verbosity', 'minimal', ...buildFlags], directory, token);
      const result = { tests, cases: [], suggestedCases: [] };
      if (tests.exitCode !== 0 || !/Failed:\s+0/.test(tests.stdout) || !/Passed:\s+4/.test(tests.stdout) || !/Total:\s+4/.test(tests.stdout)) {
        result.passed = false;
        return result;
      }
      const program = path.join(directory, 'src/PizzaEligibility/bin/Debug/net10.0/PizzaEligibility.dll');
      for (const scenario of PIZZA_CASES) {
        cancelled(token);
        const runDirectory = await fs.mkdtemp(path.join(directory, 'case-'));
        const before = await visibleFiles(runDirectory);
        const processResult = await runDotnet([program, ...scenario.input], runDirectory, token);
        const after = await visibleFiles(runDirectory);
        result.cases.push({ input: [...scenario.input], ...processResult, visibleFilesBefore: before, visibleFilesAfter: after });
      }
      for (const input of sampleInputs) {
        const runDirectory = await fs.mkdtemp(path.join(directory, 'suggested-case-'));
        const before = await visibleFiles(runDirectory);
        const processResult = await runDotnet([program, input.subtotal, String(input.isMember)], runDirectory, token);
        const after = await visibleFiles(runDirectory);
        const expectedOutput = expectedSampleCase(candidate.target, input);
        const passed = processResult.exitCode === 0 && processResult.stderr === '' &&
          processResult.stdout === `${expectedOutput}${os.EOL}` && JSON.stringify(before) === JSON.stringify(after);
        result.suggestedCases.push({ input, expectedOutput, ...processResult, passed,
          visibleFilesBefore: before, visibleFilesAfter: after });
      }
      result.passed = result.cases.every((item, index) => item.exitCode === 0 && item.stderr === '' &&
        item.stdout === `${PIZZA_CASES[index].output}${os.EOL}` &&
        JSON.stringify(item.visibleFilesBefore) === JSON.stringify(item.visibleFilesAfter)) &&
        result.suggestedCases.every((item) => item.passed);
      return result;
    };
    observations.baseline = capturedBaseline(candidate, fixtureHashes) ?? await stage();
    if (!observations.baseline.passed) throw new Error('Baseline tests or representative inputs failed.');
    if (candidate.baselineOnly) {
      observations.status = 'captured';
      return observations;
    }
    await fs.writeFile(path.join(directory, TARGET_PATH), replacementBytes(candidate));
    observations.transformed = await stage();
    if (!observations.transformed.passed || observations.baseline.tests.stderr !== observations.transformed.tests.stderr ||
        !sameObservedCases(observations.baseline.cases, observations.transformed.cases) ||
        !sameObservedCases(observations.baseline.suggestedCases, observations.transformed.suggestedCases)) {
      throw new Error('Transformed tests or replay differed; revised proposal required.');
    }
    await assertFixtureHashes(candidate, fixtureHashes);
    cancelled(token);
    observations.status = 'passed';
    return observations;
  } catch (error) {
    if (error.code === 'CANCELLED' || token?.isCancellationRequested) throw error;
    observations.reason = error.message;
    return observations;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function runNode(args, cwd, token, timeoutMs = 30000, spawnProcess = spawn) {
  return runDotnet(args, cwd, token, timeoutMs, spawnProcess, 'node');
}

async function verifyNodeProposal(candidate, token) {
  cancelled(token);
  if (controlledDefinition(candidate).kind !== 'node') throw new Error('Expected controlled Node target.');
  const sampleInputs = validateSampleInputs(candidate.sampleInputs ?? [], candidate.target, candidate.mode === 'live');
  const files = await readControlledFixture(candidate);
  const fixtureHashes = Object.fromEntries(Object.entries(files).map(([relativePath, bytes]) => [relativePath, hashBytes(bytes)]));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-node-replay-'));
  const observations = { status: 'failed', fixtureHashes, setup: [], baseline: null, transformed: null, unknowns: [
    'Eight reset-state cases and existing tests only; no formal equivalence proof or complete dynamic call graph.',
    'Visible working-directory files, JSON balances, stdout, stderr and exits are compared; external/network/timing effects remain unknown.',
    'Disposable pinned copies are not an operating-system sandbox. Node runtime does not establish TypeScript provider version.'
  ] };
  try {
    for (const [relativePath, bytes] of Object.entries(files)) {
      const destination = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx' });
    }
    const runtime = await runNode(['--version'], directory, token);
    observations.setup.push(runtime);
    if (runtime.exitCode !== 0 || !/^v24\.19\./.test(runtime.stdout.trim())) throw new Error('Controlled Node replay requires Node.js 24.19.x.');
    const stage = async () => {
      const testCode = "const {run}=require('node:test');run({files:[process.argv[1]],isolation:'none'}).on('test:summary',summary=>{if(!summary.file){process.stdout.write(JSON.stringify({success:summary.success,counts:summary.counts})+'\\n');if(!summary.success)process.exitCode=1;}});";
      const tests = await runNode(['-e', testCode, path.join(directory, 'tests/transfer.test.js')], directory, token);
      const result = { tests, cases: [], suggestedCases: [], passed: false };
      const summary = JSON.parse(tests.stdout);
      if (tests.exitCode !== 0 || tests.stderr !== '' || !summary.success || summary.counts.passed !== 8 ||
          summary.counts.failed !== 0 || summary.counts.cancelled !== 0 || summary.counts.skipped !== 0) return result;
      for (const scenario of [...NODE_CASES, { input: 'unknown case', error: 'unknown case' }]) {
        const runDirectory = await fs.mkdtemp(path.join(directory, 'case-'));
        const before = await visibleFiles(runDirectory);
        const processResult = await runNode([path.join(directory, 'src/runner.js'), scenario.input], runDirectory, token);
        const after = await visibleFiles(runDirectory);
        const output = JSON.parse(scenario.error ? processResult.stderr : processResult.stdout);
        const expected = scenario.error ? { error: scenario.error } : { result: scenario.result, balances: scenario.balances };
        const passed = processResult.exitCode === (scenario.error ? 2 : 0) &&
          (scenario.error ? processResult.stdout === '' : processResult.stderr === '') &&
          JSON.stringify(output) === JSON.stringify(expected) && JSON.stringify(before) === JSON.stringify(after);
        result.cases.push({ input: scenario.input, ...processResult, output, passed, visibleFilesBefore: before, visibleFilesAfter: after });
      }
      const sampleRunner = "const {transfer}=require(process.argv[1]);const sample=JSON.parse(process.argv[2]);const accounts=Object.fromEntries(sample.accounts.map(({id,balance})=>[id,balance]));const result=transfer(accounts,sample.sourceId,sample.destinationId,sample.amount);process.stdout.write(JSON.stringify({result,balances:accounts})+'\\n');";
      for (const input of sampleInputs) {
        const runDirectory = await fs.mkdtemp(path.join(directory, 'suggested-case-'));
        const before = await visibleFiles(runDirectory);
        const processResult = await runNode(['-e', sampleRunner, path.join(directory, NODE_TARGET_PATH), JSON.stringify(input)], runDirectory, token);
        const after = await visibleFiles(runDirectory);
        const output = JSON.parse(processResult.stdout);
        const expectedOutput = expectedSampleCase(candidate.target, input);
        const passed = processResult.exitCode === 0 && processResult.stderr === '' &&
          JSON.stringify(output) === JSON.stringify(expectedOutput) && JSON.stringify(before) === JSON.stringify(after);
        result.suggestedCases.push({ input, expectedOutput, ...processResult, output, passed,
          visibleFilesBefore: before, visibleFilesAfter: after });
      }
      result.passed = result.cases.every((scenario) => scenario.passed) && result.suggestedCases.every((scenario) => scenario.passed);
      return result;
    };
    observations.baseline = capturedBaseline(candidate, fixtureHashes) ?? await stage();
    if (!observations.baseline.passed) throw new Error('Baseline Node tests or reset-state replay failed.');
    if (candidate.baselineOnly) {
      observations.status = 'captured';
      return observations;
    }
    await fs.writeFile(path.join(directory, NODE_TARGET_PATH), replacementBytes(candidate));
    observations.transformed = await stage();
    if (!observations.transformed.passed || !sameObservedCases(observations.baseline.cases, observations.transformed.cases) ||
        !sameObservedCases(observations.baseline.suggestedCases, observations.transformed.suggestedCases)) {
      throw new Error('Transformed Node tests or replay differed; revised proposal required.');
    }
    await assertFixtureHashes(candidate, fixtureHashes);
    cancelled(token);
    observations.status = 'passed';
    return observations;
  } catch (error) {
    if (error.code === 'CANCELLED' || token?.isCancellationRequested) throw error;
    observations.reason = error.message;
    return observations;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function parseTapSummary(output) {
  const summary = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
    if (matches.length === 0) return null;
    summary[name] = Number(matches.at(-1)[1]);
  }
  return summary;
}

function runSelectedNodeTest(workspaceRoot, testFilePath, nodeExecutable, env, token) {
  const testPath = path.resolve(workspaceRoot, ...testFilePath.split('/'));
  if (!isPathWithinRoot(workspaceRoot, testPath)) throw new Error('Selected test path escaped its disposable copy.');
  return runBoundedProcess(nodeExecutable, ['--test', '--test-reporter=tap', testPath], {
    cwd: workspaceRoot, env, timeoutMs: 120000, maxOutputBytes: 1024 * 1024, token
  });
}

async function runSelectedNodeSamples(workspaceRoot, candidate, nodeExecutable, env, token) {
  const sampleInputs = candidate.sampleInputs ?? [];
  if (sampleInputs.length === 0) return [];
  if (candidate.target.path !== NODE_TARGET_PATH || candidate.target.symbol !== 'transfer') {
    throw new Error('Supplemental Node samples are available only for the pinned transfer target.');
  }
  const modulePath = path.resolve(workspaceRoot, ...candidate.target.path.split('/'));
  if (!isPathWithinRoot(workspaceRoot, modulePath)) throw new Error('Sample target escaped its disposable copy.');
  const sampleRunner = "const {transfer}=require(process.argv[1]);const sample=JSON.parse(process.argv[2]);const accounts=Object.fromEntries(sample.accounts.map(({id,balance})=>[id,balance]));const result=transfer(accounts,sample.sourceId,sample.destinationId,sample.amount);process.stdout.write(JSON.stringify({result,balances:accounts})+'\\n');";
  const samples = [];
  for (const input of sampleInputs) {
    cancelled(token);
    const runDirectory = await fs.mkdtemp(path.join(workspaceRoot, 'sample-'));
    try {
      const visibleFilesBefore = await visibleFiles(runDirectory);
      const processResult = await runBoundedProcess(nodeExecutable,
        ['-e', sampleRunner, modulePath, JSON.stringify(input)], {
          cwd: runDirectory, env, timeoutMs: 120000, maxOutputBytes: 1024 * 1024, token
        });
      const visibleFilesAfter = await visibleFiles(runDirectory);
      let output = null;
      try {
        output = JSON.parse(processResult.stdout);
      } catch {}
      const expectedOutput = expectedSampleCase(candidate.target, input);
      const passed = processResult.exitCode === 0 && !processResult.reason && processResult.stderr === '' &&
        JSON.stringify(output) === JSON.stringify(expectedOutput) &&
        JSON.stringify(visibleFilesBefore) === JSON.stringify(visibleFilesAfter);
      samples.push({ input, expectedOutput, ...processResult, output, passed, visibleFilesBefore, visibleFilesAfter });
    } finally {
      await fs.rm(runDirectory, { recursive: true, force: true });
    }
  }
  return samples;
}

function sameSelectedSamples(before, after) {
  return before.length === after.length && before.every((item, index) => {
    const transformed = after[index];
    return JSON.stringify(item.input) === JSON.stringify(transformed.input) &&
      JSON.stringify(item.expectedOutput) === JSON.stringify(transformed.expectedOutput) &&
      item.stdout === transformed.stdout && item.stderr === transformed.stderr &&
      item.exitCode === transformed.exitCode && item.passed && transformed.passed &&
      JSON.stringify(item.visibleFilesAfter) === JSON.stringify(transformed.visibleFilesAfter);
  });
}

async function verifySelectedNodeProposal(candidate, token, preflight, options = {}) {
  cancelled(token);
  if (!candidate.testFileSnapshot || candidate.proposal.changes.length !== 1 ||
      candidate.proposal.changes[0].path !== candidate.target.path) {
    throw new Error('Selected-test verification requires one exact Node target-span replacement.');
  }
  validateRelativePath(candidate.target.path);
  validateRelativePath(candidate.testFileSnapshot.path);
  if (!/\.(?:js|cjs|mjs)$/i.test(candidate.target.path)) {
    throw new Error('Selected-test verification supports only Node target files.');
  }
  const projectPreflight = preflight ?? await inspectNodeTestProject(candidate.sourceSnapshot.rootPath,
    candidate.testFileSnapshot.path);
  const workspaceOptions = {
    nodeExecutable: projectPreflight.nodeExecutable,
    npmCliPath: projectPreflight.npmCliPath,
    expectedProjectHashes: {
      manifestHash: projectPreflight.manifestHash,
      lockHash: projectPreflight.lockHash,
      testFileHash: candidate.testFileSnapshot.fileHash
    },
    token,
    ...options.workspaceOptions
  };
  const workspace = await prepareNodeTestWorkspace(candidate.sourceSnapshot.rootPath,
    candidate.testFileSnapshot.path, workspaceOptions);
  const observations = {
    status: 'failed', testFile: candidate.testFileSnapshot.path,
    testFileHash: candidate.testFileSnapshot.fileHash,
    manifestHash: workspace.manifestHash, lockHash: workspace.lockHash,
    runtimeVersion: workspace.toolchain.runtimeVersion,
    installRequired: workspace.installRequired, packageCount: workspace.packageCount,
    install: workspace.installResult, baseline: null, transformed: null,
    unknowns: [
      'Only the selected node:test file is executed; passing it does not prove general behavioral equivalence.',
      'Selected test and imported project code execute with the user permissions; the disposable copies are not an operating-system sandbox.'
    ]
  };
  try {
    if (projectPreflight.runtimeVersion && workspace.toolchain.runtimeVersion !== projectPreflight.runtimeVersion) {
      throw new Error('Node.js runtime changed after confirmation.');
    }
    const targetPath = path.resolve(workspace.baselineRoot, ...candidate.target.path.split('/'));
    const transformedTargetPath = path.resolve(workspace.transformedRoot, ...candidate.target.path.split('/'));
    const testFilePath = path.resolve(workspace.baselineRoot, ...candidate.testFileSnapshot.path.split('/'));
    const transformedTestPath = path.resolve(workspace.transformedRoot, ...candidate.testFileSnapshot.path.split('/'));
    if (![targetPath, transformedTargetPath, testFilePath, transformedTestPath].every((filePath) =>
      isPathWithinRoot(filePath === targetPath || filePath === testFilePath ? workspace.baselineRoot : workspace.transformedRoot, filePath))) {
      throw new Error('Target or selected test escaped its disposable copy.');
    }
    if (hashBytes(await fs.readFile(targetPath)) !== candidate.sourceSnapshot.fileHash ||
        hashBytes(await fs.readFile(testFilePath)) !== candidate.testFileSnapshot.fileHash ||
        hashBytes(await fs.readFile(transformedTestPath)) !== candidate.testFileSnapshot.fileHash) {
      throw new Error('Target or selected test changed before disposable verification.');
    }
    const executeTest = options.runTest ?? runSelectedNodeTest;
    const env = safeProcessEnvironment(workspace.tempRoot);
    observations.baseline = await executeTest(workspace.baselineRoot, candidate.testFileSnapshot.path,
      workspace.toolchain.nodeExecutable, env, token);
    observations.baseline.summary = parseTapSummary(observations.baseline.stdout);
    observations.baseline.passed = observations.baseline.exitCode === 0 && !observations.baseline.reason &&
      observations.baseline.summary?.tests > 0 && observations.baseline.summary.pass === observations.baseline.summary.tests &&
      observations.baseline.summary.fail === 0 && observations.baseline.summary.cancelled === 0 &&
      observations.baseline.summary.skipped === 0;
    if (!observations.baseline.passed) {
      observations.reason = 'The selected Node test did not pass against the original target.';
      return observations;
    }
    observations.baseline.samples = await runSelectedNodeSamples(workspace.baselineRoot, candidate,
      workspace.toolchain.nodeExecutable, env, token);
    if (observations.baseline.samples.some((sample) => !sample.passed)) {
      observations.reason = 'A supplemental Node sample did not match its extension-owned expected output on the original target.';
      return observations;
    }
    const capturedSamples = candidate.baselineObservations?.baseline?.suggestedCases;
    if (capturedSamples && (capturedSamples.length !== observations.baseline.samples.length ||
        capturedSamples.some((sample, index) => sample.stdout !== observations.baseline.samples[index].stdout ||
          sample.stderr !== observations.baseline.samples[index].stderr ||
          sample.exitCode !== observations.baseline.samples[index].exitCode))) {
      observations.reason = 'Original characterization outputs changed since the reviewed baseline was captured.';
      return observations;
    }
    const replacement = replacementBytes(candidate);
    await fs.writeFile(transformedTargetPath, replacement);
    observations.transformed = await executeTest(workspace.transformedRoot, candidate.testFileSnapshot.path,
      workspace.toolchain.nodeExecutable, env, token);
    observations.transformed.summary = parseTapSummary(observations.transformed.stdout);
    observations.transformed.passed = observations.transformed.exitCode === 0 && !observations.transformed.reason &&
      observations.transformed.summary?.tests > 0 && observations.transformed.summary.pass === observations.transformed.summary.tests &&
      observations.transformed.summary.fail === 0 && observations.transformed.summary.cancelled === 0 &&
      observations.transformed.summary.skipped === 0;
    if (!observations.transformed.passed) {
      observations.reason = 'The selected Node test did not pass against the transformed target.';
      return observations;
    }
    observations.transformed.samples = await runSelectedNodeSamples(workspace.transformedRoot, candidate,
      workspace.toolchain.nodeExecutable, env, token);
    if (observations.transformed.samples.some((sample) => !sample.passed)) {
      observations.reason = 'A supplemental Node sample did not match its extension-owned expected output on the transformed target.';
      return observations;
    }
    if (JSON.stringify(observations.baseline.summary) !== JSON.stringify(observations.transformed.summary) ||
        !sameSelectedSamples(observations.baseline.samples, observations.transformed.samples)) {
      observations.reason = 'Selected Node test or supplemental sample results changed between baseline and transformed runs.';
      return observations;
    }
    observations.status = 'passed';
    return observations;
  } catch (error) {
    if (error.code === 'CANCELLED' || token?.isCancellationRequested) throw error;
    observations.reason = error.message;
    return observations;
  } finally {
    await cleanupNodeTestWorkspace(workspace);
  }
}

function verifyControlledProposal(candidate, token, preflight) {
  if (candidate.testFileSnapshot) return verifySelectedNodeProposal(candidate, token, preflight);
  return controlledDefinition(candidate).kind === 'node' ? verifyNodeProposal(candidate, token) : verifyPizzaProposal(candidate, token);
}

async function captureControlledBaseline(candidate, token) {
  const baselineCandidate = { ...candidate, baselineOnly: true };
  const result = controlledDefinition(baselineCandidate).kind === 'node' ?
    await verifyNodeProposal(baselineCandidate, token) : await verifyPizzaProposal(baselineCandidate, token);
  if (result.status !== 'captured') {
    throw new Error(`Could not capture controlled baseline: ${result.reason ?? 'baseline replay failed.'}`);
  }
  return result;
}

function renderVerificationReport(candidate, verification, application = { status: 'not-applied' }) {
  const title = candidate.testFileSnapshot ? 'Node Characterization Verification' : 'Controlled Fixture Verification';
  const description = candidate.testFileSnapshot ? 'Selected Node test observations from disposable copies.' :
    'Extension-owned disposable fixture observations.';
  const applicationResult = application.status === 'applied' ?
    `Application: applied\n\nApplied source SHA-256: ${application.sourceHash}` :
    'Application: not applied. The selected source was left unchanged.';
  return `---\ntitle: ${title}\ndescription: ${description}\n---\n\n` +
    `## Result\n\nVerification: ${verification.status}\n\nProposal ID: ${candidate.id}\n\nProposal SHA-256: ${candidate.proposalHash}\n\n` +
    `Source SHA-256 before application: ${candidate.sourceSnapshot.fileHash}\n\n${applicationResult}\n\n` +
    `The application status is recorded only after the source write completes. The reviewed proposal report is unchanged. ` +
    `A failed verification requires a revised proposal.\n\n` +
    `## Owned Process Observations\n\n\`\`\`json\n${JSON.stringify(verification, null, 2)}\n\`\`\`\n`;
}

module.exports = { TARGET_PATH, PIZZA_CASES, readControlledFixture, assertFixtureHashes, runDotnet, runNode,
  verifyPizzaProposal, verifyNodeProposal, verifySelectedNodeProposal, parseTapSummary, runSelectedNodeTest,
  runSelectedNodeSamples, sameSelectedSamples,
  verifyControlledProposal, isControlledTarget, captureControlledBaseline, renderVerificationReport };
