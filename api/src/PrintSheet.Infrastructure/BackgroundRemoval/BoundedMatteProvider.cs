using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Caps the pixels a provider is asked to matte. Both engines compute the matte at
/// their own low internal resolution, so a print-size crop buys nothing and costs
/// minutes: a 2.7 MP crop took ~29 s on the CPU engine, which puts a 16.9 MP
/// upload well past the provider timeout, and a timed-out attempt is retried —
/// the cutout "runs forever" instead of failing. The matte is scaled back up by
/// the refiner, which already resamples it to the print size.
/// </summary>
public sealed class BoundedMatteProvider(
    IBackgroundRemovalService inner,
    IOptions<BackgroundRemovalOptions> options,
    ILogger<BoundedMatteProvider> logger) : IBackgroundRemovalService
{
    public string Provider => inner.Provider;

    public IReadOnlyList<IBackgroundRemover> Providers => inner.Providers;

    public async Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken,
        string? preferredProvider = null)
    {
        var budget = options.Value.ProviderMaxInputPixels;
        using var decoded = SKBitmap.Decode(image.Bytes);
        if (decoded is null
            || (long)decoded.Width * decoded.Height <= budget
            || (long)decoded.Width * decoded.Height == 0)
        {
            return await inner.RemoveAsync(image, cancellationToken, preferredProvider);
        }

        var scale = Math.Sqrt((double)budget / ((long)decoded.Width * decoded.Height));
        var width = Math.Max(1, (int)(decoded.Width * scale));
        var height = Math.Max(1, (int)(decoded.Height * scale));
        using var resized = decoded.Resize(
            new SKImageInfo(width, height, decoded.ColorType, decoded.AlphaType),
            new SKSamplingOptions(SKCubicResampler.Mitchell));
        if (resized is null)
        {
            return await inner.RemoveAsync(image, cancellationToken, preferredProvider);
        }

        using var resizedImage = SKImage.FromBitmap(resized);
        using var data = resizedImage.Encode(SKEncodedImageFormat.Png, 100);
        logger.LogInformation(
            "Downscaling the cutout input from {SourceWidth}x{SourceHeight} to {Width}x{Height} "
            + "for the provider (budget {Budget} px).",
            decoded.Width,
            decoded.Height,
            width,
            height,
            budget);

        return await inner.RemoveAsync(
            new ImageInput(data.ToArray(), image.ContentType, image.FileName),
            cancellationToken,
            preferredProvider);
    }
}
