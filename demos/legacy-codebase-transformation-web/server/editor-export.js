'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function prepareEditorFolder(session, report) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'debt-assessor-output-'));
  const folder = path.join(output, session.rootName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'project');
  try {
    await fs.mkdir(folder);
    for (const [relativePath, bytes] of session.files) {
      const segments = relativePath.split('/');
      if (segments.shift() !== session.rootName || !segments.length ||
          segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\:\u0000-\u001f]/.test(segment))) {
        throw new Error('Invalid output path.');
      }
      const target = path.resolve(folder, ...segments);
      if (!target.startsWith(`${folder}${path.sep}`)) throw new Error('Invalid output path.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx' });
    }
    await fs.writeFile(path.join(folder, 'CODE-TRANSFORMATION-REPORT.md'), report);
    return folder;
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function openVscode(folder) {
  let command = 'code';
  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe')
    ].filter(Boolean);
    command = null;
    for (const candidate of candidates) {
      try { await fs.access(candidate); command = candidate; break; } catch {}
    }
    if (!command) throw new Error('VS Code is not installed in a standard location.');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['--new-window', folder], { stdio: 'ignore', detached: true, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { prepareEditorFolder, openVscode };
