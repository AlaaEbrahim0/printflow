using System.Globalization;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Infrastructure.Preflight.Checks;

/// <summary>
/// Soft edges are expected on an anti-aliased matte, but too many of them mean
/// the cut-out is a gradient, not an edge. Measured as a share of the band that
/// is allowed to be soft, so a small logo is judged the same as a large one.
/// </summary>
public sealed class SoftEdgeCheck : IPreflightCheck
{
    public string Code => "soft-edge";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var profile = context.Profile;
        var bandPx = Math.Max(1, (int)Math.Round(profile.SoftEdgeBandMm * context.PixelsPerMm));
        var pixels = context.Image.Pixels;
        var distance = context.Analysis.DistanceToTransparent;

        var band = 0;
        var soft = 0;
        for (var index = 0; index < distance.Length; index++)
        {
            var alpha = pixels[(index * 4) + 3];
            if (alpha == 0 || distance[index] > bandPx)
            {
                continue;
            }

            band++;
            if (alpha < 255)
            {
                soft++;
            }
        }

        if (band == 0)
        {
            return PreflightCheckResult.None;
        }

        var fraction = (double)soft / band;
        var metrics = new[]
        {
            PreflightSupport.Metric("soft-edge-fraction", fraction, "fraction", $"{profile.MaximumSoftEdgeFraction:F2}"),
            PreflightSupport.Metric("edge-band-px", bandPx, "px"),
        };

        if (fraction > profile.MaximumSoftEdgeFraction)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Soft edge too wide",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"{fraction:P1} of the edge band is semi-transparent; the limit is {profile.MaximumSoftEdgeFraction:P1}. The outline will look feathered on the garment."),
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>
/// Semi-transparent pixels away from the edge are trapped background or a bad
/// matte. Unlike a soft edge they cannot be justified by anti-aliasing, so this
/// one is an error.
/// </summary>
public sealed class SoftInteriorCheck : IPreflightCheck
{
    public string Code => "soft-interior";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var profile = context.Profile;
        var bandPx = Math.Max(1, (int)Math.Round(profile.SoftEdgeBandMm * context.PixelsPerMm));
        var pixels = context.Image.Pixels;
        var distance = context.Analysis.DistanceToTransparent;
        var foreground = Math.Max(1, context.Analysis.ForegroundPixels);

        var soft = 0;
        for (var index = 0; index < distance.Length; index++)
        {
            var alpha = pixels[(index * 4) + 3];
            if (alpha is > 0 and < 255 && distance[index] > bandPx)
            {
                soft++;
            }
        }

        var fraction = (double)soft / foreground;
        var metrics = new[]
        {
            PreflightSupport.Metric("soft-interior-fraction", fraction, "fraction", $"{profile.MaximumSoftInteriorFraction:F4}"),
            PreflightSupport.Metric("soft-interior-px", soft, "px"),
        };

        if (fraction > profile.MaximumSoftInteriorFraction)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Error,
                    "Transparency inside the artwork",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"{fraction:P2} of the foreground is semi-transparent away from the edge; the limit is {profile.MaximumSoftInteriorFraction:P2}. The matte is incomplete."),
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>Too much ink coverage means a stiff, heavy print and slow curing.</summary>
public sealed class CoverageCheck : IPreflightCheck
{
    public string Code => "coverage";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var analysis = context.Analysis;
        var fraction = (double)analysis.ForegroundPixels / context.Image.PixelCount;
        var metrics = new[]
        {
            PreflightSupport.Metric("coverage-fraction", fraction, "fraction", $"{context.Profile.MaximumCoverageFraction:F2}"),
        };

        if (fraction > context.Profile.MaximumCoverageFraction)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "High ink coverage",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"The artwork covers {fraction:P1} of the print area; the limit is {context.Profile.MaximumCoverageFraction:P1}."),
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>Ink within the trim margin risks being cut or pressed past the film.</summary>
public sealed class SafeMarginCheck : IPreflightCheck
{
    public string Code => "safe-margin";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var analysis = context.Analysis;
        if (analysis.Components.Count == 0)
        {
            return PreflightCheckResult.None;
        }

        var minX = analysis.Components.Min(component => component.MinX);
        var minY = analysis.Components.Min(component => component.MinY);
        var maxX = analysis.Components.Max(component => component.MaxX);
        var maxY = analysis.Components.Max(component => component.MaxY);

        var marginPx = Math.Min(
            Math.Min(minX, minY),
            Math.Min(analysis.Width - 1 - maxX, analysis.Height - 1 - maxY));
        var marginMm = marginPx / context.PixelsPerMm;
        var metrics = new[]
        {
            PreflightSupport.Metric("margin-mm", marginMm, "mm", $"{context.Profile.MinimumMarginMm:F1}"),
        };

        if (marginMm < context.Profile.MinimumMarginMm)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Artwork close to the trim edge",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"Opaque ink is {marginMm:F2} mm from the edge; the minimum margin is {context.Profile.MinimumMarginMm:F1} mm."),
                    new PreflightRegion(minX, minY, maxX - minX + 1, maxY - minY + 1),
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>
/// Many disconnected islands usually mean a broken cut-out, not a design made
/// of confetti. Specks below the island area are ignored: that is a separate,
/// more specific finding.
/// </summary>
public sealed class RegionCountCheck : IPreflightCheck
{
    public string Code => "region-count";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var minAreaPx = context.Profile.MinimumIslandAreaMm2 * context.PixelsPerMmSquared;
        var regions = context.Analysis.Components.Count(component => component.Area >= minAreaPx);
        var metrics = new[]
        {
            PreflightSupport.Metric("region-count", regions, "count", $"{context.Profile.MaximumRegions}"),
        };

        if (regions > context.Profile.MaximumRegions)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Many disconnected regions",
                    $"{regions} separate islands exceed the minimum area; the limit is {context.Profile.MaximumRegions}. Check that the background removal did not fragment the artwork.",
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}
