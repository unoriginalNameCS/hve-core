'use strict';

const MAX_DIFFERENCES = 5;

function isSerialisedObject(value) {
  return value && typeof value === 'object' && value.$type === 'object' && Array.isArray(value.entries);
}

function walk(expected, actual, path, out) {
  if (out.length >= MAX_DIFFERENCES) return;
  if (isSerialisedObject(expected) && isSerialisedObject(actual)) {
    const left = new Map(expected.entries);
    const right = new Map(actual.entries);
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      const childPath = `${path}.${key}`;
      if (!left.has(key)) out.push({ path: childPath, expected: '(missing)', actual: right.get(key) });
      else if (!right.has(key)) out.push({ path: childPath, expected: left.get(key), actual: '(missing)' });
      else walk(left.get(key), right.get(key), childPath, out);
      if (out.length >= MAX_DIFFERENCES) return;
    }
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) walk(expected[index], actual[index], `${path}[${index}]`, out);
    return;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) walk(expected[key], actual[key], path ? `${path}.${key}` : key, out);
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push({ path: path || '(result)', expected: expected ?? null, actual: actual ?? null });
}

function describeDifferences(expected, actual) {
  const out = [];
  walk(expected, actual, '', out);
  return out;
}

module.exports = { describeDifferences };
