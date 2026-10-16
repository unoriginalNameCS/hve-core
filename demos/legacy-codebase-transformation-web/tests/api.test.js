'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const test = require('node:test');
const { createApiApp } = require('../server/api');
const { getSession, removeSession } = require('../server/workflow');

const env = {
  FOUNDRY_API_KEY: 'test-key',
  FOUNDRY_ENDPOINT: 'https://sample.services.ai.azure.com',
  FOUNDRY_MODEL: 'gpt-4.1-mini'
};

async function startServer(context, options) {
  const server = createApiApp(options).listen(0, '127.0.0.1');
  context.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function upload(baseUrl, rootName, files) {
  const form = new FormData();
  const entries = [...files];
  form.append('manifest', JSON.stringify(entries.map(([relativePath, bytes], index) => ({
    id: `file-${index}`, path: `${rootName}/${relativePath}`, size: bytes.length
  }))));
  entries.forEach(([, bytes], index) => form.append('files', new Blob([bytes]), `file-${index}`));
  const response = await fetch(`${baseUrl}/api/analyze/prepare`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  return response.json();
}

function readZipEntry(zip, targetName) {
  const endRecord = zip.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.notEqual(endRecord, -1, 'ZIP end-of-central-directory record is missing');
  let directoryOffset = zip.readUInt32LE(endRecord + 16);
  const entryCount = zip.readUInt16LE(endRecord + 10);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    assert.equal(zip.readUInt32LE(directoryOffset), 0x02014b50, 'ZIP central directory entry is invalid');
    const compression = zip.readUInt16LE(directoryOffset + 10);
    const compressedSize = zip.readUInt32LE(directoryOffset + 20);
    const nameLength = zip.readUInt16LE(directoryOffset + 28);
    const extraLength = zip.readUInt16LE(directoryOffset + 30);
    const commentLength = zip.readUInt16LE(directoryOffset + 32);
    const localOffset = zip.readUInt32LE(directoryOffset + 42);
    const name = zip.toString('utf8', directoryOffset + 46, directoryOffset + 46 + nameLength);
    if (name === targetName) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      if (compression === 0) return compressed.toString('utf8');
      if (compression === 8) return inflateRawSync(compressed).toString('utf8');
      throw new Error(`Unsupported ZIP compression method ${compression}.`);
    }
    directoryOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${targetName}`);
}

function fakeTransform({ unit }) {
  return {
    unitId: unit.id,
    path: unit.path,
    name: unit.name,
    status: 'ready',
    originalText: unit.originalText,
    replacementText: unit.kind === 'statement' ? 'const amount = 4;' : unit.originalText,
    rationale: 'The focused test supplies an approved proposal.',
    gates: [{ id: 'static', status: 'pass' }, { id: 'characterisation', status: 'not-checked' }],
    baseline: { status: 'not-checked', reason: 'Not checked in this API test.' },
    warningAcknowledgementRequired: true
  };
}

test('assessment through approved apply returns a ZIP with the combined technical debt report', async (context) => {
  let sessionId;
  const baseUrl = await startServer(context, { env, transformUnit: fakeTransform });
  const prepared = await upload(baseUrl, 'sample', new Map([['src/value.js', Buffer.from('var amount = 4;')]]));
  sessionId = prepared.sessionId;
  assert.ok(prepared.assessment.findings.some((item) => item.ruleId === 'var-declaration'));
  assert.equal(prepared.sourceDisclosure, undefined);

  const unit = prepared.assessment.units.find((item) => item.kind === 'statement');
  const transformedResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/transform`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitIds: [unit.id], approved: true })
  });
  assert.equal(transformedResponse.status, 200);
  const transformed = await transformedResponse.json();
  const proposalId = transformed.proposals[0].id;

  const blockedApply = await fetch(`${baseUrl}/api/sessions/${sessionId}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedProposalIds: [proposalId], acknowledgedWarnings: [] })
  });
  assert.equal(blockedApply.status, 400);

  const applied = await fetch(`${baseUrl}/api/sessions/${sessionId}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedProposalIds: [proposalId], acknowledgedWarnings: [proposalId] })
  });
  assert.equal(applied.status, 200);
  const downloaded = await fetch(`${baseUrl}/api/sessions/${sessionId}/download`);
  assert.equal(downloaded.status, 200);
  const zip = Buffer.from(await downloaded.arrayBuffer());
  assert.ok(zip.includes(Buffer.from('TECH-DEBT-REPORT.md')));
  const report = readZipEntry(zip, 'TECH-DEBT-REPORT.md');
  assert.match(report, /Technical Debt Transformation Report/);
  assert.match(report, /Assessment before:/);
  assert.match(report, /Assessment after:/);
  assert.equal(getSession(sessionId).changeReport.sourceChanges.length, 1);
});

