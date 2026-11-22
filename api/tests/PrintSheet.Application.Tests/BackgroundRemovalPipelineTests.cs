using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Application.Tests;

public sealed class BackgroundRemovalPipelineTests
{
    private static readonly byte[] CroppedPng = [10, 11, 12];
    private static readonly byte[] CutoutPng = [20, 21, 22];
    private static readonly byte[] UpscaledPng = [30, 31, 32];
    private static readonly byte[] AlphaPixels = [40, 41, 42];
    private static readonly byte[] FinalPng = [50, 51, 52];

    [Fact]
    public async Task CropsThenRemovesThenUpscalesThenRefinesThenRecombines()
    {
        var calls = new List<string>();
        var pipeline = Create(calls);

        var result = await pipeline.RunAsync(Input(), CancellationToken.None);

        Assert.Equal(
            ["crop", "remove", "upscale", "refine", "composite"],
            calls);
        Assert.Equal(FinalPng, result.PngBytes);
        Assert.Equal("fake", result.Provider);
        Assert.Equal(400, result.WidthPx);
        Assert.Equal(200, result.HeightPx);
    }

    [Fact]
    public async Task SendsTheCroppedPixelsToTheRemoverAndTheUpscaler()
    {
        var harness = Harness.Create();

        await Create(harness).RunAsync(Input(), CancellationToken.None);

        Assert.Equal(CroppedPng, harness.Remover.LastImage!.Bytes);
        Assert.Equal("image/png", harness.Remover.LastImage.ContentType);
        // Upscale uses the cropped *original* colours, not the provider cutout.
        Assert.Equal(CroppedPng, harness.Upscaler.LastImage!.Bytes);
    }

    [Fact]
    public async Task RefinesTheProviderMatteToTheUpscaledColourSize()
    {
        var harness = Harness.Create();

        await Create(harness).RunAsync(Input(), CancellationToken.None);

        var refinement = harness.Refiner.LastRequest!;
        Assert.Equal(CutoutPng, refinement.CutoutRgbaPng);
        Assert.Equal(400, refinement.TargetWidthPx);
        Assert.Equal(200, refinement.TargetHeightPx);
        Assert.Equal(UpscaledPng, harness.Compositor.LastRgbPng);
        Assert.Equal(AlphaPixels, harness.Compositor.LastAlpha!.Pixels);
    }

