'use strict';

const TAX_RATE = 0.0825;
const CENTS = 100;

function summarizeTotals(lines) {
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    subtotal += line.subtotal;
    tax += line.tax;
  }
  const roundedSubtotal = Math.round(subtotal * CENTS) / CENTS;
  const roundedTax = Math.round(tax * CENTS) / CENTS;
  const total = Math.round((roundedSubtotal + roundedTax) * CENTS) / CENTS;
  return { subtotal: roundedSubtotal, tax: roundedTax, total, rate: TAX_RATE };
}

module.exports = { summarizeTotals };
