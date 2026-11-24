using PrintSheet.Application.Abstractions;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Removes the background colour still mixed into semi-transparent pixels:
/// <c>C = (I - (1 - a)B) / a</c>, clamped to 0-255. Only pixels with fractional
/// alpha are touched; opaque and fully transparent pixels keep their bytes.
/// </summary>
public sealed class SkiaBackgroundDecontaminator : IBackgroundDecontaminator
{
    public Task<byte[]> DecontaminateAsync(
        byte[] rgbaPng,
        RgbColor backgroundColor,
        CancellationToken cancellationToken)
        => Task.Run(() => Decontaminate(rgbaPng, backgroundColor, cancellationToken), cancellationToken);

    private static byte[] Decontaminate(
        byte[] rgbaPng,
        RgbColor background,
        CancellationToken cancellationToken)
    {
        var image = SkiaRgbaImage.Decode(rgbaPng, "decontaminator");
        var pixels = image.Pixels;
        var count = image.Width * image.Height;

        for (var index = 0; index < count; index++)
        {
            var offset = index * 4;
            var alpha = pixels[offset + 3];
            if (alpha is 0 or 255)
            {
                continue;
            }

            var a = alpha / 255d;
            var inverse = 1 - a;
            pixels[offset] = Unmix(pixels[offset], inverse, background.R);
            pixels[offset + 1] = Unmix(pixels[offset + 1], inverse, background.G);
            pixels[offset + 2] = Unmix(pixels[offset + 2], inverse, background.B);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return SkiaRgbaImage.Encode(image);
    }

    private static byte Unmix(byte channel, double inverse, byte background)
        => (byte)Math.Clamp(
            (int)Math.Round((channel - (inverse * background)) / (1 - inverse)),
            0,
            255);
}
