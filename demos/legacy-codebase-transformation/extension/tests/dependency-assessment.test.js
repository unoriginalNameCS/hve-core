'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { inventoryDependencies, DEPENDENCY_LIMITS, validPackageName } = require('../src/dependency-inventory');
const { AssessDependenciesTool } = require('../src/extension');
const { renderDependencyReport, writeDependencyReport } = require('../src/dependency-report');

async function nativeFixture(context, files, transport) {
  const sample = await fixture(context, files);
  const storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-dependency-reports-')));
  context.after(() => fs.rm(storage, { recursive: true, force: true }));
  sample.vscode.LanguageModelToolResult = class { constructor(content) { this.content = content; } };
  sample.vscode.LanguageModelTextPart = class { constructor(value) { this.value = value; } };
  sample.vscode.Uri = { file: uri };
  sample.vscode.workspace.openTextDocument = async (fileUri) => ({ uri: fileUri });
  sample.vscode.window = { showTextDocument: async () => {} };
  const calls = [];
  const tool = new AssessDependenciesTool(sample.vscode, { reportDirectory: storage, transport: async (request) => {
    calls.push(request);
    if (transport) return transport(request, sample);
    if (request.method === 'POST') return {};
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    return { name, 'dist-tags': { latest: '1.2.0' }, versions: {
      '1.0.0': { name, version: '1.0.0', deprecated: 'Use a newer release.' },
      '1.2.0': { name, version: '1.2.0' }
    } };
  } });
  const invoke = async (input, token) => JSON.parse((await tool.invoke({ input }, token)).content[0].value);
  return { ...sample, tool, calls, storage, invoke,
    prepare: () => invoke({ phase: 'prepare', projectRoot: sample.projectRoot }) };
}

test('native dependency prepare and decline send no metadata and disclose the exact bounded lookup set', async (context) => {
  const root = manifest({ alpha: '^1' });
  const sample = await nativeFixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }) });
  const preview = await sample.prepare();
  assert.equal(preview.status, 'awaiting-decision');
  assert.deepEqual(preview.registryNames, ['alpha']);
  assert.deepEqual(preview.advisoryTuples, [{ name: 'alpha', version: '1.0.0' }]);
  assert.equal(preview.documents.length, 2);
  assert.equal(preview.limits.maxHttpRequests, 300);
  assert.equal(preview.expiresInSeconds, 300);
  assert.match(preview.warning, /internal packages/);
  assert.equal(sample.calls.length, 0);
  const declined = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'reject' });
  assert.equal(declined.status, 'cancelled');
  assert.equal(declined.requests, 0);
  assert.equal((await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'rejected');
  assert.equal(sample.calls.length, 0);
});

test('approved dependency assessment saves separate evidence without writing input bytes', async (context) => {
  const root = manifest({ alpha: '^1' });
  const files = { 'package.json': root, 'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }),
    'source.js': 'function sample() { return 0 + 1; }' };
  const sample = await nativeFixture(context, files);
  const before = await Promise.all(Object.keys(files).map((relativePath) => fs.readFile(path.join(sample.projectRoot, relativePath))));
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'completed');
  assert.equal(result.requests, 2);
  assert.equal(result.currentSnapshot, true);
  assert.equal(result.sourceWritten, false);
  assert.equal(result.reportOpened, true);
  assert.ok(result.reportPath.startsWith(sample.storage));
  assert.match(path.basename(result.reportPath), /^dependencies-/);
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /Published latest tag: 1\\\.2\\\.0/);
  assert.match(report, /Latest stable nondeprecated release: 1\\\.2\\\.0/);
  assert.match(report, /Direct update candidate: 1\\\.2\\\.0/);
  assert.match(report, /## Proposed Direct Dependency Updates/);
  assert.match(report, /Before:/);
  assert.match(report, /After \(suggested; lock resolution pending selection\):/);
  assert.match(report, /"alpha": "\^1"/);
  assert.match(report, /"alpha": "1\.2\.0"/);
  assert.match(report, /current spec: \^1; locked: 1\\\.0\\\.0/);
  assert.equal((report.match(/\* 1\\\.2\\\.0 engines:/g) ?? []).length, 1);
  assert.match(report, /Use a newer release/);
  assert.match(report, /none-returned/);
  assert.match(report, /candidate advisories|Candidate advisories/i);
  assert.match(report, /- \[ \] Reviewed and validated/);
  assert.doesNotMatch(report, /function sample/);
  assert.deepEqual(await Promise.all(Object.keys(files).map((relativePath) => fs.readFile(path.join(sample.projectRoot, relativePath)))), before);
});

test('deprecated direct dependency with no newer nondeprecated version is summarized as advisory-only', async (context) => {
  const sample = await lockedNativeFixture(context, async (request) => request.method === 'GET' ? {
    name: 'alpha', 'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: 'alpha', version: '1.0.0', deprecated: 'No replacement version is published.' } }
  } : {});
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /## Deprecated Dependencies Without A Direct Update Candidate[\s\S]*alpha @ 1\\\.0\\\.0 is explicitly deprecated/);
  assert.match(report, /No replacement version is published/);
});

function uri(filePath) {
  return { scheme: 'file', authority: '', fsPath: filePath };
}

async function lockedNativeFixture(context, transport) {
  const root = manifest({ alpha: '^1' });
  return nativeFixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }) }, transport);
}

test('native banking dependency report is not applicable without approval or network', async (context) => {
  const banking = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../../targeted-legacy-code-transformation/fixtures/node/package.json'), 'utf8'));
  const sample = await nativeFixture(context, { 'package.json': banking });
  const result = await sample.prepare();
  assert.equal(result.status, 'not-applicable');
  assert.equal(result.requests, 0);
  assert.equal(sample.calls.length, 0);
  assert.equal(sample.tool.previews.size, 0);
  assert.match(await fs.readFile(result.reportPath, 'utf8'), /No registry lookups performed/);
});

test('unsupported-only metadata is incomplete, never no-dependency approval', async (context) => {
  const sample = await nativeFixture(context, { 'package.json': manifest({ alias: 'npm:alpha@1' }) });
  const result = await sample.prepare();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.requests, 0);
  assert.ok(result.gaps > 0);
  assert.equal(sample.tool.previews.size, 0);
  assert.equal(sample.calls.length, 0);
});

test('no readable npm manifest is unknown coverage, not a dependency-free project', async (context) => {
  for (const files of [{ 'source.js': 'return 0;' }, { 'pnpm-lock.yaml': 'lockfileVersion: 9' }]) {
    const sample = await nativeFixture(context, files);
    const result = await sample.prepare();
    assert.equal(result.status, 'incomplete');
    assert.equal(result.requests, 0);
    assert.equal(sample.calls.length, 0);
    assert.match(await fs.readFile(result.reportPath, 'utf8'), /No valid visible npm manifest/);
  }
});

test('native phase fields reject extra, wrong-phase and invented consent before lookup', async (context) => {
  const sample = await lockedNativeFixture(context);
  for (const input of [null, [], {}, { phase: 'prepare' },
    { phase: 'prepare', projectRoot: sample.projectRoot, decision: 'approve' },
    { phase: 'prepare', projectRoot: sample.projectRoot, previewId: 'made-up' },
    { phase: 'prepare', projectRoot: sample.projectRoot, transport: 'override' },
    { phase: 'confirm', previewId: 'made-up', decision: 'approve', projectRoot: sample.projectRoot },
    { phase: 'confirm', previewId: 'made-up', decision: 'maybe' },
    { phase: 'confirm', previewId: 'made-up', decision: 'approve' }]) {
    const result = await sample.invoke(input);
    assert.equal(result.status, 'rejected');
    assert.equal(result.requests, 0);
  }
  assert.equal(sample.calls.length, 0);
});

test('changed bytes consume the native preview without lookup or replay', async (context) => {
  const sample = await lockedNativeFixture(context);
  const preview = await sample.prepare();
  await fs.appendFile(path.join(sample.projectRoot, 'package.json'), '\n');
  const input = { phase: 'confirm', previewId: preview.previewId, decision: 'approve' };
  assert.equal((await sample.invoke(input)).status, 'stale');
  assert.equal((await sample.invoke(input)).status, 'rejected');
  assert.equal(sample.calls.length, 0);
});

test('changed document membership cannot expand a previously approved lookup set', async (context) => {
  const sample = await lockedNativeFixture(context);
  const preview = await sample.prepare();
  const added = path.join(sample.projectRoot, 'nested/package.json');
  await fs.mkdir(path.dirname(added));
  await fs.writeFile(added, JSON.stringify(manifest({ beta: '^2' })));
  sample.matches.push(uri(added));
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'stale');
  assert.equal(result.requests, 0);
  assert.equal(sample.calls.length, 0);
});

