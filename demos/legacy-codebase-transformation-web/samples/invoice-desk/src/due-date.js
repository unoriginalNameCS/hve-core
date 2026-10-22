'use strict';

const { addDays, format } = require('date-fns');

function formatDueDate(issuedOn, termsDays) {
  return format(addDays(issuedOn, termsDays), 'YYYY-MM-DD');
}

module.exports = { formatDueDate };
