'use strict';

const { assessProject } = require('../assess');
const { captureBaseline, compareRewrite } = require('../characterise/harness');
const { INPUT_SCHEMA, REWRITE_SCHEMA, buildInputPrompt, buildRewritePrompt } = require('./prompts');
const { evaluateReplacement } = require('./gates');
const { requestStructured } = require('../foundry-client');

function validateCases(response, unit) {
  if (!response || !Array.isArray(response.cases) || response.cases.length !== 5) {
    throw new Error('Foundry must return exactly five characterisation cases.');
  }
  const cases = response.cases.map((item) => {
    if (!item || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 120 ||
        !Array.isArray(item.args) || item.args.length !== unit.paramCount || item.args.some((value) => typeof value !== 'string')) {
      throw new Error('Each characterisation case must have a description and the selected function argument count.');
    }
    let args;
    try { args = item.args.map((value) => JSON.parse(value)); }
    catch { throw new Error('Each characterisation argument must contain valid JSON.'); }
    return { description: item.description.trim(), args };
  });
  if (Buffer.byteLength(JSON.stringify(cases), 'utf8') > 32 * 1024) throw new Error('Characterisation inputs exceed the 32 KB limit.');
  return cases;
}

const METRIC_RULE_IDS = new Set(['long-function', 'deep-nesting', 'high-complexity', 'callback-nesting', 'long-branch-chain', 'long-file']);

// Metric messages embed the current value, so metric findings match on rule alone.
function isApprovedFinding(unit, item) {
  return unit.findings.some((target) => target.ruleId === item.ruleId &&
    (METRIC_RULE_IDS.has(item.ruleId) || target.message === item.message));
}

function validationFeedback(gates, comparison, residualFindings = [], previousAttempt = '') {
  const failed = gates.filter((item) => item.status === 'fail').map((item) => `${item.id}: ${item.message}`);
  const mismatches = comparison?.cases?.filter((item) => !item.passed).slice(0, 3).map((item) => (item.differences?.length
    ? { description: item.description, args: item.args, differences: item.differences }
    : { description: item.description, args: item.args, expected: item.expected, actual: item.actual })) ?? [];
  const unresolved = residualFindings.filter((item) => item.ruleId !== 'too-many-params')
    .map((item) => `${item.ruleId} (line ${item.line}): ${item.message}`);
  return JSON.stringify({ failedGates: failed, unresolvedFindings: unresolved, mismatches,
    ...(previousAttempt ? { previousAttempt: previousAttempt.slice(0, 12000) } : {}) });
}

