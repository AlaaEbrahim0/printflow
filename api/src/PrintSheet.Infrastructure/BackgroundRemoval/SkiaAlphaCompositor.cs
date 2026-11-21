using System.Runtime.InteropServices;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Writes the refined matte into the upscaled colour layer. RGB is copied
/// byte-for-byte; only the alpha channel changes.
/// </summary>
public sealed class SkiaAlphaCompositor : IAlphaCompositor
{
    public Task<byte[]> ApplyAlphaAsync(
        byte[] rgbPng,
        AlphaMask alpha,
        CancellationToken cancellationToken)
        => Task.Run(() => Composite(rgbPng, alpha, cancellationToken), cancellationToken);

    private static byte[] Composite(byte[] rgbPng, AlphaMask alpha, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var stream = new MemoryStream(rgbPng, writable: false);
        using var decoded = SKBitmap.Decode(stream)
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                "alpha-compositor",
                "The upscaled RGB layer could not be decoded.");

        if (decoded.Width != alpha.WidthPx || decoded.Height != alpha.HeightPx)
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                "alpha-compositor",
                $"RGB layer is {decoded.Width}x{decoded.Height} but the matte is "
                + $"{alpha.WidthPx}x{alpha.HeightPx}.");
        }

        using var source = decoded.ColorType == SKColorType.Rgba8888
            ? null
            : decoded.Copy(SKColorType.Rgba8888)
                ?? throw new BackgroundRemovalException(
                    BackgroundRemovalFailureReason.InvalidImage,
                    "alpha-compositor",
                    "The RGB layer could not be converted to RGBA.");
        var pixels = source ?? decoded;
        var count = alpha.WidthPx * alpha.HeightPx;
        var rgba = new byte[count * 4];
        Marshal.Copy(pixels.GetPixels(), rgba, 0, rgba.Length);

        for (var pixel = 0; pixel < count; pixel++)
        {
            var offset = pixel * 4;
            // The worker produces an opaque RGB layer, so premultiplied and
            // straight channels are identical here; keep the alpha write last.
            if (pixels.AlphaType == SKAlphaType.Premul && rgba[offset + 3] is > 0 and < 255)
            {
                var a = rgba[offset + 3];
                rgba[offset] = (byte)Math.Min(255, rgba[offset] * 255 / a);
                rgba[offset + 1] = (byte)Math.Min(255, rgba[offset + 1] * 255 / a);
                rgba[offset + 2] = (byte)Math.Min(255, rgba[offset + 2] * 255 / a);
            }

            rgba[offset + 3] = alpha.Pixels[pixel];
        }

        using var output = new SKBitmap(
            new SKImageInfo(alpha.WidthPx, alpha.HeightPx, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        Marshal.Copy(rgba, 0, output.GetPixels(), rgba.Length);
        using var image = SKImage.FromBitmap(output);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}