test('dirty metadata or a missing opened root invalidates confirmation with zero sends', async (context) => {
  const sample = await lockedNativeFixture(context);
  let preview = await sample.prepare();
  sample.vscode.workspace.textDocuments = [{ uri: uri(path.join(sample.projectRoot, 'package.json')), isDirty: true }];
  assert.equal((await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'stale');
  sample.vscode.workspace.textDocuments = [];
  preview = await sample.prepare();
  sample.vscode.workspace.workspaceFolders = [];
  assert.equal((await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' })).status, 'stale');
  assert.equal(sample.calls.length, 0);
});

test('expired and superseded native previews cannot authorize requests', async (context) => {
  const sample = await lockedNativeFixture(context);
  const expired = await sample.prepare();
  sample.tool.previews.get(expired.previewId).createdAt -= DEPENDENCY_LIMITS.previewTtlMs + 1;
  assert.equal((await sample.invoke({ phase: 'confirm', previewId: expired.previewId, decision: 'approve' })).status, 'rejected');
  const old = await sample.prepare();
  const current = await sample.prepare();
  assert.equal((await sample.invoke({ phase: 'confirm', previewId: old.previewId, decision: 'approve' })).status, 'stale');
  assert.equal(sample.calls.length, 0);
  assert.equal((await sample.invoke({ phase: 'confirm', previewId: current.previewId, decision: 'approve' })).requests, 2);
});

test('pre-lookup cancellation consumes confirm once and sends nothing', async (context) => {
  const sample = await lockedNativeFixture(context);
  assert.equal((await sample.invoke({ phase: 'prepare', projectRoot: sample.projectRoot }, { isCancellationRequested: true })).status, 'cancelled');
  const preview = await sample.prepare();
  const input = { phase: 'confirm', previewId: preview.previewId, decision: 'approve' };
  assert.equal((await sample.invoke(input, { isCancellationRequested: true })).status, 'cancelled');
  assert.equal((await sample.invoke(input)).status, 'rejected');
  assert.equal(sample.calls.length, 0);
});

test('concurrent preparations are rejected while the owning local inventory is active', async (context) => {
  const sample = await lockedNativeFixture(context);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  sample.vscode.workspace.findFiles = async () => { entered(); await gate; return sample.matches; };
  const first = sample.prepare();
  await started;
  try {
    assert.equal((await sample.prepare()).status, 'busy');
    assert.equal(sample.calls.length, 0);
  } finally { release(); }
  assert.equal((await first).status, 'awaiting-decision');
  assert.equal(sample.tool.running, false);
});

test('concurrent approval and preparation cannot start another lookup or consume the running preview twice', async (context) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const sample = await lockedNativeFixture(context, async () => { entered(); await gate; return {}; });
  const preview = await sample.prepare();
  const input = { phase: 'confirm', previewId: preview.previewId, decision: 'approve' };
  const first = sample.invoke(input);
  await started;
  try {
    assert.equal((await sample.invoke(input)).status, 'busy');
    assert.equal((await sample.prepare()).status, 'busy');
    assert.equal(sample.calls.length, 1);
  } finally { release(); }
  assert.equal((await first).requests, 2);
  assert.equal((await sample.invoke(input)).status, 'rejected');
  assert.equal(sample.tool.running, false);
});

test('project changes during lookup retain actual sends and historical evidence without new disclosures', async (context) => {
  const sample = await lockedNativeFixture(context, async (request, input) => {
    if (request.method === 'GET') await fs.writeFile(path.join(input.projectRoot, 'package.json'), JSON.stringify(manifest({ alpha: '^1', beta: '^2' })));
    return request.method === 'POST' ? {} : { name: 'alpha', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { version: '1.0.0' } } };
  });
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'stale');
  assert.equal(result.requests, 2);
  assert.equal(result.currentSnapshot, false);
  assert.ok(sample.calls.every((request) => !JSON.stringify(request).includes('beta')));
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /historical only/);
  assert.match(report, /Actual HTTP attempts: 2/);
  assert.doesNotMatch(report, /beta/);
});

test('metadata becoming dirty during lookup also marks historical evidence stale', async (context) => {
  const sample = await lockedNativeFixture(context, async (request, input) => {
    input.vscode.workspace.textDocuments = [{ uri: uri(path.join(input.projectRoot, 'package.json')), isDirty: true }];
    return {};
  });
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'stale');
  assert.equal(result.requests, 2);
  assert.equal(result.currentSnapshot, false);
});

test('cancellation during lookup reports actual attempts and skips later targets', async (context) => {
  const token = { isCancellationRequested: false };
  const sample = await lockedNativeFixture(context, async () => { token.isCancellationRequested = true; return {}; });
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' }, token);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.requests, 1);
  assert.equal(result.advisoryTuplesQueried, 0);
  assert.match(await fs.readFile(result.reportPath, 'utf8'), /skipped: 1/);
});

