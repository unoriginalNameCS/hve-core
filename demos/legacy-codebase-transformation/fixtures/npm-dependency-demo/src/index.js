'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lodash = require('lodash');
const mkdirp = require('mkdirp');

function loadOrders() {
  const contents = fs.readFileSync(path.join(__dirname, '..', 'data', 'orders.json'), 'utf8');
  return JSON.parse(contents);
}

function formatOrderCount(count) {
  if (count === 1) {
    return '1 order';
  } else {
    return `${count} orders`;
  }
}

async function main() {
  const orders = loadOrders();
  const regions = lodash.groupBy(orders, 'region');
  const summary = { regions: {}, total: { orders: orders.length, amount: lodash.sumBy(orders, 'amount') } };
  console.log('Order Summary');
  for (const region of Object.keys(regions).sort()) {
    const regionOrders = regions[region];
    const amount = lodash.sumBy(regionOrders, 'amount');
    summary.regions[region] = { orders: regionOrders.length, amount };
    console.log(`${region}: ${formatOrderCount(regionOrders.length)}, $${amount.toFixed(2)}`);
  }
  console.log(`Total: ${orders.length} orders, $${summary.total.amount.toFixed(2)}`);
  const outputDirectory = path.join(os.tmpdir(), 'npm-dependency-demo');
  mkdirp.sync(outputDirectory);
  fs.writeFileSync(path.join(outputDirectory, 'order-summary.json'), JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
