'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assessProject } = require('../server/assess');
const { ratingFor } = require('../server/assess/score');

function assess(content, config = {}) {
  return assessProject([{ path: 'src/sample.js', content }], config);
}

test('reports nested control flow, complexity, parameters, and long functions', () => {
  const content = [
    'function inspect(a, b, c, d, e, f, g) {',
    '  if (a && b || c && d || e && f) { if (b) { if (c) { if (d) { if (e) return 1; } } } }',
    ...Array.from({ length: 42 }, (_, index) => `  const value${index} = a + ${index + 3};`),
    '}'
  ].join('\n');
  const result = assess(content);
  const ids = result.findings.map((item) => item.ruleId);
  assert.ok(ids.includes('deep-nesting'));
  assert.ok(ids.includes('high-complexity'));
  assert.ok(ids.includes('too-many-params'));
  assert.ok(ids.includes('long-function'));
  assert.equal(result.units.find((unit) => unit.name === 'inspect').metrics.paramCount, 7);
});

test('reports branch chains, callback depth, and named arrow functions', () => {
  const result = assess([
    'const handle = (items) => items.map((item) => item.map((value) => value.map((entry) => entry ? 11 : 0)));',
    'function choose(value) { if (value === 1) return 1; else if (value === 2) return 2; else if (value === 3) return 3; else if (value === 4) return 4; else if (value === 5) return 5; else if (value === 6) return 6; else return 0; }'
  ].join('\n'));
  const handle = result.units.find((unit) => unit.name === 'handle');
  const choose = result.units.find((unit) => unit.name === 'choose');
  assert.equal(handle.metrics.callbackNesting, 3);
  assert.ok(handle.findings.some((item) => item.ruleId === 'callback-nesting'));
  assert.equal(choose.metrics.maxBranchChain, 6);
  assert.equal(choose.metrics.maxNesting, 1);
  assert.ok(result.findings.some((item) => item.ruleId === 'long-branch-chain'));
});

test('reports bad names, magic numbers, var, loose equality, empty catch, and markers', () => {
  const result = assess([
    'function calculate(data) {',
    '  var tmp = data.amount == 49;',
    '  try { return tmp ? data.amount * 0.17 : 0; } catch (err) {}',
    '  // TODO explain this later',
    '}'
  ].join('\n'));
  for (const ruleId of ['bad-variable-name', 'magic-number', 'var-declaration', 'loose-equality', 'empty-catch', 'debt-marker']) {
    assert.ok(result.findings.some((item) => item.ruleId === ruleId), `expected ${ruleId}`);
  }
});

test('finds callback nesting and branch chains without counting nested-body complexity', () => {
  const result = assess('function process(items) { return items.map((item) => item.map((value) => value ? 10 : 0)); }');
  const unit = result.units.find((item) => item.name === 'process');
  assert.equal(unit.metrics.callbackNesting, 2);
  assert.equal(unit.metrics.cyclomaticComplexity, 1);
  assert.equal(unit.findings.some((item) => item.ruleId === 'magic-number'), false);
});

test('isolates function metrics and reports source paths for top-level statements', () => {
  const result = assess('if (ready) { if (again) run(); }\nfunction simple() { return true; }\nvar x = 3;');
  const simple = result.units.find((unit) => unit.name === 'simple');
  assert.equal(simple.metrics.cyclomaticComplexity, 1);
  assert.equal(simple.metrics.maxNesting, 0);
  assert.ok(result.findings.every((item) => item.path === 'src/sample.js'));
});

test('reports top-level statement and file units', () => {
  const content = [
    'var x = 4;',
    'if (x == 5) console.log(x);',
    ...Array.from({ length: 301 }, () => '// file line')
  ].join('\n');
  const result = assess(content);
  assert.ok(result.units.some((unit) => unit.kind === 'statement' && unit.findings.some((item) => item.ruleId === 'var-declaration')));
  assert.ok(result.units.some((unit) => unit.kind === 'file' && unit.findings.some((item) => item.ruleId === 'long-file')));
});

test('applies local config overrides to thresholds and allowlists', () => {
  const result = assess('function x(d) { return d.amount * 99; }', {
    rules: { 'long-function': { warn: 100 } }, nameAllowlist: ['d'], magicAllowlist: [99]
  });
  assert.equal(result.findings.some((item) => item.ruleId === 'long-function'), false);
  assert.equal(result.findings.some((item) => item.ruleId === 'bad-variable-name'), false);
  assert.equal(result.findings.some((item) => item.ruleId === 'magic-number'), false);
});

