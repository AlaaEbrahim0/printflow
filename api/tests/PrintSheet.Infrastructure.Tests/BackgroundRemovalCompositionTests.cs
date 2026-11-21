using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// Composition tests: every adapter and option set must be constructible from
/// configuration alone. These caught a real startup failure where the resilience
/// handler rejected a zero retry count before the API could serve a request.
/// </summary>
public sealed class BackgroundRemovalCompositionTests
{
    [Fact]
    public void ResolvesTheWholePipelineFromConfiguration()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "withoutbg",
                ["BackgroundRemoval:FallbackProvider"] = "poof",
                ["BackgroundRemoval:Poof:ApiKey"] = "secret",
                ["BackgroundRemoval:PrepareWorker:BaseUrl"] = "http://worker:8000",
            });

        Assert.IsType<BackgroundRemovalPipeline>(
            provider.GetRequiredService<IBackgroundRemovalPipeline>());
        Assert.IsType<BackgroundRemovalProviderSelector>(
            provider.GetRequiredService<IBackgroundRemovalService>());
        Assert.IsType<PrepareWorkerCropper>(provider.GetRequiredService<IImageCropper>());
        Assert.IsType<PrepareWorkerUpscaler>(provider.GetRequiredService<IImageUpscaler>());
        Assert.IsType<SkiaAlphaRefiner>(provider.GetRequiredService<IAlphaRefiner>());
        Assert.IsType<SkiaAlphaCompositor>(provider.GetRequiredService<IAlphaCompositor>());
    }

    [Fact]
    public async Task ThePrepareWorkerPortsAreWiredToAClientWithABaseAddress()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "withoutbg",
                ["BackgroundRemoval:PrepareWorker:BaseUrl"] = "http://worker:8000",
            });

        // Regression: these ports were registered with a bare AddTransient, so the
        // injected HttpClient had no BaseAddress and every crop/upscale call threw
        // "An invalid request URI was provided" — but only once a real job ran, so
        // composition tests passed while the feature was dead. Calling the port is
        // the only assertion that actually catches it.
        var cropper = provider.GetRequiredService<IImageCropper>();
        var upscaler = provider.GetRequiredService<IImageUpscaler>();

        var cropError = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => cropper.CropAsync(
                new ImageInput([1, 2, 3], "image/png", "a.png"),
                CancellationToken.None));
        var upscaleError = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => upscaler.UpscaleAsync(
                new ImageInput([1, 2, 3], "image/png", "a.png"),
                CancellationToken.None));

        // No worker is listening, so the call must fail as a *connection* fault
        // against http://worker:8000 — not as a malformed request URI.
        Assert.Equal(BackgroundRemovalFailureReason.ProviderUnavailable, cropError.Reason);
        Assert.Equal(BackgroundRemovalFailureReason.ProviderUnavailable, upscaleError.Reason);
        Assert.DoesNotContain("request URI", cropError.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("request URI", upscaleError.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CreatesEveryProviderClientWithoutAKey()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "withoutbg",
            });

        // Constructing the Poof client must not require a key; only calling it does.
        Assert.NotNull(provider.GetRequiredService<PoofBackgroundRemover>());
        Assert.NotNull(provider.GetRequiredService<WithoutBgBackgroundRemover>());
        Assert.NotNull(provider.GetRequiredService<IHttpClientFactory>().CreateClient("withoutbg-health"));
    }

    [Fact]
    public void FailsFastOnAnInvalidProviderName()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "not-a-provider",
            });

        var error = Assert.Throws<InvalidOperationException>(
            () => provider.GetRequiredService<IBackgroundRemovalService>());
        Assert.Contains("not-a-provider", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void FailsFastOnAMalformedBaseUrl()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "withoutbg",
                ["BackgroundRemoval:WithoutBg:BaseUrl"] = "not a url",
            });

        var error = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IOptions<WithoutBgOptions>>().Value);
        Assert.Contains("BaseUrl", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WorkerKeyFallsBackToTheSharedWorkerSetting()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "withoutbg",
                ["Worker:Key"] = "shared-key",
            });

        var options = provider.GetRequiredService<IOptions<PrepareWorkerOptions>>().Value;

        Assert.Equal("shared-key", options.WorkerKey);
    }

    [Fact]
    public void AnExplicitPrepareWorkerKeyWinsOverTheSharedSetting()
    {
        using var provider = Build(
            new Dictionary<string, string?>
            {
                ["BackgroundRemoval:DefaultProvider"] = "withoutbg",
                ["BackgroundRemoval:PrepareWorker:WorkerKey"] = "dedicated",
                ["Worker:Key"] = "shared-key",
            });

        var options = provider.GetRequiredService<IOptions<PrepareWorkerOptions>>().Value;

        Assert.Equal("dedicated", options.WorkerKey);
    }

    private static ServiceProvider Build(Dictionary<string, string?> values)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        // The real composition root registers this before AddBackgroundRemoval;
        // the pipeline only needs the port, so a stub keeps the test offline.
        services.AddSingleton<IImageInspector, StubInspector>();
        services.AddBackgroundRemoval(configuration);
        return services.BuildServiceProvider();
    }

    private sealed class StubInspector : IImageInspector
    {
        public Task<ImageInspection> InspectAsync(Stream stream, CancellationToken cancellationToken)
            => Task.FromResult(new ImageInspection(1, 1, false, "png", "image/png", ".png"));
    }
}
