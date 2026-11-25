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

    /// <summary>
    /// Hard ceiling on how far the edge ramp may reach while it is still
    /// incomplete. <see cref="EdgeBandPixels"/> is only the floor: a soft source
    /// spreads the transition over more pixels, and cutting the ramp off at the
    /// floor left a fully opaque near-background pixel immediately outside it,
    /// which prints as a dirty outline.
    ///
    /// The default is deliberately generous. The ramp is upscaled with the
    /// artwork, so a source with a 3 px transition becomes a 12 px one at 4x and
    /// a 24 px one at 8x; measured on a 2.5 px-blurred ring upscaled 4x, the
    /// transition spans exactly 12 px, so a ceiling of 12 stopped one pixel short
    /// and still left an opaque <c>(115,115,115)</c> ring. This bound only stops a
    /// design whose ink is close to the background colour from being flooded —
    /// the ramp still terminates as soon as a pixel reaches the reference
    /// distance, so a generous ceiling costs nothing on ordinary artwork.
    /// </summary>
    [Range(0, 64)]
    public int MaxEdgeBandPixels { get; init; } = 32;

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

    /// <summary>
    /// Clears background-coloured regions enclosed by artwork — the inside of an
    /// <c>o</c>, the bowls of a <c>B</c> — when the caller does not choose. Off by
    /// default: it is only right when those areas really are background, and a
    /// design whose ink matches the background colour loses the ink instead.
    /// </summary>
    public bool RemoveEnclosedBackgroundByDefault { get; init; }

    /// <summary>
    /// Smallest enclosed region the pass will clear. 64 px is 0.5 mm² at 300 DPI,
    /// the same floor preflight uses for a printable hole, so a dark dot that is
    /// part of the design is never mistaken for a counter.
    /// </summary>
    [Range(1, int.MaxValue)]
    public int MinCounterAreaPx { get; init; } = 64;

    /// <summary>
    /// Safety cap: a single enclosed region larger than this share of the image
    /// makes the pass refuse and report it. A design whose ink is the background
    /// colour (a black logo on black) is otherwise gutted. Measured per region, not
    /// on the total: a white "Bo8" on black is five legitimate counters adding up
    /// to 15% of the canvas, while an inverted logo is one region the size of the
    /// design.
    /// </summary>
    [Range(0.001d, 1d)]
    public double MaxCounterAreaFraction { get; init; } = 0.10;

    /// <summary>How far the rebuilt soft ramp reaches into the artwork around a counter.</summary>
    [Range(0, 32)]
    public int CounterEdgeBandPixels { get; init; } = 3;

    /// <summary>
    /// Hard ceiling on the counter ramp's reach while it is still incomplete, for
    /// the same reason <see cref="SolidBackgroundRemovalOptions.MaxEdgeBandPixels"/>
    /// exists: a fixed floor truncates a soft transition and leaves an opaque
    /// near-background ring around the counter.
    /// </summary>
    [Range(0, 64)]
    public int CounterMaxEdgeBandPixels { get; init; } = 32;

    /// <summary>Distance at or below which a counter's edge pixel is fully transparent.</summary>
    [Range(0, 255)]
    public int CounterEdgeLow { get; init; } = 10;

    /// <summary>Lower bound for the counter edge ramp's reference distance.</summary>
    [Range(1, 255)]
    public int CounterEdgeReferenceFloor { get; init; } = 60;

    /// <summary>Percentile of artwork distance used as the counter edge ramp reference.</summary>
    [Range(0, 100)]
    public int CounterEdgeReferencePercentile { get; init; } = 90;

    /// <summary>Maximum RGB distance (0-255) still considered the background colour.</summary>
    [Range(0, 255)]
    public int CounterBackgroundTolerance { get; init; } = 22;

    /// <summary>
    /// Share of the transparent border that must match the sampled key before the
    /// pass trusts it. When the remover reports no background colour, the key is
    /// recovered from that border; a soft, blended rim is not a keyable background.
    /// </summary>
    [Range(0.5d, 1d)]
    public double MinCounterKeyUniformity { get; init; } = 0.90;

    public bool IsAllowedContentType(string? contentType)
        => contentType is not null
            && AllowedContentTypes.Any(
                allowed => string.Equals(allowed, contentType, StringComparison.OrdinalIgnoreCase));
}
