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

    /// <summary>
    /// Largest image this provider is asked to matte. The self-hosted model runs on
    /// the workstation CPU at roughly 1 MP per 30 s, so a print-size crop blows the
    /// request budget and every attempt times out. It mattes at its own low internal
    /// resolution anyway, so a bigger upload buys no edge detail.
    /// </summary>
    [Range(1, int.MaxValue)]
    public int MaxInputPixels { get; init; } = 1_000_000;
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

    /// <summary>
    /// Poof returns a matte at the input resolution, and measured 5.5 s for 6.2 MP
    /// and 6.7 s for 24 MP, so there is no reason to downscale first: doing so
    /// measurably softened the anti-aliased edge (mean 17/255 alpha error against
    /// the native matte). This ceiling only bounds the upload.
    /// </summary>
    [Range(1, int.MaxValue)]
    public int MaxInputPixels { get; init; } = 24_000_000;
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
    /// Largest Real-ESRGAN output the prepare step will ask for; above it the crop
    /// is resampled in-process instead. Unset derives it from <see cref="UseGpu"/>:
    /// a timed-out attempt only burns the 300 s budget before falling back, so
    /// asking a CPU worker for a print-size pass wastes five minutes per attempt
    /// for an image it cannot finish.
    /// </summary>
    [Range(0, int.MaxValue)]
    public int? MaxAiOutputPixels { get; init; }

    /// <summary>
    /// The pixel budget actually applied. Measured on the reference workstation:
    /// the CPU worker produces ~970 px/s (154k px in 159 s) and the GPU ~25k px/s
    /// (480k px in 19.5 s). Against the 300 s attempt timeout that is ~290k and
    /// ~7.4M px; the defaults keep a wide margin for a busier machine.
    /// </summary>
    public int AiOutputPixelBudget => MaxAiOutputPixels ?? (UseGpu ? 4_000_000 : 150_000);

    /// <summary>
    /// Ceiling for the upscaled colour layer. The configured scale is halved
    /// until the output fits; a design wider than the 58 cm roll at 300 DPI
    /// (6850 px) cannot be printed anyway.
    /// </summary>
    [Range(1, int.MaxValue)]
    public int MaxOutputPixels { get; init; } = 24_000_000;
}
