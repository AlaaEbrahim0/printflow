using PrintSheet.Application.Abstractions;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.BackgroundRemoval.Solid;

/// <summary>One enclosed background-coloured region found by <see cref="CounterAnalyzer"/>.</summary>
/// <param name="Start">First index into <see cref="EnclosedRegionMap.Members"/>.</param>
/// <param name="Length">Member count in pixels.</param>
/// <param name="MinX">Inclusive bounds, for the bounded edge-band search.</param>
/// <param name="MinY">Inclusive bounds, for the bounded edge-band search.</param>
/// <param name="MaxX">Inclusive bounds, for the bounded edge-band search.</param>
/// <param name="MaxY">Inclusive bounds, for the bounded edge-band search.</param>
internal sealed record EnclosedRegion(
    int Start,
    int Length,
    int MinX,
    int MinY,
    int MaxX,
    int MaxY)
{
    public int Area => Length;
}

/// <summary>
/// The result of one counter search: every member pixel in one flat array plus
/// the region table that indexes into it. A design with hundreds of letter
/// counters then costs four flat buffers, not four per region.
/// </summary>
internal sealed class EnclosedRegionMap
{
    internal EnclosedRegionMap(
        int[] members,
        bool[] backgroundLike,
        EnclosedRegion[] regions,
        int area)
    {
        Members = members;
        BackgroundLike = backgroundLike;
        Regions = regions;
        Area = area;
    }

    /// <summary>
    /// Flat pixel indices of every enclosed region, grouped by region and in the
    /// order each region's flood found them. Indexed by
    /// <see cref="EnclosedRegion.Start"/> and <see cref="EnclosedRegion.Length"/>.
    /// </summary>
    public int[] Members { get; }

    /// <summary>
    /// True for every pixel that is transparent or within tolerance of the key
    /// colour, reachable or not. The edge ramp uses it to find the artwork's
    /// colour range without rescanning the image per counter.
    /// </summary>
    public bool[] BackgroundLike { get; }

    /// <summary>Enclosed regions, in discovery order.</summary>
    public IReadOnlyList<EnclosedRegion> Regions { get; }

    /// <summary>Combined area of every enclosed region, before any minimum-area filter.</summary>
    public int Area { get; }
}

/// <summary>
/// Finds background-coloured areas the matte left opaque because nothing connects
/// them to the frame edge. Same 4-connected, border-seeded reasoning as
/// <see cref="SolidAnalyzer.FloodFill"/>, but the *result* is inverted: this
/// returns what the flood could not reach.
/// </summary>
internal static class CounterAnalyzer
{
    /// <summary>
    /// Marks every pixel that is either already transparent or still within
    /// <paramref name="tolerance"/> of the background colour, floods it from the
    /// border, then labels the leftover background-like components.
    /// </summary>
    public static EnclosedRegionMap Find(
        RgbaImage image,
        RgbColor background,
        int tolerance,
        CancellationToken cancellationToken)
    {
        var width = image.Width;
        var height = image.Height;
        var count = width * height;
        var pixels = image.Pixels;
        var toleranceSquared = 3 * tolerance * tolerance;

        // candidate: pixel that could be background — already transparent, or the
        // keyed colour still sitting opaque behind the artwork.
        var candidate = new bool[count];
        for (var index = 0; index < count; index++)
        {
            var offset = index * 4;
            candidate[index] = pixels[offset + 3] == 0
                || SquaredDistance(pixels, offset, background) < toleranceSquared;
        }

        cancellationToken.ThrowIfCancellationRequested();

        // reachable: border-connected candidate. Candidate minus reachable is
        // enclosed by artwork.
        var reachable = new bool[count];
        var queue = new int[count];
        var head = 0;
        var tail = 0;

        void Seed(int index)
        {
            if (reachable[index] || !candidate[index])
            {
                return;
            }

            reachable[index] = true;
            queue[tail++] = index;
        }

        for (var x = 0; x < width; x++)
        {
            Seed(x);
            Seed(((height - 1) * width) + x);
        }

        for (var y = 1; y < height - 1; y++)
        {
            Seed(y * width);
            Seed((y * width) + width - 1);
        }

        while (head < tail)
        {
            var index = queue[head++];
            var x = index % width;
            var y = index / width;
            if (x > 0)
            {
                Seed(index - 1);
            }

            if (x < width - 1)
            {
                Seed(index + 1);
            }

            if (y > 0)
            {
                Seed(index - width);
            }

            if (y < height - 1)
            {
                Seed(index + width);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();

        // Label the enclosed components in one more pass, appending every member
        // to one flat array so clearing a region never rescans the image.
        var labelled = new bool[count];
        var members = new int[count];
        var written = 0;
        var regions = new List<EnclosedRegion>();

        for (var start = 0; start < count; start++)
        {
            if (labelled[start] || !candidate[start] || reachable[start])
            {
                continue;
            }

            var first = written;
            var minX = width;
            var minY = height;
            var maxX = -1;
            var maxY = -1;
            head = 0;
            tail = 0;
            labelled[start] = true;
            queue[tail++] = start;

            while (head < tail)
            {
                var index = queue[head++];
                members[written++] = index;
                var x = index % width;
                var y = index / width;
                if (x < minX)
                {
                    minX = x;
                }

                if (x > maxX)
                {
                    maxX = x;
                }

                if (y < minY)
                {
                    minY = y;
                }

                if (y > maxY)
                {
                    maxY = y;
                }

                Visit(index - 1, x > 0);
                Visit(index + 1, x < width - 1);
                Visit(index - width, y > 0);
                Visit(index + width, y < height - 1);
            }

            regions.Add(new EnclosedRegion(first, written - first, minX, minY, maxX, maxY));

            void Visit(int index, bool inside)
            {
                if (!inside || labelled[index] || !candidate[index] || reachable[index])
                {
                    return;
                }

                labelled[index] = true;
                queue[tail++] = index;
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        return new EnclosedRegionMap(members, candidate, regions.ToArray(), written);
    }

    private static int SquaredDistance(byte[] pixels, int offset, RgbColor background)
    {
        var dr = pixels[offset] - background.R;
        var dg = pixels[offset + 1] - background.G;
        var db = pixels[offset + 2] - background.B;
        return (dr * dr) + (dg * dg) + (db * db);
    }
}
