using System.Runtime.InteropServices;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Phase 1 matte refinement: bicubic (Mitchell) upscale of the provider's matte,
/// followed by an optional contraction of the selection border, an optional
/// feather and an optional hard threshold. Deliberately no guided filter yet;
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
        if (_options.AlphaContractPx > 0)
        {
            // Photoshop's Select > Modify > Contract moves the *selection border*
            // inward, and the border is where the matte is at least half visible.
            // The provider matte is computed at the cropped source size and then
            // upscaled several times, so its "soft" edge is often eight or more
            // pixels of near-transparent haze. Eroding the soft ramp itself only
            // shifts it; eroding the selection cuts the haze, and the feather
            // below rebuilds the anti-aliased ramp on the new border.
            var edge = (byte)(_options.AlphaThreshold ?? 128);
            for (var i = 0; i < alpha.Length; i++)
            {
                alpha[i] = alpha[i] >= edge ? byte.MaxValue : byte.MinValue;
            }

            Erode(alpha, refinement.TargetWidthPx, refinement.TargetHeightPx, _options.AlphaContractPx);
            cancellationToken.ThrowIfCancellationRequested();
        }

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

    /// <summary>
    /// Contract a binary selection by <paramref name="radius"/> pixels: a pixel
    /// stays selected only when its whole circular neighbourhood is selected.
    ///
    /// The neighbourhood is a Euclidean disk, not a square. A square (Chebyshev)
    /// kernel pulls a diagonal edge by <c>radius × sqrt(2)</c>, so a 2 px
    /// contract would shave 2.8 px off a circle; the disk keeps the offset the
    /// same in every direction. Edge pixels clamp, so a subject that bleeds to
    /// the crop border is not eaten inward from the frame.
    /// </summary>
    private static void Erode(byte[] pixels, int width, int height, int radius)
    {
        var offsets = DiskOffsets(radius);

        // The clamp never changes across a row, so resolve each column once
        // instead of twice per pixel; an upscaled print layer is tens of
        // millions of pixels.
        var columns = new int[offsets.Length][];
        for (var i = 0; i < offsets.Length; i++)
        {
            var columnsForOffset = new int[width];
            for (var x = 0; x < width; x++)
            {
                columnsForOffset[x] = Math.Clamp(x + offsets[i].Dx, 0, width - 1);
            }

            columns[i] = columnsForOffset;
        }

        var rows = new int[offsets.Length];
        var eroded = new byte[pixels.Length];
        for (var y = 0; y < height; y++)
        {
            for (var i = 0; i < offsets.Length; i++)
            {
                rows[i] = Math.Clamp(y + offsets[i].Dy, 0, height - 1) * width;
            }

            var row = y * width;
            for (var x = 0; x < width; x++)
            {
                var minimum = byte.MaxValue;
                for (var i = 0; i < offsets.Length; i++)
                {
                    var value = pixels[rows[i] + columns[i][x]];
                    if (value < minimum)
                    {
                        minimum = value;
                    }
                }

                eroded[row + x] = minimum;
            }
        }

        Array.Copy(eroded, pixels, pixels.Length);
    }

    private static (int Dx, int Dy)[] DiskOffsets(int radius)
    {
        var squared = radius * radius;
        var offsets = new List<(int Dx, int Dy)>((radius * 2 + 1) * (radius * 2 + 1));
        for (var dy = -radius; dy <= radius; dy++)
        {
            for (var dx = -radius; dx <= radius; dx++)
            {
                if ((dx * dx) + (dy * dy) <= squared)
                {
                    offsets.Add((dx, dy));
                }
            }
        }

        return offsets.ToArray();
    }
}
