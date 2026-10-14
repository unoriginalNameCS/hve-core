'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { searchCatalog } = require('./catalog-search');
const { buildOrderReport } = require('./order-report');
const mkdirpPackage = require('mkdirp');

const customers = [
  { id: 'C-101', firstName: 'Nia', lastName: 'Park', tier: 'standard' },
  { id: 'C-102', firstName: 'Omar', lastName: 'Reed', tier: 'staff' },
  { id: 'C-103', firstName: 'Mina', lastName: 'Cole', tier: 'gold' }
];

const orders = [
  {
    id: 'O-5001', customerId: 'C-101', couponCode: 'WELCOME10', shipping: 'standard',
    items: [
      { sku: 'LAMP-01', name: 'Desk lamp', unitPrice: 42, quantity: 1 },
      { sku: 'NOTE-02', name: 'Notebook set', unitPrice: 12, quantity: 2 }
    ]
  },
  {
    id: 'O-5002', customerId: 'C-102', couponCode: 'STAFF20', shipping: 'express',
    items: [
      { sku: 'CHAIR-03', name: 'Task chair', unitPrice: 89, quantity: 1 },
      { sku: 'MAT-04', name: 'Desk mat', unitPrice: 18, quantity: 1 }
    ]
  },
  {
    id: 'O-5003', customerId: 'C-103', couponCode: '', shipping: 'standard',
    items: [{ sku: 'PEN-05', name: 'Pen set', unitPrice: 8, quantity: 3 }]
  }
];

const products = [
  { sku: 'LAMP-01', name: 'Desk lamp', description: 'Adjustable warm task lighting', category: 'Lighting', price: 42, stock: 8, tags: ['desk', 'led'] },
  { sku: 'CHAIR-03', name: 'Task chair', description: 'Mesh chair with adjustable arms', category: 'Furniture', price: 89, stock: 3, tags: ['office', 'ergonomic'] },
  { sku: 'MAT-04', name: 'Desk mat', description: 'Large recycled felt work surface', category: 'Accessories', price: 18, stock: 0, tags: ['desk', 'felt'] },
  { sku: 'PEN-05', name: 'Pen set', description: 'Fine point assorted ink pens', category: 'Stationery', price: 8, stock: 24, tags: ['writing', 'set'] },
  { sku: 'SHELF-06', name: 'Wall shelf', description: 'Compact oak display shelf', category: 'Furniture', price: 54, stock: 5, tags: ['oak', 'storage'] }
];

async function runOrderDesk() {
  const uuidPackage = await import('uuid');
  const createRunId = uuidPackage.v4 || uuidPackage.default?.v4;
  const makeDirectory = typeof mkdirpPackage === 'function' ? mkdirpPackage : mkdirpPackage.mkdirp;
  if (typeof createRunId !== 'function' || typeof makeDirectory !== 'function') {
    throw new Error('The installed UUID or directory-creation API is unavailable.');
  }

  const report = buildOrderReport(orders, customers);
  const matchingProducts = searchCatalog(products, 'desk', { inStock: true, maximumPrice: 60 });
  const result = { runId: createRunId(), report, matchingProducts };
  const outputDirectory = path.join(__dirname, '..', 'dist');
  await makeDirectory(outputDirectory);
  await fs.writeFile(path.join(outputDirectory, 'daily-report.json'), `${JSON.stringify(result, null, 2)}\n`);

  console.log('Order Desk daily view');
  console.log(JSON.stringify(result, null, 2));
}

runOrderDesk().catch((error) => {
  console.error('Order Desk failed:', error.message);
  process.exitCode = 1;
});
