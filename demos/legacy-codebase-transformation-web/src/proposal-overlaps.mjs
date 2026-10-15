function comparePosition(left, right) {
  return left.line - right.line || left.character - right.character;
}

function positions(finding) {
  return {
    start: { line: finding.range.startLine, character: finding.range.startCharacter },
    end: { line: finding.range.endLine, character: finding.range.endCharacter }
  };
}

export function findProposalOverlaps(findings) {
  const pairs = [];
  for (const [index, left] of findings.entries()) {
    const leftRange = positions(left);
    for (let otherIndex = index + 1; otherIndex < findings.length; otherIndex += 1) {
      const right = findings[otherIndex];
      if (left.path !== right.path) continue;
      const rightRange = positions(right);
      if (comparePosition(leftRange.start, rightRange.end) >= 0 ||
          comparePosition(rightRange.start, leftRange.end) >= 0) continue;
      pairs.push({
        key: JSON.stringify([left.id, right.id]),
        left, right, leftNumber: index + 1, rightNumber: otherIndex + 1,
        start: comparePosition(leftRange.start, rightRange.start) >= 0 ? leftRange.start : rightRange.start,
        end: comparePosition(leftRange.end, rightRange.end) <= 0 ? leftRange.end : rightRange.end
      });
    }
  }
  return pairs;
}

export function keepProposal(selected, keepId, otherId) {
  const next = new Set(selected);
  next.delete(otherId);
  next.add(keepId);
  return next;
}
