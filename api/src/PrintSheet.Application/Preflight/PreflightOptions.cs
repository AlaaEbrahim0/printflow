using Microsoft.Extensions.Options;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Application.Preflight;

/// <summary>Stable fix identifiers, also used in configuration and report JSON.</summary>
public static class PreflightFixCodes
{
    public const string RemoveIslands = "remove-islands";
    public const string FillHoles = "fill-holes";
    public const string SetDpiMetadata = "set-dpi-metadata";
    public const string EmbedSrgb = "embed-srgb";
    public const string HardenSoftInterior = "harden-soft-interior";

    public static readonly string[] All =
        [RemoveIslands, FillHoles, SetDpiMetadata, EmbedSrgb, HardenSoftInterior];
}

/// <summary>
/// Bound from <c>Preflight</c>. Thresholds are configurable but the report is
/// only as good as their consistency, so the profile is validated on startup.
/// </summary>
public sealed class PreflightOptions
{
    public const string SectionName = "Preflight";

    /// <summary>
    /// False skips preflight entirely, including the cut-out report. It is on by
    /// default because the report is cheap and the shop needs it before printing.
    /// </summary>
    public bool Enabled { get; init; } = true;

    public PreflightProfile Profile { get; init; } = new();

    /// <summary>
    /// Fixes an API caller may request. Report-only is still the default; this
    /// list only bounds what <c>fix: true</c> is allowed to do.
    /// </summary>
    public string[] EnabledFixes { get; init; } = PreflightFixCodes.All;
}

public sealed class PreflightOptionsValidator : IValidateOptions<PreflightOptions>
{
    public ValidateOptionsResult Validate(string? name, PreflightOptions options)
    {
        var errors = options.Profile.Validate().ToList();

        foreach (var fix in options.EnabledFixes)
        {
            if (!PreflightFixCodes.All.Contains(fix, StringComparer.OrdinalIgnoreCase))
            {
                errors.Add($"Preflight:EnabledFixes contains unknown fix '{fix}'.");
            }
        }

        return errors.Count == 0
            ? ValidateOptionsResult.Success
            : ValidateOptionsResult.Fail(errors);
    }
}
