'use strict';

const _ = require('lodash');

function transfer(accounts, sourceId, destinationId, amount) {
  if (Object.hasOwn(accounts, sourceId)) {
    if (Object.hasOwn(accounts, destinationId)) {
      if (sourceId !== destinationId) {
        if (_.isFinite(amount) && amount > 0) {
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
}

module.exports = { transfer };