test('unavailable registry evidence remains independent of published advisory evidence', async (context) => {
  const sample = await lockedNativeFixture(context, async (request) => {
    if (request.method === 'GET') throw new Error('SECRET transport content must not reach the report.');
    return { vulns: [{ id: 'GHSA-demo-1234', aliases: ['CVE-2026-1234'], modified: '2026-10-12T00:00:00Z',
      affected: [{ package: { name: 'alpha', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.1.0' }] }] }] }] };
  });
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.activeAdvisoryIdsPerTuple, 1);
  assert.equal(result.requests, 2);
  const report = await fs.readFile(result.reportPath, 'utf8');
  assert.match(report, /osv\.dev\/vulnerability\/GHSA-demo-1234/);
  assert.match(report, /Published severity: unknown/);
  assert.match(report, /advisory-reported fixed versions: 1\\\.1\\\.0/);
  assert.match(report, /service-unavailable/);
  assert.doesNotMatch(report, /SECRET/);
});

test('opening failures preserve the saved dependency report path and assessment counts', async (context) => {
  const sample = await lockedNativeFixture(context);
  sample.vscode.window.showTextDocument = async () => { throw new Error('SECRET editor failure'); };
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  assert.equal(result.status, 'completed');
  assert.equal(result.reportOpened, false);
  assert.equal(result.requests, 2);
  assert.ok((await fs.stat(result.reportPath)).isFile());
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('dependency report storage is write-once and cannot write into the input root', async (context) => {
  const sample = await lockedNativeFixture(context);
  const preview = await sample.prepare();
  const result = await sample.invoke({ phase: 'confirm', previewId: preview.previewId, decision: 'approve' });
  const report = await fs.readFile(result.reportPath, 'utf8');
  const assessmentId = path.basename(result.reportPath).slice('dependencies-'.length, -3);
  await assert.rejects(writeDependencyReport(sample.storage, assessmentId, 'replacement', sample.projectRoot), { code: 'EEXIST' });
  assert.equal(await fs.readFile(result.reportPath, 'utf8'), report);
  sample.tool.options.reportDirectory = path.join(sample.projectRoot, 'reports');
  const next = await sample.prepare();
  const failed = await sample.invoke({ phase: 'confirm', previewId: next.previewId, decision: 'approve' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.requests, 2);
  assert.equal(failed.stage, 'report creation');
  await assert.rejects(fs.stat(path.join(sample.projectRoot, 'reports')), { code: 'ENOENT' });
});

test('dependency report cannot use a storage alias pointing into the input project', async (context) => {
  const sample = await lockedNativeFixture(context);
  const alias = path.join(sample.storage, 'alias');
  await fs.symlink(sample.projectRoot, alias, 'junction');
  await assert.rejects(writeDependencyReport(alias, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'report', sample.projectRoot));
  assert.deepEqual((await fs.readdir(sample.projectRoot)).sort(), ['package-lock.json', 'package.json']);
});

test('report strings are escaped bounded data and unchecked snapshots remain historical', async (context) => {
  const sample = await lockedNativeFixture(context);
  const inventory = await sample.inventory();
  const { assessDependencies } = require('../src/dependency-assessment');
  const result = await assessDependencies(inventory, undefined, { transport: async () => ({}) });
  result.inventory.documents[0].path = '# heading\n<img> [external](https://example.com)';
  const report = renderDependencyReport(result);
  assert.match(report, /\\# heading \\<img\\>/);
  assert.doesNotMatch(report, /\n<img>|\[external\]\(https:\/\/example.com\)/);
  assert.match(report, /unchecked; evidence is historical only/);
  assert.match(report, /Human review: pending/);
});

function manifest(dependencies = {}, extra = {}) {
  return { name: 'sample', version: '1.0.0', dependencies, ...extra };
}

function record(name, version = '1.0.0', extra = {}) {
  return { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, ...extra };
}

function lock(root, packages = {}, lockfileVersion = 3) {
  return { name: root.name, version: root.version, lockfileVersion, packages: { '': root, ...packages } };
}

async function fixture(context, files) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-dependencies-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const projectRoot = await fs.realpath(temporaryRoot);
  const matches = [];
  const before = new Map();
  for (const [relativePath, value] of Object.entries(files)) {
    const filePath = path.join(projectRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    await fs.writeFile(filePath, bytes);
    matches.push(uri(filePath));
    before.set(filePath, bytes);
  }
  let reads = 0;
  const vscode = {
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: uri(projectRoot) }],
      textDocuments: [],
      findFiles: async () => matches,
      fs: { readFile: async () => { reads += 1; throw new Error('Unexpected workspace file read.'); },
        writeFile: async () => { throw new Error('Project writes forbidden.'); } }
    }
  };
  const inventory = async (token) => {
    const fail = () => { throw new Error('Network, commands and project writes forbidden.'); };
    const mocks = [];
    for (const [owner, names] of [[globalThis, ['fetch']], [require('node:https'), ['request', 'get']],
      [require('node:http'), ['request', 'get']], [require('node:child_process'), ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync']],
      [fs, ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink', 'truncate']]]) {
      for (const name of names) mocks.push(context.mock.method(owner, name, fail));
    }
    try {
      const result = await inventoryDependencies(vscode, projectRoot, token);
      for (const [filePath, bytes] of before) assert.deepEqual(await fs.readFile(filePath), bytes);
      assert.equal(reads, 0);
      return result;
    } finally { for (const mock of mocks) mock.mock.restore(); }
  };
  return { projectRoot, vscode, matches, inventory };
}

test('zero-dependency banking manifest produces empty lookup sets without missing-lock gaps', async (context) => {
  const banking = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../../targeted-legacy-code-transformation/fixtures/node/package.json'), 'utf8'));
  const sample = await fixture(context, { 'package.json': banking, '.npmrc': 'token=SECRET', 'src/index.js': 'throw 0;' });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup, { registryNames: [], advisoryTuples: [] });
  assert.deepEqual(result.gaps, []);
  assert.equal(result.documents.length, 1);
  assert.equal(result.projectRoot, sample.projectRoot);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|scripts|engines|throw 0/);
});

for (const version of [2, 3]) {
  test(`lock v${version} preserves scoped, nested and repeated occurrences; deduplicates only lookup tuples`, async (context) => {
    const root = manifest({ alpha: '^1.0.0', '@scope/beta': 'latest' }, { private: true });
    const sample = await fixture(context, { 'package.json': root,
      'package-lock.json': { ...lock(root, {
        'node_modules/alpha': record('alpha'),
        'node_modules/@scope/beta': record('@scope/beta', '2.0.0'),
        'node_modules/alpha/node_modules/gamma': record('gamma'),
        'node_modules/@scope/beta/node_modules/gamma': record('gamma'),
        'node_modules/gamma': record('gamma', '2.0.0')
      }, version), dependencies: { fake: { version: '9.0.0' } } } });
    const result = await sample.inventory();
    assert.equal(result.occurrences.length, 5);
    assert.equal(result.lookup.advisoryTuples.length, 4);
    assert.deepEqual(result.lookup.registryNames, ['@scope/beta', 'alpha']);
    assert.deepEqual(result.declarations.find((entry) => entry.name === 'alpha').lockedVersions, ['1.0.0']);
    assert.ok(result.occurrences.every((entry) => entry.lock === 'package-lock.json' && entry.manifest === 'package.json'));
    assert.doesNotMatch(JSON.stringify(result), /fake|resolved|private/);
  });
}

test('shrinkwrap takes precedence, including malformed shrinkwrap without package-lock fallback', async (context) => {
  const root = manifest({ alpha: '*' });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }),
    'npm-shrinkwrap.json': lock(root, { 'node_modules/alpha': record('alpha', '2.0.0') }) });
  assert.deepEqual((await sample.inventory()).lookup.advisoryTuples, [{ name: 'alpha', version: '2.0.0' }]);
  await fs.writeFile(path.join(sample.projectRoot, 'npm-shrinkwrap.json'), '{');
  const invalid = await inventoryDependencies(sample.vscode, sample.projectRoot);
  assert.deepEqual(invalid.lookup.advisoryTuples, []);
  assert.ok(invalid.gaps.some((entry) => /Superseded/.test(entry.reason)));
});

test('visible nested manifests own colocated locks; workspace leaves do not inherit ancestor locks', async (context) => {
  const root = manifest({}, { workspaces: ['packages/*'] });
  const leaf = manifest({ beta: '^2.0.0' }, { name: 'leaf' });
  const nested = manifest({ alpha: '^1.0.0' }, { name: 'nested' });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/beta': record('beta', '2.0.0') }),
    'packages/leaf/package.json': leaf, 'tools/package.json': nested,
    'tools/package-lock.json': lock(nested, { 'node_modules/alpha': record('alpha') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.declarations.find((entry) => entry.manifest === 'packages/leaf/package.json').lockedVersions, []);
  assert.ok(result.gaps.some((entry) => /shared workspace/.test(entry.reason)));
  assert.ok(result.occurrences.some((entry) => entry.name === 'beta' && entry.manifest === 'package.json'));
  assert.ok(result.occurrences.some((entry) => entry.name === 'alpha' && entry.lock === 'tools/package-lock.json'));
});

test('optional precedence retains group provenance, dev and peer declarations without invented resolution', async (context) => {
  const root = manifest({ alpha: '^1.0.0' }, { optionalDependencies: { alpha: '^2.0.0' },
    devDependencies: { dev: '^1' }, peerDependencies: { peer: '^3' } });
  const sample = await fixture(context, { 'package.json': root, 'package-lock.json': lock(root, {
    'node_modules/alpha': record('alpha', '2.0.0'), 'node_modules/dev': record('dev') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.declarations.find((entry) => entry.name === 'alpha'), {
    name: 'alpha', spec: '^2.0.0', groups: ['dependencies', 'optionalDependencies'], manifest: 'package.json', lockedVersions: ['2.0.0'] });
  assert.deepEqual(result.declarations.find((entry) => entry.name === 'peer').lockedVersions, []);
  assert.equal(result.lookup.advisoryTuples.length, 2);
});

for (const [label, value] of [['missing', undefined], ['v1', { lockfileVersion: 1, dependencies: { alpha: { version: '1.0.0' } } }],
  ['malformed', '{SECRET'], ['array', []], ['packages array', { lockfileVersion: 3, packages: [] }]]) {
  test(`${label} lock retains declarations but never fabricates exact versions`, async (context) => {
    const sample = await fixture(context, { 'package.json': manifest({ alpha: '^1' }),
      ...(value === undefined ? {} : { 'package-lock.json': value }) });
    const result = await sample.inventory();
    assert.deepEqual(result.lookup.registryNames, ['alpha']);
    assert.deepEqual(result.lookup.advisoryTuples, []);
    assert.deepEqual(result.declarations[0].lockedVersions, []);
    assert.ok(result.gaps.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  });
}

for (const field of ['name', 'version', 'dependencies']) {
  test(`stale lock-root ${field} invalidates lock-recorded tuples`, async (context) => {
    const root = manifest({ alpha: '^1' });
    const stale = { ...root, [field]: field === 'dependencies' ? { alpha: '^2' } : field === 'name' ? 'other' : '9.0.0' };
    const sample = await fixture(context, { 'package.json': root,
      'package-lock.json': lock(stale, { 'node_modules/alpha': record('alpha') }) });
    const result = await sample.inventory();
    assert.deepEqual(result.lookup.advisoryTuples, []);
    assert.ok(result.gaps.some((entry) => /Stale/.test(entry.reason)));
  });
}

test('direct lock versions outside effective ranges are not known current versions', async (context) => {
  const root = manifest({ alpha: '^2' });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup.advisoryTuples, []);
  assert.deepEqual(result.declarations[0].lockedVersions, []);
  assert.ok(result.gaps.some((entry) => /does not satisfy/.test(entry.reason)));
});

test('unsupported specs are generic markers and never leak URLs, credentials, aliases or local paths', async (context) => {
  const dependencies = { alias: 'npm:real@^1', git: 'git+https://SECRET@host/repo',
    file: 'file:SECRET', workspace: 'workspace:*', url: 'https://SECRET/thing', link: 'link:SECRET',
    alpha: '^1.2.0', beta: 'next', gamma: '>=1 <3', empty: '', weird: 'not/a/tag' };
  const sample = await fixture(context, { 'package.json': manifest(dependencies) });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup.registryNames, ['alpha', 'beta', 'gamma']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|npm:real|workspace:\*|not\/a\/tag/);
});

test('lock aliases, path traversal, unknown versions and workspace links do not acquire false identities', async (context) => {
  const root = manifest({ alias: '*', linked: '*' });
  const sample = await fixture(context, { 'package.json': root, 'package-lock.json': lock(root, {
    'node_modules/alias': record('real', '1.0.0', { name: 'real' }),
    'node_modules/linked': { link: true, resolved: 'packages/SECRET' },
    'node_modules/unknown': { version: 'SECRET' }, 'node_modules/vprefix': record('vprefix', 'v1.0.0'),
    'node_modules/alpha/../other': record('other'), 'packages/SECRET': manifest(),
    'node_modules/good': record('good') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup.registryNames, []);
  assert.deepEqual(result.lookup.advisoryTuples, [{ name: 'good', version: '1.0.0' }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|"name":"real"|\.\.\/other/);
});

test('known private and credential resolutions are omitted, unknown origins require later public approval', async (context) => {
  const root = manifest({ alpha: '*', beta: '*', gamma: '*', delta: '*' }, { private: true, scripts: { test: 'SECRET' } });
  const sample = await fixture(context, { 'package.json': root, 'package-lock.json': lock(root, {
    'node_modules/alpha': record('alpha', '1.0.0', { resolved: 'https://SECRET.example/alpha' }),
    'node_modules/beta': record('beta', '1.0.0', { resolved: 'https://user:SECRET@registry.npmjs.org/beta' }),
    'node_modules/gamma': { version: '1.0.0' }, 'node_modules/delta': record('delta') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup.registryNames, ['delta', 'gamma']);
  assert.equal(result.lookup.advisoryTuples.length, 2);
  assert.ok(result.gaps.some((entry) => /origin unknown/.test(entry.reason)));
  assert.doesNotMatch(JSON.stringify(result), /SECRET|resolved|scripts|example/);
});

for (const signal of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'packageManager', 'overrides']) {
  test(`${signal} ambiguity remains unsupported rather than guessing npm ownership`, async (context) => {
    const root = manifest({ alpha: '*' }, signal === 'packageManager' ? { packageManager: 'pnpm@9.0.0' } :
      signal === 'overrides' ? { overrides: { alpha: 'npm:SECRET' } } : {});
    const sample = await fixture(context, { 'package.json': root,
      'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }),
      ...(!['packageManager', 'overrides'].includes(signal) ? { [signal]: 'SECRET' } : {}) });
    const result = await sample.inventory();
    assert.deepEqual(result.lookup, { registryNames: [], advisoryTuples: [] });
    assert.equal(result.declarations[0].spec, '(unsupported)');
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  });
}

test('invalid manifest schemas and orphan locks are explicit gaps', async (context) => {
  const sample = await fixture(context, { 'package.json': manifest({ 'bad/name': '*' }),
    'orphan/package-lock.json': lock(manifest(), { 'node_modules/alpha': record('alpha') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup.advisoryTuples, []);
  assert.ok(result.gaps.some((entry) => /Invalid manifest/.test(entry.reason)));
  assert.ok(result.gaps.some((entry) => /colocated manifest/.test(entry.reason)));
});

test('hidden, dependency and existing output folders never enter document reads or lookups', async (context) => {
  const files = { 'package.json': manifest() };
  for (const folder of ['.hidden', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'coverage', 'generated', 'out', 'target']) {
    files[`${folder}/package.json`] = manifest({ secret: '*' });
  }
  const sample = await fixture(context, files);
  const result = await sample.inventory();
  assert.equal(result.documents.length, 1);
  assert.equal(result.coverage.excludedDocuments, 11);
  assert.deepEqual(result.lookup.registryNames, []);
});

test('dirty relevant buffers, duplicate canonical aliases and non-file workspace roots are rejected', async (context) => {
  const sample = await fixture(context, { 'package.json': manifest() });
  sample.vscode.workspace.textDocuments.push({ uri: sample.matches[0], isDirty: true });
  await assert.rejects(sample.inventory(), /dirty/);
  sample.vscode.workspace.textDocuments = [];
  sample.matches.push(sample.matches[0]);
  await assert.rejects(sample.inventory(), /alias/);
  sample.matches.pop();
  sample.vscode.workspace.workspaceFolders[0].uri.scheme = 'remote';
  await assert.rejects(sample.inventory(), /file workspace/);
});

test('opened root aliases canonicalize documents and preserve the dependency snapshot', async (context) => {
  const root = manifest({ alpha: '*' });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }) });
  const canonical = await sample.inventory();
  const openedRoot = path.join(path.dirname(sample.projectRoot), 'short-workspace-alias');
  const realpath = fs.realpath.bind(fs);
  context.mock.method(fs, 'realpath', async (filePath) => realpath(
    filePath === openedRoot || filePath.startsWith(`${openedRoot}${path.sep}`) ?
      path.join(sample.projectRoot, path.relative(openedRoot, filePath)) : filePath));
  sample.vscode.workspace.workspaceFolders = [{ uri: uri(openedRoot) }];
  sample.matches.splice(0, sample.matches.length, ...canonical.documents.map((document) =>
    uri(path.join(openedRoot, document.path))));
  const result = await inventoryDependencies(sample.vscode, openedRoot);
  assert.equal(result.projectRoot, sample.projectRoot);
  assert.equal(result.fingerprint, canonical.fingerprint);
  assert.deepEqual(result.lookup, canonical.lookup);
  assert.deepEqual(result.gaps, []);
  assert.equal((await inventoryDependencies(sample.vscode, sample.projectRoot)).fingerprint, canonical.fingerprint);
});

test('exact opened workspace is required; contained descendants and escaped discovery cannot authorize lookups', async (context) => {
  const sample = await fixture(context, { 'package.json': manifest(), 'nested/package.json': manifest({ alpha: '*' }) });
  await assert.rejects(inventoryDependencies(sample.vscode, path.join(sample.projectRoot, 'nested')), /open VS Code/);
  sample.matches.push(uri(path.join(sample.projectRoot, '../package.json')));
  const result = await sample.inventory();
  assert.ok(result.gaps.some((entry) => entry.path === '(outside workspace)'));
});

test('directory junction root escapes and in-root junction aliases are rejected', async (context) => {
  const sample = await fixture(context, { 'package.json': manifest(), 'nested/package.json': manifest() });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lcb-outside-'));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'package.json'), JSON.stringify(manifest({ secret: '*' })));
  const escape = path.join(sample.projectRoot, 'escape');
  await fs.symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  sample.matches.push(uri(path.join(escape, 'package.json')));
  await assert.rejects(sample.inventory(), /escapes/);
  sample.matches.pop();
  const alias = path.join(sample.projectRoot, 'alias');
  await fs.symlink(path.join(sample.projectRoot, 'nested'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  sample.matches.push(uri(path.join(alias, 'package.json')));
  await assert.rejects(sample.inventory(), /alias/);
  await assert.rejects(inventoryDependencies(sample.vscode, alias), /open VS Code/);
});

test('fingerprint binds exact bytes, document membership and deterministic lookup sets', async (context) => {
  const root = manifest({ alpha: '*' });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha') }) });
  const first = await sample.inventory();
  assert.equal(first.documents.find((entry) => entry.path === 'package.json').hash,
    createHash('sha256').update(JSON.stringify(root)).digest('hex'));
  sample.matches.reverse();
  assert.equal((await sample.inventory()).fingerprint, first.fingerprint);
  await fs.appendFile(path.join(sample.projectRoot, 'package.json'), '\n');
  const changed = await inventoryDependencies(sample.vscode, sample.projectRoot);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  sample.matches.pop();
  assert.notEqual((await inventoryDependencies(sample.vscode, sample.projectRoot)).fingerprint, changed.fingerprint);
});

test('document/name/tuple limits select deterministic subsets and disclose all remainder counts', async (context) => {
  const root = manifest(Object.fromEntries(Array.from({ length: 110 }, (_, index) => [`pkg-${String(index).padStart(3, '0')}`, '*'])));
  const packages = Object.fromEntries(Array.from({ length: 210 }, (_, index) =>
    [`node_modules/pkg-${String(index).padStart(3, '0')}`, record(`pkg-${String(index).padStart(3, '0')}`)]));
  const files = { 'package.json': root, 'package-lock.json': lock(root, packages) };
  for (let index = 0; index < 201; index += 1) files[`z-${String(index).padStart(3, '0')}/package.json`] = manifest();
  const sample = await fixture(context, files);
  const result = await sample.inventory();
  assert.equal(result.documents.length, 200);
  assert.equal(result.coverage.discoveredDocuments, 203);
  assert.equal(result.lookup.registryNames.length, 100);
  assert.equal(result.lookup.advisoryTuples.length, 200);
  assert.equal(result.coverage.omittedRegistryNames, 10);
  assert.equal(result.coverage.omittedAdvisoryTuples, 10);
  assert.equal(result.gaps.filter((entry) => /document limit/.test(entry.reason)).length, 3);
  sample.matches.reverse();
  assert.equal((await sample.inventory()).fingerprint, result.fingerprint);
});

test('document and total byte budgets bound actual reads and disclose skipped snapshots', async (context) => {
  const files = { 'package.json': manifest(), 'oversize/package.json': Buffer.alloc(DEPENDENCY_LIMITS.maxDocumentBytes + 1, 32) };
  const large = JSON.stringify({ ...manifest(), padding: 'x'.repeat(DEPENDENCY_LIMITS.maxDocumentBytes - 200) });
  for (let index = 0; index < 9; index += 1) files[`large-${index}/package.json`] = large;
  const sample = await fixture(context, files);
  const result = await sample.inventory();
  assert.ok(result.coverage.snapshotBytes <= DEPENDENCY_LIMITS.maxSnapshotBytes);
  assert.equal(result.gaps.filter((entry) => /byte limit/.test(entry.reason)).length, 2);
  assert.ok(!result.documents.some((entry) => entry.path === 'oversize/package.json'));
});

test('cancellation performs no document reads, lookups, commands or writes', async (context) => {
  const sample = await fixture(context, { 'package.json': manifest({ alpha: '*' }) });
  await assert.rejects(sample.inventory({ isCancellationRequested: true }), /cancelled/);
  sample.vscode.workspace.findFiles = async () => { throw new Error('Unexpected discovery.'); };
  await assert.rejects(sample.inventory({ isCancellationRequested: true }), /cancelled/);
});

test('unsupported origins in one manifest never overwrite unrelated public occurrence provenance', async (context) => {
  const root = manifest({ alpha: '*' });
  const nested = manifest({ alpha: '^2' }, { name: 'nested' });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha', '1.0.0', { resolved: 'file:SECRET' }) }),
    'nested/package.json': nested,
    'nested/package-lock.json': lock(nested, { 'node_modules/alpha': record('alpha', '2.0.0') }) });
  const result = await sample.inventory();
  assert.equal(result.declarations.find((entry) => entry.manifest === 'package.json').spec, '(unsupported)');
  assert.deepEqual(result.declarations.find((entry) => entry.manifest === 'nested/package.json').lockedVersions, ['2.0.0']);
  assert.deepEqual(result.lookup.advisoryTuples, [{ name: 'alpha', version: '2.0.0' }]);
  assert.equal(result.occurrences[0].manifest, 'nested/package.json');
});

test('optional registry declarations override unsupported ordinary specs in manifest and lock root', async (context) => {
  const root = manifest({ alpha: 'file:SECRET' }, { optionalDependencies: { alpha: '^2' } });
  const sample = await fixture(context, { 'package.json': root,
    'package-lock.json': lock(root, { 'node_modules/alpha': record('alpha', '2.0.0') }) });
  const result = await sample.inventory();
  assert.equal(result.declarations[0].spec, '^2');
  assert.deepEqual(result.declarations[0].groups, ['dependencies', 'optionalDependencies']);
  assert.deepEqual(result.lookup.advisoryTuples, [{ name: 'alpha', version: '2.0.0' }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('valid repeated public versions remain occurrences when a different same-name resolution is non-public', async (context) => {
  const root = manifest({ alpha: '*' });
  const sample = await fixture(context, { 'package.json': root, 'package-lock.json': lock(root, {
    'node_modules/alpha': record('alpha'), 'node_modules/beta': record('beta'),
    'node_modules/beta/node_modules/alpha': record('alpha', '2.0.0', { resolved: 'file:SECRET' }) }) });
  const result = await sample.inventory();
  assert.ok(result.occurrences.some((entry) => entry.name === 'alpha' && entry.version === '1.0.0'));
  assert.ok(!result.occurrences.some((entry) => entry.version === '2.0.0'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('unsupported transitive alias/local declarations cannot authorize ambiguous recorded package tuples', async (context) => {
  const root = manifest({ alpha: '*' });
  const sample = await fixture(context, { 'package.json': root, 'package-lock.json': lock(root, {
    'node_modules/alpha': record('alpha', '1.0.0', { dependencies: { alias: 'npm:SECRET@*', local: 'file:SECRET' } }),
    'node_modules/alias': { version: '1.0.0' }, 'node_modules/local': record('local') }) });
  const result = await sample.inventory();
  assert.deepEqual(result.lookup.advisoryTuples, [{ name: 'alpha', version: '1.0.0' }]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|"name":"alias"|"name":"local"/);
});

test('dirty buffers through canonical aliases reject while unrelated dirty buffers are ignored', async (context) => {
  const sample = await fixture(context, { 'package.json': manifest(), 'nested/package.json': manifest(), 'source.js': '' });
  const alias = path.join(sample.projectRoot, 'alias');
  await fs.symlink(path.join(sample.projectRoot, 'nested'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  sample.vscode.workspace.textDocuments.push({ uri: uri(path.join(sample.projectRoot, 'source.js')), isDirty: true });
  assert.equal((await sample.inventory()).documents.length, 2);
  sample.vscode.workspace.textDocuments.push({ uri: uri(path.join(alias, 'package.json')), isDirty: true });
  await assert.rejects(sample.inventory(), /dirty/);
});

test('package identity validation rejects encoded, credential-bearing and ambiguous names', () => {
  for (const name of ['@scope/name', 'package-name', 'under_score']) assert.equal(validPackageName(name), true);
  for (const name of ['@scope', '../escape', 'NAME', 'https://host', 'name%2fsecret', 'name:token', 'node_modules', '@s/../p']) {
    assert.equal(validPackageName(name), false);
  }
  assert.deepEqual(DEPENDENCY_LIMITS, { maxDocuments: 200, maxDocumentBytes: 4194304, maxSnapshotBytes: 33554432,
    maxRegistryNames: 100, maxAdvisoryTuples: 200, maxHttpRequests: 300, maxOsvPagesPerTuple: 5,
    maxConcurrentRequests: 4, requestTimeoutMs: 15000, maxResponseBytes: 2097152, previewTtlMs: 300000 });
});

const { assessDependencies, defaultTransport, normalizeRegistry, normalizeAdvisory } = require('../src/dependency-assessment');

function assessmentInventory(names = ['alpha'], tuples = [{ name: 'alpha', version: '1.0.0' }], specs = {}) {
  return { projectRoot: '/approved', fingerprint: 'approved-fingerprint', documents: [],
    declarations: names.map((name) => ({ name, spec: specs[name] ?? '^1', groups: ['dependencies'], manifest: 'package.json',
      lockedVersions: tuples.filter((tuple) => tuple.name === name).map((tuple) => tuple.version) })),
    occurrences: tuples.map((tuple) => ({ ...tuple, path: `node_modules/${tuple.name}`, lock: 'package-lock.json', manifest: 'package.json' })),
    lookup: { registryNames: names, advisoryTuples: tuples }, gaps: [], coverage: {}, limits: DEPENDENCY_LIMITS };
}

function packument(name = 'alpha', latest = '2.0.0', versions = ['1.0.0', '1.9.0', '2.0.0']) {
  return { name, 'dist-tags': { latest }, versions: Object.fromEntries(versions.map((version) => [version, { name, version }])) };
}

function advisory(id = 'GHSA-test-0001', extra = {}) {
  return { id, modified: '2026-10-01T12:00:00Z', aliases: ['CVE-2026-1234'],
    affected: [{ package: { name: 'alpha', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER',
      events: [{ introduced: '0' }, { fixed: '1.5.0' }] }] }], ...extra };
}

test('assessment separates latest from highest stable range candidate and only queries approved lock inputs', async () => {
  const requests = [];
  const inventory = assessmentInventory();
  const result = await assessDependencies(inventory, undefined, { transport: async (request) => {
    requests.push(request);
    return request.method === 'GET' ? packument() : {};
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.requests, 2);
  assert.equal(result.registry[0].latest.version, '2.0.0');
  assert.equal(result.registry[0].latestStable.version, '2.0.0');
  assert.equal(result.registry[0].declarations[0].candidate.version, '1.9.0');
  assert.equal(result.registry[0].declarations[0].updateCandidate.version, '2.0.0');
  assert.match(result.registry[0].declarations[0].caveats.join(' '), /changes the declared range/);
  assert.match(result.registry[0].declarations[0].caveats.join(' '), /outside.*major/);
  assert.doesNotMatch(result.registry[0].declarations[0].caveats.join(' '), /prerelease/);
  assert.deepEqual(requests[1].body, { package: { name: 'alpha', ecosystem: 'npm' }, version: '1.0.0' });
  assert.equal(result.advisories[0].outcome, 'none-returned');
  assert.deepEqual(result.inventory, inventory);
  assert.notEqual(result.inventory, inventory);
  assert.ok(Date.parse(result.completedAt) >= Date.parse(result.startedAt));
});

test('assessment empty snapshot is not applicable and sends zero requests', async () => {
  const result = await assessDependencies(assessmentInventory([], []), undefined, { transport: () => { throw new Error('Unexpected send'); } });
  assert.equal(result.status, 'not-applicable');
  assert.equal(result.requests, 0);
});

function metadataRequest(name = 'alpha') {
  return { url: `https://registry.npmjs.org/${encodeURIComponent(name)}`, method: 'GET',
    headers: { Accept: 'application/vnd.npm.install-v1+json' } };
}

function cancellationToken() {
  const listeners = new Set();
  return { isCancellationRequested: false,
    onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    cancel() { this.isCancellationRequested = true; for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size };
}

test('registry latest tag is not max semver; stable candidates exclude prereleases and explicit deprecation', () => {
  const inventory = assessmentInventory();
  const payload = packument('alpha', '1.1.0-beta.1', ['1.0.0', '1.1.0-beta.1', '1.8.0', '1.9.0', '3.0.0']);
  payload.versions['1.9.0'].deprecated = 'No longer maintained';
  const normalized = normalizeRegistry('alpha', payload, inventory.declarations);
  assert.equal(normalized.latest.version, '1.1.0-beta.1');
  assert.equal(normalized.declarations[0].candidate.version, '1.8.0');
  assert.match(normalized.declarations[0].caveats.join(' '), /prerelease/);
});

test('simple registry tags never acquire invented ranges or stable candidates', () => {
  const inventory = assessmentInventory(['alpha'], [{ name: 'alpha', version: '1.0.0' }], { alpha: 'next' });
  const normalized = normalizeRegistry('alpha', packument(), inventory.declarations);
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.declarations[0].candidate, null);
  assert.equal(normalized.declarations[0].updateCandidate, null);
  assert.match(normalized.declarations[0].caveats.join(' '), /no declared semver range/);
});

test('exact pins expose newer stable versions separately from in-range candidates', () => {
  const inventory = assessmentInventory(['alpha'], [{ name: 'alpha', version: '1.0.0' }], { alpha: '1.0.0' });
  const normalized = normalizeRegistry('alpha', packument('alpha', '1.0.0', ['1.0.0', '1.1.0']), inventory.declarations);
  assert.equal(normalized.declarations[0].candidate.version, '1.0.0');
  assert.equal(normalized.declarations[0].updateCandidate.version, '1.1.0');
  assert.match(normalized.declarations[0].caveats.join(' '), /changes the declared range/);
});

test('deprecated or metadata-unknown releases never become direct update candidates', () => {
  const inventory = assessmentInventory(['alpha'], [{ name: 'alpha', version: '1.0.0' }], { alpha: '1.0.0' });
  const payload = packument('alpha', '1.1.0', ['1.0.0', '1.1.0']);
  payload.versions['1.1.0'].deprecated = 'Do not use';
  assert.equal(normalizeRegistry('alpha', payload, inventory.declarations).declarations[0].updateCandidate, null);
  payload.versions['1.1.0'].deprecated = '';
  payload.versions['1.1.0'].engines = 'invalid';
  const incomplete = normalizeRegistry('alpha', payload, inventory.declarations);
  assert.equal(incomplete.declarations[0].updateCandidate.version, '1.1.0');
  assert.equal(incomplete.declarations[0].updateCandidate.status, 'unknown');
  assert.match(incomplete.declarations[0].caveats.join(' '), /metadata is incomplete/);
});

test('malformed metadata on an unrelated historical release does not taint an exact-pin assessment', () => {
  const inventory = assessmentInventory(['lodash'], [{ name: 'lodash', version: '4.17.20' }], { lodash: '4.17.20' });
  const payload = packument('lodash', '4.18.1', ['4.17.19', '4.17.20', '4.18.1']);
  payload.versions['4.17.19'].engines = 'invalid';

  const normalized = normalizeRegistry('lodash', payload, inventory.declarations);

  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.latest.version, '4.18.1');
  assert.equal(normalized.lockedVersions[0].version, '4.17.20');
  assert.equal(normalized.declarations[0].updateCandidate.version, '4.18.1');
  assert.deepEqual(normalized.gaps, []);
});

test('deprecation is exact-version-specific, not inferred from latest or age', () => {
  const payload = packument();
  payload.versions['1.0.0'].deprecated = 'Old explicit message';
  payload.versions['2.0.0'].deprecated = '';
  payload.time = { '1.0.0': '1990-01-01' };
  const normalized = normalizeRegistry('alpha', payload, assessmentInventory().declarations);
  assert.equal(normalized.lockedVersions[0].deprecated, 'Old explicit message');
  assert.equal(normalized.lockedVersions[0].deprecationStatus, 'deprecated');
  assert.equal(normalized.latest.deprecationStatus, 'not-declared');
  assert.doesNotMatch(JSON.stringify(normalized), /1990|EOL|installed|safe upgrade/);
});

for (const [label, change] of [
  ['missing exact metadata', (payload) => { delete payload.versions['1.0.0']; }],
  ['invalid version key', (payload) => { payload.versions['v1.4.0'] = { version: '1.4.0' }; }],
  ['version identity mismatch', (payload) => { payload.versions['1.0.0'].version = '1.0.1'; }],
  ['package record identity mismatch', (payload) => { payload.versions['1.0.0'].name = 'other'; }],
  ['invalid deprecated type', (payload) => { payload.versions['1.0.0'].deprecated = true; }],
  ['missing latest record', (payload) => { payload['dist-tags'].latest = '9.0.0'; }],
  ['invalid latest version', (payload) => { payload['dist-tags'].latest = 'v2.0.0'; }],
  ['malformed version record', (payload) => { payload.versions['1.0.0'] = null; }]
]) {
  test(`registry ${label} is incomplete even if other latest metadata is valid`, async () => {
    const payload = packument();
    change(payload);
    const result = await assessDependencies(assessmentInventory(), undefined,
      { transport: async (request) => request.method === 'GET' ? payload : {} });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.registry[0].status, 'incomplete');
    assert.ok(result.gaps.length);
  });
}

test('missing locked exact metadata remains unknown alongside valid latest', () => {
  const payload = packument();
  delete payload.versions['1.0.0'];
  const normalized = normalizeRegistry('alpha', payload, assessmentInventory().declarations);
  assert.equal(normalized.latest.version, '2.0.0');
  assert.equal(normalized.lockedVersions[0].status, 'unknown');
  assert.equal(normalized.lockedVersions[0].deprecationStatus, 'unknown');
  assert.equal(normalized.status, 'incomplete');
});

test('registry retains only safe engines and peers, never full packument, URLs, contacts or scripts', () => {
  const payload = packument();
  Object.assign(payload.versions['1.0.0'], { engines: { node: '>=18' }, peerDependencies: { '@scope/peer': '^2' },
    scripts: { install: 'SECRET' }, dist: { tarball: 'https://evil.example/SECRET' }, author: { email: 'SECRET' }, readme: 'SECRET' });
  payload.versions['1.9.0'].engines = { node: 'https://evil.example/SECRET' };
  payload.versions['2.0.0'].deprecated = '<a href="https://evil.example/SECRET">bad</a>';
  const normalized = normalizeRegistry('alpha', payload, assessmentInventory().declarations);
  assert.deepEqual(normalized.lockedVersions[0].engines, { node: '>=18' });
  assert.deepEqual(normalized.lockedVersions[0].peerDependencies, { '@scope/peer': '^2' });
  assert.equal(normalized.status, 'incomplete');
  assert.doesNotMatch(JSON.stringify(normalized), /SECRET|evil|scripts|tarball|author|readme|<a/);
});

test('multiple locked direct versions retain separate metadata and outgoing exact tuples', async () => {
  const tuples = [{ name: 'alpha', version: '1.0.0' }, { name: 'alpha', version: '1.9.0' }];
  const inventory = assessmentInventory(['alpha'], tuples);
  inventory.declarations.push({ ...inventory.declarations[0], manifest: 'nested/package.json', lockedVersions: ['1.9.0'] });
  inventory.occurrences.push({ ...inventory.occurrences[1], manifest: 'nested/package.json', lock: 'nested/package-lock.json' });
  const requests = [];
  const result = await assessDependencies(inventory, undefined, { transport: async (request) => {
    requests.push(request); return request.method === 'GET' ? packument() : {};
  } });
  assert.equal(result.registry[0].lockedVersions.length, 2);
  assert.equal(result.registry[0].declarations.length, 2);
  assert.deepEqual(requests.filter((request) => request.body).map((request) => request.body.version), ['1.0.0', '1.9.0']);
});

test('lockless ranges never cause OSV or candidate queries; inherited inventory gaps remain incomplete', async () => {
  const inventory = assessmentInventory(['alpha'], []);
  inventory.gaps.push({ path: 'package.json', reason: 'Missing lock.' });
  const requests = [];
  const result = await assessDependencies(inventory, undefined, { transport: async (request) => { requests.push(request); return packument(); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.deepEqual(result.advisories, []);
  assert.match(result.registry[0].declarations[0].caveats.join(' '), /locked direct version unknown/);
});

test('OSV matches preserve npm provenance, published severity and fixes with separate withdrawals', async () => {
  const active = advisory('GHSA-test-0001', { severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L' }],
    database_specific: { severity: 'HIGH', html: 'SECRET' }, details: '<script>SECRET</script>',
    references: [{ url: 'https://evil.example/SECRET' }] });
  active.affected.push({ package: { name: 'other', ecosystem: 'PyPI' }, versions: ['9.0.0'] });
  const withdrawn = advisory('GHSA-test-0002', { withdrawn: '2026-10-02T12:00:00Z' });
  const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
    { transport: async () => ({ vulns: [active, active, withdrawn] }) });
  const entry = result.advisories[0];
  assert.equal(entry.status, 'completed');
  assert.equal(entry.activeCount, 1);
  assert.equal(entry.withdrawnCount, 1);
  assert.equal(entry.matches[0].affected.length, 1);
  assert.deepEqual(entry.matches[0].affected[0].ranges[0].events[1], { fixed: '1.5.0' });
  assert.deepEqual(entry.matches[0].severity, active.severity);
  assert.equal(entry.matches[0].databaseSeverity, 'HIGH');
  assert.equal(entry.matches[1].severityStatus, 'unknown');
  assert.equal(entry.matches[0].url, 'https://osv.dev/vulnerability/GHSA-test-0001');
  assert.doesNotMatch(JSON.stringify(entry), /SECRET|evil|details|references|PyPI/);
});

test('advisory IDs are canonical deduplication keys; shared aliases do not imply unique vulnerabilities', async () => {
  const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
    { transport: async () => ({ vulns: [advisory('OSV-one'), advisory('OSV-two')] }) });
  assert.equal(result.advisories[0].matches.length, 2);
  assert.deepEqual(result.advisories[0].matches[0].aliases, result.advisories[0].matches[1].aliases);
  assert.equal(normalizeAdvisory('alpha', advisory('OSV:encoded')).record.url, 'https://osv.dev/vulnerability/OSV%3Aencoded');
});

test('OSV token-only pages are followed and duplicate canonical records do not inflate counts', async () => {
  const bodies = [];
  const pages = [{ next_page_token: 'first' }, { vulns: [advisory()], next_page_token: 'second' }, { vulns: [advisory()] }];
  const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
    { transport: async (request) => { bodies.push(request.body); return pages.shift(); } });
  assert.equal(result.requests, 3);
  assert.equal(result.advisories[0].pages, 3);
  assert.equal(result.advisories[0].activeCount, 1);
  assert.deepEqual(bodies.map((body) => body.page_token), [undefined, 'first', 'second']);
  assert.ok(bodies.every((body) => body.version === '1.0.0' && body.package.ecosystem === 'npm'));
});

for (const [label, pages, reason] of [
  ['repeated token', [{ vulns: [advisory()], next_page_token: 'repeat' }, { next_page_token: 'repeat' }], 'repeated-page-token'],
  ['malformed next token', [{ vulns: [advisory()], next_page_token: 10 }], 'malformed-page'],
  ['malformed vulnerabilities', [{ vulns: [advisory()], next_page_token: 'next' }, { vulns: null }], 'malformed-page'],
  ['HTTP failure', [{ vulns: [advisory()], next_page_token: 'next' }, new Error('SECRET service failure')], 'service-unavailable']
]) {
  test(`OSV ${label} retains partial matches without a completed no-match outcome`, async () => {
    const responses = [...pages];
    const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
      { transport: async () => { const response = responses.shift(); if (response instanceof Error) throw response; return response; } });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.advisories[0].status, 'incomplete');
    assert.equal(result.advisories[0].outcome, 'provider-matches');
    assert.equal(result.advisories[0].activeCount, 1);
    assert.ok(result.advisories[0].gaps.includes(reason));
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  });
}

for (const [label, invalid] of [
  ['package identity', advisory('OSV-invalid', { affected: [{ package: { name: 'other', ecosystem: 'npm' }, versions: ['1.0.0'] }] })],
  ['ecosystem identity', advisory('OSV-invalid', { affected: [{ package: { name: 'alpha', ecosystem: 'PyPI' }, versions: ['1.0.0'] }] })],
  ['record ID', advisory('https://evil.example/SECRET')],
  ['modified date', advisory('OSV-invalid', { modified: 'yesterday' })],
  ['withdrawn date', advisory('OSV-invalid', { withdrawn: true })],
  ['aliases', advisory('OSV-invalid', { aliases: ['<script>SECRET</script>'] })],
  ['severity', advisory('OSV-invalid', { severity: [{ type: 'CVSS_V3', score: '<script>SECRET</script>' }] })],
  ['affected ranges', advisory('OSV-invalid', { affected: [{ package: { name: 'alpha', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [] }] }] })]
]) {
  test(`malformed advisory ${label} cannot establish completed coverage`, async () => {
    const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
      { transport: async () => ({ vulns: [invalid] }) });
    assert.equal(result.status, 'incomplete');
    assert.notEqual(result.advisories[0].outcome, 'none-returned');
    assert.doesNotMatch(JSON.stringify(result), /SECRET|evil/);
  });
}

test('conflicting records with the same canonical ID keep coverage incomplete', async () => {
  const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
    { transport: async () => ({ vulns: [advisory(), advisory('GHSA-test-0001', { modified: '2026-10-03T12:00:00Z' })] }) });
  assert.equal(result.advisories[0].activeCount, 1);
  assert.equal(result.advisories[0].matches[0].modified, '2026-10-03T12:00:00Z');
  assert.equal(result.status, 'incomplete');
});

test('page caps and request budgets include every OSV page and never silently imply no matches', async () => {
  let calls = 0;
  const inventory = assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }, { name: 'beta', version: '1.0.0' }]);
  const result = await assessDependencies(inventory, undefined, { limits: { maxOsvPagesPerTuple: 2, maxHttpRequests: 2 },
    transport: async () => ({ next_page_token: `page-${++calls}` }) });
  assert.equal(result.requests, 2);
  assert.equal(result.advisories[0].pages, 2);
  assert.ok(result.advisories[0].gaps.includes('page-limit'));
  assert.ok(result.advisories[1].gaps.includes('request-budget'));
  assert.equal(result.advisories[1].queried, false);
  assert.ok(result.advisories.every((entry) => entry.outcome === 'unknown'));
});

test('default 300-request budget bounds 100 registry names plus 200 tuples with pagination', async () => {
  const names = Array.from({ length: 100 }, (_, index) => `package-${index}`);
  const tuples = names.flatMap((name) => [{ name, version: '1.0.0' }, { name, version: '1.1.0' }]);
  let pages = 0;
  let active = 0;
  let maximum = 0;
  const result = await assessDependencies(assessmentInventory(names, tuples), undefined, { transport: async (request) => {
    active += 1; maximum = Math.max(maximum, active);
    await Promise.resolve();
    active -= 1;
    if (request.method === 'GET') return packument(decodeURIComponent(new URL(request.url).pathname.slice(1)), '1.1.0', ['1.0.0', '1.1.0']);
    return request.body.package.name === 'package-0' && request.body.version === '1.0.0' ? { next_page_token: `page-${++pages}` } : {};
  } });
  assert.equal(result.requests, 300);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.advisories[0].pages, 5);
  assert.equal(result.advisories.filter((entry) => !entry.queried).length, 4);
  assert.ok(maximum <= DEPENDENCY_LIMITS.maxConcurrentRequests);
});

test('lower-only test limits cannot widen approved budgets; omitted lookup evidence stays unknown', async () => {
  let calls = 0;
  const inventory = assessmentInventory(['alpha', 'beta'], []);
  const result = await assessDependencies(inventory, undefined, { limits: { maxRegistryNames: 1 },
    transport: async () => { calls += 1; return packument(); } });
  assert.equal(calls, 1);
  assert.equal(result.registry[1].status, 'unknown');
  assert.equal(result.status, 'incomplete');
  await assert.rejects(assessDependencies(inventory, undefined, { limits: { maxHttpRequests: 301 } }), /invalid-limits/);
});

test('assessment validates every approved name and exact lock tuple before any request', async () => {
  for (const change of [
    (inventory) => { inventory.lookup.registryNames.push('https://evil.example/SECRET'); },
    (inventory) => { inventory.lookup.registryNames.push('not-declared'); },
    (inventory) => { inventory.lookup.advisoryTuples.push({ name: 'alpha', version: '2.0.0' }); },
    (inventory) => { inventory.lookup.advisoryTuples[0].version = '^1'; },
    (inventory) => { inventory.lookup.advisoryTuples[0].version = 'v1.0.0'; },
    (inventory) => { inventory.lookup.registryNames.push('alpha'); },
    (inventory) => { inventory.declarations[0].lockedVersions.push('9.0.0'); }
  ]) {
    const inventory = assessmentInventory();
    change(inventory);
    await assert.rejects(assessDependencies(inventory, undefined, { transport: () => { throw new Error('Unexpected send'); } }), /invalid-inventory/);
  }
});

test('assessment snapshots approved facts and never rediscovers targets when caller input changes', async () => {
  const inventory = assessmentInventory();
  const requests = [];
  const result = await assessDependencies(inventory, undefined, { transport: async (request) => {
    requests.push(request);
    inventory.lookup.advisoryTuples.push({ name: 'extra', version: '9.0.0' });
    return request.method === 'GET' ? packument() : {};
  } });
  assert.equal(requests.length, 2);
  assert.equal(result.inventory.lookup.advisoryTuples.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /extra|9\.0\.0/);
});

test('cancellation before assessment sends zero; cancellation during a page stops all later targets', async () => {
  const cancelled = cancellationToken();
  cancelled.cancel();
  const before = await assessDependencies(assessmentInventory(), cancelled, { transport: () => { throw new Error('Unexpected send'); } });
  assert.equal(before.status, 'cancelled');
  assert.equal(before.requests, 0);
  const token = cancellationToken();
  const result = await assessDependencies(assessmentInventory(['alpha', 'beta']), token, { transport: async () => {
    token.cancel(); return packument();
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.requests, 1);
  assert.equal(result.registry[1].queried, false);
  assert.equal(result.advisories[0].queried, false);
  assert.equal(token.listenerCount(), 0);
});

test('injected transport timeout and response caps produce unknown evidence without retries', async () => {
  const timed = await assessDependencies(assessmentInventory(['alpha'], []), undefined,
    { limits: { requestTimeoutMs: 5 }, transport: () => new Promise(() => {}) });
  assert.equal(timed.requests, 1);
  assert.ok(timed.registry[0].gaps.includes('timeout'));
  const oversized = await assessDependencies(assessmentInventory(['alpha'], []), undefined,
    { limits: { maxResponseBytes: 64 }, transport: async () => packument() });
  assert.equal(oversized.requests, 1);
  assert.ok(oversized.registry[0].gaps.includes('response-size-limit'));
});

test('default transport uses exact encoded endpoints, manual redirects, no auth or cookies', async () => {
  const calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return new Response('{"ok":true}'); };
  assert.deepEqual(await defaultTransport(metadataRequest('@scope/name'), undefined, DEPENDENCY_LIMITS, { fetch }), { ok: true });
  const request = { url: 'https://api.osv.dev/v1/query', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { package: { name: '@scope/name', ecosystem: 'npm' }, version: '1.0.0', page_token: 'next' } };
  await defaultTransport(request, undefined, DEPENDENCY_LIMITS, { fetch });
  assert.equal(calls[0].url, 'https://registry.npmjs.org/%40scope%2Fname');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.headers.Cookie, undefined);
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), request.body);
});

test('default transport rejects arbitrary URLs, credentials, methods, headers and inexact OSV bodies before fetch', async () => {
  const osv = { url: 'https://api.osv.dev/v1/query', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { package: { name: 'alpha', ecosystem: 'npm' }, version: '1.0.0' } };
  const invalid = [
    { ...metadataRequest(), url: 'https://evil.example/alpha' },
    { ...metadataRequest(), url: 'http://registry.npmjs.org/alpha' },
    { ...metadataRequest(), url: 'https://user:SECRET@registry.npmjs.org/alpha' },
    { ...metadataRequest(), url: 'https://registry.npmjs.org/alpha?token=SECRET' },
    { ...metadataRequest(), url: 'https://registry.npmjs.org/alpha#SECRET' },
    { ...metadataRequest(), url: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz' },
    { ...metadataRequest(), headers: { Authorization: 'SECRET' } },
    { ...metadataRequest(), method: 'POST' },
    { ...osv, body: { ...osv.body, version: '^1' } },
    { ...osv, body: { ...osv.body, package: { name: 'alpha', ecosystem: 'PyPI' } } },
    { ...osv, body: { ...osv.body, extra: 'SECRET' } },
    { ...osv, body: { ...osv.body, package: { ...osv.body.package, purl: 'SECRET' } } }
  ];
  for (const request of invalid) {
    await assert.rejects(defaultTransport(request, undefined, DEPENDENCY_LIMITS,
      { fetch: () => { throw new Error('Unexpected fetch'); } }), /invalid-request/);
  }
});

test('default transport bounds request bodies before fetch', async () => {
  const request = { url: 'https://api.osv.dev/v1/query', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { package: { name: 'alpha', ecosystem: 'npm' }, version: '1.0.0', page_token: 'x'.repeat(80) } };
  await assert.rejects(defaultTransport(request, undefined, { ...DEPENDENCY_LIMITS, maxResponseBytes: 100 },
    { fetch: () => { throw new Error('Unexpected fetch'); } }), /request-body-limit/);
});

test('default transport rejects HTTP failures and redirects without following or retrying', async () => {
  for (const status of [301, 302, 307, 308, 404, 429, 500]) {
    let calls = 0;
    await assert.rejects(defaultTransport(metadataRequest(), undefined, DEPENDENCY_LIMITS, { fetch: async () => {
      calls += 1; return new Response('SECRET', { status, headers: { location: 'https://evil.example/SECRET' } });
    } }), status < 400 ? /redirect-rejected/ : /http-unavailable/);
    assert.equal(calls, 1);
  }
});

test('default transport caps streamed bytes without content-length and cancels the reader', async () => {
  let cancellations = 0;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(9));
  }, cancel() { cancellations += 1; } });
  await assert.rejects(defaultTransport(metadataRequest(), undefined, { ...DEPENDENCY_LIMITS, maxResponseBytes: 16 },
    { fetch: async () => new Response(body) }), /response-size-limit/);
  assert.equal(cancellations, 1);
});

test('default transport rejects excessive declared size, malformed JSON and invalid UTF-8', async () => {
  for (const [response, message] of [
    [new Response('{}', { headers: { 'content-length': String(DEPENDENCY_LIMITS.maxResponseBytes + 1) } }), /response-size-limit/],
    [new Response('{SECRET'), /malformed-json/],
    [new Response(new Uint8Array([0xff])), /malformed-json/]
  ]) {
    await assert.rejects(defaultTransport(metadataRequest(), undefined, DEPENDENCY_LIMITS, { fetch: async () => response }), message);
  }
});

test('default transport accepts JSON split across Response stream chunks', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('{"value":')); controller.enqueue(Buffer.from('42}')); controller.close();
  } });
  assert.deepEqual(await defaultTransport(metadataRequest(), undefined, DEPENDENCY_LIMITS,
    { fetch: async () => new Response(body) }), { value: 42 });
});

test('default transport times out stalled fetches and stalled Response streams', async () => {
  let fetchSignal;
  await assert.rejects(defaultTransport(metadataRequest(), undefined, { ...DEPENDENCY_LIMITS, requestTimeoutMs: 5 },
    { fetch: (url, options) => { fetchSignal = options.signal; return new Promise(() => {}); } }), /timeout/);
  assert.equal(fetchSignal.aborted, true);
  let cancellations = 0;
  const body = new ReadableStream({ cancel() { cancellations += 1; } });
  await assert.rejects(defaultTransport(metadataRequest(), undefined, { ...DEPENDENCY_LIMITS, requestTimeoutMs: 5 },
    { fetch: async () => new Response(body) }), /timeout/);
  assert.equal(cancellations, 1);
});

test('default transport links VS Code cancellation and disposes listeners on completion', async () => {
  const token = cancellationToken();
  let signal;
  await assert.rejects(defaultTransport(metadataRequest(), token, DEPENDENCY_LIMITS, { fetch: (url, options) => {
    signal = options.signal; token.cancel(); return new Promise(() => {});
  } }), /cancelled/);
  assert.equal(signal.aborted, true);
  assert.equal(token.listenerCount(), 0);
  const before = cancellationToken(); before.cancel();
  await assert.rejects(defaultTransport(metadataRequest(), before, DEPENDENCY_LIMITS,
    { fetch: () => { throw new Error('Unexpected fetch'); } }), /cancelled/);
});

test('assessment default adapter never fetches returned reference or tarball URLs and does not query candidates', async () => {
  const urls = [];
  const result = await assessDependencies(assessmentInventory(), undefined, { fetch: async (url, options) => {
    urls.push({ url, body: options.body });
    const payload = options.method === 'GET' ? packument() : { vulns: [advisory('OSV-one',
      { references: [{ url: 'https://evil.example/SECRET' }], details: 'SECRET' })] };
    if (options.method === 'GET') payload.versions['1.9.0'].dist = { tarball: 'https://evil.example/SECRET' };
    return new Response(JSON.stringify(payload));
  } });
  assert.equal(result.requests, 2);
  assert.deepEqual(urls.map((entry) => entry.url), ['https://registry.npmjs.org/alpha', 'https://api.osv.dev/v1/query']);
  assert.equal(JSON.parse(urls[1].body).version, '1.0.0');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|evil/);
});

