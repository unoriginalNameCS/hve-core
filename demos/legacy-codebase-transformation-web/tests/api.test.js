'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { createApiApp } = require('../server/api');
const { getSession, removeSession } = require('../server/workflow');

const source = [
  'function isReady(value) {',
  '  if (value) {',
  '    return true;',
  '  } else {',
  '    return false;',
  '  }',
  '}',
  ''
].join('\n');
const candidate = {
  category: 'redundant-control-flow', rationale: 'The branch returns booleans directly.', confidence: 'high',
  symbol: 'isReady', functionStartLine: 1, functionEndLine: 7, startLine: 2, startCharacter: 2,
  endLine: 6, endCharacter: 3,
  originalText: 'if (value) {\n    return true;\n  } else {\n    return false;\n  }',
  replacementText: 'return Boolean(value);'
};

test('folder upload requires approval before returning an applied ZIP', async (context) => {
  const app = createApiApp({
    env: {
      FOUNDRY_API_KEY: 'test-key',
      FOUNDRY_ENDPOINT: 'https://sample.services.ai.azure.com',
      FOUNDRY_MODEL: 'gpt-4.1-mini'
    },
    requestFindings: async () => ({ findings: [candidate] })
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const status = await fetch(`${baseUrl}/api/status`).then((response) => response.json());
  assert.deepEqual(status, { configured: true, model: 'gpt-4.1-mini' });

  const bytes = Buffer.from(source);
  const form = new FormData();
  form.append('manifest', JSON.stringify([
    { id: 'file-0', path: 'sample/src/readiness.js', size: bytes.length }
  ]));
  form.append('files', new Blob([bytes]), 'file-0');
  const prepareResponse = await fetch(`${baseUrl}/api/analyze/prepare`, { method: 'POST', body: form });
  assert.equal(prepareResponse.status, 201);
  const preview = await prepareResponse.json();
  const reviewResponse = await fetch(`${baseUrl}/api/sessions/${preview.sessionId}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceApproved: true, dependencyApproved: false })
  });
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json();
  assert.equal(review.complete, true);

  const blockedDownload = await fetch(`${baseUrl}/api/sessions/${review.sessionId}/download`);
  assert.equal(blockedDownload.status, 409);

  const applyResponse = await fetch(`${baseUrl}/api/sessions/${review.sessionId}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedFindingIds: [review.findings[0].id] })
  });
  assert.equal(applyResponse.status, 200);

  const downloadResponse = await fetch(`${baseUrl}/api/sessions/${review.sessionId}/download`);
  const zip = Buffer.from(await downloadResponse.arrayBuffer());
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get('content-type'), 'application/zip');
  assert.equal(zip.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(zip.includes(Buffer.from('TRANSFORMATION-REPORT.md')));
  assert.equal(getSession(review.sessionId).changeReport.sourceChanges[0].before, candidate.originalText);
  removeSession(review.sessionId);
});

test('npm identifiers are disclosed locally and sent to fixed services only after explicit approval', async (context) => {
  const externalCalls = [];
  const app = createApiApp({
    metadataFetchImpl: async (url, options) => {
      externalCalls.push({ url, options });
      if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
      return new Response(JSON.stringify({
        name: 'sample-lib', 'dist-tags': { latest: '1.2.0' },
        versions: {
          '1.0.0': { name: 'sample-lib', version: '1.0.0', deprecated: 'Use the newer release.' },
          '1.2.0': { name: 'sample-lib', version: '1.2.0' }
        }
      }), { status: 200 });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const manifest = { name: 'sample', version: '1.0.0', dependencies: { 'sample-lib': '^1.0.0' } };
  const lock = {
    name: 'sample', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'sample', version: '1.0.0', dependencies: manifest.dependencies },
      'node_modules/sample-lib': {
        version: '1.0.0', resolved: 'https://registry.npmjs.org/sample-lib/-/sample-lib-1.0.0.tgz'
      }
    }
  };
  async function prepare() {
    const files = [JSON.stringify(manifest), JSON.stringify(lock)];
    const form = new FormData();
    form.append('manifest', JSON.stringify(files.map((content, index) => ({
      id: `file-${index}`, path: `sample/${index ? 'package-lock.json' : 'package.json'}`,
      size: Buffer.byteLength(content)
    }))));
    files.forEach((content, index) => form.append('files', new Blob([content]), `file-${index}`));
    const response = await fetch(`${baseUrl}/api/analyze/prepare`, { method: 'POST', body: form });
    assert.equal(response.status, 201);
    return response.json();
  }

  const declinedPreview = await prepare();
  assert.deepEqual(declinedPreview.dependencyPreview.registryNames, ['sample-lib']);
  assert.deepEqual(declinedPreview.dependencyPreview.advisoryTuples, [{ name: 'sample-lib', version: '1.0.0' }]);
  assert.equal(externalCalls.length, 0);
  const declinedResponse = await fetch(`${baseUrl}/api/sessions/${declinedPreview.sessionId}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceApproved: false, dependencyApproved: false })
  });
  const declined = await declinedResponse.json();
  assert.equal(declined.dependencyAssessment.status, 'not-approved');
  assert.equal(externalCalls.length, 0);
  removeSession(declinedPreview.sessionId);

  const approvedPreview = await prepare();
  const approvedResponse = await fetch(`${baseUrl}/api/sessions/${approvedPreview.sessionId}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceApproved: false, dependencyApproved: true })
  });
  const approved = await approvedResponse.json();
  assert.equal(approvedResponse.status, 200);
  assert.equal(approved.dependencyAssessment.status, 'completed');
  assert.equal(approved.dependencyAssessment.requests, 2);
  assert.ok(externalCalls.some((call) => call.url === 'https://registry.npmjs.org/sample-lib'));
  assert.ok(externalCalls.some((call) => call.url === 'https://api.osv.dev/v1/query'));
  assert.ok(externalCalls.every((call) => call.options.credentials === 'omit' && call.options.redirect === 'manual'));
  removeSession(approvedPreview.sessionId);
});

