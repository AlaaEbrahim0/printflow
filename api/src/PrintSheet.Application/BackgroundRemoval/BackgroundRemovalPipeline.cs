using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;

namespace PrintSheet.Application.BackgroundRemoval;

/// <summary>Final artefact of the pipeline, still in memory.</summary>
/// <param name="PngBytes">The cut-out PNG.</param>
/// <param name="Provider">Adapter that produced the matte.</param>
/// <param name="RemovalElapsed">Time inside the provider.</param>
/// <param name="TotalElapsed">Time for the whole pipeline.</param>
/// <param name="WidthPx">Output width.</param>
/// <param name="HeightPx">Output height.</param>
/// <param name="EnclosedBackground">
/// What the optional counter pass did, or null when it was not requested.
/// </param>
public sealed record BackgroundRemovalPipelineResult(
    byte[] PngBytes,
    string Provider,
    TimeSpan RemovalElapsed,
    TimeSpan TotalElapsed,
    int WidthPx,
    int HeightPx,
    EnclosedBackgroundOutcome? EnclosedBackground = null);

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
    private readonly IBackgroundDecontaminator _decontaminator;
    private readonly IEnclosedBackgroundCleaner _enclosedCleaner;
    private readonly IImageInspector _inspector;
    private readonly BackgroundRemovalOptions _options;
    private readonly ILogger<BackgroundRemovalPipeline> _logger;

    public BackgroundRemovalPipeline(
        IBackgroundRemovalService remover,
        IImageCropper cropper,
        IImageUpscaler upscaler,
        IAlphaRefiner refiner,
        IAlphaCompositor compositor,
        IBackgroundDecontaminator decontaminator,
        IEnclosedBackgroundCleaner enclosedCleaner,
        IImageInspector inspector,
        IOptions<BackgroundRemovalOptions> options,
        ILogger<BackgroundRemovalPipeline> logger)
    {
        _remover = remover;
        _cropper = cropper;
        _upscaler = upscaler;
        _refiner = refiner;
        _compositor = compositor;
        _decontaminator = decontaminator;
        _enclosedCleaner = enclosedCleaner;
        _inspector = inspector;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<BackgroundRemovalPipelineResult> RunAsync(
        ImageInput input,
        CancellationToken cancellationToken,
        string? preferredProvider = null,
        bool preserveSize = false,
        bool removeEnclosedBackground = false)
    {
        Validate(input);
        var total = Stopwatch.StartNew();

        // The shop's step order is crop → enhance → set print size → remove
        // background, so the cut-out normally runs on a version whose pixel size
        // is already the approved print size. In that position the internal
        // auto-crop and the AI upscale must both be skipped: either one changes
        // the dimensions, and the packer requires the final version to be exactly
        // the target pixels. The matte is still computed on the cropped *view* of
        // the same bytes, so the subject is centred in the provider's input
        // without moving the output frame.
        var croppedPng = preserveSize
            ? input.Bytes
            : await _cropper.CropAsync(input, cancellationToken);
        var cropped = await InspectAsync(croppedPng, cancellationToken);

        var removal = await _remover.RemoveAsync(
            new ImageInput(croppedPng, "image/png", "cropped.png"),
            cancellationToken,
            preferredProvider);

        var cutout = await InspectAsync(removal.PngBytes, cancellationToken);
        // A provider matte may be smaller than the crop (the providers compute it
        // at their own internal resolution); the refiner scales it up. It may not
        // be larger, and the aspect ratio must survive, so a mangled result is
        // still rejected rather than smeared over the artwork.
        if (cutout.WidthPx > cropped.WidthPx
            || cutout.HeightPx > cropped.HeightPx
            || Math.Abs((double)cutout.WidthPx / cutout.HeightPx
                - (double)cropped.WidthPx / cropped.HeightPx) > 0.01)
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                removal.Provider,
                $"Provider returned {cutout.WidthPx}x{cutout.HeightPx} but the cropped input is "
                + $"{cropped.WidthPx}x{cropped.HeightPx}.");
        }

        var upscaledPng = preserveSize
            ? croppedPng
            : await _upscaler.UpscaleAsync(
                new ImageInput(croppedPng, "image/png", "cropped.png"),
                cancellationToken);
        var upscaled = preserveSize
            ? cropped
            : await InspectAsync(upscaledPng, cancellationToken);

        var alpha = await _refiner.RefineAsync(
            new AlphaRefinement(
                removal.PngBytes,
                upscaled.WidthPx,
                upscaled.HeightPx,
                removal.PreserveSoftEdge),
            cancellationToken);
        var finalPng = await _compositor.ApplyAlphaAsync(upscaledPng, alpha, cancellationToken);

        // The provider's RGB never reaches the output: the compositor writes the
        // refined matte over the upscaled original colours. Decontamination must
        // therefore run here, after the alpha exists, using the remover's hint.
        // Enclosed counters are cleared first, because that pass creates a new
        // anti-aliased ramp which then needs the same decontamination.
        EnclosedBackgroundOutcome? enclosed = null;
        if (removeEnclosedBackground)
        {
            enclosed = await _enclosedCleaner.ClearAsync(
                finalPng,
                removal.BackgroundColor,
                cancellationToken);
            finalPng = enclosed.PngBytes;
        }

        if (removal.BackgroundColor is { } background)
        {
            finalPng = await _decontaminator.DecontaminateAsync(
                finalPng,
                background,
                cancellationToken);
        }

        total.Stop();
        _logger.LogInformation(
            "Background removal pipeline succeeded: provider={Provider} inputBytes={InputBytes} "
            + "outputBytes={OutputBytes} removalMs={RemovalMs} totalMs={TotalMs} "
            + "widthPx={WidthPx} heightPx={HeightPx} preserveSize={PreserveSize} "
            + "enclosedRegions={EnclosedRegions} enclosedPixels={EnclosedPixels} "
            + "enclosedSkipped={EnclosedSkipped}",
            removal.Provider,
            input.Bytes.Length,
            finalPng.Length,
            (long)removal.Elapsed.TotalMilliseconds,
            (long)total.Elapsed.TotalMilliseconds,
            upscaled.WidthPx,
            upscaled.HeightPx,
            preserveSize,
            enclosed?.RegionsCleared,
            enclosed?.PixelsCleared,
            enclosed?.SkippedReason);

        return new BackgroundRemovalPipelineResult(
            finalPng,
            removal.Provider,
            removal.Elapsed,
            total.Elapsed,
            upscaled.WidthPx,
            upscaled.HeightPx,
            enclosed);
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

    private async Task<ImageInspection> InspectAsync(byte[] png, CancellationToken cancellationToken)
    {
        await using var stream = new MemoryStream(png, writable: false);
        return await _inspector.InspectAsync(stream, cancellationToken);
    }
}
