'use strict';

const invoices = require('../data/invoices.json');
const { v4: uuidv4 } = require('uuid');
const { calculateDiscount } = require('./discount');
const { buildInvoiceLines } = require('./invoice-lines');
const { summarizeTotals } = require('./summary');
const { formatLine } = require('./format-line');

var invoiceCount = invoices.length == 0 ? 99 : invoices.length;
const invoiceRunId = uuidv4();
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
    lineCount: lines.length,
    discount,
    totals,
    formattedLines
  });
}
console.log('Invoice Desk preview');
console.log(`Run ${invoiceRunId.slice(0, 8)} · ${invoiceCount} invoice(s)`);
console.log(JSON.stringify(results, null, 2));