test('projects with source and npm dependencies require one combined approval and run both analyses', async (context) => {
  let modelCalls = 0;
  const metadataCalls = [];
  const app = createApiApp({
    env: {
      FOUNDRY_API_KEY: 'test-key',
      FOUNDRY_ENDPOINT: 'https://sample.services.ai.azure.com',
      FOUNDRY_MODEL: 'gpt-4.1-mini'
    },
    requestFindings: async () => { modelCalls += 1; return { findings: [] }; },
    metadataFetchImpl: async (url, options) => {
      metadataCalls.push({ url, options });
      if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
      return new Response(JSON.stringify({
        name: 'sample-lib', 'dist-tags': { latest: '1.2.0' },
        versions: { '1.0.0': { name: 'sample-lib', version: '1.0.0' }, '1.2.0': { name: 'sample-lib', version: '1.2.0' } }
      }), { status: 200 });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const source = 'function isReady(value) {\n  return value === true;\n}\n';
  const packageManifest = { name: 'sample', version: '1.0.0', dependencies: { 'sample-lib': '^1.0.0' } };
  const packageLock = {
    name: 'sample', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'sample', version: '1.0.0', dependencies: packageManifest.dependencies },
      'node_modules/sample-lib': { version: '1.0.0', resolved: 'https://registry.npmjs.org/sample-lib/-/sample-lib-1.0.0.tgz' }
    }
  };
  const fileContents = [source, JSON.stringify(packageManifest), JSON.stringify(packageLock)];
  const form = new FormData();
  form.append('manifest', JSON.stringify(fileContents.map((content, index) => ({
    id: `file-${index}`,
    path: ['sample/src/ready.js', 'sample/package.json', 'sample/package-lock.json'][index],
    size: Buffer.byteLength(content)
  }))));
  fileContents.forEach((content, index) => form.append('files', new Blob([content]), `file-${index}`));

  const prepareResponse = await fetch(`${baseUrl}/api/analyze/prepare`, { method: 'POST', body: form });
  const preview = await prepareResponse.json();
  assert.equal(prepareResponse.status, 201);
  assert.deepEqual(preview.sourceDisclosure.files, ['sample/src/ready.js']);
  assert.deepEqual(preview.dependencyPreview.registryNames, ['sample-lib']);
  assert.equal(modelCalls, 0);
  assert.equal(metadataCalls.length, 0);

  const partialApproval = await fetch(`${baseUrl}/api/sessions/${preview.sessionId}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceApproved: true, dependencyApproved: false })
  });
  assert.equal(partialApproval.status, 400);
  assert.equal(modelCalls, 0);
  assert.equal(metadataCalls.length, 0);

  const combinedResponse = await fetch(`${baseUrl}/api/sessions/${preview.sessionId}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceApproved: true, dependencyApproved: true })
  });
  const combined = await combinedResponse.json();
  assert.equal(combinedResponse.status, 200, JSON.stringify(combined));
  assert.equal(combined.sourceStatus, 'completed');
  assert.equal(combined.dependencyAssessment.status, 'completed');
  assert.equal(modelCalls, 1);
  assert.equal(metadataCalls.length, 2);
  removeSession(preview.sessionId);
});

