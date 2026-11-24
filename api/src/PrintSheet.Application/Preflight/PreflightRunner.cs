using Microsoft.Extensions.Logging;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Application.Preflight;

/// <summary>
/// Runs every registered check against one image. A check that throws must not
/// lose the other fourteen results, so its failure becomes a warning finding and
/// the run continues. Cancellation is the one exception that propagates.
/// </summary>
public sealed class PreflightRunner(
    IEnumerable<IPreflightCheck> checks,
    ILogger<PreflightRunner> logger)
{
    public const string CheckFailedCode = "check-failed";

    private readonly IReadOnlyList<IPreflightCheck> _checks = checks
        .OrderBy(check => check.Code, StringComparer.Ordinal)
        .ToArray();

    public PreflightRun Run(
        PreflightImage image,
        PrintSpec spec,
        PreflightProfile profile,
        CancellationToken cancellationToken)
    {
        var context = new PreflightContext(image, spec, profile, cancellationToken);
        var findings = new List<PreflightFinding>();
        var metrics = new List<PreflightMetric>();

        foreach (var check in _checks)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                var result = check.Run(context, cancellationToken);
                findings.AddRange(result.Findings);
                metrics.AddRange(result.Metrics);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(
                    exception,
                    "Preflight check {CheckCode} failed; reporting it and continuing.",
                    check.Code);
                findings.Add(
                    new PreflightFinding(
                        CheckFailedCode,
                        PreflightSeverity.Warning,
                        "Check failed",
                        $"The '{check.Code}' check could not finish: {exception.Message}",
                        null,
                        []));
            }
        }

        // A check may emit several findings (contrast emits one per colour); the
        // stable order is code, then the region it points at, then the message.
        var ordered = findings
            .OrderBy(finding => finding.Code, StringComparer.Ordinal)
            .ThenBy(finding => finding.Region?.Y ?? -1)
            .ThenBy(finding => finding.Region?.X ?? -1)
            .ThenBy(finding => finding.Message, StringComparer.Ordinal)
            .ToArray();

        return new PreflightRun(ordered, metrics);
    }
}

public sealed record PreflightRun(
    IReadOnlyList<PreflightFinding> Findings,
    IReadOnlyList<PreflightMetric> Metrics);
