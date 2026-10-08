'use strict';

const NODE_TARGET_PATH = 'src/transfer.js';
const NODE_BASELINE = `function transfer(accounts, sourceId, destinationId, amount) {
  if (Object.hasOwn(accounts, sourceId)) {
    if (Object.hasOwn(accounts, destinationId)) {
      if (sourceId !== destinationId) {
        if (Number.isFinite(amount) && amount > 0) {
          if (accounts[sourceId] >= amount) {
            accounts[sourceId] -= amount;
            accounts[destinationId] += amount;
            return { accepted: true, reason: null };
          } else {
            return { accepted: false, reason: 'insufficient funds' };
          }
        } else {
          return { accepted: false, reason: 'amount must be positive' };
        }
      } else {
        return { accepted: false, reason: 'accounts must differ' };
      }
    } else {
      return { accepted: false, reason: 'destination missing' };
    }
  } else {
    return { accepted: false, reason: 'source missing' };
  }
}`;
const NODE_REPLACEMENT = `function transfer(accounts, sourceId, destinationId, amount) {
  if (!Object.hasOwn(accounts, sourceId)) return { accepted: false, reason: 'source missing' };
  if (!Object.hasOwn(accounts, destinationId)) return { accepted: false, reason: 'destination missing' };
  if (sourceId === destinationId) return { accepted: false, reason: 'accounts must differ' };
  if (!Number.isFinite(amount) || amount <= 0) return { accepted: false, reason: 'amount must be positive' };
  if (accounts[sourceId] < amount) return { accepted: false, reason: 'insufficient funds' };
  accounts[sourceId] -= amount;
  accounts[destinationId] += amount;
  return { accepted: true, reason: null };
}`;
const NODE_HASHES = Object.freeze({
  'package.json': '1750280a9b4e0fc75274c10116987ca807d27d54513d69020a58b166aff891a3',
  'jsconfig.json': '1a5e750d147b15318174099bf1bd28d7f0a9bea4cc1ccae7f52d60af1d1be683',
  [NODE_TARGET_PATH]: 'fb116b3865c5af50e5ae9b1d8c9023e8eb1ef5de8cdec5841c3caed9fb7b3023',
  'src/cases.js': '5e7056196a56e7ef742fbe26daaf1e17ff76a179b3de9e6728dd548fca5b56bb',
  'src/runner.js': 'ef67cfcfda6b6be531dee5f333b9d17e0470aa389691c10437d7afa0f3d5ce43',
  'tests/transfer.test.js': '6b43df87699a30b5ab8530f27ed8693a6cb0ed98727bd0a77a98391a1c36f624'
});
const NODE_CASES = Object.freeze([
  { input: 'successful transfer', result: { accepted: true, reason: null }, balances: { alice: 75, bob: 75 } },
  ...[['missing source', 'source missing'], ['missing destination', 'destination missing'],
    ['both missing', 'source missing'], ['same account', 'accounts must differ'],
    ['zero amount', 'amount must be positive'], ['negative amount', 'amount must be positive'],
    ['insufficient funds', 'insufficient funds']].map(([input, reason]) => ({
    input, result: { accepted: false, reason }, balances: { alice: 100, bob: 50 }
  }))
].map((scenario) => Object.freeze({ ...scenario, result: Object.freeze(scenario.result), balances: Object.freeze(scenario.balances) })));

module.exports = { NODE_TARGET_PATH, NODE_BASELINE, NODE_REPLACEMENT, NODE_HASHES, NODE_CASES };
