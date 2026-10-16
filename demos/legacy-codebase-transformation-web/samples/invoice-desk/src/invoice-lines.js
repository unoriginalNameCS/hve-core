'use strict';

const _ = require('lodash');

function buildInvoiceLines(invoice) {
  const lines = [];
  const groups = _.groupBy(invoice.items, (item) => item.category || 'other');
  for (const [category, items] of Object.entries(groups)) {
    for (const item of items) {
      const data2 = item.description || 'Service';
      const d = item.quantity * item.unitPrice;
      const tmp = {
        sku: item.sku,
        description: data2,
        category,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: d,
        taxable: item.taxable !== false
      };
      if (item.discount) {
        tmp.discount = item.discount;
        tmp.subtotal = tmp.subtotal - item.discount;
      }
      if (item.notes) {
        tmp.notes = item.notes;
      }
      if (item.shipping) {
        tmp.shipping = item.shipping;
      }
      if (item.metadata) {
        tmp.metadata = item.metadata;
      }
      if (item.taxable === false) {
        tmp.tax = 0;
      } else {
        tmp.tax = Math.round(tmp.subtotal * 0.0825 * 100) / 100;
      }
      if (tmp.subtotal < 0) {
        tmp.subtotal = 0;
      }
      if (!tmp.description) {
        tmp.description = 'Service';
      }
      if (!tmp.category) {
        tmp.category = 'other';
      }
      if (!tmp.quantity) {
        tmp.quantity = 1;
      }
      lines.push(tmp);
    }
  }
  return lines;
}

module.exports = { buildInvoiceLines };
