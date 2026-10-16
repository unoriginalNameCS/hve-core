'use strict';

const traverse = require('@babel/traverse').default;

const CONTROL_NODES = new Set([
  'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement', 'CatchClause'
]);

function ancestorsOfType(path, type, stopNode) {
  let count = 0;
  for (const ancestor of path.getAncestry()) {
    if (ancestor.node === stopNode) break;
    if (type === 'Function' ? ancestor.isFunction() : ancestor.node.type === type) count += 1;
  }
  return count;
}

function nestedFunctionSpans(ast, node) {
  const spans = [];
  traverse(ast, {
    Function(path) {
      if (path.node !== node && path.node.start >= node.start && path.node.end <= node.end) {
        spans.push({ start: path.node.loc.start.line, end: path.node.loc.end.line });
      }
    }
  });
  return spans;
}

function traverseFunction(ast, node, visitors) {
  traverse(ast, {
    Function(path) {
      if (path.node === node) {
        path.traverse(visitors);
        path.stop();
      }
    }
  });
}

function isLiteralInit(init) {
  if (!init) return false;
  if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral'].includes(init.type)) return true;
  return init.type === 'UnaryExpression' && init.operator === '-' && init.argument.type === 'NumericLiteral';
}

// Named-constant declarations are the magic-number fix, so they must not count toward function length.
function constantDeclarationLines(node) {
  const lines = new Set();
  for (const statement of node.body?.body ?? []) {
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' &&
        statement.declarations.every((item) => item.id.type === 'Identifier' && isLiteralInit(item.init))) {
      for (let line = statement.loc.start.line; line <= statement.loc.end.line; line += 1) lines.add(line);
    }
  }
  return lines;
}

function measureFunction(ast, node, content) {
  let complexity = 1;
  let maxNesting = 0;
  let callbackNesting = 0;
  let maxBranchChain = 0;
  const nestedSpans = nestedFunctionSpans(ast, node);
  const constantLines = constantDeclarationLines(node);
  const lines = content.split(/\r?\n/);
  const startLine = node.loc.start.line;
  const endLine = node.loc.end.line;
  let loc = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    if (!lines[line - 1]?.trim()) continue;
    if (nestedSpans.some((span) => line >= span.start && line <= span.end)) continue;
    if (constantLines.has(line)) continue;
    loc += 1;
  }

  traverseFunction(ast, node, {
    Function(path) {
      if (path.node !== node) {
        path.skip();
      }
    },
    IfStatement(path) {
      const depth = path.getAncestry().filter((ancestor) => ancestor.node !== node && CONTROL_NODES.has(ancestor.node.type)).length;
      maxNesting = Math.max(maxNesting, depth + 1);
      complexity += 1;
      let chainLength = 1;
      let alternate = path.node.alternate;
      while (alternate?.type === 'IfStatement') {
        chainLength += 1;
        alternate = alternate.alternate;
      }
      maxBranchChain = Math.max(maxBranchChain, chainLength);
    },
    'ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|CatchClause'(path) {
      const depth = path.getAncestry().filter((ancestor) => ancestor.node !== node && CONTROL_NODES.has(ancestor.node.type)).length;
      maxNesting = Math.max(maxNesting, depth + 1);
      complexity += 1;
    },
    SwitchStatement(path) {
      const depth = path.getAncestry().filter((ancestor) => ancestor.node !== node && CONTROL_NODES.has(ancestor.node.type)).length;
      maxNesting = Math.max(maxNesting, depth + 1);
      const cases = path.node.cases.filter((item) => item.test !== null).length;
      complexity += cases;
      maxBranchChain = Math.max(maxBranchChain, path.node.cases.length);
    },
    ConditionalExpression() { complexity += 1; },
    LogicalExpression() { complexity += 1; }
  });
  traverseFunction(ast, node, {
    Function(path) {
      callbackNesting = Math.max(callbackNesting, ancestorsOfType(path, 'Function', node));
    }
  });

  return {
    loc,
    maxNesting,
    cyclomaticComplexity: complexity,
    paramCount: node.params?.length ?? 0,
    callbackNesting,
    maxBranchChain
  };
}

module.exports = { measureFunction };
