namespace PrintSheet.Application.Preflight;

/// <summary>One connected opaque or transparent region, with the numbers checks need.</summary>
public sealed record PreflightComponent(
    int Label,
    int Area,
    int MinX,
    int MinY,
    int MaxX,
    int MaxY,
    bool TouchesBorder)
{
    public int Width => MaxX - MinX + 1;

    public int Height => MaxY - MinY + 1;
}

/// <summary>
/// The pixel facts every check shares. Building this once keeps fifteen checks
/// from each walking the buffer, and keeps memory to three buffers rather than
/// one per rule. Distances are capped at 255 px: every threshold is far below
/// that, and a byte keeps the distance map affordable on a 6850 px roll.
/// </summary>
public sealed class PreflightAnalysis
{
    private readonly Lazy<int[]> _holeLabels;

    private PreflightAnalysis(
        bool[] opaque,
        byte[] distanceToTransparent,
        int[] labels,
        IReadOnlyList<PreflightComponent> components,
        IReadOnlyList<PreflightComponent> holes,
        int opaquePixels,
        int semiTransparentPixels,
        int foregroundPixels,
        int width,
        int height)
    {
        Opaque = opaque;
        DistanceToTransparent = distanceToTransparent;
        Labels = labels;
        Components = components;
        Holes = holes;
        OpaquePixels = opaquePixels;
        SemiTransparentPixels = semiTransparentPixels;
        ForegroundPixels = foregroundPixels;
        Width = width;
        Height = height;
        _holeLabels = new Lazy<int[]>(() => LabelTransparent(opaque, width, height));
    }

    /// <summary>Alpha at or above 128. Below that is background or a soft edge.</summary>
    public bool[] Opaque { get; }

    /// <summary>Distance in pixels to the nearest pixel with alpha below 128, capped at 255.</summary>
    public byte[] DistanceToTransparent { get; }

    /// <summary>1-based label per pixel, 0 for background.</summary>
    public int[] Labels { get; }

    public IReadOnlyList<PreflightComponent> Components { get; }

    /// <summary>Enclosed transparent regions, excluding anything connected to the border.</summary>
    public IReadOnlyList<PreflightComponent> Holes { get; }

    /// <summary>
    /// 1-based labels for transparent pixels, computed only when a fix needs to
    /// fill holes. Label numbers match <see cref="Holes"/>.
    /// </summary>
    public int[] HoleLabels => _holeLabels.Value;

    public int OpaquePixels { get; }

    public int SemiTransparentPixels { get; }

    public int ForegroundPixels { get; }

    public int Width { get; }

    public int Height { get; }

    public static PreflightAnalysis Build(PreflightImage image, CancellationToken cancellationToken)
    {
        var pixels = image.Pixels;
        var count = image.PixelCount;
        var opaque = new bool[count];
        var semi = 0;
        var foreground = 0;

        for (var index = 0; index < count; index++)
        {
            var alpha = pixels[(index * 4) + 3];
            if (alpha >= 128)
            {
                opaque[index] = true;
            }

            if (alpha is > 0 and < 255)
            {
                semi++;
            }

            if (alpha > 0)
            {
                foreground++;
            }
        }

        cancellationToken.ThrowIfCancellationRequested();

        var labels = new int[count];
        var queue = new int[count];
        var visited = new bool[count];
        var components = Label(
            opaque,
            width: image.Width,
            height: image.Height,
            eightConnected: true,
            labels,
            queue,
            visited,
            cancellationToken);

        var holes = Label(
            Invert(opaque),
            width: image.Width,
            height: image.Height,
            eightConnected: false,
            labels: null,
            queue,
            visited,
            cancellationToken)
            .Where(component => !component.TouchesBorder)
            .ToArray();

        cancellationToken.ThrowIfCancellationRequested();

        var distance = ComputeDistanceToTransparent(opaque, image.Width, image.Height);

        return new PreflightAnalysis(
            opaque,
            distance,
            labels,
            components,
            holes,
            components.Sum(component => component.Area),
            semi,
            foreground,
            image.Width,
            image.Height);
    }

