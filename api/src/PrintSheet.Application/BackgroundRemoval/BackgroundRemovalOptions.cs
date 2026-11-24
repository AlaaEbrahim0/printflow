using System.ComponentModel.DataAnnotations;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>Configuration names used to pick an adapter. Not provider types.</summary>
public static class BackgroundRemovalProviders
{
    public const string WithoutBg = "withoutbg";
    public const string Poof = "poof";

    /// <summary>Deterministic local remover for flat artwork on a solid background.</summary>
    public const string Solid = "solid";

    /// <summary>Solid when applicable, then the local ML remover, then Poof.</summary>
    public const string Auto = "auto";

    public static readonly string[] All = [WithoutBg, Poof, Solid, Auto];
}

/// <summary>Bound from <c>BackgroundRemoval:Solid</c>; validated on startup.</summary>
public sealed class SolidBackgroundRemovalOptions
{
    public const string SectionName = "BackgroundRemoval:Solid";

    /// <summary>Thickness of the sampled border, in pixels.</summary>
    [Range(1, 32)]
    public int BorderWidthPx { get; init; } = 2;

    /// <summary>Maximum RGB distance (0-255) still considered background.</summary>
    [Range(0, 255)]
    public int BackgroundTolerance { get; init; } = 22;

    /// <summary>Share of border pixels that must match the estimated colour.</summary>
    [Range(0d, 1d)]
    public double MinBorderUniformity { get; init; } = 0.90;

    /// <summary>Share of border pixels allowed to be foreground (art bleeding off the edge).</summary>
    [Range(0d, 1d)]
    public double MaxBorderForegroundRatio { get; init; } = 0.02;

    [Range(0d, 1d)]
    public double MinBackgroundFraction { get; init; } = 0.05;

    [Range(0d, 1d)]
    public double MaxBackgroundFraction { get; init; } = 0.98;

    /// <summary>How far the fractional-alpha band reaches into the foreground.</summary>
    [Range(0, 32)]
    public int EdgeBandPixels { get; init; } = 3;

    /// <summary>Distance at or below which an edge pixel is fully transparent.</summary>
    [Range(0, 255)]
    public int EdgeLow { get; init; } = 10;

    /// <summary>Lower bound for the edge ramp's reference distance.</summary>
    [Range(1, 255)]
    public int EdgeReferenceFloor { get; init; } = 60;

    /// <summary>Percentile of foreground distance used as the edge ramp reference.</summary>
    [Range(0, 100)]
    public int EdgeReferencePercentile { get; init; } = 90;

    [Range(0, int.MaxValue)]
    public int MinSpeckArea { get; init; } = 12;

    public bool RemoveSpecks { get; init; } = true;
}

/// <summary>Bound from <c>BackgroundRemoval</c>; validated on startup.</summary>
public sealed class BackgroundRemovalOptions
{
    public const string SectionName = "BackgroundRemoval";

    [Required]
    public string DefaultProvider { get; init; } = BackgroundRemovalProviders.WithoutBg;

    /// <summary>Optional provider used when the primary fails for an availability reason.</summary>
    public string? FallbackProvider { get; init; }

    /// <summary>Poof rejects images above 20 MB, so this default is also its ceiling.</summary>
    [Range(1, 64 * 1024 * 1024)]
    public int MaxInputBytes { get; init; } = 20 * 1024 * 1024;

    [MinLength(1)]
    public string[] AllowedContentTypes { get; init; } =
        ["image/png", "image/jpeg", "image/webp"];

    /// <summary>Feather radius applied to the upscaled matte; 0 disables it.</summary>
    [Range(0d, 8d)]
    public double AlphaFeatherPx { get; init; } = 0.5;

    /// <summary>
    /// Pixels the finished matte is pulled inward, Photoshop's
    /// <c>Select &gt; Modify &gt; Contract</c>. The upscaler blends the original
    /// background into the outermost pixels of the subject, so an uncontracted
    /// matte keeps a pale rim that prints as a halo on a dark garment.
    /// </summary>
    [Range(0, 8)]
    public int AlphaContractPx { get; init; } = 2;

    /// <summary>Optional hard alpha cutoff (0..255). Off by default to keep soft edges.</summary>
    [Range(0, 255)]
    public int? AlphaThreshold { get; init; }

    public bool IsAllowedContentType(string? contentType)
        => contentType is not null
            && AllowedContentTypes.Any(
                allowed => string.Equals(allowed, contentType, StringComparison.OrdinalIgnoreCase));
}
