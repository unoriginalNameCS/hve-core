'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { findProposalOverlaps, keepProposal } = require('../src/proposal-overlaps.mjs');

function finding(id, startLine, startCharacter, endLine, endCharacter, path = 'src/report.js') {
  return { id, path, range: { startLine, startCharacter, endLine, endCharacter } };
}

test('overlapping proposals expose exact pairs, numbers, and shared ranges', () => {
  const findings = [finding('whole', 2, 0, 8, 1), finding('inner', 4, 2, 6, 3), finding('partial', 6, 0, 10, 1)];
  const pairs = findProposalOverlaps(findings);
  assert.deepEqual(pairs.map(({ leftNumber, rightNumber }) => [leftNumber, rightNumber]), [[1, 2], [1, 3], [2, 3]]);
  assert.deepEqual(pairs[0].start, { line: 4, character: 2 });
  assert.deepEqual(pairs[0].end, { line: 6, character: 3 });
  assert.deepEqual(pairs[2].start, { line: 6, character: 0 });
  assert.deepEqual(pairs[2].end, { line: 6, character: 3 });
});

test('adjacent spans and different files do not conflict, including same-line spans', () => {
  assert.deepEqual(findProposalOverlaps([
    finding('first', 1, 0, 1, 4), finding('adjacent', 1, 4, 1, 8),
    finding('next-line', 2, 0, 3, 0), finding('other-file', 1, 0, 9, 0, 'other.js')
  ]), []);
  assert.equal(findProposalOverlaps([finding('first', 1, 0, 1, 5), finding('second', 1, 4, 1, 8)]).length, 1);
  assert.equal(findProposalOverlaps([finding('first', 1, 0, 1, 5), finding('same', 1, 0, 1, 5)]).length, 1);
});

test('keeping either alternative only replaces its counterpart and preserves other choices', () => {
  const selected = new Set(['first', 'second', 'unrelated']);
  assert.deepEqual([...keepProposal(selected, 'first', 'second')], ['first', 'unrelated']);
  assert.deepEqual([...keepProposal(selected, 'second', 'first')], ['second', 'unrelated']);
  assert.deepEqual([...selected], ['first', 'second', 'unrelated']);
  assert.deepEqual([...keepProposal(new Set(), 'first', 'second')], ['first']);
});