test('records parse failures as coverage gaps and assessment makes no network or child-process calls', () => {
  const originalFetch = globalThis.fetch;
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  globalThis.fetch = () => { throw new Error('assessment attempted network access'); };
  childProcess.spawn = () => { throw new Error('assessment attempted project execution'); };
  try {
    const result = assessProject([{ path: 'broken.js', content: 'function {' }, { path: 'ok.js', content: 'const answer = 42;' }]);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.files.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
  }
});

test('maps debt ratios to the documented A-E ratings', () => {
  assert.deepEqual([0.05, 0.1, 0.2, 0.5, 0.51].map((ratio) => ratingFor(ratio * 100, 200)), ['A', 'B', 'C', 'D', 'E']);
});

test('returns file-level debt ratings alongside detailed source records', () => {
  const result = assess('function inspect(temp) { return temp; }');
  assert.equal(result.fileScores[0].path, 'src/sample.js');
  assert.equal(result.fileScores[0].findingCount, result.files[0].findings.length);
  assert.ok(result.files[0].units.length > 0);
});

test('named-constant declarations do not count toward function length', () => {
  const constants = Array.from({ length: 10 }, (_, index) => `  const RATE_${index} = ${index + 3};`);
  const body = Array.from({ length: 35 }, (_, index) => `  total += ${index % 2 === 0 ? 'RATE_0' : 'RATE_1'};`);
  const result = assess(['function compute(total) {', ...constants, ...body, '  return total;', '}'].join('\n'));
  const unit = result.units.find((item) => item.name === 'compute');
  assert.equal(unit.metrics.loc, 38);
  assert.equal(unit.findings.some((item) => item.ruleId === 'long-function'), false);
});

test('node-located findings report line and column', () => {
  const result = assess('function compute(total) {\n  const d = total;\n  return d * 7;\n}');
  const badName = result.findings.find((item) => item.ruleId === 'bad-variable-name');
  const magic = result.findings.find((item) => item.ruleId === 'magic-number');
  assert.deepEqual([badName.line, badName.column], [2, 9]);
  assert.deepEqual([magic.line, magic.column], [3, 14]);
});

test('does not attribute top-level literals to a function hotspot', () => {
  const result = assess('var taxRate = 47;\nfunction calculate(value) { return value + 1; }');
  const calculate = result.units.find((unit) => unit.name === 'calculate');
  assert.equal(calculate.findings.some((item) => item.ruleId === 'magic-number'), false);
  assert.ok(result.units.find((unit) => unit.kind === 'statement').findings.some((item) => item.ruleId === 'magic-number'));
});

test('invoice-desk starts at rating D with the planned transformation targets', () => {
  const root = path.resolve(__dirname, '../samples/invoice-desk');
  const sourceFiles = [];
  for (const file of fs.readdirSync(path.join(root, 'src'))) {
    if (file.endsWith('.js')) sourceFiles.push({ path: `invoice-desk/src/${file}`, content: fs.readFileSync(path.join(root, 'src', file), 'utf8') });
  }
  const result = assessProject(sourceFiles);
  assert.equal(new Set(result.findings.map((item) => item.id)).size, result.findings.length);
  assert.equal(result.units.filter((unit) => unit.findings.length > 0).length, 5);
  const calculateDiscount = result.units.find((unit) => unit.name === 'calculateDiscount');
  const buildInvoiceLines = result.units.find((unit) => unit.name === 'buildInvoiceLines');
  const formatLine = result.units.find((unit) => unit.name === 'formatLine');
  const formatInvoiceStatus = result.units.find((unit) => unit.name === 'formatInvoiceStatus');
  const debtByRule = Object.groupBy(result.findings, (item) => item.ruleId);
  const ruleSummary = Object.fromEntries(Object.entries(debtByRule).map(([ruleId, findings]) => [ruleId,
    { count: findings.length, minutes: findings.reduce((total, item) => total + item.remediationMinutes, 0) }]));
  assert.equal(result.rating, 'D', JSON.stringify({ rating: result.rating, debtMinutes: result.debtMinutes, loc: result.loc, ruleSummary }));
  assert.ok(calculateDiscount.findings.some((item) => item.ruleId === 'deep-nesting'));
  assert.ok(calculateDiscount.findings.some((item) => item.ruleId === 'high-complexity'));
  assert.ok(calculateDiscount.findings.some((item) => item.ruleId === 'debt-marker'));
  assert.ok(buildInvoiceLines.findings.some((item) => item.ruleId === 'long-function'));
  assert.ok(buildInvoiceLines.findings.some((item) => item.ruleId === 'bad-variable-name'));
  assert.ok(formatLine.findings.some((item) => item.ruleId === 'too-many-params'));
  assert.ok(formatInvoiceStatus.findings.some((item) => item.ruleId === 'long-branch-chain'));
  const statementFindings = result.units.filter((unit) => unit.kind === 'statement').flatMap((unit) => unit.findings);
  for (const ruleId of ['var-declaration', 'loose-equality', 'magic-number']) assert.ok(statementFindings.some((item) => item.ruleId === ruleId));
});

