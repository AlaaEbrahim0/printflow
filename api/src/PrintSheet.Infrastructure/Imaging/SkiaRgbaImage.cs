using System.Runtime.InteropServices;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Imaging;

/// <summary>Straight (unpremultiplied) RGBA8 pixels, the shape every pixel pass uses.</summary>
internal sealed record RgbaImage(byte[] Pixels, int Width, int Height);

/// <summary>Decode/encode helpers shared by the deterministic pixel passes.</summary>
internal static class SkiaRgbaImage
{
    public static RgbaImage Decode(byte[] png, string provider)
    {
        using var stream = new MemoryStream(png, writable: false);
        using var decoded = SKBitmap.Decode(stream)
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                provider,
                "The image could not be decoded.");

        using var converted = decoded.ColorType == SKColorType.Rgba8888
            ? null
            : decoded.Copy(SKColorType.Rgba8888)
                ?? throw new BackgroundRemovalException(
                    BackgroundRemovalFailureReason.InvalidImage,
                    provider,
                    "The image could not be converted to RGBA.");

        var bitmap = converted ?? decoded;
        var pixels = new byte[bitmap.Width * bitmap.Height * 4];
        Marshal.Copy(bitmap.GetPixels(), pixels, 0, pixels.Length);

        if (bitmap.AlphaType == SKAlphaType.Premul)
        {
            Unpremultiply(pixels);
        }

        return new RgbaImage(pixels, bitmap.Width, bitmap.Height);
    }

    public static byte[] Encode(RgbaImage image)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(image.Width, image.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        Marshal.Copy(image.Pixels, 0, bitmap.GetPixels(), image.Pixels.Length);
        using var skiaImage = SKImage.FromBitmap(bitmap);
        using var data = skiaImage.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static void Unpremultiply(byte[] rgba)
    {
        for (var offset = 0; offset < rgba.Length; offset += 4)
        {
            var alpha = rgba[offset + 3];
            if (alpha is 0 or 255)
            {
                continue;
            }

            rgba[offset] = (byte)Math.Min(255, rgba[offset] * 255 / alpha);
            rgba[offset + 1] = (byte)Math.Min(255, rgba[offset + 1] * 255 / alpha);
            rgba[offset + 2] = (byte)Math.Min(255, rgba[offset + 2] * 255 / alpha);
        }
    }
}