    /// <summary>
    /// Narrowest transparent corridor between two opaque pixels, in pixels.
    /// Scans each transparent pixel for opaque neighbours on opposite sides,
    /// which finds the corridor the eye sees; a diagonal-only pinch is not
    /// measured, and every DTF threshold is wide enough that this does not
    /// change the verdict.
    /// </summary>
    public int? MinimumGapPx(int maxGapPx, CancellationToken cancellationToken)
    {
        if (maxGapPx < 1)
        {
            return null;
        }

        var minimum = int.MaxValue;
        var width = Width;
        var height = Height;
        var opaque = Opaque;

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
                if (opaque[index])
                {
                    continue;
                }

                // Horizontal corridor.
                var left = 0;
                for (var step = 1; step <= maxGapPx && x - step >= 0; step++)
                {
                    if (opaque[index - step])
                    {
                        left = step;
                        break;
                    }
                }

                if (left > 0)
                {
                    for (var step = 1; step <= maxGapPx && x + step < width; step++)
                    {
                        if (opaque[index + step])
                        {
                            minimum = Math.Min(minimum, left + step - 1);
                            break;
                        }
                    }
                }

                // Vertical corridor.
                var up = 0;
                for (var step = 1; step <= maxGapPx && y - step >= 0; step++)
                {
                    if (opaque[index - (step * width)])
                    {
                        up = step;
                        break;
                    }
                }

                if (up > 0)
                {
                    for (var step = 1; step <= maxGapPx && y + step < height; step++)
                    {
                        if (opaque[index + (step * width)])
                        {
                            minimum = Math.Min(minimum, up + step - 1);
                            break;
                        }
                    }
                }

                if (minimum <= 1)
                {
                    return 1;
                }
            }
        }

        return minimum == int.MaxValue ? null : minimum;
    }

    private static bool[] Invert(bool[] mask)
    {
        var inverted = new bool[mask.Length];
        for (var index = 0; index < mask.Length; index++)
        {
            inverted[index] = !mask[index];
        }

        return inverted;
    }

    private static int[] LabelTransparent(bool[] opaque, int width, int height)
    {
        var labels = new int[opaque.Length];
        Label(
            Invert(opaque),
            width,
            height,
            eightConnected: false,
            labels,
            new int[opaque.Length],
            new bool[opaque.Length],
            CancellationToken.None);
        return labels;
    }

    private static IReadOnlyList<PreflightComponent> Label(
        bool[] mask,
        int width,
        int height,
        bool eightConnected,
        int[]? labels,
        int[] queue,
        bool[] visited,
        CancellationToken cancellationToken)
    {
        Array.Clear(visited);
        var components = new List<PreflightComponent>();
        var nextLabel = 1;

        for (var start = 0; start < mask.Length; start++)
        {
            if (!mask[start] || visited[start])
            {
                continue;
            }

            var label = nextLabel++;
            var head = 0;
            var tail = 0;
            var area = 0;
            var minX = width;
            var minY = height;
            var maxX = -1;
            var maxY = -1;
            var touchesBorder = false;

            visited[start] = true;
            queue[tail++] = start;

            while (head < tail)
            {
                var index = queue[head++];
                area++;
                if ((area & 0xFFFFF) == 0)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                }

                var x = index % width;
                var y = index / width;

                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (x == 0 || y == 0 || x == width - 1 || y == height - 1)
                {
                    touchesBorder = true;
                }

                if (labels is not null)
                {
                    labels[index] = label;
                }

                var hasLeft = x > 0;
                var hasRight = x < width - 1;
                var hasUp = y > 0;
                var hasDown = y < height - 1;

                if (hasLeft) Visit(index - 1);
                if (hasRight) Visit(index + 1);
                if (hasUp) Visit(index - width);
                if (hasDown) Visit(index + width);

                if (eightConnected)
                {
                    if (hasLeft && hasUp) Visit(index - width - 1);
                    if (hasRight && hasUp) Visit(index - width + 1);
                    if (hasLeft && hasDown) Visit(index + width - 1);
                    if (hasRight && hasDown) Visit(index + width + 1);
                }
            }

            if ((nextLabel & 63) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            components.Add(
                new PreflightComponent(label, area, minX, minY, maxX, maxY, touchesBorder));

            void Visit(int index)
            {
                if (!mask[index] || visited[index])
                {
                    return;
                }

                visited[index] = true;
                queue[tail++] = index;
            }
        }

        return components;
    }

    /// <summary>
    /// Exact Euclidean distance to the nearest pixel with alpha below 128, via
    /// two Felzenszwalb 1-D passes. O(pixels), no recursion, no per-pixel objects.
    /// </summary>
    private static byte[] ComputeDistanceToTransparent(bool[] opaque, int width, int height)
    {
        var count = width * height;
        var source = new double[count];
        for (var index = 0; index < count; index++)
        {
            source[index] = opaque[index] ? double.PositiveInfinity : 0;
        }

        var max = Math.Max(width, height);
        var f = new double[max];
        var d = new double[max];
        var v = new int[max];
        var z = new double[max + 1];

        for (var y = 0; y < height; y++)
        {
            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                f[x] = source[row + x];
            }

            Transform(f, width, d, v, z);
            for (var x = 0; x < width; x++)
            {
                source[row + x] = d[x];
            }
        }

        for (var x = 0; x < width; x++)
        {
            for (var y = 0; y < height; y++)
            {
                f[y] = source[(y * width) + x];
            }

            Transform(f, height, d, v, z);
            for (var y = 0; y < height; y++)
            {
                source[(y * width) + x] = d[y];
            }
        }

        var result = new byte[count];
        for (var index = 0; index < count; index++)
        {
            result[index] = (byte)Math.Min(255, (int)Math.Sqrt(source[index]));
        }

        return result;
    }

    private static void Transform(double[] f, int n, double[] d, int[] v, double[] z)
    {
        const double Infinity = double.PositiveInfinity;
        var k = 0;
        v[0] = 0;
        z[0] = -Infinity;
        z[1] = Infinity;

        for (var q = 1; q < n; q++)
        {
            var s = ((f[q] + (q * q)) - (f[v[k]] + (v[k] * v[k]))) / (2 * q - (2 * v[k]));
            while (s <= z[k])
            {
                k--;
                s = ((f[q] + (q * q)) - (f[v[k]] + (v[k] * v[k]))) / (2 * q - (2 * v[k]));
            }

            k++;
            v[k] = q;
            z[k] = s;
            z[k + 1] = Infinity;
        }

        k = 0;
        for (var q = 0; q < n; q++)
        {
            while (z[k + 1] < q)
            {
                k++;
            }

            var distance = q - v[k];
            d[q] = (distance * distance) + f[v[k]];
        }
    }
}
