using System.Globalization;
using PrintSheet.Application.Preflight;
using PrintSheet.Domain.Preflight;

namespace PrintSheet.Infrastructure.Preflight.Checks;

/// <summary>
/// WCAG contrast between the ink and the garment, at the opacities DTF actually
/// lays down. A colour can be perfectly visible at 100% and disappear at 25%,
/// which is the failure the operator only notices after pressing.
/// </summary>
public sealed class ContrastCheck : IPreflightCheck
{
    private const int Buckets = 4096;

    public string Code => "contrast";

    public PreflightCheckResult Run(PreflightContext context, CancellationToken cancellationToken)
    {
        var analysis = context.Analysis;
        if (analysis.OpaquePixels == 0)
        {
            return PreflightCheckResult.None;
        }

        var pixels = context.Image.Pixels;
        var counts = new int[Buckets];
        var sums = new long[Buckets * 3];

        for (var index = 0; index < analysis.Opaque.Length; index++)
        {
            if (!analysis.Opaque[index])
            {
                continue;
            }

            var offset = index * 4;
            var r = pixels[offset];
            var g = pixels[offset + 1];
            var b = pixels[offset + 2];
            var bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            counts[bucket]++;
            sums[(bucket * 3)] += r;
            sums[(bucket * 3) + 1] += g;
            sums[(bucket * 3) + 2] += b;
        }

        cancellationToken.ThrowIfCancellationRequested();

        var garment = PreflightSupport.GarmentRgb(context.Spec.Garment);
        var findings = new List<PreflightFinding>();
        var metrics = new List<PreflightMetric>();

        var dominant = Enumerable.Range(0, Buckets)
            .Where(bucket => counts[bucket] > 0)
            .OrderByDescending(bucket => counts[bucket])
            .ThenBy(bucket => bucket)
            .Take(context.Profile.DominantColorCount);

        foreach (var bucket in dominant)
        {
            var fraction = (double)counts[bucket] / analysis.OpaquePixels;
            if (fraction < context.Profile.DominantColorMinimumFraction)
            {
                continue;
            }

            var colour = (
                (byte)(sums[(bucket * 3)] / counts[bucket]),
                (byte)(sums[(bucket * 3) + 1] / counts[bucket]),
                (byte)(sums[(bucket * 3) + 2] / counts[bucket]));
            var hex = PreflightSupport.Hex(colour.Item1, colour.Item2, colour.Item3);

            foreach (var opacity in context.Profile.EffectiveContrastOpacities)
            {
                var blended = PreflightSupport.Blend(colour, garment, opacity);
                var ratio = PreflightSupport.ContrastRatio(blended, garment);
                var metricName = string.Create(
                    CultureInfo.InvariantCulture,
                    $"contrast-{hex}-{opacity * 100:F0}");
                metrics.Add(
                    PreflightSupport.Metric(
                        metricName,
                        ratio,
                        "ratio",
                        $"{context.Profile.MinimumContrastRatio:F1}"));

                if (ratio < context.Profile.MinimumContrastRatio)
                {
                    findings.Add(
                        new PreflightFinding(
                            Code,
                            PreflightSeverity.Warning,
                            "Low contrast on the garment",
                            string.Create(
                                CultureInfo.InvariantCulture,
                                $"Ink {hex} at {opacity:P0} opacity has a contrast ratio of {ratio:F2}:1 against the garment; the minimum is {context.Profile.MinimumContrastRatio:F1}:1."),
                            null,
                            [PreflightSupport.Metric("contrast-ratio", ratio, "ratio", $"{context.Profile.MinimumContrastRatio:F1}")]));
                }
            }
        }

        return new PreflightCheckResult(findings, metrics);
    }
}
