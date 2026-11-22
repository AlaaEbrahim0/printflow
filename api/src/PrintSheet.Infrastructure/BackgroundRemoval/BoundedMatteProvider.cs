using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Caps the pixels a provider is asked to matte.
///
/// The two providers need different limits. The self-hosted model runs on the
/// workstation CPU at roughly 1 MP per 30 s, so a print-size crop blows the
/// request budget, times out, and is retried — the cutout "runs forever". Poof
/// answers in 5.5 s for 6.2 MP and 6.7 s for 24 MP and returns a matte at the
/// input resolution, so downscaling it would only soften the anti-aliased edge
/// (measured mean 17/255 alpha error against the native matte).
///
/// The budget is the *smallest* one that could run, counting the configured
/// fallback: the selector may switch providers after this decorator has already
/// resized the bytes, so a budget that only suited the primary could hand the
/// fallback an image it cannot finish in time.
///
/// When a downscale does happen, the refiner scales the matte back up to the
/// print size.
/// </summary>
public sealed class BoundedMatteProvider(
    IBackgroundRemovalService inner,
    IOptions<BackgroundRemovalOptions> removal,
    IOptions<WithoutBgOptions> withoutBg,
    IOptions<PoofOptions> poof,
    ILogger<BoundedMatteProvider> logger) : IBackgroundRemovalService
{
    public string Provider => inner.Provider;

    public IReadOnlyList<IBackgroundRemover> Providers => inner.Providers;

    public async Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken,
        string? preferredProvider = null)
    {
        var budget = BudgetFor(preferredProvider);
        using var decoded = SKBitmap.Decode(image.Bytes);
        var pixels = decoded is null ? 0L : (long)decoded.Width * decoded.Height;
        if (decoded is null || pixels <= budget)
        {
            EnsureUploadFits(image.Bytes, preferredProvider);
            return await inner.RemoveAsync(image, cancellationToken, preferredProvider);
        }

        var scale = Math.Sqrt((double)budget / pixels);
        var width = Math.Max(1, (int)(decoded.Width * scale));
        var height = Math.Max(1, (int)(decoded.Height * scale));
        using var resized = decoded.Resize(
            new SKImageInfo(width, height, decoded.ColorType, decoded.AlphaType),
            new SKSamplingOptions(SKCubicResampler.Mitchell));
        if (resized is null)
        {
            EnsureUploadFits(image.Bytes, preferredProvider);
            return await inner.RemoveAsync(image, cancellationToken, preferredProvider);
        }

        using var resizedImage = SKImage.FromBitmap(resized);
        using var data = resizedImage.Encode(SKEncodedImageFormat.Png, 100);
        var downscaled = data.ToArray();
        logger.LogInformation(
            "Downscaling the cutout input from {SourceWidth}x{SourceHeight} to {Width}x{Height} "
            + "for the provider (budget {Budget} px).",
            decoded.Width,
            decoded.Height,
            width,
            height,
            budget);

        EnsureUploadFits(downscaled, preferredProvider);
        return await inner.RemoveAsync(
            new ImageInput(downscaled, image.ContentType, image.FileName),
            cancellationToken,
            preferredProvider);
    }

    /// <summary>
    /// The upload cap belongs to the provider and applies to the bytes that are
    /// actually sent — the downscaled ones when a downscale happened. Checking the
    /// untouched crop would reject a large design that the pixel budget already
    /// brings comfortably under the cap.
    /// </summary>
    private void EnsureUploadFits(byte[] bytes, string? preferredProvider)
    {
        var limit = removal.Value.MaxInputBytes;
        if (bytes.Length <= limit)
        {
            return;
        }

        throw new BackgroundRemovalException(
            BackgroundRemovalFailureReason.InvalidImage,
            preferredProvider ?? inner.Provider,
            $"The image to send is {bytes.Length} bytes; the provider limit is {limit}. "
            + "Crop tighter before removing the background.");
    }

    /// <summary>
    /// The tightest budget among the providers this call could reach. An override
    /// replaces the primary for one job; the availability fallback still applies,
    /// so its budget counts too unless the override *is* the fallback.
    /// </summary>
    private int BudgetFor(string? preferredProvider)
    {
        var configured = removal.Value;
        var primary = string.IsNullOrWhiteSpace(preferredProvider)
            ? configured.DefaultProvider
            : preferredProvider;
        var budget = BudgetOf(primary);

        if (configured.FallbackProvider is { Length: > 0 } fallback
            && !string.Equals(fallback, primary, StringComparison.OrdinalIgnoreCase))
        {
            budget = Math.Min(budget, BudgetOf(fallback));
        }

        return budget;
    }

    private int BudgetOf(string provider)
        => string.Equals(provider, BackgroundRemovalProviders.Poof, StringComparison.OrdinalIgnoreCase)
            ? poof.Value.MaxInputPixels
            : withoutBg.Value.MaxInputPixels;
}
