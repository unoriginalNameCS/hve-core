'use strict';

const parser = require('@babel/parser');

function parseSource(content, relativePath = 'source.js') {
  try {
    const ast = parser.parse(content, {
      sourceFilename: relativePath,
      sourceType: 'unambiguous',
      plugins: ['jsx'],
      errorRecovery: false
    });
    return {
      ast,
      moduleFormat: ast.program.sourceType === 'module' ? 'esm' : 'commonjs',
      error: null
    };
  } catch (error) {
    return { ast: null, moduleFormat: null, error: error.message };
  }
}

module.exports = { parseSource };
