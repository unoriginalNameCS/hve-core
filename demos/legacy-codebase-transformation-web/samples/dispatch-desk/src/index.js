'use strict';

const { summarizeDispatch } = require('./dispatch-quote');

const dispatches = [
  {
    reference: 'D-701', status: 'ready', destination: { zone: 'local' }, service: 'standard', discountCode: 'LOCAL10',
    packages: [{ weight: 2.5 }, { weight: 1.25 }]
  },
  {
    reference: 'D-702', status: 'ready', destination: { zone: 'remote' }, service: 'express', discountCode: '',
    packages: [{ weight: 4 }]
  },
  {
    reference: 'D-703', status: 'ready', destination: { zone: 'regional' }, service: 'standard', discountCode: '',
    packages: [{ weight: 0 }]
  }
];

const summaries = dispatches.map(summarizeDispatch);
console.log('Dispatch Desk readiness preview');
console.log(JSON.stringify(summaries, null, 2));
