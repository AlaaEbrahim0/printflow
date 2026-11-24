namespace PrintSheet.Domain.Preflight;

public enum PreflightSeverity
{
    Info,
    Warning,
    Error,
}

public enum PreflightVerdict
{
    Pass,
    Warn,
    Fail,
}

/// <summary>A pixel rectangle in the version's own coordinates.</summary>
public sealed record PreflightRegion(int X, int Y, int Width, int Height);

/// <summary>
/// One measured value with its unit and the limit it was compared against. The
/// number is kept so the operator can see how far past the line a finding is,
/// not just that it failed.
/// </summary>
public sealed record PreflightMetric(string Name, decimal Value, string Unit, string? Limit = null);

public sealed record PreflightFinding(
    string Code,
    PreflightSeverity Severity,
    string Title,
    string Message,
    PreflightRegion? Region,
    IReadOnlyList<PreflightMetric> Metrics);

public sealed record PreflightFixRecord(string Code, string Description);

public sealed record PreflightSpecSummary(
    decimal WidthCm,
    decimal HeightCm,
    int Dpi,
    string GarmentColor);

/// <summary>
/// The stable document written next to a cut-out and returned by the preflight
/// endpoint. Property order is the serialisation order, findings and fixes are
/// sorted by code, and nothing time- or machine-dependent is included, so the
/// same input always produces the same bytes.
/// </summary>
public sealed record PreflightReport(
    string SchemaVersion,
    string Profile,
    PreflightSpecSummary Spec,
    PreflightVerdict Verdict,
    IReadOnlyList<PreflightFinding> Findings,
    IReadOnlyList<PreflightFixRecord> Fixes,
    IReadOnlyList<PreflightMetric> Metrics)
{
    public const string CurrentSchemaVersion = "1.0";

    public static PreflightReport Build(
        PreflightProfile profile,
        PrintSpec spec,
        IReadOnlyList<PreflightFinding> findings,
        IReadOnlyList<PreflightFixRecord> fixes,
        IReadOnlyList<PreflightMetric> metrics)
    {
        var verdict = findings.Any(finding => finding.Severity == PreflightSeverity.Error)
            ? PreflightVerdict.Fail
            : findings.Any(finding => finding.Severity == PreflightSeverity.Warning)
                ? PreflightVerdict.Warn
                : PreflightVerdict.Pass;

        return new PreflightReport(
            CurrentSchemaVersion,
            profile.Name,
            new PreflightSpecSummary(
                spec.WidthCm,
                spec.HeightCm,
                spec.Dpi,
                spec.Garment.Kind.ToString().ToLowerInvariant()),
            verdict,
            findings,
            fixes,
            metrics);
    }
}
