using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

public sealed class BackgroundRemovalAdapterTests
{
    private static readonly ImageInput Input = new(CreatePng(8, 8), "image/png", "art.png");

    [Fact]
    public async Task PoofSendsTheVerifiedContract()
    {
        var handler = new StubHandler((request, _) =>
        {
            var form = Assert.IsType<MultipartFormDataContent>(request.Content);
            var parts = form.ToDictionary(
                part => (part.Headers.ContentDisposition!.Name ?? string.Empty).Trim('"'),
                part => part);

            Assert.Equal("png", parts["format"].ReadAsStringAsync().Result);
            Assert.Equal("rgba", parts["channels"].ReadAsStringAsync().Result);
            Assert.Equal("full", parts["size"].ReadAsStringAsync().Result);
            Assert.Equal(Input.Bytes.Length, parts["file"].Headers.ContentLength);
            Assert.Equal("image/png", parts["file"].Headers.ContentType!.MediaType);
            Assert.Equal("secret", request.Headers.GetValues("x-api-key").Single());
            Assert.Equal("/remove", request.RequestUri!.AbsolutePath);
            return Png();
        });

        var result = await CreatePoof(handler).RemoveAsync(Input, CancellationToken.None);

        Assert.Equal("poof", result.Provider);
        Assert.NotEmpty(result.PngBytes);
    }

