using PrintSheet.Application.Preflight;

namespace PrintSheet.Infrastructure.Preflight.Fixes;

/// <summary>
/// Drops opaque islands below the profile's area floor. Opt-in: a design may
/// legitimately have tiny dots, so the operator decides, not the pipeline.
/// </summary>
public sealed class RemoveIslandsFix : IPreflightFix
{
    public string Code => PreflightFixCodes.RemoveIslands;

    public string Description => "Removed opaque islands below the minimum area.";

    public IReadOnlyCollection<string> Addresses { get; } = ["island-area", "region-count"];

    public PreflightImage Apply(
        PreflightImage image,
        PreflightContext context,
        CancellationToken cancellationToken)
    {
        var analysis = context.Analysis;
        var minAreaPx = context.Profile.MinimumIslandAreaMm2 * context.PixelsPerMmSquared;
        var areas = new int[analysis.Components.Count + 1];
        foreach (var component in analysis.Components)
        {
            areas[component.Label] = component.Area;
        }

        var pixels = (byte[])image.Pixels.Clone();
        for (var index = 0; index < analysis.Labels.Length; index++)
        {
            var label = analysis.Labels[index];
            if (label != 0 && areas[label] < minAreaPx)
            {
                pixels[(index * 4) + 3] = 0;
            }

            if ((index & 0xFFFFF) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
        }

        return image with { Pixels = pixels };
    }
}

/// <summary>Fills enclosed holes below the area floor so the film has no trapped air.</summary>
public sealed class FillHolesFix : IPreflightFix
{
    public string Code => PreflightFixCodes.FillHoles;

    public string Description => "Filled enclosed holes below the minimum area.";

    public IReadOnlyCollection<string> Addresses { get; } = ["hole-area"];

    public PreflightImage Apply(
        PreflightImage image,
        PreflightContext context,
        CancellationToken cancellationToken)
    {
        var analysis = context.Analysis;
        var minAreaPx = context.Profile.MinimumHoleAreaMm2 * context.PixelsPerMmSquared;
        var small = analysis.Holes
            .Where(hole => hole.Area < minAreaPx)
            .Select(hole => hole.Label)
            .ToHashSet();

        if (small.Count == 0)
        {
            return image;
        }

        var labels = analysis.HoleLabels;
        var pixels = (byte[])image.Pixels.Clone();
        for (var index = 0; index < labels.Length; index++)
        {
            if (small.Contains(labels[index]))
            {
                pixels[(index * 4) + 3] = 255;
            }

            if ((index & 0xFFFFF) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
        }

        return image with { Pixels = pixels };
    }
}

/// <summary>
/// Snaps semi-transparent pixels away from the edge to fully clear or fully
/// opaque. The edge band is left alone: that is where a soft ramp is correct.
/// </summary>
public sealed class HardenSoftInteriorFix : IPreflightFix
{
    public string Code => PreflightFixCodes.HardenSoftInterior;

    public string Description => "Snapped semi-transparent interior pixels to fully clear or opaque.";

    public IReadOnlyCollection<string> Addresses { get; } = ["soft-interior"];

    public PreflightImage Apply(
        PreflightImage image,
        PreflightContext context,
        CancellationToken cancellationToken)
    {
        var bandPx = Math.Max(1, (int)Math.Round(context.Profile.SoftEdgeBandMm * context.PixelsPerMm));
        var distance = context.Analysis.DistanceToTransparent;
        var pixels = (byte[])image.Pixels.Clone();

        for (var index = 0; index < distance.Length; index++)
        {
            var offset = (index * 4) + 3;
            var alpha = pixels[offset];
            if (alpha is > 0 and < 255 && distance[index] > bandPx)
            {
                pixels[offset] = alpha < 128 ? (byte)0 : (byte)255;
            }

            if ((index & 0xFFFFF) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
        }

        return image with { Pixels = pixels };
    }
}

/// <summary>Declares the print resolution in pHYs so the RIP does not guess.</summary>
public sealed class SetDpiMetadataFix : IPreflightFix
{
    public string Code => PreflightFixCodes.SetDpiMetadata;

    public string Description => "Wrote the print spec DPI into the PNG metadata.";

    public IReadOnlyCollection<string> Addresses { get; } = ["dpi-metadata"];

    public PreflightImage Apply(
        PreflightImage image,
        PreflightContext context,
        CancellationToken cancellationToken)
        => image with { DpiX = context.Spec.Dpi, DpiY = context.Spec.Dpi };
}

/// <summary>Embeds the sRGB chunk; no ICC payload is needed for sRGB artwork.</summary>
public sealed class EmbedSrgbFix : IPreflightFix
{
    public string Code => PreflightFixCodes.EmbedSrgb;

    public string Description => "Embedded an sRGB profile marker.";

    public IReadOnlyCollection<string> Addresses { get; } = ["icc-profile"];

    public PreflightImage Apply(
        PreflightImage image,
        PreflightContext context,
        CancellationToken cancellationToken)
        => image with { HasSrgbProfile = true };
}
