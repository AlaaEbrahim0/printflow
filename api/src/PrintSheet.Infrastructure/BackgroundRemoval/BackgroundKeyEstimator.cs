using PrintSheet.Application.Abstractions;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Recovers the colour the artwork was sitting on, for removers that cannot
/// report one themselves. The providers return a matte only, but the pipeline
/// composites that matte over the *original* colours, so every pixel the matte
/// made transparent still carries the background it was sampled from.
///
/// Only the border ring is sampled: a provider that ate the whole background
/// would otherwise "estimate" whatever colour dominates the subject. If that
/// ring is not uniform the estimate is refused rather than guessed, because a
/// wrong key would either leave the halo in place or start deleting artwork.
/// </summary>
internal static class BackgroundKeyEstimator
{
    private const int BorderWidthPx = 2;
    private const int MinimumSamples = 16;

    /// <summary>
    /// The median colour of the transparent border, or null when the ring has
    /// too few transparent pixels or fewer than <paramref name="minUniformity"/>
    /// of them sit within <paramref name="tolerance"/> of that median.
    /// </summary>
    public static RgbColor? FromTransparentBorder(
        RgbaImage image,
        int tolerance,
        double minUniformity,
        CancellationToken cancellationToken)
    {
        var width = image.Width;
        var height = image.Height;
        var border = Math.Max(1, Math.Min(BorderWidthPx, Math.Min(width, height) / 2));
        var pixels = image.Pixels;

        var red = new int[256];
        var green = new int[256];
        var blue = new int[256];
        var samples = 0;

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
                if (pixels[offset + 3] != 0)
                {
                    continue;
                }

                red[pixels[offset]]++;
                green[pixels[offset + 1]]++;
                blue[pixels[offset + 2]]++;
                samples++;
            }
        }

        if (samples < MinimumSamples)
        {
            return null;
        }

        var background = new RgbColor(
            Median(red, samples),
            Median(green, samples),
            Median(blue, samples));

        var toleranceSquared = 3 * tolerance * tolerance;
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
                if (pixels[offset + 3] != 0)
                {
                    continue;
                }

                if (SquaredDistance(pixels, offset, background) < toleranceSquared)
                {
                    matching++;
                }
            }
        }

        cancellationToken.ThrowIfCancellationRequested();

        // A cut-out that leaves a soft, blended rim behind has transparent pixels
        // of many shades; that is not a keyable background and guessing one would
        // eat the anti-aliased edge of the artwork.
        return (double)matching / samples >= minUniformity ? background : null;
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
