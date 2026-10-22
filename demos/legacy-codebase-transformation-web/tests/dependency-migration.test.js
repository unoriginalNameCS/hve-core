'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createApiApp } = require('../server/api');
const { findMigrationFiles, migrationGuides, proposeMigration, validateMigration } = require('../server/dependency-migration');
const { getSession, removeSession } = require('../server/workflow');

const env = {
  FOUNDRY_API_KEY: 'test-key',
  FOUNDRY_ENDPOINT: 'https://sample.services.ai.azure.com',
  FOUNDRY_MODEL: 'gpt-4.1-mini'
};
const legacySource = "'use strict';\n\nconst { addDays, format } = require('date-fns');\n\nfunction formatDueDate(issuedOn, termsDays) {\n  return format(addDays(issuedOn, termsDays), 'YYYY-MM-DD');\n}\n\nmodule.exports = { formatDueDate };\n";
const migratedSource = legacySource
  .replace('{ addDays, format }', '{ addDays, format, parseISO }')
  .replace('addDays(issuedOn, termsDays)', 'addDays(parseISO(issuedOn), termsDays)')
  .replace("'YYYY-MM-DD'", "'yyyy-MM-dd'");
const testSource = "const { formatDueDate } = require('../src/due-date');\nrequire('date-fns');\n";

function projectFiles() {
  const manifest = {
    name: 'sample', version: '1.0.0', private: true,
    scripts: { build: 'node scripts/build.js', test: 'node --test test/due-date.test.js' },
    dependencies: { 'date-fns': '1.28.4' }
  };
  const lock = {
    name: 'sample', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'sample', version: '1.0.0', dependencies: manifest.dependencies },
      'node_modules/date-fns': {
        version: '1.28.4', resolved: 'https://registry.npmjs.org/date-fns/-/date-fns-1.28.4.tgz', integrity: 'sha512-old'
      }
    }
  };
  return new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest, null, 2))],
    ['package-lock.json', Buffer.from(JSON.stringify(lock, null, 2))],
    ['src/due-date.js', Buffer.from(legacySource)],
    ['test/due-date.test.js', Buffer.from(testSource)],
    ['scripts/build.js', Buffer.from('process.exitCode = 0;\n')]
  ]);
}

test('only curated breaking upgrades receive migration guides', () => {
  assert.equal(migrationGuides([{ name: 'date-fns', fromVersion: '1.28.4', version: '4.4.0' }]).length, 1);
  assert.equal(migrationGuides([{ name: 'date-fns', fromVersion: '1.28.4', version: '1.28.5' }]).length, 0);
  assert.equal(migrationGuides([{ name: 'lodash', fromVersion: '4.17.20', version: '5.0.0' }]).length, 0);
});

test('migration candidates are non-test source files that import the upgraded package', () => {
  const files = new Map([...projectFiles()].map(([relativePath, bytes]) => [`sample/${relativePath}`, bytes]));
  files.set('sample/src/other.js', Buffer.from("module.exports = require('lodash');\n"));
  files.set('sample/src/esm.mjs', Buffer.from("import { format } from 'date-fns/format';\nexport const f = format;\n"));
  assert.deepEqual(findMigrationFiles(files, 'sample', ['date-fns']).map((file) => file.path), ['sample/src/due-date.js', 'sample/src/esm.mjs']);
});

test('migration edits must target listed files, parse, and keep the module format', () => {
  const candidates = [{ path: 'sample/src/due-date.js', source: legacySource }];
  assert.equal(validateMigration({ edits: [{ path: 'sample/src/due-date.js', content: migratedSource, rationale: 'r' }] }, candidates)[0].after, migratedSource);
  assert.throws(() => validateMigration({ edits: [{ path: 'sample/test/due-date.test.js', content: 'x', rationale: 'r' }] }, candidates), /unlisted file/);
  assert.throws(() => validateMigration({ edits: [{ path: 'sample/src/due-date.js', content: 'function (', rationale: 'r' }] }, candidates), /does not parse/);
  assert.throws(() => validateMigration({ edits: [{ path: 'sample/src/due-date.js', content: 'export const x = 1;', rationale: 'r' }] }, candidates), /module format/);
});

