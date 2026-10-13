'use strict';

const cases = [
  { name: 'successful transfer', sourceId: 'alice', destinationId: 'bob', amount: 25, accepted: true, reason: null, balances: { alice: 75, bob: 75 } },
  { name: 'missing source', sourceId: 'missing', destinationId: 'bob', amount: 25, accepted: false, reason: 'source missing' },
  { name: 'missing destination', sourceId: 'alice', destinationId: 'missing', amount: 25, accepted: false, reason: 'destination missing' },
  { name: 'both missing', sourceId: 'missing', destinationId: 'absent', amount: 25, accepted: false, reason: 'source missing' },
  { name: 'same account', sourceId: 'alice', destinationId: 'alice', amount: 25, accepted: false, reason: 'accounts must differ' },
  { name: 'zero amount', sourceId: 'alice', destinationId: 'bob', amount: 0, accepted: false, reason: 'amount must be positive' },
  { name: 'negative amount', sourceId: 'alice', destinationId: 'bob', amount: -5, accepted: false, reason: 'amount must be positive' },
  { name: 'insufficient funds', sourceId: 'alice', destinationId: 'bob', amount: 101, accepted: false, reason: 'insufficient funds' }
];

function resetAccounts() {
  return { alice: 100, bob: 50 };
}

module.exports = { cases, resetAccounts };
