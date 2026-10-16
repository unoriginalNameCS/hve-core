'use strict';

const traverse = require('@babel/traverse').default;
const { measureFunction } = require('./metrics');
const { badName, finding, metricFinding, ruleSettings } = require('./rules');

function getName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'VariableDeclaration') {
    const declarator = parent.declarations.find((item) => item.init === node);
    if (declarator?.id.type === 'Identifier') return declarator.id.name;
  }
  if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') return parent.left.name;
  if (parent?.type === 'ObjectProperty' && parent.key.type === 'Identifier') return parent.key.name;
  return '<anonymous>';
}

function isFunction(node) {
  return node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type);
}

function functionForTopLevel(node) {
  if (isFunction(node)) return node;
  if (node.type === 'VariableDeclaration') {
    const declarator = node.declarations.find((item) => isFunction(item.init));
    return declarator?.init ?? null;
  }
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    return functionForTopLevel(node.declaration);
  }
  return null;
}

function collectBindings(node) {
  const bindings = [];
  const seen = new Set();
  const addPattern = (pattern, context = {}) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      if (!seen.has(pattern.name)) {
        seen.add(pattern.name);
        bindings.push({ name: pattern.name, node: pattern, context });
      }
    } else if (pattern.type === 'RestElement') addPattern(pattern.argument, context);
    else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left, context);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((element) => addPattern(element, context));
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((property) => addPattern(property.value ?? property.argument, context));
  };

  for (const parameter of node.params ?? []) addPattern(parameter);
  const ast = { type: 'File', program: { type: 'Program', sourceType: 'script', body: [node], directives: [] } };
  traverse(ast, {
    Function(path) { if (path.node !== node) path.skip(); },
    VariableDeclarator(path) {
      const declaration = path.parentPath.node;
      addPattern(path.node.id, { varKind: declaration.kind });
    },
    CatchClause(path) { addPattern(path.node.param, { catchBinding: true }); },
    FunctionDeclaration(path) {
      if (path.node !== node && path.node.id) addPattern(path.node.id);
    }
  });
  return bindings;
}

function moduleExports(ast) {
  const names = new Set();
  let hasCommonJs = false;
  let hasEsm = false;
  traverse(ast, {
    ExportNamedDeclaration(path) {
      hasEsm = true;
      for (const specifier of path.node.specifiers) names.add(specifier.exported.name ?? specifier.exported.value);
      if (path.node.declaration?.id?.name) names.add(path.node.declaration.id.name);
    },
    ExportDefaultDeclaration() { hasEsm = true; names.add('default'); },
    AssignmentExpression(path) {
      const left = path.node.left;
      if (left.type === 'MemberExpression' && left.object.type === 'Identifier' && left.object.name === 'module' && left.property.name === 'exports') {
        hasCommonJs = true;
        if (path.node.right.type === 'ObjectExpression') {
          for (const property of path.node.right.properties) if (property.key?.name ?? property.key?.value) names.add(property.key.name ?? property.key.value);
        } else names.add('default');
      }
      if (left.type === 'MemberExpression' && left.object.type === 'Identifier' && left.object.name === 'exports') {
        hasCommonJs = true;
        names.add(left.property.name ?? left.property.value);
      }
    }
  });
  return { names: [...names].sort(), format: hasEsm ? 'esm' : 'commonjs', hasCommonJs };
}

