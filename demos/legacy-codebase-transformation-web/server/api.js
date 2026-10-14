'use strict';

const Busboy = require('busboy');
const archiver = require('archiver');
const express = require('express');
const {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  analyzePreparedUpload,
  applyApprovedFindings,
  getSession,
  prepareApprovedUpdate,
  prepareUpload,
  removeSession,
  runApprovedUpdateBuild
} = require('./workflow');
const { getFoundryConfiguration } = require('./foundry-client');

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function renderChangeReport(report) {
  const lines = [
    '# Transformation Report',
    '',
    `Source changes: ${report.sourceChanges.length}`,
    `Package updates: ${report.packageChanges.length}`,
    `Lock entries changed: ${report.lockChanges.length + report.omittedLockChanges}`,
    `Build: ${report.build?.status ?? 'not run'}`,
    `Tests: ${report.tests}`,
    ''
  ];

  for (const change of report.sourceChanges) {
    lines.push(`## ${change.path} - ${change.symbol}`, '',
      `Lines ${change.startLine}-${change.endLine} | ${change.category}`, '',
      change.rationale, '', '### Before', '', '```text', change.before, '```', '',
      '### After', '', '```text', change.after, '```', '');
  }

  if (report.packageChanges.length) {
    lines.push('## Package Updates', '');
    for (const update of report.packageChanges) lines.push(`- ${update.name}: ${update.fromVersion} -> ${update.version}`);
    lines.push('');
  }

  if (report.lockChanges.length || report.omittedLockChanges) {
    lines.push('## Lockfile Changes', '');
    for (const entry of report.lockChanges) lines.push(`- ${entry.name}: ${entry.from || 'new'} -> ${entry.to || 'removed'}`);
    if (report.omittedLockChanges) lines.push(`- ${report.omittedLockChanges} additional entries omitted`);
    lines.push('');
  }

  if (report.build) lines.push('## Build Output', '', `Command: \`${report.build.command}\``, '', '```text', report.build.output || 'No output.', '```', '');
  return lines.join('\n');
}

