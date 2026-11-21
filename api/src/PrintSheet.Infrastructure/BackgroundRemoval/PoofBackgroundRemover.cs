using System.Diagnostics;
using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Poof cloud cutout. RGBA PNG at full resolution; Poof's crop/resize options stay
/// unset because this pipeline crops itself and must keep the original resolution.
/// </summary>
public sealed class PoofBackgroundRemover(
    HttpClient client,
    IOptions<PoofOptions> options,
    ILogger<PoofBackgroundRemover> logger) : IBackgroundRemover
{
    public string Provider => BackgroundRemovalProviders.Poof;

    public async Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken)
    {
        var apiKey = options.Value.ApiKey;
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.Unauthorized,
                Provider,
                "BackgroundRemoval:Poof:ApiKey is not configured.");
        }

        var stopwatch = Stopwatch.StartNew();
        using var request = new HttpRequestMessage(HttpMethod.Post, "remove");
        request.Headers.Add("x-api-key", apiKey);
        request.Content = BuildForm(image);

        try
        {
            using var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw await BackgroundRemovalHttp.FromResponseAsync(
                    Provider,
                    response,
                    cancellationToken);
            }

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
            stopwatch.Stop();
            logger.LogDebug(
                "Poof cutout: processingMs={ProcessingMs} width={Width} height={Height} bytes={Bytes}",
                response.Headers.TryGetValues("X-Processing-Time-Ms", out var processing)
                    ? processing.FirstOrDefault()
                    : null,
                response.Headers.TryGetValues("X-Image-Width", out var width)
                    ? width.FirstOrDefault()
                    : null,
                response.Headers.TryGetValues("X-Image-Height", out var height)
                    ? height.FirstOrDefault()
                    : null,
                bytes.Length);
            return new BackgroundRemovalResult(bytes, Provider, stopwatch.Elapsed);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw BackgroundRemovalHttp.Timeout(Provider, new TimeoutException());
        }
        catch (HttpRequestException exception)
        {
            throw BackgroundRemovalHttp.Unavailable(Provider, exception);
        }
    }

    private static MultipartFormDataContent BuildForm(ImageInput image)
    {
        var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(image.Bytes);
        file.Headers.ContentType = MediaTypeHeaderValue.Parse(image.ContentType);
        // Poof detects the media type from the bytes, never the file name.
        form.Add(file, "file", "image");
        form.Add(new StringContent("png"), "format");
        form.Add(new StringContent("rgba"), "channels");
        form.Add(new StringContent("full"), "size");
        return form;
    }
}
