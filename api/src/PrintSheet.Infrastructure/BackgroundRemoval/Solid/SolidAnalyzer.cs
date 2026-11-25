using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.BackgroundRemoval.Solid;

/// <summary>Border statistics: the cheap half of applicability.</summary>
internal sealed record BorderAnalysis(
    RgbColor Background,
    int PixelCount,
    int MatchingPixels,
    double Uniformity,
    double ForegroundRatio);

/// <summary>
/// Deterministic colour and connectivity math for the solid-background remover.
/// Every buffer is flat; no per-pixel objects and no recursion.
/// </summary>
internal static class SolidAnalyzer
{
    private const float SqrtThree = 1.7320508f;

    public static BorderAnalysis SampleBorder(
        RgbaImage image,
        SolidBackgroundRemovalOptions options,
        CancellationToken cancellationToken)
    {
        var width = image.Width;
        var height = image.Height;
        var border = Math.Min(options.BorderWidthPx, Math.Min(width, height) / 2);
        border = Math.Max(1, border);

        var red = new int[256];
        var green = new int[256];
        var blue = new int[256];
        var count = 0;

        for (var y = 0; y < height; y++)
        {
            var rowEdge = y < border || y >= height - border;
            for (var x = 0; x < width; x++)
            {
                if (!rowEdge && x >= border && x < width - border)
                {
                    continue;
                }

                var offset = ((y * width) + x) * 4;
                red[image.Pixels[offset]]++;
                green[image.Pixels[offset + 1]]++;
                blue[image.Pixels[offset + 2]]++;
                count++;
            }
        }

        var background = new RgbColor(
            Median(red, count),
            Median(green, count),
            Median(blue, count));

        var toleranceSquared = 3 * options.BackgroundTolerance * options.BackgroundTolerance;
        var matching = 0;
        for (var y = 0; y < height; y++)
        {
            var rowEdge = y < border || y >= height - border;
            for (var x = 0; x < width; x++)
            {
                if (!rowEdge && x >= border && x < width - border)
                {
                    continue;
                }

                var offset = ((y * width) + x) * 4;
                if (SquaredDistance(image.Pixels, offset, background) < toleranceSquared)
                {
                    matching++;
                }
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        var uniformity = count == 0 ? 0 : (double)matching / count;
        return new BorderAnalysis(
            background,
            count,
            matching,
            uniformity,
            1 - uniformity);
    }

    /// <summary>
    /// Marks the border-connected candidate region. Enclosed same-coloured areas
    /// (letter counters, stripes inside a badge) are never reached from the border
    /// and therefore stay foreground.
    /// </summary>
    public static bool[] FloodFill(
        RgbaImage image,
        RgbColor background,
        int tolerance,
        CancellationToken cancellationToken)
    {
        var width = image.Width;
        var height = image.Height;
        var pixels = image.Pixels;
        var count = width * height;
        var toleranceSquared = 3 * tolerance * tolerance;
        var backgroundMask = new bool[count];
        var queue = new int[count];
        var head = 0;
        var tail = 0;

        void Seed(int x, int y)
        {
            var index = (y * width) + x;
            if (backgroundMask[index])
            {
                return;
            }

            if (SquaredDistance(pixels, index * 4, background) >= toleranceSquared)
            {
                return;
            }

            backgroundMask[index] = true;
            queue[tail++] = index;
        }

        for (var x = 0; x < width; x++)
        {
            Seed(x, 0);
            Seed(x, height - 1);
        }

        for (var y = 1; y < height - 1; y++)
        {
            Seed(0, y);
            Seed(width - 1, y);
        }

        while (head < tail)
        {
            var index = queue[head++];
            var x = index % width;
            var y = index / width;

            if (x > 0)
            {
                Visit(index - 1);
            }

            if (x < width - 1)
            {
                Visit(index + 1);
            }

            if (y > 0)
            {
                Visit(index - width);
            }

            if (y < height - 1)
            {
                Visit(index + width);
            }
        }

        return backgroundMask;

        void Visit(int index)
        {
            if (backgroundMask[index])
            {
                return;
            }

            if (SquaredDistance(pixels, index * 4, background) >= toleranceSquared)
            {
                return;
            }

            backgroundMask[index] = true;
            queue[tail++] = index;
        }
    }

    /// <summary>Rounded Euclidean RGB distance divided by sqrt(3), so 0-255.</summary>
    public static byte[] Distances(RgbaImage image, RgbColor background, CancellationToken cancellationToken)
    {
        var pixels = image.Pixels;
        var count = image.Width * image.Height;
        var distances = new byte[count];
        for (var index = 0; index < count; index++)
        {
            var offset = index * 4;
            var dr = pixels[offset] - background.R;
            var dg = pixels[offset + 1] - background.G;
            var db = pixels[offset + 2] - background.B;
            var distance = MathF.Sqrt((dr * dr) + (dg * dg) + (db * db)) / SqrtThree;
            distances[index] = (byte)Math.Clamp((int)MathF.Round(distance), 0, 255);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return distances;
    }

    /// <summary>Percentile of the foreground distance histogram, 0-255.</summary>
    public static int Percentile(byte[] distances, bool[] backgroundMask, int percentile)
    {
        var histogram = new int[256];
        var foreground = 0;
        for (var index = 0; index < distances.Length; index++)
        {
            if (backgroundMask[index])
            {
                continue;
            }

            histogram[distances[index]]++;
            foreground++;
        }

        if (foreground == 0)
        {
            return 0;
        }

        var target = (int)Math.Ceiling(percentile / 100d * foreground);
        target = Math.Clamp(target, 1, foreground);
        var cumulative = 0;
        for (var value = 0; value < histogram.Length; value++)
        {
            cumulative += histogram[value];
            if (cumulative >= target)
            {
                return value;
            }
        }

        return 255;
    }

    /// <summary>
    /// Marks the pixels whose alpha must come from the edge ramp instead of being
    /// set fully opaque.
    ///
    /// <paramref name="minimumRadius"/> is a floor, so a hard-edged source still
    /// gets its anti-aliased ring. Past it the band keeps growing while the
    /// pixels are still within <paramref name="reference"/> of the background
    /// colour, because a soft source spreads that ramp over more pixels than any
    /// fixed radius covers. Cutting the band off at a fixed radius is what left a
    /// fully opaque near-background pixel one step outside it — measured at
    /// <c>(65,65,65)</c> alpha 255 immediately next to a ramp pixel of alpha 74 —
    /// which prints as a dirty outline on a garment.
    ///
    /// <paramref name="maximumRadius"/> bounds the growth so artwork whose ink
    /// sits close to the background colour cannot be flooded.
    /// </summary>
    public static bool[] EdgeBand(
        bool[] backgroundMask,
        int width,
        int height,
        int minimumRadius,
        int maximumRadius,
        int reference,
        Func<int, int> distanceAt,
        CancellationToken cancellationToken)
    {
        var band = new bool[backgroundMask.Length];
        var floor = Math.Max(0, minimumRadius);
        var ceiling = Math.Max(floor, maximumRadius);
        if (ceiling == 0)
        {
            return band;
        }

        var queue = new int[backgroundMask.Length];
        var head = 0;
        var tail = 0;

        // Ring 1: foreground pixels that touch the background.
        for (var index = 0; index < backgroundMask.Length; index++)
        {
            if (backgroundMask[index])
            {
                continue;
            }

            var x = index % width;
            var y = index / width;
            if ((x > 0 && backgroundMask[index - 1])
                || (x < width - 1 && backgroundMask[index + 1])
                || (y > 0 && backgroundMask[index - width])
                || (y < height - 1 && backgroundMask[index + width]))
            {
                band[index] = true;
                queue[tail++] = index;
            }
        }

        // Breadth-first dilation: every further ring is one more pixel from the
        // background, so the loop is O(foreground) rather than O(foreground × r²).
        var depth = 1;
        while (head < tail && depth < ceiling)
        {
            var ringEnd = tail;
            while (head < ringEnd)
            {
                var index = queue[head++];
                var x = index % width;
                var y = index / width;
                Visit(index - 1, x > 0);
                Visit(index + 1, x < width - 1);
                Visit(index - width, y > 0);
                Visit(index + width, y < height - 1);
            }

            depth++;
        }

        cancellationToken.ThrowIfCancellationRequested();
        return band;

        void Visit(int index, bool inside)
        {
            if (!inside || backgroundMask[index] || band[index])
            {
                return;
            }

            // Past the floor the band only continues while the ramp is still
            // incomplete. Once a pixel has reached the reference distance the
            // ramp would make it fully opaque anyway, so there is nothing left
            // for a deeper ring to fix.
            if (depth + 1 > floor && distanceAt(index) >= reference)
            {
                return;
            }

            band[index] = true;
            queue[tail++] = index;
        }
    }

    public static byte EdgeAlpha(byte distance, int edgeLow, int reference)
    {
        if (reference <= edgeLow)
        {
            return distance >= reference ? (byte)255 : (byte)0;
        }

        var alpha = (distance - edgeLow) / (double)(reference - edgeLow);
        return (byte)Math.Clamp((int)Math.Round(alpha * 255), 0, 255);
    }

    private static int SquaredDistance(byte[] pixels, int offset, RgbColor background)
    {
        var dr = pixels[offset] - background.R;
        var dg = pixels[offset + 1] - background.G;
        var db = pixels[offset + 2] - background.B;
        return (dr * dr) + (dg * dg) + (db * db);
    }

    private static byte Median(int[] histogram, int count)
    {
        if (count <= 0)
        {
            return 0;
        }

        var lower = (count - 1) / 2;
        var upper = count / 2;
        var cumulative = 0;
        int? first = null;
        for (var value = 0; value < histogram.Length; value++)
        {
            cumulative += histogram[value];
            if (first is null && cumulative > lower)
            {
                first = value;
            }

            if (cumulative > upper)
            {
                return (byte)((first!.Value + value) / 2);
            }
        }

        return (byte)(first ?? 0);
    }
}