test('representative invoice refactors reduce the calibrated rating from D to B', () => {
  const root = path.resolve(__dirname, '../samples/invoice-desk');
  const sourceFiles = fs.readdirSync(path.join(root, 'src')).filter((file) => file.endsWith('.js')).map((file) => ({
    path: `invoice-desk/src/${file}`, content: fs.readFileSync(path.join(root, 'src', file), 'utf8')
  }));
  const initial = assessProject(sourceFiles);
  const replacements = new Map([
    ['calculateDiscount', `function calculateDiscount(invoice) {
  const GOLD_RATE = 0.15;
  const SILVER_RATE = 0.1;
  const REVIEW_RATE = 0.07;
  const VOLUME_LIMIT = 500;
  const VOLUME_RATE = 0.07;
  const CODE_RATE = 0.1;
  const US_RATE = 0.03;
  const PLATINUM_RATE = 0.2;
  const MAX_RATE = 0.25;
  if (!invoice) return 0;
  const customer = invoice.customer || {};
  const tierRate = { gold: GOLD_RATE, silver: SILVER_RATE, platinum: PLATINUM_RATE }[customer.tier] || 0;
  const volumeRate = Number(invoice.subtotal > VOLUME_LIMIT) * VOLUME_RATE;
  const codeRate = Number(invoice.discountCode === 'SAVE' && invoice.status !== 'void') * CODE_RATE;
  const reviewRate = Number(invoice.status === 'review' && customer.tier === 'gold') * REVIEW_RATE;
  const baseRate = tierRate + volumeRate + codeRate + reviewRate;
  const marketEligible = [invoice.country === 'US', invoice.subtotal > 0, baseRate > 0].every(Boolean);
  const marketRate = Number(marketEligible) * US_RATE;
  return Math.min(baseRate + marketRate, MAX_RATE);
}`],
    ['buildInvoiceLines', `function buildInvoiceLines(invoice) {
  const groupedItems = _.groupBy(invoice.items, (item) => item.category || 'other');
  return Object.entries(groupedItems).flatMap(([category, items]) =>
    items.map((item) => createInvoiceLine(item, category))
  );
}

function createInvoiceLine(item, category) {
  const TAX_RATE = 0.0825;
  const CENTS = 100;
  let subtotal = item.quantity * item.unitPrice;
  if (item.discount) subtotal -= item.discount;
  if (subtotal < 0) subtotal = 0;
  const line = {
    sku: item.sku,
    description: item.description || 'Service',
    category,
    quantity: item.quantity || 1,
    unitPrice: item.unitPrice,
    subtotal,
    taxable: item.taxable !== false
  };
  for (const key of ['discount', 'notes', 'shipping', 'metadata'].filter((name) => item[name])) line[key] = item[key];
  line.tax = line.taxable ? Math.round(subtotal * TAX_RATE * CENTS) / CENTS : 0;
  return line;
}`],
    ['formatLine', `function formatLine(description, sku, quantity, unitPrice, discount, tax, label) {
  const lineTotal = quantity * unitPrice - discount + tax;
  return \`${'${label || description}'} [${'${sku}'}] x${'${quantity}'}: $${'${lineTotal.toFixed(2)}'}\`;
}`],
    ['formatInvoiceStatus', `function formatInvoiceStatus(status) {
  const labels = new Map([
    ['draft', 'Pending'], ['approved', 'Ready'], ['review', 'Needs review'],
    ['rejected', 'Declined'], ['void', 'Cancelled'], ['expired', 'Expired']
  ]);
  return labels.get(status) ?? 'Unknown';
}`]
  ]);
  const updatedFiles = sourceFiles.map((sourceFile) => {
    let content = sourceFile.content;
    for (const [name, replacement] of replacements) {
      const unit = initial.units.find((item) => item.kind === 'function' && item.name === name && item.path === sourceFile.path);
      if (unit) content = content.replace(unit.originalText, replacement);
    }
    if (sourceFile.path.endsWith('/index.js')) {
      content = content.replace('var invoiceCount = invoices.length == 0 ? 99 : invoices.length;',
        'const NO_INVOICES = 99;\nconst invoiceCount = invoices.length === 0 ? NO_INVOICES : invoices.length;');
    }
    return { ...sourceFile, content };
  });
  const updated = assessProject(updatedFiles);
  assert.equal(initial.rating, 'D');
  assert.equal(updated.rating, 'B', JSON.stringify({ rating: updated.rating, debtMinutes: updated.debtMinutes, loc: updated.loc, findings: updated.findings }));
  assert.ok(updated.findings.some((item) => item.ruleId === 'too-many-params'));
});
