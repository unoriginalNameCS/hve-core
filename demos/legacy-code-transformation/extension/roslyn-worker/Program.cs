using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.MSBuild;

var options = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
};

try
{
    var input = await Console.In.ReadToEndAsync();
    var request = JsonSerializer.Deserialize<AnalysisRequest>(input, options)
        ?? throw new InvalidOperationException("An analysis request is required.");
    var result = request.Mode switch
    {
        "syntax" => AnalyzeSyntax(request),
        "msbuild" => await AnalyzeMsBuildAsync(request),
        _ => throw new ArgumentException("The analysis mode is not supported.")
    };
    Console.Write(JsonSerializer.Serialize(result, options));
}
catch (Exception exception)
{
    Console.Write(JsonSerializer.Serialize(new { error = exception.Message }, options));
    Environment.ExitCode = 1;
}

static SyntaxAnalysis AnalyzeSyntax(AnalysisRequest request)
{
    if (string.IsNullOrWhiteSpace(request.TargetSymbol))
    {
        throw new ArgumentException("A target symbol is required.");
    }

    var trees = request.Files
        .Where(file => file.Path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
        .Select(file => CSharpSyntaxTree.ParseText(file.Content, path: file.Path))
        .ToArray();
    var roots = trees.Select(tree => tree.GetRoot()).ToArray();
    var targetCandidates = roots
        .SelectMany(root => root.DescendantNodesAndSelf())
        .Select(node => new { Node = node, Kind = GetDeclarationKind(node, request.TargetSymbol) })
        .Where(candidate => candidate.Kind is not null)
        .Select(candidate => ToNodeLocation(candidate.Node, candidate.Kind!))
        .ToArray();
    var syntacticMatches = roots
        .SelectMany(root => root.DescendantNodes().OfType<SimpleNameSyntax>())
        .Where(name => name.Identifier.ValueText == request.TargetSymbol)
        .Select(name => ToNodeLocation(name, "name-match"))
        .DistinctBy(location => (location.Path, location.Line))
        .ToArray();
    var diagnostics = trees
        .SelectMany(tree => tree.GetDiagnostics())
        .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
        .Take(50)
        .Select(diagnostic => new SyntaxDiagnostic(
            diagnostic.Location.SourceTree?.FilePath ?? string.Empty,
            diagnostic.Location.GetLineSpan().StartLinePosition.Line + 1,
            diagnostic.GetMessage()))
        .ToArray();

    return new SyntaxAnalysis("syntax-only", targetCandidates, syntacticMatches, diagnostics);
}

static async Task<object> AnalyzeMsBuildAsync(AnalysisRequest request)
{
    if (string.IsNullOrWhiteSpace(request.RootPath) ||
        string.IsNullOrWhiteSpace(request.ProjectPath) ||
        string.IsNullOrWhiteSpace(request.TargetFile))
    {
        throw new ArgumentException("Root, project, and target paths are required for MSBuild analysis.");
    }

    var rootPath = Path.GetFullPath(request.RootPath);
    var projectPath = Path.GetFullPath(request.ProjectPath);
    var targetPath = Path.GetFullPath(request.TargetFile);
    if (!IsPathWithinRoot(rootPath, projectPath) || !IsPathWithinRoot(rootPath, targetPath))
    {
        return Unsupported("The selected project or target resolves outside the selected root.");
    }

    var propsPath = FindNearestBuildFile(Path.GetDirectoryName(projectPath)!, rootPath, "Directory.Build.props");
    var targetsPath = FindNearestBuildFile(Path.GetDirectoryName(projectPath)!, rootPath, "Directory.Build.targets");
    var preflight = ValidateProjectGraph(projectPath, rootPath, propsPath, targetsPath);
    if (preflight.Diagnostic is not null)
    {
        return Unsupported(preflight.Diagnostic);
    }

    if (!MSBuildLocator.IsRegistered)
    {
        MSBuildLocator.RegisterDefaults();
    }

    var workspaceProperties = new Dictionary<string, string>
    {
        ["DirectoryBuildPropsPath"] = propsPath ?? string.Empty,
        ["DirectoryBuildTargetsPath"] = targetsPath ?? string.Empty
    };
    var diagnostics = new List<string>();
    using var workspace = MSBuildWorkspace.Create(workspaceProperties);
    workspace.RegisterWorkspaceFailedHandler(eventArgs => diagnostics.Add(eventArgs.Diagnostic.Message));

    var project = await workspace.OpenProjectAsync(projectPath);
    var document = project.Documents.FirstOrDefault(candidate =>
        candidate.FilePath is not null && PathsEqual(candidate.FilePath, targetPath));
    if (document is null)
    {
        return new MsBuildAnalysis("msbuild", false, [], [], [.. diagnostics, "The target file was not part of the loaded project."]);
    }

    var syntaxRoot = await document.GetSyntaxRootAsync();
    var semanticModel = await document.GetSemanticModelAsync();
    if (syntaxRoot is null || semanticModel is null)
    {
        return new MsBuildAnalysis("msbuild", false, [], [], [.. diagnostics, "Roslyn could not create a semantic model for the target file."]);
    }

    var candidates = syntaxRoot.DescendantNodesAndSelf()
        .Where(node => GetDeclarationKind(node, request.TargetSymbol) is not null)
        .Select(node => new { Node = node, Symbol = GetDeclaredSymbol(semanticModel, node) })
        .Where(candidate => candidate.Symbol is not null)
        .ToArray();
    var targetCandidates = candidates
        .Select(candidate => ToNodeLocation(candidate.Node, GetDeclarationKind(candidate.Node, request.TargetSymbol)!))
        .ToArray();
    if (candidates.Length != 1)
    {
        return new MsBuildAnalysis("msbuild", false, targetCandidates, [], [.. diagnostics, "The target symbol did not resolve uniquely in the project."]);
    }

    var references = await SymbolFinder.FindReferencesAsync(candidates[0].Symbol!, project.Solution);
    var referenceLocations = references
        .SelectMany(reference => reference.Locations)
        .Where(location => location.Document.FilePath is not null)
        .Select(location => ToReferenceLocation(location.Location, location.Document.FilePath!))
        .ToArray();

    return new MsBuildAnalysis("msbuild", true, targetCandidates, referenceLocations, diagnostics.ToArray());
}

static ProjectPreflight ValidateProjectGraph(
    string projectPath,
    string rootPath,
    string? propsPath,
    string? targetsPath)
{
    var pending = new Queue<string>();
    var visited = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
    pending.Enqueue(projectPath);
    if (propsPath is not null)
    {
        pending.Enqueue(propsPath);
    }
    if (targetsPath is not null)
    {
        pending.Enqueue(targetsPath);
    }

    while (pending.TryDequeue(out var path))
    {
        var fullPath = Path.GetFullPath(path);
        if (!IsPathWithinRoot(rootPath, fullPath))
        {
            return new ProjectPreflight("An imported project file resolves outside the selected root.");
        }
        if (!visited.Add(fullPath))
        {
            continue;
        }

        XDocument document;
        try
        {
            using var reader = XmlReader.Create(fullPath, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null
            });
            document = XDocument.Load(reader);
        }
        catch (Exception exception) when (exception is IOException or XmlException or UnauthorizedAccessException)
        {
            return new ProjectPreflight($"A project file could not be safely inspected: {Path.GetFileName(fullPath)}.");
        }

        if (document.Descendants().Any(element => element.Name.LocalName == "Import"))
        {
            return new ProjectPreflight("Explicit project imports are unsupported by the root-bound MSBuild preflight.");
        }

        foreach (var task in document.Descendants().Where(element => element.Name.LocalName == "UsingTask"))
        {
            var assemblyFile = task.Attribute("AssemblyFile")?.Value;
            if (string.IsNullOrWhiteSpace(assemblyFile) ||
                assemblyFile.Contains('$') ||
                assemblyFile.Contains('*') ||
                assemblyFile.Contains('?'))
            {
                return new ProjectPreflight("A task registration does not identify a static, root-bound assembly file.");
            }

            var taskAssemblyPath = Path.GetFullPath(assemblyFile, Path.GetDirectoryName(fullPath)!);
            if (!IsPathWithinRoot(rootPath, taskAssemblyPath))
            {
                return new ProjectPreflight("A task assembly resolves outside the selected root.");
            }
        }

        foreach (var item in document.Descendants().Where(element =>
                     element.Name.LocalName is "ProjectReference" or "Compile"))
        {
            var include = item.Attribute("Include")?.Value;
            if (string.IsNullOrWhiteSpace(include))
            {
                continue;
            }
            if (include.Contains('$') || include.Contains('*') || include.Contains('?') || include.Contains(';'))
            {
                return new ProjectPreflight("A project or source include uses a dynamic path that cannot be proven root-bound.");
            }

            var includedPath = Path.GetFullPath(include, Path.GetDirectoryName(fullPath)!);
            if (!IsPathWithinRoot(rootPath, includedPath))
            {
                return new ProjectPreflight("A project or source include resolves outside the selected root.");
            }
            if (item.Name.LocalName == "ProjectReference")
            {
                if (!File.Exists(includedPath))
                {
                    return new ProjectPreflight("A referenced project file could not be found inside the selected root.");
                }
                pending.Enqueue(includedPath);
            }
        }
    }

    return new ProjectPreflight(null);
}