function collectFunctionFindings(ast, unit, node, content, settings) {
  const findings = [];
  const metrics = measureFunction(ast, node, content);
  for (const [ruleId, key] of [
    ['long-function', 'loc'], ['deep-nesting', 'maxNesting'], ['high-complexity', 'cyclomaticComplexity'],
    ['too-many-params', 'paramCount'], ['callback-nesting', 'callbackNesting'], ['long-branch-chain', 'maxBranchChain']
  ]) {
    const item = metricFinding(ruleId, unit, metrics[key], settings);
    if (item) findings.push(item);
  }

  for (const binding of collectBindings(node)) {
    if (badName(binding.name, settings, binding.context)) {
      findings.push(finding({ ruleId: 'bad-variable-name', unitId: unit.id, path: unit.path,
        line: binding.node.loc.start.line, column: binding.node.loc.start.column + 1, value: 1, message: `Vague or short identifier "${binding.name}".`, settings }));
    }
  }

  traverse(ast, {
    Function(path) {
      if (path.node !== node) return;
      path.traverse({
        Function(innerPath) { innerPath.skip(); },
        VariableDeclaration(innerPath) {
          if (innerPath.node.kind === 'var') findings.push(finding({ ruleId: 'var-declaration', unitId: unit.id, path: unit.path,
            line: innerPath.node.loc.start.line, column: innerPath.node.loc.start.column + 1, value: 1, message: 'Use block-scoped declaration instead of var.', settings }));
        },
        BinaryExpression(innerPath) {
          if (innerPath.node.operator === '==' || innerPath.node.operator === '!=') findings.push(finding({ ruleId: 'loose-equality', unitId: unit.id,
            path: unit.path, line: innerPath.node.loc.start.line, column: innerPath.node.loc.start.column + 1, value: 1, message: `Use strict equality instead of ${innerPath.node.operator}.`, settings }));
        },
        NumericLiteral(innerPath) {
          const parent = innerPath.parentPath;
          const negative = parent.isUnaryExpression({ operator: '-' });
          const value = negative ? -innerPath.node.value : innerPath.node.value;
          const declaration = parent.parentPath?.isVariableDeclarator() ? parent.parentPath.parentPath.node : parent.isVariableDeclarator() ? parent.parentPath.node : null;
          const isConstInitializer = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const';
          const isIndex = parent.isMemberExpression() && parent.node.computed && parent.node.property === innerPath.node;
          const isDefault = parent.isAssignmentPattern();
          if (!settings.magicAllowlist.has(value) && !isConstInitializer && !isIndex && !isDefault) {
            findings.push(finding({ ruleId: 'magic-number', unitId: unit.id, path: unit.path, line: innerPath.node.loc.start.line, column: innerPath.node.loc.start.column + 1, offset: innerPath.node.start,
              value: 1, message: `Extract numeric literal ${value} to a named constant.`, settings }));
          }
        },
        CatchClause(innerPath) {
          if (!innerPath.node.body.body.length) findings.push(finding({ ruleId: 'empty-catch', unitId: unit.id, path: unit.path,
            line: innerPath.node.loc.start.line, column: innerPath.node.loc.start.column + 1, value: 1, message: 'Catch block does not handle or report the error.', settings }));
        }
      });
      path.stop();
    }
  });
  for (const comment of ast.comments ?? []) {
    if (comment.start >= node.start && comment.end <= node.end && /\b(TODO|FIXME|HACK)\b/i.test(comment.value)) {
      findings.push(finding({ ruleId: 'debt-marker', unitId: unit.id, path: unit.path, line: comment.loc.start.line, column: comment.loc.start.column + 1,
        value: 1, message: 'Resolve or track this TODO/FIXME/HACK marker.', settings }));
    }
  }
  return { metrics, findings };
}

