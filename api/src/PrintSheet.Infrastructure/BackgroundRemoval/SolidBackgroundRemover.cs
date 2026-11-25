using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval.Solid;
using PrintSheet.Infrastructure.Imaging;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Deterministic remover for flat artwork on a solid black, white or navy
/// background. It estimates the border colour, flood-fills the border-connected
/// background, builds a soft edge band and removes specks. RGB is never edited:
/// the result is the input colours plus an alpha channel, and the background
/// colour is reported so the shared decontamination stage can remove the halo.
/// </summary>
public sealed class SolidBackgroundRemover(
    IOptions<SolidBackgroundRemovalOptions> options,
    ILogger<SolidBackgroundRemover> logger) : IBackgroundRemover, IBackgroundRemovalApplicability
{
    private readonly SolidBackgroundRemovalOptions _options = options.Value;

    public string Provider => BackgroundRemovalProviders.Solid;

    public Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken)
        => Task.Run(() => Remove(image, cancellationToken), cancellationToken);

    public Task<BackgroundRemovalApplicability> CheckApplicabilityAsync(
        ImageInput image,
        CancellationToken cancellationToken)
        => Task.Run(() => Check(image, cancellationToken), cancellationToken);

    private BackgroundRemovalResult Remove(ImageInput image, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var rgba = SkiaRgbaImage.Decode(image.Bytes, Provider);
        var analysis = Analyze(rgba, cancellationToken);

        if (!analysis.IsApplicable)
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                Provider,
                "Solid background removal is not applicable: "
                + string.Join(" ", analysis.Reasons));
        }

        var background = analysis.Background;
        var distances = SolidAnalyzer.Distances(rgba, background, cancellationToken);
        var reference = Math.Max(
            _options.EdgeReferenceFloor,
            SolidAnalyzer.Percentile(
                distances,
                analysis.BackgroundMask,
                _options.EdgeReferencePercentile));
        var band = SolidAnalyzer.EdgeBand(
            analysis.BackgroundMask,
            rgba.Width,
            rgba.Height,
            _options.EdgeBandPixels,
            _options.MaxEdgeBandPixels,
            reference,
            index => distances[index],
            cancellationToken);

        var alpha = new byte[rgba.Width * rgba.Height];
        for (var index = 0; index < alpha.Length; index++)
        {
            if (analysis.BackgroundMask[index])
            {
                alpha[index] = 0;
            }
            else if (band[index])
            {
                alpha[index] = SolidAnalyzer.EdgeAlpha(
                    distances[index],
                    _options.EdgeLow,
                    reference);
            }
            else
            {
                alpha[index] = 255;
            }
        }

        if (_options.RemoveSpecks)
        {
            SpeckFilter.Remove(
                alpha,
                rgba.Width,
                rgba.Height,
                _options.MinSpeckArea,
                cancellationToken);
        }

        // Write alpha into a copy; RGB stays byte-identical to the input.
        var output = new byte[rgba.Pixels.Length];
        Array.Copy(rgba.Pixels, output, output.Length);
        for (var index = 0; index < alpha.Length; index++)
        {
            output[(index * 4) + 3] = alpha[index];
        }

        var png = SkiaRgbaImage.Encode(new RgbaImage(output, rgba.Width, rgba.Height));
        stopwatch.Stop();
        logger.LogInformation(
            "Solid background removal: widthPx={WidthPx} heightPx={HeightPx} "
            + "background=#{R:X2}{G:X2}{B:X2} borderUniformity={Uniformity:F3} "
            + "backgroundFraction={BackgroundFraction:F3} elapsedMs={ElapsedMs}",
            rgba.Width,
            rgba.Height,
            background.R,
            background.G,
            background.B,
            analysis.BorderUniformity,
            analysis.BackgroundFraction,
            (long)stopwatch.Elapsed.TotalMilliseconds);

        return new BackgroundRemovalResult(
            png,
            Provider,
            stopwatch.Elapsed,
            background,
            PreserveSoftEdge: true);
    }

    private BackgroundRemovalApplicability Check(ImageInput image, CancellationToken cancellationToken)
    {
        var rgba = SkiaRgbaImage.Decode(image.Bytes, Provider);
        var analysis = Analyze(rgba, cancellationToken);
        return new BackgroundRemovalApplicability(
            analysis.IsApplicable,
            analysis.Reasons,
            analysis.Background,
            analysis.BorderUniformity,
            analysis.BorderForegroundRatio,
            analysis.BackgroundFraction);
    }

    private SolidAnalysis Analyze(RgbaImage rgba, CancellationToken cancellationToken)
    {
        var border = SolidAnalyzer.SampleBorder(rgba, _options, cancellationToken);
        var reasons = new List<string>();

        if (border.Uniformity < _options.MinBorderUniformity)
        {
            reasons.Add(
                $"Border uniformity {border.Uniformity:P1} is below "
                + $"{_options.MinBorderUniformity:P1}.");
        }

        if (border.ForegroundRatio > _options.MaxBorderForegroundRatio)
        {
            reasons.Add(
                $"Artwork touches the border ({border.ForegroundRatio:P1} of border pixels); "
                + $"the limit is {_options.MaxBorderForegroundRatio:P1}.");
        }

        if (reasons.Count > 0)
        {
            return new SolidAnalysis(
                border.Background,
                [],
                border.Uniformity,
                border.ForegroundRatio,
                0,
                reasons);
        }

        var mask = SolidAnalyzer.FloodFill(
            rgba,
            border.Background,
            _options.BackgroundTolerance,
            cancellationToken);
        var backgroundFraction = (double)mask.Count(value => value) / mask.Length;
        if (backgroundFraction < _options.MinBackgroundFraction)
        {
            reasons.Add(
                $"Background is only {backgroundFraction:P1} of the image; "
                + $"the minimum is {_options.MinBackgroundFraction:P1}.");
        }

        if (backgroundFraction > _options.MaxBackgroundFraction)
        {
            reasons.Add(
                $"Background is {backgroundFraction:P1} of the image; "
                + $"the maximum is {_options.MaxBackgroundFraction:P1}.");
        }

        return new SolidAnalysis(
            border.Background,
            mask,
            border.Uniformity,
            border.ForegroundRatio,
            backgroundFraction,
            reasons);
    }

    private sealed record SolidAnalysis(
        RgbColor Background,
        bool[] BackgroundMask,
        double BorderUniformity,
        double BorderForegroundRatio,
        double BackgroundFraction,
        IReadOnlyList<string> Reasons)
    {
        public bool IsApplicable => Reasons.Count == 0;
    }
}