    [Fact]
    public async Task PoofRefusesToCallWithoutAnApiKey()
    {
        var handler = new StubHandler((_, _) => throw new InvalidOperationException("no call"));
        var options = Options.Create(new PoofOptions { ApiKey = null });

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => new PoofBackgroundRemover(
                    Client("https://poof.test/", handler),
                    options,
                    NullLogger<PoofBackgroundRemover>.Instance)
                .RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.Unauthorized, error.Reason);
        Assert.Equal(0, handler.Calls);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, BackgroundRemovalFailureReason.Unauthorized, true)]
    [InlineData(HttpStatusCode.PaymentRequired, BackgroundRemovalFailureReason.InsufficientCredits, true)]
    [InlineData(HttpStatusCode.Forbidden, BackgroundRemovalFailureReason.PermissionDenied, true)]
    [InlineData(HttpStatusCode.TooManyRequests, BackgroundRemovalFailureReason.RateLimited, true)]
    [InlineData(HttpStatusCode.BadRequest, BackgroundRemovalFailureReason.InvalidImage, false)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, BackgroundRemovalFailureReason.InvalidImage, false)]
    [InlineData(HttpStatusCode.UnsupportedMediaType, BackgroundRemovalFailureReason.InvalidImage, false)]
    [InlineData(HttpStatusCode.UnprocessableEntity, BackgroundRemovalFailureReason.InvalidImage, false)]
    [InlineData(HttpStatusCode.InternalServerError, BackgroundRemovalFailureReason.ProviderUnavailable, true)]
    [InlineData(HttpStatusCode.BadGateway, BackgroundRemovalFailureReason.ProviderUnavailable, true)]
    [InlineData(HttpStatusCode.ServiceUnavailable, BackgroundRemovalFailureReason.ProviderUnavailable, true)]
    public async Task PoofMapsStatusCodesToApplicationFailures(
        HttpStatusCode status,
        BackgroundRemovalFailureReason expected,
        bool allowsFallback)
    {
        var handler = new StubHandler(
            (_, _) => new HttpResponseMessage(status) { Content = new StringContent("{\"error\":\"x\"}") });

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => CreatePoof(handler).RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(expected, error.Reason);
        Assert.Equal(allowsFallback, error.AllowsFallback);
    }

    [Fact]
    public async Task PoofReportsATimeoutAsAvailabilityFailure()
    {
        var handler = new StubHandler((_, _) => throw new TaskCanceledException("timed out"));

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => CreatePoof(handler).RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.Timeout, error.Reason);
        Assert.True(error.AllowsFallback);
    }

    [Fact]
    public async Task PoofReportsATransportFailureAsUnavailable()
    {
        var handler = new StubHandler(
            (_, _) => throw new HttpRequestException(
                "connection refused",
                new IOException("refused"),
                HttpStatusCode.BadGateway));

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => CreatePoof(handler).RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.ProviderUnavailable, error.Reason);
    }

    [Fact]
    public async Task WithoutBgPostsRawBytesAndReturnsTheMatte()
    {
        var handler = new StubHandler((request, body) =>
        {
            Assert.Equal("/v1/remove-background", request.RequestUri!.AbsolutePath);
            // The default cutout's alpha channel is the matte, so no query is
            // needed; a grayscale matte would need a second decode path.
            Assert.Empty(request.RequestUri.Query);
            Assert.Equal("image/png", request.Content!.Headers.ContentType!.MediaType);
            Assert.Equal(Input.Bytes, body);
            return Png();
        });

        var result = await new WithoutBgBackgroundRemover(
                Client("http://withoutbg.test/", handler),
                NullLogger<WithoutBgBackgroundRemover>.Instance)
            .RemoveAsync(Input, CancellationToken.None);

        Assert.Equal("withoutbg", result.Provider);
        Assert.NotEmpty(result.PngBytes);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task WithoutBgMapsABadRequestToInvalidImage()
    {
        var handler = new StubHandler(
            (_, _) => new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent("{\"detail\":\"unsupported image\"}"),
            });

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => new WithoutBgBackgroundRemover(
                    Client("http://withoutbg.test/", handler),
                    NullLogger<WithoutBgBackgroundRemover>.Instance)
                .RemoveAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
        Assert.False(error.AllowsFallback);
        Assert.Contains("unsupported image", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CropperForwardsCropSettingsAndTheWorkerKey()
    {
        var handler = new StubHandler((request, body) =>
        {
            Assert.Equal("/v1/crop", request.RequestUri!.AbsolutePath);
            Assert.Contains("tolerance=20", request.RequestUri.Query, StringComparison.Ordinal);
            Assert.Contains("paddingPx=4", request.RequestUri.Query, StringComparison.Ordinal);
            Assert.Equal("worker-key", request.Headers.GetValues("X-Worker-Key").Single());
            Assert.Equal(Input.Bytes, body);
            return Png();
        });
        var options = Options.Create(
            new PrepareWorkerOptions { WorkerKey = "worker-key", CropTolerance = 20, CropPaddingPx = 4 });

        var png = await new PrepareWorkerCropper(Client("http://worker.test/", handler), options)
            .CropAsync(Input, CancellationToken.None);

        Assert.NotEmpty(png);
    }

    [Fact]
    public async Task UpscalerForwardsScaleModelAndGpuChoice()
    {
        var handler = new StubHandler((request, _) =>
        {
            Assert.Equal("/v1/upscale", request.RequestUri!.AbsolutePath);
            var query = request.RequestUri.Query;
            Assert.Contains("scale=4", query, StringComparison.Ordinal);
            Assert.Contains("model=realesrgan-x4plus", query, StringComparison.Ordinal);
            Assert.Contains("gpu=true", query, StringComparison.Ordinal);
            return Png();
        });
        var options = Options.Create(
            new PrepareWorkerOptions { WorkerKey = "worker-key", UseGpu = true });

        var png = await new PrepareWorkerUpscaler(Client("http://worker.test/", handler), options)
            .UpscaleAsync(Input, CancellationToken.None);

        Assert.NotEmpty(png);
    }

    [Fact]
    public async Task CropperReportsAWorkerRefusalAsInvalidImage()
    {
        var handler = new StubHandler(
            (_, _) => new HttpResponseMessage(HttpStatusCode.UnprocessableEntity)
            {
                Content = new StringContent("{\"code\":\"full-bleed-no-auto-trim\"}"),
            });

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => new PrepareWorkerCropper(
                    Client("http://worker.test/", handler),
                    Options.Create(new PrepareWorkerOptions()))
                .CropAsync(Input, CancellationToken.None));

        Assert.Equal(BackgroundRemovalFailureReason.InvalidImage, error.Reason);
    }

    private static PoofBackgroundRemover CreatePoof(StubHandler handler)
        => new(
            Client("https://poof.test/", handler),
            Options.Create(new PoofOptions { ApiKey = "secret" }),
            NullLogger<PoofBackgroundRemover>.Instance);

    private static HttpClient Client(string baseUrl, StubHandler handler)
        => new(handler, disposeHandler: false) { BaseAddress = new Uri(baseUrl) };

    private static byte[] CreatePng(int width, int height, byte alpha = 255)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(new SKColor(200, 100, 50, alpha));
        }

        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static HttpResponseMessage Png()
        => new(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(CreatePng(4, 4)),
        };

    private sealed class StubHandler(
        Func<HttpRequestMessage, byte[], HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Calls++;
            var body = request.Content is null
                ? []
                : await request.Content.ReadAsByteArrayAsync(cancellationToken);
            return respond(request, body);
        }
    }
}
