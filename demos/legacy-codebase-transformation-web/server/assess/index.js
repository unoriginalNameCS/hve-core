'use strict';

const { createHash } = require('node:crypto');
const { parseSource } = require('./parse');
const { analyzeUnits } = require('./units');
const { scoreProject } = require('./score');

function assessProject(sourceFiles, config = {}) {
  const files = [];
  const gaps = [];
  for (const sourceFile of sourceFiles) {
    const parsed = parseSource(sourceFile.content, sourceFile.path);
    if (!parsed.ast) {
      gaps.push({ path: sourceFile.path, reason: `JavaScript parse failed: ${parsed.error}` });
      continue;
    }
    const units = analyzeUnits(sourceFile.path, sourceFile.content, parsed.ast, config);
    const sourceHash = sourceFile.sourceHash ?? createHash('sha256').update(sourceFile.content, 'utf8').digest('hex');
    for (const unit of units) unit.sourceHash = sourceHash;
    const findings = units.flatMap((unit) => unit.findings);
    const loc = sourceFile.content.split(/\r?\n/).filter((line) => line.trim()).length;
    files.push({ path: sourceFile.path, loc, moduleFormat: parsed.moduleFormat, units, findings });
  }
  const score = scoreProject(files);
  const unitList = files.flatMap((file) => file.units);
  const hotspots = [...unitList].filter((unit) => unit.findings.length)
    .sort((left, right) => right.findings.reduce((sum, item) => sum + item.remediationMinutes, 0) -
      left.findings.reduce((sum, item) => sum + item.remediationMinutes, 0));
  return { ...score, files, fileScores: score.files, units: unitList, findings: files.flatMap((file) => file.findings), gaps, hotspots };
}

module.exports = { assessProject };
