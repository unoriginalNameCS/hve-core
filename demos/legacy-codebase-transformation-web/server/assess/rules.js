'use strict';

const DEFAULT_RULES = Object.freeze({
  'long-function': { warn: 40, high: 80, minutes: 5, highMinutes: 5 },
  'deep-nesting': { warn: 3, high: 5, minutes: 2, highMinutes: 3 },
  'high-complexity': { warn: 10, high: 20, minutes: 3, highMinutes: 4 },
  'too-many-params': { warn: 4, high: 6, minutes: 3, highMinutes: 5 },
  'callback-nesting': { warn: 3, high: 4, minutes: 2, highMinutes: 3 },
  'long-branch-chain': { warn: 6, high: 10, minutes: 2, highMinutes: 3 },
  'bad-variable-name': { warn: 1, high: null, minutes: 0.5 },
  'magic-number': { warn: 1, high: null, minutes: 0.5 },
  'loose-equality': { warn: 1, high: null, minutes: 0.5 },
  'var-declaration': { warn: 1, high: null, minutes: 0.5 },
  'debt-marker': { warn: 1, high: null, minutes: 1 },
  'long-file': { warn: 300, high: 600, minutes: 5, highMinutes: 8 },
  'empty-catch': { warn: 1, high: null, minutes: 1 }
});

const DEFAULT_NAME_ALLOWLIST = ['i', 'j', 'k', 'e', 'err', 'a', 'b', '_', 'x', 'y'];
const DEFAULT_VAGUE_NAMES = ['data', 'temp', 'tmp', 'val', 'obj', 'foo', 'bar', 'thing', 'stuff', 'res', 'info'];
const DEFAULT_MAGIC_ALLOWLIST = [0, 1, -1, 2];

function ruleSettings(config = {}) {
  return {
    rules: Object.fromEntries(Object.entries(DEFAULT_RULES).map(([id, defaults]) => [
      id, { ...defaults, ...(config.rules?.[id] ?? {}) }
    ])),
    nameAllowlist: new Set([ ...DEFAULT_NAME_ALLOWLIST, ...(config.nameAllowlist ?? []) ].map((name) => name.toLowerCase())),
    vagueNames: new Set([ ...DEFAULT_VAGUE_NAMES, ...(config.vagueNames ?? []) ].map((name) => name.toLowerCase())),
    magicAllowlist: new Set([ ...DEFAULT_MAGIC_ALLOWLIST, ...(config.magicAllowlist ?? []) ].map(Number))
  };
}

function severityFor(ruleId, value, settings) {
  const rule = settings.rules[ruleId];
  if (rule.high !== null && value >= rule.high) return 'high';
  return 'warning';
}

function finding({ ruleId, unitId, path, line, column, offset, value, message, settings }) {
  const rule = settings.rules[ruleId];
  const severity = severityFor(ruleId, value, settings);
  return {
    id: `${unitId}:${ruleId}:${offset ?? `${line ?? 0}:${message}`}:${value}`,
    unitId,
    path,
    ruleId,
    severity,
    line: line ?? null,
    column: column ?? null,
    value,
    message,
    remediationMinutes: severity === 'high' ? rule.highMinutes : rule.minutes
  };
}

function metricFinding(ruleId, unit, value, settings) {
  const rule = settings.rules[ruleId];
  if (value < rule.warn) return null;
  return finding({
    ruleId,
    unitId: unit.id,
    path: unit.path,
    line: unit.startLine,
    value,
    message: `${ruleId} is ${value} (threshold ${rule.warn}).`,
    settings
  });
}

function badName(name, settings, context = {}) {
  const lower = name.toLowerCase();
  if (settings.nameAllowlist.has(lower)) return false;
  if (context.catchBinding && ['e', 'err'].includes(lower)) return false;
  if (context.comparatorBinding && ['a', 'b'].includes(lower)) return false;
  return name.length <= 2 || settings.vagueNames.has(lower) || /^\w+\d+$/.test(name);
}

module.exports = { DEFAULT_MAGIC_ALLOWLIST, DEFAULT_NAME_ALLOWLIST, DEFAULT_RULES, badName, finding, metricFinding, ruleSettings, severityFor };
