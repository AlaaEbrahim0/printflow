using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Common;
using PrintSheet.Domain.Batches;
using PrintSheet.Domain.Common;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Application.Preflight;

/// <summary>
/// Decode, check, optionally fix, check again, serialise. The report is built
/// from the final state, so a fix that did not help still shows the finding and
/// the operator sees the truth rather than an optimistic claim.
/// </summary>
public sealed class PreflightService(
    IPreflightImageCodec codec,
    PreflightRunner runner,
    IEnumerable<IPreflightFix> fixes,
    IOptions<PreflightOptions> options,
    ILogger<PreflightService> logger)
{
    private readonly PreflightOptions _options = options.Value;
    private readonly IReadOnlyList<IPreflightFix> _fixes = fixes
        .OrderBy(fix => fix.Code, StringComparer.Ordinal)
        .ToArray();

    public bool Enabled => _options.Enabled;

    public Result<PreflightOutcome> Run(
        byte[] png,
        PrintSpec? spec,
        int dpi,
        GarmentColor garment,
        string? profileName,
        bool applyFixes,
        CancellationToken cancellationToken)
    {
        var profile = ResolveProfile(profileName);
        if (profile is null)
        {
            return Result<PreflightOutcome>.Failure(
                ErrorCodes.InvalidRequest,
                $"Unknown preflight profile '{profileName}'. The configured profile is "
                + $"'{_options.Profile.Name}'.");
        }

        var image = codec.Decode(png);

        // A caller without a print size is judging the file on its own canvas;
        // the pixel dimensions and the requested DPI are all the physical context
        // that exists, and the report says so through the spec it echoes.
        spec ??= PrintSpec.FromPixels(image.Width, image.Height, dpi, garment);

        var run = runner.Run(image, spec, profile, cancellationToken);
        var applied = new List<PreflightFixRecord>();
        byte[]? fixedPng = null;

        if (applyFixes && _options.EnabledFixes.Length > 0)
        {
            var fixable = _fixes
                .Where(fix => IsEnabled(fix) && run.Findings.Any(
                    finding => fix.Addresses.Contains(finding.Code, StringComparer.Ordinal)))
                .ToArray();

            if (fixable.Length > 0)
            {
                foreach (var fix in fixable)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var context = new PreflightContext(image, spec, profile, cancellationToken);
                    image = fix.Apply(image, context, cancellationToken);
                    applied.Add(new PreflightFixRecord(fix.Code, fix.Description));
                }

                run = runner.Run(image, spec, profile, cancellationToken);
                fixedPng = codec.Encode(image);
                logger.LogInformation(
                    "Preflight applied {FixCount} fix(es): {Fixes}",
                    applied.Count,
                    string.Join(", ", applied.Select(record => record.Code)));
            }
        }

        var report = PreflightReport.Build(
            profile,
            spec,
            run.Findings,
            applied,
            run.Metrics);

        return Result<PreflightOutcome>.Success(
            new PreflightOutcome(report, fixedPng, Serialize(report)));
    }

    /// <summary>
    /// Report JSON is a contract document, so its enums are lower-case strings
    /// (`pass`, `warning`), not the numbers the default serializer would emit.
    /// Kept local to preflight so the shared application policy is unchanged.
    /// </summary>
    private static readonly JsonSerializerOptions ReportJson = new(ApplicationJson.Options)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string Serialize(PreflightReport report)
        => JsonSerializer.Serialize(report, ReportJson);

    private PreflightProfile? ResolveProfile(string? name)
        => string.IsNullOrWhiteSpace(name)
            || string.Equals(name, _options.Profile.Name, StringComparison.OrdinalIgnoreCase)
            ? _options.Profile
            : null;

    private bool IsEnabled(IPreflightFix fix)
        => _options.EnabledFixes.Contains(fix.Code, StringComparer.OrdinalIgnoreCase);
}
