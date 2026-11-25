using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class SkiaEnclosedBackgroundCleanerTests
{
    [Fact]
    public async Task ClearsTheEnclosedCounterAndKeepsTheArtworkOpaque()
    {
        // A ring of opaque white on a transparent page, with a keyed-colour hole in
        // the middle: exactly what the compositor leaves behind when the provider
        // matted the outside but could not reach the letter counter.
        var png = RingPng(hole: (26, 26, 12, 12));

        var outcome = await Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.True(outcome.Applied);
        Assert.Null(outcome.SkippedReason);
        Assert.Equal(1, outcome.RegionsCleared);
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 32, 32));
        // The page outside the ring was already transparent, and the ink stays put.
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 2, 2));
        Assert.Equal(255, AlphaAt(outcome.PngBytes, 12, 32));
    }

    [Fact]
    public async Task LeavesRegionsSmallerThanTheMinimumAreaAlone()
    {
        // 4x4 = 16 px, below the 64 px floor: a dark detail inside a letter is not
        // a counter, and clearing it would punch a hole in the design.
        var png = RingPng(hole: (30, 30, 4, 4));

        var outcome = await Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.False(outcome.Applied);
        Assert.Equal("no-enclosed-regions", outcome.SkippedReason);
        Assert.Equal(255, AlphaAt(outcome.PngBytes, 32, 32));
        Assert.Same(png, outcome.PngBytes);
    }

    [Fact]
    public async Task RefusesTheWholeImageWhenOneEnclosedRegionExceedsTheCap()
    {
        // 30x30 = 900 px of 4096, above the 10% cap: what an inverted logo, whose
        // ink *is* the background colour, looks like.
        var png = RingPng(hole: (17, 17, 30, 30), ringThickness: 6);

        var outcome = await Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.False(outcome.Applied);
        Assert.Equal("region-too-large", outcome.SkippedReason);
        Assert.Equal(0, outcome.RegionsCleared);
        // All-or-nothing: the pass must not clear the regions it likes and leave
        // the rest, or the result would depend on iteration order.
        Assert.Equal(255, AlphaAt(outcome.PngBytes, 32, 32));
        Assert.Same(png, outcome.PngBytes);
    }

    [Fact]
    public async Task TheCapIsPerRegionNotOnTheTotal()
    {
        // Nine 20x20 counters (3600 px total, 15.6% of the canvas) on a page whose
        // largest single counter is 400 px (1.7%). This is an ordinary white "Bo8"
        // on black: the *total* share is irrelevant, only one region the size of the
        // design is dangerous.
        var png = CreateRgbaPng(152, 152, (pixels, width) =>
        {
            FillRect(pixels, width, 0, 0, 152, 152, [255, 255, 255, 255]);
            for (var row = 0; row < 3; row++)
            {
                for (var column = 0; column < 3; column++)
                {
                    FillRect(pixels, width, 16 + (column * 44), 16 + (row * 44), 20, 20, [0, 0, 0, 255]);
                }
            }
        });

        var outcome = await Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.True(outcome.Applied);
        Assert.Equal(9, outcome.RegionsCleared);
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 25, 25));
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 113, 113));
        Assert.Equal(255, AlphaAt(outcome.PngBytes, 2, 2));
    }

    [Fact]
    public async Task RecoversTheKeyFromTheTransparentBorderWhenTheRemoverReportsNone()
    {
        var png = RingPng(hole: (26, 26, 12, 12));

        var outcome = await Cleaner().ClearAsync(png, backgroundColor: null, CancellationToken.None);

        Assert.True(outcome.Applied);
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 32, 32));
    }

    [Fact]
    public async Task SkipsWhenNoBackgroundColourCanBeEstablished()
    {
        // A fully opaque page: the border has no transparent pixels to sample, so
        // there is no key to trust and nothing may be cleared.
        var png = CreateRgbaPng(64, 64, (pixels, width) =>
        {
            FillRect(pixels, width, 0, 0, 64, 64, [255, 255, 255, 255]);
            FillRect(pixels, width, 26, 26, 12, 12, [0, 0, 0, 255]);
        });

        var outcome = await Cleaner().ClearAsync(png, backgroundColor: null, CancellationToken.None);

        Assert.False(outcome.Applied);
        Assert.Equal("no-background-key", outcome.SkippedReason);
        Assert.Same(png, outcome.PngBytes);
    }

    [Fact]
    public async Task NeverTouchesABackgroundReachableFromTheFrameEdge()
    {
        // A page with no artwork at all: every pixel is the key colour, so the
        // flood reaches all of it and nothing is enclosed.
        var png = CreateRgbaPng(64, 64, (pixels, width) => FillRect(pixels, width, 0, 0, 64, 64, [0, 0, 0, 255]));

        var outcome = await Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.False(outcome.Applied);
        Assert.Equal("no-enclosed-regions", outcome.SkippedReason);
        Assert.Equal(255, AlphaAt(outcome.PngBytes, 32, 32));
    }

    [Fact]
    public async Task ClearsEveryCounterInOnePass()
    {
        // Three separate counters inside one opaque block, each above the floor.
        var png = CreateRgbaPng(96, 64, (pixels, width) =>
        {
            FillRect(pixels, width, 0, 0, 96, 64, [0, 0, 0, 0]);
            FillRect(pixels, width, 8, 8, 80, 48, [255, 255, 255, 255]);
            FillRect(pixels, width, 16, 20, 12, 12, [0, 0, 0, 255]);
            FillRect(pixels, width, 40, 20, 12, 12, [0, 0, 0, 255]);
            FillRect(pixels, width, 64, 20, 12, 12, [0, 0, 0, 255]);
        });

        var outcome = await Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.True(outcome.Applied);
        Assert.Equal(3, outcome.RegionsCleared);
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 21, 25));
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 45, 25));
        Assert.Equal(0, AlphaAt(outcome.PngBytes, 69, 25));
        Assert.Equal(255, AlphaAt(outcome.PngBytes, 12, 12));
    }

    [Fact]
    public async Task ASoftCounterEdgeDoesNotLeaveAnOpaqueNearBackgroundRing()
    {
        // Same defect as the outer silhouette, on the counter side. The counter's
        // rebuild used a fixed radius too, so a counter whose keyed colour bleeds
        // a few pixels into the ink (a JPEG-compressed upload) kept a fully opaque
        // near-background ring around the hole instead of a ramp.
        var png = CreateRgbaPng(64, 64, (pixels, width) =>
        {
            FillRect(pixels, width, 0, 0, 64, 64, [0, 0, 0, 0]);
            // Opaque ink page.
            FillRect(pixels, width, 6, 6, 52, 52, [255, 255, 255, 255]);
            // A keyed hole, surrounded by a 5 px gradient ring that is ink-coloured
            // but still close to the key. Values climb 50 -> 170, so the first two
            // rings are visually dark: if the ramp stops early they stay fully
            // opaque and print as a dirty ring around the counter. Draw outermost
            // first so each smaller ring overwrites the inside of the previous one.
            for (var ring = 5; ring >= 1; ring--)
            {
                var value = (byte)(30 + (ring * 28));
                FillRect(
                    pixels,
                    width,
                    26 - ring,
                    26 - ring,
                    12 + (ring * 2),
                    12 + (ring * 2),
                    [value, value, value, 255]);
            }

            FillRect(pixels, width, 26, 26, 12, 12, [0, 0, 0, 255]);
        });

        var outcome = await Cleaner(new BackgroundRemovalOptions
        {
            CounterEdgeBandPixels = 1,
            CounterMaxEdgeBandPixels = 12,
        }).ClearAsync(png, new RgbColor(0, 0, 0), CancellationToken.None);

        Assert.True(outcome.Applied);

        // No pixel that is still visually dark may be fully opaque. Scan the whole
        // page: the damage from a truncated ramp sits a few pixels out from the
        // hole, so a narrow window is not evidence either way.
        var (rgb, alpha, width2, height2) = DecodeSplit(outcome.PngBytes);
        var darkOpaque = 0;
        for (var i = 0; i < width2 * height2; i++)
        {
            if (alpha[i] == 255 && rgb[i * 3] + rgb[(i * 3) + 1] + rgb[(i * 3) + 2] < 300)
            {
                darkOpaque++;
            }
        }

        Assert.True(darkOpaque == 0, $"{darkOpaque} opaque pixels around the counter are still background-dark.");
    }

    [Fact]
    public async Task HonoursCancellation()
    {
        var png = RingPng(hole: (26, 26, 12, 12));
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Cleaner().ClearAsync(png, new RgbColor(0, 0, 0), cancelled.Token));
    }

    private static SkiaEnclosedBackgroundCleaner Cleaner(BackgroundRemovalOptions? options = null)
        => new(
            Options.Create(options ?? new BackgroundRemovalOptions { CounterEdgeBandPixels = 1 }),
            NullLogger<SkiaEnclosedBackgroundCleaner>.Instance);

    /// <summary>
    /// An opaque square ring on a transparent page, with a keyed-colour hole inside
    /// it that keeps alpha 255 — how a provider matte leaves a counter behind.
    /// </summary>
    private static byte[] RingPng(
        (int Left, int Top, int Width, int Height) hole,
        int size = 64,
        int ringThickness = 10)
        => CreateRgbaPng(size, size, (pixels, width) =>
        {
            FillRect(pixels, width, 0, 0, size, size, [0, 0, 0, 0]);
            FillRect(pixels, width, ringThickness, ringThickness, size - (ringThickness * 2), size - (ringThickness * 2), [255, 255, 255, 255]);
            FillRect(pixels, width, hole.Left, hole.Top, hole.Width, hole.Height, [0, 0, 0, 255]);
        });

    private static void FillRect(
        byte[] pixels,
        int width,
        int left,
        int top,
        int rectWidth,
        int rectHeight,
        byte[] rgba)
    {
        for (var y = top; y < top + rectHeight; y++)
        {
            for (var x = left; x < left + rectWidth; x++)
            {
                var offset = ((y * width) + x) * 4;
                pixels[offset] = rgba[0];
                pixels[offset + 1] = rgba[1];
                pixels[offset + 2] = rgba[2];
                pixels[offset + 3] = rgba[3];
            }
        }
    }

    private static byte[] CreateRgbaPng(int width, int height, Action<byte[], int> draw)
    {
        var pixels = new byte[width * height * 4];
        draw(pixels, width);
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        Marshal.Copy(pixels, 0, bitmap.GetPixels(), pixels.Length);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static (byte[] Pixels, int Width) DecodeRgba(byte[] png)
    {
        using var bitmap = SKBitmap.Decode(png);
        using var converted = bitmap.ColorType == SKColorType.Rgba8888
            ? null
            : bitmap.Copy(SKColorType.Rgba8888);
        var source = converted ?? bitmap;
        var pixels = new byte[source.Width * source.Height * 4];
        Marshal.Copy(source.GetPixels(), pixels, 0, pixels.Length);
        return (pixels, source.Width);
    }

    private static (byte[] Rgb, byte[] Alpha, int Width, int Height) DecodeSplit(byte[] png)
    {
        var (pixels, width) = DecodeRgba(png);
        var height = pixels.Length / 4 / width;
        var rgb = new byte[width * height * 3];
        var alpha = new byte[width * height];
        for (var i = 0; i < width * height; i++)
        {
            rgb[i * 3] = pixels[i * 4];
            rgb[(i * 3) + 1] = pixels[(i * 4) + 1];
            rgb[(i * 3) + 2] = pixels[(i * 4) + 2];
            alpha[i] = pixels[(i * 4) + 3];
        }

        return (rgb, alpha, width, height);
    }

    private static byte AlphaAt(byte[] png, int x, int y)
    {
        var (pixels, width) = DecodeRgba(png);
        return pixels[(((y * width) + x) * 4) + 3];
    }
}
