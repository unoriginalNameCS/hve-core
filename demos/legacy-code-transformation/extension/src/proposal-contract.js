'use strict';

const path = require('node:path');

const PROPOSAL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'target', 'evidence', 'changes', 'unknowns'],
  properties: {
    summary: { type: 'string' },
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'symbol'],
      properties: { path: { type: 'string' }, symbol: { type: 'string' } }
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'path', 'startLine', 'endLine', 'claim'],
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          claim: { type: 'string' }
        }
      }
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'originalText', 'replacementText', 'rationale'],
        properties: {
          path: { type: 'string' },
          originalText: { type: 'string' },
          replacementText: { type: 'string' },
          rationale: { type: 'string' }
        }
      }
    },
    unknowns: { type: 'array', items: { type: 'string' } }
  }
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isNormalizedRelativePath(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function validateProposal(proposal, evidenceCatalog, expectedTarget) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const topKeys = ['summary', 'target', 'evidence', 'changes', 'unknowns'];

  if (!hasExactKeys(proposal, topKeys)) {
    return { valid: false, errors: ['Proposal must contain only summary, target, evidence, changes, and unknowns.'] };
  }
  if (typeof proposal.summary !== 'string' || proposal.summary.trim().length === 0) {
    fail('summary must be a non-empty string.');
  }
  if (!hasExactKeys(proposal.target, ['path', 'symbol'])) {
    fail('target must contain only path and symbol.');
  } else {
    if (!isNormalizedRelativePath(proposal.target.path)) {
      fail('target.path must be a normalized project-relative path.');
    }
    if (typeof proposal.target.symbol !== 'string' || proposal.target.symbol.trim().length === 0) {
      fail('target.symbol must be a non-empty string.');
    }
    if (expectedTarget &&
        (proposal.target.path !== expectedTarget.path || proposal.target.symbol !== expectedTarget.symbol)) {
      fail('target does not match the user-selected file and symbol.');
    }
  }

  const catalog = new Map((evidenceCatalog ?? []).map((item) => [item.id, item]));
  const collectedSourceByPath = new Map();
  for (const item of evidenceCatalog ?? []) {
    if (!isNormalizedRelativePath(item.path) || typeof item.content !== 'string') {
      continue;
    }
    collectedSourceByPath.set(item.path, [collectedSourceByPath.get(item.path) ?? '', item.content].join('\n'));
  }
  if (!Array.isArray(proposal.evidence)) {
    fail('evidence must be an array.');
  } else {
    proposal.evidence.forEach((citation, index) => {
      const label = `evidence[${index}]`;
      if (!hasExactKeys(citation, ['id', 'path', 'startLine', 'endLine', 'claim'])) {
        fail(`${label} must contain only id, path, startLine, endLine, and claim.`);
        return;
      }
      if (typeof citation.id !== 'string' || !catalog.has(citation.id)) {
        fail(`${label}.id does not identify collected evidence.`);
        return;
      }
      const source = catalog.get(citation.id);
      if (citation.path !== source.path || !isNormalizedRelativePath(citation.path)) {
        fail(`${label}.path does not match its collected evidence path.`);
      }
      if (!Number.isInteger(citation.startLine) || !Number.isInteger(citation.endLine) ||
          citation.startLine < source.startLine || citation.endLine > source.endLine ||
          citation.endLine < citation.startLine) {
        fail(`${label} line range is outside the collected evidence range.`);
      }
      if (typeof citation.claim !== 'string' || citation.claim.trim().length === 0) {
        fail(`${label}.claim must be a non-empty string.`);
      }
    });
  }

  if (!Array.isArray(proposal.changes)) {
    fail('changes must be an array.');
  } else {
    proposal.changes.forEach((change, index) => {
      const label = `changes[${index}]`;
      if (!hasExactKeys(change, ['path', 'originalText', 'replacementText', 'rationale'])) {
        fail(`${label} must contain only path, originalText, replacementText, and rationale.`);
        return;
      }
      if (!isNormalizedRelativePath(change.path)) {
        fail(`${label}.path must be a normalized project-relative path.`);
      } else if (!collectedSourceByPath.has(change.path)) {
        fail(`${label}.path was not included in collected source evidence.`);
      }
      for (const field of ['originalText', 'replacementText', 'rationale']) {
        if (typeof change[field] !== 'string') {
          fail(`${label}.${field} must be a string.`);
        }
      }
      if (typeof change.path === 'string' && typeof change.originalText === 'string' &&
          change.originalText.length > 0 &&
          !collectedSourceByPath.get(change.path)?.includes(change.originalText)) {
        fail(`${label}.originalText was not found in collected source evidence.`);
      }
    });
  }

  if (!Array.isArray(proposal.unknowns) || proposal.unknowns.some((item) => typeof item !== 'string')) {
    fail('unknowns must be an array of strings.');
  }

  return { valid: errors.length === 0, errors };
}

function codeSpan(value) {
  const runs = [...String(value).matchAll(/`+/g)].map((match) => match[0].length);
  const fence = '`'.repeat(Math.max(0, ...runs) + 1);
  const padding = String(value).startsWith('`') || String(value).endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function escapeText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function textFence(value) {
  const runs = [...String(value).matchAll(/`+/g)].map((match) => match[0].length);
  const fence = '`'.repeat(Math.max(3, ...runs) + 1);
  return `${fence}text\n${value}\n${fence}`;
}

function renderProposalReport(proposal, evidenceCatalog, expectedTarget) {
  const validation = validateProposal(proposal, evidenceCatalog, expectedTarget);
  if (!validation.valid) {
    throw new Error(`Proposal validation failed: ${validation.errors.join(' ')}`);
  }

  const catalog = new Map((evidenceCatalog ?? []).map((item) => [item.id, item]));
  const lines = [
    '# Legacy Code Refactor Proposal',
    '',
    escapeText(proposal.summary),
    '',
    '## Target',
    '',
    `* File: ${codeSpan(proposal.target.path)}`,
    `* Symbol: ${codeSpan(proposal.target.symbol)}`,
    '',
    '## Evidence',
    ''
  ];

  for (const citation of proposal.evidence) {
    const source = catalog.get(citation.id);
    lines.push(`* ${codeSpan(citation.id)} ${codeSpan(citation.path)}:${citation.startLine}-${citation.endLine}: ${escapeText(citation.claim)}`);
    lines.push('', textFence(source.content));
  }

  lines.push('', '## Proposed Changes', '');
  for (const [index, change] of proposal.changes.entries()) {
    lines.push(`### Change ${index + 1}: ${codeSpan(change.path)}`, '');
    lines.push(`Rationale: ${escapeText(change.rationale)}`, '', 'Original:', '', textFence(change.originalText), '', 'Replacement:', '', textFence(change.replacementText), '');
  }

  lines.push('## Unknowns', '');
  if (proposal.unknowns.length === 0) {
    lines.push('* None recorded.');
  } else {
    lines.push(...proposal.unknowns.map((unknown) => `* ${escapeText(unknown)}`));
  }
  lines.push('', '> This report is a proposal only. No source files were changed or validated by rendering it.', '');
  return lines.join('\n');
}

module.exports = { PROPOSAL_SCHEMA, renderProposalReport, validateProposal };