function parseFolderUpload(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          files: MAX_UPLOAD_FILES,
          fields: 1,
          fieldSize: MAX_MANIFEST_BYTES,
          fileSize: MAX_UPLOAD_BYTES,
          parts: MAX_UPLOAD_FILES + 1
        }
      });
    } catch {
      reject(Object.assign(new Error('Upload a folder using the application file picker.'), { statusCode: 400 }));
      return;
    }

    let manifestText;
    let totalBytes = 0;
    let failure;
    let settled = false;
    const files = new Map();
    const fail = (error) => {
      if (failure) return;
      failure = error;
      request.unpipe(parser);
      parser.destroy();
    };

    parser.on('field', (name, value, info) => {
      if (name !== 'manifest' || manifestText !== undefined || info.valueTruncated) {
        fail(Object.assign(new Error('The upload manifest is invalid or too large.'), { statusCode: 400 }));
        return;
      }
      manifestText = value;
    });
    parser.on('file', (name, stream, info) => {
      const id = info.filename;
      if (name !== 'files' || !/^file-\d+$/.test(id) || files.has(id)) {
        stream.resume();
        fail(Object.assign(new Error('The upload contains an invalid file entry.'), { statusCode: 400 }));
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_UPLOAD_BYTES) {
          fail(Object.assign(new Error('The selected folder exceeds the 25 MB upload limit.'), { statusCode: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('limit', () => fail(Object.assign(new Error('An uploaded file exceeds the upload limit.'), { statusCode: 413 })));
      stream.on('end', () => {
        if (!failure) files.set(id, Buffer.concat(chunks));
      });
    });
    parser.on('filesLimit', () => fail(Object.assign(new Error(`Select no more than ${MAX_UPLOAD_FILES} files.`), { statusCode: 413 })));
    parser.on('fieldsLimit', () => fail(Object.assign(new Error('The upload contains unexpected fields.'), { statusCode: 400 })));
    parser.on('partsLimit', () => fail(Object.assign(new Error('The upload contains too many parts.'), { statusCode: 413 })));
    parser.on('error', (error) => fail(error));
    parser.on('close', () => {
      if (settled) return;
      settled = true;
      if (failure) return reject(failure);
      if (manifestText === undefined) return reject(Object.assign(new Error('The upload manifest is missing.'), { statusCode: 400 }));
      try {
        resolve({ manifest: JSON.parse(manifestText), files });
      } catch {
        reject(Object.assign(new Error('The upload manifest is not valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('aborted', () => fail(Object.assign(new Error('The upload was interrupted.'), { statusCode: 400 })));
    request.pipe(parser);
  });
}

function createApiApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/status', (_request, response) => {
    try {
      const config = getFoundryConfiguration(options.env);
      response.json({ configured: true, model: config.model });
    } catch {
      response.json({ configured: false, model: options.env?.FOUNDRY_MODEL || process.env.FOUNDRY_MODEL || 'gpt-4.1-mini' });
    }
  });

  app.post('/api/analyze/prepare', async (request, response) => {
    try {
      const upload = await parseFolderUpload(request);
      const result = prepareUpload(upload.manifest, upload.files);
      response.status(201).json(result);
    } catch (error) {
      if (error.statusCode) response.status(error.statusCode).json({ error: error.message });
      else response.status(400).json({ error: error.message || 'The upload could not be prepared.' });
    }
  });

  app.post('/api/sessions/:sessionId/analyze', async (request, response) => {
    const decisions = request.body;
    if (!decisions || Object.keys(decisions).some((key) => !['sourceApproved', 'dependencyApproved'].includes(key)) ||
        typeof decisions.sourceApproved !== 'boolean' || typeof decisions.dependencyApproved !== 'boolean') {
      response.status(400).json({ error: 'Confirm source sharing and npm metadata sharing.' });
      return;
    }
    const session = getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ error: 'This upload preview expired. Select the folder again.' });
      return;
    }
    let config;
    if (decisions.sourceApproved && session.chunks.length) {
      try { config = getFoundryConfiguration(options.env); } catch (error) {
        response.status(503).json({ error: error.message });
        return;
      }
    }
    try {
      const result = await analyzePreparedUpload(request.params.sessionId, decisions, {
        config,
        env: options.env,
        requestFindings: options.requestFindings,
        metadataFetchImpl: options.metadataFetchImpl
      });
      response.json(result);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || 'The analysis could not be completed.' });
    }
  });

  app.post('/api/sessions/:sessionId/apply', (request, response) => {
    try {
      const result = applyApprovedFindings(request.params.sessionId, request.body?.approvedFindingIds);
      response.json(result);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message });
    }
  });

  app.post('/api/sessions/:sessionId/updates/prepare', async (request, response) => {
    const input = request.body;
    if (!input || Object.keys(input).some((key) => !['approvedFindingIds', 'selectedUpdateNames'].includes(key)) ||
        !Array.isArray(input.approvedFindingIds) || !Array.isArray(input.selectedUpdateNames)) {
      response.status(400).json({ error: 'Provide approved finding IDs and selected dependency names.' });
      return;
    }
    try {
      const preview = await prepareApprovedUpdate(request.params.sessionId, input.approvedFindingIds,
        input.selectedUpdateNames, { runCommand: options.runDependencyCommand });
      response.json(preview);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || 'The dependency update preview could not be prepared.' });
    }
  });

  app.post('/api/sessions/:sessionId/updates/build', async (request, response) => {
    const input = request.body;
    if (!input || Object.keys(input).some((key) => !['previewId', 'acknowledgedBuild'].includes(key)) ||
        typeof input.previewId !== 'string' || input.acknowledgedBuild !== true) {
      response.status(400).json({ error: 'Approve the exact diff and disclosed build command before execution.' });
      return;
    }
    try {
      const result = await runApprovedUpdateBuild(request.params.sessionId, input.previewId,
        { runCommand: options.runBuildCommand });
      response.json(result);
    } catch (error) {
      response.status(error.statusCode || 400).json({ error: error.message || 'The approved build could not be run.' });
    }
  });

  app.delete('/api/sessions/:sessionId', (request, response) => {
    if (!removeSession(request.params.sessionId)) return response.status(404).json({ error: 'This review expired.' });
    return response.status(204).end();
  });

  app.get('/api/sessions/:sessionId/download', (request, response, next) => {
    const session = getSession(request.params.sessionId);
    if (!session) return response.status(404).json({ error: 'This review expired. Upload the folder again.' });
    if (!session.applied) return response.status(409).json({ error: 'Approve and apply findings before downloading.' });

    const archive = archiver('zip', { zlib: { level: 6 } });
    const safeRoot = session.rootName.replace(/[^a-zA-Z0-9._-]/g, '_');
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${safeRoot}-transformed.zip"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    archive.on('error', (error) => {
      if (!response.headersSent) next(error);
      else response.destroy(error);
    });
    archive.pipe(response);
    for (const [relativePath, bytes] of session.files) archive.append(bytes, { name: relativePath });
    if (session.changeReport) archive.append(renderChangeReport(session.changeReport), { name: 'TRANSFORMATION-REPORT.md' });
    archive.finalize();
    return undefined;
  });

  app.use((error, _request, response, _next) => {
    if (response.headersSent) return response.end();
    response.status(error.statusCode || 500).json({ error: 'The request could not be completed.' });
    return undefined;
  });

  return app;
}

module.exports = { createApiApp, parseFolderUpload };
