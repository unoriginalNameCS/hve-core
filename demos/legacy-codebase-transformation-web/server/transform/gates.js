'use strict';

const { createHash } = require('node:crypto');
const traverse = require('@babel/traverse').default;
const { assessProject } = require('../assess');
const { parseSource } = require('../assess/parse');
const { moduleExports } = require('../assess/units');

const METRIC_RULES = new Map([
  ['long-function', 'loc'], ['deep-nesting', 'maxNesting'], ['high-complexity', 'cyclomaticComplexity'],
  ['too-many-params', 'paramCount'], ['callback-nesting', 'callbackNesting'], ['long-branch-chain', 'maxBranchChain'],
  ['long-file', 'loc']
]);
const SEVERITY_RANK = { info: 0, warning: 1, high: 2 };

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function patternNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'RestElement') return patternNames(pattern.argument);
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(patternNames);
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap((property) => patternNames(property.value ?? property.argument));
  return [];
}

function topLevelBindings(ast) {
  const names = new Set();
  const add = (statement) => {
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      if (statement.id?.name) names.add(statement.id.name);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) for (const name of patternNames(declaration.id)) names.add(name);
    }
  };
  for (const statement of ast.program.body) {
    if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') add(statement.declaration ?? {});
    else add(statement);
  }
  return names;
}

function topLevelFunctionsInSpan(ast, start, end) {
  const functions = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type.startsWith('Export') ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' && declaration.start >= start && declaration.end <= end) {
      functions.push(declaration.id?.name);
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (item.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(item.init.type) &&
            item.start >= start && item.end <= end && item.id.type === 'Identifier') functions.push(item.id.name);
      }
    }
  }
  return functions.filter(Boolean);
}

function findTarget(assessment, unit) {
  return assessment.units.find((candidate) => candidate.path === unit.path && candidate.kind === unit.kind &&
    (unit.kind === 'function' ? candidate.name === unit.name : candidate.startLine === unit.startLine));
}

function severityRegression(beforeFindings, afterFindings) {
  const rank = { info: 0, warning: 1, high: 2 };
  const ruleIds = new Set([...beforeFindings, ...afterFindings].map((item) => item.ruleId));
  for (const ruleId of ruleIds) {
    for (const threshold of ['high', 'warning']) {
      const minimum = rank[threshold];
      const beforeCount = beforeFindings.filter((item) => item.ruleId === ruleId && rank[item.severity] >= minimum).length;
      const afterCount = afterFindings.filter((item) => item.ruleId === ruleId && rank[item.severity] >= minimum).length;
      if (afterCount > beforeCount) return { ruleId, severity: threshold };
    }
  }
  return null;
}

function scopeSafetyFailure(originalAst, updatedAst, unit) {
  const originalVars = [];
  const updatedDeclarations = new Map();
  traverse(originalAst, {
    VariableDeclarator(path) {
      if (path.parentPath.node.kind !== 'var' || path.node.start < unit.start || path.node.end > unit.end) return;
      for (const name of patternNames(path.node.id)) {
        const binding = path.scope.getBinding(name);
        originalVars.push({ name, binding });
      }
    }
  });
  traverse(updatedAst, {
    VariableDeclarator(path) {
      if (path.parentPath.node.kind === 'var') return;
      for (const name of patternNames(path.node.id)) updatedDeclarations.set(name, { kind: path.parentPath.node.kind, binding: path.scope.getBinding(name) });
    }
  });
  for (const original of originalVars) {
    const updated = updatedDeclarations.get(original.name);
    if (!updated) continue;
    if (updated.kind === 'const' && original.binding?.constantViolations.length) {
      return `Binding "${original.name}" is reassigned and cannot become const.`;
    }
    if (original.binding?.referencePaths.some((reference) => reference.node.start < original.binding.path.node.start)) {
      return `Binding "${original.name}" is referenced before declaration and cannot become ${updated.kind}.`;
    }
  }
  return null;
}

function gate(id, status, message) {
  return { id, status, message };
}

