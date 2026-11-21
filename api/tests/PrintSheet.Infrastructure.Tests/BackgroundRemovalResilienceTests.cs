using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging.Abstractions;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// The adapters must speak the application's failure vocabulary even when the
/// failure comes from the resilience pipeline rather than from HTTP. The standard
/// handler rejects a timed-out attempt with <c>Polly.Timeout.TimeoutRejectedException</c>
/// and a broken circuit with <c>Polly.CircuitBreaker.BrokenCircuitException</c>;
/// neither is an <see cref="HttpRequestException"/>, so a bare catch would let
/// Polly types escape the port and silently disable provider fallback.
/// </summary>
public sealed class BackgroundRemovalResilienceTests
{
    private static readonly ImageInput Input = new(CreatePng(), "image/png", "art.png");

    [Fact]
    public async Task AnAttemptTimeoutBecomesAFallbackEligibleTimeout()
    {
        using var client = ResilientClient(new SlowHandler());

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => new WithoutBgBackgroundRemover(
                    client,
                    NullLogger<WithoutBgBackgroundRemover>.Instance)
                .RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.Timeout, error.Reason);
        Assert.True(error.AllowsFallback);
    }

    [Fact]
    public async Task AnOpenCircuitBecomesAFallbackEligibleAvailabilityFailure()
    {
        // One failed call is enough to open the breaker; the next call must be
        // rejected before it reaches the handler at all.
        var handler = new CountingHandler();
        using var client = ResilientClient(
            handler,
            configure: options =>
            {
                options.CircuitBreaker.FailureRatio = 0;
                options.CircuitBreaker.MinimumThroughput = 2;
                options.CircuitBreaker.BreakDuration = TimeSpan.FromMinutes(1);
            });
        var remover = new WithoutBgBackgroundRemover(
            client,
            NullLogger<WithoutBgBackgroundRemover>.Instance);

        // Two attempts are the minimum throughput the breaker accepts.
        await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => remover.RemoveAsync(Input, CancellationToken.None));
        await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => remover.RemoveAsync(Input, CancellationToken.None));
        var callsBeforeOpen = handler.Calls;

        var rejected = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => remover.RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.ProviderUnavailable, rejected.Reason);
        Assert.True(rejected.AllowsFallback);
        Assert.Equal(callsBeforeOpen, handler.Calls);
    }

    [Fact]
    public async Task CallerCancellationStaysACancellation()
    {
        using var client = ResilientClient(new SlowHandler());
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new WithoutBgBackgroundRemover(
                    client,
                    NullLogger<WithoutBgBackgroundRemover>.Instance)
                .RemoveAsync(Input, cancellation.Token));
    }

    private static HttpClient ResilientClient(
        HttpMessageHandler handler,
        Action<HttpStandardResilienceOptions>? configure = null)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services
            .AddHttpClient("resilient")
            .ConfigurePrimaryHttpMessageHandler(() => handler)
            .AddStandardResilienceHandler(options =>
            {
                options.AttemptTimeout.Timeout = TimeSpan.FromMilliseconds(200);
                options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(5);
                options.Retry.DisableForUnsafeHttpMethods();
                options.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
                configure?.Invoke(options);
            });

        var provider = services.BuildServiceProvider();
        var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("resilient");
        client.BaseAddress = new Uri("http://withoutbg.test/");
        return client;
    }

    private static byte[] CreatePng()
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(4, 4, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(new SKColor(200, 100, 50));
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private sealed class CountingHandler : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Calls++;
            await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }

    private sealed class SlowHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }
}
