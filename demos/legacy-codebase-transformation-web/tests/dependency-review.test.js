'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assessNpmDependencies, inventoryNpmFiles, updateLevel } = require('../server/dependency-review');

function sampleFiles() {
  const manifest = {
    name: 'sample-app', version: '1.0.0',
    scripts: { build: 'node scripts/build.js' },
    dependencies: { lodash: '^4.17.0', mkdirp: '^0.5.0' }
  };
  const lock = {
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
      'node_modules/lodash': {
        version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz'
      },
      'node_modules/mkdirp': {
        version: '0.5.1', resolved: 'https://registry.npmjs.org/mkdirp/-/mkdirp-0.5.1.tgz'
      },
      'node_modules/minimist': {
        version: '0.0.8', resolved: 'https://registry.npmjs.org/minimist/-/minimist-0.0.8.tgz'
      }
    }
  };
  return new Map([
    ['sample/package.json', Buffer.from(JSON.stringify(manifest))],
    ['sample/package-lock.json', Buffer.from(JSON.stringify(lock))],
    ['sample/node_modules/ignored/package.json', Buffer.from('{}')]
  ]);
}

test('npm inventory extracts direct declarations and exact v3 lock occurrences but skips installed modules', () => {
  const inventory = inventoryNpmFiles(sampleFiles(), 'sample');

  assert.deepEqual(inventory.lookup.registryNames, ['lodash', 'mkdirp']);
  assert.deepEqual(inventory.lookup.advisoryTuples, [
    { name: 'lodash', version: '4.17.20' },
    { name: 'minimist', version: '0.0.8' },
    { name: 'mkdirp', version: '0.5.1' }
  ]);
  assert.equal(inventory.declarations.length, 2);
  assert.equal(inventory.occurrences.length, 3);
  assert.equal(inventory.documents.some((entry) => entry.path.includes('node_modules')), false);
  assert.equal(inventory.gaps.length, 0);
  assert.equal(inventory.buildScript, 'node scripts/build.js');
});

test('npm assessment calls only fixed public endpoints and reports deprecation and OSV matches', async () => {
  const inventory = inventoryNpmFiles(sampleFiles(), 'sample');
  const calls = [];
  const result = await assessNpmDependencies(inventory, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://api.osv.dev/v1/query') {
        return new Response(JSON.stringify({ vulns: [{
          id: 'GHSA-test-1234', aliases: ['CVE-2026-12345'], modified: '2026-10-14T00:00:00Z',
          summary: 'A test advisory.',
          affected: [{ package: { ecosystem: 'npm', name: 'mkdirp' }, ranges: [{ events: [{ fixed: '1.0.0' }] }] }]
        }] }), { status: 200 });
      }
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      return new Response(JSON.stringify({
        name,
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '0.5.1': { name, version: '0.5.1', deprecated: name === 'mkdirp' ? 'Use the maintained 1.x API.' : undefined },
          '1.2.0': { name, version: '1.2.0' },
          '2.0.0': { name, version: '2.0.0' }
        }
      }), { status: 200 });
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.requests, 5);
  assert.ok(result.registry.find((entry) => entry.name === 'mkdirp').lockedVersions.some((entry) => entry.deprecated));
  assert.equal(result.advisories.find((entry) => entry.name === 'mkdirp').matches[0].id, 'GHSA-test-1234');
  assert.ok(calls.every(({ url, options }) => url.startsWith('https://registry.npmjs.org/') || url === 'https://api.osv.dev/v1/query'));
  assert.ok(calls.every(({ options }) => options.redirect === 'manual' && options.credentials === 'omit'));
});

