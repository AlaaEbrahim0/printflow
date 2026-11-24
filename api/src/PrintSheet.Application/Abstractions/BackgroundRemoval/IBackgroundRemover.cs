namespace PrintSheet.Application.Abstractions;

/// <summary>One image on its way through an adapter. Bytes only; no storage paths.</summary>
public sealed record ImageInput(byte[] Bytes, string ContentType, string FileName);

/// <summary>A straight (unpremultiplied) sRGB colour.</summary>
public readonly record struct RgbColor(byte R, byte G, byte B);

/// <summary>An RGBA PNG produced by a background remover.</summary>
/// <param name="BackgroundColor">
/// Optional hint for the post-composite decontamination stage. The pipeline
/// composites the matte over the original colours, so a remover that knows the
/// background colour must report it here instead of editing RGB itself.
/// </param>
/// <param name="PreserveSoftEdge">
/// True when the provider matte is already at target resolution and its soft
/// band is intentional. The refiner then skips binarize/contract/feather.
/// </param>
public sealed record BackgroundRemovalResult(
    byte[] PngBytes,
    string Provider,
    TimeSpan Elapsed,
    RgbColor? BackgroundColor = null,
    bool PreserveSoftEdge = false);

/// <summary>
/// A background-removal provider. The application layer knows this contract and
/// nothing about HTTP, API keys or provider-specific status codes.
/// </summary>
public interface IBackgroundRemover
{
    /// <summary>Stable configuration name, for example <c>poof</c> or <c>withoutbg</c>.</summary>
    string Provider { get; }

    Task<BackgroundRemovalResult> RemoveAsync(ImageInput image, CancellationToken cancellationToken);
}

/// <summary>
/// What a remover thinks about one image before doing the work. Only local,
/// deterministic removers implement this; the ML adapters have no opinion and
/// are never probed.
/// </summary>
public sealed record BackgroundRemovalApplicability(
    bool IsApplicable,
    IReadOnlyList<string> Reasons,
    RgbColor? BackgroundColor,
    double BorderUniformity,
    double BorderForegroundRatio,
    double BackgroundFraction);

/// <summary>A remover that can cheaply refuse an image it would mishandle.</summary>
public interface IBackgroundRemovalApplicability
{
    Task<BackgroundRemovalApplicability> CheckApplicabilityAsync(
        ImageInput image,
        CancellationToken cancellationToken);
}

/// <summary>Primary provider plus an optional fallback chosen by configuration.</summary>
public interface IBackgroundRemovalService
{
    string Provider { get; }

    IReadOnlyList<IBackgroundRemover> Providers { get; }

    /// <summary>
    /// Removes the background with the primary provider, falling back only for
    /// availability faults. <paramref name="preferredProvider"/> overrides the
    /// configured primary for a single job; it must be one of <see cref="Providers"/>.
    /// </summary>
    Task<BackgroundRemovalResult> RemoveAsync(
        ImageInput image,
        CancellationToken cancellationToken,
        string? preferredProvider = null);
}

/// <summary>
/// The whole crop → cutout → upscale → refine → recombine use case. Declared as a
/// port so the job runner can be exercised without the real providers, worker or
/// Skia; <see cref="BackgroundRemoval.BackgroundRemovalPipeline"/> is the only
/// implementation.
/// </summary>
public interface IBackgroundRemovalPipeline
{
    /// <param name="preferredProvider">
    /// Optional per-job provider override; null uses the configured default.
    /// </param>
    /// <param name="preserveSize">
    /// When true the pipeline keeps the input's exact pixel dimensions: no
    /// internal auto-crop and no AI upscale. Used when the cut-out runs after
    /// print size is set, because the packer requires the final version to be
    /// exactly the target pixels.
    /// </param>
    Task<BackgroundRemoval.BackgroundRemovalPipelineResult> RunAsync(
        ImageInput input,
        CancellationToken cancellationToken,
        string? preferredProvider = null,
        bool preserveSize = false);
}