test('a failed migration check is retried once with the failure as feedback', async () => {
  const files = new Map([...projectFiles()].map(([relativePath, bytes]) => [`sample/${relativePath}`, bytes]));
  const prompts = [];
  let checks = 0;
  const result = await proposeMigration({
    guides: migrationGuides([{ name: 'date-fns', fromVersion: '1.28.4', version: '4.4.0' }]),
    files, rootName: 'sample', failure: { stage: 'tests', output: 'RangeError: Use `yyyy` instead of `YYYY`' }
  }, {
    requestStructured: async (prompt) => {
      prompts.push(prompt);
      return { summary: 'Use parseISO and Unicode tokens.', edits: [{ path: 'sample/src/due-date.js', content: migratedSource, rationale: 'r' }] };
    },
    check: async () => (++checks === 1 ? { status: 'failed', stage: 'tests', output: 'still failing' } : { status: 'passed', stage: 'build', output: '' })
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.attempts.length, 2);
  assert.match(prompts[0], /parseISO/);
  assert.match(prompts[0], /RangeError/);
  assert.equal(prompts[0].includes(testSource), false);
  assert.match(prompts[1], /still failing/);
});

test('failed major upgrade offers an approved migration that rechecks and stages only after acceptance', async (context) => {
  const server = createApiApp({
    env,
    transformUnit: ({ unit }) => ({ unitId: unit.id, path: unit.path, name: unit.name, status: 'ready', originalText: unit.originalText,
      replacementText: unit.originalText, rationale: 'unchanged', gates: [], baseline: { status: 'not-checked' }, warningAcknowledgementRequired: false }),
    metadataFetchImpl: async (url) => {
      if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
      return new Response(JSON.stringify({ name: 'date-fns', 'dist-tags': { latest: '4.4.0' }, versions: Object.fromEntries(
        ['1.28.4', '1.28.5', '1.30.1', '4.4.0'].map((version) => [version, { name: 'date-fns', version }])) }), { status: 200 });
    },
    runDependencyCommand: async ({ cwd }) => {
      const lockPath = path.join(cwd, 'package-lock.json');
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      lock.packages[''].dependencies['date-fns'] = '4.4.0';
      lock.packages['node_modules/date-fns'] = { version: '4.4.0', resolved: 'https://registry.npmjs.org/date-fns/-/date-fns-4.4.0.tgz', integrity: 'sha512-new' };
      await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
      return { exitCode: 0, output: 'resolved' };
    },
    runBuildCommand: async ({ cwd, stage }) => {
      if (stage !== 'test') return { exitCode: 0, output: `${stage} passed` };
      const version = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')).dependencies['date-fns'];
      const source = await fs.readFile(path.join(cwd, 'src/due-date.js'), 'utf8');
      return version === '4.4.0' && source.includes('YYYY')
        ? { exitCode: 1, output: 'RangeError: Use `yyyy` instead of `YYYY`' }
        : { exitCode: 0, output: 'tests passed' };
    },
    requestStructured: async () => ({ summary: 'Use parseISO and Unicode tokens.',
      edits: [{ path: 'sample/src/due-date.js', content: migratedSource, rationale: 'date-fns 2+ rejects strings and YYYY.' }] })
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let sessionId;
  context.after(async () => {
    if (sessionId) removeSession(sessionId);
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  });
  const post = (route, body) => fetch(`${baseUrl}/api/sessions/${sessionId}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  const form = new FormData();
  const entries = [...projectFiles()];
  form.append('manifest', JSON.stringify(entries.map(([relativePath, bytes], index) => ({ id: `file-${index}`, path: `sample/${relativePath}`, size: bytes.length }))));
  entries.forEach(([, bytes], index) => form.append('files', new Blob([bytes]), `file-${index}`));
  const prepared = await (await fetch(`${baseUrl}/api/analyze/prepare`, { method: 'POST', body: form })).json();
  sessionId = prepared.sessionId;
  const unit = prepared.assessment.units.find((item) => item.name === 'formatDueDate');
  const transformed = await (await post('/transform', { unitIds: [unit.id], checkDependencies: true, approved: true })).json();
  const options = transformed.dependencyAssessment.registry[0].declarations[0].updateOptions.map(({ level, version }) => `${level}:${version}`);
  assert.deepEqual(options, ['patch:1.28.5', 'minor:1.30.1', 'major:4.4.0']);
  const guides = transformed.dependencyAssessment.registry[0].declarations[0].updateOptions.map((option) => option.migrationGuide);
  assert.deepEqual(guides, [null, null, 'date-fns 1.x to 2.0 or later']);

  const preview = await (await post('/updates/prepare', { approvedProposalIds: [], acknowledgedWarnings: [], selectedUpdates: [{ name: 'date-fns', level: 'major' }] })).json();
  assert.equal(preview.packageDiff[0].level, 'major');
  assert.equal(preview.migrationGuides[0].name, 'date-fns');

  const build = await (await post('/updates/build', { previewId: preview.previewId, acknowledgedBuild: true })).json();
  assert.equal(build.status, 'failed');
  assert.equal(build.stage, 'tests');
  assert.equal(build.tests.baseline.status, 'passed');
  assert.equal(build.migrationAvailable, true);

  assert.equal((await post('/updates/migrate', { migrationId: build.migrationId })).status, 400);
  const migration = await (await post('/updates/migrate', { migrationId: build.migrationId, approved: true })).json();
  assert.equal(migration.status, 'ready');
  assert.deepEqual(migration.sentFiles, ['sample/src/due-date.js']);
  assert.equal(migration.checks.tests.status, 'passed');
  assert.equal(getSession(sessionId).applied, false);
  assert.equal((await post('/updates/migrate', { migrationId: build.migrationId, approved: true })).status, 400);

  const accepted = await (await post('/updates/migrate/accept', { migrationId: build.migrationId })).json();
  assert.equal(accepted.status, 'passed');
  assert.equal(accepted.summary.migratedFiles, 1);
  const session = getSession(sessionId);
  assert.equal(session.files.get('sample/src/due-date.js').toString(), migratedSource);
  assert.equal(JSON.parse(session.files.get('sample/package.json').toString()).dependencies['date-fns'], '4.4.0');
  assert.equal(session.files.get('sample/test/due-date.test.js').toString(), testSource);
  assert.equal(session.changeReport.migration.edits.length, 1);
  assert.equal(session.changeReport.packageChanges[0].level, 'major');
});
