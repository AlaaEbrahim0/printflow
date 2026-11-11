namespace PrintSheet.Application.Abstractions;

/// <summary>
/// Shared-storage port. Every path is relative to the configured storage root
/// and is validated against traversal before use.
/// </summary>
public interface IFileStore
{
    Task WriteAsync(string relativePath, Stream content, CancellationToken cancellationToken);

    Task<Stream> OpenReadAsync(string relativePath, CancellationToken cancellationToken);

    Task<bool> ExistsAsync(string relativePath, CancellationToken cancellationToken);

    Task<long> GetLengthAsync(string relativePath, CancellationToken cancellationToken);

    /// <summary>Deletes a single file (the original intake upload is never mutated).</summary>
    Task DeleteAsync(string relativePath, CancellationToken cancellationToken);

    /// <summary>Recursively deletes a directory tree (all versions, masks, SVGs, job/export artifacts).</summary>
    Task DeleteDirectoryAsync(string relativePath, CancellationToken cancellationToken);
}
