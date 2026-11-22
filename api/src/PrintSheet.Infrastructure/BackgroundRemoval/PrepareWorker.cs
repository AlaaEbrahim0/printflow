using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Polly;
using PrintSheet.Application.Abstractions;
using PrintSheet.Application.BackgroundRemoval;
using SkiaSharp;

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

/// <summary>
/// Real-ESRGAN through the existing worker engine, but only while the output is
/// small enough to finish inside the request budget. A larger crop is resampled
/// in-process: on a CPU worker a 4x pass over a print-size design takes minutes
/// and every attempt times out, which surfaced as a cutout that "runs forever"
/// and never completes. The result is still a proposal the human approves.
/// </summary>
public sealed class PrepareWorkerUpscaler(
    HttpClient client,
    IOptions<PrepareWorkerOptions> options,
    ILogger<PrepareWorkerUpscaler> logger) : IImageUpscaler
{
    public async Task<byte[]> UpscaleAsync(ImageInput image, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        var size = DecodeSize(image.Bytes);
        if (size is null)
        {
            // Undecodable input is the worker's call to reject; a size budget
            // cannot be computed and a local resample would hide the fault.
            return await SendToWorkerAsync(image, settings.UpscaleScale, settings, cancellationToken);
        }

        var (width, height) = size.Value;
        var scale = ResolveScale(width, height, settings);
        if (scale == 1)
        {
            // Already at, or past, the largest layer worth printing.
            return image.Bytes;
        }

        if ((long)width * height * scale * scale <= settings.MaxAiOutputPixels)
        {
            try
            {
                return await SendToWorkerAsync(image, scale, settings, cancellationToken);
            }
            catch (BackgroundRemovalException exception) when (exception.AllowsFallback)
            {
                // A slow or busy engine must not fail a cutout that a local
                // resample can finish.
                logger.LogWarning(
                    "Real-ESRGAN upscale failed ({Reason}); resampling {Width}x{Height} locally at {Scale}x.",
                    exception.Reason,
                    width,
                    height,
                    scale);
            }
        }

        return Resample(image.Bytes, width * scale, height * scale);
    }

    private async Task<byte[]> SendToWorkerAsync(
        ImageInput image,
        int scale,
        PrepareWorkerOptions settings,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "v1/upscale"
            + $"?scale={scale}"
            + $"&model={Uri.EscapeDataString(settings.UpscaleModel)}"
            + $"&tileSize={settings.UpscaleTileSize}"
            + $"&gpu={settings.UseGpu.ToString().ToLowerInvariant()}");
        PrepareWorkerRequest.Attach(request, image, settings);
        return await PrepareWorkerRequest.SendPngAsync(client, request, "prepare-worker upscale", cancellationToken);
    }

    private static int ResolveScale(int width, int height, PrepareWorkerOptions settings)
    {
        var scale = settings.UpscaleScale;
        while (scale > 1 && (long)width * height * scale * scale > settings.MaxOutputPixels)
        {
            scale /= 2;
        }

        return scale;
    }

    private static (int Width, int Height)? DecodeSize(byte[] png)
    {
        using var stream = new MemoryStream(png, writable: false);
        using var codec = SKCodec.Create(stream);
        return codec is null ? null : (codec.Info.Width, codec.Info.Height);
    }

    /// <summary>
    /// Mitchell bicubic, the same resampler the matte refiner uses. It adds no
    /// detail, but it is bounded and keeps the layer at the requested size.
    /// </summary>
    private static byte[] Resample(byte[] png, int width, int height)
    {
        using var stream = new MemoryStream(png, writable: false);
        using var decoded = SKBitmap.Decode(stream)
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.InvalidImage,
                "prepare-worker upscale",
                "The image to upscale could not be decoded.");
        using var resized = decoded.Resize(
            new SKImageInfo(width, height, decoded.ColorType, decoded.AlphaType),
            new SKSamplingOptions(SKCubicResampler.Mitchell))
            ?? throw new BackgroundRemovalException(
                BackgroundRemovalFailureReason.Unexpected,
                "prepare-worker upscale",
                "The image could not be resampled.");
        using var image = SKImage.FromBitmap(resized);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
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