test('dependency assessment follows combined approval and build runs only after its checkpoint', async (context) => {
  let sessionId;
  const metadataCalls = [];
  const dependencyCalls = [];
  const buildCalls = [];
  const baseUrl = await startServer(context, {
    env,
    transformUnit: fakeTransform,
    metadataFetchImpl: async (url) => {
      metadataCalls.push(url);
      if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
      return new Response(JSON.stringify({
        name: 'sample-lib', 'dist-tags': { latest: '1.2.0' },
        versions: { '1.0.0': { name: 'sample-lib', version: '1.0.0' }, '1.2.0': { name: 'sample-lib', version: '1.2.0' } }
      }), { status: 200 });
    },
    runDependencyCommand: async ({ cwd, stage }) => {
      dependencyCalls.push(stage);
      if (stage === 'resolve') {
        const lockPath = path.join(cwd, 'package-lock.json');
        const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        lock.packages[''].dependencies['sample-lib'] = '1.2.0';
        lock.packages['node_modules/sample-lib'] = {
          version: '1.2.0', resolved: 'https://registry.npmjs.org/sample-lib/-/sample-lib-1.2.0.tgz', integrity: 'sha512-sample'
        };
        await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
      }
      return { exitCode: 0, output: `${stage} completed` };
    },
    runBuildCommand: async ({ stage }) => {
      buildCalls.push(stage);
      return { exitCode: 0, output: `${stage} passed` };
    }
  });

  const manifest = {
    name: 'sample', version: '1.0.0', private: true,
    scripts: { build: 'node scripts/build.js' },
    dependencies: { 'sample-lib': '1.0.0' }
  };
  const lock = {
    name: 'sample', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'sample', version: '1.0.0', dependencies: manifest.dependencies },
      'node_modules/sample-lib': { version: '1.0.0', resolved: 'https://registry.npmjs.org/sample-lib/-/sample-lib-1.0.0.tgz', integrity: 'sha512-old' }
    }
  };
  const prepared = await upload(baseUrl, 'sample', new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest))],
    ['package-lock.json', Buffer.from(JSON.stringify(lock))],
    ['src/main.js', Buffer.from('function inspect(value) { return value; }\nmodule.exports = { inspect };')]
  ]));
  sessionId = prepared.sessionId;
  const unit = prepared.assessment.units.find((item) => item.kind === 'function');
  const transformedResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/transform`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitIds: [unit.id], checkDependencies: true, approved: true })
  });
  assert.equal(transformedResponse.status, 200);
  const transformed = await transformedResponse.json();
  assert.equal(transformed.dependencyAssessment.status, 'completed');
  assert.equal(metadataCalls.length, 2);

  const updateResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/updates/prepare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedProposalIds: [], acknowledgedWarnings: [], selectedUpdateNames: ['sample-lib'] })
  });
  assert.equal(updateResponse.status, 200);
  const updatePreview = await updateResponse.json();
  assert.deepEqual(updatePreview.packageDiff.map(({ name, version }) => ({ name, version })), [{ name: 'sample-lib', version: '1.2.0' }]);
  assert.deepEqual(dependencyCalls, ['resolve']);

  const blockedBuild = await fetch(`${baseUrl}/api/sessions/${sessionId}/updates/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewId: updatePreview.previewId, acknowledgedBuild: false })
  });
  assert.equal(blockedBuild.status, 400);
  assert.deepEqual(buildCalls, []);

  const builtResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/updates/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewId: updatePreview.previewId, acknowledgedBuild: true })
  });
  assert.equal(builtResponse.status, 200);
  const built = await builtResponse.json();
  assert.equal(built.status, 'passed');
  assert.deepEqual(buildCalls, ['install', 'build']);
  const downloaded = await fetch(`${baseUrl}/api/sessions/${sessionId}/download`);
  const zip = Buffer.from(await downloaded.arrayBuffer());
  assert.match(readZipEntry(zip, 'TECH-DEBT-REPORT.md'), /sample-lib: 1.0.0 -> 1.2.0/);
});
