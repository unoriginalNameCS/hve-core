'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { hashBytes, safeFile, replacementBytes } = require('./proposal-apply');
const { NODE_TARGET_PATH, NODE_REPLACEMENT, NODE_HASHES, NODE_CASES } = require('./node-fixture');

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
    if (candidate.target.path === TARGET_PATH && candidate.target.symbol === 'CalculateDiscountAmount' &&
        candidate.proposal.changes[0].replacementText === KNOWN_REPLACEMENT) return { hashes: FIXTURE_HASHES, targetPath: TARGET_PATH, kind: 'pizza' };
    if (candidate.target.path === NODE_TARGET_PATH && candidate.target.symbol === 'transfer' &&
        candidate.proposal.changes[0].replacementText === NODE_REPLACEMENT) return { hashes: NODE_HASHES, targetPath: NODE_TARGET_PATH, kind: 'node' };
  }
  throw new Error('Apply disabled: no equivalent controlled verification is configured for this target or replacement.');
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

async function verifyPizzaProposal(candidate, token) {
  cancelled(token);
  if (controlledDefinition(candidate).kind !== 'pizza') throw new Error('Expected controlled pizza target.');
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
      const result = { tests, cases: [] };
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
      result.passed = result.cases.every((item, index) => item.exitCode === 0 && item.stderr === '' &&
        item.stdout === `${PIZZA_CASES[index].output}${os.EOL}` &&
        JSON.stringify(item.visibleFilesBefore) === JSON.stringify(item.visibleFilesAfter));
      return result;
    };
    observations.baseline = await stage();
    if (!observations.baseline.passed) throw new Error('Baseline tests or representative inputs failed.');
    await fs.writeFile(path.join(directory, TARGET_PATH), replacementBytes(candidate));
    observations.transformed = await stage();
    if (!observations.transformed.passed || observations.baseline.tests.stderr !== observations.transformed.tests.stderr ||
        observations.baseline.cases.some((before, index) => {
          const after = observations.transformed.cases[index];
          return before.stdout !== after.stdout || before.stderr !== after.stderr || before.exitCode !== after.exitCode ||
            JSON.stringify(before.visibleFilesAfter) !== JSON.stringify(after.visibleFilesAfter);
        })) throw new Error('Transformed tests or replay differed; revised proposal required.');
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
  return runDotnet(args, cwd, token, timeoutMs, spawnProcess, process.execPath);
}

async function verifyNodeProposal(candidate, token) {
  cancelled(token);
  if (controlledDefinition(candidate).kind !== 'node') throw new Error('Expected controlled Node target.');
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
      const result = { tests, cases: [], passed: false };
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
      result.passed = result.cases.every((scenario) => scenario.passed);
      return result;
    };
    observations.baseline = await stage();
    if (!observations.baseline.passed) throw new Error('Baseline Node tests or reset-state replay failed.');
    await fs.writeFile(path.join(directory, NODE_TARGET_PATH), replacementBytes(candidate));
    observations.transformed = await stage();
    if (!observations.transformed.passed || observations.baseline.cases.some((before, index) => {
      const after = observations.transformed.cases[index];
      return before.stdout !== after.stdout || before.stderr !== after.stderr || before.exitCode !== after.exitCode ||
        JSON.stringify(before.visibleFilesAfter) !== JSON.stringify(after.visibleFilesAfter);
    })) throw new Error('Transformed Node tests or replay differed; revised proposal required.');
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

function verifyControlledProposal(candidate, token) {
  return controlledDefinition(candidate).kind === 'node' ? verifyNodeProposal(candidate, token) : verifyPizzaProposal(candidate, token);
}

function renderVerificationReport(candidate, verification) {
  return `---\ntitle: Controlled Fixture Verification\ndescription: Extension-owned disposable fixture observations.\n---\n\n` +
    `## Result\n\nVerification: ${verification.status}\n\nProposal ID: ${candidate.id}\n\nProposal SHA-256: ${candidate.proposalHash}\n\n` +
    `Source SHA-256: ${candidate.sourceSnapshot.fileHash}\n\nThis records pre-application verification, not proof that source was applied. ` +
    `The reviewed proposal report is unchanged. A failed result requires a revised proposal.\n\n` +
    `## Owned Process Observations\n\n\`\`\`json\n${JSON.stringify(verification, null, 2)}\n\`\`\`\n`;
}

module.exports = { TARGET_PATH, PIZZA_CASES, readControlledFixture, assertFixtureHashes, runDotnet, runNode,
  verifyPizzaProposal, verifyNodeProposal, verifyControlledProposal, renderVerificationReport };
