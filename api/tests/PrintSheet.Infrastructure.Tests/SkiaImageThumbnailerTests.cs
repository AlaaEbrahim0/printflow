using Microsoft.Extensions.Caching.Memory;
using PrintSheet.Infrastructure.Imaging;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class SkiaImageThumbnailerTests
{
    [Fact]
    public async Task DownscalesLongestSideAndPreservesAspectAndTransparency()
    {
        var thumbnailer = CreateThumbnailer();
        await using var source = CreateArtwork(1200, 800);

        await using var rendered = await thumbnailer.RenderAsync(
            "downscale",
            source,
            120,
            CancellationToken.None);

        using var decoded = SKBitmap.Decode(((MemoryStream)rendered).ToArray());
        Assert.NotNull(decoded);
        Assert.Equal(120, decoded.Width);
        Assert.Equal(80, decoded.Height);
        Assert.Equal(0, decoded.GetPixel(0, 0).Alpha);
        Assert.Equal(255, decoded.GetPixel(60, 40).Alpha);
    }

    [Fact]
    public async Task NeverEnlargesASmallerSource()
    {
        var thumbnailer = CreateThumbnailer();
        await using var source = CreateArtwork(90, 60);

        await using var rendered = await thumbnailer.RenderAsync(
            "small",
            source,
            512,
            CancellationToken.None);

        using var decoded = SKBitmap.Decode(((MemoryStream)rendered).ToArray());
        Assert.NotNull(decoded);
        Assert.Equal(90, decoded.Width);
        Assert.Equal(60, decoded.Height);
    }

    [Fact]
    public async Task ReusesTheCachedThumbnailForTheSameImmutableVersion()
    {
        var thumbnailer = CreateThumbnailer();
        await using var source = CreateArtwork(400, 200, drawContent: false);

        await using var first = await thumbnailer.RenderAsync(
            "cached-version",
            source,
            64,
            CancellationToken.None);

        // The cached render must not touch the source stream again. If it did,
        // decoding this empty stream would fail.
        await using var second = await thumbnailer.RenderAsync(
            "cached-version",
            new MemoryStream(),
            64,
            CancellationToken.None);

        using var firstDecoded = SKBitmap.Decode(((MemoryStream)first).ToArray());
        using var secondDecoded = SKBitmap.Decode(((MemoryStream)second).ToArray());
        Assert.NotNull(firstDecoded);
        Assert.NotNull(secondDecoded);
        Assert.Equal(firstDecoded.Width, secondDecoded.Width);
        Assert.Equal(firstDecoded.Height, secondDecoded.Height);
    }

    [Fact]
    public async Task RejectsBytesThatAreNotAnImage()
    {
        var thumbnailer = CreateThumbnailer();
        await using var source = new MemoryStream([1, 2, 3, 4]);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => thumbnailer.RenderAsync("invalid", source, 64, CancellationToken.None));
    }

    private static SkiaImageThumbnailer CreateThumbnailer()
        => new(new MemoryCache(new MemoryCacheOptions { SizeLimit = 8 * 1024 * 1024 }));

    private static MemoryStream CreateArtwork(int width, int height, bool drawContent = true)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(SKColors.Transparent);
            if (drawContent)
            {
                using var paint = new SKPaint { Color = SKColors.Red };
                canvas.DrawRect(
                    SKRect.Create(width * 0.25f, height * 0.25f, width * 0.5f, height * 0.5f),
                    paint);
            }
        }

        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return new MemoryStream(data.ToArray());
    }
}
