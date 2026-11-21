using Microsoft.Extensions.Logging.Abstractions;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using PrintSheet.Infrastructure.BackgroundRemoval;
using SkiaSharp;

namespace PrintSheet.Infrastructure.Tests;

/// <summary>
/// Real-container checks. Skipped unless the operator exports the URL of a
/// running withoutBG service, so the default test run stays offline and never
/// touches a billed provider:
///
/// <code>
/// docker compose up -d withoutbg
/// PRINTSHEET_TEST_WITHOUTBG_URL=http://localhost:8002/ \
///   dotnet test --filter Category=Docker
/// </code>
/// </summary>
[Trait("Category", "Docker")]
public sealed class WithoutBgContainerTests
{
    public const string UrlVariable = "PRINTSHEET_TEST_WITHOUTBG_URL";

    [DockerFact]
    public async Task RemovesTheBackgroundOfARealImage()
    {
        using var client = CreateClient();
        var remover = new WithoutBgBackgroundRemover(
            client,
            NullLogger<WithoutBgBackgroundRemover>.Instance);

        var result = await remover.RemoveAsync(
            new ImageInput(CreateArtwork(320, 240), "image/png", "art.png"),
            CancellationToken.None);

        Assert.Equal("withoutbg", result.Provider);
        using var matte = SKBitmap.Decode(result.PngBytes);
        Assert.NotNull(matte);
        Assert.Equal(320, matte.Width);
        Assert.Equal(240, matte.Height);
        var alpha = ReadAlpha(matte);
        Assert.Contains(alpha, value => value == 0);
        Assert.Contains(alpha, value => value == 255);
    }

    [DockerFact]
    public async Task ReportsAnUnreadableBodyAsAnInputFault()
    {
        using var client = CreateClient();
        var remover = new WithoutBgBackgroundRemover(
            client,
            NullLogger<WithoutBgBackgroundRemover>.Instance);

        var error = await Assert.ThrowsAsync<BackgroundRemovalException>(
            () => remover.RemoveAsync(
                new ImageInput([1, 2, 3], "image/png", "junk.png"),
                CancellationToken.None));

        Assert.False(error.AllowsFallback);
        Assert.True(
            error.Reason is BackgroundRemovalFailureReason.InvalidImage
                or BackgroundRemovalFailureReason.Unexpected,
            $"Unexpected reason {error.Reason}.");
    }

    private static HttpClient CreateClient()
        => new()
        {
            BaseAddress = new Uri(Environment.GetEnvironmentVariable(UrlVariable)!),
            Timeout = TimeSpan.FromMinutes(2),
        };

    private static byte[] ReadAlpha(SKBitmap bitmap)
    {
        using var rgba = bitmap.ColorType == SKColorType.Rgba8888
            ? null
            : bitmap.Copy(SKColorType.Rgba8888)
                ?? throw new InvalidOperationException("The matte could not be read as RGBA.");
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
            using var paint = new SKPaint { Color = SKColors.Crimson, IsAntialias = true };
            canvas.DrawCircle(width / 2f, height / 2f, Math.Min(width, height) / 3f, paint);
        }

        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }
}

/// <summary>A fact that only runs when <c>PRINTSHEET_TEST_WITHOUTBG_URL</c> is set.</summary>
public sealed class DockerFactAttribute : FactAttribute
{
    public DockerFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(
                Environment.GetEnvironmentVariable(WithoutBgContainerTests.UrlVariable)))
        {
            Skip = "Set PRINTSHEET_TEST_WITHOUTBG_URL to run Docker integration tests.";
        }
    }
}
