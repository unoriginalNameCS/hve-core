'use strict';

function findOpenClasses(classes, filters) {
  const matches = [];

  for (const classInfo of classes) {
    if (classInfo && classInfo.active === true) {
      if (Number.isInteger(classInfo.spotsLeft) && classInfo.spotsLeft > 0) {
        if (!filters.day || classInfo.day === filters.day) {
          if (!filters.level || classInfo.level === filters.level) {
            if (!Number.isFinite(filters.maximumPrice) || classInfo.price <= filters.maximumPrice) {
              matches.push({
                name: classInfo.name,
                day: classInfo.day,
                startTime: classInfo.startTime,
                spotsLeft: classInfo.spotsLeft,
                price: classInfo.price
              });
            }
          }
        }
      }
    }
  }

  return matches;
}

module.exports = { findOpenClasses };
