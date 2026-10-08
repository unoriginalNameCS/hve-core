'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 60_000;
const PROJECT_PATH = path.join(
  __dirname,
  '..',
  'roslyn-worker',
  'LegacyCodeTransformation.RoslynWorker.csproj'
);

function runRoslynAnalysis(request, token) {
  const requestJson = JSON.stringify(request);
  if (Buffer.byteLength(requestJson, 'utf8') > MAX_REQUEST_BYTES) {
    return Promise.reject(new Error('The selected C# source exceeds the syntax-analysis size limit.'));
  }

  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) {
      reject(new Error('Syntax analysis was cancelled.'));
      return;
    }

    const executable = process.env.DOTNET_HOST_PATH || (process.platform === 'win32'
      ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet', 'dotnet.exe')
      : 'dotnet');
    const child = spawn(executable, [
      'run',
      '--project', PROJECT_PATH,
      '--no-launch-profile',
      '--verbosity', 'quiet'
    ], {
      cwd: path.dirname(PROJECT_PATH),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exitFallback;
    const cancellation = token?.onCancellationRequested(() => child.kill());
    const timeout = setTimeout(() => {
      child.kill();
      settle(reject, new Error('Roslyn analysis exceeded the 60-second limit.'));
    }, WORKER_TIMEOUT_MS);

    function settle(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(exitFallback);
      cancellation?.dispose();
      callback(value);
    }

    function complete(code) {
      if (settled) {
        return;
      }
      if (code !== 0) {
        settle(reject, new Error(stderr.trim() || `Roslyn analysis exited with code ${code}.`));
        return;
      }
      try {
        settle(resolve, JSON.parse(stdout));
      } catch {
        settle(reject, new Error('Roslyn analysis returned invalid JSON.'));
      }
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_RESPONSE_BYTES) {
        child.kill();
        settle(reject, new Error('Roslyn syntax analysis returned too much data.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => settle(reject, error));
    child.on('exit', (code) => {
      exitFallback = setTimeout(() => {
        complete(code);
        child.stdout.destroy();
        child.stderr.destroy();
      }, 100);
    });
    child.on('close', complete);
    child.stdin.end(requestJson);
  });
}

module.exports = { runRoslynAnalysis };
