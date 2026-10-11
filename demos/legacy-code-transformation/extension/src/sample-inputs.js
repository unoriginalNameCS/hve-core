'use strict';

const PIZZA_TARGET_PATH = 'src/PizzaEligibility/PizzaDiscountCalculator.cs';
const NODE_TARGET_PATH = 'src/transfer.js';
const MAX_SAMPLE_CASES = 5;
const MAX_ACCOUNT_BALANCE = 1000000;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const SAMPLE_INPUT_SCHEMA = Object.freeze({
  pizzaCases: {
    type: 'array',
    items: {
      type: 'object', additionalProperties: false, required: ['subtotal', 'isMember'],
      properties: { subtotal: { type: 'string' }, isMember: { type: 'boolean' } }
    }
  },
  nodeCases: {
    type: 'array',
    items: {
      type: 'object', additionalProperties: false,
      required: ['accounts', 'sourceId', 'destinationId', 'amount'],
      properties: {
        accounts: {
          type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['id', 'balance'],
            properties: { id: { type: 'string' }, balance: { type: 'number' } }
          }
        },
        sourceId: { type: 'string' },
        destinationId: { type: 'string' },
        amount: { type: 'number' }
      }
    }
  }
});

function responseSchema(proposalSchema) {
  const schema = structuredClone(proposalSchema);
  schema.required.push('pizzaCases', 'nodeCases');
  Object.assign(schema.properties, structuredClone(SAMPLE_INPUT_SCHEMA));
  return schema;
}

function isFixtureTarget(target) {
  return (target.path === PIZZA_TARGET_PATH && target.symbol === 'CalculateDiscountAmount') ||
    (target.path === NODE_TARGET_PATH && target.symbol === 'transfer');
}

function isMoneyNumber(value, allowNegative = false) {
  return typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value) <= MAX_ACCOUNT_BALANCE && (allowNegative || value >= 0) &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}

function sampleInputError(reason, message) {
  return Object.assign(new Error(message), { sampleInputReason: reason });
}

function pizzaCaseFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'isMember,subtotal' || typeof value.isMember !== 'boolean') return 'pizza-shape';
  if (typeof value.subtotal !== 'string' || !/^(?:0|[1-9]\d{0,5}|1000000)(?:\.\d{2})?$/.test(value.subtotal)) {
    return 'pizza-subtotal-format';
  }
  const cents = Math.round(Number(value.subtotal) * 100);
  if (cents > MAX_ACCOUNT_BALANCE * 100) return 'pizza-subtotal-range';
  if (cents % 10 !== 0) return 'pizza-subtotal-increment';
  return null;
}

function validateNodeCase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'accounts,amount,destinationId,sourceId' ||
      !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > 4 ||
      typeof value.sourceId !== 'string' || !ID_PATTERN.test(value.sourceId) ||
      typeof value.destinationId !== 'string' || !ID_PATTERN.test(value.destinationId) ||
      !isMoneyNumber(value.amount, true)) return false;
  const ids = new Set();
  for (const account of value.accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account) ||
        Object.keys(account).sort().join(',') !== 'balance,id' ||
        typeof account.id !== 'string' || !ID_PATTERN.test(account.id) ||
        ids.has(account.id) || !isMoneyNumber(account.balance)) return false;
    ids.add(account.id);
  }
  return true;
}

function validateSampleInputs(sampleInputs, target, required = false) {
  if (!Array.isArray(sampleInputs) || sampleInputs.length > MAX_SAMPLE_CASES) {
    throw sampleInputError('too-many', 'Sample inputs must be a bounded array.');
  }
  const isPizza = target.path === PIZZA_TARGET_PATH && target.symbol === 'CalculateDiscountAmount';
  const isNode = target.path === NODE_TARGET_PATH && target.symbol === 'transfer';
  if (!isPizza && !isNode) {
    if (sampleInputs.length !== 0) throw sampleInputError('unsupported', 'Sample inputs are unsupported for this target.');
    return [];
  }
  if (required && sampleInputs.length < 3) {
    throw sampleInputError('too-few', 'Sample inputs must contain three to five valid, unique cases for the selected fixture target.');
  }
  for (const sample of sampleInputs) {
    const reason = isPizza ? pizzaCaseFailure(sample) : validateNodeCase(sample) ? null : 'node-case-shape';
    if (reason) {
      throw sampleInputError(reason, 'Sample inputs must contain three to five valid, unique cases for the selected fixture target.');
    }
  }
  if (new Set(sampleInputs.map((item) => JSON.stringify(item))).size !== sampleInputs.length) {
    throw sampleInputError('duplicate', 'Sample inputs must contain three to five valid, unique cases for the selected fixture target.');
  }
  return structuredClone(sampleInputs);
}