function analyzeUnits(path, content, ast, config = {}) {
  const settings = ruleSettings(config);
  const program = ast.program;
  const exports = moduleExports(ast);
  const units = [];
  const fileUnitId = `${path}::file`;
  const fileLineCount = content.split(/\r?\n/).filter((line) => line.trim()).length;

  for (const statement of program.body) {
    const functionNode = functionForTopLevel(statement);
    if (!functionNode) continue;
    const name = getName(functionNode, statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement);
    const start = statement.start;
    const end = statement.end;
    const unit = {
      id: `${path}::function::${name}::${functionNode.loc.start.line}`,
      kind: 'function', path, name, start, end,
      startLine: statement.loc.start.line, endLine: statement.loc.end.line,
      originalText: content.slice(start, end), metrics: {}, findings: [],
      exportNames: exports.names, moduleFormat: exports.format, paramCount: functionNode.params.length
    };
    const result = collectFunctionFindings(ast, unit, functionNode, content, settings);
    unit.metrics = result.metrics;
    unit.findings = result.findings;
    units.push(unit);
  }

  for (const statement of program.body) {
    if (functionForTopLevel(statement)) continue;
    const unit = { id: `${path}::statement::${statement.loc.start.line}`, kind: 'statement', path,
      name: statement.type, start: statement.start, end: statement.end, startLine: statement.loc.start.line,
      endLine: statement.loc.end.line, originalText: content.slice(statement.start, statement.end), metrics: {}, findings: [],
      exportNames: exports.names, moduleFormat: exports.format, paramCount: null };
    const statementAst = { type: 'File', program: { type: 'Program', sourceType: 'script', body: [statement], directives: [] } };
    traverse(statementAst, {
      Function(path) { path.skip(); },
      VariableDeclaration(path) {
        if (path.node.kind === 'var') unit.findings.push(finding({ ruleId: 'var-declaration', unitId: unit.id, path: unit.path,
          line: path.node.loc.start.line, column: path.node.loc.start.column + 1, value: 1, message: 'Use block-scoped declaration instead of var.', settings }));
      },
      BinaryExpression(path) {
        if (path.node.operator === '==' || path.node.operator === '!=') unit.findings.push(finding({ ruleId: 'loose-equality', unitId: unit.id,
          path: unit.path, line: path.node.loc.start.line, column: path.node.loc.start.column + 1, value: 1, message: `Use strict equality instead of ${path.node.operator}.`, settings }));
      },
      NumericLiteral(path) {
        const parent = path.parentPath;
        const negative = parent.isUnaryExpression({ operator: '-' });
        const value = negative ? -path.node.value : path.node.value;
        const declaration = parent.parentPath?.isVariableDeclarator() ? parent.parentPath.parentPath.node : parent.isVariableDeclarator() ? parent.parentPath.node : null;
        const isConstInitializer = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const';
        const isIndex = parent.isMemberExpression() && parent.node.computed;
        if (!settings.magicAllowlist.has(value) && !isConstInitializer && !isIndex) unit.findings.push(finding({ ruleId: 'magic-number', unitId: unit.id,
          path: unit.path, line: path.node.loc.start.line, column: path.node.loc.start.column + 1, offset: path.node.start, value: 1, message: `Extract numeric literal ${value} to a named constant.`, settings }));
      },
      CatchClause(path) {
        if (!path.node.body.body.length) unit.findings.push(finding({ ruleId: 'empty-catch', unitId: unit.id, path: unit.path,
          line: path.node.loc.start.line, column: path.node.loc.start.column + 1, value: 1, message: 'Catch block does not handle or report the error.', settings }));
      }
    });
    for (const comment of ast.comments ?? []) {
      if (comment.start >= statement.start && comment.end <= statement.end && /\b(TODO|FIXME|HACK)\b/i.test(comment.value)) {
        unit.findings.push(finding({ ruleId: 'debt-marker', unitId: unit.id, path: unit.path, line: comment.loc.start.line, column: comment.loc.start.column + 1,
          value: 1, message: 'Resolve or track this TODO/FIXME/HACK marker.', settings }));
      }
    }
    const binding = statement.type === 'VariableDeclaration' ? statement.declarations.flatMap((item) => item.id.type === 'Identifier' ? [item.id] : []) : [];
    for (const identifier of binding) {
      if (badName(identifier.name, settings)) unit.findings.push(finding({ ruleId: 'bad-variable-name', unitId: unit.id, path: unit.path,
        line: identifier.loc.start.line, column: identifier.loc.start.column + 1, value: 1, message: `Vague or short identifier "${identifier.name}".`, settings }));
    }
    if (unit.findings.length) units.push(unit);
  }

  const fileFindings = [];
  const longFile = metricFinding('long-file', { id: fileUnitId, path, startLine: 1 }, fileLineCount, settings);
  if (longFile) fileFindings.push(longFile);
  for (const comment of ast.comments ?? []) {
    if (/\b(TODO|FIXME|HACK)\b/i.test(comment.value) && !units.some((unit) => comment.start >= unit.start && comment.end <= unit.end)) {
      fileFindings.push(finding({ ruleId: 'debt-marker', unitId: fileUnitId, path, line: comment.loc.start.line, column: comment.loc.start.column + 1,
        value: 1, message: 'Resolve or track this TODO/FIXME/HACK marker.', settings }));
    }
  }
  if (fileFindings.length) units.push({ id: fileUnitId, kind: 'file', path, name: path.split('/').at(-1), start: 0,
    end: content.length, startLine: 1, endLine: content.split(/\r?\n/).length, originalText: content,
    metrics: { loc: fileLineCount }, findings: fileFindings, exportNames: exports.names, moduleFormat: exports.format, paramCount: null });

  return units;
}

module.exports = { analyzeUnits, moduleExports };
