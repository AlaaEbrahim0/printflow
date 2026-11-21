using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using PrintSheet.Infrastructure.Imaging;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// The whole pipeline against live services: a worker with Real-ESRGAN installed
/// and a withoutBG container. Skipped unless both URLs are exported, so the
/// default run stays offline and no billed provider is ever called:
///
/// <code>
/// docker compose up -d withoutbg
/// PRINTSHEET_TEST_WORKER_URL=http://localhost:8000/ \
/// PRINTSHEET_TEST_WITHOUTBG_URL=http://localhost:8002/ \
///   dotnet test --filter Category=Live
/// </code>
/// </summary>
[Trait("Category", "Live")]
public sealed class BackgroundRemovalPipelineLiveTests
{
    public const string WorkerVariable = "PRINTSHEET_TEST_WORKER_URL";

    [LiveFact]
    public async Task ProducesAFullResolutionCutoutFromACroppedProviderMatte()
    {
        var worker = new Uri(Environment.GetEnvironmentVariable(WorkerVariable)!);
        var withoutBg = new Uri(Environment.GetEnvironmentVariable(WithoutBgContainerTests.UrlVariable)!);
        var workerOptions = Options.Create(
            new PrepareWorkerOptions
            {
                BaseUrl = worker.ToString(),
                WorkerKey = Environment.GetEnvironmentVariable("PRINTSHEET_TEST_WORKER_KEY") ?? "dev-worker-key",
                UpscaleScale = 2,
                UseGpu = true,
            });
        var pipelineCropper = new PrepareWorkerCropper(
            new HttpClient { BaseAddress = worker, Timeout = TimeSpan.FromMinutes(5) },
            workerOptions);
        var pipeline = new BackgroundRemovalPipeline(
            new BackgroundRemovalProviderSelector(
                [
                    new WithoutBgBackgroundRemover(
                        new HttpClient { BaseAddress = withoutBg, Timeout = TimeSpan.FromMinutes(5) },
                        NullLogger<WithoutBgBackgroundRemover>.Instance),
                ],
                Options.Create(new BackgroundRemovalOptions { DefaultProvider = "withoutbg" }),
                NullLogger<BackgroundRemovalProviderSelector>.Instance),
            pipelineCropper,
            new PrepareWorkerUpscaler(
                new HttpClient { BaseAddress = worker, Timeout = TimeSpan.FromMinutes(5) },
                workerOptions),
            new SkiaAlphaRefiner(Options.Create(new BackgroundRemovalOptions { AlphaFeatherPx = 0.5 })),
            new SkiaAlphaCompositor(),
            new SkiaImageInspector(),
            Options.Create(new BackgroundRemovalOptions { DefaultProvider = "withoutbg" }),
            NullLogger<BackgroundRemovalPipeline>.Instance);

        var artwork = CreateArtwork(300, 200);
        // The crop trims the white margin and adds the configured padding, so the
        // exact size comes from the cropper rather than from a guess here.
        var croppedPng = await pipelineCropper.CropAsync(
            new ImageInput(artwork, "image/png", "art.png"),
            CancellationToken.None);
        using var cropped = SKBitmap.Decode(croppedPng);
        Assert.NotNull(cropped);
        Assert.True(
            cropped.Width < 300 && cropped.Height < 200,
            $"The crop should trim the margin, got {cropped.Width}x{cropped.Height}.");

        var result = await pipeline.RunAsync(
            new ImageInput(artwork, "image/png", "art.png"),
            CancellationToken.None);

        Assert.Equal("withoutbg", result.Provider);
        // Upscaled 2x from the cropped frame, not from the original upload.
        Assert.Equal(cropped.Width * 2, result.WidthPx);
        Assert.Equal(cropped.Height * 2, result.HeightPx);

        using var cutout = SKBitmap.Decode(result.PngBytes);
        Assert.NotNull(cutout);
        Assert.Equal(cropped.Width * 2, cutout.Width);
        Assert.Equal(cropped.Height * 2, cutout.Height);
        var alpha = ReadAlpha(cutout);
        // The subject survives and the paper around it is gone.
        Assert.True(alpha.Max() > 200, "The subject should stay opaque.");
        Assert.True(alpha.Min() < 40, "The paper should become transparent.");
    }

    private static byte[] ReadAlpha(SKBitmap bitmap)
    {
        using var rgba = bitmap.ColorType == SKColorType.Rgba8888
            ? null
            : bitmap.Copy(SKColorType.Rgba8888)
                ?? throw new InvalidOperationException("The cutout could not be read as RGBA.");
        var source = rgba ?? bitmap;
        var pixels = new byte[source.Width * source.Height * 4];
        System.Runtime.InteropServices.Marshal.Copy(source.GetPixels(), pixels, 0, pixels.Length);
        return [.. Enumerable.Range(0, source.Width * source.Height).Select(i => pixels[(i * 4) + 3])];
    }

    private static byte[] CreateArtwork(int width, int height)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(SKColors.White);
            using var paint = new SKPaint { Color = SKColors.Crimson, IsAntialias = false };
            canvas.DrawRect(SKRect.Create(50, 40, 200, 120), paint);
        }

        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}

/// <summary>A fact that only runs when both live service URLs are exported.</summary>
public sealed class LiveFactAttribute : FactAttribute
{
    public LiveFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(
                Environment.GetEnvironmentVariable(BackgroundRemovalPipelineLiveTests.WorkerVariable))
            || string.IsNullOrWhiteSpace(
                Environment.GetEnvironmentVariable(WithoutBgContainerTests.UrlVariable)))
        {
            Skip = "Set PRINTSHEET_TEST_WORKER_URL and PRINTSHEET_TEST_WITHOUTBG_URL to run live tests.";
        }
    }
}
