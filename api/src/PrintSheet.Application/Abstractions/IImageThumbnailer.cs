namespace PrintSheet.Application.Abstractions;

/// <summary>
/// Renders a downscaled, alpha-preserving PNG preview of an immutable version
/// file. The full-resolution file stays untouched; a thumbnail is a derived
/// read-only artifact that may be cached.
/// </summary>
public interface IImageThumbnailer
{
    /// <summary>
    /// Renders the image so its longest side is at most <paramref name="maxPx"/>.
    /// Smaller sources are never upscaled. <paramref name="cacheKey"/> must
    /// identify the immutable source file, not the request.
    /// </summary>
    Task<Stream> RenderAsync(
        string cacheKey,
        Stream source,
        int maxPx,
        CancellationToken cancellationToken);
}
