namespace PrintSheet.Infrastructure.BackgroundRemoval.Solid;

/// <summary>
/// Removes isolated specks after the matte is built. A component is judged by
/// its opaque core (alpha &gt; 127) but removed through its whole non-zero
/// footprint, so a speck's faint JPEG halo does not survive as a ghost.
/// </summary>
internal static class SpeckFilter
{
    public static void Remove(
        byte[] alpha,
        int width,
        int height,
        int minArea,
        CancellationToken cancellationToken)
    {
        if (minArea <= 0)
        {
            return;
        }

        var count = width * height;
        var visited = new bool[count];
        var queue = new int[count];

        for (var start = 0; start < count; start++)
        {
            if (visited[start] || alpha[start] == 0)
            {
                continue;
            }

            var head = 0;
            var tail = 0;
            var core = 0;
            visited[start] = true;
            queue[tail++] = start;

            while (head < tail)
            {
                var index = queue[head++];
                if (alpha[index] > 127)
                {
                    core++;
                }

                var x = index % width;
                var y = index / width;
                Visit(index - 1, x > 0);
                Visit(index + 1, x < width - 1);
                Visit(index - width, y > 0);
                Visit(index + width, y < height - 1);
            }

            if (core < minArea)
            {
                for (var i = 0; i < tail; i++)
                {
                    alpha[queue[i]] = 0;
                }
            }

            void Visit(int index, bool inside)
            {
                if (!inside || visited[index] || alpha[index] == 0)
                {
                    return;
                }

                visited[index] = true;
                queue[tail++] = index;
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
    }
}
