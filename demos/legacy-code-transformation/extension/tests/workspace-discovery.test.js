'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { discoverTarget } = require('../src/workspace-discovery');
const { isPathWithinRoot } = require('../src/workspace-scope');
const { registerDiscoveryTool } = require('../src/extension');
const { runRoslynAnalysis } = require('../src/roslyn-worker');

function makeUri(filePath, scheme = 'file', authority = '') {
  return {
    scheme,
    authority,
    fsPath: filePath,
    path: filePath.split(path.sep).join('/')
  };
}

function makeVscode(workspaceFolder, fileUris, providerResults, readPaths, confirmationResult = 'Continue with C# providers') {
  const executedCommands = [];
  const confirmationRequests = [];
  return {
    executedCommands,
    confirmationRequests,
    workspace: {
      workspaceFolders: [workspaceFolder],
      findFiles: async () => fileUris,
      fs: {
        readFile: async (uri) => {
          readPaths.push(uri.fsPath);
          return fs.readFile(uri.fsPath);
        }
      }
    },
    window: {
      showWarningMessage: async (...args) => {
        confirmationRequests.push(args);
        return confirmationResult;
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    Uri: {
      joinPath(baseUri, ...segments) {
        return makeUri(path.join(baseUri.fsPath, ...segments), baseUri.scheme, baseUri.authority);
      }
    },
    commands: {
      executeCommand: async (command) => {
        executedCommands.push(command);
        return providerResults[command] ?? [];
      }
    }
  };
}

test('extension registers the declared read-only discovery tool', () => {
  const registrations = [];
  const subscriptions = [];
  const vscode = {
    lm: {
      registerTool(name, tool) {
        const registration = { name, tool, dispose() {} };
        registrations.push(registration);
        return registration;
      }
    }
  };

  registerDiscoveryTool(vscode, { subscriptions });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'legacy_code_transformation_demo_discover_target');
  assert.equal(typeof registrations[0].tool.invoke, 'function');
  assert.equal(subscriptions[0], registrations[0]);
});

test('discovery reads and reports only files and provider results inside the selected root', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-discovery-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const rootPath = path.join(temporaryRoot, 'project');
  const outsidePath = path.join(temporaryRoot, 'sibling');
  await fs.mkdir(rootPath);
  await fs.mkdir(outsidePath);

  const targetPath = path.join(rootPath, 'Target.cs');
  const testPath = path.join(rootPath, 'TargetTests.cs');
  const outsideFilePath = path.join(outsidePath, 'External.cs');
  await fs.writeFile(targetPath, 'class Target { void Execute() {} }');
  await fs.writeFile(testPath, 'class TargetTests { void Execute() {} }');
  await fs.writeFile(outsideFilePath, 'class External { void Execute() {} }');

  const workspaceFolder = { uri: makeUri(rootPath) };
  const targetUri = makeUri(targetPath);
  const testUri = makeUri(await fs.realpath(testPath));
  const outsideUri = makeUri(await fs.realpath(outsideFilePath));
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 35 }
  };
  const callItem = { uri: targetUri, selectionRange: range };
  const readPaths = [];
  const providerResults = {
    'vscode.executeDocumentSymbolProvider': [
      { name: 'Execute', kind: 11, selectionRange: range, range, children: [] }
    ],
    'vscode.executeReferenceProvider': [
      { uri: testUri, range },
      { uri: outsideUri, range }
    ],
    'vscode.prepareCallHierarchy': [callItem],
    'vscode.provideIncomingCalls': [
      { from: { uri: testUri, selectionRange: range } },
      { from: { uri: outsideUri, selectionRange: range } }
    ],
    'vscode.provideOutgoingCalls': [
      { to: { uri: outsideUri, selectionRange: range } }
    ]
  };
  const vscode = makeVscode(workspaceFolder, [targetUri, testUri, outsideUri], providerResults, readPaths);

  const result = await discoverTarget(vscode, {
    projectRoot: rootPath,
    targetFile: targetPath,
    targetSymbol: 'Execute'
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.target.resolution, 'unique', JSON.stringify(result.target));
    assert.match(result.target.source.text, /class Target \{ void Execute\(\) \{\} \}/);
    assert.equal(result.target.source.startLine, 1);
  assert.deepEqual(result.files.sort(), ['Target.cs', 'TargetTests.cs']);
  assert.deepEqual(result.references, [{ path: 'TargetTests.cs', line: 1 }]);
  assert.deepEqual(result.incomingCalls, [{ path: 'TargetTests.cs', line: 1 }]);
  assert.deepEqual(result.outgoingCalls, []);
  const rootRealPath = await fs.realpath(rootPath);
  const readRealPaths = await Promise.all(readPaths.map((filePath) => fs.realpath(filePath)));
  assert.ok(readRealPaths.every((filePath) => isPathWithinRoot(rootRealPath, filePath)));
  assert.ok(result.textMatches.every((match) => !match.path.startsWith('../')));
});

