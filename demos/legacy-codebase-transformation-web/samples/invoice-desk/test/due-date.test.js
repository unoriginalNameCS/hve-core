'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const invoices = require('../data/invoices.json');
const { formatDueDate } = require('../src/due-date');

test('due dates follow each invoice payment terms', () => {
  for (const invoice of invoices) {
    assert.equal(formatDueDate(invoice.issuedOn, invoice.termsDays), invoice.expectedDueDate);
  }
});
