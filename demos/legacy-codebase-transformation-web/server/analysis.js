'use strict';

const { chunkSourceFiles, scanPrompt } = require('../../legacy-codebase-transformation/extension/src/workspace-scan');
const { validateFindingResponse } = require('../../legacy-codebase-transformation/extension/src/scan-pipeline');

function validateUploadedFinding(payload, chunk) {
  const rejections = [];
  const findings = validateFindingResponse(payload, chunk, rejections);
  return { findings, rejections };
}

module.exports = { chunkSourceFiles, scanPrompt, validateUploadedFinding };
