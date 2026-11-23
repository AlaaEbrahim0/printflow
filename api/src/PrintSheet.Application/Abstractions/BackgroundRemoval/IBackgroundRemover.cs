namespace PrintSheet.Application.Abstractions;

/// <summary>One image on its way through an adapter. Bytes only; no storage paths.</summary>
public sealed record ImageInput(byte[] Bytes, string ContentType, string FileName);

/// <summary>An RGBA PNG produced by a background remover.</summary>
public sealed record BackgroundRemovalResult(byte[] PngBytes, string Provider, TimeSpan Elapsed);

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
