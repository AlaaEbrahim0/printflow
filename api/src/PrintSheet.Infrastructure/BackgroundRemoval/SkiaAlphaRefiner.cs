using System.Runtime.InteropServices;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Phase 1 matte refinement: bicubic (Mitchell) upscale of the provider's matte,
/// followed by optional feather and threshold. Deliberately no guided filter yet;
/// that would replace this class behind <see cref="IAlphaRefiner"/>.
/// </summary>
public sealed class SkiaAlphaRefiner(IOptions<BackgroundRemovalOptions> options) : IAlphaRefiner
{
    private readonly BackgroundRemovalOptions _options = options.Value;

    public Task<AlphaMask> RefineAsync(
        AlphaRefinement refinement,
        CancellationToken cancellationToken)
        => Task.Run(() => Refine(refinement, cancellationToken), cancellationToken);

    private AlphaMask Refine(AlphaRefinement refinement, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var (source, width, height) = DecodeAlpha(refinement.CutoutRgbaPng);

        using var sourceBitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Gray8, SKAlphaType.Opaque));
        Marshal.Copy(source, 0, sourceBitmap.GetPixels(), source.Length);

        using var targetBitmap = sourceBitmap.Resize(
            new SKImageInfo(
                refinement.TargetWidthPx,
                refinement.TargetHeightPx,
                SKColorType.Gray8,
                SKAlphaType.Opaque),
            // Bicubic/Mitchell keeps a soft matte edge; nearest or bilinear would
            // stair-step the alpha at upscaled sizes.
            new SKSamplingOptions(SKCubicResampler.Mitchell))
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.Unexpected,
                "alpha-refiner",
                "The matte could not be upscaled.");

        var alpha = ReadGray(targetBitmap);
        cancellationToken.ThrowIfCancellationRequested();

        var featherRadius = (int)Math.Round(_options.AlphaFeatherPx, MidpointRounding.AwayFromZero);
        if (featherRadius > 0)
        {
            BoxBlur(alpha, refinement.TargetWidthPx, refinement.TargetHeightPx, featherRadius);
        }

        if (_options.AlphaThreshold is { } threshold)
        {
            for (var i = 0; i < alpha.Length; i++)
            {
                alpha[i] = alpha[i] >= threshold ? (byte)255 : (byte)0;
            }
        }

        return new AlphaMask(alpha, refinement.TargetWidthPx, refinement.TargetHeightPx);
    }

    private static (byte[] Alpha, int Width, int Height) DecodeAlpha(byte[] cutoutPng)
    {
        using var stream = new MemoryStream(cutoutPng, writable: false);
        using var decoded = SKBitmap.Decode(stream)
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                "alpha-refiner",
                "The provider cutout could not be decoded.");

        if (decoded.ColorType != SKColorType.Rgba8888)
        {
            using var converted = decoded.Copy(SKColorType.Rgba8888)
                ?? throw new BackgroundRemovalException(
                    BackgroundRemovalFailureReason.InvalidImage,
                    "alpha-refiner",
                    "The provider cutout could not be converted to RGBA.");
            return ExtractAlpha(converted);
        }

        return ExtractAlpha(decoded);
    }

    private static (byte[], int, int) ExtractAlpha(SKBitmap bitmap)
    {
        var count = bitmap.Width * bitmap.Height;
        var rgba = new byte[count * 4];
        Marshal.Copy(bitmap.GetPixels(), rgba, 0, rgba.Length);
        var alpha = new byte[count];
        for (var pixel = 0; pixel < count; pixel++)
        {
            alpha[pixel] = rgba[(pixel * 4) + 3];
        }

        return (alpha, bitmap.Width, bitmap.Height);
    }

    private static byte[] ReadGray(SKBitmap bitmap)
    {
        var pixels = new byte[bitmap.Width * bitmap.Height];
        for (var y = 0; y < bitmap.Height; y++)
        {
            Marshal.Copy(
                bitmap.GetPixels() + (y * bitmap.RowBytes),
                pixels,
                y * bitmap.Width,
                bitmap.Width);
        }

        return pixels;
    }

    /// <summary>
    /// One separable box pass; a 0.5 px feather becomes a 3-tap blur.
    ///
    /// Sliding-window sums keep this O(pixels) rather than O(pixels × radius):
    /// a 6850 px print layer is 47 M pixels, and the naive version would be
    /// billions of adds at the maximum feather.
    /// </summary>
    private static void BoxBlur(byte[] pixels, int width, int height, int radius)
    {
        var horizontal = new byte[pixels.Length];
        var window = (radius * 2) + 1;

        for (var y = 0; y < height; y++)
        {
            var row = y * width;
            // Seed the window with the left edge replicated `radius` times.
            var sum = 0;
            for (var k = -radius; k <= radius; k++)
            {
                sum += pixels[row + Math.Clamp(k, 0, width - 1)];
            }

            for (var x = 0; x < width; x++)
            {
                horizontal[row + x] = (byte)(sum / window);
                var leaving = pixels[row + Math.Clamp(x - radius, 0, width - 1)];
                var entering = pixels[row + Math.Clamp(x + radius + 1, 0, width - 1)];
                sum += entering - leaving;
            }
        }

        for (var x = 0; x < width; x++)
        {
            var sum = 0;
            for (var k = -radius; k <= radius; k++)
            {
                sum += horizontal[(Math.Clamp(k, 0, height - 1) * width) + x];
            }

            for (var y = 0; y < height; y++)
            {
                pixels[(y * width) + x] = (byte)(sum / window);
                var leaving = horizontal[(Math.Clamp(y - radius, 0, height - 1) * width) + x];
                var entering = horizontal[(Math.Clamp(y + radius + 1, 0, height - 1) * width) + x];
                sum += entering - leaving;
            }
        }
    }
}