test('update options label the highest patch, minor, and major candidates and skip deprecated releases', async () => {
  const inventory = inventoryNpmFiles(sampleFiles(), 'sample');
  const versions = {
    lodash: ['4.17.20', '4.17.21', '4.17.22-beta.1', '4.18.0', '4.19.0', '5.0.0', '5.1.0'],
    mkdirp: ['0.5.1', '0.5.6', '0.6.0', '1.0.4']
  };
  const result = await assessNpmDependencies(inventory, {
    fetchImpl: async (url) => {
      if (url === 'https://api.osv.dev/v1/query') return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      return new Response(JSON.stringify({
        name, 'dist-tags': { latest: versions[name].at(-1) },
        versions: Object.fromEntries(versions[name].map((version) => [version, {
          name, version, deprecated: version === '4.19.0' ? 'Broken release.' : undefined
        }]))
      }), { status: 200 });
    }
  });
  const options = (name) => result.registry.find((entry) => entry.name === name).declarations[0].updateOptions
    .map(({ level, version }) => ({ level, version }));

  assert.deepEqual(options('lodash'), [
    { level: 'patch', version: '4.17.21' },
    { level: 'minor', version: '4.18.0' },
    { level: 'major', version: '5.1.0' }
  ]);
  assert.deepEqual(options('mkdirp'), [
    { level: 'patch', version: '0.5.6' },
    { level: 'major', version: '1.0.4' }
  ]);
  assert.equal(updateLevel('0.5.1', '0.6.0'), 'major');
  assert.equal(updateLevel('1.28.4', '1.30.1'), 'minor');
});

test('invalid or unsupported npm declarations produce gaps and no Registry identifier', () => {
  const files = new Map([
    ['sample/package.json', Buffer.from(JSON.stringify({ name: 'sample', dependencies: { lodash: 'git+https://example.test/repo' } }))],
    ['sample/package-lock.json', Buffer.from(JSON.stringify({
      lockfileVersion: 3, packages: { '': { name: 'sample', dependencies: { lodash: 'git+https://example.test/repo' } } }
    }))]
  ]);
  const inventory = inventoryNpmFiles(files, 'sample');

  assert.deepEqual(inventory.lookup.registryNames, []);
  assert.ok(inventory.gaps.length > 0);
});

test('bundled npm review sample has a compact, analyzable v3 manifest and lock', () => {
  const root = path.resolve(__dirname, '../samples/npm-review');
  const files = new Map(['package.json', 'package-lock.json', 'src/transfer.js'].map((relativePath) =>
    [`npm-review/${relativePath}`, fs.readFileSync(path.join(root, relativePath))]));
  const inventory = inventoryNpmFiles(files, 'npm-review');

  assert.deepEqual(inventory.lookup.registryNames, ['lodash', 'mkdirp']);
  assert.deepEqual(inventory.lookup.advisoryTuples, [
    { name: 'lodash', version: '4.17.20' },
    { name: 'minimist', version: '0.0.8' },
    { name: 'mkdirp', version: '0.5.1' }
  ]);
  assert.equal(inventory.gaps.length, 0);
  assert.equal(files.size, 3);
  assert.equal(inventory.buildAvailable, true);
  assert.match(inventory.buildScript, /node -e/);
  assert.match(inventory.buildScript, /require\('mkdirp'\)/);
});

test('invoice-desk exposes the headline npm dependencies with a public v3 lock', () => {
  const root = path.resolve(__dirname, '../samples/invoice-desk');
  const files = new Map(['package.json', 'package-lock.json', 'src/index.js', 'src/invoice-lines.js'].map((relativePath) =>
    [`invoice-desk/${relativePath}`, fs.readFileSync(path.join(root, relativePath))]));
  const inventory = inventoryNpmFiles(files, 'invoice-desk');
  const lock = JSON.parse(files.get('invoice-desk/package-lock.json').toString('utf8'));
  assert.deepEqual(inventory.lookup.registryNames, ['date-fns', 'lodash']);
  assert.deepEqual(inventory.lookup.advisoryTuples.filter((item) => ['date-fns', 'lodash'].includes(item.name)), [
    { name: 'date-fns', version: '1.28.4' },
    { name: 'lodash', version: '4.17.20' }
  ]);
  assert.equal(inventory.buildAvailable, true);
  assert.match(inventory.buildScript, /scripts\/build\.js/);
  assert.equal(inventory.gaps.length, 0);
  assert.equal(lock.lockfileVersion, 3);
  for (const name of ['date-fns', 'lodash']) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry.resolved.startsWith(`https://registry.npmjs.org/${name}/`));
    assert.match(entry.integrity, /^sha512-/);
  }
});
