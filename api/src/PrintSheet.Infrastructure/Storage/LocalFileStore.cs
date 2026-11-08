using PrintSheet.Application.Abstractions;

namespace PrintSheet.Infrastructure.Storage;

public sealed class StorageOptions
{
    public string Root { get; set; } = "storage";
}

/// <summary>
/// Local shared-storage adapter. Paths from contracts are relative, use forward
/// slashes and are rejected if they escape the configured root.
/// </summary>
public sealed class LocalFileStore : IFileStore
{
    private readonly string _root;

    public LocalFileStore(StorageOptions options)
    {
        _root = Path.GetFullPath(options.Root);
    }

    public string Root => _root;

    public async Task WriteAsync(string relativePath, Stream content, CancellationToken cancellationToken)
    {
        var fullPath = Resolve(relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);

        var temporary = fullPath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            await using (var target = new FileStream(
                             temporary,
                             FileMode.CreateNew,
                             FileAccess.Write,
                             FileShare.None,
                             bufferSize: 81920,
                             useAsync: true))
            {
                await content.CopyToAsync(target, cancellationToken);
                await target.FlushAsync(cancellationToken);
            }

            File.Move(temporary, fullPath, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    public Task<Stream> OpenReadAsync(string relativePath, CancellationToken cancellationToken)
    {
        var fullPath = Resolve(relativePath);
        Stream stream = new FileStream(
            fullPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 81920,
            useAsync: true);
        return Task.FromResult(stream);
    }

    public Task<bool> ExistsAsync(string relativePath, CancellationToken cancellationToken)
        => Task.FromResult(File.Exists(Resolve(relativePath)));

    public Task<long> GetLengthAsync(string relativePath, CancellationToken cancellationToken)
        => Task.FromResult(new FileInfo(Resolve(relativePath)).Length);

    public Task DeleteAsync(string relativePath, CancellationToken cancellationToken)
    {
        var fullPath = Resolve(relativePath);
        if (File.Exists(fullPath))
        {
            File.Delete(fullPath);
        }

        return Task.CompletedTask;
    }

    private string Resolve(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            throw new ArgumentException("A storage path is required.", nameof(relativePath));
        }

        if (Path.IsPathRooted(relativePath))
        {
            throw new ArgumentException("Storage paths must be relative.", nameof(relativePath));
        }

        var normalized = relativePath.Replace('\\', '/');
        if (normalized.Split('/').Any(segment => segment == ".."))
        {
            throw new ArgumentException("Storage paths must not contain '..'.", nameof(relativePath));
        }

        var fullPath = Path.GetFullPath(Path.Combine(_root, normalized));
        var rootWithSeparator = _root.EndsWith(Path.DirectorySeparatorChar)
            ? _root
            : _root + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(rootWithSeparator, StringComparison.Ordinal)
            && !string.Equals(fullPath, _root, StringComparison.Ordinal))
        {
            throw new ArgumentException("Storage path escapes the storage root.", nameof(relativePath));
        }

        return fullPath;
    }
}
