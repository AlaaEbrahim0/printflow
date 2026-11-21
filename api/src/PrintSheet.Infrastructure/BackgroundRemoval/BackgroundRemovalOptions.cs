using System.ComponentModel.DataAnnotations;

namespace PrintSheet.Infrastructure.BackgroundRemoval;

/// <summary>What every outbound adapter's HTTP client needs from its option set.</summary>
internal interface IHttpClientEndpointOptions
{
    string BaseUrl { get; }
}

/// <summary>Self-hosted withoutBG service. Bound from <c>BackgroundRemoval:WithoutBg</c>.</summary>
public sealed class WithoutBgOptions : IHttpClientEndpointOptions
{
    public const string SectionName = "BackgroundRemoval:WithoutBg";

    [Required, Url]
    public string BaseUrl { get; init; } = "http://localhost:8002";
}

/// <summary>Poof API. Bound from <c>BackgroundRemoval:Poof</c>; the key is never logged.</summary>
public sealed class PoofOptions : IHttpClientEndpointOptions
{
    public const string SectionName = "BackgroundRemoval:Poof";

    [Required, Url]
    public string BaseUrl { get; init; } = "https://api.poof.bg/v1/";

    /// <summary>
    /// Supplied through user-secrets or an environment variable. Left empty so the
    /// API still starts when Poof is not the configured provider; the adapter then
    /// reports Unauthorized and the selector may fall back.
    /// </summary>
    public string? ApiKey { get; init; }
}

/// <summary>The existing crop/upscale worker endpoints. Bound from <c>BackgroundRemoval:PrepareWorker</c>.</summary>
public sealed class PrepareWorkerOptions : IHttpClientEndpointOptions
{
    public const string SectionName = "BackgroundRemoval:PrepareWorker";

    [Required, Url]
    public string BaseUrl { get; init; } = "http://localhost:8000";

    /// <summary>Falls back to the existing <c>Worker:Key</c> when unset.</summary>
    public string? WorkerKey { get; set; }

    [Range(0, 255)]
    public int CropTolerance { get; init; } = 12;

    [Range(0, 500)]
    public int CropPaddingPx { get; init; } = 8;

    /// <summary>Real-ESRGAN only implements 2x and 4x; the worker rejects anything else.</summary>
    [AllowedValues(2, 4)]
    public int UpscaleScale { get; init; } = 4;

    [Required]
    public string UpscaleModel { get; init; } = "realesrgan-x4plus";

    [Range(0, 512)]
    public int UpscaleTileSize { get; init; }

    public bool UseGpu { get; init; } = true;
}
