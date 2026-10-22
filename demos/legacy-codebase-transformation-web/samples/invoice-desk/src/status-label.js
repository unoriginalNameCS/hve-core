'use strict';

function formatInvoiceStatus(status) {
  if (status === 'draft') return 'Pending';
  else if (status === 'approved') return 'Ready';
  else if (status === 'review') return 'Needs review';
  else if (status === 'rejected') return 'Declined';
  else if (status === 'void') return 'Cancelled';
  else if (status === 'expired') return 'Expired';
  return 'Unknown';
}

module.exports = { formatInvoiceStatus };