function selectSampleInputs(payload, target) {
  if (!Array.isArray(payload.pizzaCases) || !Array.isArray(payload.nodeCases)) {
    throw sampleInputError('arrays', 'Foundry response must include pizzaCases and nodeCases arrays.');
  }
  const isPizza = target.path === PIZZA_TARGET_PATH && target.symbol === 'CalculateDiscountAmount';
  const isNode = target.path === NODE_TARGET_PATH && target.symbol === 'transfer';
  const selected = isPizza ? payload.pizzaCases : isNode ? payload.nodeCases : [];
  const unused = isPizza ? payload.nodeCases : isNode ? payload.pizzaCases : [...payload.pizzaCases, ...payload.nodeCases];
  if (unused.length !== 0) {
    throw sampleInputError('wrong-array', 'Foundry response must provide cases only for the selected controlled fixture target.');
  }
  if (isFixtureTarget(target) && selected.length < 3) {
    throw sampleInputError('too-few', 'Foundry response must provide three to five cases for the selected controlled fixture target.');
  }
  if (selected.length > MAX_SAMPLE_CASES) {
    throw sampleInputError('too-many', 'Foundry response must provide three to five cases for the selected controlled fixture target.');
  }
  if (!isFixtureTarget(target) && (payload.pizzaCases.length !== 0 || payload.nodeCases.length !== 0)) {
    throw sampleInputError('unsupported', 'Foundry response must not provide cases for this target.');
  }
  return Object.freeze(validateSampleInputs(selected, target, isFixtureTarget(target)));
}

function expectedPizzaCase(sample) {
  const subtotalCents = Math.round(Number(sample.subtotal) * 100);
  const discountCents = sample.isMember || subtotalCents >= 5000 ? subtotalCents / 10 : 0;
  return (discountCents / 100).toFixed(2);
}

function expectedNodeCase(sample) {
  const accounts = Object.fromEntries(sample.accounts.map(({ id, balance }) => [id, balance]));
  let accepted = false;
  let reason = null;
  if (!Object.hasOwn(accounts, sample.sourceId)) reason = 'source missing';
  else if (!Object.hasOwn(accounts, sample.destinationId)) reason = 'destination missing';
  else if (sample.sourceId === sample.destinationId) reason = 'accounts must differ';
  else if (!Number.isFinite(sample.amount) || sample.amount <= 0) reason = 'amount must be positive';
  else if (accounts[sample.sourceId] < sample.amount) reason = 'insufficient funds';
  else {
    accepted = true;
    accounts[sample.sourceId] -= sample.amount;
    accounts[sample.destinationId] += sample.amount;
  }
  return { result: { accepted, reason }, balances: accounts };
}

function expectedSampleCase(target, sample) {
  if (target.path === PIZZA_TARGET_PATH && target.symbol === 'CalculateDiscountAmount') return expectedPizzaCase(sample);
  if (target.path === NODE_TARGET_PATH && target.symbol === 'transfer') return expectedNodeCase(sample);
  throw new Error('No independent sample-input oracle is configured for this target.');
}

module.exports = { PIZZA_TARGET_PATH, NODE_TARGET_PATH, MAX_SAMPLE_CASES, SAMPLE_INPUT_SCHEMA,
  responseSchema, isFixtureTarget, selectSampleInputs, validateSampleInputs, expectedSampleCase };
