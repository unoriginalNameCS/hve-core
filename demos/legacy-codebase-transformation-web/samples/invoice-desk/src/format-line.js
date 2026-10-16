'use strict';

function formatLine(description, sku, quantity, unitPrice, discount, tax, val) {
  const label = val || description;
  const lineTotal = quantity * unitPrice - discount + tax;
  return `${label} [${sku}] x${quantity}: $${lineTotal.toFixed(2)}`;
}

module.exports = { formatLine };
