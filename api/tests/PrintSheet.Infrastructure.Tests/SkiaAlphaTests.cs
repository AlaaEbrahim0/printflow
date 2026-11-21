using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class SkiaAlphaTests
{
    [Fact]
    public async Task CompositorKeepsColourAndReplacesAlpha()
    {
        var rgb = CreateRgbaPng(2, 1, [60, 120, 180, 255, 200, 100, 50, 255]);
        var compositor = new SkiaAlphaCompositor();

        var png = await compositor.ApplyAlphaAsync(
            rgb,
            new AlphaMask([0, 255], 2, 1),
            CancellationToken.None);

        var pixels = DecodePixels(png);
        // Skia's PNG encoder zeroes the colour under a fully transparent pixel;
        // that channel is invisible and not part of the contract.
        Assert.Equal(0, pixels[3]);
        Assert.Equal([200, 100, 50, 255], pixels[4..]);
    }

    [Fact]
    public async Task CompositorRejectsAMatteOfTheWrongSize()
    {
        var rgb = CreateRgbaPng(2, 1, new byte[8]);

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => new SkiaAlphaCompositor().ApplyAlphaAsync(
                rgb,
                new AlphaMask([1], 1, 1),
                CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
    }

    [Fact]
    public async Task RefinerUpscalesAMatteToTheColourSize()
    {
        // 4x4 matte, opaque centre, transparent border.
        var alpha = new byte[16];
        alpha[5] = alpha[6] = alpha[9] = alpha[10] = 255;
        var cutout = CreateRgbaPng(4, 4, ToRgba(alpha));
        var refiner = CreateRefiner(feather: 0, threshold: null);

        var mask = await refiner.RefineAsync(
            new AlphaRefinement(cutout, 8, 8),
            CancellationToken.None);

        Assert.Equal(8, mask.WidthPx);
        Assert.Equal(8, mask.HeightPx);
        Assert.True(mask.Pixels[3 * 8 + 3] > 200);
        Assert.Equal(0, mask.Pixels[0]);
    }

    [Fact]
    public async Task ThresholdSnapsSoftMatteValuesWhenEnabled()
    {
        var cutout = CreateRgbaPng(2, 1, ToRgba([40, 200]));
        var refiner = CreateRefiner(feather: 0, threshold: 128);

        var mask = await refiner.RefineAsync(
            new AlphaRefinement(cutout, 2, 1),
            CancellationToken.None);

        Assert.Equal([0, 255], mask.Pixels);
    }

    [Fact]
    public async Task FeatherSoftensAHardMatteEdge()
    {
        // 5x1: opaque, opaque, transparent, transparent, transparent.
        var cutout = CreateRgbaPng(5, 1, ToRgba([255, 255, 0, 0, 0]));

        var hard = await CreateRefiner(feather: 0, threshold: null).RefineAsync(
            new AlphaRefinement(cutout, 5, 1),
            CancellationToken.None);
        var feathered = await CreateRefiner(feather: 1, threshold: null).RefineAsync(
            new AlphaRefinement(cutout, 5, 1),
            CancellationToken.None);

        Assert.Equal([255, 255, 0, 0, 0], hard.Pixels);
        // A 3-tap pass averages each pixel with its clamped neighbours.
        Assert.Equal([255, 170, 85, 0, 0], feathered.Pixels);
    }

    [Fact]
    public async Task FeatherIsAnEdgeBlurNotAGlobalDim()
    {
        var cutout = CreateRgbaPng(6, 1, ToRgba([255, 255, 255, 255, 255, 255]));

        var mask = await CreateRefiner(feather: 2, threshold: null).RefineAsync(
            new AlphaRefinement(cutout, 6, 1),
            CancellationToken.None);

        Assert.All(mask.Pixels, value => Assert.Equal(255, value));
    }

    [Fact]
    public async Task RefinerRejectsBytesThatAreNotAnImage()
    {
        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => CreateRefiner(0, null).RefineAsync(
                new AlphaRefinement([1, 2, 3], 2, 2),
                CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
    }

    private static SkiaAlphaRefiner CreateRefiner(double feather, int? threshold)
        => new(Options.Create(
            new BackgroundRemovalOptions { AlphaFeatherPx = feather, AlphaThreshold = threshold }));

    private static byte[] ToRgba(byte[] alpha)
    {
        var rgba = new byte[alpha.Length * 4];
        for (var i = 0; i < alpha.Length; i++)
        {
            rgba[(i * 4) + 3] = alpha[i];
        }

        return rgba;
    }

    private static byte[] CreateRgbaPng(int width, int height, byte[] rgba)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        System.Runtime.InteropServices.Marshal.Copy(rgba, 0, bitmap.GetPixels(), rgba.Length);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static byte[] DecodePixels(byte[] png)
    {
        using var decoded = SKBitmap.Decode(png);
        Assert.NotNull(decoded);
        using var rgba = decoded.ColorType == SKColorType.Rgba8888
            ? null
            : decoded.Copy(SKColorType.Rgba8888);
        var pixels = new byte[decoded.Width * decoded.Height * 4];
        System.Runtime.InteropServices.Marshal.Copy(
            (rgba ?? decoded).GetPixels(),
            pixels,
            0,
            pixels.Length);
        return pixels;
    }
}