async function transformUnit({ unit, source, sourceFiles, files, rootName, assessment, config = {} }, options = {}) {
  const sendProgress = options.onProgress ?? (() => {});
  const structuredRequest = options.requestStructured ?? requestStructured;
  const baselineCapture = options.captureBaseline ?? captureBaseline;
  const rewriteComparison = options.compareRewrite ?? compareRewrite;
  const workspaceFiles = files ?? new Map(sourceFiles.map((file) => [file.path, Buffer.from(file.content, 'utf8')]));
  let baseline;
  if (unit.kind === 'function') {
    const inputPrompt = buildInputPrompt(unit);
    sendProgress({ stage: 'inputs', unitId: unit.id });
    const inputResponse = await structuredRequest(inputPrompt, {
      schemaName: 'characterisation_inputs', schema: INPUT_SCHEMA, ...(options.foundryOptions ?? {})
    });
    const cases = validateCases(inputResponse, unit);
    sendProgress({ stage: 'baseline', unitId: unit.id });
    baseline = await baselineCapture(workspaceFiles, rootName, unit, cases, {
      ...(options.characterisationOptions ?? {}),
      onProgress: (progress) => sendProgress({ ...progress, unitId: unit.id })
    });
  } else {
    baseline = { status: 'not-checked', reason: 'Statement units do not have function inputs for characterisation.', cases: [] };
  }

  let feedback = '';
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    sendProgress({ stage: 'rewrite', unitId: unit.id, attempt });
    const prompt = buildRewritePrompt(unit, baseline, assessment, feedback);
    const response = await structuredRequest(prompt, {
      schemaName: 'source_replacement', schema: REWRITE_SCHEMA, purpose: 'rewrite', ...(options.foundryOptions ?? {})
    });
    if (!response || typeof response.replacementText !== 'string' || !response.replacementText.trim()) {
      throw new Error('Foundry did not return a complete source replacement.');
    }

    const staticResult = evaluateReplacement({
      unit, source, replacementText: response.replacementText, sourceFiles, assessment, config
    });
    let comparison = { status: 'not-checked', reason: baseline.status === 'passed' ? 'Static gates did not pass.' : baseline.reason, cases: [] };
    if (staticResult.accepted && baseline.status === 'passed') {
      sendProgress({ stage: 'comparison', unitId: unit.id, attempt });
      const rewrittenFiles = new Map(workspaceFiles);
      rewrittenFiles.set(unit.path, Buffer.from(
        `${source.slice(0, unit.start)}${response.replacementText}${source.slice(unit.end)}`, 'utf8'));
      comparison = await rewriteComparison(rewrittenFiles, rootName, unit, baseline, {
        ...(options.characterisationOptions ?? {}),
        onProgress: (progress) => sendProgress({ ...progress, unitId: unit.id, attempt })
      });
    }
    const mismatched = comparison.cases?.filter((item) => !item.passed) ?? [];
    const runFailures = mismatched.filter((item) => item.actual?.moduleError || item.actual?.status);
    const failureLabel = (actual) => actual.moduleError ? `module error: ${actual.moduleError.message}` : actual.reason ?? actual.status;
    const characterisationGate = {
      id: 'characterisation',
      status: comparison.status === 'passed' ? 'pass' : comparison.status === 'failed' ? 'fail' : 'not-checked',
      message: comparison.status === 'failed'
        ? `${mismatched.length} of ${comparison.cases.length} cases returned a different result from the original${runFailures.length ? ` (${runFailures.length} did not run: ${[...new Set(runFailures.map((item) => failureLabel(item.actual)))].join(', ')})` : ''}. See the case tabs below.`
        : comparison.reason ?? (comparison.status === 'passed' ? 'All stable baseline cases matched.' : 'Characterisation could not be completed.')
    };
    const gates = [...staticResult.gates, characterisationGate];
    const accepted = staticResult.accepted && comparison.status !== 'failed';
    const entry = { attempt, rationale: response.rationale ?? '', replacementText: response.replacementText,
      gates, comparison, residualFindings: staticResult.residualFindings };
    attempts.push(entry);
    if (accepted) {
      return {
        status: 'ready', unitId: unit.id, path: unit.path, name: unit.name,
        originalText: unit.originalText, replacementText: response.replacementText,
        rationale: response.rationale ?? '', baseline, comparison, gates,
        residualFindings: staticResult.residualFindings, attempts: attempt,
        warningAcknowledgementRequired: gates.some((item) => item.status === 'not-checked')
      };
    }
    if (attempt === 2) break;
    feedback = validationFeedback(staticResult.gates, comparison,
      staticResult.residualFindings.filter((item) => isApprovedFinding(unit, item)), response.replacementText);
  }

  const lastAttempt = attempts.at(-1);
  return {
    status: 'rejected', unitId: unit.id, path: unit.path, name: unit.name,
    originalText: unit.originalText, replacementText: lastAttempt.replacementText,
    rationale: lastAttempt.rationale, baseline, comparison: lastAttempt.comparison,
    gates: lastAttempt.gates, residualFindings: lastAttempt.residualFindings,
    attempts: attempts.length, warningAcknowledgementRequired: lastAttempt.gates.some((item) => item.status === 'not-checked'),
    attemptHistory: attempts.map((item) => ({
      attempt: item.attempt, replacementText: item.replacementText, rationale: item.rationale,
      failedGates: item.gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id)
    })),
    reason: 'The proposal did not pass the static and behaviour checks after one retry.'
  };
}

module.exports = { transformUnit, validateCases, validationFeedback };