function evaluateReplacement({ unit, source, replacementText, sourceFiles, assessment, config = {} }) {
  const gates = [];
  const actualSpan = Number.isInteger(unit.start) && Number.isInteger(unit.end) ? source.slice(unit.start, unit.end) : null;
  const exact = actualSpan === unit.originalText;
  gates.push(gate('exact-span', exact ? 'pass' : 'fail', exact ? 'The source span still matches.' : 'The source span changed since assessment.'));
  if (!exact || typeof replacementText !== 'string' || !replacementText.trim()) {
    gates.push(gate('parse', 'not-checked', 'A valid exact replacement span is required.'));
    return { accepted: false, gates, updatedContent: null, residualFindings: [] };
  }
  if (unit.sourceHash && sha256(source) !== unit.sourceHash) {
    gates.push(gate('source-hash', 'fail', 'The source file changed since assessment.'));
    gates.push(gate('parse', 'not-checked', 'The source file hash did not match.'));
    return { accepted: false, gates, updatedContent: null, residualFindings: [] };
  }
  gates.push(gate('source-hash', 'pass', 'The source file hash matches.'));

  const updatedContent = `${source.slice(0, unit.start)}${replacementText}${source.slice(unit.end)}`;
  const originalParsed = parseSource(source, unit.path);
  const updatedParsed = parseSource(updatedContent, unit.path);
  if (!updatedParsed.ast) {
    gates.push(gate('parse', 'fail', `The replacement is invalid JavaScript: ${updatedParsed.error}`));
    return { accepted: false, gates, updatedContent, residualFindings: [] };
  }
  gates.push(gate('parse', 'pass', 'The updated file parses as JavaScript.'));
  if (!originalParsed.ast) {
    gates.push(gate('invariants', 'fail', 'The original file no longer parses.'));
    return { accepted: false, gates, updatedContent, residualFindings: [] };
  }

  const beforeExports = moduleExports(originalParsed.ast);
  const afterExports = moduleExports(updatedParsed.ast);
  const updatedAssessment = assessProject([{ path: unit.path, content: updatedContent }], config);
  const afterTarget = findTarget(updatedAssessment, unit);
  let invariantFailure = null;
  if (unit.kind === 'function' && !afterTarget) invariantFailure = `The original function "${unit.name}" is missing.`;
  else if (unit.kind === 'function' && afterTarget.metrics.paramCount !== unit.paramCount) invariantFailure = 'The function parameter count changed.';
  else if (unit.kind === 'function' && afterTarget.name !== unit.name) invariantFailure = 'The function name changed.';
  else if (beforeExports.format !== afterExports.format) invariantFailure = 'The module format changed.';
  else if (JSON.stringify(beforeExports.names) !== JSON.stringify(afterExports.names)) invariantFailure = 'The module export names changed.';

  if (!invariantFailure && unit.kind === 'function') {
    const originalNames = topLevelBindings(originalParsed.ast);
    const replacementEnd = unit.start + replacementText.length;
    const helperNames = topLevelFunctionsInSpan(updatedParsed.ast, unit.start, replacementEnd).filter((name) => name !== unit.name);
    const collision = helperNames.find((name) => originalNames.has(name));
    if (collision) invariantFailure = `Helper name "${collision}" already exists in the module.`;
  }
  gates.push(gate('invariants', invariantFailure ? 'fail' : 'pass', invariantFailure ?? 'Function signature, exports, and module format are preserved.'));

  const scopeFailure = unit.kind === 'statement' ? scopeSafetyFailure(originalParsed.ast, updatedParsed.ast, unit) : null;
  gates.push(gate('statement-scope', scopeFailure ? 'fail' : 'pass', scopeFailure ?? 'No unsafe var scope change was detected.'));

  const baselineAssessment = assessment ?? assessProject([{ path: unit.path, content: source }], config);
  const beforeTarget = findTarget(baselineAssessment, unit) ?? unit;
  const targetedRuleIds = [...new Set(unit.findings.map((item) => item.ruleId))];
  const remaining = afterTarget?.findings ?? [];
  const improved = [];
  const failures = [];
  for (const ruleId of targetedRuleIds) {
    if (ruleId === 'too-many-params') continue;
    if (METRIC_RULES.has(ruleId)) {
      const key = METRIC_RULES.get(ruleId);
      const beforeValue = ruleId === 'long-file' ? unit.metrics.loc : beforeTarget.metrics[key];
      const afterValue = ruleId === 'long-file' ? updatedAssessment.files[0]?.loc : afterTarget?.metrics[key];
      if (Number.isFinite(beforeValue) && Number.isFinite(afterValue) && afterValue < beforeValue) improved.push(ruleId);
      else failures.push(ruleId);
    } else {
      const approvedMessages = new Set(unit.findings.filter((item) => item.ruleId === ruleId).map((item) => item.message));
      const matching = (items) => items.filter((item) => item.ruleId === ruleId && approvedMessages.has(item.message)).length;
      const beforeCount = matching(beforeTarget.findings ?? unit.findings);
      const afterCount = matching(remaining);
      if (afterCount < beforeCount) improved.push(ruleId);
      else failures.push(ruleId);
    }
  }
  const actionable = targetedRuleIds.filter((ruleId) => ruleId !== 'too-many-params');
  const metricFailure = !actionable.length || failures.length > 0;
  const residualFindings = remaining;
  gates.push(gate('metric-improvement', metricFailure ? 'fail' : 'pass', metricFailure ?
    `Targeted findings did not all improve: ${failures.length ? failures.join(', ') : 'no editable target finding'}.` :
    `Improved ${improved.join(', ')}.${targetedRuleIds.includes('too-many-params') ? ' Parameter-count finding remains because the signature is preserved.' : ''}`));

  const originalFiles = sourceFiles ?? [{ path: unit.path, content: source }];
  const originalProject = assessment ?? assessProject(originalFiles, config);
  const updatedFiles = originalFiles.map((file) => file.path === unit.path ? { ...file, content: updatedContent } : file);
  const updatedProject = assessProject(updatedFiles, config);
  const severityRegressionFound = severityRegression(originalProject.findings, updatedProject.findings);
  gates.push(gate('no-new-findings', severityRegressionFound ? 'fail' : 'pass', severityRegressionFound ?
    `The replacement introduced additional ${severityRegressionFound.severity}-severity ${severityRegressionFound.ruleId} finding(s).` : 'No additional warning or high-severity findings were introduced.'));

  const accepted = gates.every((item) => item.status === 'pass');
  return { accepted, gates, updatedContent, residualFindings, updatedAssessment };
}

module.exports = { evaluateReplacement, scopeSafetyFailure, topLevelBindings };