test('declining C# project-load confirmation returns syntax-only results without invoking providers', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-csharp-decline-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const targetPath = path.join(rootPath, 'Target.cs');
  await fs.writeFile(targetPath, 'class Target { void Execute() {} }');
  const targetUri = makeUri(targetPath);
  const vscode = makeVscode(
    { uri: makeUri(rootPath) },
    [targetUri],
    {},
    [],
    'Use bounded text only'
  );

  let syntaxRequest;
  const result = await discoverTarget(vscode, {
    projectRoot: rootPath,
    targetFile: targetPath,
    targetSymbol: 'Execute'
  }, undefined, async (request) => {
    syntaxRequest = request;
    return { mode: 'syntax-only', targetCandidates: [{ path: 'Target.cs', line: 1, kind: 'method' }] };
  });

  assert.equal(result.analysisMode, 'syntax-only');
  assert.equal(result.target.resolution, 'unresolved');
  assert.deepEqual(result.target.candidates, []);
  assert.match(result.warnings[0], /confirmation was declined/);
  assert.deepEqual(vscode.executedCommands, []);
  assert.equal(result.textMatches.length, 1);
  assert.equal(syntaxRequest.files[0].path, 'Target.cs');
  assert.deepEqual(result.syntaxAnalysis.targetCandidates, [{ path: 'Target.cs', line: 1, kind: 'method' }]);
});

test('confirmed C# analysis uses the in-root project and filters Roslyn locations', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-msbuild-boundary-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const rootPath = path.join(temporaryRoot, 'project');
  const sourcePath = path.join(rootPath, 'src');
  const testPath = path.join(rootPath, 'tests');
  const outsidePath = path.join(temporaryRoot, 'sibling');
  await Promise.all([
    fs.mkdir(sourcePath, { recursive: true }),
    fs.mkdir(testPath, { recursive: true }),
    fs.mkdir(outsidePath, { recursive: true })
  ]);

  const targetPath = path.join(sourcePath, 'Target.cs');
  const projectPath = path.join(sourcePath, 'Target.csproj');
  const callerPath = path.join(testPath, 'TargetTests.cs');
  const outsideFilePath = path.join(outsidePath, 'External.cs');
  await fs.writeFile(targetPath, 'class Target { void Execute() {} }');
  await fs.writeFile(projectPath, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  await fs.writeFile(callerPath, 'class TargetTests { void Run() { new Target().Execute(); } }');
  await fs.writeFile(outsideFilePath, 'class External { void Execute() {} }');

  const targetUri = makeUri(targetPath);
  const projectUri = makeUri(projectPath);
  const callerUri = makeUri(callerPath);
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 35 } };
  const vscode = makeVscode(
    { uri: makeUri(rootPath) },
    [targetUri, projectUri, callerUri],
    {
      'vscode.executeDocumentSymbolProvider': []
    },
    []
  );
  let workerRequest;

  const result = await discoverTarget(vscode, {
    projectRoot: rootPath,
    targetFile: targetPath,
    targetSymbol: 'Execute'
  }, undefined, async (request) => {
    workerRequest = request;
    assert.equal(vscode.confirmationRequests.length, 1);
    return {
      mode: 'msbuild',
      semanticReferencesResolved: true,
      targetCandidates: [{ path: targetPath, line: 1, kind: 'method' }],
      references: [
        { path: callerPath, line: 1, kind: 'reference' },
        { path: outsideFilePath, line: 1, kind: 'reference' }
      ],
      diagnostics: []
    };
  });

  assert.equal(workerRequest.mode, 'msbuild');
  assert.equal(workerRequest.projectPath, await fs.realpath(projectPath));
  assert.equal(result.target.resolution, 'unique');
  assert.deepEqual(result.target.candidates, [
    { path: 'src/Target.cs', line: 1, kind: 'method' }
  ]);
  assert.deepEqual(result.roslynAnalysis.references, [
    { path: 'tests/TargetTests.cs', line: 1, kind: 'reference' }
  ]);
});

