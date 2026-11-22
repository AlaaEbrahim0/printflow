using System.ComponentModel.DataAnnotations;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>Configuration names used to pick an adapter. Not provider types.</summary>
public static class BackgroundRemovalProviders
{
    public const string WithoutBg = "withoutbg";
    public const string Poof = "poof";

    public static readonly string[] All = [WithoutBg, Poof];
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

    /// <summary>
    /// Largest image sent to a provider, in pixels; larger crops are downscaled
    /// first and the returned matte is scaled back up. Both models compute the
    /// matte at their own low internal resolution, so a print-size upload only
    /// costs time: a 16.9 MP crop took ~6x longer than a 2.7 MP one and blew
    /// through the provider timeout, which surfaced as a cutout stuck retrying.
    /// </summary>
    [Range(1, int.MaxValue)]
    public int ProviderMaxInputPixels { get; init; } = 1_000_000;

    public bool IsAllowedContentType(string? contentType)
        => contentType is not null
            && AllowedContentTypes.Any(
                allowed => string.Equals(allowed, contentType, StringComparison.OrdinalIgnoreCase));
}
