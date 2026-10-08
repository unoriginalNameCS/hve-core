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
  'package.json': 'c12148d20ab2e50379c11fa8a5b9753e63fc5ea11492c4debfb7c70e1e227353',
  'jsconfig.json': '16011b772803f6732d492b5633082f1f67118ff55ea5772ba17d6cdc90d9dbd4',
  [NODE_TARGET_PATH]: '9b1230ff629dde7a1eb09a323ea17c2c5ef00612071de92744e29eae32ea1574',
  'src/cases.js': '433343f200998ce42514f5535980a49cfaf07f47ccc9eb77f25e994e91ba4c9a',
  'src/runner.js': 'b645ca2f0dc750be7dc2894217412e5184d23941d570138321b9a8a3262e1f4c',
  'tests/transfer.test.js': '1f307325fcbe1b57abfacb531ae7bc87422348ddda0906754631467b42c74ea6'
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
