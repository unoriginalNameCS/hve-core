'use strict';

const { transfer } = require('./transfer');
const { cases, resetAccounts } = require('./cases');
const scenario = cases.find((item) => item.name === process.argv[2]);
if (!scenario) {
  process.stderr.write(`${JSON.stringify({ error: 'unknown case' })}\n`);
  process.exitCode = 2;
} else {
  const accounts = resetAccounts();
  const result = transfer(accounts, scenario.sourceId, scenario.destinationId, scenario.amount);
  process.stdout.write(`${JSON.stringify({ result, balances: accounts })}\n`);
}
