using System.Diagnostics;
using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using Polly;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>
/// Self-hosted withoutBG cutout. Raw image body in, RGBA PNG out; the API key
/// concept does not exist on the self-hosted service.
///
/// The default cutout is requested rather than <c>?output=matte</c> on purpose:
/// its alpha channel *is* the matte, and returning RGBA keeps this adapter and
/// Poof on one shape, so the refiner has a single path for both providers.
/// </summary>
public sealed class WithoutBgBackgroundRemover(
    HttpClient client,
    ILogger<WithoutBgBackgroundRemover> logger) : IBackgroundRemover
{
    public string Provider => BackgroundRemovalProviders.WithoutBg;

    public async Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        using var request = new HttpRequestMessage(HttpMethod.Post, "v1/remove-background");
        request.Content = new ByteArrayContent(image.Bytes);
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(image.ContentType);

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
                "withoutBG cutout: latencyMs={LatencyMs} route={Route} bytes={Bytes}",
                response.Headers.TryGetValues("X-Latency-Ms", out var latency)
                    ? latency.FirstOrDefault()
                    : null,
                response.Headers.TryGetValues("X-Route-Pipeline", out var route)
                    ? route.FirstOrDefault()
                    : null,
                bytes.Length);
            return new BackgroundRemovalResult(bytes, Provider, stopwatch.Elapsed);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw BackgroundRemovalHttp.Timeout(Provider, new TimeoutException());
        }
        catch (ExecutionRejectedException exception)
        {
            throw BackgroundRemovalHttp.Rejected(Provider, exception);
        }
        catch (HttpRequestException exception)
        {
            throw BackgroundRemovalHttp.Unavailable(Provider, exception);
        }
    }
}
