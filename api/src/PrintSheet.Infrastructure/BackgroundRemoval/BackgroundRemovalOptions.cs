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

    /// <summary>
    /// Largest Real-ESRGAN output the prepare step will ask for. Above it the
    /// crop is resampled in-process instead: CPU inference past this point runs
    /// longer than the request budget, and a timed-out attempt only burns 300 s
    /// before the job is retried. GPU deployments can raise it.
    /// </summary>
    [Range(0, int.MaxValue)]
    public int MaxAiOutputPixels { get; init; } = 1_000_000;

    /// <summary>
    /// Ceiling for the upscaled colour layer. The configured scale is halved
    /// until the output fits; a design wider than the 58 cm roll at 300 DPI
    /// (6850 px) cannot be printed anyway.
    /// </summary>
    [Range(1, int.MaxValue)]
    public int MaxOutputPixels { get; init; } = 24_000_000;
}
