import { useEffect, useRef, useState } from 'react';
import { findProposalOverlaps, keepProposal } from './proposal-overlaps.mjs';

const STEPS = [
  { id: 'upload', number: '01', title: 'Upload' },
  { id: 'consent', number: '02', title: 'Data review' },
  { id: 'review', number: '03', title: 'Findings' },
  { id: 'build', number: '04', title: 'Update + build' },
  { id: 'export', number: '05', title: 'Export' }
];
const OMIT_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'coverage', 'generated', 'out', 'target']);

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
    if (!relativePath || segments.some((segment) => OMIT_DIRECTORIES.has(segment.toLowerCase()))) {
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

function DependencyEvidence({ assessment, selectedUpdates, onToggleUpdate }) {
  const inventory = assessment.inventory;
  const registry = assessment.registry || [];
  const advisories = assessment.advisories || [];
  const advisoryMatches = advisories.reduce((total, entry) => total + entry.matches.length, 0);
  const selectedCandidates = registry.flatMap((entry) => (entry.declarations || [])
    .filter((declaration) => selectedUpdates.has(entry.name) && declaration.updateCandidate)
    .map((declaration) => ({ name: entry.name, version: declaration.updateCandidate.version })));

  return (
    <section className="dependency-evidence" aria-labelledby="dependency-title">
      <div className="evidence-heading">
        <div>
          <p className="eyebrow">NPM DEPENDENCY EVIDENCE</p>
          <h3 id="dependency-title">{inventory.declarations.length} direct declarations · {inventory.occurrences.length} locked packages</h3>
        </div>
        <span className={`evidence-status status-${assessment.status}`}>{assessment.status}</span>
      </div>
      <p className="evidence-note">Registry and OSV results are provider evidence, not compatibility or exploitability decisions. No package files were changed.</p>

      <details className="evidence-details" open>
        <summary>Local package inventory</summary>
        {inventory.declarations.length ? (
          <div className="evidence-list">
            {inventory.declarations.map((entry, index) => (
              <div className="evidence-row" key={`${entry.manifest}-${entry.name}-${index}`}>
                <strong>{entry.name}</strong>
                <span>{entry.spec}</span>
                <small>{entry.groups.join(', ')} · locked {entry.lockedVersions.join(', ') || 'unknown'}</small>
              </div>
            ))}
          </div>
        ) : <p className="evidence-empty">No valid direct npm declarations found.</p>}
      </details>

      {assessment.status === 'not-approved' && <p className="local-note">Public metadata lookups were not approved. Only the local package inventory is shown.</p>}
      {registry.length > 0 && (
        <details className="evidence-details" open>
          <summary>npm Registry evidence · {registry.length} package names</summary>
          <div className="evidence-list">
            {registry.map((entry) => (
              <div className="evidence-row" key={entry.name}>
                <strong>{entry.name}</strong>
                <span>{entry.status}</span>
                <small>Latest tag: {entry.latest?.version || 'unknown'} · latest stable nondeprecated: {entry.latestStable?.version || 'unknown'}</small>
                {entry.lockedVersions.filter((version) => version.deprecated).map((version) => (
                  <small className="evidence-warning" key={`${entry.name}-${version.version}`}>
                    {version.version} is deprecated: {version.deprecated}
                  </small>
                ))}
                {inventory.buildAvailable && inventory.buildScript && entry.declarations.some((declaration) => declaration.updateCandidate) && (
                  <div className="update-candidates">
                    {entry.declarations.filter((declaration) => declaration.updateCandidate).map((declaration) => (
                      <label className="update-choice" key={`${entry.name}-${declaration.manifest}`}>
                        <input type="checkbox" checked={selectedUpdates.has(entry.name)} onChange={() => onToggleUpdate(entry.name)} />
                        <span className="checkmark" aria-hidden="true" />
                        <span><strong>Update {entry.name}</strong><small>{declaration.lockedVersions.join(', ') || 'unknown'} → {declaration.updateCandidate.version}; build verification required</small></span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {(!inventory.buildAvailable || !inventory.buildScript) && <p className="local-note">A supported single-root npm lock and build script are required before dependency updates can be prepared.</p>}
          </div>
        </details>
      )}

      {selectedCandidates.length > 0 && (
        <p className="disclosure-warning">
          Resolving {selectedCandidates.map((candidate) => `${candidate.name}@${candidate.version}`).join(', ')} runs
          `npm install --package-lock-only --ignore-scripts` in a temporary copy. npm may request metadata for
          transitive packages not listed here. Lifecycle scripts do not run during resolution.
        </p>
      )}

      {advisories.length > 0 && (
        <details className="evidence-details" open>
          <summary>OSV exact-version evidence · {advisoryMatches} matches</summary>
          <div className="evidence-list">
            {advisories.map((entry) => (
              <div className="evidence-row" key={`${entry.name}@${entry.version}`}>
                <strong>{entry.name} @ {entry.version}</strong>
                {!entry.matches.length && <span>{entry.status === 'completed' ? 'No advisory returned' : entry.status}</span>}
                {entry.matches.map((match) => (
                  <small className="evidence-warning" key={match.id}>
                    {match.id}{match.aliases.length ? ` · ${match.aliases.join(', ')}` : ''}
                    {match.summary ? ` · ${match.summary}` : ''}
                    {match.fixedVersions.length ? ` · advisory fixed versions: ${match.fixedVersions.join(', ')}` : ''}
                  </small>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}

      {assessment.gaps.length > 0 && (
        <details className="evidence-details">
          <summary>{assessment.gaps.length} coverage gaps</summary>
          <ul className="gap-list">{assessment.gaps.map((gap, index) => <li key={`${gap.source}-${gap.path}-${index}`}>{gap.path || gap.name || gap.source}: {gap.reason}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function ChangeReport({ report }) {
  return (
    <section className="change-report" aria-labelledby="change-report-title">
      <p className="eyebrow">CHANGE REPORT</p>
      <h3 id="change-report-title">What changed</h3>
      <ul className="report-summary">
        <li>{report.sourceChanges.length} source changes</li>
        <li>{report.packageChanges.length} package updates</li>
        <li>{report.lockChanges.length + report.omittedLockChanges} lock entries</li>
        <li>Build: {report.build ? report.build.status : 'not run'}</li>
        <li>Tests: {report.tests}</li>
      </ul>

      {report.sourceChanges.map((change) => (
        <article className="report-item" key={change.id}>
          <div className="finding-meta">
            <span className="finding-path">{change.path}</span>
            <span>lines {change.startLine}–{change.endLine}</span>
            <span>{change.symbol}</span>
            <span>{change.category}</span>
          </div>
          <p className="finding-rationale">{change.rationale}</p>
          <div className="change-columns">
            <div><span>BEFORE</span><pre>{change.before}</pre></div>
            <div><span>AFTER</span><pre>{change.after}</pre></div>
          </div>
        </article>
      ))}

      {report.packageChanges.length > 0 && (
        <div className="report-item">
          <p className="eyebrow">PACKAGE UPDATES</p>
          {report.packageChanges.map((update) => (
            <div className="update-diff-row" key={update.name}>
              <strong>{update.name}</strong>
              <span>{update.fromVersion}</span>
              <span>→ {update.version}</span>
            </div>
          ))}
        </div>
      )}

      {report.lockChanges.length > 0 && (
        <details className="report-item">
          <summary>Lockfile changes ({report.lockChanges.length + report.omittedLockChanges})</summary>
          {report.lockChanges.map((entry) => (
            <div className="update-diff-row" key={entry.path}>
              <strong>{entry.name}</strong>
              <span>{entry.from || 'new'}</span>
              <span>→ {entry.to || 'removed'}</span>
            </div>
          ))}
        </details>
      )}

      {report.build && (
        <details className="report-item">
          <summary>Build output ({report.build.command})</summary>
          <pre className="report-output">{report.build.output || 'No output.'}</pre>
        </details>
      )}
    </section>
  );
}

function OverlapComparison({ pair, selected, onKeep, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      previousFocus?.focus();
    };
  }, []);

  return (
    <dialog ref={dialogRef} className="overlap-dialog" aria-labelledby="overlap-title" aria-describedby="overlap-location" onClose={(event) => {
      if (!event.currentTarget.open) onClose();
    }} onCancel={(event) => {
      event.preventDefault();
      onClose();
    }}>
      <div className="overlap-dialog-heading">
        <h2 id="overlap-title">Proposal {pair.leftNumber} vs {pair.rightNumber}</h2>
        <button className="button button-quiet" type="button" onClick={onClose} autoFocus>Close comparison</button>
      </div>
      <p id="overlap-location" className="overlap-location">{pair.left.path}<br />Shared source: {pair.start.line}:{pair.start.character + 1} to {pair.end.line}:{pair.end.character + 1} (end exclusive)</p>
      <div className="overlap-comparison">
        {[{ finding: pair.left, number: pair.leftNumber, other: pair.right },
          { finding: pair.right, number: pair.rightNumber, other: pair.left }].map(({ finding, number, other }) => (
          <section className="overlap-alternative" key={finding.id} aria-labelledby={`alternative-${number}`}>
            <h3 id={`alternative-${number}`}>Proposal {number} <span>{selected.has(finding.id) ? 'Selected' : 'Not selected'}</span></h3>
            <p className="finding-meta">{finding.symbol} · lines {finding.range.startLine}-{finding.range.endLine} · {finding.confidence} confidence</p>
            <p className="finding-rationale">{finding.rationale}</p>
            <div className="change-columns">
              <div><span>BEFORE</span><pre>{finding.originalText}</pre></div>
              <div><span>PROPOSED</span><pre>{finding.replacementText}</pre></div>
            </div>
            <button className="button button-primary" type="button" onClick={() => onKeep(finding.id, other.id)}>Keep proposal {number}</button>
          </section>
        ))}
      </div>
    </dialog>
  );
}

export default function App() {
  const inputRef = useRef(null);
  const [stage, setStage] = useState('upload');
  const [connection, setConnection] = useState({ loading: true, configured: false, model: 'gpt-4.1-mini' });
  const [folder, setFolder] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const [sourceConsent, setSourceConsent] = useState(false);
  const [dependencyConsent, setDependencyConsent] = useState(false);
  const [review, setReview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [comparedPair, setComparedPair] = useState(null);
  const [selectedUpdates, setSelectedUpdates] = useState(new Set());
  const [updatePreview, setUpdatePreview] = useState(null);
  const [buildResult, setBuildResult] = useState(null);
  const [buildAcknowledged, setBuildAcknowledged] = useState(false);
  const [applied, setApplied] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/status')
      .then((response) => response.json())
      .then((status) => setConnection({ loading: false, ...status }))
      .catch(() => setConnection({ loading: false, configured: false, model: 'gpt-4.1-mini' }));
  }, []);

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
      setError('This demo accepts up to 500 files and 25 MB per review. Exclude generated and dependency folders, then try again.');
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
      const manifest = folder.files.map((file, index) => ({
        id: `file-${index}`, path: file.webkitRelativePath, size: file.size
      }));
      form.append('manifest', JSON.stringify(manifest));
      folder.files.forEach((file, index) => form.append('files', file, `file-${index}`));
      const response = await fetch('/api/analyze/prepare', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      setPrepared(result);
      setSourceConsent(false);
      setDependencyConsent(false);
      setStage('consent');
    } catch (requestError) {
      setError(requestError.message || 'The upload could not be prepared.');
    } finally {
      setBusy('');
    }
  }

  async function confirmAnalysis() {
    if (!prepared) return;
    setBusy('analyze');
    setError('');
    try {
      const response = await fetch(`/api/sessions/${prepared.sessionId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceApproved: sourceConsent, dependencyApproved: dependencyConsent })
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json();
      setReview(result);
      setSelected(new Set());
      setSelectedUpdates(new Set());
      setStage('review');
    } catch (requestError) {
      setError(requestError.message || 'Analysis could not be completed.');
    } finally {
      setBusy('');
    }
  }

  async function applySelected() {
    if (selectedOverlaps.length) {
      setComparedPair(selectedOverlaps[0]);
      return;
    }
    if (selectedUpdates.size > 0) {
      await prepareSelectedUpdates();
      return;
    }
    if (!review || selected.size === 0) return;
    setBusy('apply');
    setError('');
    try {
      const response = await fetch(`/api/sessions/${review.sessionId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedFindingIds: [...selected] })
      });
      if (!response.ok) throw new Error(await readError(response));
      setApplied(await response.json());
      setStage('export');
    } catch (requestError) {
      setError(requestError.message || 'Approved changes could not be applied.');
    } finally {
      setBusy('');
    }
  }

  async function prepareSelectedUpdates() {
    if (!review || selectedUpdates.size === 0) return;
    setBusy('update-prepare');
    setError('');
    try {
      const response = await fetch(`/api/sessions/${review.sessionId}/updates/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedFindingIds: [...selected], selectedUpdateNames: [...selectedUpdates] })
      });
      if (!response.ok) throw new Error(await readError(response));
      setUpdatePreview(await response.json());
      setBuildResult(null);
      setBuildAcknowledged(false);
      setStage('build');
    } catch (requestError) {
      setError(requestError.message || 'Dependency update preview could not be prepared.');
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId: updatePreview.previewId, acknowledgedBuild: true })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `The build request failed with status ${response.status}.`);
      if (result.status !== 'passed') {
        setBuildResult(result);
        return;
      }
      setApplied({
        findings: result.summary.findings,
        files: result.summary.files,
        packages: result.summary.packages,
        buildStatus: result.summary.buildStatus,
        report: result.report
      });
      setStage('export');
    } catch (requestError) {
      setError(requestError.message || 'The staged build could not be completed.');
    } finally {
      setBusy('');
    }
  }

  function resetReview() {
    const sessionId = review?.sessionId || prepared?.sessionId;
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    setFolder(null);
    setPrepared(null);
    setSourceConsent(false);
    setDependencyConsent(false);
    setReview(null);
    setSelected(new Set());
    setComparedPair(null);
    setSelectedUpdates(new Set());
    setUpdatePreview(null);
    setBuildResult(null);
    setBuildAcknowledged(false);
    setApplied(null);
    setStage('upload');
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  }

  function toggleFinding(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleUpdate(name) {
    setSelectedUpdates((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const activeStep = STEPS.findIndex((item) => item.id === stage);
  const hasDependencyLookups = Boolean(prepared && (prepared.dependencyPreview.registryNames.length || prepared.dependencyPreview.advisoryTuples.length));
  const requiresCombinedApproval = Boolean(prepared?.sourceDisclosure.files.length && hasDependencyLookups);
  const overlaps = findProposalOverlaps(review?.findings ?? []);
  const selectedOverlaps = overlaps.filter((pair) => selected.has(pair.left.id) && selected.has(pair.right.id));

  function keepComparedProposal(keepId, otherId) {
    setSelected((current) => keepProposal(current, keepId, otherId));
    setComparedPair(null);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Codebase Review home">
          <span className="wordmark-mark">CR</span>
          <span>CODEBASE <b>/</b> REVIEW</span>
        </a>
        <div className={`model-status ${connection.configured ? 'is-ready' : 'is-missing'}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>{connection.loading ? 'Checking Foundry' : connection.configured ? connection.model : 'Foundry not configured'}</span>
        </div>
      </header>

      <main id="top">
        <section className="intro-row">
          <div>
            <p className="eyebrow"><span className="eyebrow-mark" /> LOCAL TRANSFORMATION WORKSPACE</p>
            <h1>Make the change<br /><em>after you review it.</em></h1>
            <p className="intro-copy">Inspect a codebase, review exact proposed edits, and export only the changes you approve.</p>
          </div>
          <nav className="stepper" aria-label="Review stages">
            {STEPS.map((item, index) => (
              <div className={`step ${index === activeStep ? 'active' : index < activeStep ? 'complete' : ''}`} key={item.id}>
                <span>{item.number}</span>
                <strong>{item.title}</strong>
              </div>
            ))}
          </nav>
        </section>

        {error && <p className="alert" role="alert">{error}</p>}

        {stage === 'upload' && (
          <section className="workspace-grid" aria-labelledby="upload-title">
            <div className="upload-panel">
              <div className="section-heading">
                <span className="section-index">01</span>
                <div>
                  <p className="eyebrow">SOURCE FOLDER</p>
                  <h2 id="upload-title">Choose a codebase</h2>
                </div>
              </div>
              <button className="folder-picker" type="button" onClick={() => inputRef.current?.click()} disabled={busy !== ''}>
                <span className="picker-symbol" aria-hidden="true">+</span>
                <span className="picker-text">
                  <strong>{folder ? folder.name : 'Select folder'}</strong>
                  <small>{folder ? `${folder.files.length} files · ${formatBytes(folder.totalBytes)}` : 'Choose a project folder from this device'}</small>
                </span>
                <span className="picker-arrow" aria-hidden="true">↗</span>
              </button>
              <input ref={inputRef} className="visually-hidden" type="file" webkitdirectory="" directory="" multiple onChange={selectFolder} aria-label="Select project folder" />
              {folder && (
                <div className="upload-meta">
                  <span>{folder.files.length} files queued</span>
                  <span>{folder.excluded} generated/dependency files excluded</span>
                </div>
              )}
              <div className="upload-footer">
                <span>Up to 500 files · 25 MB total</span>
                <button className="button button-primary" type="button" onClick={prepareFolder} disabled={!folder || busy !== ''}>
                    {busy === 'prepare' ? 'Preparing…' : 'Prepare review'}
                </button>
              </div>
                {busy === 'prepare' && <p className="busy-note" role="status">Reading source and npm metadata locally. Nothing is sent to an external service yet.</p>}
            </div>

            <aside className="side-panel">
              <p className="eyebrow">REVIEW BOUNDARIES</p>
              <div className="boundary-item">
                <span className="boundary-number">A</span>
                <p>Only supported source files are sent to the selected Foundry deployment.</p>
              </div>
              <div className="boundary-item">
                <span className="boundary-number">B</span>
                <p>Original files stay unchanged. Edits apply to an in-memory copy.</p>
              </div>
              <div className="boundary-item">
                <span className="boundary-number">C</span>
                <p>Uploaded code runs only if you approve the staged build; tests and lifecycle scripts are not run.</p>
              </div>
              {!connection.configured && !connection.loading && (
                <div className="config-note">
                  <strong>Server configuration required</strong>
                  <p>Set FOUNDRY_API_KEY, FOUNDRY_ENDPOINT, and FOUNDRY_MODEL in the demo server environment.</p>
                </div>
              )}
            </aside>
          </section>
        )}

        {stage === 'consent' && prepared && (
          <section className="consent-section" aria-labelledby="consent-title">
            <div className="review-heading consent-heading">
              <div>
                <p className="eyebrow">02 / DATA TRANSFER REVIEW</p>
                <h2 id="consent-title">Choose what may leave this app.</h2>
                <p className="review-subtitle">The upload has been inspected locally. No model or metadata requests have been made.</p>
              </div>
              <button className="button button-quiet" type="button" onClick={resetReview}>Reject upload</button>
            </div>

            {prepared.sourceDisclosure.files.length > 0 && (
              <section className="disclosure-block">
                <label className="consent-choice">
                  <input type="checkbox" checked={requiresCombinedApproval ? sourceConsent && dependencyConsent : sourceConsent} onChange={(event) => {
                    const approved = event.target.checked;
                    setSourceConsent(approved);
                    if (requiresCombinedApproval) setDependencyConsent(approved);
                  }} />
                  <span className="checkmark" aria-hidden="true" />
                  <span><strong>{requiresCombinedApproval ? 'Approve combined code and npm analysis' : 'Send source to Foundry'}</strong><small>{prepared.sourceDisclosure.files.length} files · {prepared.sourceDisclosure.chunks} chunks · {formatBytes(prepared.sourceDisclosure.bytes)} · model {connection.model}{requiresCombinedApproval ? ' · source and dependency evidence run together' : ''}</small></span>
                </label>
                <details className="disclosure-details">
                  <summary>Show source file paths</summary>
                  <ul>{prepared.sourceDisclosure.files.map((file) => <li key={file}>{file}</li>)}</ul>
                </details>
              </section>
            )}

            {prepared.dependencyPreview.documents.length > 0 && (
              <section className="disclosure-block dependency-disclosure">
                {requiresCombinedApproval ? (
                  <p className="combined-approval-note"><strong>Included in combined approval</strong><span>{prepared.dependencyPreview.registryNames.length} Registry names · {prepared.dependencyPreview.advisoryTuples.length} exact OSV package/version tuples</span></p>
                ) : (
                  <label className="consent-choice">
                    <input type="checkbox" checked={dependencyConsent} onChange={(event) => setDependencyConsent(event.target.checked)} />
                    <span className="checkmark" aria-hidden="true" />
                    <span><strong>Look up npm dependency metadata</strong><small>{prepared.dependencyPreview.registryNames.length} Registry names · {prepared.dependencyPreview.advisoryTuples.length} exact OSV package/version tuples</small></span>
                  </label>
                )}
                <p className="local-note">Build check: {prepared.dependencyPreview.buildAvailable && prepared.dependencyPreview.buildScript ?
                  `available (${prepared.dependencyPreview.buildScript})` : 'unavailable: a supported root npm lock and build script were not found'}.</p>
                <p className="disclosure-warning">Package identifiers may reveal private project metadata. Only these names and exact locked versions are sent; manifests, source, and credentials are not sent to npm or OSV. {requiresCombinedApproval ? 'The combined approval above starts source and npm analysis together.' : 'No lookup happens unless you approve the displayed transfer.'}</p>
                <div className="identifier-lists">
                  <div>
                    <span className="identifier-heading">NPM REGISTRY · GET</span>
                    {prepared.dependencyPreview.registryNames.length ? <ul>{prepared.dependencyPreview.registryNames.map((name) => <li key={name}>{name}</li>)}</ul> : <p>None</p>}
                  </div>
                  <div>
                    <span className="identifier-heading">OSV · POST</span>
                    {prepared.dependencyPreview.advisoryTuples.length ? <ul>{prepared.dependencyPreview.advisoryTuples.map((tuple) => <li key={`${tuple.name}@${tuple.version}`}>{tuple.name} @ {tuple.version}</li>)}</ul> : <p>None</p>}
                  </div>
                </div>
                {prepared.dependencyPreview.gaps.length > 0 && (
                  <details className="disclosure-details">
                    <summary>{prepared.dependencyPreview.gaps.length} local inventory gaps</summary>
                    <ul>{prepared.dependencyPreview.gaps.map((gap, index) => <li key={`${gap.path}-${index}`}>{gap.path}: {gap.reason}</li>)}</ul>
                  </details>
                )}
              </section>
            )}
            {prepared.dependencyPreview.documents.length === 0 && <p className="local-note">No npm manifest or lockfile was found. No npm or OSV requests will be made.</p>}
            {!prepared.sourceDisclosure.files.length && <p className="local-note">No supported source files were found. You can review npm metadata only.</p>}

            <div className="consent-footer">
              <span>{requiresCombinedApproval ? 'Code and npm analyses require one approval and run together.' : 'Approve the available analysis before any external request.'}</span>
              <button className="button button-primary" type="button" onClick={confirmAnalysis} disabled={busy !== '' ||
                requiresCombinedApproval && !(sourceConsent && dependencyConsent) ||
                !requiresCombinedApproval && prepared.sourceDisclosure.files.length > 0 && !sourceConsent ||
                !requiresCombinedApproval && prepared.sourceDisclosure.files.length === 0 && hasDependencyLookups && !dependencyConsent}>
                {busy === 'analyze' ? 'Analyzing…' : 'Continue with selected approvals'}
              </button>
            </div>
            {busy === 'analyze' && <p className="busy-note" role="status">Running only the transfers you approved. This may take a few minutes.</p>}
          </section>
        )}

        {stage === 'review' && review && (
          <section className="review-section" aria-labelledby="review-title">
            <div className="review-heading">
              <div>
                <p className="eyebrow">02 / FINDING REVIEW</p>
                <h2 id="review-title">{review.findings.length ? `${review.findings.length} proposed changes` : review.sourceStatus === 'not-applicable' ? 'npm dependency evidence' : 'No changes proposed'}</h2>
                <p className="review-subtitle">{review.summary.sourceFiles} source files · {review.summary.requests} model requests · {review.summary.dependencyRequests} npm/OSV requests</p>
              </div>
              <div className="review-actions">
                <button className="button button-quiet" type="button" onClick={resetReview} disabled={busy !== ''}>Reject review</button>
                <button className="button button-primary" type="button" onClick={applySelected}
                  disabled={(selected.size === 0 && selectedUpdates.size === 0) || busy !== '' || selectedOverlaps.length > 0}
                  aria-describedby={selectedOverlaps.length ? 'overlap-selection-status' : undefined}>
                  {busy === 'apply' ? 'Applying…' : busy === 'update-prepare' ? 'Resolving update…' : selectedUpdates.size > 0 ?
                    selected.size > 0 ?
                      `Stage ${selected.size} source change${selected.size === 1 ? '' : 's'} + ${selectedUpdates.size} dependency update${selectedUpdates.size === 1 ? '' : 's'}` :
                      `Resolve ${selectedUpdates.size} dependency update${selectedUpdates.size === 1 ? '' : 's'}` :
                    `Approve ${selected.size} and transform`}
                </button>
              </div>
            </div>

            {review.sourceStatus === 'not-approved' && <p className="local-note">Source analysis was not approved. npm evidence is shown separately when available.</p>}
            {review.sourceStatus === 'not-applicable' && <p className="local-note">No supported source files were found, so no Foundry request was made.</p>}
            {review.sourceStatus === 'incomplete' && <p className="alert">Some source proposals could not be validated and were excluded. You can approve the validated findings below; analysis coverage is incomplete.</p>}
            {review.sourceFailures.map((failure, index) => (
              <p className="failure-line" key={`${failure.path}-${index}`}>{failure.path}: {failure.reason}</p>
            ))}
            {review.dependencyAssessment && <DependencyEvidence assessment={review.dependencyAssessment}
              selectedUpdates={selectedUpdates} onToggleUpdate={toggleUpdate} />}
            {review.findings.length === 0 && review.complete && <p className="empty-review">The selected source did not produce an actionable refactor finding.</p>}
            {overlaps.length > 0 && (
              <section className="overlap-summary" aria-labelledby="overlap-summary-title">
                <h3 id="overlap-summary-title">Overlapping proposals ({overlaps.length} {overlaps.length === 1 ? 'pair' : 'pairs'})</h3>
                <p id="overlap-selection-status" role="status">{selectedOverlaps.length ?
                  `${selectedOverlaps.length} selected ${selectedOverlaps.length === 1 ? 'pair conflicts' : 'pairs conflict'}. Choose one proposal per overlapping pair before staging.` :
                  'No selected proposals conflict.'}</p>
                <ul className="overlap-pairs">
                  {overlaps.map((pair) => (
                    <li key={pair.key}>
                      <div><strong>Proposal {pair.leftNumber} + proposal {pair.rightNumber}</strong>
                        <span>{pair.left.path} · shared lines {pair.start.line}-{pair.end.line}</span>
                        <small>{selected.has(pair.left.id) && selected.has(pair.right.id) ? 'Both selected: conflict' : 'Alternative proposals'}</small></div>
                      <button className="button button-quiet" type="button" onClick={() => setComparedPair(pair)} disabled={busy !== ''}>Compare proposals {pair.leftNumber} and {pair.rightNumber}</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="finding-list">
              {review.findings.map((finding, index) => (
                <article className={`finding ${selected.has(finding.id) ? 'selected' : ''}`} key={finding.id}>
                  <label className="finding-select">
                    <input type="checkbox" aria-label={`Select proposal ${index + 1}`} checked={selected.has(finding.id)} onChange={() => toggleFinding(finding.id)} disabled={busy !== ''} />
                    <span className="checkmark" aria-hidden="true" />
                    <span className="finding-number">{String(index + 1).padStart(2, '0')}</span>
                  </label>
                  <div className="finding-body">
                    <div className="finding-meta">
                      <span className="finding-path">{finding.path}</span>
                      <span>{finding.symbol}</span>
                      <span>{finding.category}</span>
                      <span>{finding.confidence} confidence</span>
                      <span>lines {finding.range.startLine}-{finding.range.endLine}</span>
                    </div>
                    <p className="finding-rationale">{finding.rationale}</p>
                    <div className="finding-overlaps">
                      {overlaps.filter((pair) => pair.left.id === finding.id || pair.right.id === finding.id).map((pair) => (
                        <button className="overlap-link" key={pair.key} type="button" disabled={busy !== ''} onClick={() => setComparedPair(pair)}>
                          Overlaps proposal {pair.left.id === finding.id ? pair.rightNumber : pair.leftNumber}: compare
                        </button>
                      ))}
                    </div>
                    <details className="change-details">
                      <summary>Inspect exact change</summary>
                      <div className="change-columns">
                        <div><span>BEFORE</span><pre>{finding.originalText}</pre></div>
                        <div><span>PROPOSED</span><pre>{finding.replacementText}</pre></div>
                      </div>
                    </details>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {stage === 'build' && review && updatePreview && (
          <section className="build-review" aria-labelledby="build-review-title">
            <div className="review-heading">
              <div>
                <p className="eyebrow">04 / UPDATE DIFF AND BUILD</p>
                <h2 id="build-review-title">Review the staged update</h2>
                <p className="review-subtitle">{updatePreview.packageDiff.length} direct packages · {updatePreview.lockChanges.length} lock entries changed · {updatePreview.sourceFindings} approved source findings</p>
              </div>
              <button className="button button-quiet" type="button" onClick={resetReview} disabled={busy !== ''}>Reject update</button>
            </div>

            <section className="update-diff-block">
              <p className="eyebrow">DIRECT PACKAGE CHANGES</p>
              {updatePreview.packageDiff.map((update) => (
                <div className="update-diff-row" key={update.name}>
                  <strong>{update.name}</strong>
                  <span>{update.fromSpec} · locked {update.fromVersion}</span>
                  <span>→ {update.version}</span>
                </div>
              ))}
            </section>

            {selected.size > 0 && (
              <details className="update-diff-block" open>
                <summary>Approved source changes ({selected.size})</summary>
                {review.findings.filter((finding) => selected.has(finding.id)).map((finding) => (
                  <div className="update-source-change" key={finding.id}>
                    <strong>{finding.path} · {finding.symbol}</strong>
                    <div className="change-columns">
                      <div><span>BEFORE</span><pre>{finding.originalText}</pre></div>
                      <div><span>PROPOSED</span><pre>{finding.replacementText}</pre></div>
                    </div>
                  </div>
                ))}
              </details>
            )}

            <details className="update-diff-block" open>
              <summary>Lockfile changes ({updatePreview.lockChanges.length})</summary>
              <div className="update-lock-list">
                {updatePreview.lockChanges.map((entry) => (
                  <div className="update-diff-row" key={entry.path}>
                    <strong>{entry.name}</strong>
                    <span>{entry.from || 'new'}</span>
                    <span>→ {entry.to || 'removed'}</span>
                  </div>
                ))}
              </div>
              {updatePreview.omittedLockChanges > 0 && <p className="evidence-note">{updatePreview.omittedLockChanges} additional lock entries changed and are included in the staged lockfile.</p>}
            </details>

            <section className="build-command-block">
              <p className="eyebrow">EXECUTION AFTER APPROVAL</p>
              <code>{updatePreview.build.install}</code>
              <code>{updatePreview.build.command}</code>
              <p>Lifecycle scripts and project tests are not run. The build command itself executes uploaded project code.</p>
              <p className="disclosure-warning">This runs in a temporary copy with a sanitized environment, but the temporary directory is not an OS sandbox. Approve only code you trust.</p>
              <label className="build-acknowledgement">
                <input type="checkbox" checked={buildAcknowledged} onChange={(event) => setBuildAcknowledged(event.target.checked)} disabled={Boolean(buildResult)} />
                <span className="checkmark" aria-hidden="true" />
                <span>I approve installing the staged dependencies and running the disclosed build command.</span>
              </label>
            </section>

            {buildResult && (
              <div className={`build-result ${buildResult.status === 'passed' ? 'build-passed' : 'build-failed'}`} role="status">
                <strong>Build {buildResult.status}</strong>
                <span>{buildResult.stage}: {buildResult.reason || 'command completed'}</span>
                {buildResult.output && <pre>{buildResult.output}</pre>}
                <p>The uploaded folder remains unchanged. Project tests were not run.</p>
              </div>
            )}

            <div className="consent-footer">
              <span>Only a successful build makes these changes available for download.</span>
              <button className="button button-primary" type="button" onClick={runStagedBuild}
                disabled={!buildAcknowledged || busy !== '' || Boolean(buildResult)}>
                {busy === 'build' ? 'Installing and building…' : 'Run build and stage download'}
              </button>
            </div>
          </section>
        )}

        {stage === 'export' && review && applied && (
          <section className="export-panel" aria-labelledby="export-title">
            <p className="eyebrow">03 / TRANSFORMATION READY</p>
            <h2 id="export-title">Your approved copy is ready.</h2>
            <p className="export-copy">{applied.packages ? `${applied.packages} dependency updates and ${applied.findings} source changes staged; build passed.` : `${applied.findings} approved changes across ${applied.files} files.`} The uploaded folder was not modified. Tests were not run.</p>
            <div className="export-actions">
              <a className="button button-primary download-button" href={`/api/sessions/${review.sessionId}/download`}>
                Download transformed ZIP <span aria-hidden="true">↓</span>
              </a>
              <button className="button button-quiet" type="button" onClick={resetReview}>Review another folder</button>
            </div>
            {applied.report && <ChangeReport report={applied.report} />}
          </section>
        )}
      </main>

      {comparedPair && <OverlapComparison pair={comparedPair} selected={selected} onKeep={keepComparedProposal} onClose={() => setComparedPair(null)} />}

      <footer className="footer-bar">
        <span>LOCAL DEMO</span>
        <span>Model suggestions are unverified until reviewed.</span>
      </footer>
    </div>
  );
}
