using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval.Solid;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Clears background-coloured areas that the matte left opaque because artwork
/// encloses them — the inside of an <c>o</c>, the two bowls of a <c>B</c>, the
/// black stripes inside a badge.
///
/// Providers only matte background they can reach from the frame edge, so a
/// counter survives as an opaque island of exactly the background colour. This
/// pass finds those islands by colour, not by shape: it marks every pixel that is
/// either already transparent or still the sampled background colour, floods that
/// mask from the border, and treats whatever the flood cannot reach as enclosed.
///
/// Two guards keep it from eating artwork. A region below
/// <see cref="BackgroundRemovalOptions.MinCounterAreaPx"/> is left alone (a dark
/// dot inside a letter is design detail, not a counter), and the whole pass aborts
/// when any single region exceeds
/// <see cref="BackgroundRemovalOptions.MaxCounterAreaFraction"/> — a design whose
/// ink *is* the background colour would otherwise be gutted.
/// </summary>
public sealed class SkiaEnclosedBackgroundCleaner(
    IOptions<BackgroundRemovalOptions> options,
    ILogger<SkiaEnclosedBackgroundCleaner> logger) : IEnclosedBackgroundCleaner
{
    private readonly BackgroundRemovalOptions _options = options.Value;

    public Task<EnclosedBackgroundOutcome> ClearAsync(
        byte[] rgbaPng,
        RgbColor? backgroundColor,
        CancellationToken cancellationToken)
        => Task.Run(
            () => Clear(rgbaPng, backgroundColor, cancellationToken),
            cancellationToken);

    private EnclosedBackgroundOutcome Clear(
        byte[] rgbaPng,
        RgbColor? backgroundColor,
        CancellationToken cancellationToken)
    {
        var image = SkiaRgbaImage.Decode(rgbaPng, "enclosed-background-cleaner");
        var key = backgroundColor
            ?? BackgroundKeyEstimator.FromTransparentBorder(
                image,
                _options.CounterBackgroundTolerance,
                _options.MinCounterKeyUniformity,
                cancellationToken);

        if (key is null)
        {
            logger.LogInformation(
                "Enclosed background pass skipped: the cut-out has no uniform background colour "
                + "to key on.");
            return new EnclosedBackgroundOutcome(rgbaPng, false, "no-background-key", 0, 0);
        }

        var background = key.Value;
        var found = CounterAnalyzer.Find(
            image,
            background,
            _options.CounterBackgroundTolerance,
            cancellationToken);

        // The cap is per region, not on the total. A white "Bo8" on black is five
        // legitimate counters adding up to 15% of the canvas and must clear; an
        // inverted logo, whose ink *is* the background colour, produces one region
        // the size of the design. Comparing the total would refuse the first and
        // call it the same thing as the second.
        var total = image.Width * image.Height;
        var largest = 0;
        foreach (var region in found.Regions)
        {
            largest = Math.Max(largest, region.Area);
        }

        if (largest > total * _options.MaxCounterAreaFraction)
        {
            logger.LogWarning(
                "Enclosed background pass skipped: the largest of {Regions} enclosed region(s) is "
                + "{LargestPx} px ({Fraction:P1}) of {TotalPx}, above the {Limit:P1} safety cap "
                + "(all {AreaPx} px enclosed in total). The ink is probably the background colour.",
                found.Regions.Count,
                largest,
                (double)largest / total,
                total,
                _options.MaxCounterAreaFraction,
                found.Area);
            return new EnclosedBackgroundOutcome(rgbaPng, false, "region-too-large", 0, 0);
        }

        // One reference ramp for the whole image, measured on the artwork only:
        // recomputing it per counter would make each hole's edge depend on its own
        // neighbours instead of on the design.
        var distances = SolidAnalyzer.Distances(image, background, cancellationToken);
        var reference = Math.Max(
            _options.CounterEdgeReferenceFloor,
            SolidAnalyzer.Percentile(
                distances,
                found.BackgroundLike,
                _options.CounterEdgeReferencePercentile));

        var minArea = _options.MinCounterAreaPx;
        var cleared = 0;
        var regions = 0;

        foreach (var region in found.Regions)
        {
            if (region.Area < minArea)
            {
                continue;
            }

            cleared += ClearRegion(image, found, region, distances, reference, cancellationToken);
            regions++;
        }

        if (regions == 0)
        {
            return new EnclosedBackgroundOutcome(rgbaPng, false, "no-enclosed-regions", 0, 0);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var png = SkiaRgbaImage.Encode(image);
        logger.LogInformation(
            "Enclosed background pass cleared {Regions} region(s) and {Pixels} px "
            + "on {Width}x{Height}; background=#{R:X2}{G:X2}{B:X2}.",
            regions,
            cleared,
            image.Width,
            image.Height,
            background.R,
            background.G,
            background.B);

        return new EnclosedBackgroundOutcome(png, true, null, regions, cleared);
    }

    /// <summary>
    /// Zeroes the region's alpha and rebuilds a soft ramp on the ring around it,
    /// so a counter does not print as a hard-edged bite out of an anti-aliased
    /// letter. Only alpha is touched: the compositor already wrote the artwork's
    /// own colours, and the decontamination stage that follows uses the same
    /// background hint for the new ramp.
    /// </summary>
    /// <returns>Pixels whose alpha changed.</returns>
    private int ClearRegion(
        RgbaImage image,
        EnclosedRegionMap found,
        EnclosedRegion region,
        byte[] distances,
        int reference,
        CancellationToken cancellationToken)
    {
        var width = image.Width;
        var height = image.Height;
        var pixels = image.Pixels;
        var members = found.Members;
        var changed = 0;
        var end = region.Start + region.Length;

        for (var i = region.Start; i < end; i++)
        {
            var index = members[i];
            if (pixels[(index * 4) + 3] != 0)
            {
                pixels[(index * 4) + 3] = 0;
                changed++;
            }

            if ((i & 0xFFFFF) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
        }

        var radius = _options.CounterEdgeBandPixels;
        if (radius <= 0)
        {
            return changed;
        }

        // The ramp reaches at most `radius` pixels past the region, so the band is
        // built on the region's padded box. A design with 200 letter counters then
        // costs 200 small BFS runs instead of 200 full-image ones.
        var pad = radius + 1;
        var left = Math.Max(0, region.MinX - pad);
        var top = Math.Max(0, region.MinY - pad);
        var right = Math.Min(width - 1, region.MaxX + pad);
        var bottom = Math.Min(height - 1, region.MaxY + pad);
        var boxWidth = right - left + 1;
        var boxHeight = bottom - top + 1;
        var local = new bool[boxWidth * boxHeight];
        for (var i = region.Start; i < end; i++)
        {
            var index = members[i];
            var y = index / width;
            var x = index % width;
            if (x < left || x > right || y < top || y > bottom)
            {
                continue;
            }

            local[((y - top) * boxWidth) + (x - left)] = true;
        }

        var band = SolidAnalyzer.EdgeBand(local, boxWidth, boxHeight, radius, cancellationToken);
        for (var y = 0; y < boxHeight; y++)
        {
            var source = ((top + y) * width) + left;
            var target = y * boxWidth;
            for (var x = 0; x < boxWidth; x++)
            {
                if (!band[target + x])
                {
                    continue;
                }

                var index = source + x;
                var alpha = SolidAnalyzer.EdgeAlpha(
                    distances[index],
                    _options.CounterEdgeLow,
                    reference);
                // Never brighten what the matte already decided: a pixel the
                // provider made nearly transparent is an edge, not the start of
                // a new one.
                if (alpha < pixels[(index * 4) + 3])
                {
                    pixels[(index * 4) + 3] = alpha;
                    changed++;
                }
            }
        }

        return changed;
    }
}