static string? FindNearestBuildFile(string projectDirectory, string rootPath, string fileName)
{
    var current = new DirectoryInfo(projectDirectory);
    while (current is not null && IsPathWithinRoot(rootPath, current.FullName))
    {
        var candidate = Path.Combine(current.FullName, fileName);
        if (File.Exists(candidate))
        {
            return candidate;
        }
        if (PathsEqual(current.FullName, rootPath))
        {
            break;
        }
        current = current.Parent;
    }
    return null;
}

static bool IsPathWithinRoot(string rootPath, string candidatePath)
{
    var relativePath = Path.GetRelativePath(rootPath, candidatePath);
    return relativePath == "." ||
        (relativePath != ".." &&
         !relativePath.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) &&
         !Path.IsPathRooted(relativePath));
}

static bool PathsEqual(string left, string right) => string.Equals(
    Path.GetFullPath(left),
    Path.GetFullPath(right),
    OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

static object Unsupported(string diagnostic) => new MsBuildAnalysis("unsupported", false, [], [], [diagnostic]);

static ISymbol? GetDeclaredSymbol(SemanticModel model, SyntaxNode node) => node switch
{
    MethodDeclarationSyntax method => model.GetDeclaredSymbol(method),
    LocalFunctionStatementSyntax function => model.GetDeclaredSymbol(function),
    ClassDeclarationSyntax @class => model.GetDeclaredSymbol(@class),
    StructDeclarationSyntax @struct => model.GetDeclaredSymbol(@struct),
    InterfaceDeclarationSyntax @interface => model.GetDeclaredSymbol(@interface),
    RecordDeclarationSyntax record => model.GetDeclaredSymbol(record),
    _ => null
};

static SyntaxLocation ToReferenceLocation(Location location, string path)
{
    var line = location.GetLineSpan().StartLinePosition.Line + 1;
    return new SyntaxLocation(path, line, "reference");
}

static string? GetDeclarationKind(SyntaxNode node, string targetSymbol) => node switch
{
    MethodDeclarationSyntax method when method.Identifier.ValueText == targetSymbol => "method",
    LocalFunctionStatementSyntax function when function.Identifier.ValueText == targetSymbol => "local-function",
    ClassDeclarationSyntax @class when @class.Identifier.ValueText == targetSymbol => "class",
    StructDeclarationSyntax @struct when @struct.Identifier.ValueText == targetSymbol => "struct",
    InterfaceDeclarationSyntax @interface when @interface.Identifier.ValueText == targetSymbol => "interface",
    RecordDeclarationSyntax record when record.Identifier.ValueText == targetSymbol => "record",
    _ => null
};

static SyntaxLocation ToNodeLocation(SyntaxNode node, string kind)
{
    var line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
    return new SyntaxLocation(node.SyntaxTree.FilePath, line, kind);
}

internal sealed record AnalysisRequest(
    string Mode,
    string TargetSymbol,
    string? RootPath,
    string? ProjectPath,
    string? TargetFile,
    SourceFile[] Files);
internal sealed record ProjectPreflight(string? Diagnostic);
internal sealed record SourceFile(string Path, string Content);
internal sealed record SyntaxAnalysis(
    string Mode,
    SyntaxLocation[] TargetCandidates,
    SyntaxLocation[] SyntacticMatches,
    SyntaxDiagnostic[] Diagnostics);
internal sealed record SyntaxLocation(string Path, int Line, string Kind);
internal sealed record SyntaxDiagnostic(string Path, int Line, string Message);
internal sealed record MsBuildAnalysis(
    string Mode,
    bool SemanticReferencesResolved,
    SyntaxLocation[] TargetCandidates,
    SyntaxLocation[] References,
    string[] Diagnostics);
