'use strict';

const assert = require('node:assert/strict');
const invoices = require('../data/invoices.json');
const { buildInvoiceLines } = require('../src/invoice-lines');
const { summarizeTotals } = require('../src/summary');
const { formatInvoiceStatus } = require('../src/status-label');

for (const [status, label] of [
  ['draft', 'Pending'], ['approved', 'Ready'], ['review', 'Needs review'],
  ['rejected', 'Declined'], ['void', 'Cancelled'], ['expired', 'Expired'], ['unknown', 'Unknown']
]) {
  assert.equal(formatInvoiceStatus(status), label);
}

for (const invoice of invoices) {
  const lines = buildInvoiceLines(invoice);
  const totals = summarizeTotals(lines);
  assert.ok(lines.length > 0, `Invoice ${invoice.invoiceNumber} has no lines.`);
  assert.ok(Number.isFinite(totals.total), `Invoice ${invoice.invoiceNumber} has an invalid total.`);
}
console.log('Invoice Desk build checks passed.');
