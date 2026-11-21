using System.Net.Http.Headers;
using Microsoft.Extensions.Options;
using Polly;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>Auto-crop through the worker that already owns the trim rules.</summary>
public sealed class PrepareWorkerCropper(
    HttpClient client,
    IOptions<PrepareWorkerOptions> options) : IImageCropper
{
    public async Task<byte[]> CropAsync(ImageInput image, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"v1/crop?tolerance={settings.CropTolerance}&paddingPx={settings.CropPaddingPx}");
        PrepareWorkerRequest.Attach(request, image, settings);
        return await PrepareWorkerRequest.SendPngAsync(client, request, "prepare-worker crop", cancellationToken);
    }
}

/// <summary>Real-ESRGAN through the existing worker engine.</summary>
public sealed class PrepareWorkerUpscaler(
    HttpClient client,
    IOptions<PrepareWorkerOptions> options) : IImageUpscaler
{
    public async Task<byte[]> UpscaleAsync(ImageInput image, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "v1/upscale"
            + $"?scale={settings.UpscaleScale}"
            + $"&model={Uri.EscapeDataString(settings.UpscaleModel)}"
            + $"&tileSize={settings.UpscaleTileSize}"
            + $"&gpu={settings.UseGpu.ToString().ToLowerInvariant()}");
        PrepareWorkerRequest.Attach(request, image, settings);
        return await PrepareWorkerRequest.SendPngAsync(client, request, "prepare-worker upscale", cancellationToken);
    }
}

internal static class PrepareWorkerRequest
{
    public static void Attach(
        HttpRequestMessage request,
        ImageInput image,
        PrepareWorkerOptions settings)
    {
        request.Content = new ByteArrayContent(image.Bytes);
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(image.ContentType);
        if (!string.IsNullOrWhiteSpace(settings.WorkerKey))
        {
            request.Headers.Add("X-Worker-Key", settings.WorkerKey);
        }
    }

    public static async Task<byte[]> SendPngAsync(
        HttpClient client,
        HttpRequestMessage request,
        string operation,
        CancellationToken cancellationToken)
    {
        try
        {
            using var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw await BackgroundRemovalHttp.FromResponseAsync(
                    operation,
                    response,
                    cancellationToken);
            }

            return await response.Content.ReadAsByteArrayAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw BackgroundRemovalHttp.Timeout(operation, new TimeoutException());
        }
        catch (ExecutionRejectedException exception)
        {
            throw BackgroundRemovalHttp.Rejected(operation, exception);
        }
        catch (HttpRequestException exception)
        {
            throw BackgroundRemovalHttp.Unavailable(operation, exception);
        }
    }
}
