'use strict';

function ratingFor(debtMinutes, loc) {
  const ratio = debtMinutes / Math.max(1, loc * 0.5);
  if (ratio <= 0.05) return 'A';
  if (ratio <= 0.1) return 'B';
  if (ratio <= 0.2) return 'C';
  if (ratio <= 0.5) return 'D';
  return 'E';
}

function scoreProject(files) {
  const allFindings = files.flatMap((file) => file.findings);
  const findingsByPath = new Map();
  for (const item of allFindings) {
    const list = findingsByPath.get(item.path) ?? [];
    list.push(item);
    findingsByPath.set(item.path, list);
  }
  const fileScores = files.map((file) => {
    const findings = findingsByPath.get(file.path) ?? [];
    const debtMinutes = findings.reduce((total, item) => total + item.remediationMinutes, 0);
    return { path: file.path, loc: file.loc, debtMinutes, rating: ratingFor(debtMinutes, file.loc), findingCount: findings.length };
  });
  const debtMinutes = allFindings.reduce((total, item) => total + item.remediationMinutes, 0);
  const loc = files.reduce((total, file) => total + file.loc, 0);
  return {
    debtMinutes,
    debtHours: Math.round((debtMinutes / 60) * 10) / 10,
    loc,
    rating: ratingFor(debtMinutes, loc),
    findingCount: allFindings.length,
    files: fileScores
  };
}

module.exports = { ratingFor, scoreProject };
