'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { escapeMarkdown } = require('./scan-report');
const { isPathWithinRoot } = require('./workspace-scope');

const text = (value) => escapeMarkdown(String(value ?? 'unknown').slice(0, 2048));

function listing(values, render, limit = 200) {
  if (!values.length) return 'None recorded.';
  return values.slice(0, limit).map(render).join('\n') +
    (values.length > limit ? `\n\nDisplay limited to ${limit} of ${values.length} entries; counts include all recorded entries.` : '');
}

function renderCodeBlock(value, language) {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function metadata(value) {
  if (!value) return 'unknown';
  return `${text(value.version)} (${text(value.status)}; deprecation: ${text(value.deprecationStatus)}` +
    `${value.deprecated ? `, ${text(value.deprecated)}` : ''})`;
}

function renderRegistry(entry) {
  return [
    `### ${text(entry.name)}`,
    '',
    `Registry evidence: ${text(entry.status)}; queried: ${entry.queried ? 'yes' : 'no'}`,
    `Source: <${entry.url}>; retrieved: ${text(entry.completedAt)}`,
    `Published latest tag: ${metadata(entry.latest)}`,
    `Latest stable nondeprecated release: ${metadata(entry.latestStable)}`,
    `Known locked direct versions: ${entry.lockedVersions.map(metadata).join('; ') || 'unknown'}`,
    '',
    listing(entry.declarations, (declaration) =>
      `* ${text(declaration.manifest)}; ${text(declaration.spec)}; ${declaration.groups.map(text).join(', ')}; ` +
      `highest nondeprecated stable range candidate: ${metadata(declaration.candidate)}\n` +
      `  Direct update candidate: ${declaration.updateCandidate ? metadata(declaration.updateCandidate) : 'none established'}\n` +
      `  Caveats: ${declaration.caveats.map(text).join(' ')}`, 20),
    '',
    listing([...new Map([entry.latest, entry.latestStable, ...entry.declarations.flatMap((declaration) =>
      [declaration.candidate, declaration.updateCandidate])].filter(Boolean).map((version) => [version.version, version])).values()], (version) =>
      `* ${text(version.version)} engines: ${text(JSON.stringify(version.engines))}; ` +
      `peers: ${text(JSON.stringify(version.peerDependencies))}`, 20),
    '',
    `Evidence gaps: ${entry.gaps.map(text).join('; ') || 'none recorded'}`
  ].join('\n');
}

function renderAdvisories(entry) {
  return [
    `### ${text(entry.name)} @ ${text(entry.version)}`,
    '',
    `OSV evidence: ${text(entry.status)}; outcome: ${text(entry.outcome)}; pages: ${entry.pages}`,
    `Source: <${entry.url}>; retrieved: ${text(entry.completedAt)}`,
    `Provider-returned active advisory IDs: ${entry.activeCount}; withdrawn IDs: ${entry.withdrawnCount}`,
    'Counts are per package/version and canonical advisory ID, not alias-deduplicated project vulnerability counts.',
    '',
    listing(entry.matches, (match) => {
      const severity = [...match.severity, ...match.affected.flatMap((affected) => affected.severity)]
        .map((rating) => `${text(rating.type)}: ${text(rating.score)}`).join('; ');
      const fixes = [...new Set(match.affected.flatMap((affected) => affected.ranges
        .flatMap((range) => range.events.filter((event) => event.fixed).map((event) => event.fixed))))];
      return `* [${text(match.id)}](${match.url}); modified: ${text(match.modified)}; ` +
        `withdrawn: ${text(match.withdrawn ?? 'no')}; aliases: ${match.aliases.map(text).join(', ') || 'none supplied'}\n` +
        `  Published severity: ${severity || text(match.databaseSeverity ?? 'unknown')}; ` +
        `advisory-reported fixed versions: ${fixes.map(text).join(', ') || 'none supplied'}\n` +
        `  Matching npm affected evidence: ${text(JSON.stringify(match.affected))}`;
    }),
    '',
    `Evidence gaps: ${entry.gaps.map(text).join('; ') || 'none recorded'}`
  ].join('\n');
}

function dependencySnippet(declaration, version) {
  return JSON.stringify(Object.fromEntries(declaration.groups.map((group) =>
    [group, { [declaration.package]: version }])), null, 2);
}

function renderDependencyReport(result) {
  const inventory = result.inventory;
  const queried = [...result.registry, ...result.advisories].filter((entry) => entry.queried).length;
  const unknown = [...result.registry, ...result.advisories].filter((entry) => entry.status !== 'completed').length;
  const updates = result.registry.flatMap((entry) => entry.declarations.filter((declaration) => declaration.updateCandidate)
    .map((declaration) => ({ package: entry.name, ...declaration })));
  const blockedDeprecations = result.registry.flatMap((entry) => entry.declarations.filter((declaration) =>
    !declaration.updateCandidate && declaration.lockedVersions.some((version) => entry.lockedVersions.some((metadata) =>
      metadata.version === version && metadata.deprecationStatus === 'deprecated')))
    .map((declaration) => ({ package: entry.name, ...declaration })));
  return [
    '# npm Dependency Evidence Report',
    '',
    `Status: ${text(result.status)}`,
    'Human review: pending',
    'Source, manifests and locks changed: none; project commands, tests and installs: not run',
    `Workspace root: ${text(result.projectRoot)}`,
    `Snapshot fingerprint: ${text(result.fingerprint)}`,
    `Current snapshot: ${result.currentSnapshot === true ? 'matched at final local check' : 'stale, dirty or unchecked; evidence is historical only'}`,
    `Assessment started: ${text(result.startedAt)}; finished: ${text(result.completedAt)}`,
    `Actual HTTP attempts: ${result.requests}`,
    `Approved identifiers queried: ${queried}; skipped: ${result.registry.length + result.advisories.length - queried}; incomplete/unknown: ${unknown}`,
    '',
    '## Evidence Scope',
    '',
    'This recommendation-only report separates declarations, lock-recorded versions, registry facts and published provider-returned advisory matches. Locks do not prove installation or runtime reachability. OSV can match upstream versions approximately; matches do not establish application exploitability. No matches means only none returned within completed provider coverage, never security approval or a vulnerability-free project.',
    'Registry candidates and advisory-reported fixes are not verified compatible or guaranteed-safe upgrades. Candidate-version advisories, project behavior, build success, runtime end-of-life and private feeds were not assessed. A direct update candidate is a reviewable version suggestion only; no package changes are made by this assessment.',
    `Coverage: ${text(JSON.stringify(inventory.coverage))}`,
    `Limits: ${text(JSON.stringify(inventory.limits))}`,
    'Hidden, dependency and generated/build folders are excluded. Supported lock formats are npm v2/v3 packages maps. Leaf projects do not inherit ancestor locks; aliases, overrides, links, non-public resolutions and other package managers can leave gaps. Detail display is bounded independently of lookup coverage.',
    '',
    '## Local Snapshot',
    '',
    listing(inventory.documents, (document) => `* ${text(document.path)}; SHA-256: ${text(document.hash)}`),
    '',
    '## Declared Dependencies',
    '',
    listing(inventory.declarations, (entry) => `* ${text(entry.name)}; ${text(entry.spec)}; ` +
      `${entry.groups.map(text).join(', ')}; manifest: ${text(entry.manifest)}; ` +
      `locked direct versions: ${entry.lockedVersions.map(text).join(', ') || 'unknown'}`),
    '',
    '## Proposed Direct Dependency Updates',
    '',
    'Candidates are discovered automatically. They are version suggestions, not compatibility/security approval. Exact lockfile changes are generated in a disposable copy only after the user selects candidates and approves resolution.',
    '',
    updates.length ? listing(updates, (declaration) => [
      `### ${text(declaration.package)}`,
      '',
      `Manifest: ${text(declaration.manifest)}; current spec: ${text(declaration.spec)}; locked: ${declaration.lockedVersions.map(text).join(', ') || 'unknown'}`,
      `Suggested version: ${text(declaration.updateCandidate.version)} (${text(declaration.updateCandidate.status)}; deprecation: ${text(declaration.updateCandidate.deprecationStatus)})`,
      `Caveats: ${declaration.caveats.map(text).join(' ')}`,
      '',
      'Before:',
      '',
      renderCodeBlock(dependencySnippet(declaration, declaration.spec), 'json'),
      '',
      'After (suggested; lock resolution pending selection):',
      '',
      renderCodeBlock(dependencySnippet(declaration, declaration.updateCandidate.version), 'json')
    ].join('\n')) : 'No newer stable nondeprecated direct-version candidates were established from the completed registry evidence.',
    '',
    '## Deprecated Dependencies Without A Direct Update Candidate',
    '',
    blockedDeprecations.length ? listing(blockedDeprecations, (declaration) => {
      const deprecatedVersions = result.registry.find((entry) => entry.name === declaration.package)?.lockedVersions
        .filter((version) => declaration.lockedVersions.includes(version.version) && version.deprecationStatus === 'deprecated')
        .map((version) => text(version.version)) ?? [];
      return `* ${text(declaration.package)} @ ${deprecatedVersions.join(', ') || 'unknown'} is explicitly deprecated; no newer stable nondeprecated direct-version candidate was established. A package replacement may require source/API migration and is not proposed automatically.`;
    }) :
      'None identified in completed direct-version metadata.',
    '',
    '## Lock-Recorded Occurrences',
    '',
    listing(inventory.occurrences, (entry) => `* ${text(entry.name)} @ ${text(entry.version)}; ` +
      `${text(entry.lock)}: ${text(entry.path)}; manifest: ${text(entry.manifest)}`),
    '',
    '## Registry Update And Deprecation Evidence',
    '',
    result.registry.length ? result.registry.map(renderRegistry).join('\n\n') : 'No registry lookups performed.',
    '',
    '## Published Advisory Evidence',
    '',
    result.advisories.length ? result.advisories.map(renderAdvisories).join('\n\n') : 'No exact-version advisory lookups performed.',
    '',
    '## Coverage Gaps',
    '',
    `Gaps recorded: ${result.gaps.length}`,
    listing(result.gaps, (gap) => `* ${text(gap.path ?? gap.name ?? gap.source)}: ${text(gap.reason)}`),
    '',
    '- [ ] Reviewed and validated by a qualified human reviewer',
    ''
  ].join('\n');
}

async function writeDependencyReport(reportDirectory, assessmentId, markdown, projectRoot, reportKind = 'dependencies') {
  if (!path.isAbsolute(reportDirectory ?? '') || !path.isAbsolute(projectRoot ?? '') ||
  !['dependencies', 'codebase-review'].includes(reportKind) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(assessmentId ?? '') ||
      isPathWithinRoot(projectRoot, reportDirectory)) throw new Error('External extension storage is required.');
  const parent = await fs.realpath(path.dirname(reportDirectory));
  const canonicalDirectory = path.join(parent, path.basename(reportDirectory));
  if (isPathWithinRoot(projectRoot, canonicalDirectory)) throw new Error('Storage cannot be in the input project.');
  await fs.mkdir(canonicalDirectory, { recursive: true });
  const directory = await fs.realpath(canonicalDirectory);
  if (isPathWithinRoot(projectRoot, directory)) throw new Error('Storage cannot alias the input project.');
  const reportPath = path.join(directory, `${reportKind}-${assessmentId}.md`);
  await fs.writeFile(reportPath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return reportPath;
}

module.exports = { dependencySnippet, renderDependencyReport, writeDependencyReport };
