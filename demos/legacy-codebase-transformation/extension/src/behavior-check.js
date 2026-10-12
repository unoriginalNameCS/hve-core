'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { contentHash, renderProposalReport, safeSourcePath, spanOffsets } = require('./proposal-workflow');
const { resolveWorkspaceRoot } = require('./workspace-scope');

const TARGET_PATH = 'src/transfer.js';
const FIXTURE_HASHES = Object.freeze({
  [TARGET_PATH]: 'fb116b3865c5af50e5ae9b1d8c9023e8eb1ef5de8cdec5841c3caed9fb7b3023',
  'src/cases.js': '5e7056196a56e7ef742fbe26daaf1e17ff76a179b3de9e6728dd548fca5b56bb',
  'src/runner.js': 'ef67cfcfda6b6be531dee5f333b9d17e0470aa389691c10437d7afa0f3d5ce43',
  'tests/transfer.test.js': '6b43df87699a30b5ab8530f27ed8693a6cb0ed98727bd0a77a98391a1c36f624'
});
const CASES = Object.freeze(['successful transfer', 'missing source', 'missing destination', 'both missing',
  'same account', 'zero amount', 'negative amount', 'insufficient funds', 'unknown case']);
const TEST_REPORTER = [
  'module.exports = async function*(events) {',
  '  const counts = { passed: 0, failed: 0, cancelled: 0, skipped: 0 };',
  '  for await (const event of events) {',
  "    if (event.type === 'test:pass' && event.data.details?.type !== 'suite') {",
  '      if (event.data.skip || event.data.todo) counts.skipped += 1; else counts.passed += 1;',
  '    }',
  "    if (event.type === 'test:fail' && event.data.details?.type !== 'suite') counts.failed += 1;",
  '  }',
  "  yield JSON.stringify({ success: counts.failed === 0, counts }) + '\\n';",
  '};'
].join('\n');

