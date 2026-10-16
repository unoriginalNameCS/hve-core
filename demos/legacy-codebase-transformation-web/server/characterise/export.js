'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { serialise } = require('./serialise');

function exportKey(unit) {
  return `__characterise_${createHash('sha256').update(unit.id).digest('hex').slice(0, 12)}`;
}

function renderTestFile({ unit, rootName, baseline }) {
  const targetPath = path.posix.relative(`${rootName}/__characterisation__`, unit.path);
  const property = exportKey(unit);
  const isExported = unit.exportNames?.includes(unit.name);
  const cases = JSON.stringify(baseline.cases.map(({ description, args, expected }) => ({ description, args, expected })), null, 2);
  const serialiserSource = serialise.toString();
  const loader = isExported ?
    `return require(targetFile)[${JSON.stringify(unit.name)}];` :
    [
      `const source = fs.readFileSync(targetFile, 'utf8') + ${JSON.stringify(`\nmodule.exports[${JSON.stringify(property)}] = ${unit.name};\n`) };`,
      'const loaded = new Module(targetFile, module);',
      'loaded.filename = targetFile;',
      'loaded.paths = Module._nodeModulePaths(path.dirname(targetFile));',
      'loaded._compile(source, targetFile);',
      `return loaded.exports[${JSON.stringify(property)}];`
    ].join('\n  ');
  return `'use strict';\n\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst Module = require('node:module');\nconst path = require('node:path');\nconst { test } = require('node:test');\nconst serialise = ${serialiserSource};\nconst targetFile = path.resolve(__dirname, ${JSON.stringify(targetPath)});\nconst cases = ${cases};\n\nfunction loadTarget() {\n  ${loader}\n}\n\nasync function capture(fn, args) {\n  const output = [];\n  const methods = ['log', 'info', 'warn', 'error', 'debug'];\n  const originals = new Map(methods.map((method) => [method, console[method]]));\n  for (const method of methods) console[method] = (...values) => output.push({ method, args: serialise(values) });\n  let value;\n  let error = null;\n  try { value = await fn(...args); } catch (caught) { error = { name: caught?.name ?? 'Error', message: String(caught?.message ?? caught) }; }\n  finally { for (const [method, original] of originals) console[method] = original; }\n  return { value: serialise(value), error, argsAfter: serialise(args), console: output };\n}\n\nfor (const item of cases) {\n  test(item.description, async () => {\n    const args = structuredClone(item.args);\n    assert.deepStrictEqual(await capture(loadTarget(), args), item.expected);\n  });\n}\n`;
}

module.exports = { renderTestFile };
