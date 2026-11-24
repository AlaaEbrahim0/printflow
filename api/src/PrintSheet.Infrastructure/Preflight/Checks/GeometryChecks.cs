using System.Globalization;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Infrastructure.Preflight.Checks;

/// <summary>
/// Thinnest stroke, measured on the medial axis: a pixel is on the ridge when no
/// neighbour is farther from the background, and its stroke is twice that
/// distance. Isolated specks are ignored here; the island check owns them.
/// </summary>
public sealed class StrokeCheck : IPreflightCheck
{
    public string Code => "stroke-width";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var analysis = context.Analysis;
        var minAreaPx = context.Profile.MinimumIslandAreaMm2 * context.PixelsPerMmSquared;
        var areas = new int[analysis.Components.Count + 1];
        foreach (var component in analysis.Components)
        {
            areas[component.Label] = component.Area;
        }

        var width = analysis.Width;
        var height = analysis.Height;
        var opaque = analysis.Opaque;
        var labels = analysis.Labels;
        var distance = analysis.DistanceToTransparent;

        var thinnest = int.MaxValue;
        var thinnestIndex = -1;

        for (var y = 0; y < height; y++)
        {
            if ((y & 63) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                var index = row + x;
                if (!opaque[index])
                {
                    continue;
                }

                var label = labels[index];
                if (areas[label] < minAreaPx)
                {
                    continue;
                }

                var value = distance[index];
                if (value == 0 || value >= thinnest)
                {
                    continue;
                }

                if (!IsRidge(distance, width, height, x, y, value))
                {
                    continue;
                }

                thinnest = value;
                thinnestIndex = index;
            }
        }

        if (thinnestIndex < 0)
        {
            return PreflightCheckResult.None;
        }

        var strokeMm = (2 * thinnest) / context.PixelsPerMm;
        var metrics = new[]
        {
            PreflightSupport.Metric("thinnest-stroke-mm", strokeMm, "mm", $"{context.Profile.MinimumStrokeMm:F2}"),
        };

        var region = new PreflightRegion(
            thinnestIndex % width,
            thinnestIndex / width,
            1,
            1);

        if (strokeMm < context.Profile.CriticalStrokeMm)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Error,
                    "Stroke too thin to print",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"The thinnest stroke is {strokeMm:F2} mm; below {context.Profile.CriticalStrokeMm:F1} mm the film cannot hold it."),
                    region,
                    metrics),
                metrics);
        }

        if (strokeMm < context.Profile.MinimumStrokeMm)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Thin stroke",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"The thinnest stroke is {strokeMm:F2} mm; the shop minimum is {context.Profile.MinimumStrokeMm:F1} mm."),
                    region,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }

    private static bool IsRidge(byte[] distance, int width, int height, int x, int y, byte value)
    {
        for (var dy = -1; dy <= 1; dy++)
        {
            var ny = y + dy;
            if (ny < 0 || ny >= height)
            {
                continue;
            }

            for (var dx = -1; dx <= 1; dx++)
            {
                if (dx == 0 && dy == 0)
                {
                    continue;
                }

                var nx = x + dx;
                if (nx < 0 || nx >= width)
                {
                    continue;
                }

                if (distance[(ny * width) + nx] > value)
                {
                    return false;
                }
            }
        }

        return true;
    }
}

/// <summary>
/// Narrowest transparent corridor between two opaque shapes. Anything narrower
/// than the shop gap bleeds together on the shirt even when the file looks fine.
/// </summary>
public sealed class GapCheck : IPreflightCheck
{
    public string Code => "gap-width";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var maxGapPx = (int)Math.Ceiling(context.Profile.MinimumGapMm * context.PixelsPerMm);
        var gapPx = context.Analysis.MinimumGapPx(maxGapPx, cancellationToken);
        if (gapPx is not { } measured)
        {
            return PreflightCheckResult.None;
        }

        var gapMm = measured / context.PixelsPerMm;
        var metrics = new[]
        {
            PreflightSupport.Metric("narrowest-gap-mm", gapMm, "mm", $"{context.Profile.MinimumGapMm:F2}"),
        };

        if (gapMm < context.Profile.MinimumGapMm)
        {
            return PreflightCheckResult.Finding(
                new PreflightFinding(
                    Code,
                    PreflightSeverity.Warning,
                    "Narrow gap",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"Two shapes are {gapMm:F2} mm apart; the shop minimum is {context.Profile.MinimumGapMm:F1} mm. They may bleed together."),
                    null,
                    metrics),
                metrics);
        }

        return PreflightCheckResult.Pass(metrics);
    }
}

/// <summary>Islands smaller than the minimum flake off or clog the film.</summary>
public sealed class IslandCheck : IPreflightCheck
{
    public string Code => "island-area";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var minAreaPx = context.Profile.MinimumIslandAreaMm2 * context.PixelsPerMmSquared;
        var small = context.Analysis.Components
            .Where(component => component.Area < minAreaPx)
            .OrderBy(component => component.Area)
            .ToArray();

        if (small.Length == 0)
        {
            return PreflightCheckResult.None;
        }

        var smallest = small[0];
        var smallestMm2 = smallest.Area / context.PixelsPerMmSquared;
        var metrics = new[]
        {
            PreflightSupport.Metric("small-island-count", small.Length, "count"),
            PreflightSupport.Metric("smallest-island-mm2", smallestMm2, "mm2", $"{context.Profile.MinimumIslandAreaMm2:F1}"),
        };

        return PreflightCheckResult.Finding(
            new PreflightFinding(
                Code,
                PreflightSeverity.Warning,
                "Islands too small",
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{small.Length} opaque island(s) are smaller than {context.Profile.MinimumIslandAreaMm2:F1} mm2; the smallest is {smallestMm2:F3} mm2."),
                ToRegion(smallest),
                metrics),
            metrics);
    }

    internal static PreflightRegion ToRegion(PreflightComponent component)
        => new(
            component.MinX,
            component.MinY,
            component.MaxX - component.MinX + 1,
            component.MaxY - component.MinY + 1);
}

/// <summary>Enclosed transparent holes smaller than the minimum trap air under the film.</summary>
public sealed class HoleCheck : IPreflightCheck
{
    public string Code => "hole-area";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var minAreaPx = context.Profile.MinimumHoleAreaMm2 * context.PixelsPerMmSquared;
        var small = context.Analysis.Holes
            .Where(hole => hole.Area < minAreaPx)
            .OrderBy(hole => hole.Area)
            .ToArray();

        if (small.Length == 0)
        {
            return PreflightCheckResult.None;
        }

        var smallest = small[0];
        var smallestMm2 = smallest.Area / context.PixelsPerMmSquared;
        var metrics = new[]
        {
            PreflightSupport.Metric("small-hole-count", small.Length, "count"),
            PreflightSupport.Metric("smallest-hole-mm2", smallestMm2, "mm2", $"{context.Profile.MinimumHoleAreaMm2:F1}"),
        };

        return PreflightCheckResult.Finding(
            new PreflightFinding(
                Code,
                PreflightSeverity.Warning,
                "Holes too small",
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{small.Length} enclosed hole(s) are smaller than {context.Profile.MinimumHoleAreaMm2:F1} mm2; the smallest is {smallestMm2:F3} mm2."),
                IslandCheck.ToRegion(smallest),
                metrics),
            metrics);
    }
}
