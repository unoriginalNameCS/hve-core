'use strict';

function summarizeAttendance(decisions) {
  let accepted = 0;
  let rejected = 0;
  let revenue = 0;
  const reasons = {};

  for (const decision of decisions) {
    if (decision) {
      if (decision.accepted === true) {
        accepted = accepted + 1;
        revenue = revenue + decision.price;
      } else {
        rejected = rejected + 1;
        if (decision.reason) {
          if (reasons[decision.reason]) {
            reasons[decision.reason] = reasons[decision.reason] + 1;
          } else {
            reasons[decision.reason] = 1;
          }
        }
      }
    }
  }

  return { accepted, rejected, revenue: Number(revenue.toFixed(2)), reasons };
}

module.exports = { summarizeAttendance };