test('controlled pizza discovery invokes Roslyn and returns its in-root caller', async () => {
  const rootPath = path.resolve(__dirname, '..', '..', 'fixtures', 'dotnet');
  const targetPath = path.join(rootPath, 'src', 'PizzaEligibility', 'PizzaDiscountCalculator.cs');
  const projectPath = path.join(rootPath, 'src', 'PizzaEligibility', 'PizzaEligibility.csproj');
  const callerPath = path.join(rootPath, 'src', 'PizzaEligibility', 'Program.cs');
  const vscode = makeVscode(
    { uri: makeUri(rootPath) },
    [makeUri(targetPath), makeUri(projectPath), makeUri(callerPath)],
    {},
    []
  );

  const result = await discoverTarget(vscode, {
    projectRoot: rootPath,
    targetFile: targetPath,
    targetSymbol: 'CalculateDiscountAmount'
  });

  assert.equal(vscode.confirmationRequests.length, 1);
  assert.equal(result.analysisMode, 'msbuild-workspace');
  assert.equal(result.target.resolution, 'unique');
  assert.deepEqual(result.roslynAnalysis.references, [
    { path: 'src/PizzaEligibility/Program.cs', line: 12, kind: 'reference' }
  ]);
});

test('Roslyn MSBuild preflight rejects an external project reference before workspace loading', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-msbuild-preflight-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const rootPath = path.join(temporaryRoot, 'project');
  const sourcePath = path.join(rootPath, 'src');
  const outsidePath = path.join(temporaryRoot, 'outside');
  await Promise.all([
    fs.mkdir(sourcePath, { recursive: true }),
    fs.mkdir(outsidePath, { recursive: true })
  ]);
  const projectPath = path.join(sourcePath, 'Target.csproj');
  const targetPath = path.join(sourcePath, 'Target.cs');
  const outsideProjectPath = path.join(outsidePath, 'External.csproj');
  await fs.writeFile(projectPath, '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../../outside/External.csproj" /></ItemGroup></Project>');
  await fs.writeFile(targetPath, 'class Target { void Execute() {} }');
  await fs.writeFile(outsideProjectPath, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');

  const result = await runRoslynAnalysis({
    mode: 'msbuild',
    rootPath,
    projectPath,
    targetFile: targetPath,
    targetSymbol: 'Execute',
    files: []
  });

  assert.equal(result.mode, 'unsupported');
  assert.equal(result.semanticReferencesResolved, false);
  assert.match(result.diagnostics[0], /outside the selected root/);
});

test('discovery rejects a project root that is not an open workspace folder', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lcta-unopened-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const openPath = path.join(temporaryRoot, 'open');
  const closedPath = path.join(temporaryRoot, 'closed');
  await fs.mkdir(openPath);
  await fs.mkdir(closedPath);
  const vscode = makeVscode({ uri: makeUri(openPath) }, [], {}, []);

  await assert.rejects(
    discoverTarget(vscode, {
      projectRoot: closedPath,
      targetFile: path.join(closedPath, 'Target.cs'),
      targetSymbol: 'Execute'
    }),
    /must match an open VS Code workspace folder/
  );
});
