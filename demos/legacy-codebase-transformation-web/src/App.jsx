import { useEffect, useRef, useState } from 'react';

const STEPS = [
  { id: 'upload', number: '01', title: 'Choose project' },
  { id: 'assessment', number: '02', title: 'Assess locally' },
  { id: 'review', number: '03', title: 'Review proposals' },
  { id: 'build', number: '04', title: 'Validate' },
  { id: 'export', number: '05', title: 'Export' }
];
const OMIT_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'coverage', 'generated', 'out', 'target']);
const MAX_SELECTED_UNITS = 5;
const UPDATE_LEVELS = ['patch', 'minor', 'major'];
const UPDATE_POLICIES = [
  { value: 'patch', label: 'Patch only' },
  { value: 'minor', label: 'Up to minor' },
  { value: 'major', label: 'Up to major' }
];

function policyCandidate(declaration, policy) {
  return (declaration.updateOptions ?? []).filter((option) => UPDATE_LEVELS.indexOf(option.level) <= UPDATE_LEVELS.indexOf(policy)).at(-1) ?? null;
}

function UpdateLevel({ level }) {
  return <span className={`update-level level-${level}`}>{level}</span>;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadableFiles(fileList) {
  const accepted = [];
  let excluded = 0;
  for (const file of fileList) {
    const relativePath = file.webkitRelativePath;
    const segments = relativePath.split('/');
    if (!relativePath || segments.some((segment) => segment.startsWith('.') || OMIT_DIRECTORIES.has(segment.toLowerCase()))) {
      excluded += 1;
      continue;
    }
    accepted.push(file);
  }
  return { files: accepted.sort((left, right) => left.webkitRelativePath.localeCompare(right.webkitRelativePath)), excluded };
}

async function readError(response) {
  const result = await response.json().catch(() => ({}));
  return result.error || `The request failed with status ${response.status}.`;
}

function unitCost(unit, assessment) {
  return unit.kind === 'file' ? assessment.units.filter((item) => item.kind === 'function' && item.path === unit.path).length : 1;
}

function DebtRating({ rating }) {
  return <span className={`debt-rating rating-${rating || 'unknown'}`}>{rating || '?'}</span>;
}

function DependencyEvidence({ assessment, inventory, selectedUpdates, onToggleUpdate, updatePolicy, onPolicyChange }) {
  const registry = assessment?.registry || [];
  const advisories = assessment?.advisories || [];
  const advisoryMatches = advisories.reduce((total, item) => total + item.matches.length, 0);
  const updatesAvailable = inventory.buildAvailable && inventory.buildScript &&
    registry.some((entry) => entry.declarations.some((item) => item.updateOptions?.length));
  return (
    <section className="dependency-evidence" aria-labelledby="dependency-title">
      <div className="evidence-heading">
        <div>
          <p className="eyebrow">DEPENDENCY REVIEW</p>
          <h3 id="dependency-title">{inventory.declarations.length} direct packages · {inventory.occurrences.length} locked packages</h3>
        </div>
        <span className={`evidence-status status-${assessment.status}`}>{assessment.status}</span>
      </div>
      <p className="evidence-note">Registry and OSV results are provider evidence, not compatibility guarantees. Package files remain unchanged until the staged build and project tests succeed.</p>
      {updatesAvailable && <label className="update-policy"><span>Allowed update level</span>
        <select value={updatePolicy} onChange={(event) => onPolicyChange(event.target.value)}>
          {UPDATE_POLICIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <small>Patch only is the default. Minor and major updates can change behaviour or APIs.</small></label>}
      <details className="evidence-details" open>
        <summary>Local package inventory</summary>
        <div className="evidence-list">
          {inventory.declarations.map((entry, index) => (
            <div className="evidence-row" key={`${entry.manifest}-${entry.name}-${index}`}>
              <strong>{entry.name}</strong><span>{entry.spec}</span>
              <small>{entry.groups.join(', ')} · locked {entry.lockedVersions.join(', ') || 'unknown'}</small>
            </div>
          ))}
          {!inventory.declarations.length && <p className="evidence-empty">No valid direct npm declarations found.</p>}
        </div>
      </details>
      {registry.length > 0 && (
        <details className="evidence-details" open>
          <summary>Registry evidence · {registry.length} package names</summary>
          <div className="evidence-list">
            {registry.map((entry) => (
              <div className="evidence-row" key={entry.name}>
                <strong>{entry.name}</strong><span>{entry.status}</span>
                <small>Latest tag: {entry.latest?.version || 'unknown'} · latest stable nondeprecated: {entry.latestStable?.version || 'unknown'}</small>
                {entry.lockedVersions.filter((version) => version.deprecated).map((version) => (
                  <small className="evidence-warning" key={`${entry.name}-${version.version}`}>{version.version} is deprecated: {version.deprecated}</small>
                ))}
                {updatesAvailable && entry.declarations.some((item) => item.updateOptions?.length) && (
                  <div className="update-candidates">
                    {entry.declarations.filter((item) => item.updateOptions?.length).map((declaration) => {
                      const candidate = policyCandidate(declaration, updatePolicy);
                      const higher = declaration.updateOptions.filter((option) => UPDATE_LEVELS.indexOf(option.level) > UPDATE_LEVELS.indexOf(updatePolicy));
                      return <div key={`${entry.name}-${declaration.manifest}`}>
                        {candidate && <label className="update-choice">
                          <input type="checkbox" checked={selectedUpdates.has(entry.name)} onChange={() => onToggleUpdate(entry.name)} />
                          <span className="checkmark" aria-hidden="true" />
                          <span><strong>Update {entry.name} <UpdateLevel level={candidate.level} /></strong><small>{declaration.lockedVersions.join(', ') || 'unknown'} to {candidate.version}; build and project tests required</small>
                            {candidate.migrationGuide && <small className="migration-support">Source migration supported ({candidate.migrationGuide}): if checks fail, you can approve Foundry-proposed code changes.</small>}</span>
                        </label>}
                        {higher.length > 0 && <small className="update-blocked">{higher.map((option) => `${option.level} ${option.version}${option.migrationGuide ? ' (source migration supported)' : ''}`).join(' · ')} available. Raise the allowed level to select it.</small>}
                      </div>;
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      {advisories.length > 0 && (
        <details className="evidence-details">
          <summary>OSV evidence · {advisoryMatches} matches</summary>
          <div className="evidence-list">
            {advisories.map((entry) => (
              <div className="evidence-row" key={`${entry.name}@${entry.version}`}>
                <strong>{entry.name} @ {entry.version}</strong>
                {!entry.matches.length && <span>{entry.status === 'completed' ? 'No advisory returned' : entry.status}</span>}
                {entry.matches.map((match) => <small className="evidence-warning" key={match.id}>{match.id}{match.summary ? ` · ${match.summary}` : ''}</small>)}
              </div>
            ))}
          </div>
        </details>
      )}
      {assessment.gaps?.length > 0 && <p className="local-note">{assessment.gaps.length} dependency coverage gaps are included in the report.</p>}
      {(!inventory.buildAvailable || !inventory.buildScript) && <p className="local-note">Dependency updates are unavailable without a supported root npm lockfile and build script.</p>}
    </section>
  );
}

function GateList({ gates = [] }) {
  return (
    <ul className="gate-list">
      {gates.map((item) => <li className={`gate-${item.status}`} key={item.id}><strong>{item.status}</strong><span>{item.id}</span><small>{item.message}</small></li>)}
    </ul>
  );
}

function findingLocation(item) {
  if (!item.line) return 'Whole unit';
  return item.column ? `Line ${item.line}:${item.column}` : `Line ${item.line}`;
}

function NumberedSource({ unit, approvedFindings, activeLine, onSelectLine }) {
  const containerRef = useRef(null);
  const byLine = new Map();
  for (const item of unit.findings) {
    if (item.line) byLine.set(item.line, [...(byLine.get(item.line) ?? []), item]);
  }
  useEffect(() => {
    const container = containerRef.current;
    const row = container?.querySelector(`[data-line="${activeLine}"]`);
    if (row) container.scrollTop = row.offsetTop - container.clientHeight / 2;
  }, [activeLine, unit.id]);
  return (
    <div className="source-preview numbered-source" ref={containerRef} role="region" aria-label={`${unit.name} source with line numbers`} tabIndex={0}>
      {unit.originalText.split(/\r?\n/).map((text, index) => {
        const line = unit.startLine + index;
        const flagged = byLine.get(line) ?? [];
        const approved = flagged.some((item) => approvedFindings.has(item.id));
        return (
          <div key={line} data-line={line}
            className={`source-line ${flagged.length ? approved ? 'is-flagged' : 'is-flagged-skipped' : ''} ${activeLine === line ? 'is-active' : ''}`}
            onClick={flagged.length ? () => onSelectLine(line) : undefined}
            title={flagged.length ? flagged.map((item) => `${item.ruleId}: ${item.message}`).join('\n') : undefined}>
            <span className="line-number" aria-hidden="true">{line}</span>
            <code>{text || ' '}</code>
            {flagged.length > 0 && <span className="line-flag">{flagged.length}</span>}
          </div>
        );
      })}
    </div>
  );
}

function lineDiff(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  const lengths = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const leftChanged = new Array(a.length).fill(true);
  const rightChanged = new Array(b.length).fill(true);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { leftChanged[i] = false; rightChanged[j] = false; i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) i += 1;
    else j += 1;
  }
  return { left: a.map((text, index) => ({ text, changed: leftChanged[index] })), right: b.map((text, index) => ({ text, changed: rightChanged[index] })) };
}

function DiffPre({ lines, kind }) {
  const ref = useRef(null);
  const content = lines.map((line) => `${line.changed ? '!' : ' '}${line.text}`).join('\n');
  useEffect(() => {
    const first = ref.current?.querySelector('.diff-line.is-changed');
    if (first) ref.current.scrollTop = first.offsetTop - ref.current.clientHeight / 3;
  }, [content]);
  return (
    <pre ref={ref} className="diff-pre">
      {lines.map((line, index) => (
        <span key={index} className={`diff-line ${line.changed ? `is-changed diff-${kind}` : ''}`}>{line.text || ' '}</span>
      ))}
    </pre>
  );
}

function BaselineTable({ proposal }) {
  const cases = proposal.baseline?.status === 'passed' ? proposal.baseline.cases || [] : [];
  const results = new Map((proposal.comparison?.cases || []).map((item) => [item.description, item]));
  const firstFailure = cases.findIndex((item) => results.get(item.description)?.passed === false);
  const [active, setActive] = useState(Math.max(firstFailure, 0));
  const tabRefs = useRef([]);
  if (proposal.baseline?.status !== 'passed') {
    return <p className="local-note">Characterisation not checked: {proposal.baseline?.reason || 'no stable baseline was available.'}</p>;
  }
  const tabCount = cases.length + (proposal.testPreview ? 1 : 0);
  const statusOf = (item) => {
    const result = results.get(item.description);
    return result ? result.passed ? 'PASS' : 'FAIL' : 'NOT RUN';
  };
  const selectTab = (index) => {
    const next = (index + tabCount) % tabCount;
    setActive(next);
    tabRefs.current[next]?.focus();
  };
  const onKeyDown = (event) => {
    const moves = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: tabCount - 1 };
    if (event.key in moves) { event.preventDefault(); selectTab(moves[event.key]); }
  };
  const passed = cases.filter((item) => statusOf(item) === 'PASS').length;
  const current = cases[active];
  const currentResult = current && results.get(current.description);
  const idBase = `case-${proposal.id}`;
  return (
    <div className="baseline-list">
      <p className="local-note">Each case calls the original function in an isolated Node process (run twice to confirm it is stable), then calls the rewrite with the same input and compares the result. {results.size ? `${passed} of ${cases.length} cases match.` : ''}</p>
      {proposal.comparison?.status === 'not-checked' && <p className="local-note">Case comparison was not run: {proposal.comparison.reason || 'a static gate blocked it.'}</p>}
      <div className="case-tabs" role="tablist" aria-label={`Characterisation cases for ${proposal.name}`} onKeyDown={onKeyDown}>
        {cases.map((item, index) => {
          const caseStatus = statusOf(item);
          return (
            <button type="button" role="tab" key={`${item.description}-${index}`} id={`${idBase}-tab-${index}`}
              ref={(node) => { tabRefs.current[index] = node; }} aria-selected={index === active} aria-controls={`${idBase}-panel`}
              tabIndex={index === active ? 0 : -1} className={`case-tab ${index === active ? 'is-active' : ''}`} onClick={() => setActive(index)}>
              <span className={caseStatus === 'PASS' ? 'case-pass' : caseStatus === 'FAIL' ? 'case-fail' : 'case-not-run'}>{caseStatus}</span>
              <span>Case {index + 1}</span>
            </button>
          );
        })}
        {proposal.testPreview && (
          <button type="button" role="tab" id={`${idBase}-tab-${cases.length}`} ref={(node) => { tabRefs.current[cases.length] = node; }}
            aria-selected={active === cases.length} aria-controls={`${idBase}-panel`} tabIndex={active === cases.length ? 0 : -1}
            className={`case-tab ${active === cases.length ? 'is-active' : ''}`} onClick={() => setActive(cases.length)}>
            <span>Test file</span>
          </button>
        )}
      </div>
      {active === cases.length && proposal.testPreview && (
        <div className="case-panel" role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${cases.length}`}>
          <p className="case-description">Exported as <code>{proposal.testPreview.path}</code> when this proposal is applied. Run it with <code>node --test</code> to replay these cases against your code.</p>
          <pre className="test-preview">{proposal.testPreview.content}</pre>
        </div>
      )}
      {current && (
        <div className="case-panel" role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${active}`}>
          <p className="case-description">{current.description}</p>
          {currentResult?.differences?.length > 0 && <div className="case-differences" role="note">
            <span>DIFFERENCES</span>
            <ul>{currentResult.differences.map((item) => (
              <li key={item.path}><code>{item.path}</code> expected <code>{JSON.stringify(item.expected)}</code>, got <code>{JSON.stringify(item.actual)}</code></li>
            ))}</ul>
          </div>}
          <div className="baseline-values">
            <div><span>INPUT</span><pre>{JSON.stringify(current.args, null, 2)}</pre></div>
            {currentResult && !currentResult.passed ? (() => {
              const diff = lineDiff(JSON.stringify(current.expected, null, 2), JSON.stringify(currentResult.actual, null, 2));
              return <>
                <div><span>EXPECTED (ORIGINAL)</span><DiffPre lines={diff.left} kind="removed" /></div>
                <div><span>ACTUAL (REWRITE)</span><DiffPre lines={diff.right} kind="added" /></div>
              </>;
            })() : <>
              <div><span>EXPECTED (ORIGINAL)</span><pre>{JSON.stringify(current.expected, null, 2)}</pre></div>
              <div><span>ACTUAL (REWRITE)</span><pre>{JSON.stringify(currentResult?.actual ?? 'No comparison result', null, 2)}</pre></div>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

const PROGRESS_LABELS = {
  starting: 'Starting',
  'dependency-assessment': 'Checking dependencies',
  'unit-start': 'Preparing',
  inputs: 'Generating test inputs for',
  baseline: 'Capturing baseline for',
  rewrite: 'Requesting rewrite for',
  comparison: 'Replaying cases against rewrite of',
  'unit-complete': 'Finished',
  complete: 'Finishing up'
};

function progressLabel(progress, units) {
  const label = PROGRESS_LABELS[progress?.stage] ?? 'Working';
  const unit = units.find((item) => item.id === progress?.unitId);
  const target = unit && /(for|of)$/.test(label) ? ` ${unit.name}` : '';
  const retry = progress?.attempt > 1 ? ' (retry)' : '';
  const caseText = progress?.case ? ` · case ${progress.case}` : '';
  return `${label}${target}${retry}${caseText}`;
}

function AcknowledgeDialog({ proposals, onConfirm, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={ref} className="overlap-dialog ack-dialog" aria-labelledby="ack-dialog-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <p className="eyebrow">ACKNOWLEDGEMENT REQUIRED</p>
      <h2 id="ack-dialog-title">Behaviour was not checked for {proposals.length === 1 ? 'this change' : 'these changes'}</h2>
      <p>No characterisation cases ran for the selected proposals below, so nothing confirmed that the rewrite returns the same results as the original. Static gates still passed. Acknowledge to apply them anyway, or go back and review.</p>
      <ul className="ack-list">{proposals.map((proposal) => (
        <li key={proposal.id}><strong>{proposal.name}</strong> <span>{proposal.path}</span>
          <small>{proposal.baseline?.reason || proposal.comparison?.reason || 'Characterisation was not run.'}</small></li>
      ))}</ul>
      <div className="ack-actions">
        <button className="button button-quiet" type="button" onClick={onCancel}>Go back</button>
        <button className="button button-primary" type="button" onClick={onConfirm}>Acknowledge and continue</button>
      </div>
    </dialog>
  );
}

function ChangeReport({ report }) {
  return (
    <section className="change-report" aria-labelledby="change-report-title">
      <p className="eyebrow">CODE TRANSFORMATION REPORT</p>
      <h3 id="change-report-title">Assessment delta</h3>
      <div className="report-rating-row">
        <span><DebtRating rating={report.before?.rating} /> {report.before?.debtMinutes ?? 0} min before</span>
        <span aria-hidden="true">to</span>
        <span><DebtRating rating={report.after?.rating} /> {report.after?.debtMinutes ?? 0} min after</span>
      </div>
      <ul className="report-summary">
        <li>{report.sourceChanges.length} source units</li>
        <li>{report.packageChanges.length} package updates</li>
        <li>Build: {report.build?.status || 'not run'}</li>
        <li>Project tests: {report.build?.tests?.status || 'not run'}</li>
        {report.build?.characterisation && <li>Characterisation after update: {report.build.characterisation.status}{report.build.characterisation.results.map((item) => ` · ${item.name} ${item.matched}/${item.total}`).join('')}</li>}
        <li>{report.tests}</li>
      </ul>
      {report.testFiles?.length > 0 && <div className="report-test-files">
        <p className="eyebrow">CHARACTERISATION TESTS IN THE ZIP</p>
        <ul>{report.testFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        <p className="local-note">Run them from the project folder with <code>node --test __characterisation__</code>.</p>
      </div>}
      {report.sourceChanges.map((change) => (
        <details className="report-item" key={change.id}>
          <summary>{change.path} · {change.symbol} · {change.category}</summary>
          <p className="finding-rationale">{change.rationale}</p>
          <div className="change-columns">
            <div><span>BEFORE</span><pre>{change.before}</pre></div>
            <div><span>AFTER</span><pre>{change.after}</pre></div>
          </div>
          <GateList gates={change.gates} />
        </details>
      ))}
      {report.packageChanges.length > 0 && <div className="report-test-files">
        <p className="eyebrow">DEPENDENCY UPDATES · BEHAVIOR COMPATIBILITY</p>
        <ul>
          <li>Code changes needed for dependency compatibility: {report.migration?.edits.length ? 'Yes' : 'No, not for the checks that ran'}</li>
          <li>Compatibility code changes applied: {report.migration?.edits.length ? `${report.migration.edits.length} migration edit(s)` : 'None'}</li>
        </ul>
      </div>}
      {report.packageChanges.map((item) => <p className="report-item" key={item.name}>{item.name}: {item.fromVersion} to {item.version}{item.level && <> <UpdateLevel level={item.level} /></>}</p>)}
      {report.migration?.edits.map((edit) => (
        <details className="report-item" key={edit.path} open>
          <summary>Dependency migration · {edit.path}</summary>
          <p className="finding-rationale">{edit.rationale}</p>
          <div className="change-columns"><div><span>BEFORE</span><pre>{edit.before}</pre></div><div><span>AFTER</span><pre>{edit.after}</pre></div></div>
        </details>
      ))}
      {report.build && <details className="report-item"><summary>Build output</summary><pre className="report-output">{report.build.output || 'No output.'}</pre></details>}
    </section>
  );
}

export default function App() {
  const inputRef = useRef(null);
  const [stage, setStage] = useState('upload');
  const [connection, setConnection] = useState({ loading: true, configured: false, model: 'gpt-4.1-mini' });
  const [folder, setFolder] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const [review, setReview] = useState(null);
  const [selectedUnits, setSelectedUnits] = useState(new Set());
  const [approvedFindings, setApprovedFindings] = useState(new Set());
  const [checkDependencies, setCheckDependencies] = useState(false);
  const [ackPrompt, setAckPrompt] = useState(null);
  const [activeLine, setActiveLine] = useState(null);
  const [focusedUnitId, setFocusedUnitId] = useState(null);
  const [selectedProposals, setSelectedProposals] = useState(new Set());
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState(new Set());
  const [selectedUpdates, setSelectedUpdates] = useState(new Set());
  const [updatePolicy, setUpdatePolicy] = useState('patch');
  const [migration, setMigration] = useState(null);
  const [progress, setProgress] = useState(null);
  const [updatePreview, setUpdatePreview] = useState(null);
  const [buildResult, setBuildResult] = useState(null);
  const [buildAcknowledged, setBuildAcknowledged] = useState(false);
  const [applied, setApplied] = useState(null);
  const [editorFolder, setEditorFolder] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/status').then((response) => response.json())
      .then((status) => setConnection({ loading: false, ...status }))
      .catch(() => setConnection({ loading: false, configured: false, model: 'gpt-4.1-mini' }));
  }, []);

  useEffect(() => { setActiveLine(null); }, [focusedUnitId]);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [stage]);

  useEffect(() => {
    if (busy !== 'transform' || !prepared?.sessionId) return undefined;
    let active = true;
    const timer = setInterval(() => {
      fetch(`/api/sessions/${prepared.sessionId}/progress`).then((response) => response.ok ? response.json() : null)
        .then((value) => { if (active && value) setProgress(value); })
        .catch(() => {});
    }, 700);
    return () => { active = false; clearInterval(timer); };
  }, [busy, prepared?.sessionId]);

  function selectFolder(event) {
    const { files, excluded } = uploadableFiles(event.target.files || []);
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const firstPath = files[0]?.webkitRelativePath || '';
    const folderName = firstPath.split('/')[0] || '';
    if (!files.length) {
      setFolder(null);
      setError('Choose a folder containing files.');
    } else if (files.some((file) => !file.webkitRelativePath.startsWith(`${folderName}/`))) {
      setFolder(null);
      setError('Choose files from one folder at a time.');
    } else if (files.length > 500 || totalBytes > 25 * 1024 * 1024) {
      setFolder(null);
      setError('This demo accepts up to 500 files and 25 MB per review.');
    } else {
      setFolder({ files, excluded, totalBytes, name: folderName });
      setError('');
    }
  }

  async function prepareFolder() {
    if (!folder) return;
    setBusy('prepare');
    setError('');
    try {
      const form = new FormData();
      const manifest = folder.files.map((file, index) => ({ id: `file-${index}`, path: file.webkitRelativePath, size: file.size }));
      form.append('manifest', JSON.stringify(manifest));
      folder.files.forEach((file, index) => form.append('files', file, `file-${index}`));
      const response = await fetch('/api/analyze/prepare', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      setPrepared(result);
      setSelectedUnits(new Set());
      setApprovedFindings(new Set());
      setActiveLine(null);
      const firstVisibleUnit = result.assessment.files.flatMap((file) => file.units)
        .find((unit) => unit.findings.length > 0);
      setFocusedUnitId(firstVisibleUnit?.id ?? result.assessment.units[0]?.id ?? null);
      setStage('assessment');
    } catch (requestError) {
      setError(requestError.message || 'The project could not be assessed.');
    } finally {
      setBusy('');
    }
  }

  function fitsSelection(unit) {
    const selectedCost = [...selectedUnits].reduce((total, id) => total + unitCost(prepared.assessment.units.find((item) => item.id === id), prepared.assessment), 0);
    if (selectedCost + unitCost(unit, prepared.assessment) > MAX_SELECTED_UNITS) {
      setError(`A transformation run is limited to ${MAX_SELECTED_UNITS} function or statement units.`);
      return false;
    }
    return true;
  }

  function applyUnitFindings(unit, nextFindings) {
    const anyApproved = unit.findings.some((item) => nextFindings.has(item.id));
    const isSelected = selectedUnits.has(unit.id);
    if (anyApproved && !isSelected && !fitsSelection(unit)) return;
    const nextUnits = new Set(selectedUnits);
    if (anyApproved) nextUnits.add(unit.id); else nextUnits.delete(unit.id);
    setSelectedUnits(nextUnits);
    setApprovedFindings(nextFindings);
    setError('');
  }

  function toggleUnit(unit) {
    if (!prepared || busy) return;
    const next = new Set(approvedFindings);
    const approve = !selectedUnits.has(unit.id);
    for (const item of unit.findings) { if (approve) next.add(item.id); else next.delete(item.id); }
    applyUnitFindings(unit, next);
    setFocusedUnitId(unit.id);
  }

  function toggleFinding(unit, findingId) {
    if (!prepared || busy) return;
    const next = new Set(approvedFindings);
    if (next.has(findingId)) next.delete(findingId); else next.add(findingId);
    applyUnitFindings(unit, next);
  }

  function setAllFindings(unit, approve) {
    if (!prepared || busy) return;
    const next = new Set(approvedFindings);
    for (const item of unit.findings) { if (approve) next.add(item.id); else next.delete(item.id); }
    applyUnitFindings(unit, next);
  }

  async function confirmTransformation() {
    if (!prepared || !selectedUnits.size || !connection.configured) return;
    setBusy('transform');
    setProgress({ stage: 'starting', completed: 0, total: selectedUnits.size, unitId: null });
    setError('');
    try {
      const response = await fetch(`/api/sessions/${prepared.sessionId}/transform`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitIds: [...selectedUnits], findingIds: [...approvedFindings], checkDependencies, approved: true })
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      setReview(result);
      setSelectedProposals(new Set());
      setAcknowledgedWarnings(new Set());
      setSelectedUpdates(new Set());
      setStage('review');
    } catch (requestError) {
      setError(requestError.message || 'The approved analysis could not be completed.');
    } finally {
      setBusy('');
    }
  }

  function toggleProposal(proposal) {
    const next = new Set(selectedProposals);
    if (next.has(proposal.id)) {
      next.delete(proposal.id);
      const warnings = new Set(acknowledgedWarnings);
      warnings.delete(proposal.id);
      setAcknowledgedWarnings(warnings);
    } else next.add(proposal.id);
    setSelectedProposals(next);
  }

  function toggleWarning(id) {
    setAcknowledgedWarnings((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleUpdate(name) {
    setSelectedUpdates((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function changeUpdatePolicy(policy) {
    setUpdatePolicy(policy);
    setSelectedUpdates(new Set());
  }

  function selectedUpdatePayload() {
    const rootManifest = review.dependencyAssessment.inventory.rootManifest;
    return [...selectedUpdates].map((name) => {
      const declaration = review.dependencyAssessment.registry.find((entry) => entry.name === name)?.declarations
        .find((item) => item.manifest === rootManifest && item.updateOptions?.length);
      return { name, level: policyCandidate(declaration ?? {}, updatePolicy)?.level };
    });
  }

  async function applySelected(acks = acknowledgedWarnings) {
    if (!review) return;
    const missing = review.proposals.filter((proposal) => selectedProposals.has(proposal.id) &&
      proposal.warningAcknowledgementRequired && !acks.has(proposal.id));
    if (missing.length) { setAckPrompt(missing); return; }
    setBusy(selectedUpdates.size ? 'update-prepare' : 'apply');
    setError('');
    try {
      if (selectedUpdates.size) {
        const response = await fetch(`/api/sessions/${review.sessionId}/updates/prepare`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvedProposalIds: [...selectedProposals], acknowledgedWarnings: [...acks], selectedUpdates: selectedUpdatePayload() })
        });
        if (!response.ok) throw new Error(await readError(response));
        setUpdatePreview(await response.json());
        setBuildAcknowledged(false);
        setBuildResult(null);
        setMigration(null);
        setStage('build');
      } else {
        const response = await fetch(`/api/sessions/${review.sessionId}/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvedProposalIds: [...selectedProposals], acknowledgedWarnings: [...acks] })
        });
        if (!response.ok) throw new Error(await readError(response));
        setApplied(await response.json());
        setStage('export');
      }
    } catch (requestError) {
      setError(requestError.message || 'The selected changes could not be staged.');
    } finally {
      setBusy('');
    }
  }

  async function runStagedBuild() {
    if (!review || !updatePreview || !buildAcknowledged || buildResult) return;
    setBusy('build');
    setError('');
    try {
      const response = await fetch(`/api/sessions/${review.sessionId}/updates/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId: updatePreview.previewId, acknowledgedBuild: true })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `The build request failed with status ${response.status}.`);
      if (result.status !== 'passed') { setBuildResult(result); return; }
      setApplied({ ...result.summary, report: result.report });
      setStage('export');
    } catch (requestError) {
      setError(requestError.message || 'The staged build could not be completed.');
    } finally {
      setBusy('');
    }
  }

  async function proposeMigration() {
    if (!review || !buildResult?.migrationId || busy) return;
    setBusy('migrate');
    setError('');
    try {
      const response = await fetch(`/api/sessions/${review.sessionId}/updates/migrate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ migrationId: buildResult.migrationId, approved: true })
      });
      if (!response.ok) throw new Error(await readError(response));
      setMigration(await response.json());
    } catch (requestError) {
      setError(requestError.message || 'The dependency migration could not be proposed.');
      setBuildResult((current) => current && { ...current, migrationAvailable: false });
    } finally {
      setBusy('');
    }
  }

  async function acceptMigration() {
    if (!review || migration?.status !== 'ready' || busy) return;
    setBusy('migrate-accept');
    setError('');
    try {
      const response = await fetch(`/api/sessions/${review.sessionId}/updates/migrate/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ migrationId: migration.migrationId })
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      setApplied({ ...result.summary, report: result.report });
      setStage('export');
    } catch (requestError) {
      setError(requestError.message || 'The migration could not be staged.');
    } finally {
      setBusy('');
    }
  }

  async function openOutputInVscode() {
    if (!review || busy) return;
    setBusy('editor');
    setError('');
    setEditorFolder('');
    try {
      const response = await fetch(`/api/sessions/${review.sessionId}/open-in-vscode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true })
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      setEditorFolder(result.folder);
    } catch (requestError) {
      setError(requestError.message || 'Could not open VS Code. Download the ZIP instead.');
    } finally {
      setBusy('');
    }
  }

  function resetReview() {
    const sessionId = review?.sessionId || prepared?.sessionId;
    if (sessionId) fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    setFolder(null); setPrepared(null); setReview(null); setSelectedUnits(new Set()); setApprovedFindings(new Set()); setCheckDependencies(false); setActiveLine(null); setFocusedUnitId(null);
    setSelectedProposals(new Set()); setAcknowledgedWarnings(new Set()); setSelectedUpdates(new Set());
    setProgress(null); setUpdatePreview(null); setBuildResult(null); setBuildAcknowledged(false); setApplied(null);
    setUpdatePolicy('patch'); setMigration(null);
    setEditorFolder('');
    setStage('upload'); setError('');
    if (inputRef.current) inputRef.current.value = '';
  }

  const activeStep = STEPS.findIndex((item) => item.id === stage);
  const assessment = prepared?.assessment;
  const dependencyInventory = prepared?.dependencyPreview;
  const hotFiles = assessment?.files.map((file) => ({ ...file, units: file.units.filter((unit) => unit.findings.length > 0) })).filter((file) => file.units.length) ?? [];
  const focusedUnit = assessment?.units.find((unit) => unit.id === focusedUnitId) ?? null;
  const selectedUnitCount = [...selectedUnits].reduce((total, id) => total + unitCost(assessment.units.find((item) => item.id === id), assessment), 0);
  const selectedProposalList = review?.proposals.filter((proposal) => selectedProposals.has(proposal.id)) ?? [];
  const dependencyLookupsAvailable = Boolean(dependencyInventory?.registryNames.length || dependencyInventory?.advisoryTuples.length);
  const canApply = selectedProposals.size > 0 || selectedUpdates.size > 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Legacy code transformer home">
          <span className="wordmark-mark">LC</span><span>LEGACY CODE <b>/</b> TRANSFORMER</span>
        </a>
        <div className={`model-status ${connection.configured ? 'is-ready' : 'is-missing'}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>{connection.loading ? 'Checking Foundry' : !connection.configured ? 'Foundry not configured'
            : connection.rewriteModel && connection.rewriteModel !== connection.model
              ? `${connection.model} · rewrite ${connection.rewriteModel}` : connection.model}</span>
        </div>
      </header>

      <main id="top">
        <section className="tool-heading">
          <div>
            <p className="eyebrow">LOCAL CODE REVIEW · APPROVAL-GATED TRANSFORMATION</p>
            <h1>Legacy code transformer</h1>
          </div>
          <nav className="stepper" aria-label="Workflow stages">
            {STEPS.map((item, index) => <div className={`step ${index === activeStep ? 'active' : index < activeStep ? 'complete' : ''}`} key={item.id}>
              <span>{item.number}</span><strong>{item.title}</strong>
            </div>)}
          </nav>
        </section>

        {error && <p className="alert" role="alert">{error}</p>}

        {stage === 'upload' && (
          <section className="upload-workspace" aria-labelledby="upload-title">
            <div className="upload-panel">
              <p className="eyebrow">PROJECT FOLDER</p>
              <h2 id="upload-title">Choose a codebase to transform</h2>
              <button className="folder-picker" type="button" onClick={() => inputRef.current?.click()} disabled={busy !== ''}>
                <span className="picker-symbol" aria-hidden="true">+</span>
                <span className="picker-text"><strong>{folder?.name || 'Select folder'}</strong>
                  <small>{folder ? `${folder.files.length} files · ${formatBytes(folder.totalBytes)}` : 'JavaScript and JSX files are assessed locally'}</small></span>
                <span className="picker-arrow" aria-hidden="true">↗</span>
              </button>
              <input ref={inputRef} className="visually-hidden" type="file" webkitdirectory="" directory="" multiple onChange={selectFolder} aria-label="Select project folder" />
              {folder && <p className="upload-meta">{folder.files.length} files · {folder.excluded} hidden/generated folders excluded · {formatBytes(folder.totalBytes)}</p>}
              <div className="upload-footer">
                <button className="button button-primary" type="button" onClick={prepareFolder} disabled={!folder || busy !== ''}>
                  {busy === 'prepare' ? <><Spinner />Assessing...</> : 'Run assessment'}
                </button>
              </div>
              {busy === 'prepare' && <p className="busy-note" role="status"><Spinner />Parsing source and calculating debt metrics. No code is sent or executed.</p>}
            </div>
            <aside className="local-boundaries">
              <p className="eyebrow">LOCAL FIRST</p>
              <p>Assessment parses source only. It makes no network requests, runs no project code, and needs no approval.</p>
              <p>Foundry, npm/OSV, dependency installation, and function execution start only after you select units and approve the combined review.</p>
            </aside>
          </section>
        )}

        {stage === 'assessment' && prepared && assessment && (
          <>
            <section className="assessment-summary" aria-label="Technical debt summary">
              <div className="rating-block"><DebtRating rating={assessment.rating} /><div><span className="eyebrow">PROJECT RATING</span><strong>{assessment.debtHours}h estimated debt</strong></div></div>
              <div className="summary-metric"><strong>{assessment.findingCount}</strong><span>findings</span></div>
              <div className="summary-metric"><strong>{assessment.loc.toLocaleString()}</strong><span>lines of code</span></div>
              <div className="summary-metric"><strong>{assessment.files.length}</strong><span>source files</span></div>
              <button className="button button-quiet" type="button" onClick={resetReview}>Choose another folder</button>
            </section>

            <section className="assessment-layout" aria-label="Assessment findings">
              <div className="hotspot-pane">
                <div className="pane-heading"><div><p className="eyebrow">HOTSPOTS</p><h2>Prioritize by estimated debt</h2></div><span>{selectedUnitCount} selected · max {MAX_SELECTED_UNITS} units</span></div>
                {assessment.gaps.length > 0 && <p className="local-note">{assessment.gaps.length} files could not be parsed; they are excluded from the rating.</p>}
                {hotFiles.length ? hotFiles.map((file) => (
                  <section className="hotspot-file" key={file.path}>
                    <div className="hotspot-file-heading"><strong>{file.path}</strong><span><DebtRating rating={assessment.fileScores?.find((item) => item.path === file.path)?.rating} /> {file.findings.length} findings</span></div>
                    {file.units.map((unit) => {
                      const cost = unitCost(unit, assessment);
                      return <label className={`hotspot-row ${focusedUnitId === unit.id ? 'is-focused' : ''}`} key={unit.id}>
                        <input type="checkbox" checked={selectedUnits.has(unit.id)} onChange={() => toggleUnit(unit)} disabled={busy !== ''} />
                        <span className="checkmark" aria-hidden="true" />
                        <span className="hotspot-unit" onClick={() => setFocusedUnitId(unit.id)}>
                          <strong>{unit.name}</strong><small>{unit.kind} · {unit.startLine}-{unit.endLine} · {cost} unit{cost === 1 ? '' : 's'} · {unit.findings.map((item) => item.ruleId).join(', ')}</small>
                        </span>
                      </label>;
                    })}
                  </section>
                )) : <p className="empty-review">No configured code-smell thresholds were crossed.</p>}
              </div>
              <aside className="unit-detail-pane">
                <p className="eyebrow">LOCAL DETAIL</p>
                {focusedUnit ? <>
                  <h2>{focusedUnit.name}</h2>
                  <p className="detail-location">{focusedUnit.path} · lines {focusedUnit.startLine}-{focusedUnit.endLine}</p>
                  <div className="metric-chips">{Object.entries(focusedUnit.metrics || {}).map(([key, value]) => <span key={key}>{key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} <strong>{value}</strong></span>)}</div>
                  <div className="finding-toolbar">
                    <span>{focusedUnit.findings.filter((item) => approvedFindings.has(item.id)).length} of {focusedUnit.findings.length} findings approved for transformation</span>
                    <div>
                      <button className="button button-quiet button-small" type="button" onClick={() => setAllFindings(focusedUnit, true)}
                        disabled={busy !== '' || focusedUnit.findings.every((item) => approvedFindings.has(item.id))}>Select all</button>
                      <button className="button button-quiet button-small" type="button" onClick={() => setAllFindings(focusedUnit, false)}
                        disabled={busy !== '' || !focusedUnit.findings.some((item) => approvedFindings.has(item.id))}>Clear all</button>
                    </div>
                  </div>
                  <ul className="unit-findings">{focusedUnit.findings.map((item) => (
                    <li key={item.id} className={item.line && activeLine === item.line ? 'is-active' : ''}>
                      <label className="finding-approve">
                        <input type="checkbox" checked={approvedFindings.has(item.id)} onChange={() => toggleFinding(focusedUnit, item.id)} disabled={busy !== ''}
                          aria-label={`Approve ${item.ruleId} at ${findingLocation(item)}`} />
                        <span className="checkmark" aria-hidden="true" />
                      </label>
                      <strong>{item.severity}</strong>
                      <span>{item.ruleId}</span>
                      <button type="button" className="finding-location" onClick={() => setActiveLine(item.line)} disabled={!item.line}>{findingLocation(item)}</button>
                      <small>{item.message}</small>
                    </li>
                  ))}</ul>
                  <NumberedSource unit={focusedUnit} approvedFindings={approvedFindings} activeLine={activeLine} onSelectLine={setActiveLine} />
                </> : <p className="empty-review">Select a hotspot to inspect its local source and metrics.</p>}
              </aside>
            </section>

            <section className="approval-band" aria-labelledby="approval-title">
              <div className="approval-heading"><div><p className="eyebrow">COMBINED APPROVAL</p><h2 id="approval-title">Review only the units you selected</h2></div>
                <span>{selectedUnits.size} selected spans · {selectedUnitCount} function/statement units · {assessment.units.filter((unit) => selectedUnits.has(unit.id)).reduce((total, unit) => total + unit.findings.filter((item) => approvedFindings.has(item.id)).length, 0)} approved findings</span></div>
              {dependencyLookupsAvailable && <label className="build-acknowledgement dependency-toggle">
                <input type="checkbox" checked={checkDependencies} onChange={(event) => setCheckDependencies(event.target.checked)} disabled={busy !== ''} />
                <span className="checkmark" aria-hidden="true" />
                <span>Also check npm dependencies. Sends the package names and versions below to npm Registry and OSV, lists update candidates, and enables the dependency update and validate stage. Leave unticked for a source-only run.</span>
              </label>}
              <div className="approval-disclosures">
                <p><strong>Foundry</strong><span>{[...selectedUnits].map((id) => assessment.units.find((unit) => unit.id === id)).filter(Boolean).map((unit) => `${unit.path} · ${unit.name}`).join('; ') || 'No source selected'}</span></p>
                <p><strong>npm / OSV</strong><span>{!dependencyLookupsAvailable ? 'No npm metadata lookup is available' : checkDependencies ? `${dependencyInventory.registryNames.length} Registry package names · ${dependencyInventory.advisoryTuples.length} exact version tuples` : 'Skipped: dependency checks are off'}</span></p>
                <p><strong>Local execution</strong><span>Selected functions run in a temporary copy; npm uses `ci --ignore-scripts`. Node limits filesystem access but does not block network access.</span></p>
              </div>
              {checkDependencies && dependencyInventory.documents.length > 0 && <details className="disclosure-details"><summary>Show package identifiers before approval</summary>
                <div className="identifier-lists"><div><span className="identifier-heading">NPM REGISTRY</span><ul>{dependencyInventory.registryNames.map((name) => <li key={name}>{name}</li>)}</ul></div>
                  <div><span className="identifier-heading">OSV LOCKED TUPLES</span><ul>{dependencyInventory.advisoryTuples.map((item) => <li key={`${item.name}@${item.version}`}>{item.name} @ {item.version}</li>)}</ul></div></div>
              </details>}
              {!connection.configured && !connection.loading && <p className="local-note">Configure FOUNDRY_API_KEY, FOUNDRY_ENDPOINT, and FOUNDRY_MODEL to request proposals.</p>}
              <div className="consent-footer"><span>This approval starts selected source transfer{checkDependencies ? ', npm/OSV lookups' : ''}, dependency installation if a selected function needs it, and local function execution.</span>
                <button className="button button-primary" type="button" onClick={confirmTransformation} disabled={!selectedUnits.size || !connection.configured || busy !== ''}>
                  {busy === 'transform' ? <><Spinner />Transforming selected units...</> : 'Approve transfer and transform'}
                </button></div>
              {busy === 'transform' && <div className="busy-note busy-panel" role="status" aria-live="polite">
                <Spinner /><span>{progressLabel(progress, assessment.units)}</span>
                <span className="busy-count">{progress?.stage === 'complete' ? progress?.total : progress?.completed || 0} of {progress?.total || selectedUnitCount} units done</span>
                <span className="busy-bar" aria-hidden="true"><span style={{ width: `${Math.round(((progress?.completed || 0) / (progress?.total || selectedUnitCount || 1)) * 100)}%` }} /></span>
              </div>}
            </section>
          </>
        )}

        {stage === 'review' && review && (
          <section className="proposal-review" aria-labelledby="review-title">
            <div className="review-heading"><div><p className="eyebrow">PROPOSAL REVIEW</p><h2 id="review-title">{review.proposals.length} selected-unit proposals</h2>
              <p className="review-subtitle">{review.sourceDisclosure.units.length} source spans · {review.dependencyAssessment.status === 'skipped' ? 'dependency checks skipped' : `${review.dependencyAssessment.requests} npm/OSV lookups`} · project tests run only at the validate stage</p></div>
              <button className="button button-quiet" type="button" onClick={resetReview} disabled={busy !== ''}>Reject review</button></div>
            {review.dependencyAssessment?.inventory && review.dependencyAssessment.status !== 'skipped' && <DependencyEvidence assessment={review.dependencyAssessment} inventory={review.dependencyAssessment.inventory}
              selectedUpdates={selectedUpdates} onToggleUpdate={toggleUpdate} updatePolicy={updatePolicy} onPolicyChange={changeUpdatePolicy} />}
            <div className="proposal-list">
              {review.proposals.map((proposal, index) => (
                <article className={`proposal-item ${selectedProposals.has(proposal.id) ? 'is-selected' : ''}`} key={proposal.id}>
                  <div className="proposal-topline">
                    <label className="proposal-select"><input type="checkbox" checked={selectedProposals.has(proposal.id)} onChange={() => toggleProposal(proposal)} disabled={proposal.status !== 'ready' || busy !== ''} />
                      <span className="checkmark" aria-hidden="true" /><strong>{String(index + 1).padStart(2, '0')} · {proposal.name}</strong></label>
                    <span className={`proposal-status status-${proposal.status}`}>{proposal.status}</span>
                  </div>
                  <p className="detail-location">{proposal.path}</p>
                  {proposal.targetFindings?.length > 0 && <details className="evidence-details target-findings" open={proposal.status !== 'ready'}>
                    <summary>Approved findings targeted ({proposal.targetFindings.length})</summary>
                    <ul className="residual-list">{proposal.targetFindings.map((finding) => (
                      <li key={finding.id}><strong>{finding.severity} · {finding.ruleId}</strong> · {findingLocation(finding)}: {finding.message}</li>
                    ))}</ul>
                  </details>}
                  {proposal.reason && <p className="failure-line">{proposal.reason}</p>}
                  {proposal.rationale && <p className="finding-rationale">{proposal.rationale}</p>}
                  {proposal.status === 'ready' && <div className="change-columns"><div><span>BEFORE</span><pre>{proposal.originalText}</pre></div><div><span>PROPOSED</span><pre>{proposal.replacementText}</pre></div></div>}
                  {proposal.status === 'rejected' && proposal.replacementText && <details className="evidence-details">
                    <summary>Show rejected rewrites ({proposal.attempts} attempt{proposal.attempts === 1 ? '' : 's'}) · not applicable</summary>
                    {(proposal.attemptHistory ?? [{ attempt: proposal.attempts, replacementText: proposal.replacementText, failedGates: [] }]).map((attempt) => (
                      <div className="rejected-attempt" key={attempt.attempt}>
                        <p className="local-note">Attempt {attempt.attempt}{attempt.failedGates.length ? ` · failed: ${attempt.failedGates.join(', ')}` : ''}</p>
                        <div className="change-columns"><div><span>BEFORE</span><pre>{proposal.originalText}</pre></div><div><span>REJECTED</span><pre>{attempt.replacementText}</pre></div></div>
                      </div>
                    ))}
                  </details>}
                  <GateList gates={proposal.gates} />
                  {proposal.warningAcknowledgementRequired && <label className="warning-ack"><input type="checkbox" checked={acknowledgedWarnings.has(proposal.id)} onChange={() => toggleWarning(proposal.id)} disabled={!selectedProposals.has(proposal.id)} />
                    <span className="checkmark" aria-hidden="true" /><span>I acknowledge this proposal has a not-checked safety gate.</span></label>}
                  {proposal.baseline && <details className="baseline-details" open={proposal.baseline.status === 'passed'}><summary>Characterisation baseline · {proposal.baseline.status}{proposal.baseline.stableCases ? ` · ${proposal.baseline.stableCases} stable cases` : ''}</summary><BaselineTable proposal={proposal} /></details>}
                  {proposal.residualFindings?.length > 0 && <details className="evidence-details" open={proposal.status !== 'ready'}>
                    <summary>{proposal.residualFindings.length} finding(s) remain after the proposed change</summary>
                    <ul className="residual-list">{proposal.residualFindings.map((finding, findingIndex) => (
                      <li key={`${finding.ruleId}-${finding.line}-${findingIndex}`}><strong>{finding.severity} · {finding.ruleId}</strong>{finding.line ? ` · line ${finding.line}` : ''} — {finding.message}</li>
                    ))}</ul>
                  </details>}
                </article>
              ))}
            </div>
            <div className="consent-footer"><span>{selectedProposals.size} proposals · {selectedUpdates.size} dependency updates selected</span>
              <button className="button button-primary" type="button" onClick={() => applySelected()} disabled={!canApply || busy !== ''}>
                {busy === 'apply' ? <><Spinner />Rechecking combined baselines...</> : busy === 'update-prepare' ? <><Spinner />Resolving dependency update...</> : selectedUpdates.size ? 'Review update diff and build' : 'Apply approved proposals'}
              </button></div>
          </section>
        )}

        {stage === 'build' && review && updatePreview && (
          <section className="build-review" aria-labelledby="build-review-title">
            <div className="review-heading"><div><p className="eyebrow">SECOND CHECKPOINT · BUILD</p><h2 id="build-review-title">Review the staged update</h2>
              <p className="review-subtitle">{updatePreview.packageDiff.length} packages · {updatePreview.lockChanges.length} lock entries · {updatePreview.sourceFindings} source proposals</p></div>
              <button className="button button-quiet" type="button" onClick={resetReview} disabled={busy !== ''}>Reject staged update</button></div>
            <section className="update-diff-block"><p className="eyebrow">DIRECT PACKAGE CHANGES</p>{updatePreview.packageDiff.map((item) => <div className="update-diff-row" key={item.name}><strong>{item.name} <UpdateLevel level={item.level} /></strong><span>{item.fromVersion} · {item.fromSpec}</span><span>to {item.version}</span></div>)}
              {updatePreview.migrationGuides?.length > 0
                ? <p className="evidence-note">Source migration supported: {updatePreview.migrationGuides.map((guide) => guide.title).join(' · ')}. If the build, project tests, or characterisation fail on the upgraded copy, you can approve Foundry-proposed code changes, which are rechecked before staging.</p>
                : updatePreview.packageDiff.some((item) => item.level === 'major') && <p className="evidence-note">Major updates can change the package API. No curated source migration exists for these packages, so a failing check blocks the update.</p>}</section>
            <details className="update-diff-block" open><summary>Lockfile changes ({updatePreview.lockChanges.length + updatePreview.omittedLockChanges})</summary>
              <div className="update-lock-list">{updatePreview.lockChanges.map((item) => <div className="update-diff-row" key={item.path}><strong>{item.name}</strong><span>{item.from || 'new'}</span><span>to {item.to || 'removed'}</span></div>)}</div>
              {updatePreview.omittedLockChanges > 0 && <p className="evidence-note">{updatePreview.omittedLockChanges} more entries are included in the staged lockfile.</p>}</details>
            <section className="build-command-block"><p className="eyebrow">EXECUTION DISCLOSURE</p><code>{updatePreview.build.install}</code><code>{updatePreview.build.command}</code>
              {updatePreview.build.testScript && <code>{updatePreview.build.tests}</code>}
              <p>{updatePreview.build.testScript
                ? `Project tests (${updatePreview.build.testScript}) run on the original upload and then on the upgraded copy. They block the update only if they passed on the original.`
                : 'No project test script was found, so project tests are not run.'} After a passing build, every stable characterisation baseline replays against the upgraded copy. Lifecycle scripts are not run. These commands execute uploaded code in temporary copies, not an OS sandbox.</p>
              <label className="build-acknowledgement"><input type="checkbox" checked={buildAcknowledged} onChange={(event) => setBuildAcknowledged(event.target.checked)} disabled={Boolean(buildResult)} />
                <span className="checkmark" aria-hidden="true" /><span>I approve the displayed install, build{updatePreview.build.testScript ? ', and test' : ''} commands.</span></label></section>
            {buildResult && <div className="build-result build-failed" role="status"><strong>{buildResult.stage === 'tests' ? 'Project tests failed' : `Build ${buildResult.status}`}</strong><span>{buildResult.stage}: {buildResult.reason}</span>
              {buildResult.tests?.baseline && <span>Project tests · original {buildResult.tests.baseline.status} · upgraded {buildResult.tests.upgraded?.status ?? 'not run'}</span>}
              <pre>{buildResult.output}</pre></div>}
            {buildResult?.migrationAvailable && !migration && <section className="migration-panel">
              <p className="eyebrow">CURATED MIGRATION AVAILABLE</p>
              <h3>{buildResult.migrationGuides.map((guide) => guide.title).join(' · ')}</h3>
              <p>Approving sends the non-test source files that import the upgraded package, the curated migration notes, and the failure output above to Foundry. Each proposed edit is rebuilt and re-tested in a temporary copy, with one retry. Nothing is staged until you accept it.</p>
              <button className="button button-primary" type="button" onClick={proposeMigration} disabled={busy !== ''}>{busy === 'migrate' ? <><Spinner />Proposing migration and re-checking...</> : 'Approve and propose migration'}</button>
            </section>}
            {migration && <section className="migration-panel">
              <p className="eyebrow">DEPENDENCY MIGRATION · {migration.status}</p>
              <h3>{migration.summary || (migration.status === 'ready' ? 'Migration passed every check.' : 'Migration was not accepted by the checks.')}</h3>
              <p className="detail-location">Sent to Foundry: {migration.sentFiles.join(', ')} · {migration.attempts.length} attempt{migration.attempts.length === 1 ? '' : 's'}</p>
              {migration.reason && <p className="failure-line">{migration.reason}</p>}
              {migration.checks && <p className="local-note">{migration.checks.status === 'passed' ? 'Build passed' : `Failed at ${migration.checks.stage}`} · project tests {migration.checks.tests?.status ?? 'not run'} · characterisation {migration.checks.characterisation?.status ?? 'not run'}</p>}
              {migration.edits.map((edit) => <details className="evidence-details" key={edit.path} open>
                <summary>{edit.path}</summary>
                <p className="finding-rationale">{edit.rationale}</p>
                <div className="change-columns"><div><span>BEFORE</span><pre>{edit.before}</pre></div><div><span>MIGRATED</span><pre>{edit.after}</pre></div></div>
              </details>)}
              {migration.status !== 'ready' && migration.checks?.output && <pre className="report-output">{migration.checks.output}</pre>}
            </section>}
            <div className="consent-footer"><span>Only a passing build and project tests make dependency changes available for download.</span>
              {migration?.status === 'ready'
                ? <button className="button button-primary" type="button" onClick={acceptMigration} disabled={busy !== ''}>{busy === 'migrate-accept' ? <><Spinner />Staging migration...</> : 'Accept migration and stage'}</button>
                : <button className="button button-primary" type="button" onClick={runStagedBuild} disabled={!buildAcknowledged || busy !== '' || Boolean(buildResult)}>{busy === 'build' ? <><Spinner />Installing, building, testing, and re-checking...</> : 'Run approved build and tests'}</button>}</div>
          </section>
        )}

        {stage === 'export' && review && applied && (
          <section className="export-panel" aria-labelledby="export-title"><p className="eyebrow">TRANSFORMATION READY</p><h2 id="export-title">Approved copy is ready.</h2>
            <p className="export-copy">{applied.proposals ?? applied.findings ?? 0} source proposals · {applied.packages ?? 0} package updates · {applied.migratedFiles ?? 0} migrated files · {applied.files ?? 0} staged files · {applied.testFiles ?? 0} characterisation test files. The uploaded folder was not modified; project tests {applied.testStatus === 'passed' ? 'passed on the upgraded copy' : applied.testStatus ? `were ${applied.testStatus}` : 'were not run'}.</p>
            <div className="export-actions"><a className="button button-primary download-button" href={`/api/sessions/${review.sessionId}/download`}>Download transformed ZIP <span aria-hidden="true">↓</span></a>
              <button className="button button-primary" type="button" onClick={openOutputInVscode} disabled={busy !== ''}
                title="Save a separate output copy and open it in a new VS Code window">
                {busy === 'editor' ? <><Spinner />Opening VS Code...</> : 'Open in VS Code'}
              </button>
              <button className="button button-quiet" type="button" onClick={resetReview} disabled={busy !== ''}>Assess another folder</button></div>
            {editorFolder && <p className="local-note editor-output" role="status">Requested a new VS Code window for <code>{editorFolder}</code></p>}
            {applied.report && <ChangeReport report={applied.report} />}
          </section>
        )}
      </main>
      {ackPrompt && <AcknowledgeDialog proposals={ackPrompt} onCancel={() => setAckPrompt(null)} onConfirm={() => {
        const next = new Set([...acknowledgedWarnings, ...ackPrompt.map((proposal) => proposal.id)]);
        setAcknowledgedWarnings(next);
        setAckPrompt(null);
        applySelected(next);
      }} />}
      <footer className="footer-bar"><span>LOCAL ASSESSMENT · NODE 24</span><span>Model output is a proposal; gates and review determine what is staged.</span></footer>
    </div>
  );
}
