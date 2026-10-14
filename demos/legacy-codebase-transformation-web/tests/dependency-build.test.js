'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { inventoryNpmFiles } = require('../server/dependency-review');
const { prepareDependencyBuild, runApprovedBuild } = require('../server/dependency-build');

function updateFixture() {
  const manifest = {
    name: 'sample', version: '1.0.0', private: true,
    scripts: { build: 'node scripts/build.js' },
    dependencies: { lodash: '4.17.20', mkdirp: '0.5.1' }
  };
  const lock = {
    name: 'sample', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
      'node_modules/lodash': {
        version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: 'sha512-lodash'
      },
      'node_modules/mkdirp': {
        version: '0.5.1', resolved: 'https://registry.npmjs.org/mkdirp/-/mkdirp-0.5.1.tgz', integrity: 'sha512-mkdirp'
      },
      'node_modules/minimist': {
        version: '0.0.8', resolved: 'https://registry.npmjs.org/minimist/-/minimist-0.0.8.tgz', integrity: 'sha512-minimist'
      }
    }
  };
  const files = new Map([
    ['sample/package.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['sample/package-lock.json', Buffer.from(`${JSON.stringify(lock, null, 2)}\n`)],
    ['sample/src/transfer.js', Buffer.from('module.exports = true;\n')],
    ['sample/scripts/build.js', Buffer.from('process.exitCode = 0;\n')]
  ]);
  const inventory = inventoryNpmFiles(files, 'sample');
  const assessment = {
    registry: [{
      name: 'mkdirp', status: 'completed', declarations: [{
        manifest: 'sample/package.json', spec: '0.5.1', groups: ['dependencies'], lockedVersions: ['0.5.1'],
        updateCandidate: { version: '3.0.1', status: 'completed', deprecated: null }
      }]
    }]
  };
  return { files, dependencyInventory: inventory, dependencyAssessment: assessment, rootName: 'sample' };
}

function resolvingRunner(calls) {
  return async ({ args, cwd, stage }) => {
    calls.push({ args, cwd, stage });
    if (stage === 'resolve') {
      assert.ok(args.includes('--package-lock-only'));
      assert.ok(args.includes('--ignore-scripts'));
      const lockPath = path.join(cwd, 'package-lock.json');
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      lock.packages[''].dependencies.mkdirp = '3.0.1';
      lock.packages['node_modules/mkdirp'] = {
        version: '3.0.1', resolved: 'https://registry.npmjs.org/mkdirp/-/mkdirp-3.0.1.tgz', integrity: 'sha512-mkdirp3'
      };
      await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }
    return { exitCode: 0, output: `${stage} completed` };
  };
}

test('update preview resolves only selected direct candidates and shows lock changes before build', async () => {
  const sample = updateFixture();
  const calls = [];
  const preview = await prepareDependencyBuild(sample, ['mkdirp'], {
    runCommand: resolvingRunner(calls)
  });

  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.packageDiff, [{ name: 'mkdirp', fromVersion: '0.5.1', fromSpec: '0.5.1', version: '3.0.1' }]);
  assert.ok(preview.lockChanges.some((entry) => entry.name === 'mkdirp' && entry.from === '0.5.1' && entry.to === '3.0.1'));
  assert.equal(preview.build.command, 'npm --ignore-scripts run build');
  assert.match(preview.build.warning, /not an OS sandbox/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stage, 'resolve');
  assert.equal(JSON.parse(sample.files.get('sample/package.json').toString()).dependencies.mkdirp, '0.5.1');
});

test('approved build installs without lifecycle scripts and returns staged files only on success', async () => {
  const sample = updateFixture();
  for (const config of ['.npmrc', 'user.npmrc', 'global.npmrc']) {
    sample.files.set(`sample/${config}`, Buffer.from('ignore-scripts=false\n'));
  }
  const calls = [];
  const preview = await prepareDependencyBuild(sample, ['mkdirp'], { runCommand: resolvingRunner(calls) });
  const build = await runApprovedBuild(preview, { runCommand: async (command) => {
    for (const config of ['.npmrc', 'user.npmrc', 'global.npmrc']) {
      assert.equal(await fs.readFile(path.join(command.cwd, config), 'utf8'), '');
    }
    return resolvingRunner(calls)(command);
  } });

  assert.equal(build.status, 'passed');
  assert.deepEqual(build.tests, 'not run');
  assert.equal(build.files.size, sample.files.size);
  assert.equal(JSON.parse(build.files.get('sample/package.json').toString()).dependencies.mkdirp, '3.0.1');
  assert.deepEqual(calls.map((call) => call.stage), ['resolve', 'install', 'build']);
  assert.ok(calls[1].args.includes('--ignore-scripts'));
  assert.deepEqual(calls[2].args.slice(0, 4), ['npm', '--ignore-scripts', 'run', 'build']);
  assert.equal(JSON.parse(sample.files.get('sample/package.json').toString()).dependencies.mkdirp, '0.5.1');
  assert.equal(build.files.get('sample/.npmrc').toString(), 'ignore-scripts=false\n');
});

test('failed build returns bounded failure without staged output or original changes', async () => {
  const sample = updateFixture();
  const preview = await prepareDependencyBuild(sample, ['mkdirp'], { runCommand: resolvingRunner([]) });
  const result = await runApprovedBuild(preview, {
    runCommand: async ({ stage }) => stage === 'build' ? { exitCode: 1, output: 'build failed' } : { exitCode: 0, output: '' }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'build');
  assert.match(result.output, /build failed/);
  assert.equal(Object.hasOwn(result, 'files'), false);
  assert.equal(JSON.parse(sample.files.get('sample/package.json').toString()).dependencies.mkdirp, '0.5.1');
});

test('missing build script and unknown update candidates are rejected before resolution', async () => {
  const sample = updateFixture();
  sample.files.set('sample/package.json', Buffer.from(JSON.stringify({ name: 'sample', dependencies: { mkdirp: '0.5.1' } })));
  const calls = [];
  await assert.rejects(() => prepareDependencyBuild(sample, ['mkdirp'], { runCommand: resolvingRunner(calls) }), /build-unavailable/);
  assert.equal(calls.length, 0);

  const withBuild = updateFixture();
  await assert.rejects(() => prepareDependencyBuild(withBuild, ['lodash'], { runCommand: resolvingRunner(calls) }), /candidate-unavailable/);
  assert.equal(calls.length, 0);
});