    [Fact]
    public async Task RejectsAProviderResultWithTheWrongAspectRatio()
    {
        // 99x50 against a 100x50 crop: smaller, but 2% off the crop's aspect, so
        // it would smear the subject when the refiner scales it.
        var harness = Harness.Create(cutoutWidth: 99);

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => Create(harness).RunAsync(Input(), CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.Equal("fake", error.Provider);
        Assert.False(harness.Upscaler.Called);
    }

    [Fact]
    public async Task RejectsAProviderResultLargerThanTheCrop()
    {
        var harness = Harness.Create(cutoutWidth: 200, cutoutHeight: 100);

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => Create(harness).RunAsync(Input(), CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.False(harness.Upscaler.Called);
    }

    [Fact]
    public async Task AcceptsAProviderMatteSmallerThanTheCrop()
    {
        // The providers matte at their own internal resolution, so a half-size
        // result is normal; the refiner scales it to the print size.
        var harness = Harness.Create(cutoutWidth: 50, cutoutHeight: 25);

        var result = await Create(harness).RunAsync(Input(), CancellationToken.None);

        Assert.Equal(FinalPng, result.PngBytes);
        Assert.NotNull(harness.Refiner.LastRequest);
        Assert.Equal(400, harness.Refiner.LastRequest!.TargetWidthPx);
    }

    [Fact]
    public async Task RejectsAnEmptyImageBeforeAnyAdapterRuns()
    {
        var harness = Harness.Create();

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => Create(harness).RunAsync(
                new ImageInput([], "image/png", "art.png"),
                CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.False(harness.Cropper.Called);
    }

    [Fact]
    public async Task RejectsACroppedImageOverTheProviderLimitAfterCropping()
    {
        // The limit is the provider's upload cap, so it is checked on the bytes that
        // are actually uploaded. Cropping still has to happen first.
        var harness = Harness.Create(maxBytes: 2);

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => Create(harness).RunAsync(Input(), CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.True(harness.Cropper.Called);
        Assert.False(harness.Remover.Called);
    }

    [Fact]
    public async Task AcceptsAnOriginalOverTheLimitWhenCroppingFitsUnderIt()
    {
        // A 30 MB upload that crops down to 3 bytes is a normal case, not an error.
        var harness = Harness.Create(maxBytes: 4);

        var result = await Create(harness).RunAsync(
            new ImageInput(new byte[30], "image/png", "huge.png"),
            CancellationToken.None);

        Assert.Equal(FinalPng, result.PngBytes);
        Assert.True(harness.Remover.Called);
    }

    [Fact]
    public async Task AcceptsABigCropOverTheByteLimitWhenTheProviderInputIsDownscaled()
    {
        // The upload cap applies to what the provider receives. A crop above the
        // pixel budget is downscaled by the provider decorator first, so its PNG
        // size here is not the request size and must not reject the job.
        var harness = Harness.Create(maxBytes: 2, providerMaxInputPixels: 1_000);

        var result = await Create(harness).RunAsync(Input(), CancellationToken.None);

        Assert.Equal(FinalPng, result.PngBytes);
        Assert.True(harness.Remover.Called);
    }

    [Fact]
    public async Task RejectsAContentTypeOutsideTheAllowList()
    {
        var harness = Harness.Create();

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => Create(harness).RunAsync(
                new ImageInput([1, 2, 3], "image/gif", "art.gif"),
                CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.False(harness.Cropper.Called);
    }

    private static ImageInput Input() => new([1, 2, 3], "image/png", "art.png");

    private static BackgroundRemovalPipeline Create(List<string> calls)
        => Create(Harness.Create(calls: calls));

    private static BackgroundRemovalPipeline Create(Harness harness)
        => new(
            harness.Remover,
            harness.Cropper,
            harness.Upscaler,
            harness.Refiner,
            harness.Compositor,
            harness.Inspector,
            Options.Create(
                new BackgroundRemovalOptions
                {
                    MaxInputBytes = harness.MaxBytes,
                    ProviderMaxInputPixels = harness.ProviderMaxInputPixels,
                    AlphaFeatherPx = 0,
                }),
            NullLogger<BackgroundRemovalPipeline>.Instance);

    /// <summary>Every fake the pipeline touches, wired to one call log.</summary>
    private sealed class Harness
    {
        public List<string> Calls { get; private init; } = [];

        public int MaxBytes { get; private init; } = 20 * 1024 * 1024;

        public int ProviderMaxInputPixels { get; private init; } = 1_000_000;

        public FakeCropper Cropper { get; private init; } = null!;

        public FakeRemover Remover { get; private init; } = null!;

        public FakeUpscaler Upscaler { get; private init; } = null!;

        public FakeRefiner Refiner { get; private init; } = null!;

        public FakeCompositor Compositor { get; private init; } = null!;

        public FakeInspector Inspector { get; private init; } = null!;

        public static Harness Create(
            int cutoutWidth = 100,
            int cutoutHeight = 50,
            int maxBytes = 20 * 1024 * 1024,
            int providerMaxInputPixels = 1_000_000,
            List<string>? calls = null)
        {
            var log = calls ?? [];
            return new Harness
            {
                Calls = log,
                MaxBytes = maxBytes,
                ProviderMaxInputPixels = providerMaxInputPixels,
                Cropper = new FakeCropper(log),
                Remover = new FakeRemover(log),
                Upscaler = new FakeUpscaler(log),
                Refiner = new FakeRefiner(log),
                Compositor = new FakeCompositor(log),
                // Inspection order: cropped frame, provider cutout, upscaled frame.
                Inspector = new FakeInspector(
                    [
                        new ImageInspection(100, 50, false, "png", "image/png", ".png"),
                        new ImageInspection(cutoutWidth, cutoutHeight, true, "png", "image/png", ".png"),
                        new ImageInspection(400, 200, false, "png", "image/png", ".png"),
                    ]),
            };
        }
    }

    private sealed class FakeCropper(List<string> calls) : IImageCropper
    {
        public bool Called { get; private set; }

        public Task<byte[]> CropAsync(ImageInput image, CancellationToken cancellationToken)
        {
            Called = true;
            calls.Add("crop");
            return Task.FromResult(CroppedPng);
        }
    }

    private sealed class FakeRemover(List<string> calls) : IBackgroundRemovalService
    {
        public ImageInput? LastImage { get; private set; }

        public bool Called => LastImage is not null;

        public string Provider => "fake";

        public IReadOnlyList<IBackgroundRemover> Providers => [];

        public string? LastPreferredProvider { get; private set; }

        public Task<BackgroundRemovalResult> RemoveAsync(
            ImageInput image,
            CancellationToken cancellationToken,
            string? preferredProvider = null)
        {
            LastImage = image;
            LastPreferredProvider = preferredProvider;
            calls.Add("remove");
            return Task.FromResult(
                new BackgroundRemovalResult(CutoutPng, "fake", TimeSpan.FromMilliseconds(5)));
        }
    }

    private sealed class FakeUpscaler(List<string> calls) : IImageUpscaler
    {
        public bool Called { get; private set; }

        public ImageInput? LastImage { get; private set; }

        public Task<byte[]> UpscaleAsync(ImageInput image, CancellationToken cancellationToken)
        {
            Called = true;
            LastImage = image;
            calls.Add("upscale");
            return Task.FromResult(UpscaledPng);
        }
    }

    private sealed class FakeRefiner(List<string> calls) : IAlphaRefiner
    {
        public AlphaRefinement? LastRequest { get; private set; }

        public Task<AlphaMask> RefineAsync(
            AlphaRefinement refinement,
            CancellationToken cancellationToken)
        {
            LastRequest = refinement;
            calls.Add("refine");
            return Task.FromResult(
                new AlphaMask(AlphaPixels, refinement.TargetWidthPx, refinement.TargetHeightPx));
        }
    }

    private sealed class FakeCompositor(List<string> calls) : IAlphaCompositor
    {
        public byte[]? LastRgbPng { get; private set; }

        public AlphaMask? LastAlpha { get; private set; }

        public Task<byte[]> ApplyAlphaAsync(
            byte[] rgbPng,
            AlphaMask alpha,
            CancellationToken cancellationToken)
        {
            LastRgbPng = rgbPng;
            LastAlpha = alpha;
            calls.Add("composite");
            return Task.FromResult(FinalPng);
        }
    }

    private sealed class FakeInspector(IReadOnlyList<ImageInspection> results) : IImageInspector
    {
        private int _next;

        public Task<ImageInspection> InspectAsync(Stream stream, CancellationToken cancellationToken)
            => Task.FromResult(results[_next++]);
    }
}