test('selected dependency update shows lock diff and builds only after exact command approval', async (context) => {
  const dependencyCommands = [];
  const buildCommands = [];
  const app = createApiApp({
    env: {
      FOUNDRY_API_KEY: 'test-key',
      FOUNDRY_ENDPOINT: 'https://sample.services.ai.azure.com',
      FOUNDRY_MODEL: 'gpt-4.1-mini'
    },
    requestFindings: async () => ({ findings: [{ category: 'invalid-model-finding' }] }),
    metadataFetchImpl: async (url) => {
      if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      return new Response(JSON.stringify({
        name,
        'dist-tags': { latest: name === 'mkdirp' ? '3.0.1' : '4.18.1' },
        versions: name === 'mkdirp' ? {
          '0.5.1': { name, version: '0.5.1', deprecated: 'Legacy API.' },
          '3.0.1': { name, version: '3.0.1' }
        } : {
          '4.17.20': { name, version: '4.17.20' },
          '4.18.1': { name, version: '4.18.1' }
        }
      }), { status: 200 });
    },
    runDependencyCommand: async ({ args, cwd, stage }) => {
      dependencyCommands.push({ args, stage });
      const lockPath = require('node:path').join(cwd, 'package-lock.json');
      const lock = JSON.parse(await require('node:fs/promises').readFile(lockPath, 'utf8'));
      lock.packages[''].dependencies.mkdirp = '3.0.1';
      lock.packages['node_modules/mkdirp'] = {
        version: '3.0.1', resolved: 'https://registry.npmjs.org/mkdirp/-/mkdirp-3.0.1.tgz', integrity: 'sha512-mkdirp3'
      };
      await require('node:fs/promises').writeFile(lockPath, JSON.stringify(lock, null, 2));
      return { exitCode: 0, output: 'lock resolved' };
    },
    runBuildCommand: async ({ args, stage }) => {
      buildCommands.push({ args, stage });
      return { exitCode: 0, output: `${stage} passed` };
    }
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
  });
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sourceText = "'use strict';\nconst _ = require('lodash');\nmodule.exports = _.sum([1, 2]);\n";
  const packageManifest = {
    name: 'sample', version: '1.0.0', private: true, scripts: { build: 'node scripts/build.js' },
    dependencies: { lodash: '4.17.20', mkdirp: '0.5.1' }
  };
  const packageLock = {
    name: 'sample', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'sample', version: '1.0.0', dependencies: packageManifest.dependencies },
      'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: 'sha512-lodash' },
      'node_modules/mkdirp': { version: '0.5.1', resolved: 'https://registry.npmjs.org/mkdirp/-/mkdirp-0.5.1.tgz', integrity: 'sha512-mkdirp' },
      'node_modules/minimist': { version: '0.0.8', resolved: 'https://registry.npmjs.org/minimist/-/minimist-0.0.8.tgz', integrity: 'sha512-minimist' }
    }
  };
  const contents = [sourceText, JSON.stringify(packageManifest), JSON.stringify(packageLock), "require('lodash');\n"];
  const names = ['src/main.js', 'package.json', 'package-lock.json', 'scripts/build.js'];
  const originals = contents.map((value) => Buffer.from(value));
  const form = new FormData();
  form.append('manifest', JSON.stringify(contents.map((value, index) => ({
    id: `file-${index}`, path: `sample/${names[index]}`, size: Buffer.byteLength(value)
  }))));
  originals.forEach((value, index) => form.append('files', new Blob([value]), `file-${index}`));
  const preparedResponse = await fetch(`${baseUrl}/api/analyze/prepare`, { method: 'POST', body: form });
  const prepared = await preparedResponse.json();
  assert.equal(preparedResponse.status, 201);

  const analysisResponse = await fetch(`${baseUrl}/api/sessions/${prepared.sessionId}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceApproved: true, dependencyApproved: true })
  });
  const analysis = await analysisResponse.json();
  assert.equal(analysisResponse.status, 200);
  assert.equal(analysis.complete, false);
  assert.equal(analysis.sourceStatus, 'incomplete');
  assert.equal(analysis.dependencyAssessment.inventory.buildAvailable, true);
  assert.equal(analysis.dependencyAssessment.inventory.buildScript, 'node scripts/build.js');
  const updateResponse = await fetch(`${baseUrl}/api/sessions/${prepared.sessionId}/updates/prepare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedFindingIds: [], selectedUpdateNames: ['mkdirp'] })
  });
  const update = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(update.packageDiff, [{ name: 'mkdirp', fromVersion: '0.5.1', fromSpec: '0.5.1', version: '3.0.1' }]);
  assert.ok(update.lockChanges.some((entry) => entry.name === 'mkdirp' && entry.to === '3.0.1'));
  assert.match(update.build.warning, /not an OS sandbox/);

  const deniedBuild = await fetch(`${baseUrl}/api/sessions/${prepared.sessionId}/updates/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewId: update.previewId, acknowledgedBuild: false })
  });
  assert.equal(deniedBuild.status, 400);
  assert.equal(buildCommands.length, 0);

  const buildResponse = await fetch(`${baseUrl}/api/sessions/${prepared.sessionId}/updates/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewId: update.previewId, acknowledgedBuild: true })
  });
  const build = await buildResponse.json();
  assert.equal(buildResponse.status, 200);
  assert.equal(build.status, 'passed');
  assert.equal(build.tests, 'not run');
  assert.deepEqual(buildCommands.map((call) => call.stage), ['install', 'build']);
  assert.ok(buildCommands[0].args.includes('--ignore-scripts'));
  assert.deepEqual(buildCommands[1].args.slice(0, 4), ['npm', '--ignore-scripts', 'run', 'build']);
  const session = getSession(prepared.sessionId);
  assert.equal(JSON.parse(session.files.get('sample/package.json').toString()).dependencies.mkdirp, '3.0.1');
  for (const [index, fileName] of names.entries()) assert.deepEqual(originals[index], Buffer.from(contents[index]));
  removeSession(prepared.sessionId);
});
