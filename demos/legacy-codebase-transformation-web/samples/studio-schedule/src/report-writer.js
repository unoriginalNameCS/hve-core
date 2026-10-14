'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const mkdirpPackage = require('mkdirp');

async function writeStudioReport(report) {
  const uuidPackage = await import('uuid');
  const createRunId = uuidPackage.v4 || uuidPackage.default?.v4;
  const makeDirectory = typeof mkdirpPackage === 'function' ? mkdirpPackage : mkdirpPackage.mkdirp;
  if (typeof createRunId !== 'function' || typeof makeDirectory !== 'function') {
    throw new Error('The installed UUID or directory-creation API is unavailable.');
  }

  const directory = path.join(__dirname, '..', 'dist');
  await makeDirectory(directory);
  const reportPath = path.join(directory, 'studio-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify({ runId: createRunId(), ...report }, null, 2)}\n`);
  return reportPath;
}

module.exports = { writeStudioReport };
