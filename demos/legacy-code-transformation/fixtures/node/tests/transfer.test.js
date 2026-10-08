'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { transfer } = require('../src/transfer');
const { cases, resetAccounts } = require('../src/cases');

for (const scenario of cases) {
  test(scenario.name, () => {
    const accounts = resetAccounts();
    const before = structuredClone(accounts);
    const result = transfer(accounts, scenario.sourceId, scenario.destinationId, scenario.amount);
    assert.deepEqual(result, { accepted: scenario.accepted, reason: scenario.reason });
    assert.deepEqual(accounts, scenario.accepted ? scenario.balances : before);
  });
}
