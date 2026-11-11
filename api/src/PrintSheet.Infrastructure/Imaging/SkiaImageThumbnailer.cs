using Microsoft.Extensions.Caching.Memory;
using PrintSheet.Application.Abstractions;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Imaging;

/// <summary>
/// SkiaSharp thumbnails for the batch grid. Decoding is bounded so a page of
/// full-resolution artwork cannot exhaust API memory in one burst, and the
/// encoded PNG is cached because version files are immutable.
/// </summary>
public sealed class SkiaImageThumbnailer : IImageThumbnailer
{
    // The browser lazy-loads the grid, but several thumbnails still arrive at
    // once. Two concurrent decodes keep memory bounded on a 4 GB workstation.
    private static readonly SemaphoreSlim DecodeGate = new(2, 2);

    private readonly IMemoryCache _cache;

    public SkiaImageThumbnailer(IMemoryCache cache)
    {
        _cache = cache;
    }

    public async Task<Stream> RenderAsync(
        string cacheKey,
        Stream source,
        int maxPx,
        CancellationToken cancellationToken)
    {
        var key = $"version-thumbnail:{cacheKey}:{maxPx}";
        if (_cache.TryGetValue(key, out byte[]? cached) && cached is not null)
        {
            return new MemoryStream(cached, writable: false);
        }

        await DecodeGate.WaitAsync(cancellationToken);
        try
        {
            // Another request for the same thumbnail may have finished while we
            // waited for the gate.
            if (_cache.TryGetValue(key, out cached) && cached is not null)
            {
                return new MemoryStream(cached, writable: false);
            }

            var bytes = Render(source, maxPx);
            _cache.Set(
                key,
                bytes,
                new MemoryCacheEntryOptions
                {
                    Size = bytes.Length,
                    SlidingExpiration = TimeSpan.FromHours(2),
                });
            return new MemoryStream(bytes, writable: false);
        }
        finally
        {
            DecodeGate.Release();
        }
    }

    private static byte[] Render(Stream source, int maxPx)
    {
        if (source.CanSeek)
        {
            source.Position = 0;
        }

        using var decoded = SKBitmap.Decode(source)
            ?? throw new InvalidOperationException("The version file could not be decoded as an image.");

        var longest = Math.Max(decoded.Width, decoded.Height);
        var scale = longest > maxPx ? (double)maxPx / longest : 1.0;
        var width = Math.Max(1, (int)Math.Round(decoded.Width * scale));
        var height = Math.Max(1, (int)Math.Round(decoded.Height * scale));

        using var resized = decoded.Resize(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul),
            new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear))
            ?? throw new InvalidOperationException("The version file could not be resized.");

        using var image = SKImage.FromBitmap(resized);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}
