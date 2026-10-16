'use strict';

const { serialise } = require('./serialise.cjs');

function readRequest() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.once('end', () => {
      try { resolve(JSON.parse(input)); } catch (error) { reject(error); }
    });
    process.stdin.once('error', reject);
  });
}

async function runCase(request) {
  const logs = [];
  const originals = new Map();
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals.set(method, console[method]);
    console[method] = (...args) => logs.push({ method, args: serialise(args) });
  }

  let result;
  let thrown = null;
  try {
    const loaded = require(request.modulePath);
    const fn = request.exportName === 'default' && typeof loaded === 'function' ? loaded : loaded?.[request.exportName];
    if (typeof fn !== 'function') throw new TypeError(`Characterisation target ${request.exportName} is not callable.`);
    const args = request.args;
    try {
      result = await fn(...args);
    } catch (error) {
      thrown = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
    }
    return {
      value: serialise(result),
      error: thrown,
      argsAfter: serialise(args),
      console: logs
    };
  } catch (error) {
    return { moduleError: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } };
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
}

async function main() {
  try {
    const request = await readRequest();
    const outcome = await runCase(request);
    process.stdout.write(JSON.stringify(outcome));
  } catch (error) {
    process.stderr.write(String(error?.message ?? error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { runCase };