test('declared and locked prereleases retain caveats even when latest is stable', () => {
  const inventory = assessmentInventory(['alpha'], [{ name: 'alpha', version: '1.0.0-beta.1' }], { alpha: '^1.0.0-beta.1' });
  const normalized = normalizeRegistry('alpha', packument('alpha', '1.9.0', ['1.0.0-beta.1', '1.9.0']), inventory.declarations);
  assert.equal(normalized.declarations[0].candidate.version, '1.9.0');
  assert.match(normalized.declarations[0].caveats.join(' '), /prerelease comparators/);
  assert.match(normalized.declarations[0].caveats.join(' '), /locked direct version is a prerelease/);
});

test('unsafe explicit deprecation is retained as a fact with omitted message and unknown metadata', () => {
  const payload = packument();
  payload.versions['1.0.0'].deprecated = '<a href="https://evil.example/SECRET">obsolete</a>';
  const normalized = normalizeRegistry('alpha', payload, assessmentInventory().declarations);
  assert.equal(normalized.lockedVersions[0].deprecationStatus, 'deprecated');
  assert.equal(normalized.lockedVersions[0].deprecated, null);
  assert.equal(normalized.lockedVersions[0].status, 'unknown');
  assert.equal(normalized.status, 'incomplete');
  assert.doesNotMatch(JSON.stringify(normalized), /SECRET|evil|<a/);
});

