using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>Final artefact of the pipeline, still in memory.</summary>
public sealed record BackgroundRemovalPipelineResult(
    byte[] PngBytes,
    string Provider,
    TimeSpan RemovalElapsed,
    TimeSpan TotalElapsed,
    int WidthPx,
    int HeightPx);

/// <summary>
/// Crop, remove background on the small clean image, upscale the original cropped
/// colours, upscale and refine the matte, then recombine. The matte runs on the
/// cropped pixels because the open model computes it at a low internal resolution;
/// upscaling first would only cost time and add edge fringing.
///
/// Memory: every step keeps a full PNG in memory (a 6850 px RGBA layer is ~190 MB
/// decoded). One design at a time is the documented ceiling; streaming belongs with
/// the future job runner, not this use case.
/// </summary>
public sealed class BackgroundRemovalPipeline : IBackgroundRemovalPipeline
{
    private readonly IBackgroundRemovalService _remover;
    private readonly IImageCropper _cropper;
    private readonly IImageUpscaler _upscaler;
    private readonly IAlphaRefiner _refiner;
    private readonly IAlphaCompositor _compositor;
    private readonly IImageInspector _inspector;
    private readonly BackgroundRemovalOptions _options;
    private readonly ILogger<BackgroundRemovalPipeline> _logger;

    public BackgroundRemovalPipeline(
        IBackgroundRemovalService remover,
        IImageCropper cropper,
        IImageUpscaler upscaler,
        IAlphaRefiner refiner,
        IAlphaCompositor compositor,
        IImageInspector inspector,
        IOptions<BackgroundRemovalOptions> options,
        ILogger<BackgroundRemovalPipeline> logger)
    {
        _remover = remover;
        _cropper = cropper;
        _upscaler = upscaler;
        _refiner = refiner;
        _compositor = compositor;
        _inspector = inspector;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<BackgroundRemovalPipelineResult> RunAsync(
        ImageInput input,
        CancellationToken cancellationToken,
        string? preferredProvider = null)
    {
        Validate(input);
        var total = Stopwatch.StartNew();

        var croppedPng = await _cropper.CropAsync(input, cancellationToken);
        EnsureProviderPayload(croppedPng);
        var cropped = await InspectAsync(croppedPng, cancellationToken);

        var removal = await _remover.RemoveAsync(
            new ImageInput(croppedPng, "image/png", "cropped.png"),
            cancellationToken,
            preferredProvider);

        var cutout = await InspectAsync(removal.PngBytes, cancellationToken);
        if (cutout.WidthPx != cropped.WidthPx || cutout.HeightPx != cropped.HeightPx)
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                removal.Provider,
                $"Provider returned {cutout.WidthPx}x{cutout.HeightPx} but the cropped input is "
                + $"{cropped.WidthPx}x{cropped.HeightPx}.");
        }

        var upscaledPng = await _upscaler.UpscaleAsync(
            new ImageInput(croppedPng, "image/png", "cropped.png"),
            cancellationToken);
        var upscaled = await InspectAsync(upscaledPng, cancellationToken);

        var alpha = await _refiner.RefineAsync(
            new AlphaRefinement(removal.PngBytes, upscaled.WidthPx, upscaled.HeightPx),
            cancellationToken);
        var finalPng = await _compositor.ApplyAlphaAsync(upscaledPng, alpha, cancellationToken);

        total.Stop();
        _logger.LogInformation(
            "Background removal pipeline succeeded: provider={Provider} inputBytes={InputBytes} "
            + "outputBytes={OutputBytes} removalMs={RemovalMs} totalMs={TotalMs} "
            + "widthPx={WidthPx} heightPx={HeightPx}",
            removal.Provider,
            input.Bytes.Length,
            finalPng.Length,
            (long)removal.Elapsed.TotalMilliseconds,
            (long)total.Elapsed.TotalMilliseconds,
            upscaled.WidthPx,
            upscaled.HeightPx);

        return new BackgroundRemovalPipelineResult(
            finalPng,
            removal.Provider,
            removal.Elapsed,
            total.Elapsed,
            upscaled.WidthPx,
            upscaled.HeightPx);
    }

    private void Validate(ImageInput input)
    {
        if (input.Bytes.Length == 0)
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                _remover.Provider,
                "The image is empty.");
        }

        if (!_options.IsAllowedContentType(input.ContentType))
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                _remover.Provider,
                $"Content type '{input.ContentType}' is not allowed.");
        }
    }

    /// <summary>
    /// The size limit belongs to the provider, so it is enforced on the bytes that
    /// are actually uploaded — the cropped image, which is what the matte runs on.
    /// Applying it to the untouched original would reject a large upload that
    /// cropping already brings comfortably under the cap.
    /// </summary>
    private void EnsureProviderPayload(byte[] croppedPng)
    {
        if (croppedPng.Length > _options.MaxInputBytes)
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                _remover.Provider,
                $"The cropped image is {croppedPng.Length} bytes; the provider limit is "
                + $"{_options.MaxInputBytes}. Crop tighter before removing the background.");
        }
    }

    private async Task<ImageInspection> InspectAsync(byte[] png, CancellationToken cancellationToken)
    {
        await using var stream = new MemoryStream(png, writable: false);
        return await _inspector.InspectAsync(stream, cancellationToken);
    }
}