function normalizedHash(bytes) {
  return contentHash(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n'));
}

async function prepareBehaviorCheck(vscode, proposalStore, proposalIds) {
  if (!Array.isArray(proposalIds) || proposalIds.length < 1 || proposalIds.length > 30 ||
      proposalIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(proposalIds).size !== proposalIds.length) {
    return { status: 'not-checked', reason: 'Select between 1 and 30 unique applied proposal IDs from one banking file.' };
  }
  try {
    const candidates = [...proposalIds].sort().map((id) => proposalStore.get(id));
    if (candidates.some((candidate) => !candidate || candidate.status !== 'applied' ||
        candidate.finding.path !== TARGET_PATH || candidate.proposalHash !== contentHash(JSON.stringify(candidate.proposal)) ||
        candidate.report !== renderProposalReport(candidate) || candidate.reportHash !== contentHash(candidate.report))) {
      return { status: 'not-checked', reason: 'Only successfully applied, intact banking proposals can be checked.' };
    }
    const snapshot = candidates[0].sourceSnapshot;
    const originalBytes = Buffer.from(snapshot.bytes, 'base64');
    if (normalizedHash(originalBytes) !== FIXTURE_HASHES[TARGET_PATH] || contentHash(originalBytes) !== snapshot.fileHash ||
        candidates.some((candidate) => candidate.sourceSnapshot.rootPath !== snapshot.rootPath ||
          candidate.sourceSnapshot.path !== snapshot.path || candidate.sourceSnapshot.bytes !== snapshot.bytes)) {
      return { status: 'not-checked', reason: 'The before snapshot must be the original known banking fixture, not an arbitrary project.' };
    }
    const root = await resolveWorkspaceRoot(snapshot.rootPath, vscode.workspace.workspaceFolders);
    const spans = candidates.map((candidate) => ({ candidate, offsets: spanOffsets(snapshot.text, candidate.finding.range) }));
    if (spans.some(({ candidate, offsets }) => !offsets ||
        snapshot.text.slice(offsets.start, offsets.end) !== candidate.finding.originalText)) {
      return { status: 'not-checked', reason: 'The applied change no longer matches its before snapshot.' };
    }
    spans.sort((left, right) => left.offsets.start - right.offsets.start);
    if (spans.some((span, index) => index > 0 && span.offsets.start < spans[index - 1].offsets.end)) {
      return { status: 'not-checked', reason: 'Applied spans overlap.' };
    }
    let expectedText = snapshot.text;
    for (const { candidate, offsets } of [...spans].reverse()) {
      expectedText = expectedText.slice(0, offsets.start) + candidate.proposal.replacementText + expectedText.slice(offsets.end);
    }
    const bom = originalBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? originalBytes.subarray(0, 3) : Buffer.alloc(0);
    const expectedBytes = Buffer.concat([bom, Buffer.from(expectedText, 'utf8')]);
    const baselineFiles = {};
    const transformedFiles = {};
    for (const [relativePath, hash] of Object.entries(FIXTURE_HASHES)) {
      const sourcePath = await safeSourcePath(root.realPath, relativePath);
      const dirtyPaths = await Promise.all((vscode.workspace.textDocuments ?? []).filter((document) => document.isDirty)
        .map((document) => fs.realpath(document.uri.fsPath).catch(() => null)));
      const dirty = dirtyPaths.some((documentPath) => documentPath &&
        (process.platform === 'win32' ? documentPath.toLowerCase() === sourcePath.toLowerCase() : documentPath === sourcePath));
      if (dirty) return { status: 'not-checked', reason: 'Save or discard dirty fixture buffers before checking behavior.' };
      const bytes = await fs.readFile(sourcePath);
      if (bytes.length > 64 * 1024 || (relativePath === TARGET_PATH ? !bytes.equals(expectedBytes) : normalizedHash(bytes) !== hash)) {
        return { status: 'not-checked', reason: 'The saved source or known test harness changed. No code was executed.' };
      }
      transformedFiles[relativePath] = bytes;
      baselineFiles[relativePath] = relativePath === TARGET_PATH ? originalBytes : bytes;
    }
    const fingerprint = contentHash(JSON.stringify({ root: root.realPath, candidates,
      hashes: Object.entries(transformedFiles).map(([name, bytes]) => [name, contentHash(bytes)]) }));
    return { status: 'ready', fingerprint, baselineFiles, transformedFiles,
      preview: { proposalIds: candidates.map((candidate) => candidate.id), projectRoot: root.realPath, path: TARGET_PATH,
        sourceHash: contentHash(expectedBytes), baselineHash: contentHash(originalBytes), tests: 8, sampleCases: CASES.length,
        cases: [...CASES],
        runtime: 'Node.js 24.19.x from PATH (not the VS Code executable)',
        commands: ['node --version', 'node --test --test-reporter=<fixed JSON reporter> tests/transfer.test.js', 'node src/runner.js <each fixed case>'],
        execution: 'Original and transformed code execute in disposable local copies, not in the project directory.',
        warning: 'Temporary copies are not an OS sandbox. Executed code may have external side effects. No model requests, installs, source writes, or automatic rollback.' } };
  } catch {
    return { status: 'not-checked', reason: 'The current applied banking fixture could not be verified. No code was executed.' };
  }
}

function runProcess(args, cwd, token) {
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) return reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' }));
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn('node', args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure;
    const stop = (code) => {
      if (failure) return;
      failure = Object.assign(new Error('Behavior check stopped.'), { code });
      if (process.platform === 'win32' && child.pid && process.env.SystemRoot) {
        const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { env, shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('TIMEOUT'), 30000);
    const subscription = token?.onCancellationRequested?.(() => stop('CANCELLED'));
    const cleanup = () => { clearTimeout(timer); subscription?.dispose(); };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 256 * 1024) stop('OUTPUT_LIMIT'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > 256 * 1024) stop('OUTPUT_LIMIT'); });
    child.on('error', () => { cleanup(); reject(Object.assign(new Error('Node could not launch.'), { code: 'UNAVAILABLE' })); });
    child.on('close', (exitCode) => { cleanup(); if (failure) reject(failure); else resolve({ exitCode, stdout, stderr }); });
    if (token?.isCancellationRequested) stop('CANCELLED');
  });
}