test('packument identity failure is independent of completed exact OSV evidence', async () => {
  const result = await assessDependencies(assessmentInventory(), undefined,
    { transport: async (request) => request.method === 'GET' ? packument('other') : {} });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.registry[0].gaps.includes('registry-identity-or-schema'));
  assert.equal(result.registry[0].latest, null);
  assert.equal(result.advisories[0].status, 'completed');
  assert.equal(result.advisories[0].outcome, 'none-returned');
});

test('unexpected OSV success-envelope fields cannot become none-returned evidence', async () => {
  for (const payload of [{ error: 'SECRET' }, [], null, { next_page_token: null }]) {
    const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
      { transport: async () => payload });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.advisories[0].outcome, 'unknown');
    assert.ok(result.advisories[0].gaps.includes('malformed-page'));
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('invalid advisory calendar dates are not preserved as modified provenance', async () => {
  const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }]), undefined,
    { transport: async () => ({ vulns: [advisory('OSV-date', { modified: '2026-02-30T12:00:00Z' })] }) });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.advisories[0].matches.length, 0);
});

test('matching affected-entry severity is preserved without evaluation or numeric conversion', () => {
  const value = advisory();
  value.affected[0].severity = [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L' }];
  const normalized = normalizeAdvisory('alpha', value);
  assert.deepEqual(normalized.record.affected[0].severity, value.affected[0].severity);
  assert.deepEqual(normalized.record.severity, []);
  assert.equal(normalized.record.severityStatus, 'supplied');
  assert.deepEqual(normalized.gaps, []);
});

test('cancellation after a completed OSV page preserves only earlier provider matches', async () => {
  const token = cancellationToken();
  let calls = 0;
  const result = await assessDependencies(assessmentInventory([], [{ name: 'alpha', version: '1.0.0' }, { name: 'beta', version: '1.0.0' }]),
    token, { transport: async () => {
      calls += 1;
      if (calls === 1) return { vulns: [advisory()], next_page_token: 'next' };
      token.cancel();
      return {};
    } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.requests, 2);
  assert.equal(result.advisories[0].status, 'incomplete');
  assert.equal(result.advisories[0].activeCount, 1);
  assert.equal(result.advisories[1].queried, false);
  assert.equal(token.listenerCount(), 0);
});

test('default transport cancellation during a Response stream cancels bounded reads', async () => {
  const token = cancellationToken();
  let cancellations = 0;
  let signal;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{')); },
    pull() { token.cancel(); }, cancel() { cancellations += 1; } }, { highWaterMark: 0 });
  await assert.rejects(defaultTransport(metadataRequest(), token, DEPENDENCY_LIMITS,
    { fetch: async (url, options) => { signal = options.signal; return new Response(body); } }), /cancelled/);
  assert.equal(signal.aborted, true);
  assert.equal(cancellations, 1);
  assert.equal(token.listenerCount(), 0);
});

test('default adapter errors are sanitized and reported per service with no retry', async () => {
  let calls = 0;
  const result = await assessDependencies(assessmentInventory(), undefined, { fetch: async () => {
    calls += 1;
    return new Response('SECRET', { status: 503 });
  } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.requests, 2);
  assert.equal(calls, 2);
  assert.ok(result.registry[0].gaps.includes('http-unavailable'));
  assert.ok(result.advisories[0].gaps.includes('http-unavailable'));
  assert.equal(result.advisories[0].outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  await assert.rejects(defaultTransport(metadataRequest(), undefined, DEPENDENCY_LIMITS,
    { fetch: async () => { throw new Error('SECRET connection details'); } }), /^Error: Dependency metadata service-unavailable\.$/);
});
