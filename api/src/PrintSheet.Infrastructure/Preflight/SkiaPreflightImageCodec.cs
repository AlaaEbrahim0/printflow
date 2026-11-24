using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Application.Preflight;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.Preflight;

/// <summary>
/// Decodes to straight RGBA8 for the pixel checks and re-encodes with the
/// metadata the fixes repaired. Reuses the shared Skia helper so preflight and
/// the cut-out agree on colour handling.
/// </summary>
public sealed class SkiaPreflightImageCodec : IPreflightImageCodec
{
    public PreflightImage Decode(byte[] png)
    {
        var info = PngMetadata.Read(png);

        RgbaImage rgba;
        try
        {
            rgba = SkiaRgbaImage.Decode(png, "preflight");
        }
        catch (BackgroundRemovalException exception)
        {
            throw PreflightException.Unsupported(exception.Message);
        }

        return new PreflightImage(
            rgba.Pixels,
            rgba.Width,
            rgba.Height,
            info.HasAlphaChannel,
            info.BitDepth,
            info.HasSrgbProfile,
            info.DpiX,
            info.DpiY);
    }

    public byte[] Encode(PreflightImage image)
    {
        var png = SkiaRgbaImage.Encode(new RgbaImage(image.Pixels, image.Width, image.Height));
        var chunks = new List<(string Type, byte[] Data)>();

        if (image.HasSrgbProfile)
        {
            chunks.Add(("sRGB", PngMetadata.SrgbChunk()));
        }

        if (image.DpiX is { } dpiX && image.DpiY is { } dpiY)
        {
            chunks.Add(("pHYs", PngMetadata.PhysChunk(dpiX, dpiY)));
        }

        return chunks.Count == 0 ? png : PngMetadata.WithChunks(png, chunks);
    }
}
