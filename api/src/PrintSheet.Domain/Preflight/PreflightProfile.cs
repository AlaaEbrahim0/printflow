namespace PrintSheet.Domain.Preflight;

/// <summary>
/// The DTF shop's thresholds, in millimetres, fractions and ratios rather than
/// pixels, so the same profile is meaningful at 200 and 600 DPI. Defaults come
/// from the production checklist; every value is operator-configurable and the
/// profile refuses to run when the numbers contradict each other.
/// </summary>
public sealed record PreflightProfile
{
    public const string DefaultName = "dtf";

    public string Name { get; init; } = DefaultName;

    /// <summary>Below this effective resolution the job is an error, not a warning.</summary>
    public int MinimumDpi { get; init; } = 200;

    /// <summary>At or above this the resolution check is silent.</summary>
    public int RecommendedDpi { get; init; } = 300;

    /// <summary>Share of edge-band pixels allowed to be partially transparent.</summary>
    public double MaximumSoftEdgeFraction { get; init; } = 0.12;

    /// <summary>Share of interior foreground pixels allowed to be partially transparent.</summary>
    public double MaximumSoftInteriorFraction { get; init; } = 0.005;

    /// <summary>How far the soft-edge band reaches into the artwork, in millimetres.</summary>
    public double SoftEdgeBandMm { get; init; } = 0.3;

    /// <summary>Thinner strokes warn below this width.</summary>
    public double MinimumStrokeMm { get; init; } = 0.5;

    /// <summary>Thinner strokes are errors: the film cannot hold them.</summary>
    public double CriticalStrokeMm { get; init; } = 0.25;

    /// <summary>Two shapes closer than this will bleed together on the garment.</summary>
    public double MinimumGapMm { get; init; } = 0.5;

    /// <summary>Isolated opaque areas smaller than this are lost or flake off.</summary>
    public double MinimumIslandAreaMm2 { get; init; } = 1.0;

    /// <summary>Enclosed transparent areas smaller than this hold trapped air.</summary>
    public double MinimumHoleAreaMm2 { get; init; } = 0.5;

    /// <summary>Minimum WCAG contrast between the ink and the garment.</summary>
    public double MinimumContrastRatio { get; init; } = 1.5;

    /// <summary>
    /// Ink opacities the contrast is judged at. DTF ink is laid down at partial
    /// opacity on purpose, so a colour can pass at 100% and vanish at 25%.
    /// Left null so configuration replaces the default instead of appending to it
    /// (the .NET binder appends to a non-empty array).
    /// </summary>
    public double[]? ContrastOpacities { get; init; }

    /// <summary>The configured opacities, or the DTF defaults when none were set.</summary>
    public IReadOnlyList<double> EffectiveContrastOpacities
        => ContrastOpacities is { Length: > 0 } configured
            ? configured
            : [0.25, 0.60];

    /// <summary>Maximum share of the print area the artwork may cover.</summary>
    public double MaximumCoverageFraction { get; init; } = 0.60;

    /// <summary>More disconnected islands than this usually means a broken cutout.</summary>
    public int MaximumRegions { get; init; } = 10;

    /// <summary>Opaque ink closer than this to the trim edge risks being cut.</summary>
    public double MinimumMarginMm { get; init; } = 1.0;

    /// <summary>How many dominant colours the contrast check samples.</summary>
    public int DominantColorCount { get; init; } = 5;

    /// <summary>Colours covering less than this share are ignored by the contrast check.</summary>
    public double DominantColorMinimumFraction { get; init; } = 0.05;

    /// <summary>
    /// Cross-field rules that data annotations cannot express. Returns one
    /// operator-facing message per contradiction; an empty list means valid.
    /// </summary>
    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();

        if (string.IsNullOrWhiteSpace(Name))
        {
            errors.Add("Preflight profile needs a name.");
        }

        if (MinimumDpi is < PrintSpec.MinimumDpi or > PrintSpec.MaximumDpi)
        {
            errors.Add($"Preflight MinimumDpi must be between {PrintSpec.MinimumDpi} and {PrintSpec.MaximumDpi}.");
        }

        if (RecommendedDpi < MinimumDpi)
        {
            errors.Add("Preflight RecommendedDpi must not be below MinimumDpi.");
        }

        if (CriticalStrokeMm <= 0 || CriticalStrokeMm >= MinimumStrokeMm)
        {
            errors.Add("Preflight CriticalStrokeMm must be positive and below MinimumStrokeMm.");
        }

        if (MinimumGapMm <= 0)
        {
            errors.Add("Preflight MinimumGapMm must be positive.");
        }

        if (MinimumIslandAreaMm2 <= 0 || MinimumHoleAreaMm2 <= 0)
        {
            errors.Add("Preflight island and hole area limits must be positive.");
        }

        if (MinimumContrastRatio is < 1 or > 21)
        {
            errors.Add("Preflight MinimumContrastRatio must be between 1 and 21.");
        }

        if (EffectiveContrastOpacities.Count == 0
            || EffectiveContrastOpacities.Any(value => value is <= 0 or > 1))
        {
            errors.Add("Preflight ContrastOpacities must contain fractions in (0, 1].");
        }

        foreach (var (name, value) in new (string, double)[]
        {
            (nameof(MaximumSoftEdgeFraction), MaximumSoftEdgeFraction),
            (nameof(MaximumSoftInteriorFraction), MaximumSoftInteriorFraction),
            (nameof(MaximumCoverageFraction), MaximumCoverageFraction),
        })
        {
            if (value is <= 0 or > 1)
            {
                errors.Add($"Preflight {name} must be a fraction in (0, 1].");
            }
        }

        if (MaximumRegions <= 0)
        {
            errors.Add("Preflight MaximumRegions must be positive.");
        }

        if (MinimumMarginMm < 0 || SoftEdgeBandMm <= 0)
        {
            errors.Add("Preflight MinimumMarginMm must not be negative and SoftEdgeBandMm must be positive.");
        }

        if (DominantColorCount <= 0 || DominantColorMinimumFraction is <= 0 or > 1)
        {
            errors.Add("Preflight dominant-colour limits must be positive.");
        }

        return errors;
    }
}
