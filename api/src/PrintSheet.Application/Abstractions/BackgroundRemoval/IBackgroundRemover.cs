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

    Task<BackgroundRemovalResult> RemoveAsync(ImageInput image, CancellationToken cancellationToken);
}

/// <summary>
/// The whole crop → cutout → upscale → refine → recombine use case. Declared as a
/// port so the job runner can be exercised without the real providers, worker or
/// Skia; <see cref="BackgroundRemoval.BackgroundRemovalPipeline"/> is the only
/// implementation.
/// </summary>
public interface IBackgroundRemovalPipeline
{
    Task<BackgroundRemoval.BackgroundRemovalPipelineResult> RunAsync(
        ImageInput input,
        CancellationToken cancellationToken);
}