async function runBehaviorCheck(vscode, proposalStore, proposalIds, fingerprint, token, options = {}) {
  if (options.chatApproved !== true || token?.isCancellationRequested) return { status: 'not-checked', reason: 'Execution was not approved or was cancelled.' };
  const prepared = await prepareBehaviorCheck(vscode, proposalStore, proposalIds);
  if (prepared.status !== 'ready') return prepared;
  if (fingerprint !== prepared.fingerprint) return { status: 'not-checked', reason: 'The source or test harness changed after the preview. Prepare again.' };
  const processRunner = options.runProcess ?? runProcess;
  const run = async (...args) => {
    if (token?.isCancellationRequested) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
    const observation = await processRunner(...args);
    if (token?.isCancellationRequested) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
    return observation;
  };
  let directory;
  const result = { status: 'not-checked', path: TARGET_PATH, tests: { baseline: null, transformed: null },
    sampleCases: { total: CASES.length, matched: 0, results: [] },
    limitation: 'Only the existing tests and nine fixed cases were checked; this is not proof of complete behavioral equivalence. No source rollback is performed.' };
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-behavior-'));
    const runtime = await run(['--version'], directory, token);
    if (runtime.exitCode !== 0 || !/^v24\.19\./.test(runtime.stdout.trim())) {
      return { ...result, reason: 'Node.js 24.19.x is required. No fixture code was executed.' };
    }
    const reporterPath = path.join(directory, 'reporter.cjs');
    await fs.writeFile(reporterPath, TEST_REPORTER, { flag: 'wx' });
    const cases = {};
    for (const [stage, files] of Object.entries({ baseline: prepared.baselineFiles, transformed: prepared.transformedFiles })) {
      const stageRoot = path.join(directory, stage);
      for (const [relativePath, bytes] of Object.entries(files)) {
        const destination = path.join(stageRoot, relativePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes, { flag: 'wx' });
      }
      await fs.writeFile(path.join(stageRoot, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }), { flag: 'wx' });
      const tests = await run(['--test', '--test-reporter=../reporter.cjs', path.join(stageRoot, 'tests/transfer.test.js')], stageRoot, token);
      const summary = JSON.parse(tests.stdout);
      result.tests[stage] = { passed: summary.counts?.passed ?? 0, failed: summary.counts?.failed ?? 0,
        success: tests.exitCode === 0 && tests.stderr === '' && summary.success === true && summary.counts?.passed === 8 &&
          summary.counts?.failed === 0 && summary.counts?.cancelled === 0 && summary.counts?.skipped === 0 };
      if (!result.tests[stage].success) return { ...result, status: 'failed', reason: `${stage} tests failed. Source was not reverted.` };
      cases[stage] = [];
      for (const scenario of CASES) {
        const caseRoot = await fs.mkdtemp(path.join(directory, `${stage}-case-`));
        const observation = await run([path.join(stageRoot, 'src/runner.js'), scenario], caseRoot, token);
        const expectedExit = scenario === 'unknown case' ? 2 : 0;
        JSON.parse(scenario === 'unknown case' ? observation.stderr : observation.stdout);
        if (observation.exitCode !== expectedExit || (expectedExit === 0 ? observation.stderr !== '' : observation.stdout !== '') ||
            (await fs.readdir(caseRoot)).length !== 0) {
          return { ...result, status: 'failed', reason: `${stage} sample execution failed or wrote working-directory files.` };
        }
        cases[stage].push(observation);
      }
    }
    result.sampleCases.results = CASES.map((input, index) => ({ input,
      matched: JSON.stringify(cases.baseline[index]) === JSON.stringify(cases.transformed[index]) }));
    result.sampleCases.matched = result.sampleCases.results.filter((scenario) => scenario.matched).length;
    const current = await prepareBehaviorCheck(vscode, proposalStore, proposalIds);
    if (current.status !== 'ready' || current.fingerprint !== fingerprint) {
      return { ...result, status: 'not-checked', reason: 'Source changed during execution; results do not verify the current file.' };
    }
    return { ...result, status: result.sampleCases.matched === CASES.length ? 'passed' : 'failed' };
  } catch (error) {
    return { ...result, status: ['CANCELLED', 'UNAVAILABLE'].includes(error.code) || token?.isCancellationRequested ? 'not-checked' : 'failed',
      reason: error.code === 'CANCELLED' || token?.isCancellationRequested ? 'Behavior check cancelled.' :
        error.code === 'UNAVAILABLE' ? 'Node could not launch. No fixture code was executed.' :
          'Behavior execution failed, timed out, or returned invalid output. Inspect the applied source; it was not reverted.' };
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { prepareBehaviorCheck, runBehaviorCheck };
