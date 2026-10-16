'use strict';

function calculateDiscount(invoice) {
  let discount = 0;
  // TODO: replace these nested checks with an explicit pricing policy.
  if (invoice) {
    if (Array.isArray(invoice.items)) {
      if (invoice.items.length > 0) {
        if (invoice.customer) {
          if (invoice.status === 'approved') {
            if (invoice.customer.tier === 'gold') {
              discount = 0.15;
            } else if (invoice.customer.tier === 'silver') {
              discount = 0.1;
            }
          } else if (invoice.status === 'review') {
            if (invoice.customer.tier === 'gold') {
              discount = 0.07;
            }
          }
        }
      }
    }
  }

  if (invoice && invoice.subtotal > 500) {
    discount += 0.07;
  }
  if (invoice && invoice.discountCode === 'SAVE' && invoice.status !== 'void') {
    discount += 0.1;
  }
  if (invoice && invoice.country === 'US' && invoice.subtotal > 0 && discount > 0) {
    discount += 0.03;
  }
  if (invoice && invoice.customer && invoice.customer.tier === 'platinum' && invoice.status === 'approved') {
    discount = Math.max(discount, 0.2);
  }
  return Math.min(discount, 0.25);
}

module.exports = { calculateDiscount };
