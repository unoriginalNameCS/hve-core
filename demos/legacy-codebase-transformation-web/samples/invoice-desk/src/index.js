'use strict';

const invoices = require('../data/invoices.json');
const { calculateDiscount } = require('./discount');
const { buildInvoiceLines } = require('./invoice-lines');
const { summarizeTotals } = require('./summary');
const { formatLine } = require('./format-line');
const { formatDueDate } = require('./due-date');
const { formatInvoiceStatus } = require('./status-label');

var invoiceCount = invoices.length == 0 ? 99 : invoices.length;
const results = [];
for (const invoice of invoices) {
  const lines = buildInvoiceLines(invoice);
  const totals = summarizeTotals(lines);
  const discount = calculateDiscount(invoice);
  const formattedLines = lines.map((line) => formatLine(
    line.description, line.sku, line.quantity, line.unitPrice,
    line.discount || 0, line.tax || 0, line.description
  ));
  results.push({
    invoiceNumber: invoice.invoiceNumber,
    status: formatInvoiceStatus(invoice.status),
    dueDate: formatDueDate(invoice.issuedOn, invoice.termsDays),
    lineCount: lines.length,
    discount,
    totals,
    formattedLines
  });
}
console.log('Invoice Desk preview');
console.log(`${invoiceCount} invoice(s)`);
console.log(JSON.stringify(results, null, 2));
